/**
 * routes/analyze.js
 * ================
 *
 * Responsibilities
 * ----------------
 * - POST /analyze
 *   - Resolve the target app root
 *   - Resolve a valid entrypoint (heuristic candidates; manual entryPath override only)
 *   - Run static analysis (buildMetricsFromEntrypoint)
 *   - Persist metrics JSON to the UI output folder
 *   - Start/restart a chokidar watcher for live change events (SSE)
 * - GET /events (SSE)
 *   - Stream analysis session info + filesystem change events to the browser
 *
 * Design Notes
 * ------------
 * - “Thin route” approach: logic is still kept small and grouped into helpers.
 * - No Git integration: this is a pure filesystem live feed (works for uncommitted changes).
 * - In-memory session: restarting the server resets the feed.
 */

import express from "express";
import path from "node:path";
import fs from "node:fs";
import chokidar from "chokidar";

import { buildMetricsFromEntrypoint } from "../lib/buildMetricsFromEntrypoint.js";
import { probeAppUrl } from "../lib/probeAppUrl.js";

const router = express.Router();

/* ========================================================================== */
/* Configuration                                                              */
/* ========================================================================== */

// Fallback entrypoints (used when no explicit entryPath is provided)
const ENTRY_CANDIDATES = [
  "app/server.js",
  "app/index.js",
  "src/server.js",
  "src/index.js",
  "server.js",
  "index.js"
];

// Where the app registry lives
const APPS_CONFIG_PATH = () => path.join(process.cwd(), "app/config/apps.json");

// Where analysis output is persisted for the UI
const OUTPUT_FILE_PATH = () =>
  path.join(process.cwd(), "app/public/output/code-structure.json");

/* ========================================================================== */
/* Live Change Feed (SSE + chokidar)                                          */
/* ========================================================================== */

/** @type {Set<import('http').ServerResponse>} */
const sseClients = new Set();

/** @type {import('chokidar').FSWatcher | null} */
let activeWatcher = null;

/**
 * Active analysis session.
 * The UI can use runToken to ignore stale events after re-analyze.
 * @type {{ appId: string|null, rootAbs: string|null, entryRel: string|null, startedAt: string|null, runToken: string|null }}
 */
let activeAnalysis = {
  appId: null,
  rootAbs: null,
  entryRel: null,
  startedAt: null,
  runToken: null
};

/**
 * Broadcast a typed SSE event to all connected clients.
 * @param {string} type
 * @param {object} payload
 */
function broadcastSse(type, payload) {
  const data = JSON.stringify({ type, ...payload });
  for (const res of sseClients) {
    try {
      res.write(`event: ${type}\n`);
      res.write(`data: ${data}\n\n`);
    } catch {
      // Drop dead clients silently.
      sseClients.delete(res);
    }
  }
}

/**
 * Convert an absolute path to a root-relative POSIX id.
 * Returns null if outside the root.
 * @param {string} rootAbs
 * @param {string} absPath
 */
function toRelPosix(rootAbs, absPath) {
  const rel = path.relative(rootAbs, absPath);
  if (!rel || rel === ".." || rel.startsWith(".." + path.sep)) return null;
  return rel.replace(/\\/g, "/");
}

/**
 * Stop the active watcher (if any).
 */
async function stopWatcher() {
  if (!activeWatcher) return;
  try {
    await activeWatcher.close();
  } catch {
    // noop
  }
  activeWatcher = null;
}

/**
 * Start (or restart) the filesystem watcher for the given app root.
 * Emits fs-change events.
 *
 * @param {string} rootAbs
 */
async function startWatcher(rootAbs) {
  await stopWatcher();

  if (!rootAbs) return;

  activeWatcher = chokidar.watch(rootAbs, {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: {
      stabilityThreshold: 250,
      pollInterval: 100
    },
    ignored: [
      // Dependencies / VCS
      /(^|[\\/])node_modules([\\/]|$)/,
      /(^|[\\/])\.git([\\/]|$)/,

      // Build output / caches
      /(^|[\\/])dist([\\/]|$)/,
      /(^|[\\/])build([\\/]|$)/,
      /(^|[\\/])coverage([\\/]|$)/,
      /(^|[\\/])\.next([\\/]|$)/,
      /(^|[\\/])\.cache([\\/]|$)/,

      // Analyzer output (avoid feedback loop)
      /(^|[\\/])app[\\/]public[\\/]output([\\/]|$)/
    ]
  });

  const emit = (ev, absPath) => {
    const id = toRelPosix(rootAbs, absPath);
    if (!id) return;

    broadcastSse("fs-change", {
      ev,
      id,
      absPath,
      at: new Date().toISOString(),
      runToken: activeAnalysis.runToken
    });
  };

  activeWatcher
    .on("add", (p) => emit("add", p))
    .on("change", (p) => emit("change", p))
    .on("unlink", (p) => emit("unlink", p))
    .on("addDir", (p) => emit("addDir", p))
    .on("unlinkDir", (p) => emit("unlinkDir", p))
    .on("error", (err) => {
      broadcastSse("fs-watch-error", {
        message: String(err?.message || err),
        at: new Date().toISOString(),
        runToken: activeAnalysis.runToken
      });
    });
}

/**
 * GET /events
 *
 * Server-Sent Events feed used by the browser UI.
 *
 * Emits:
 * - hello           → initial handshake + current activeAnalysis
 * - analysis        → after each analyze run
 * - fs-change       → file/dir changes under the analyzed app root
 * - fs-watch-error  → watcher errors
 */
router.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  req.socket.setKeepAlive(true);

  sseClients.add(res);

  res.write("event: hello\n");
  res.write(`data: ${JSON.stringify({ type: "hello", activeAnalysis })}\n\n`);

  req.on("close", () => {
    sseClients.delete(res);
  });
});

/* ========================================================================== */
/* App Registry                                                              */
/* ========================================================================== */

/**
 * Load app registry config.
 * Source of truth: app/config/apps.json
 *
 * Contract:
 * {
 *   apps: [ { id, name, rootDir, url? }, ... ]
 * }
 */
function loadAppsConfig() {
  const cfgPath = APPS_CONFIG_PATH();
  if (!fs.existsSync(cfgPath)) return { apps: [] };
  return JSON.parse(fs.readFileSync(cfgPath, "utf8"));
}

/**
 * Resolve a configured app by id.
 * @param {string} appId
 */
function getAppById(appId) {
  const cfg = loadAppsConfig();
  const app = (cfg.apps || []).find((a) => a.id === appId);
  return app || null;
}

/* ========================================================================== */
/* Entrypoint resolution                                                      */
/* ========================================================================== */

/**
 * Resolve an entrypoint under targetRootAbs.
 *
 * Strategy (Option B)
 * -------------------
 * - For configured apps (appId): ALWAYS resolve heuristically via ENTRY_CANDIDATES.
 * - For manual mode (no appId): allow an explicit entryPath override; otherwise also
 *   resolve heuristically.
 *
 * Note: apps.json does NOT define an entrypoint.
 *
 * @param {string} targetRootAbs
 * @param {object} opts
 * @param {string} [opts.entryPath]   Optional explicit entryPath (manual mode only)
 * @param {boolean} [opts.allowExplicit] If false, entryPath is ignored and we use candidates.
 * @returns {{ entryAbs: string, entryRel: string }}
 */
function resolveEntrypoint(targetRootAbs, { entryPath = "", allowExplicit = true } = {}) {
  const tryRel = (rel) => {
    const abs = path.resolve(targetRootAbs, rel);

    // Safety boundary: must be inside root
    if (!abs.startsWith(targetRootAbs + path.sep)) return null;
    if (!fs.existsSync(abs)) return null;
    if (!fs.statSync(abs).isFile()) return null;

    return { entryAbs: abs, entryRel: rel.replace(/\\/g, "/") };
  };

  // 1) explicit entryPath (manual mode only)
  if (allowExplicit) {
    const cleaned = String(entryPath || "").trim();
    if (cleaned) {
      if (path.isAbsolute(cleaned)) {
        const abs = path.normalize(cleaned);
        if (
          abs.startsWith(targetRootAbs + path.sep) &&
          fs.existsSync(abs) &&
          fs.statSync(abs).isFile()
        ) {
          return { entryAbs: abs, entryRel: toRelPosix(targetRootAbs, abs) || cleaned };
        }
      } else {
        const found = tryRel(cleaned);
        if (found) return found;
      }
    }
  }

  // 2) fallback candidates
  for (const rel of ENTRY_CANDIDATES) {
    const found = tryRel(rel);
    if (found) return found;
  }

  throw new Error(
    `No valid entrypoint found under ${targetRootAbs}. Tried request entryPath (if any) and: ${ENTRY_CANDIDATES.join(", ")}`
  );
}

/* ========================================================================== */
/* Output persistence                                                         */
/* ========================================================================== */

/**
 * Persist metrics JSON to the output path served by the UI.
 * @param {any} metrics
 */
function persistMetrics(metrics) {
  const outputFile = OUTPUT_FILE_PATH();
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(metrics, null, 2), "utf8");
  return "/output/code-structure.json";
}

/**
 * Create a new run token for the active analysis session.
 */
function createRunToken() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/* ========================================================================== */
/* POST /analyze                                                              */
/* ========================================================================== */

router.post("/analyze", async (req, res) => {
  try {
    // ----------------------------------------------------------------------
    // 1) Normalize inputs
    // ----------------------------------------------------------------------
    const analyzerRoot = process.cwd();

    const body = req.body || {};
    const appId = typeof body.appId === "string" ? body.appId.trim() : "";

    // entryPath is supported ONLY in manual mode (no appId). For configured apps
    // we always resolve the entry heuristically.
    const manualEntryPath = !appId && typeof body.entryPath === "string"
      ? body.entryPath.trim()
      : "";

    // App URL comes from registry (if appId) OR request (manual mode)
    let appUrl = typeof body.appUrl === "string" ? body.appUrl.trim() : "";
    if (!appUrl) appUrl = null;

    // Determine analysis target
    let targetRootAbs = analyzerRoot;

    if (appId) {
      const app = getAppById(appId);
      if (!app) return res.status(400).send(`Unknown appId: ${appId}`);

      const rootDir = String(app.rootDir || "").trim();
      if (!rootDir) return res.status(400).send(`Missing rootDir for appId: ${appId}`);

      targetRootAbs = path.resolve(rootDir);

      const cfgUrl = String(app.url || "").trim();
      appUrl = cfgUrl ? cfgUrl : null;
    }

    // ----------------------------------------------------------------------
    // 2) Resolve entrypoint under the selected app root
    // ----------------------------------------------------------------------
    const { entryAbs, entryRel } = resolveEntrypoint(targetRootAbs, {
      entryPath: manualEntryPath,
      allowExplicit: !appId // appId => configured app => heuristic only
    });

    // ----------------------------------------------------------------------
    // 3) Activate analysis session (SSE) early
    // ----------------------------------------------------------------------
    const runToken = createRunToken();

    activeAnalysis = {
      appId: appId || null,
      rootAbs: targetRootAbs,
      entryRel,
      startedAt: new Date().toISOString(),
      runToken
    };

    broadcastSse("analysis", {
      appId: activeAnalysis.appId,
      rootAbs: activeAnalysis.rootAbs,
      entryRel: activeAnalysis.entryRel,
      at: activeAnalysis.startedAt,
      runToken: activeAnalysis.runToken
    });

    // ----------------------------------------------------------------------
    // 4) Optional URL probe (metadata only)
    // ----------------------------------------------------------------------
    const urlInfo = appUrl ? await probeAppUrl(appUrl) : null;

    // ----------------------------------------------------------------------
    // 5) Run analysis using *targetRootAbs*
    // ----------------------------------------------------------------------
    const metrics = await buildMetricsFromEntrypoint({
      projectRoot: targetRootAbs,
      entryAbs,
      urlInfo
    });

    // ----------------------------------------------------------------------
    // 6) Persist output + start watcher
    // ----------------------------------------------------------------------
    const metricsUrl = persistMetrics(metrics);
    await startWatcher(targetRootAbs);

    // ----------------------------------------------------------------------
    // 7) Respond
    // ----------------------------------------------------------------------
    return res.json({
      metricsUrl,
      analyzedAppId: appId || null,
      targetRoot: targetRootAbs,
      entryUsed: entryAbs,
      entryRel,
      runToken,
      summary: { nodes: metrics.nodes.length, links: metrics.links.length }
    });
  } catch (err) {
    return res.status(500).send(err?.stack || String(err));
  }
});

export default router;
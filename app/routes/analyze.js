import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";

// NOTE:
// This module is imported as a *default export* by the server bootstrap.
// Therefore we must default-export an Express router.
const router = express.Router();

// ---------------------------------------------------------------------------
// In-memory metrics cache
// ---------------------------------------------------------------------------
// The UI performs two requests:
//  1) POST /analyze   -> returns { runToken, metricsUrl, summary }
//  2) GET  <metricsUrl> -> returns the heavy graph payload
//
// We keep results in-memory per runToken. This is simple and fast.
// If you need persistence or multi-process support, replace this with a store.
const metricsByToken = new Map();

function newRunToken() {
  // Short, URL-safe run id.
  return crypto.randomBytes(12).toString("hex");
}

function safeJsonRead(fileAbs) {
  const txt = fs.readFileSync(fileAbs, "utf8");
  return JSON.parse(txt);
}

function normalizeId(v) {
  return String(v || "").trim();
}

// ---------------------------------------------------------------------------
// Apps config (app/config/apps.json)
// ---------------------------------------------------------------------------
function appsConfigPath() {
  return path.resolve(process.cwd(), "app", "config", "apps.json");
}

function loadAppsConfig() {
  const p = appsConfigPath();
  if (!fs.existsSync(p)) {
    throw new Error(`Missing apps config: ${p}`);
  }

  const data = safeJsonRead(p);
  const apps = data?.apps || data;
  if (!Array.isArray(apps)) {
    throw new Error("apps.json must be an array or an object with an 'apps' array");
  }

  return apps;
}

function findAppById(apps, appId) {
  const id = normalizeId(appId);
  if (!id) return null;
  return apps.find((a) => normalizeId(a?.id) === id) || null;
}

function resolveAppRootAbs(app) {
  const rootDir = String(app?.rootDir || app?.root || app?.path || "").trim();
  if (!rootDir) return null;

  // rootDir in config can be absolute or relative to the NodeAnalyzer cwd.
  return path.resolve(process.cwd(), rootDir);
}

function resolveEntryAbs(appRootAbs, app) {
  const entry = String(app?.entry || "").trim();
  if (entry) return path.resolve(appRootAbs, entry);

  // Best-effort fallback if entry is omitted.
  const guesses = ["index.js", "src/index.js", "main.js", "app.js"];
  for (const g of guesses) {
    const p = path.resolve(appRootAbs, g);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }

  return null;
}

function summaryFromMetrics(metrics) {
  const nodes = Array.isArray(metrics?.nodes) ? metrics.nodes.length : 0;
  const links = Array.isArray(metrics?.links) ? metrics.links.length : 0;
  return { nodes, links };
}

// ---------------------------------------------------------------------------
// Analyzer implementation
// ---------------------------------------------------------------------------
// We import lazily so boot doesn't crash if the analyzer module changes.
async function buildMetrics({ projectRootAbs, entryAbs, urlInfo, maxDirDepth }) {
  const mod = await import("../lib/buildMetricsFromEntrypoint.js");
  const fn = mod?.buildMetricsFromEntrypoint;
  if (typeof fn !== "function") {
    throw new Error(
      "buildMetricsFromEntrypoint export missing from app/lib/buildMetricsFromEntrypoint.js"
    );
  }

  return fn({
    projectRoot: projectRootAbs,
    entryAbs,
    urlInfo,
    maxDirDepth,
  });
}

function parseMaxDirDepth(body) {
  const n = Number(body?.maxDirDepth);
  return Number.isFinite(n) && n > 0 ? n : 3;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
// We register both "POST /" and "POST /analyze" to be robust against different
// mounting styles:
//   app.use("/analyze", router)  -> client POSTs to "/analyze" (router POST "/")
//   app.use("/", router)         -> client POSTs to "/analyze" (router POST "/analyze")

async function handleAnalyze(req, res) {
  try {
    const appId = normalizeId(req?.body?.appId);
    if (!appId) return res.status(400).json({ error: { message: "Missing appId" } });

    const apps = loadAppsConfig();
    const app = findAppById(apps, appId);
    if (!app) return res
      .status(400)
      .json({ error: { message: `Unknown appId: ${appId}` } });

    const appRootAbs = resolveAppRootAbs(app);
    if (!appRootAbs) {
      return res.status(400).json({
        analysisStatus: "unsupported",
        reason: "missing-rootDir",
        message: "App config is missing rootDir/root/path.",
        details: app,
      });
    }

    if (!fs.existsSync(appRootAbs) || !fs.statSync(appRootAbs).isDirectory()) {
      return res.status(400).json({
        analysisStatus: "unsupported",
        reason: "rootDir-not-found",
        message: `App rootDir does not exist or is not a directory: ${appRootAbs}`,
        details: app,
      });
    }

    const entryAbs = resolveEntryAbs(appRootAbs, app);
    if (!entryAbs) {
      return res.status(400).json({
        analysisStatus: "unsupported",
        reason: "missing-entry",
        message:
          "Cannot resolve entry file. Provide 'entry' in apps.json (relative to rootDir).",
        details: app,
      });
    }

    const maxDirDepth = parseMaxDirDepth(req.body);

    const runToken = newRunToken();

    // `urlInfo` is optional. The UI uses it for labels; keep compatible.
    const urlInfo = {
      appId,
      appName: String(app?.name || appId),
      url: String(app?.url || ""),
      entry: String(app?.entry || ""),
    };

    const metrics = await buildMetrics({
      projectRootAbs: appRootAbs,
      entryAbs,
      urlInfo,
      maxDirDepth,
    });

    metricsByToken.set(runToken, metrics);

    const summary = summaryFromMetrics(metrics);

    // Metrics endpoint. We expose both variants for mounting compatibility.
    const metricsUrl = `/metrics?runToken=${encodeURIComponent(runToken)}`;

    return res.json({
      runToken,
      metricsUrl,
      summary,
    });
  } catch (e) {
    const msg = String(e?.message || e || "Analyze failed");
    return res.status(500).json({ error: { message: msg } });
  }
}

router.post("/", handleAnalyze);
router.post("/analyze", handleAnalyze);

function handleMetrics(req, res) {
  const token = normalizeId(req?.query?.runToken || req?.params?.runToken);
  if (!token) return res.status(400).json({ error: { message: "Missing runToken" } });

  const metrics = metricsByToken.get(token);
  if (!metrics) {
    return res.status(404).json({
      error: { message: "Metrics not found (runToken expired or unknown)." },
    });
  }

  return res.json(metrics);
}

// Same robustness pattern: allow /metrics and /analyze/metrics.
router.get("/metrics", handleMetrics);
router.get("/analyze/metrics", handleMetrics);
router.get("/metrics/:runToken", handleMetrics);
router.get("/analyze/metrics/:runToken", handleMetrics);

// ---------------------------------------------------------------------------
// Helper: Convert an absolute path to a root-relative POSIX id.
// ---------------------------------------------------------------------------
/**
 * Convert an absolute path to a root-relative POSIX id.
 *
 * Behavior
 * --------
 * 1. Compute the relative path from `rootAbs` → `absPath`.
 * 2. Reject paths that escape the root (".." segments).
 * 3. Normalize separators to POSIX style so the UI receives stable ids.
 *
 * This function intentionally returns `null` instead of throwing because
 * watcher events may occasionally produce paths outside the analyzed root
 * (symlinks, editor temp files, etc.).
 *
 * @param {string} rootAbs
 * @param {string} absPath
 * @returns {string|null}
 */
export function toRelPosix(rootAbs, absPath) {
  const rel = path.relative(rootAbs, absPath);
  if (isInvalidRelative(rel)) return null;
  return normalizeToPosix(rel);
}

/** Determine whether a relative path escapes the root directory. */
function isInvalidRelative(rel) {
  if (!rel) return true;
  if (rel === "..") return true;
  if (rel.startsWith(".." + path.sep)) return true;
  return false;
}

/** Convert Windows path separators to POSIX style (stable ids across platforms). */
function normalizeToPosix(p) {
  return String(p || "").replace(/\\/g, "/");
}

export default router;
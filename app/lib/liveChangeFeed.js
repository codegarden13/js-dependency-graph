/**
 * liveChangeFeed
 * ==============
 *
 * Responsibilities
 * ----------------
 * - Provide a Server-Sent Events (SSE) endpoint at GET /events
 * - Watch the active analysis root folder with chokidar
 * - Broadcast file change events to connected browser clients
 *
 * Why this exists
 * --------------
 * The Express server should stay thin. This module concentrates the
 * long-lived concerns (SSE + filesystem watching) in one place.
 *
 * Notes
 * -----
 * - In-memory only (no persistence)
 * - One watcher for the currently active analysis root
 * - Clients are “dumb”: they simply receive events and update UI state
 * - A `runToken` is included so the UI can ignore stale events
 *
 * Typical usage (from a route)
 * ----------------------------
 *   import {
 *     attachSseEndpoint,
 *     activateAnalysis
 *   } from "../lib/liveChangeFeed.js";
 *
 *   attachSseEndpoint(router);
 *
 *   // After a successful /analyze run:
 *   await activateAnalysis({ appId, rootAbs, entryRel });
 */

import path from "node:path";
import chokidar from "chokidar";

// -----------------------------------------------------------------------------
// In-memory state
// -----------------------------------------------------------------------------

/** @type {Set<import('http').ServerResponse>} */
const clients = new Set();

/** @type {import('chokidar').FSWatcher | null} */
let watcher = null;

/**
 * Active analysis metadata.
 *
 * This is NOT a "user session". It is the current analysis target
 * (the app root that is being watched).
 */
let activeAnalysis = {
  appId: null,
  rootAbs: null,
  entryRel: null,
  startedAt: null,
  runToken: null
};

/**
 * Defaults for ignoring noisy folders.
 * NOTE: `app/public/output` is where NodeAnalyzer writes analysis output;
 *       watching it would create feedback loops.
 */
const DEFAULT_IGNORED = [
  /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])\.git([\\/]|$)/,
  /(^|[\\/])dist([\\/]|$)/,
  /(^|[\\/])build([\\/]|$)/,
  /(^|[\\/])coverage([\\/]|$)/,
  /(^|[\\/])\.next([\\/]|$)/,
  /(^|[\\/])\.cache([\\/]|$)/,
  /(^|[\\/])app[\\/]public[\\/]output([\\/]|$)/
];

// -----------------------------------------------------------------------------
// SSE helpers
// -----------------------------------------------------------------------------

/**
 * Send one SSE event to one client.
 *
 * @param {import('http').ServerResponse} res
 * @param {string} type
 * @param {any} payload
 */
function send(res, type, payload) {
  const body = {
    type,
    ...(payload && typeof payload === "object" ? payload : { value: payload })
  };

  res.write(`event: ${type}\n`);
  res.write(`data: ${JSON.stringify(body)}\n\n`);
}

/**
 * Broadcast one SSE event to all connected clients.
 * Dead connections are removed.
 *
 * @param {string} type
 * @param {any} payload
 */
function broadcast(type, payload = {}) {
  for (const res of clients) {
    try {
      send(res, type, payload);
    } catch {
      clients.delete(res);
    }
  }
}

/**
 * Remove a client and stop the watcher if nobody is listening.
 *
 * @param {import('http').ServerResponse} res
 */
function dropClient(res) {
  clients.delete(res);

  // Optional: if nobody is connected, stop watching to save CPU.
  if (clients.size === 0) {
    // fire-and-forget (cannot await inside close handler safely)
    stopWatcher();
  }
}

// -----------------------------------------------------------------------------
// Path utilities
// -----------------------------------------------------------------------------

/**
 * Convert an absolute path to a root-relative POSIX id.
 * Returns null if outside root, or if the path maps to the root folder itself.
 *
 * @param {string} rootAbs
 * @param {string} absPath
 * @returns {string|null}
 */
function toRelPosix(rootAbs, absPath) {
  if (!rootAbs || !absPath) return null;

  const root = path.resolve(rootAbs);
  const full = path.resolve(absPath);

  const rel = path.relative(root, full);

  // Root itself (directory) has no stable node id.
  if (!rel || rel === ".") return null;

  // Must remain inside root boundary.
  if (rel === ".." || rel.startsWith(".." + path.sep)) return null;

  return rel.replace(/\\/g, "/");
}

// -----------------------------------------------------------------------------
// Watcher lifecycle
// -----------------------------------------------------------------------------

/**
 * Stop the currently active watcher.
 */
async function stopWatcher() {
  if (!watcher) return;

  try {
    await watcher.close();
  } catch {
    // ignore
  }

  watcher = null;
}

/**
 * Start (or restart) a watcher for the given root.
 *
 * @param {string} rootAbs
 */
async function startWatcher(rootAbs) {
  await stopWatcher();

  if (!rootAbs) return;

  watcher = chokidar.watch(rootAbs, {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: {
      stabilityThreshold: 250,
      pollInterval: 100
    },
    ignored: DEFAULT_IGNORED
  });

  /** @param {string} ev @param {string} absPath */
  const emit = (ev, absPath) => {
    const id = toRelPosix(rootAbs, absPath);
    if (!id) return;

    broadcast("fs-change", {
      ev,
      id,
      at: new Date().toISOString(),
      appId: activeAnalysis.appId,
      runToken: activeAnalysis.runToken,
      rootAbs: activeAnalysis.rootAbs
    });
  };

  watcher
    .on("add", (p) => emit("add", p))
    .on("change", (p) => emit("change", p))
    .on("unlink", (p) => emit("unlink", p))
    .on("addDir", (p) => emit("addDir", p))
    .on("unlinkDir", (p) => emit("unlinkDir", p))
    .on("error", (err) => {
      broadcast("fs-watch-error", {
        message: String(err?.message || err),
        at: new Date().toISOString(),
        appId: activeAnalysis.appId,
        runToken: activeAnalysis.runToken
      });
    });
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Attach GET /events SSE endpoint to a router.
 *
 * The endpoint does not start analysis or watchers by itself.
 * Instead, it streams whatever the current `activeAnalysis` is.
 *
 * @param {import('express').Router} router
 */
export function attachSseEndpoint(router) {
  router.get("/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    // Keep connection alive (Node socket)
    req.socket.setKeepAlive(true);

    // Express does not always flush automatically
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    clients.add(res);

    // Suggest reconnect delay (ms)
    res.write("retry: 2000\n");

    // Initial handshake
    try {
      send(res, "hello", { activeAnalysis });
    } catch {
      dropClient(res);
      return;
    }

    // Heartbeat (helps with proxies and idle timeouts)
    const heartbeat = setInterval(() => {
      try {
        res.write(`: ping ${Date.now()}\n\n`);
      } catch {
        clearInterval(heartbeat);
        dropClient(res);
      }
    }, 25000);

    req.on("close", () => {
      clearInterval(heartbeat);
      dropClient(res);
    });
  });
}

/**
 * Activate a new analysis target and restart the watcher.
 *
 * This should be called by /analyze AFTER metrics have been generated.
 *
 * @param {{ appId: string|null, rootAbs: string|null, entryRel: string|null }} opts
 */
export async function activateAnalysis(opts) {
  const runToken = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  activeAnalysis = {
    appId: opts.appId || null,
    rootAbs: opts.rootAbs || null,
    entryRel: opts.entryRel || null,
    startedAt: new Date().toISOString(),
    runToken
  };

  broadcast("analysis", {
    appId: activeAnalysis.appId,
    rootAbs: activeAnalysis.rootAbs,
    entryRel: activeAnalysis.entryRel,
    at: activeAnalysis.startedAt,
    runToken: activeAnalysis.runToken
  });

  // If nobody is connected, do not burn resources watching.
  if (clients.size === 0) {
    await stopWatcher();
    return;
  }

  if (activeAnalysis.rootAbs) {
    await startWatcher(activeAnalysis.rootAbs);
  } else {
    await stopWatcher();
  }
}

/**
 * Debug helper: inspect the current analysis target.
 * Not a "session" in the auth/user sense.
 */
export function getActiveAnalysis() {
  return activeAnalysis;
}
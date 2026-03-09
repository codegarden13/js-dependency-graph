/**
 * liveChangeFeed
 * ============================================================================
 *
 * What this module does
 * ---------------------
 * This module owns the long-lived "live analysis" infrastructure for the
 * NodeAnalyzer backend.
 *
 * It combines two concerns that naturally belong together:
 *   1. an SSE endpoint (`GET /events`) for browser clients
 *   2. one chokidar watcher for the currently active analysis root
 *
 * The browser connects once, listens for events, and updates the UI whenever
 * the active analysis root changes on disk.
 *
 * Why this module exists
 * ----------------------
 * The Express route layer should stay thin. It should not need to know about:
 *   - connected SSE clients
 *   - watcher lifecycle
 *   - heartbeat management
 *   - event broadcasting
 *   - active analysis metadata
 *
 * Those are process-local concerns, so they are centralized here.
 *
 * Runtime model
 * -------------
 * - in-memory only
 * - one active analysis target at a time
 * - one watcher for the active root
 * - many connected SSE clients are allowed
 * - clients are intentionally "dumb": they receive events and react
 *
 * Event model
 * -----------
 * The module emits, among others:
 *   - `hello`          initial handshake for a new SSE client
 *   - `analysis`       active analysis target changed
 *   - `fs-change`      watched file or directory changed
 *   - `fs-watch-error` chokidar reported an error
 *
 * A `runToken` is included in live events so the frontend can ignore stale
 * updates that belong to an older analysis run.
 *
 * Typical usage
 * -------------
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

import chokidar from "chokidar";
import { toRelPosix } from "./fsPaths.js";

// -----------------------------------------------------------------------------
// In-memory process state
// -----------------------------------------------------------------------------
//
// This module is intentionally stateful.
//
// We keep:
// - the connected SSE clients
// - the single active chokidar watcher
// - metadata about the currently active analysis target
//
// This is process-local state, not persisted storage and not user-session
// state in the authentication sense.

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
 * Watcher ignore rules.
 *
 * Why these paths are ignored
 * ---------------------------
 * We do not want the watcher to emit noisy or self-generated events for:
 * - dependency folders
 * - VCS metadata
 * - build / coverage output
 * - framework caches
 * - NodeAnalyzer's own generated analysis output
 *
 * In particular, `app/public/output` must be ignored, otherwise writing the
 * graph JSON / CSV would immediately trigger new fs-change events and create a
 * feedback loop.
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
 * Send one SSE event to one connected client.
 *
 * Notes
 * -----
 * - `event:` carries the event type for browser-side listeners
 * - `data:` contains one JSON payload line
 * - a blank line terminates the SSE frame
 *
 * The payload is normalized so callers can pass either:
 * - an object payload (merged into the body)
 * - a primitive payload (wrapped as `{ value: ... }`)
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
 *
 * Dead / broken connections are removed lazily when a write fails.
 * This keeps the client set self-healing without needing a separate cleanup
 * pass.
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
 * Remove one client from the connected-client set.
 *
 * If this was the last remaining client, the filesystem watcher is stopped as
 * a resource optimization. There is no reason to keep watching the active
 * root if nobody is listening for events.
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
// Watcher lifecycle
// -----------------------------------------------------------------------------

/**
 * Stop the currently active chokidar watcher, if any.
 *
 * This function is idempotent:
 * - if no watcher exists, it returns immediately
 * - watcher close errors are ignored because shutdown is best-effort here
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
 * Start (or restart) a watcher for the active analysis root.
 *
 * Behavior
 * --------
 * - always stops the previous watcher first
 * - returns early if no root is configured
 * - emits normalized root-relative ids (`id`) in fs-change events
 * - includes analysis metadata so the frontend can correlate events
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

  /**
   * Normalize one chokidar event into the frontend event contract.
   *
   * The watcher reports absolute filesystem paths. The graph and frontend,
   * however, work with root-relative POSIX ids so that paths remain stable
   * across operating systems.
   *
   * Events outside the active root are ignored defensively.
   *
   * @param {string} ev
   * @param {string} absPath
   */
  const emit = (ev, absPath) => {
    const id = toRelPosix(rootAbs, absPath);

    // Root itself has no stable graph node id and out-of-root paths are ignored.
    if (!id || id === "." || id.startsWith("..")) return;

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
 * Attach the public SSE endpoint at `GET /events` to a router.
 *
 * Important behavior
 * ------------------
 * - the endpoint does not activate analysis by itself
 * - it only streams the current in-memory analysis state
 * - each client receives an immediate `hello` handshake event
 * - a heartbeat comment is sent periodically to keep proxies / browsers from
 *   closing the connection when idle
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
 * Activate a new analysis target and restart live watching for it.
 *
 * Expected call site
 * ------------------
 * This is called by `/analyze` only after the metrics artifacts have been
 * generated successfully.
 *
 * Behavior
 * --------
 * - creates a fresh `runToken`
 * - updates the active analysis metadata
 * - broadcasts an `analysis` event to connected clients
 * - starts a new watcher only if at least one client is currently connected
 *
 * If no clients are connected, watcher startup is skipped to avoid burning CPU
 * for unused live updates.
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
 * Read the currently active analysis metadata.
 *
 * This is a debug / inspection helper. It exposes the process-local analysis
 * target, not a user session.
 */
export function getActiveAnalysis() {
  return activeAnalysis;
}
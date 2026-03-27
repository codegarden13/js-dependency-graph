import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawnSync } from "node:child_process";

import { activateAnalysis } from "../lib/liveChangeFeed.js";
import { normalizeFsPath } from "../lib/fsPaths.js";
import {
  loadAppsConfig,
  findAppById,
  resolveAppRootAbs,
  resolveEntryAbs
} from "../lib/appsRegistry.js";


import {
  metricsArtifacts,
  writeMetricsArtifacts
} from "../lib/analyze/artifacts.js";

import { normalizeId } from "../lib/stringUtils.js"




import {


  csvEscape,
  NODE_ROW_FIELDS,
  projectRow,
  nodeRow,
  linkRow,
  buildMetricsCsv
} from "../lib/analyze/csvExport.js";


// NOTE:
// This module is imported as a *default export* by the server bootstrap.
// Therefore we must default-export an Express router.
const router = express.Router();


// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

/**
 * Create a short opaque run token for one analysis execution.
 *
 * Why this exists
 * ---------------
 * The analyze endpoint returns a lightweight identifier that can be logged,
 * correlated across artifacts, and surfaced to the client without exposing
 * filesystem details.
 *
 * @returns {string}
 *   Random hexadecimal token suitable for response payloads and logs.
 */
function newRunToken() {
  // Short, URL-safe run id.
  return crypto.randomBytes(12).toString("hex");
}









/**
 * Resolve a path that may already be absolute or project-relative.
 *
 * @param {string} targetPath
 *   Absolute or project-relative filesystem path.
 * @returns {string}
 *   Normalized absolute path.
 */
function resolveAbsoluteOrProjectPath(targetPath) {
  if (path.isAbsolute(targetPath)) {
    return normalizeFsPath(targetPath);
  }

  return normalizeFsPath(path.join(process.cwd(), targetPath));
}


// ---------------------------------------------------------------------------
// Metrics summary + hotspot enrichment
// ---------------------------------------------------------------------------

/**
 * Build a compact summary from the full metrics payload.
 *
 * @param {Record<string, unknown>} metrics
 *   Metrics payload containing graph arrays.
 * @returns {{nodes: number, links: number}}
 *   Lightweight count summary for response payloads.
 */
function summaryFromMetrics(metrics) {
  const nodes = Array.isArray(metrics?.nodes) ? metrics.nodes.length : 0;
  const links = Array.isArray(metrics?.links) ? metrics.links.length : 0;
  return { nodes, links };
}

/**
 * Clamp a numeric value to the inclusive range `[0, 1]`.
 *
 * @param {unknown} v
 *   Candidate numeric value.
 * @returns {number}
 *   Clamped normalized number.
 */
function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

/**
 * Convert a value to a strictly positive finite number.
 *
 * @param {unknown} v
 *   Candidate numeric value.
 * @returns {number}
 *   Positive finite number, or `0` when invalid.
 */
function toPositiveNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Determine whether a graph node represents a function.
 *
 * @param {Record<string, unknown>} node
 *   Graph node candidate.
 * @returns {boolean}
 *   `true` when the node kind is `function`.
 */
function looksLikeFunctionNode(node) {
  return String(node?.kind || "") === "function";
}

/**
 * Determine whether a graph node represents a file/module.
 *
 * @param {Record<string, unknown>} node
 *   Graph node candidate.
 * @returns {boolean}
 *   `true` when the node kind is `file`.
 */
function looksLikeFileNode(node) {
  return String(node?.kind || "") === "file";
}

/**
 * Normalize a graph file identifier to forward-slash form.
 *
 * @param {unknown} v
 *   Candidate file identifier.
 * @returns {string}
 *   Trimmed identifier using `/` separators.
 */
function normalizeGraphFileId(v) {
  return String(v || "").replace(/\\/g, "/").trim();
}

/**
 * Read a node complexity metric as a positive number.
 *
 * @param {Record<string, unknown>} node
 *   Graph node payload.
 * @returns {number}
 *   Normalized complexity value.
 */
function readNodeComplexity(node) {
  return toPositiveNumber(node?.complexity);
}

/**
 * Read a node line-count metric as a positive number.
 *
 * @param {Record<string, unknown>} node
 *   Graph node payload.
 * @returns {number}
 *   Normalized line-count value.
 */
function readNodeLines(node) {
  return toPositiveNumber(node?.lines);
}

/**
 * Convert epoch seconds to an ISO timestamp when valid.
 *
 * @param {unknown} epochSeconds
 *   Epoch timestamp in seconds.
 * @returns {string | null}
 *   ISO timestamp, or `null` for invalid input.
 */
function safeIsoDateFromEpochSeconds(epochSeconds) {
  const ms = Number(epochSeconds) * 1000;
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

/**
 * Check whether the project root is inside a Git repository.
 *
 * @param {string} projectRootAbs
 *   Absolute project root path.
 * @returns {boolean}
 *   `true` when Git metadata is available.
 */
function hasGitRepo(projectRootAbs) {
  const probe = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: projectRootAbs,
    encoding: "utf8"
  });

  return probe.status === 0;
}

/**
 * Build the Git command used to collect per-file change frequency data.
 *
 * @returns {string[]}
 *   Argument vector for `git log`.
 */
function gitLogFileStatsCommand() {
  return [
    "log",
    "--name-only",
    "--format=@@@%ct",
    "--no-merges",
    "--",
    "."
  ];
}

/**
 * Execute the Git history scan used for hotspot enrichment.
 *
 * @param {string} projectRootAbs
 *   Absolute project root path.
 * @returns {string}
 *   Raw stdout from the Git command.
 * @throws {Error}
 *   Thrown when the Git command fails.
 */
function runGitFileStatsLog(projectRootAbs) {
  const res = spawnSync("git", gitLogFileStatsCommand(), {
    cwd: projectRootAbs,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });

  if (res.status !== 0) {
    const stderr = String(res.stderr || res.stdout || "git log failed").trim();
    throw new Error(stderr || "git log failed");
  }

  return String(res.stdout || "");
}

/**
 * Get or create the mutable stats bucket for one repository-relative file.
 *
 * @param {Map<string, {commits: number, lastTouchedEpoch: number}>} stats
 *   Aggregate stats map.
 * @param {string} relPath
 *   Normalized repository-relative file path.
 * @returns {{commits: number, lastTouchedEpoch: number}}
 *   Mutable aggregate entry for the file.
 */
function ensureGitFileStatEntry(stats, relPath) {
  let entry = stats.get(relPath);
  if (entry) return entry;

  entry = {
    commits: 0,
    lastTouchedEpoch: 0
  };
  stats.set(relPath, entry);
  return entry;
}

/**
 * Apply one file-path line from `git log --name-only` output.
 *
 * @param {Map<string, {commits: number, lastTouchedEpoch: number}>} stats
 *   Aggregate stats map.
 * @param {string} line
 *   Raw file-path line.
 * @param {number | null} currentEpoch
 *   Commit timestamp currently in scope.
 * @returns {number | null}
 *   Unchanged current epoch for parser flow consistency.
 */
function applyGitFileStatLine(stats, line, currentEpoch) {
  const relPath = normalizeGraphFileId(line);
  if (!relPath) return currentEpoch;

  const entry = ensureGitFileStatEntry(stats, relPath);
  entry.commits += 1;

  if (Number.isFinite(currentEpoch) && currentEpoch > entry.lastTouchedEpoch) {
    entry.lastTouchedEpoch = currentEpoch;
  }

  return currentEpoch;
}

/**
 * Read a synthetic commit-timestamp marker from Git log output.
 *
 * @param {string} line
 *   Raw log line.
 * @param {number | null} currentEpoch
 *   Previous parser epoch.
 * @returns {number | null}
 *   Parsed epoch when the line is a marker, otherwise the previous epoch.
 */
function readGitEpochMarker(line, currentEpoch) {
  if (!line.startsWith("@@@")) return currentEpoch;
  return Number(line.slice(3));
}

/**
 * Parse Git log output into per-file change statistics.
 *
 * @param {string} stdout
 *   Raw stdout produced by the hotspot Git command.
 * @returns {Map<string, {commits: number, lastTouchedEpoch: number}>}
 *   Aggregated file statistics keyed by normalized relative path.
 */
function parseGitFileStats(stdout) {
  const stats = new Map();
  let currentEpoch = null;

  for (const rawLine of String(stdout || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("@@@")) {
      currentEpoch = readGitEpochMarker(line, currentEpoch);
      continue;
    }

    applyGitFileStatLine(stats, line, currentEpoch);
  }

  return stats;
}

/**
 * Collect per-file Git history statistics for hotspot scoring.
 *
 * @param {string} projectRootAbs
 *   Absolute project root path.
 * @returns {Map<string, {commits: number, lastTouchedEpoch: number}>}
 *   Aggregated Git statistics keyed by normalized relative path.
 */
function listGitFileStats(projectRootAbs) {
  const stdout = runGitFileStatsLog(projectRootAbs);
  return parseGitFileStats(stdout);
}

/**
 * Normalize a positive metric to `[0, 1]` using a logarithmic scale.
 *
 * Why this exists
 * ---------------
 * Commit counts, complexity, and LOC often have long tails. Log scaling keeps
 * outliers from dominating the hotspot score.
 *
 * @param {unknown} value
 *   Observed metric value.
 * @param {unknown} maxValue
 *   Maximum observed metric value in the same population.
 * @returns {number}
 *   Log-normalized score in `[0, 1]`.
 */
function normalizeByLogScale(value, maxValue) {
  const v = Math.max(0, Number(value) || 0);
  const max = Math.max(0, Number(maxValue) || 0);
  if (v <= 0 || max <= 0) return 0;
  return clamp01(Math.log1p(v) / Math.log1p(max));
}


/**
 * Compute the hotspot score for one file node.
 *
 * @param {Record<string, unknown>} node
 *   File node payload.
 * @param {{commits?: number}} gitStat
 *   Git-derived change statistics for the file.
 * @param {{maxCommits: number, maxComplexity: number, maxLines: number}} maxima
 *   Population maxima used for normalization.
 * @returns {number}
 *   Hotspot score in `[0, 1]`.
 */
function computeFileHotspotScore(node, gitStat, maxima) {
  const complexity01 = normalizeByLogScale(readNodeComplexity(node), maxima.maxComplexity);
  const lines01 = normalizeByLogScale(readNodeLines(node), maxima.maxLines);
  const changeFreq01 = normalizeByLogScale(gitStat?.commits || 0, maxima.maxCommits);

  // CodeScene-like idea:
  // hotspot = code we change often + code that is expensive to understand.
  // We approximate understanding cost from complexity plus file size.
  const codeHealthPressure01 = clamp01((complexity01 * 0.8) + (lines01 * 0.2));
  return clamp01(changeFreq01 * codeHealthPressure01);
}

/**
 * Partition graph nodes into file nodes and function nodes.
 *
 * @param {Array<Record<string, unknown>>} nodes
 *   Full graph node collection.
 * @returns {{fileNodes: Array<object>, functionNodes: Array<object>}}
 *   Partitioned node groups used by hotspot enrichment.
 */
function splitNodesForHotspots(nodes) {
  return {
    fileNodes: nodes.filter(looksLikeFileNode),
    functionNodes: nodes.filter(looksLikeFunctionNode)
  };
}

/**
 * Scan file nodes to determine normalization maxima for hotspot scoring.
 *
 * @param {Array<Record<string, unknown>>} fileNodes
 *   File nodes participating in hotspot scoring.
 * @param {Map<string, {commits: number}>} gitStats
 *   Git-derived file statistics.
 * @returns {{maxCommits: number, maxComplexity: number, maxLines: number}}
 *   Population maxima used by the scoring model.
 */
function collectHotspotMaxima(fileNodes, gitStats) {
  const maxima = {
    maxCommits: 0,
    maxComplexity: 0,
    maxLines: 0
  };

  for (const fileNode of fileNodes) {
    const fileId = normalizeGraphFileId(fileNode?.file || fileNode?.id);
    const stat = gitStats.get(fileId);

    maxima.maxCommits = Math.max(maxima.maxCommits, toPositiveNumber(stat?.commits));
    maxima.maxComplexity = Math.max(maxima.maxComplexity, readNodeComplexity(fileNode));
    maxima.maxLines = Math.max(maxima.maxLines, readNodeLines(fileNode));
  }

  return maxima;
}

/**
 * Attach hotspot metrics to file nodes in place.
 *
 * @param {Array<Record<string, unknown>>} fileNodes
 *   File nodes to enrich.
 * @param {Map<string, {commits: number, lastTouchedEpoch: number}>} gitStats
 *   Git-derived file statistics.
 * @param {{maxCommits: number, maxComplexity: number, maxLines: number}} maxima
 *   Population maxima used for normalization.
 */
function enrichFileNodesWithHotspots(fileNodes, gitStats, maxima) {
  for (const fileNode of fileNodes) {
    const fileId = normalizeGraphFileId(fileNode?.file || fileNode?.id);
    const stat = gitStats.get(fileId) || { commits: 0, lastTouchedEpoch: 0 };

    fileNode._changeFreq = toPositiveNumber(stat.commits);
    fileNode._lastTouchedAt = safeIsoDateFromEpochSeconds(stat.lastTouchedEpoch);
    fileNode._hotspotScore = computeFileHotspotScore(fileNode, stat, maxima);
  }
}

/**
 * Index file nodes by normalized file identifier.
 *
 * @param {Array<Record<string, unknown>>} fileNodes
 *   File nodes to index.
 * @returns {Map<string, object>}
 *   Lookup map keyed by normalized file id.
 */
function mapFileNodesById(fileNodes) {
  return new Map(
    fileNodes.map((fileNode) => [normalizeGraphFileId(fileNode?.file || fileNode?.id), fileNode])
  );
}

/**
 * Propagate file-level hotspot metadata to owned function nodes.
 *
 * @param {Array<Record<string, unknown>>} functionNodes
 *   Function nodes to enrich.
 * @param {Map<string, Record<string, unknown>>} fileById
 *   File lookup indexed by normalized file id.
 */
function inheritHotspotsToFunctionNodes(functionNodes, fileById) {
  for (const fnNode of functionNodes) {
    const owner = fileById.get(normalizeGraphFileId(fnNode?.file));
    if (!owner) continue;

    fnNode._changeFreq = owner._changeFreq;
    fnNode._lastTouchedAt = owner._lastTouchedAt;
    fnNode._hotspotScore = owner._hotspotScore;
    fnNode._hotspotRank = owner._hotspotRank;
    fnNode.hotspot = Boolean(owner.hotspot);
  }
}


/**
 * Attach hotspot model provenance metadata to the metrics payload.
 *
 * @param {Record<string, unknown>} metrics
 *   Metrics payload being enriched.
 */
function attachHotspotModelMeta(metrics) {
  if (!metrics.meta || typeof metrics.meta !== "object") metrics.meta = {};

  metrics.meta.hotspotModel = {
    kind: "codescene-like",
    basedOn: ["git_commit_frequency", "file_complexity", "file_loc"],
    note: "Approximates CodeScene hotspots as frequently changed, cognitively expensive code."
  };
}

/**
 * Compare nodes by hotspot score in descending order.
 *
 * @param {Record<string, unknown>} a
 *   First node.
 * @param {Record<string, unknown>} b
 *   Second node.
 * @returns {number}
 *   Sort comparator result.
 */
function hotspotScoreDescending(a, b) {
  return (Number(b?._hotspotScore) || 0) - (Number(a?._hotspotScore) || 0);
}

/**
 * Compare nodes by stable identifier as a hotspot tie-breaker.
 *
 * @param {Record<string, unknown>} a
 *   First node.
 * @param {Record<string, unknown>} b
 *   Second node.
 * @returns {number}
 *   Locale-aware sort comparator result.
 */
function hotspotIdCompare(a, b) {
  return String(a?.id || "").localeCompare(String(b?.id || ""), "de");
}

/**
 * Compare two nodes for hotspot ranking.
 *
 * Sort order
 * ----------
 * 1. Higher hotspot score first
 * 2. Stable id comparison as deterministic tie-breaker
 *
 * @param {Record<string, unknown>} a
 *   First node.
 * @param {Record<string, unknown>} b
 *   Second node.
 * @returns {number}
 *   Sort comparator result.
 */
function compareHotspotNodes(a, b) {
  const scoreDiff = hotspotScoreDescending(a, b);
  if (scoreDiff) return scoreDiff;
  return hotspotIdCompare(a, b);
}

/**
 * Apply rank metadata and top-N hotspot flag to one ranked node.
 *
 * @param {Record<string, unknown>} node
 *   Ranked file node.
 * @param {number} index
 *   Zero-based rank index in sorted order.
 */
function applyHotspotRank(node, index) {
  node._hotspotRank = index + 1;
  node.hotspot = index < 10 && (Number(node?._hotspotScore) || 0) > 0;
}

/**
 * Rank file nodes by hotspot severity and mark the top cohort.
 *
 * @param {Array<Record<string, unknown>>} nodes
 *   File nodes to rank in place.
 */
function rankByHotspot(nodes) {
  const ranked = [...nodes].sort(compareHotspotNodes);
  ranked.forEach(applyHotspotRank);
}

/**
 * Enrich the metrics payload with CodeScene-like hotspot metadata.
 *
 * Why this exists
 * ---------------
 * The base analyzer describes structure. This post-processing step adds a
 * change-frequency signal from Git so the UI can highlight expensive, volatile
 * areas of the codebase.
 *
 * @param {Record<string, unknown>} metrics
 *   Metrics payload to enrich.
 * @param {string} projectRootAbs
 *   Absolute project root path.
 * @returns {Record<string, unknown>}
 *   The same metrics object after in-place enrichment.
 */
function enrichMetricsWithHotspots(metrics, projectRootAbs) {
  const nodes = Array.isArray(metrics?.nodes) ? metrics.nodes : [];
  if (!nodes.length) return metrics;
  if (!hasGitRepo(projectRootAbs)) return metrics;

  const gitStats = listGitFileStats(projectRootAbs);
  if (!gitStats.size) return metrics;

  const { fileNodes, functionNodes } = splitNodesForHotspots(nodes);
  const maxima = collectHotspotMaxima(fileNodes, gitStats);

  enrichFileNodesWithHotspots(fileNodes, gitStats, maxima);
  rankByHotspot(fileNodes);

  const fileById = mapFileNodesById(fileNodes);
  inheritHotspotsToFunctionNodes(functionNodes, fileById);
  attachHotspotModelMeta(metrics);

  return metrics;
}

// ---------------------------------------------------------------------------
// Analyzer integration
// ---------------------------------------------------------------------------
// We import lazily so server boot does not fail immediately if the analyzer
// module changes during refactors.
/**
 * Lazily load the analyzer module and build the graph metrics payload.
 *
 * Why this exists
 * ---------------
 * Lazy import keeps server startup resilient while analyzer modules are under
 * active refactor and allows route-time failure reporting instead of boot-time
 * crashes.
 *
 * @param {{projectRootAbs: string, entryAbs: string, urlInfo: object, maxDirDepth: number}} params
 *   Analyzer invocation parameters.
 * @returns {Promise<Record<string, unknown>>}
 *   Built metrics payload.
 * @throws {Error}
 *   Thrown when the analyzer export is missing or the analyzer fails.
 */
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

/**
 * Parse the optional directory-depth limit from the request body.
 *
 * @param {Record<string, unknown>} body
 *   Request body payload.
 * @returns {number}
 *   Positive depth limit, defaulting to `3`.
 */
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
/**
 * Send a normalized HTTP 400 response.
 *
 * @param {import("express").Response} res
 *   Express response object.
 * @param {unknown} message
 *   Error message to expose to the client.
 * @returns {import("express").Response}
 *   Sent response instance.
 */
function sendBadRequest(res, message) {
  return res.status(400).json({ error: { message: String(message || "Bad Request") } });
}

/**
 * Send a normalized unsupported-analysis response.
 *
 * @param {import("express").Response} res
 *   Express response object.
 * @param {{reason?: string, message?: string, details?: unknown}} payload
 *   Unsupported-target details.
 * @returns {import("express").Response}
 *   Sent response instance.
 */
function sendUnsupported(res, { reason, message, details }) {
  return res.status(400).json({
    analysisStatus: "unsupported",
    reason: String(reason || "unsupported"),
    message: String(message || "Unsupported target"),
    details
  });
}

/**
 * Send a normalized HTTP 500 response for unexpected analysis failures.
 *
 * @param {import("express").Response} res
 *   Express response object.
 * @param {unknown} err
 *   Thrown error or error-like value.
 * @returns {import("express").Response}
 *   Sent response instance.
 */
function sendServerError(res, err) {
  const msg = String(err?.message || err || "Analyze failed");
  return res.status(500).json({ error: { message: msg } });
}

/**
 * Read the requested app identifier from the request body.
 *
 * @param {import("express").Request} req
 *   Express request object.
 * @returns {string}
 *   Normalized requested app id.
 */
function getRequestedAppId(req) {
  return normalizeId(req?.body?.appId);
}

/**
 * Load the application registry and resolve one app by id.
 *
 * @param {string} appId
 *   Requested application identifier.
 * @returns {object | null}
 *   Matching application config, or `null` when not found.
 */
function getAppById(appId) {
  const apps = loadAppsConfig();
  return findAppById(apps, appId);
}

/**
 * Resolve and validate the configured application root directory.
 *
 * @param {object} app
 *   Application config record.
 * @returns {{ok: true, appRootAbs: string} | {ok: false, kind: string, payload: object}}
 *   Success or unsupported-result object.
 */
function resolveAndValidateAppRoot(app) {
  const appRootAbs = resolveAppRootAbs(app);
  if (!appRootAbs) {
    return {
      ok: false,
      kind: "unsupported",
      payload: {
        reason: "missing-rootDir",
        message: "App config is missing rootDir/root/path.",
        details: app
      }
    };
  }

  if (!fs.existsSync(appRootAbs) || !fs.statSync(appRootAbs).isDirectory()) {
    return {
      ok: false,
      kind: "unsupported",
      payload: {
        reason: "rootDir-not-found",
        message: `App rootDir does not exist or is not a directory: ${appRootAbs}`,
        details: app
      }
    };
  }

  return { ok: true, appRootAbs };
}

/**
 * Resolve and validate the analyzer entry file for one application.
 *
 * @param {string} appRootAbs
 *   Absolute application root directory.
 * @param {object} app
 *   Application config record.
 * @returns {{ok: true, entryAbs: string} | {ok: false, kind: string, payload: object}}
 *   Success or unsupported-result object.
 */
function resolveAndValidateEntryAbs(appRootAbs, app) {
  const entryAbs = resolveEntryAbs(appRootAbs, app);
  if (entryAbs) return { ok: true, entryAbs };

  return {
    ok: false,
    kind: "unsupported",
    payload: {
      reason: "missing-entry",
      message: "Cannot resolve entry file. Provide 'entry' in apps.json (relative to rootDir).",
      details: app
    }
  };
}

/**
 * Build the lightweight app descriptor passed into the analyzer.
 *
 * @param {string} appId
 *   Requested application identifier.
 * @param {object} app
 *   Application config record.
 * @returns {{appId: string, appName: string, url: string, entry: string}}
 *   Analyzer-facing app descriptor.
 */
function buildUrlInfo(appId, app) {
  return {
    appId,
    appName: String(app?.name || appId),
    url: String(app?.url || ""),
    entry: String(app?.entry || "")
  };
}


/**
 * Build the public API response for a successful analysis run.
 *
 * @param {string} runToken
 *   Opaque run identifier.
 * @param {string} appId
 *   Requested application identifier.
 * @param {string} timestampIso
 *   Run timestamp in ISO form.
 * @param {Record<string, unknown>} metrics
 *   Built metrics payload.
 * @returns {{runToken: string, metricsUrl: string, csvUrl: string, summary: {nodes: number, links: number}}}
 *   Response payload sent to the client.
 */
function buildAnalyzeResponse(runToken, appId, timestampIso, metrics) {
  const artifacts = metricsArtifacts(appId, timestampIso);

  return {
    runToken,
    metricsUrl: artifacts.jsonUrl,
    csvUrl: artifacts.csvUrl,
    summary: summaryFromMetrics(metrics)
  };
}

/**
 * Resolve the requested application from the incoming analyze request.
 *
 * @param {import("express").Request} req
 *   Express request object.
 * @returns {{ok: true, appId: string, app: object} | {ok: false, kind: string, payload: string}}
 *   Success or bad-request result.
 */
function resolveAnalyzeApp(req) {
  const appId = getRequestedAppId(req);
  if (!appId) {
    return {
      ok: false,
      kind: "bad-request",
      payload: "Missing appId"
    };
  }

  const app = getAppById(appId);
  if (!app) {
    return {
      ok: false,
      kind: "bad-request",
      payload: `Unknown appId: ${appId}`
    };
  }

  return { ok: true, appId, app };
}

/**
 * Resolve the validated filesystem target for one application analysis.
 *
 * @param {object} app
 *   Application config record.
 * @returns {{ok: true, appRootAbs: string, entryAbs: string} | {ok: false, kind: string, payload: object}}
 *   Success or unsupported-result object.
 */
function resolveAnalyzeTarget(app) {
  const rootResult = resolveAndValidateAppRoot(app);
  if (!rootResult.ok) return rootResult;

  const entryResult = resolveAndValidateEntryAbs(rootResult.appRootAbs, app);
  if (!entryResult.ok) return entryResult;

  return {
    ok: true,
    appRootAbs: rootResult.appRootAbs,
    entryAbs: entryResult.entryAbs
  };
}

/**
 * Convert a typed analyze-result failure into the appropriate HTTP response.
 *
 * @param {import("express").Response} res
 *   Express response object.
 * @param {{kind?: string, payload?: unknown}} result
 *   Failure result emitted by resolution helpers.
 * @returns {import("express").Response}
 *   Sent response instance.
 */
function sendAnalyzeFailure(res, result) {
  if (result?.kind === "bad-request") {
    return sendBadRequest(res, result.payload);
  }

  return sendUnsupported(res, result?.payload);
}

/**
 * Build immutable per-request analysis context.
 *
 * @param {import("express").Request} req
 *   Express request object.
 * @param {string} appId
 *   Requested application identifier.
 * @param {object} app
 *   Application config record.
 * @returns {{appId: string, app: object, maxDirDepth: number, urlInfo: object, runToken: string, timestampIso: string}}
 *   Request-scoped analysis context.
 */
function buildAnalyzeContext(req, appId, app) {
  return {
    appId,
    app,
    maxDirDepth: parseMaxDirDepth(req.body),
    urlInfo: buildUrlInfo(appId, app),
    runToken: newRunToken(),
    timestampIso: new Date().toISOString()
  };
}

/**
 * Build and enrich the metrics payload for one analysis request.
 *
 * @param {{urlInfo: object, maxDirDepth: number}} context
 *   Request-scoped analysis context.
 * @param {{appRootAbs: string, entryAbs: string}} target
 *   Validated analysis target.
 * @returns {Promise<Record<string, unknown>>}
 *   Built and hotspot-enriched metrics payload.
 */
async function buildAnalyzeMetrics(context, target) {
  return enrichMetricsWithHotspots(
    await buildMetrics({
      projectRootAbs: target.appRootAbs,
      entryAbs: target.entryAbs,
      urlInfo: context.urlInfo,
      maxDirDepth: context.maxDirDepth
    }),
    target.appRootAbs
  );
}

/**
 * Notify the live-change subsystem that an application analysis was activated.
 *
 * @param {{appId: string, app: object}} context
 *   Request-scoped analysis context.
 * @param {{appRootAbs: string}} target
 *   Validated analysis target.
 * @returns {Promise<void>}
 *   Resolves when activation bookkeeping is complete.
 */
async function activateAnalyzeRun(context, target) {
  await activateAnalysis({
    appId: context.appId,
    rootAbs: target.appRootAbs,
    entryRel: String(context.app?.entry || "").trim() || null
  });
}

/**
 * Handle the analyze endpoint.
 *
 * Request flow
 * ------------
 * 1. Resolve the requested app
 * 2. Validate root directory and entry file
 * 3. Build graph metrics
 * 4. Enrich metrics with hotspot metadata
 * 5. Persist artifacts
 * 6. Activate live analysis state
 * 7. Return response payload
 *
 * @param {import("express").Request} req
 *   Express request object.
 * @param {import("express").Response} res
 *   Express response object.
 * @returns {Promise<import("express").Response>}
 *   Sent response instance.
 */
async function handleAnalyze(req, res) {
  try {
    const appResult = resolveAnalyzeApp(req);
    if (!appResult.ok) return sendAnalyzeFailure(res, appResult);

    const targetResult = resolveAnalyzeTarget(appResult.app);
    if (!targetResult.ok) return sendAnalyzeFailure(res, targetResult);

    const context = buildAnalyzeContext(req, appResult.appId, appResult.app);
    const metrics = await buildAnalyzeMetrics(context, targetResult);

    writeMetricsArtifacts(context.appId, context.timestampIso, metrics);
    await activateAnalyzeRun(context, targetResult);

    return res.json(
      buildAnalyzeResponse(context.runToken, context.appId, context.timestampIso, metrics)
    );
  } catch (e) {
    return sendServerError(res, e);
  }
}

["/", "/analyze"].forEach((routePath) => {
  router.post(routePath, handleAnalyze);
});

export default router;

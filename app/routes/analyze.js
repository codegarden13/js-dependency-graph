import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawnSync } from "node:child_process";

import { activateAnalysis } from "../lib/liveChangeFeed.js";
import { normalizeFsPath } from "../lib/fsPaths.js";


// NOTE:
// This module is imported as a *default export* by the server bootstrap.
// Therefore we must default-export an Express router.
const router = express.Router();


// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

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
// Metrics artifact paths
// ---------------------------------------------------------------------------

function outputDirAbs() {
  return normalizeFsPath(path.join(process.cwd(), "app", "public", "output"));
}

function ensureOutputDir() {
  const dir = outputDirAbs();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function metricsBaseName(runToken) {
  return `code-structure-${normalizeId(runToken)}`;
}

/**
 * Build the full artifact descriptor for one analysis run.
 *
 * Keeping the derived names/paths/urls in one place prevents tiny helper
 * functions from drifting apart over time.
 */
function metricsArtifacts(runToken) {
  const baseName = metricsBaseName(runToken);
  const jsonFilename = `${baseName}.json`;
  const csvFilename = `${baseName}.csv`;

  return {
    baseName,
    jsonFilename,
    csvFilename,
    jsonPath: path.join(outputDirAbs(), jsonFilename),
    csvPath: path.join(outputDirAbs(), csvFilename),
    jsonUrl: `/output/${jsonFilename}`,
    csvUrl: `/output/${csvFilename}`
  };
}

function metricsJsonFilename(runToken) {
  return metricsArtifacts(runToken).jsonFilename;
}

function metricsCsvFilename(runToken) {
  return metricsArtifacts(runToken).csvFilename;
}

function metricsJsonPath(runToken) {
  return metricsArtifacts(runToken).jsonPath;
}

function metricsCsvPath(runToken) {
  return metricsArtifacts(runToken).csvPath;
}

function metricsPublicUrl(runToken) {
  return metricsArtifacts(runToken).jsonUrl;
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

function csvEscape(value) {
  const s = String(value ?? "");
  if (!/[",\n]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

// ---------------------------------------------------------------------------
// CSV row projection
// ---------------------------------------------------------------------------

function nodeRow(node) {
  return {
    kind: node?.kind,
    id: node?.id,
    file: node?.file,
    label: node?.label,
    type: node?.type,
    group: node?.group,
    layer: node?.layer,
    lines: node?.lines,
    complexity: node?.complexity,
    exported: node?.exported,
    imported: node?.imported,
    unused: node?.unused,
    hotspot: node?.hotspot,
    hotspotRank: node?._hotspotRank,
    hotspotScore: node?._hotspotScore,
    changeFreq: node?._changeFreq,
    lastTouchedAt: node?._lastTouchedAt,
    x: node?.x,
    y: node?.y
  };
}

function linkRow(link) {
  return {
    relation: "link",
    source: link?.source,
    target: link?.target,
    kind: link?.kind,
    type: link?.type,
    value: link?.value
  };
}

function buildMetricsCsv(metrics) {
  const rows = [];

  for (const node of Array.isArray(metrics?.nodes) ? metrics.nodes : []) {
    rows.push({ relation: "node", ...nodeRow(node) });
  }

  for (const link of Array.isArray(metrics?.links) ? metrics.links : []) {
    rows.push(linkRow(link));
  }

  const headers = [
    "relation",
    "kind",
    "id",
    "file",
    "label",
    "type",
    "group",
    "layer",
    "lines",
    "complexity",
    "exported",
    "imported",
    "unused",
    "hotspot",
    "hotspotRank",
    "hotspotScore",
    "changeFreq",
    "lastTouchedAt",
    "x",
    "y",
    "source",
    "target",
    "value"
  ];

  const body = rows.map((row) => headers.map((key) => csvEscape(row?.[key])).join(","));
  return [headers.join(","), ...body].join("\n");
}

function writeMetricsArtifacts(runToken, metrics) {
  ensureOutputDir();

  const artifacts = metricsArtifacts(runToken);

  fs.writeFileSync(
    artifacts.jsonPath,
    JSON.stringify(metrics, null, 2),
    "utf8"
  );

  fs.writeFileSync(
    artifacts.csvPath,
    buildMetricsCsv(metrics),
    "utf8"
  );
}

// ---------------------------------------------------------------------------
// Apps config (app/config/apps.json)
// ---------------------------------------------------------------------------
function appsConfigPath() {
  return normalizeFsPath(path.join(process.cwd(), "app", "config", "apps.json"));
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

  if (path.isAbsolute(rootDir)) {
    return normalizeFsPath(rootDir);
  }

  return normalizeFsPath(path.join(process.cwd(), rootDir));
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

// ---------------------------------------------------------------------------
// Metrics summary + hotspot enrichment
// ---------------------------------------------------------------------------

function summaryFromMetrics(metrics) {
  const nodes = Array.isArray(metrics?.nodes) ? metrics.nodes.length : 0;
  const links = Array.isArray(metrics?.links) ? metrics.links.length : 0;
  return { nodes, links };
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function toPositiveNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function looksLikeFunctionNode(node) {
  return String(node?.kind || "") === "function";
}

function looksLikeFileNode(node) {
  return String(node?.kind || "") === "file";
}

function normalizeGraphFileId(v) {
  return String(v || "").replace(/\\/g, "/").trim();
}

function readNodeComplexity(node) {
  return toPositiveNumber(node?.complexity);
}

function readNodeLines(node) {
  return toPositiveNumber(node?.lines);
}

function safeIsoDateFromEpochSeconds(epochSeconds) {
  const ms = Number(epochSeconds) * 1000;
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

function hasGitRepo(projectRootAbs) {
  const probe = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: projectRootAbs,
    encoding: "utf8"
  });

  return probe.status === 0;
}

function listGitFileStats(projectRootAbs) {
  const cmd = [
    "log",
    "--name-only",
    "--format=@@@%ct",
    "--no-merges",
    "--",
    "."
  ];

  const res = spawnSync("git", cmd, {
    cwd: projectRootAbs,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });

  if (res.status !== 0) {
    const stderr = String(res.stderr || res.stdout || "git log failed").trim();
    throw new Error(stderr || "git log failed");
  }

  const stats = new Map();
  let currentEpoch = null;

  for (const rawLine of String(res.stdout || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("@@@")) {
      currentEpoch = Number(line.slice(3));
      continue;
    }

    const relPath = normalizeGraphFileId(line);
    if (!relPath) continue;

    let entry = stats.get(relPath);
    if (!entry) {
      entry = {
        commits: 0,
        lastTouchedEpoch: 0
      };
      stats.set(relPath, entry);
    }

    entry.commits += 1;
    if (Number.isFinite(currentEpoch) && currentEpoch > entry.lastTouchedEpoch) {
      entry.lastTouchedEpoch = currentEpoch;
    }
  }

  return stats;
}

function normalizeByLogScale(value, maxValue) {
  const v = Math.max(0, Number(value) || 0);
  const max = Math.max(0, Number(maxValue) || 0);
  if (v <= 0 || max <= 0) return 0;
  return clamp01(Math.log1p(v) / Math.log1p(max));
}

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

function rankByHotspot(nodes) {
  const ranked = [...nodes].sort((a, b) => {
    const scoreDiff = (Number(b?._hotspotScore) || 0) - (Number(a?._hotspotScore) || 0);
    if (scoreDiff) return scoreDiff;
    return String(a?.id || "").localeCompare(String(b?.id || ""), "de");
  });

  ranked.forEach((node, index) => {
    node._hotspotRank = index + 1;
    node.hotspot = index < 10 && (Number(node?._hotspotScore) || 0) > 0;
  });
}

function enrichMetricsWithHotspots(metrics, projectRootAbs) {
  const nodes = Array.isArray(metrics?.nodes) ? metrics.nodes : [];
  if (!nodes.length) return metrics;
  if (!hasGitRepo(projectRootAbs)) return metrics;

  const gitStats = listGitFileStats(projectRootAbs);
  if (!gitStats.size) return metrics;

  const fileNodes = nodes.filter(looksLikeFileNode);
  const functionNodes = nodes.filter(looksLikeFunctionNode);

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

  for (const fileNode of fileNodes) {
    const fileId = normalizeGraphFileId(fileNode?.file || fileNode?.id);
    const stat = gitStats.get(fileId) || { commits: 0, lastTouchedEpoch: 0 };

    fileNode._changeFreq = toPositiveNumber(stat.commits);
    fileNode._lastTouchedAt = safeIsoDateFromEpochSeconds(stat.lastTouchedEpoch);
    fileNode._hotspotScore = computeFileHotspotScore(fileNode, stat, maxima);
  }

  rankByHotspot(fileNodes);

  const fileById = new Map(
    fileNodes.map((fileNode) => [normalizeGraphFileId(fileNode?.file || fileNode?.id), fileNode])
  );

  for (const fnNode of functionNodes) {
    const owner = fileById.get(normalizeGraphFileId(fnNode?.file));
    if (!owner) continue;

    fnNode._changeFreq = owner._changeFreq;
    fnNode._lastTouchedAt = owner._lastTouchedAt;
    fnNode._hotspotScore = owner._hotspotScore;
    fnNode._hotspotRank = owner._hotspotRank;
    fnNode.hotspot = Boolean(owner.hotspot);
  }

  if (!metrics.meta || typeof metrics.meta !== "object") metrics.meta = {};
  metrics.meta.hotspotModel = {
    kind: "codescene-like",
    basedOn: ["git_commit_frequency", "file_complexity", "file_loc"],
    note: "Approximates CodeScene hotspots as frequently changed, cognitively expensive code."
  };

  return metrics;
}

// ---------------------------------------------------------------------------
// Analyzer integration
// ---------------------------------------------------------------------------
// We import lazily so server boot does not fail immediately if the analyzer
// module changes during refactors.
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
function sendBadRequest(res, message) {
  return res.status(400).json({ error: { message: String(message || "Bad Request") } });
}

function sendUnsupported(res, { reason, message, details }) {
  return res.status(400).json({
    analysisStatus: "unsupported",
    reason: String(reason || "unsupported"),
    message: String(message || "Unsupported target"),
    details
  });
}

function sendServerError(res, err) {
  const msg = String(err?.message || err || "Analyze failed");
  return res.status(500).json({ error: { message: msg } });
}

function getRequestedAppId(req) {
  return normalizeId(req?.body?.appId);
}

function getAppById(appId) {
  const apps = loadAppsConfig();
  return findAppById(apps, appId);
}

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

function buildUrlInfo(appId, app) {
  return {
    appId,
    appName: String(app?.name || appId),
    url: String(app?.url || ""),
    entry: String(app?.entry || "")
  };
}

function buildAnalyzeResponse(runToken, metrics) {
  const artifacts = metricsArtifacts(runToken);

  return {
    runToken,
    metricsUrl: artifacts.jsonUrl,
    csvUrl: artifacts.csvUrl,
    summary: summaryFromMetrics(metrics)
  };
}

async function handleAnalyze(req, res) {
  try {
    const appId = getRequestedAppId(req);
    if (!appId) return sendBadRequest(res, "Missing appId");

    const app = getAppById(appId);
    if (!app) return sendBadRequest(res, `Unknown appId: ${appId}`);

    const rootResult = resolveAndValidateAppRoot(app);
    if (!rootResult.ok) return sendUnsupported(res, rootResult.payload);

    const entryResult = resolveAndValidateEntryAbs(rootResult.appRootAbs, app);
    if (!entryResult.ok) return sendUnsupported(res, entryResult.payload);

    const maxDirDepth = parseMaxDirDepth(req.body);
    const urlInfo = buildUrlInfo(appId, app);
    const runToken = newRunToken();

    const metrics = enrichMetricsWithHotspots(
      await buildMetrics({
        projectRootAbs: rootResult.appRootAbs,
        entryAbs: entryResult.entryAbs,
        urlInfo,
        maxDirDepth
      }),
      rootResult.appRootAbs
    );

    writeMetricsArtifacts(runToken, metrics);

    await activateAnalysis({
      appId,
      rootAbs: rootResult.appRootAbs,
      entryRel: String(app?.entry || "").trim() || null
    });

    return res.json(buildAnalyzeResponse(runToken, metrics));
  } catch (e) {
    return sendServerError(res, e);
  }
}

["/", "/analyze"].forEach((routePath) => {
  router.post(routePath, handleAnalyze);
});

export default router;
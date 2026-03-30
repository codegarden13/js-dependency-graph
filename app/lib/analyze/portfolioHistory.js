import fs from "node:fs";
import path from "node:path";
import fetch from "node-fetch";

import { OUTPUT_DIR } from "../projectPaths.js";
import { normalizeId } from "../stringUtils.js";
import { resolveAppRootAbs } from "../appsRegistry.js";
import { collectGitHeadInfo } from "../appInfo.js";

const CODE_FILE_EXT_RE = /\.(js|mjs|cjs|ts|tsx|jsx)$/i;
const CODE_METRICS_SUFFIX = "-code-metrics.csv";
const APP_STATUS_TIMEOUT_MS = 1200;
const MODULE_PRIORITY_WEIGHTS = Object.freeze({
  hotness: 0.5,
  ccDensity: 0.3,
  codeLines: 0.2
});

export async function buildPortfolioHistory(apps, options = {}) {
  const configuredApps = Array.isArray(apps) ? apps : [];
  const historyFilesByAppId = groupHistoryFilesByAppId(listAllHistoryFiles());
  const availabilityByAppId = await probeAppAvailability(configuredApps, options);

  return {
    generatedAt: new Date().toISOString(),
    apps: configuredApps
      .map((app) => buildConfiguredAppHistory(app, historyFilesByAppId, availabilityByAppId))
      .filter(Boolean)
  };
}

function buildConfiguredAppHistory(app, historyFilesByAppId, availabilityByAppId) {
  const appId = normalizeId(app?.id);
  if (!appId) return null;

  const { history, latestModules } = buildAppHistory(appId, historyFilesByAppId.get(appId) || []);
  const latest = history[history.length - 1] || null;
  const appRootAbs = resolveAppRootAbs(app);
  const git = appRootAbs ? collectGitHeadInfo(appRootAbs) : { available: false, repoRootAbs: "", head: null };

  return {
    appId,
    name: String(app?.name || appId),
    url: String(app?.url || ""),
    entry: String(app?.entry || ""),
    runCount: history.length,
    latest,
    history,
    latestModules,
    analyze: buildAnalyzeStatus(latest, git),
    availability: availabilityByAppId?.get(appId) || buildOfflineAvailability()
  };
}

function buildAnalyzeStatus(latest, git) {
  const latestRunEpoch = readIsoDateEpoch(latest?.timestamp);
  const head = git?.head || null;
  const headEpoch = readIsoDateEpoch(head?.committedAt);
  const pending = Boolean(
    git?.available &&
    head &&
    headEpoch !== null &&
    (latestRunEpoch === null || headEpoch > latestRunEpoch)
  );

  if (!pending) {
    return {
      pending: false,
      label: "Analyze",
      title: "Run analysis for this app."
    };
  }

  const shortSha = String(head?.shortSha || "").trim();
  const committedAt = String(head?.committedAt || "").trim();
  const shaPart = shortSha ? ` for commit ${shortSha}` : "";
  const atPart = committedAt ? ` (${committedAt})` : "";

  return {
    pending: true,
    label: "Analyze pending",
    title: `A newer commit is waiting for analysis${shaPart}${atPart}.`
  };
}

async function probeAppAvailability(apps, options = {}) {
  const entries = await Promise.all(
    (apps || []).map(async (app) => {
      const appId = normalizeId(app?.id);
      if (!appId) return null;
      return [appId, await probeSingleAppAvailability(app?.url, options)];
    })
  );

  return new Map(entries.filter(Boolean));
}

async function probeSingleAppAvailability(url, options = {}) {
  const safeUrl = String(url || "").trim();
  if (!safeUrl) return buildOfflineAvailability();
  if (matchesRequestOrigin(safeUrl, options?.requestUrl)) {
    return buildReachableAvailability();
  }

  try {
    const headResponse = await fetchAppUrl(safeUrl, "HEAD");
    if (isReachableResponse(headResponse)) {
      return buildReachableAvailability();
    }

    if (!shouldRetryAvailabilityProbe(headResponse?.status)) {
      return buildOfflineAvailability();
    }

    const getResponse = await fetchAppUrl(safeUrl, "GET");
    return isReachableResponse(getResponse)
      ? buildReachableAvailability()
      : buildOfflineAvailability();
  } catch {
    return buildOfflineAvailability();
  }
}

function matchesRequestOrigin(appUrl, requestUrl) {
  const current = safeParseUrl(requestUrl);
  const target = safeParseUrl(appUrl, requestUrl);
  if (!current || !target) return false;

  return (
    normalizeProtocol(current) === normalizeProtocol(target) &&
    normalizeUrlPort(current) === normalizeUrlPort(target) &&
    normalizeLoopbackHost(current.hostname) === normalizeLoopbackHost(target.hostname)
  );
}

function safeParseUrl(url, baseUrl = undefined) {
  const safeUrl = String(url || "").trim();
  if (!safeUrl) return null;

  try {
    return baseUrl ? new URL(safeUrl, baseUrl) : new URL(safeUrl);
  } catch {
    return null;
  }
}

function normalizeProtocol(url) {
  return String(url?.protocol || "").trim().toLowerCase();
}

function normalizeUrlPort(url) {
  const explicitPort = Number(url?.port || 0);
  if (Number.isInteger(explicitPort) && explicitPort > 0) return String(explicitPort);
  return normalizeProtocol(url) === "https:" ? "443" : "80";
}

function normalizeLoopbackHost(hostname = "") {
  const safeHost = String(hostname || "").trim().toLowerCase();
  if (safeHost === "localhost" || safeHost === "127.0.0.1" || safeHost === "::1" || safeHost === "[::1]") {
    return "loopback";
  }
  return safeHost;
}

async function fetchAppUrl(url, method) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), APP_STATUS_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method,
      redirect: "manual",
      signal: controller.signal
    });

    response.body?.destroy?.();
    return response;
  } finally {
    clearTimeout(timer);
  }
}

function isReachableResponse(response) {
  const status = Number(response?.status || 0);
  return status >= 200 && status < 500;
}

function shouldRetryAvailabilityProbe(status) {
  const code = Number(status || 0);
  return code === 405 || code === 501;
}

function buildReachableAvailability() {
  return {
    reachable: true,
    state: "online",
    label: "reachable"
  };
}

function buildOfflineAvailability() {
  return {
    reachable: false,
    state: "offline",
    label: "offline"
  };
}

function listAllHistoryFiles() {
  try {
    return fs.readdirSync(OUTPUT_DIR)
      .filter(isCodeMetricsFile)
      .sort();
  } catch {
    return [];
  }
}

function isCodeMetricsFile(fileName) {
  return String(fileName || "").endsWith(CODE_METRICS_SUFFIX);
}

function groupHistoryFilesByAppId(fileNames) {
  const grouped = new Map();

  for (const fileName of fileNames || []) {
    const appId = extractAppIdFromHistoryFileName(fileName);
    if (!appId) continue;

    const existing = grouped.get(appId);
    if (existing) {
      existing.push(fileName);
      continue;
    }

    grouped.set(appId, [fileName]);
  }

  return grouped;
}

function extractAppIdFromHistoryFileName(fileName) {
  const match = String(fileName || "")
    .match(/^(.*)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-code-metrics\.csv$/);
  return normalizeId(match?.[1]);
}

function buildAppHistory(appId, fileNames) {
  const history = [];
  let latestRows = [];

  for (const fileName of fileNames || []) {
    const run = buildHistoryRun(appId, fileName);
    if (!run) continue;

    history.push(run.historyEntry);
    latestRows = run.rows;
  }

  return {
    history,
    latestModules: latestRows.length
      ? rankLatestModules(extractLatestModules(latestRows, appId))
      : []
  };
}

function buildHistoryRun(appId, fileName) {
  const timestamp = extractRunDate(fileName, appId);
  if (!timestamp) return null;

  const rows = readCsvRows(path.join(OUTPUT_DIR, fileName));
  if (!isSupportedHistoryRows(rows)) return null;

  return {
    historyEntry: {
      file: fileName,
      timestamp,
      ...summarizeHistoryRows(rows)
    },
    rows
  };
}

function extractRunDate(fileName, appId) {
  const prefix = `${appId}-`;
  const suffix = CODE_METRICS_SUFFIX;

  if (!String(fileName || "").startsWith(prefix)) return "";
  if (!String(fileName || "").endsWith(suffix)) return "";

  const raw = String(fileName).slice(prefix.length, -suffix.length);
  const iso = raw.replace(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    "$1T$2:$3:$4.$5Z"
  );

  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function readCsvRows(filePath) {
  try {
    return parseCsvText(fs.readFileSync(filePath, "utf8"));
  } catch {
    return [];
  }
}

function parseCsvText(text) {
  const lines = String(text || "")
    .split(/\r\n|\r|\n/)
    .filter((line) => line.length > 0);

  if (!lines.length) return [];

  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => buildCsvRow(headers, splitCsvLine(line)));
}

function isSupportedHistoryRows(rows) {
  const sample = Array.isArray(rows) ? rows[0] : null;
  if (!sample || typeof sample !== "object") return false;

  return [
    "relation",
    "kind",
    "file",
    "fileName"
  ].some((key) => Object.prototype.hasOwnProperty.call(sample, key));
}

function splitCsvLine(line) {
  const text = String(line || "");
  const fields = [];
  let value = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index++) {
    const ch = text[index];

    if (ch === `"`) {
      if (inQuotes && text[index + 1] === `"`) {
        value += `"`;
        index++;
        continue;
      }

      inQuotes = !inQuotes;
      continue;
    }

    if (ch === "," && !inQuotes) {
      fields.push(value);
      value = "";
      continue;
    }

    value += ch;
  }

  fields.push(value);
  return fields;
}

function buildCsvRow(headers, values) {
  const row = {};

  headers.forEach((header, index) => {
    row[header] = values[index] ?? "";
  });

  return row;
}

function summarizeHistoryRows(rows) {
  const aggregate = createHistoryAggregate();

  for (const row of rows) {
    if (!isProjectCodeRow(row)) continue;
    mergeHistoryRow(aggregate, row);
  }

  return finalizeHistoryAggregate(aggregate);
}

function extractLatestModules(rows, appId) {
  return (rows || [])
    .filter(isProjectCodeRow)
    .map((row) => toLatestModuleMetric(row, appId))
    .filter(Boolean);
}

function toLatestModuleMetric(row, appId) {
  const module = readHistoryFileName(row);
  if (!module) return null;

  const codeLines = readCodeLinesValue(row).value;
  const cc = readCcValue(row) ?? 0;
  const hotness = readNumberOrZero(row?.hotspotScore);

  return {
    appId,
    module,
    codeLines,
    cc,
    hotness,
    ccDensity: codeLines > 0 ? (cc / codeLines) * 1000 : 0
  };
}

function rankLatestModules(modules) {
  const maxima = collectLatestModuleMaxima(modules);

  return modules
    .map((module) => attachModulePriority(module, maxima))
    .sort(compareLatestModules);
}

function collectLatestModuleMaxima(modules) {
  return {
    hotness: maxModuleMetric(modules, (module) => module.hotness),
    ccDensity: maxModuleMetric(modules, (module) => module.ccDensity),
    codeLines: maxModuleMetric(modules, (module) => module.codeLines)
  };
}

function maxModuleMetric(modules, readValue) {
  let max = 0;

  for (const module of modules) {
    const value = Number(readValue(module) || 0);
    if (value > max) max = value;
  }

  return max;
}

function attachModulePriority(module, maxima) {
  const hotnessNorm = normalizeModuleMetric(module.hotness, maxima.hotness);
  const ccDensityNorm = normalizeModuleMetric(module.ccDensity, maxima.ccDensity);
  const codeLinesNorm = normalizeModuleMetric(module.codeLines, maxima.codeLines);
  const priority =
    hotnessNorm * MODULE_PRIORITY_WEIGHTS.hotness +
    ccDensityNorm * MODULE_PRIORITY_WEIGHTS.ccDensity +
    codeLinesNorm * MODULE_PRIORITY_WEIGHTS.codeLines;

  return {
    ...module,
    priority,
    priorityPct: Math.round(priority * 100)
  };
}

function normalizeModuleMetric(value, max) {
  const numericValue = Number(value || 0);
  const numericMax = Number(max || 0);
  if (!Number.isFinite(numericValue) || numericValue <= 0) return 0;
  if (!Number.isFinite(numericMax) || numericMax <= 0) return 0;
  return numericValue / numericMax;
}

function compareLatestModules(a, b) {
  return (
    (Number(b?.priority) || 0) - (Number(a?.priority) || 0) ||
    (Number(b?.hotness) || 0) - (Number(a?.hotness) || 0) ||
    (Number(b?.ccDensity) || 0) - (Number(a?.ccDensity) || 0) ||
    (Number(b?.codeLines) || 0) - (Number(a?.codeLines) || 0) ||
    String(a?.module || "").localeCompare(String(b?.module || ""))
  );
}

function createHistoryAggregate() {
  return {
    fileCount: 0,
    locTotal: 0,
    codeLinesTotal: 0,
    explicitCodeRows: 0,
    commentLinesTotal: 0,
    commentRows: 0,
    hotnessTotal: 0,
    hotnessRows: 0,
    ccTotal: 0,
    ccRows: 0,
    lastTouchedEpoch: null
  };
}

function mergeHistoryRow(aggregate, row) {
  aggregate.fileCount++;
  aggregate.locTotal += readLocValue(row);

  const codeLines = readCodeLinesValue(row);
  aggregate.codeLinesTotal += codeLines.value;
  if (codeLines.explicit) aggregate.explicitCodeRows++;

  const commentLines = readNumberOrNull(row?.commentLines);
  if (commentLines !== null) {
    aggregate.commentLinesTotal += commentLines;
    aggregate.commentRows++;
  }

  const hotspotScore = readNumberOrNull(row?.hotspotScore);
  if (hotspotScore !== null) {
    aggregate.hotnessTotal += hotspotScore;
    aggregate.hotnessRows++;
  }

  const ccValue = readCcValue(row);
  if (ccValue !== null) {
    aggregate.ccTotal += ccValue;
    aggregate.ccRows++;
  }

  const lastTouchedEpoch = readIsoDateEpoch(row?.lastTouchedAt);
  if (lastTouchedEpoch !== null && (
    aggregate.lastTouchedEpoch === null ||
    lastTouchedEpoch > aggregate.lastTouchedEpoch
  )) {
    aggregate.lastTouchedEpoch = lastTouchedEpoch;
  }
}

function finalizeHistoryAggregate(aggregate) {
  const codeLinesTotal = aggregate.codeLinesTotal;
  const commentLinesTotal = aggregate.commentRows > 0 ? aggregate.commentLinesTotal : null;
  const hotnessTotal = aggregate.hotnessRows > 0 ? aggregate.hotnessTotal : null;
  const ccTotal = aggregate.ccRows > 0 ? aggregate.ccTotal : null;
  const lastTouchedEpoch = aggregate.lastTouchedEpoch;
  const totalAnnotatedLines = codeLinesTotal + (commentLinesTotal ?? 0);

  return {
    fileCount: aggregate.fileCount,
    locTotal: aggregate.locTotal,
    codeLinesTotal,
    codeLinesEstimated: aggregate.explicitCodeRows < aggregate.fileCount,
    commentLinesTotal,
    commentCoverage: coverageRatio(aggregate.commentRows, aggregate.fileCount),
    hotnessTotal,
    hotnessCoverage: coverageRatio(aggregate.hotnessRows, aggregate.fileCount),
    ccTotal,
    ccCoverage: coverageRatio(aggregate.ccRows, aggregate.fileCount),
    lastTouchedEpoch,
    lastTouchedAt: lastTouchedEpoch !== null ? new Date(lastTouchedEpoch).toISOString() : "",
    commentRatio: commentLinesTotal !== null && totalAnnotatedLines > 0
      ? commentLinesTotal / totalAnnotatedLines
      : null,
    ccDensity: ccTotal !== null && codeLinesTotal > 0
      ? (ccTotal / codeLinesTotal) * 1000
      : null,
    hotnessDensity: hotnessTotal !== null && codeLinesTotal > 0
      ? (hotnessTotal / codeLinesTotal) * 1000
      : null
  };
}

function coverageRatio(coveredRows, totalRows) {
  if (!Number.isFinite(totalRows) || totalRows <= 0) return 0;
  return coveredRows / totalRows;
}

function isProjectCodeRow(row) {
  const fileName = readHistoryFileName(row);
  if (!CODE_FILE_EXT_RE.test(fileName)) return false;
  if (String(row?.relation || "").trim().toLowerCase() === "link") return false;

  const kind = String(row?.kind || "").trim().toLowerCase();
  if (!kind) return true;
  return kind === "file";
}

function readHistoryFileName(row) {
  return normalizeHistoryFileName(
    row?.module ||
    row?.fileName ||
    row?.file ||
    row?.path ||
    row?.name
  );
}

function normalizeHistoryFileName(value) {
  return String(value || "").trim().replace(/^\.\//, "");
}

function readLocValue(row) {
  return readNumberOrZero(row?.loc ?? row?.lines);
}

function readIsoDateEpoch(value) {
  const text = String(value || "").trim();
  if (!text) return null;

  const date = new Date(text);
  const epoch = date.getTime();
  return Number.isFinite(epoch) ? epoch : null;
}

function readCodeLinesValue(row) {
  const explicit = readNumberOrNull(row?.codeLines);
  if (explicit !== null) {
    return {
      value: explicit,
      explicit: true
    };
  }

  return {
    value: readLocValue(row),
    explicit: false
  };
}

function readCcValue(row) {
  const explicitComplexity = readNumberOrNull(row?.complexity);
  if (explicitComplexity !== null) return explicitComplexity;

  const avgCc = readNumberOrNull(row?.avgCc);
  const functionCount = readNumberOrNull(row?.functionCount);
  if (avgCc === null || functionCount === null) return null;

  return avgCc * functionCount;
}

function readNumberOrZero(value) {
  return readNumberOrNull(value) ?? 0;
}

function readNumberOrNull(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : null;
}

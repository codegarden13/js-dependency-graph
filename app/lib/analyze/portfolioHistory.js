import fs from "node:fs";
import path from "node:path";

import { OUTPUT_DIR } from "../projectPaths.js";
import { normalizeId } from "../stringUtils.js";

const CODE_FILE_EXT_RE = /\.(js|mjs|cjs|ts|tsx|jsx)$/i;
const CODE_METRICS_SUFFIX = "-code-metrics.csv";
const MODULE_PRIORITY_WEIGHTS = Object.freeze({
  hotness: 0.5,
  ccDensity: 0.3,
  codeLines: 0.2
});

export function buildPortfolioHistory(apps) {
  const configuredApps = Array.isArray(apps) ? apps : [];

  return {
    generatedAt: new Date().toISOString(),
    apps: configuredApps
      .map(buildConfiguredAppHistory)
      .filter(Boolean)
  };
}

function buildConfiguredAppHistory(app) {
  const appId = normalizeId(app?.id);
  if (!appId) return null;

  const history = listAppHistoryFiles(appId)
    .map((fileName) => buildHistoryRun(appId, fileName))
    .filter((run) => run !== null);
  const latest = history[history.length - 1] || null;

  return {
    appId,
    name: String(app?.name || appId),
    url: String(app?.url || ""),
    entry: String(app?.entry || ""),
    runCount: history.length,
    latest,
    history,
    latestModules: latest ? buildLatestModules(appId, latest.file) : []
  };
}

function listAppHistoryFiles(appId) {
  try {
    return fs.readdirSync(OUTPUT_DIR)
      .filter((name) => isAppHistoryFile(name, appId))
      .sort();
  } catch {
    return [];
  }
}

function isAppHistoryFile(fileName, appId) {
  return String(fileName || "").startsWith(`${appId}-`) &&
    String(fileName || "").endsWith(CODE_METRICS_SUFFIX);
}

function buildHistoryRun(appId, fileName) {
  const timestamp = extractRunDate(fileName, appId);
  if (!timestamp) return null;

  const rows = readCsvRows(path.join(OUTPUT_DIR, fileName));
  if (!isSupportedHistoryRows(rows)) return null;
  const summary = summarizeHistoryRows(rows);

  return {
    file: fileName,
    timestamp,
    ...summary
  };
}

function buildLatestModules(appId, fileName) {
  const rows = readCsvRows(path.join(OUTPUT_DIR, fileName));
  if (!isSupportedHistoryRows(rows)) return [];
  return rankLatestModules(extractLatestModules(rows, appId));
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
    ccRows: 0
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
}

function finalizeHistoryAggregate(aggregate) {
  const codeLinesTotal = aggregate.codeLinesTotal;
  const commentLinesTotal = aggregate.commentRows > 0 ? aggregate.commentLinesTotal : null;
  const hotnessTotal = aggregate.hotnessRows > 0 ? aggregate.hotnessTotal : null;
  const ccTotal = aggregate.ccRows > 0 ? aggregate.ccTotal : null;
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

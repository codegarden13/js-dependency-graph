// public/assets/js/graph_timeView.js
// ---------------------------------------------------------------------------
// Optional time-view chart for the NodeAnalyzer UI.
//
// This module renders a stacked overview chart for historic `code-metrics.csv`
// snapshots of the currently selected app.
//
// Data flow
// ---------
// 1) ask the backend for matching output files of the current app id
// 2) load each CSV snapshot from `/output/<file>`
// 3) aggregate selected metrics per run
// 4) draw a stacked area SVG into the provided container
//
// Expected public contract:
//   initGraphTimeView(svgId, { appId, metrics })
//
// Color source
// ------------
// Colors are read from CSS custom properties defined in `graph.css`.
// ---------------------------------------------------------------------------
"use strict";

import { installSvgViewZoom } from "./svgViewZoom.js";




let STACK_KEYS = [];
const STACK_COLOR_TOKENS = {
  loc: "--cg-node-kind-service",
  fanIn: "--cg-node-kind-config",
  fanOut: "--cg-node-kind-module",
};

const TIME_VIEW_LOG_PREFIX = "[timeView]";

/**
 * Write an informational log entry for the time-view module.
 *
 * @param {string} message
 *   Human-readable log message.
 * @param {unknown} [payload]
 *   Optional structured diagnostic payload.
 */
function logInfo(message, payload) {
  if (payload === undefined) {
    console.log(`${TIME_VIEW_LOG_PREFIX} ${message}`);
    return;
  }

  console.log(`${TIME_VIEW_LOG_PREFIX} ${message}`, payload);
}

/**
 * Write a warning log entry for the time-view module.
 *
 * @param {string} message
 *   Human-readable log message.
 * @param {unknown} [payload]
 *   Optional structured diagnostic payload.
 */
function logWarn(message, payload) {
  if (payload === undefined) {
    console.warn(`${TIME_VIEW_LOG_PREFIX} ${message}`);
    return;
  }

  console.warn(`${TIME_VIEW_LOG_PREFIX} ${message}`, payload);
}

/**
 * Write an error log entry for the time-view module.
 *
 * @param {string} message
 *   Human-readable log message.
 * @param {unknown} [payload]
 *   Optional structured diagnostic payload.
 */
function logError(message, payload) {
  if (payload === undefined) {
    console.error(`${TIME_VIEW_LOG_PREFIX} ${message}`);
    return;
  }

  console.error(`${TIME_VIEW_LOG_PREFIX} ${message}`, payload);
}

/**
 * Convert a loose value to a finite number with a fallback.
 *
 * @param {unknown} v
 *   Candidate numeric value.
 * @param {number} [fallback=0]
 *   Fallback used when conversion fails.
 * @returns {number}
 *   Finite number result.
 */
function coerceNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Format a numeric run value for human-readable chart tooltips.
 *
 * @param {unknown} value
 *   Numeric value to format.
 * @returns {string}
 *   Locale-formatted numeric string.
 */
function formatRunValue(value) {
  return d3.format(",")(coerceNumber(value, 0));
}

/**
 * Build the chart title for the current app time series.
 *
 * @param {string} appId
 *   Current application identifier.
 * @returns {string}
 *   Chart title text.
 */
function buildSeriesLabel(appId) {
  return `Drift history · ${appId}`;
}

/**
 * Format a run timestamp in UTC for tooltip display.
 *
 * @param {Date} date
 *   Run timestamp.
 * @returns {string}
 *   UTC-formatted timestamp string.
 */
function formatUtcTimestamp(date) {
  return d3.utcFormat("%d.%m %H:%M UTC")(date);
}

/**
 * Build a compact ordinal label for one run in the series.
 *
 * @param {number} index
 *   Zero-based run index.
 * @param {number} total
 *   Total number of runs.
 * @returns {string}
 *   Compact run label such as `R2/7`.
 */
function buildRunLabel(index, total) {
  return `R${index + 1}/${total}`;
}

/**
 * Fetch and parse a JSON resource strictly.
 *
 * @param {string} url
 *   Request URL.
 * @returns {Promise<any>}
 *   Parsed JSON response body.
 * @throws {Error}
 *   Thrown when the HTTP response is not successful.
 */
async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { Accept: "application/json" }
  });

  if (!res.ok) {
    throw new Error(`Request failed (${res.status}) for ${url}`);
  }

  return res.json();
}

/**
 * Build the backend URL used to list code-metrics output files for one app.
 *
 * @param {string} appId
 *   Current application identifier.
 * @returns {string}
 *   Backend request URL.
 */
function buildTimeSeriesFilesUrl(appId) {
  return `/api/output-files?appId=${encodeURIComponent(appId)}&type=code-metrics`;
}

/**
 * Select code-metrics CSV files that belong to the current app.
 *
 * @param {unknown} files
 *   Raw file list returned by the backend.
 * @param {string} appId
 *   Current application identifier.
 * @returns {{allFiles: string[], matchingFiles: string[], skippedFiles: string[]}}
 *   Partitioned file selection result.
 */
function selectMatchingTimeSeriesFiles(files, appId) {
  const normalizedFiles = Array.isArray(files) ? files : [];
  const filePrefix = `${appId}-`;
  const fileSuffix = "-code-metrics.csv";

  const matchingFiles = normalizedFiles.filter(
    (file) => file?.startsWith(filePrefix) && file?.endsWith(fileSuffix)
  );

  return {
    allFiles: normalizedFiles,
    matchingFiles,
    skippedFiles: normalizedFiles.filter((file) => !matchingFiles.includes(file)),
  };
}

/**
 * Log the backend file-selection result for time-series loading.
 *
 * @param {string} appId
 *   Current application identifier.
 * @param {string[]} allFiles
 *   All files returned by the backend.
 * @param {string[]} matchingFiles
 *   Files selected for time-series loading.
 * @param {string[]} skippedFiles
 *   Files ignored by the selector.
 */
function logTimeSeriesFileSelection(appId, allFiles, matchingFiles, skippedFiles) {
  logInfo("Received output files from API", {
    appId,
    totalFiles: allFiles.length,
    matchingCsvFiles: matchingFiles.length,
    skippedFiles,
  });
}

/**
 * Load and summarize one CSV snapshot into module metrics.
 *
 * @param {string} file
 *   Output CSV filename.
 * @param {string} appId
 *   Current application identifier.
 * @returns {Promise<{file: string, timestamp: Date | null, modules: Map<string, object>}>}
 *   Loaded snapshot descriptor.
 */
async function loadTimeSeriesRun(file, appId) {
  const timestamp = extractRunDate(file, appId);
  const rows = await d3.csv(`/output/${encodeURIComponent(file)}`);
  const modules = summarizeRun(rows);

  logInfo("Loaded CSV snapshot", {
    file,
    timestamp: timestamp?.toISOString?.() || null,
    rowCount: Array.isArray(rows) ? rows.length : 0,
    moduleCount: modules.size,
  });

  return {
    file,
    timestamp,
    modules
  };
}

/**
 * Load all selected time-series snapshots in parallel.
 *
 * @param {string[]} files
 *   Selected CSV snapshot filenames.
 * @param {string} appId
 *   Current application identifier.
 * @returns {Promise<Array<{file: string, timestamp: Date | null, modules: Map<string, object>}>>}
 *   Loaded snapshot descriptors.
 */
async function loadTimeSeriesRuns(files, appId) {
  return Promise.all(files.map((file) => loadTimeSeriesRun(file, appId)));
}

/**
 * Split loaded runs into valid timestamped runs and dropped runs.
 *
 * @param {Array<{file: string, timestamp: Date | null}>} runs
 *   Loaded snapshot descriptors.
 * @returns {{validRuns: Array<object>, droppedRuns: string[]}}
 *   Sorted valid runs and dropped filenames.
 */
function splitValidAndDroppedRuns(runs) {
  const validRuns = runs
    .filter((run) => run.timestamp instanceof Date)
    .sort((a, b) => d3.ascending(a.timestamp, b.timestamp));

  const droppedRuns = runs
    .filter((run) => !(run.timestamp instanceof Date))
    .map((run) => run.file);

  return { validRuns, droppedRuns };
}

/**
 * Log the final prepared time-series run set.
 *
 * @param {string} appId
 *   Current application identifier.
 * @param {Array<object>} validRuns
 *   Valid runs retained for rendering.
 * @param {string[]} droppedRuns
 *   Filenames dropped due to invalid timestamps.
 */
function logPreparedTimeSeriesRuns(appId, validRuns, droppedRuns) {
  if (droppedRuns.length) {
    logWarn("Dropped runs without valid timestamp", { droppedRuns });
  }

  logInfo("Prepared time series runs", {
    appId,
    runCount: validRuns.length,
    files: validRuns.map((run) => run.file),
  });
}

/**
 * Extract the encoded run timestamp from a code-metrics filename.
 *
 * @param {string} fileName
 *   Output CSV filename.
 * @param {string} appId
 *   Current application identifier.
 * @returns {Date | null}
 *   Parsed run timestamp, or `null` when parsing fails.
 */
function extractRunDate(fileName, appId) {
  const prefix = `${appId}-`;
  const suffix = `-code-metrics.csv`;

  if (!fileName?.startsWith(prefix) || !fileName?.endsWith(suffix)) {
    logWarn("Skipping file with unexpected name format", { fileName, appId });
    return null;
  }

  const raw = fileName.slice(prefix.length, -suffix.length);
  const iso = raw.replace(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    "$1T$2:$3:$4.$5Z"
  );

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    logWarn("Failed to parse run timestamp from file name", { fileName, raw, iso, appId });
    return null;
  }

  return date;
}

/**
 * Read a CSS custom property with a fallback value.
 *
 * @param {string} name
 *   CSS custom property name.
 * @param {string} fallback
 *   Fallback color/value.
 * @returns {string}
 *   Resolved CSS token value.
 */
function getCssToken(name, fallback) {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

/**
 * Remove all rendered content from an SVG selection.
 *
 * @param {d3.Selection} svg
 *   Target SVG selection.
 */
function clearSvg(svg) {
  svg.selectAll("*").remove();
}

/**
 * Configure the SVG viewport and aspect behavior for chart rendering.
 *
 * @param {d3.Selection} svg
 *   Target SVG selection.
 * @param {number} width
 *   Render width.
 * @param {number} height
 *   Render height.
 */
function configureSvgViewport(svg, width, height) {
  svg
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("preserveAspectRatio", "xMidYMid meet");
}

/**
 * Measure the SVG host and derive the chart render size.
 *
 * @param {d3.Selection} svgSelection
 *   Target SVG selection.
 * @returns {{width: number, height: number}}
 *   Derived render dimensions.
 */
function getSvgRenderSize(svgSelection) {
  const svgNode = svgSelection?.node?.();
  const host = svgNode?.parentElement;

  const measuredWidth = Math.max(
    host?.clientWidth || 0,
    svgNode?.clientWidth || 0,
    640
  );

  return {
    width: measuredWidth,
    height: 560,
  };
}

/**
 * Render an empty-state message into the chart SVG.
 *
 * @param {d3.Selection} svg
 *   Target SVG selection.
 * @param {number} width
 *   Render width.
 * @param {number} height
 *   Render height.
 * @param {string} message
 *   Empty-state message.
 */
function renderEmpty(svg, width, height, message) {
  clearSvg(svg);
  configureSvgViewport(svg, width, height);

  svg.append("text")
    .attr("x", width / 2)
    .attr("y", height / 2)
    .attr("text-anchor", "middle")
    .attr("fill", "#6c757d")
    .style("font-size", "14px")
    .text(message || "No code metrics history found.");
}

/**
 * Normalize a module name for comparison and display.
 *
 * @param {unknown} value
 *   Candidate module identifier.
 * @returns {string}
 *   Normalized module name.
 */
function normalizeModuleName(value) {
  return String(value || "")
    .trim()
    .replace(/^\.\//, "");
}

/**
 * Read the best available module identifier from one CSV row.
 *
 * @param {Record<string, any>} row
 *   Raw CSV row.
 * @returns {string}
 *   Normalized module name.
 */
function readModuleRowName(row) {
  return normalizeModuleName(
    row?.module ||
    row?.fileName ||
    row?.file ||
    row?.path ||
    row?.name
  );
}

/**
 * Check whether a module name refers to a code-bearing source file.
 *
 * @param {string} moduleName
 *   Normalized module name.
 * @returns {boolean}
 *   `true` when the module name has a code-file extension.
 */
function isCodeModuleName(moduleName) {
  if (!moduleName) return false;
  return /\.(js|mjs|cjs|ts|tsx|jsx)$/i.test(moduleName);
}

/**
 * Select the effective CSV row scope for module aggregation.
 *
 * Why this exists
 * ---------------
 * When code rows are present we aggregate only those. Otherwise we fall back to
 * the full row set so the time view can still operate on older or degraded data.
 *
 * @param {unknown} rows
 *   Raw CSV rows.
 * @returns {{inputRows: Array<object>, codeRows: Array<object>, scopedRows: Array<object>}}
 *   Normalized input rows and the effective aggregation scope.
 */
function selectScopedRunRows(rows) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const codeRows = normalizedRows.filter(isCodeModuleRow);

  return {
    inputRows: normalizedRows,
    codeRows,
    scopedRows: codeRows.length ? codeRows : normalizedRows,
  };
}

/**
 * Get or create the module summary accumulator for one module.
 *
 * @param {Map<string, {loc: number, fanIn: number, fanOut: number}>} modules
 *   Module summary map.
 * @param {string} moduleName
 *   Normalized module name.
 * @returns {{loc: number, fanIn: number, fanOut: number}}
 *   Mutable module summary bucket.
 */
function ensureModuleSummary(modules, moduleName) {
  if (!modules.has(moduleName)) {
    modules.set(moduleName, emptyModuleMetrics());
  }

  return modules.get(moduleName);
}

/**
 * Read the normalized module name used for run summarization.
 *
 * @param {Record<string, any>} row
 *   Raw CSV row.
 * @returns {string}
 *   Normalized module name.
 */
function readSummaryModuleName(row) {
  return readModuleRowName(row);
}

/**
 * Read the numeric metrics from one summary row.
 *
 * @param {Record<string, any>} row
 *   Raw CSV row.
 * @returns {{loc: number, fanIn: number, fanOut: number}}
 *   Normalized row metrics.
 */
function readSummaryRowMetrics(row) {
  const hasFanIn = String(row?.fanIn ?? "").trim() !== "";
  const hasFanOut = String(row?.fanOut ?? "").trim() !== "";

  return {
    loc: coerceNumber(row?.loc ?? row?.lines, 0),
    fanIn: coerceNumber(row?.fanIn, 0),
    fanOut: coerceNumber(row?.fanOut, 0),
    hasFanMetrics: hasFanIn || hasFanOut,
  };
}

/**
 * Accumulate one row's metrics into a module summary bucket.
 *
 * @param {{loc: number, fanIn: number, fanOut: number}} metrics
 *   Mutable module summary bucket.
 * @param {{loc: number, fanIn: number, fanOut: number}} rowMetrics
 *   Normalized row metrics.
 */
function applySummaryRowMetrics(metrics, rowMetrics) {
  metrics.loc += rowMetrics.loc;

  if (!rowMetrics.hasFanMetrics) return;

  metrics.hasFanMetrics = true;
  metrics.fanIn += rowMetrics.fanIn;
  metrics.fanOut += rowMetrics.fanOut;
}

/**
 * Merge one CSV row into the module summary map.
 *
 * @param {Map<string, {loc: number, fanIn: number, fanOut: number}>} modules
 *   Module summary map.
 * @param {Record<string, any>} row
 *   Raw CSV row.
 */
function summarizeRowIntoModule(modules, row) {
  const moduleName = readSummaryModuleName(row);
  if (!moduleName) return;

  const metrics = ensureModuleSummary(modules, moduleName);
  const rowMetrics = readSummaryRowMetrics(row);

  applySummaryRowMetrics(metrics, rowMetrics);
}

/**
 * Log the result of one run summarization pass.
 *
 * @param {{inputRows: Array<object>, codeRows: Array<object>, scopedRows: Array<object>, modules: Map<string, object>}} args
 *   Summarization diagnostics.
 */
function logSummarizeRunResult({ inputRows, codeRows, scopedRows, modules }) {
  logInfo("Summarized CSV rows into module metrics", {
    inputRows: inputRows.length,
    codeRows: codeRows.length,
    scopedRows: scopedRows.length,
    moduleCount: modules.size,
  });
}

/**
 * Check whether one CSV row describes a code module.
 *
 * @param {Record<string, any>} row
 *   Raw CSV row.
 * @returns {boolean}
 *   `true` when the row resolves to a code-module filename.
 */
function isCodeModuleRow(row) {
  const moduleName = readModuleRowName(row);
  if (!isCodeModuleName(moduleName)) return false;

  const kind = String(row?.kind || "").trim().toLowerCase();
  if (kind) return kind === "file";

  return true;
}

/**
 * Summarize one CSV snapshot into module-level metrics.
 *
 * @param {unknown} rows
 *   Raw CSV rows.
 * @returns {Map<string, {loc: number, fanIn: number, fanOut: number}>}
 *   Module summary map for one run.
 */
function summarizeRun(rows) {
  const { inputRows, codeRows, scopedRows } = selectScopedRunRows(rows);
  const modules = new Map();

  for (const row of scopedRows) {
    summarizeRowIntoModule(modules, row);
  }

  logSummarizeRunResult({ inputRows, codeRows, scopedRows, modules });
  return modules;
}

/**
 * Create the zero-initialized module metric bucket.
 *
 * @returns {{loc: number, fanIn: number, fanOut: number}}
 *   Empty module metrics object.
 */
function emptyModuleMetrics() {
  return { loc: 0, fanIn: 0, fanOut: 0, hasFanMetrics: false };
}

/**
 * Accumulate per-module totals and LOC drift against the previous run.
 *
 * @param {Map<string, number>} totals
 *   Module total-LOC accumulator.
 * @param {Map<string, number>} drift
 *   Module drift accumulator.
 * @param {Map<string, {loc: number}>} currentModules
 *   Current run module metrics.
 * @param {Map<string, {loc: number}> | null} previousModules
 *   Previous run module metrics.
 */
function accumulateModuleTotalsAndDrift(totals, drift, currentModules, previousModules) {
  for (const [name, metrics] of currentModules.entries()) {
    const previousLoc = previousModules?.get(name)?.loc ?? 0;

    totals.set(name, (totals.get(name) ?? 0) + metrics.loc);
    drift.set(name, (drift.get(name) ?? 0) + Math.abs(metrics.loc - previousLoc));
  }
}

/**
 * Add drift for modules that disappeared relative to the previous run.
 *
 * @param {Map<string, number>} drift
 *   Module drift accumulator.
 * @param {Map<string, object>} currentModules
 *   Current run module metrics.
 * @param {Map<string, {loc: number}> | null} previousModules
 *   Previous run module metrics.
 */
function accumulateDisappearedModuleDrift(drift, currentModules, previousModules) {
  if (!previousModules) return;

  for (const [name, previousMetrics] of previousModules.entries()) {
    if (currentModules.has(name)) continue;
    drift.set(name, (drift.get(name) ?? 0) + Math.abs(previousMetrics.loc));
  }
}

/**
 * Collect total size and drift signals across all runs.
 *
 * @param {Array<{modules: Map<string, object>}>} runs
 *   Prepared time-series runs.
 * @returns {{totals: Map<string, number>, drift: Map<string, number>}}
 *   Aggregated totals and drift maps.
 */
function collectModuleTotalsAndDrift(runs) {
  const totals = new Map();
  const drift = new Map();

  let previousModules = null;

  for (const run of runs) {
    const currentModules = run.modules;

    accumulateModuleTotalsAndDrift(totals, drift, currentModules, previousModules);
    accumulateDisappearedModuleDrift(drift, currentModules, previousModules);

    previousModules = currentModules;
  }

  return { totals, drift };
}

/**
 * Build the comparator used to rank modules by drift and fallback size.
 *
 * @param {Map<string, number>} totals
 *   Module total-LOC map.
 * @param {Map<string, number>} drift
 *   Module drift map.
 * @returns {(a: string, b: string) => number}
 *   Module ranking comparator.
 */
function compareModulesByDriftAndSize(totals, drift) {
  return (a, b) => {
    const driftDiff = (drift.get(b) ?? 0) - (drift.get(a) ?? 0);
    if (driftDiff !== 0) return driftDiff;
    return (totals.get(b) ?? 0) - (totals.get(a) ?? 0);
  };
}

/**
 * Select the highest-interest modules for the stacked overview.
 *
 * @param {Array<{modules: Map<string, object>}>} runs
 *   Prepared time-series runs.
 * @param {number} [limit=6]
 *   Maximum number of modules to keep.
 * @returns {string[]}
 *   Ranked module names used as stack keys.
 */
function selectTopModulesForStack(runs, limit = 6) {
  const { totals, drift } = collectModuleTotalsAndDrift(runs);

  return [...totals.keys()]
    .sort(compareModulesByDriftAndSize(totals, drift))
    .slice(0, limit);
}

/**
 * Build the fixed metadata fields for one stacked-series row.
 *
 * @param {{timestamp: Date, file: string}} run
 *   Prepared time-series run.
 * @param {number} runIndex
 *   Zero-based run index.
 * @returns {{timestamp: Date, file: string, runIndex: number}}
 *   Base stacked-series row.
 */
function buildModuleDriftRowBase(run, runIndex) {
  return {
    timestamp: run.timestamp,
    file: run.file,
    runIndex,
  };
}

/**
 * Read module metrics from a run with an empty fallback bucket.
 *
 * @param {Map<string, {loc: number, fanIn: number, fanOut: number}> | null | undefined} modules
 *   Module metrics map.
 * @param {string} moduleName
 *   Normalized module name.
 * @returns {{loc: number, fanIn: number, fanOut: number}}
 *   Module metrics or an empty fallback.
 */
function readModuleMetrics(modules, moduleName) {
  return modules?.get(moduleName) ?? emptyModuleMetrics();
}

/**
 * Compute drift details for one module between adjacent runs.
 *
 * @param {{loc: number, fanIn: number, fanOut: number}} currentMetrics
 *   Current run metrics.
 * @param {{loc: number, fanIn: number, fanOut: number}} previousMetrics
 *   Previous run metrics.
 * @param {boolean} isBaselineRun
 *   Whether the current run is the baseline run.
 * @returns {{currentMetrics: object, deltaLoc: number, deltaFanIn: number, deltaFanOut: number, driftValue: number}}
 *   Detailed drift breakdown.
 */
function computeModuleDriftDetails(currentMetrics, previousMetrics, isBaselineRun) {
  const deltaLoc = currentMetrics.loc - previousMetrics.loc;
  const compareFanMetrics = currentMetrics.hasFanMetrics && previousMetrics.hasFanMetrics;
  const deltaFanIn = compareFanMetrics ? currentMetrics.fanIn - previousMetrics.fanIn : 0;
  const deltaFanOut = compareFanMetrics ? currentMetrics.fanOut - previousMetrics.fanOut : 0;

  return {
    currentMetrics,
    deltaLoc,
    deltaFanIn,
    deltaFanOut,
    driftValue: isBaselineRun
      ? 0
      : Math.abs(deltaLoc) +
        10 * Math.abs(deltaFanIn) +
        10 * Math.abs(deltaFanOut)
  };
}

/**
 * Write module drift details into one stacked-series row.
 *
 * @param {Record<string, any>} row
 *   Mutable stacked-series row.
 * @param {string} moduleName
 *   Module name used as stack key.
 * @param {{currentMetrics: object, deltaLoc: number, deltaFanIn: number, deltaFanOut: number, driftValue: number}} details
 *   Drift detail object.
 */
function assignModuleDriftDetails(row, moduleName, details) {
  row[moduleName] = details.driftValue;
  row[`${moduleName}_loc`] = details.currentMetrics.loc;
  row[`${moduleName}_fanIn`] = details.currentMetrics.fanIn;
  row[`${moduleName}_fanOut`] = details.currentMetrics.fanOut;
  row[`${moduleName}_deltaLoc`] = details.deltaLoc;
  row[`${moduleName}_deltaFanIn`] = details.deltaFanIn;
  row[`${moduleName}_deltaFanOut`] = details.deltaFanOut;
}

/**
 * Build the stacked-series rows consumed by the overview chart.
 *
 * @param {Array<{file: string, timestamp: Date, modules: Map<string, object>}>} runs
 *   Prepared time-series runs.
 * @param {string[]} topModules
 *   Selected module stack keys.
 * @returns {Array<object>}
 *   Stacked-series rows.
 */
function buildStackSeriesRows(runs, topModules) {
  let previousRunModules = null;

  return runs.map((run, runIndex) => {
    const row = buildModuleDriftRowBase(run, runIndex);
    const isBaselineRun = previousRunModules === null;

    for (const moduleName of topModules) {
      const currentMetrics = readModuleMetrics(run.modules, moduleName);
      const previousMetrics = readModuleMetrics(previousRunModules, moduleName);
      const details = computeModuleDriftDetails(currentMetrics, previousMetrics, isBaselineRun);

      assignModuleDriftDetails(row, moduleName, details);
    }

    previousRunModules = run.modules;
    return row;
  });
}

/**
 * Load, filter, summarize, and sort the time-series data for one app.
 *
 * @param {string} appId
 *   Current application identifier.
 * @returns {Promise<Array<{file: string, timestamp: Date, modules: Map<string, object>}>>}
 *   Prepared valid runs for chart rendering.
 */
async function loadTimeSeries(appId) {
  logInfo("Loading time series", { appId });

  const files = await fetchJson(buildTimeSeriesFilesUrl(appId));
  const { allFiles, matchingFiles, skippedFiles } = selectMatchingTimeSeriesFiles(files, appId);

  logTimeSeriesFileSelection(appId, allFiles, matchingFiles, skippedFiles);

  const runs = await loadTimeSeriesRuns(matchingFiles, appId);
  const { validRuns, droppedRuns } = splitValidAndDroppedRuns(runs);

  logPreparedTimeSeriesRuns(appId, validRuns, droppedRuns);
  return validRuns;
}

/**
 * Render the horizontal Y-axis grid for the overview chart.
 *
 * @param {d3.Selection} g
 *   Plot group selection.
 * @param {d3.ScaleLinear<number, number>} y
 *   Y scale.
 * @param {number} innerW
 *   Inner plot width.
 */
function renderYGrid(g, y, innerW) {
  g.append("g")
    .attr("class", "time-grid")
    .call(
      d3.axisLeft(y)
        .ticks(6)
        .tickSize(-innerW)
        .tickFormat("")
    )
    .call((sel) => sel.selectAll("line")
      .attr("stroke", getCssToken("--cg-edge-default", "rgba(100, 116, 139, 0.22)"))
      .attr("stroke-opacity", 0.85))
    .call((sel) => sel.select("path").remove());
}

/**
 * Render vertical guide lines for each run position.
 *
 * @param {d3.Selection} g
 *   Plot group selection.
 * @param {{series: Array<object>, x: Function, innerH: number}} args
 *   Run-guide render context.
 */
function renderRunGuides(g, { series, x, innerH }) {
  g.append("g")
    .attr("class", "time-run-guides")
    .selectAll("line")
    .data(series)
    .enter()
    .append("line")
    .attr("x1", (d, index) => x(index))
    .attr("x2", (d, index) => x(index))
    .attr("y1", 0)
    .attr("y2", innerH)
    .attr("stroke", "rgba(31,41,55,0.08)")
    .attr("stroke-dasharray", "3 4");
}

/**
 * Compute the total number of runs available to the X axis.
 *
 * @param {unknown} series
 *   Stacked-series rows.
 * @returns {number}
 *   Total run count.
 */
function getXAxisTotalRuns(series) {
  return Array.isArray(series) ? series.length : 0;
}

/**
 * Build the run indexes displayed as X-axis ticks.
 *
 * @param {number} totalRuns
 *   Total number of runs.
 * @param {number} tickCount
 *   Desired tick count hint.
 * @returns {number[]}
 *   Selected run indexes for the X axis.
 */
function buildXAxisTickIndexes(totalRuns, tickCount) {
  if (totalRuns <= 6) {
    return d3.range(totalRuns);
  }

  return Array.from(new Set([
    0,
    ...d3.ticks(0, totalRuns - 1, Math.max(2, tickCount)).map((value) => Math.round(value)),
    totalRuns - 1,
  ].filter((value) => value >= 0 && value < totalRuns)));
}

/**
 * Format one X-axis tick label for a run.
 *
 * @param {Array<{timestamp: Date}>} series
 *   Stacked-series rows.
 * @param {number} index
 *   Run index.
 * @param {number} totalRuns
 *   Total number of runs.
 * @returns {string}
 *   Formatted tick label.
 */
function formatXAxisTick(series, index, totalRuns) {
  const run = series[index];
  if (!run) return "";
  return `${buildRunLabel(index, totalRuns)} · ${d3.utcFormat("%d.%m %H:%M")(run.timestamp)}`;
}

/**
 * Render the X axis for the stacked overview chart.
 *
 * @param {d3.Selection} g
 *   Plot group selection.
 * @param {{x: Function, innerH: number, tickCount: number, series: Array<object>}} args
 *   X-axis render context.
 */
function renderXAxis(g, { x, innerH, tickCount, series }) {
  const totalRuns = getXAxisTotalRuns(series);
  const tickIndexes = buildXAxisTickIndexes(totalRuns, tickCount);

  g.append("g")
    .attr("transform", `translate(0,${innerH})`)
    .call(
      d3.axisBottom(x)
        .tickValues(tickIndexes)
        .tickFormat((index) => formatXAxisTick(series, index, totalRuns))
    )
    .call((sel) => sel.selectAll("text")
      .style("font-size", "10px")
      .attr("transform", "rotate(-20)")
      .style("text-anchor", "end"));
}

/**
 * Render the numeric Y axis for the overview chart.
 *
 * @param {d3.Selection} g
 *   Plot group selection.
 * @param {d3.ScaleLinear<number, number>} y
 *   Y scale.
 */
function renderYAxis(g, y) {
  g.append("g")
    .call(
      d3.axisLeft(y)
        .ticks(6)
        .tickFormat(d3.format(","))
    )
    .call((sel) => sel.selectAll("text").style("font-size", "11px"));
}

/**
 * Build the high-level stacked-series data model from prepared runs.
 *
 * @param {Array<{modules: Map<string, object>}>} runs
 *   Prepared time-series runs.
 * @returns {Array<object>}
 *   Stacked-series rows.
 */
function buildStackSeries(runs) {
  const topModules = selectTopModulesForStack(runs, 6);

  logInfo("Selected top modules for stacked series", {
    runCount: runs.length,
    topModules,
  });

  return buildStackSeriesRows(runs, topModules);
}

/**
 * Build a stable color map for module stack keys.
 *
 * @param {string[]} keys
 *   Module stack keys.
 * @returns {Map<string, string>}
 *   Color lookup by module key.
 */
function buildModulePalette(keys) {
  const palette = d3.schemeTableau10;
  const map = new Map();

  keys.forEach((key, index) => {
    map.set(key, palette[index % palette.length]);
  });

  return map;
}

/**
 * Check whether a stacked-series field is metadata rather than stack data.
 *
 * @param {string} key
 *   Row field name.
 * @returns {boolean}
 *   `true` when the field is chart metadata.
 */
function isStackSeriesMetaKey(key) {
  return key === "timestamp" || key === "file" || key === "runIndex";
}

/**
 * Check whether a stacked-series field is a detail field excluded from stacking.
 *
 * @param {string} key
 *   Row field name.
 * @returns {boolean}
 *   `true` when the field is an auxiliary detail field.
 */
function isStackSeriesDetailKey(key) {
  return key.endsWith("_loc") ||
    key.endsWith("_fanIn") ||
    key.endsWith("_fanOut") ||
    key.endsWith("_deltaLoc") ||
    key.endsWith("_deltaFanIn") ||
    key.endsWith("_deltaFanOut");
}

/**
 * Select the data fields used as stack layers in the overview chart.
 *
 * @param {Array<object>} series
 *   Stacked-series rows.
 * @returns {string[]}
 *   Stack-layer keys.
 */
function selectStackKeys(series) {
  const firstRow = series[0] || {};

  return Object.keys(firstRow).filter((key) => {
    if (isStackSeriesMetaKey(key)) return false;
    if (isStackSeriesDetailKey(key)) return false;
    return true;
  });
}

/**
 * Log the render context for the stacked overview chart.
 *
 * @param {string} appId
 *   Current application identifier.
 * @param {Array<object>} runs
 *   Prepared runs.
 * @param {Array<object>} series
 *   Stacked-series rows.
 * @param {string[]} stackKeys
 *   Stack-layer keys.
 */
function logStackedOverviewRender(appId, runs, series, stackKeys) {
  logInfo("Rendering stacked overview chart", {
    appId,
    runCount: runs.length,
    seriesCount: series.length,
    stackKeys,
  });
}

/**
 * Compute the inner plot dimensions from the outer chart box.
 *
 * @param {number} width
 *   Outer chart width.
 * @param {number} height
 *   Outer chart height.
 * @param {{top: number, right: number, bottom: number, left: number}} margin
 *   Chart margins.
 * @returns {{innerW: number, innerH: number}}
 *   Inner plot dimensions.
 */
function getChartInnerSize(width, height, margin) {
  return {
    innerW: width - margin.left - margin.right,
    innerH: height - margin.top - margin.bottom,
  };
}

/**
 * Create the root and translated plot groups for the chart.
 *
 * @param {d3.Selection} svg
 *   Target SVG selection.
 * @param {{top: number, left: number}} margin
 *   Chart margins.
 * @returns {{root: d3.Selection, g: d3.Selection}}
 *   Root group and translated plot group.
 */
function createChartRoot(svg, margin) {
  const root = svg.append("g");
  const g = root.append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  return { root, g };
}

/**
 * Build the X and Y scales for the stacked overview chart.
 *
 * @param {Array<object>} series
 *   Stacked-series rows.
 * @param {string[]} stackKeys
 *   Stack-layer keys.
 * @param {number} innerW
 *   Inner plot width.
 * @param {number} innerH
 *   Inner plot height.
 * @returns {{x: any, y: any}}
 *   D3 scales for chart rendering.
 */
function buildStackedOverviewScales(series, stackKeys, innerW, innerH) {
  const x = d3.scaleLinear()
    .domain([0, Math.max(series.length - 1, 0)])
    .range([0, innerW]);

  const y = d3.scaleLinear()
    .domain([0, d3.max(series, (row) => stackKeys.reduce(
      (sum, key) => sum + coerceNumber(row[key], 0),
      0
    )) || 1])
    .nice()
    .range([innerH, 0]);

  return { x, y };
}

/**
 * Render all overview-chart axes and guide infrastructure.
 *
 * @param {d3.Selection} g
 *   Plot group selection.
 * @param {{series: Array<object>, x: any, y: any, innerW: number, innerH: number}} args
 *   Axis render context.
 */
function renderStackedOverviewAxes(g, { series, x, y, innerW, innerH }) {
  renderYGrid(g, y, innerW);
  renderRunGuides(g, { series, x, innerH });
  renderXAxis(g, {
    x,
    innerH,
    tickCount: Math.min(series.length, 6),
    series,
  });
  renderYAxis(g, y);
}

/**
 * Build the D3 stack layers from stacked-series rows.
 *
 * @param {Array<object>} series
 *   Stacked-series rows.
 * @param {string[]} stackKeys
 *   Stack-layer keys.
 * @returns {Array<object>}
 *   D3 stack layers.
 */
function buildStackedSeriesLayers(series, stackKeys) {
  const stack = d3.stack().keys(stackKeys);
  return stack(series);
}

/**
 * Render the data-bearing layers of the stacked overview chart.
 *
 * @param {d3.Selection} g
 *   Plot group selection.
 * @param {{stacked: Array<object>, series: Array<object>, stackKeys: string[], x: any, y: any, innerW: number, colorByKey: Map<string, string>}} args
 *   Data-layer render context.
 */
function renderStackedOverviewDataLayers(g, { stacked, series, stackKeys, x, y, innerW, colorByKey }) {
  renderStackedAreas(g, {
    stacked,
    x,
    y,
    colorByKey,
  });

  renderRunMarkers(g, {
    series,
    keys: stackKeys,
    x,
    y,
  });

  renderEndLabels(g, {
    stacked,
    y,
    innerW,
    colorByKey,
  });
}

/**
 * Render non-data chart chrome such as header and legend.
 *
 * @param {d3.Selection} root
 *   Root chart group.
 * @param {{width: number, margin: object, appId: string, series: Array<object>, stackKeys: string[], colorByKey: Map<string, string>}} args
 *   Chrome render context.
 */
function renderStackedOverviewChrome(root, { width, margin, appId, series, stackKeys, colorByKey }) {
  renderChartHeader(root, { width, margin, appId, series, keys: stackKeys });
  renderModuleLegend(root, { margin, keys: stackKeys, colorByKey });
}

/**
 * Render the chart title and summary line.
 *
 * @param {d3.Selection} root
 *   Root chart group.
 * @param {{width: number, margin: object, appId: string, series: Array<object>, keys: string[]}} args
 *   Header render context.
 */
function renderChartHeader(root, { width, margin, appId, series, keys }) {
  root.append("text")
    .attr("x", margin.left)
    .attr("y", 18)
    .style("font-size", "13px")
    .style("font-weight", "600")
    .text(buildSeriesLabel(appId));

  root.append("text")
    .attr("x", width - margin.right)
    .attr("y", 18)
    .attr("text-anchor", "end")
    .style("font-size", "11px")
    .style("fill", "#6c757d")
    .text(`${series.length} runs · equal spacing · baseline run = 0 drift · top ${keys.length} modules`);
}

/**
 * Render the legend for module stack colors.
 *
 * @param {d3.Selection} root
 *   Root chart group.
 * @param {{margin: object, keys: string[], colorByKey: Map<string, string>}} args
 *   Legend render context.
 */
function renderModuleLegend(root, { margin, keys, colorByKey }) {
  const legend = root.append("g")
    .attr("transform", `translate(${margin.left}, 30)`);

  keys.forEach((key, index) => {
    const row = Math.floor(index / 4);
    const col = index % 4;
    const x = col * 210;
    const y = row * 18;

    legend.append("rect")
      .attr("x", x)
      .attr("y", y - 8)
      .attr("width", 12)
      .attr("height", 12)
      .attr("rx", 2)
      .attr("fill", colorByKey.get(key));

    legend.append("text")
      .attr("x", x + 18)
      .attr("y", y + 2)
      .style("font-size", "10px")
      .style("fill", "#6c757d")
      .text(key);
  });
}

/**
 * Render stacked area fills and their boundary lines.
 *
 * @param {d3.Selection} g
 *   Plot group selection.
 * @param {{stacked: Array<object>, x: any, y: any, colorByKey: Map<string, string>}} args
 *   Stacked-area render context.
 */
function renderStackedAreas(g, { stacked, x, y, colorByKey }) {
  const area = d3.area()
    .curve(d3.curveStepAfter)
    .x((d) => x(d.data.runIndex))
    .y0((d) => y(d[0]))
    .y1((d) => y(d[1]));

  const groups = g.selectAll(".module-area-group")
    .data(stacked)
    .enter()
    .append("g")
    .attr("class", "module-area-group");

  groups.append("path")
    .attr("class", "module-area")
    .attr("fill", (d) => colorByKey.get(d.key))
    .attr("fill-opacity", 0.72)
    .attr("stroke", "none")
    .attr("d", area)
    .append("title")
    .text((d) => d.key);

  groups.append("path")
    .attr("class", "module-area-boundary")
    .attr("fill", "none")
    .attr("stroke", (d) => colorByKey.get(d.key))
    .attr("stroke-opacity", 0.75)
    .attr("stroke-width", 1.2)
    .attr("d", d3.line()
      .curve(d3.curveStepAfter)
      .x((p) => x(p.data.runIndex))
      .y((p) => y(p[1]))
    );
}

/**
 * Render total-drift markers and detailed tooltips for each run.
 *
 * @param {d3.Selection} g
 *   Plot group selection.
 * @param {{series: Array<object>, keys: string[], x: any, y: any}} args
 *   Run-marker render context.
 */
function renderRunMarkers(g, { series, keys, x, y }) {
  g.selectAll(".time-total-point")
    .data(series)
    .enter()
    .append("circle")
    .attr("class", "time-total-point")
    .attr("cx", (d) => x(d.runIndex))
    .attr("cy", (d) => y(keys.reduce((sum, key) => sum + coerceNumber(d[key], 0), 0)))
    .attr("r", 3.2)
    .attr("fill", getCssToken("--cg-node-fill-root", "#111827"))
    .append("title")
    .text((d) => {
      const details = keys.map((key) => {
        const driftValue = formatRunValue(d[key] || 0);
        const loc = formatRunValue(d[`${key}_loc`] || 0);
        const fanIn = formatRunValue(d[`${key}_fanIn`] || 0);
        const fanOut = formatRunValue(d[`${key}_fanOut`] || 0);
        const deltaLoc = d3.format("+,d")(coerceNumber(d[`${key}_deltaLoc`], 0));
        const deltaFanIn = d3.format("+,d")(coerceNumber(d[`${key}_deltaFanIn`], 0));
        const deltaFanOut = d3.format("+,d")(coerceNumber(d[`${key}_deltaFanOut`], 0));
        return `${key}: drift ${driftValue}, loc ${loc} (Δ ${deltaLoc}), fanIn ${fanIn} (Δ ${deltaFanIn}), fanOut ${fanOut} (Δ ${deltaFanOut})`;
      }).join("\n");

      const total = keys.reduce((sum, key) => sum + coerceNumber(d[key], 0), 0);
      return `${buildRunLabel(d.runIndex, series.length)}\n${d.file}\n${formatUtcTimestamp(d.timestamp)}\n${details}\ntotal drift: ${formatRunValue(total)}`;
    });
}

/**
 * Render end-of-series labels for the stacked layers.
 *
 * @param {d3.Selection} g
 *   Plot group selection.
 * @param {{stacked: Array<object>, y: any, innerW: number, colorByKey: Map<string, string>}} args
 *   End-label render context.
 */
function renderEndLabels(g, { stacked, y, innerW, colorByKey }) {
  const latestLayer = stacked.map((layer) => ({
    key: layer.key,
    point: layer[layer.length - 1],
  }));

  const placed = [];
  const minGap = 14;

  g.selectAll(".stack-end-label")
    .data(latestLayer)
    .enter()
    .append("text")
    .attr("class", "stack-end-label")
    .attr("x", innerW - 6)
    .attr("y", (d) => {
      const targetY = y((d.point[0] + d.point[1]) / 2) - 10;
      const lastY = placed.length ? placed[placed.length - 1] : null;
      const nextY = lastY !== null && targetY - lastY < minGap ? lastY + minGap : targetY;
      placed.push(nextY);
      return nextY;
    })
    .attr("text-anchor", "end")
    .attr("dominant-baseline", "auto")
    .style("font-size", "10px")
    .style("font-weight", "600")
    .style("paint-order", "stroke")
    .style("stroke", "rgba(255,255,255,0.95)")
    .style("stroke-width", "3px")
    .style("stroke-linejoin", "round")
    .style("fill", (d) => colorByKey.get(d.key))
    .text((d) => d.key.split("/").pop());
}

/**
 * Render the stacked overview chart for the prepared run history.
 *
 * @param {d3.Selection} svg
 *   Target SVG selection.
 * @param {{width: number, height: number, margin: object, runs: Array<object>, appId: string}} args
 *   Chart render context.
 */
function renderStackedOverviewChart(svg, { width, height, margin, runs, appId }) {
  clearSvg(svg);

  const series = buildStackSeries(runs);
  if (!series.length) {
    renderEmpty(svg, width, height, "No module drift history found.");
    return null;
  }

  STACK_KEYS = selectStackKeys(series);
  const hasDrift = series.some((row) =>
    STACK_KEYS.some((key) => coerceNumber(row?.[key], 0) > 0)
  );
  if (!hasDrift) {
    renderEmpty(svg, width, height, "No module drift across available runs.");
    return null;
  }

  logStackedOverviewRender(appId, runs, series, STACK_KEYS);

  const colorByKey = buildModulePalette(STACK_KEYS);
  const { innerW, innerH } = getChartInnerSize(width, height, margin);
  const { root, g } = createChartRoot(svg, margin);
  const { x, y } = buildStackedOverviewScales(series, STACK_KEYS, innerW, innerH);

  renderStackedOverviewAxes(g, { series, x, y, innerW, innerH });

  const stacked = buildStackedSeriesLayers(series, STACK_KEYS);
  renderStackedOverviewDataLayers(g, {
    stacked,
    series,
    stackKeys: STACK_KEYS,
    x,
    y,
    innerW,
    colorByKey,
  });

  renderStackedOverviewChrome(root, {
    width,
    margin,
    appId,
    series,
    stackKeys: STACK_KEYS,
    colorByKey,
  });

  return installSvgViewZoom(svg);
}

/**
 * Initialize the optional historic time-view chart for the current app.
 *
 * Lifecycle
 * ---------
 * 1. Resolve and size the target SVG
 * 2. Load prepared time-series snapshots
 * 3. Render empty/error states when needed
 * 4. Render the stacked overview chart
 *
 * @param {string} svgId
 *   DOM id of the target SVG element.
 * @param {{appId?: string, metrics?: unknown}} [options={}]
 *   Initialization options.
 * @returns {Promise<void>}
 *   Resolves when initialization completes.
 */
export async function initGraphTimeView(svgId, { appId, metrics } = {}) {
  const svg = d3.select(`#${svgId}`);
  if (svg.empty()) {
    logWarn("Time view SVG not found", { svgId });
    return;
  }

  const { width, height } = getSvgRenderSize(svg);
  const margin = { top: 64, right: 88, bottom: 64, left: 88 };

  configureSvgViewport(svg, width, height);
  svg.attr("width", width).attr("height", height);

  void metrics;
  logInfo("Initializing time view", { svgId, appId });

  let runs;
  try {
    runs = await loadTimeSeries(appId);
  } catch (err) {
    logError("Failed to load time-view series", err);
    renderEmpty(svg, width, height, "Could not load code-metrics history.");
    return null;
  }

  if (!runs.length) {
    renderEmpty(svg, width, height, "No code-metrics history found for current app.");
    return null;
  }

  logInfo("Rendering time view with loaded runs", {
    appId,
    runCount: runs.length,
  });

  return renderStackedOverviewChart(svg, {
    width,
    height,
    margin,
    runs,
    appId
  });
}

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
const TIME_VIEW_UI_DEFAULTS = Object.freeze({
  spacingMode: "time",
  chartMode: "lines",
});

let timeViewUiState = { ...TIME_VIEW_UI_DEFAULTS };
let latestTimeViewContext = null;
let activeTimeViewZoomController = createNullZoomController();

function createNullZoomController() {
  return {
    getZoom() {
      return 1;
    },
    setZoom() {
      return 1;
    },
    destroy() { }
  };
}

const timeViewControllerProxy = {
  getZoom() {
    return activeTimeViewZoomController?.getZoom?.() ?? 1;
  },
  setZoom(value) {
    return activeTimeViewZoomController?.setZoom?.(value) ?? 1;
  },
  destroy() {
    destroyTimeViewZoomController();
    latestTimeViewContext = null;
  }
};

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

  const width = Math.max(
    host?.clientWidth || 0,
    svgNode?.clientWidth || 0,
    360
  );

  return {
    width,
    height: Math.max(host?.clientHeight || 0, width, 360),
  };
}

/**
 * Resolve the drift-card container, target SVG, and auxiliary UI elements.
 *
 * @param {string} hostId
 *   DOM id of either the panel container or the SVG itself.
 * @returns {{container: HTMLElement | null, svgNode: SVGSVGElement, svg: d3.Selection, summaryRoot: HTMLElement | null, metaEl: HTMLElement | null, legendRoot: HTMLElement | null} | null}
 *   Resolved time-view elements or `null` when not found.
 */
function resolveTimeViewElements(hostId) {
  const host = document.getElementById(String(hostId || ""));
  if (!host) return null;

  const svgNode = host instanceof SVGSVGElement
    ? host
    : host.querySelector("svg[data-role='drift-chart'], svg");

  if (!(svgNode instanceof SVGSVGElement)) {
    return null;
  }

  const container = host instanceof SVGSVGElement
    ? host.closest("#graphTimePanel") || host.parentElement
    : host;

  return {
    container: container instanceof HTMLElement ? container : null,
    svgNode,
    svg: d3.select(svgNode),
    summaryRoot: container?.querySelector?.("[data-role='drift-summary']") || null,
    metaEl: container?.querySelector?.("[data-role='drift-meta']") || null,
    legendRoot: container?.querySelector?.("[data-role='drift-legend']") || null,
  };
}

/**
 * Tear down the active zoom controller and reset to a no-op proxy target.
 */
function destroyTimeViewZoomController() {
  try { activeTimeViewZoomController?.destroy?.(); } catch { }
  activeTimeViewZoomController = createNullZoomController();
}

/**
 * Replace the active zoom controller and restore the previous zoom scale.
 *
 * @param {{getZoom?: Function, setZoom?: Function, destroy?: Function} | null} nextController
 *   Newly installed zoom controller.
 * @param {number} [zoomScale=1]
 *   Desired zoom scale to re-apply after replacement.
 * @returns {{getZoom?: Function, setZoom?: Function, destroy?: Function}}
 *   Active controller instance.
 */
function replaceTimeViewZoomController(nextController, zoomScale = 1) {
  destroyTimeViewZoomController();
  activeTimeViewZoomController = nextController || createNullZoomController();

  try {
    activeTimeViewZoomController?.setZoom?.(zoomScale);
  } catch { }

  return activeTimeViewZoomController;
}

function isTimeViewSpacingMode(value) {
  return value === "time" || value === "run";
}

function isTimeViewChartMode(value) {
  return value === "stacked" || value === "lines";
}

function formatTimeViewSpacingLabel(mode) {
  return mode === "run" ? "run spacing" : "real time spacing";
}

function formatTimeViewChartModeLabel(mode) {
  return mode === "stacked" ? "stacked view" : "line comparison";
}

function formatTimeViewRange(series) {
  const runs = Array.isArray(series) ? series : [];
  const first = runs[0]?.timestamp;
  const last = runs[runs.length - 1]?.timestamp;

  if (!(first instanceof Date) || !(last instanceof Date)) {
    return "time range unavailable";
  }

  const label = d3.utcFormat("%d.%m %H:%M");
  if (first.getTime() === last.getTime()) {
    return `${label(first)} UTC`;
  }

  return `${label(first)} -> ${label(last)} UTC`;
}

function formatModuleLabel(moduleName) {
  const normalized = normalizeModuleName(moduleName);
  const parts = normalized.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || normalized || "(unknown)";
}

function createTimeViewSummaryCard(label, value) {
  const card = document.createElement("div");
  card.className = "graphTimeSummaryCard";

  const labelEl = document.createElement("div");
  labelEl.className = "graphTimeSummaryLabel";
  labelEl.textContent = label;

  const valueEl = document.createElement("div");
  valueEl.className = "graphTimeSummaryValue";
  valueEl.textContent = String(value || "-");
  valueEl.title = valueEl.textContent;

  card.append(labelEl, valueEl);
  return card;
}

function renderTimeViewSummary(summaryRoot, summary = null) {
  if (!summaryRoot?.replaceChildren) return;

  const view = summary || {
    runs: "-",
    latestDrift: "-",
    largestSpike: "-",
    mostUnstable: "-",
  };

  summaryRoot.replaceChildren(
    createTimeViewSummaryCard("Runs", view.runs),
    createTimeViewSummaryCard("Latest drift", view.latestDrift),
    createTimeViewSummaryCard("Largest spike", view.largestSpike),
    createTimeViewSummaryCard("Most unstable", view.mostUnstable),
  );
}

function createTimeViewLegendItem(color, label) {
  const item = document.createElement("div");
  item.className = "graphLegendItem";

  const swatch = document.createElement("span");
  swatch.className = "graphLegendSwatch swatch-drift-line";
  swatch.style.background = String(color || "#64748b");

  const text = document.createElement("span");
  text.className = "small";
  text.textContent = String(label || "");

  item.append(swatch, text);
  return item;
}

function renderTimeViewLegend(legendRoot, stackKeys = [], colorByKey = new Map()) {
  if (!legendRoot?.replaceChildren) return;

  const keys = Array.isArray(stackKeys) ? stackKeys : [];
  if (!keys.length) {
    const empty = document.createElement("div");
    empty.className = "text-secondary small";
    empty.textContent = "Legend appears with loaded drift data.";
    legendRoot.replaceChildren(empty);
    return;
  }

  legendRoot.replaceChildren(
    ...keys.map((key) => createTimeViewLegendItem(colorByKey.get(key), formatModuleLabel(key)))
  );
}

function renderTimeViewMeta(metaEl, { series, spacingMode, chartMode } = {}) {
  if (!metaEl) return;

  const runs = Array.isArray(series) ? series : [];
  if (!runs.length) {
    metaEl.textContent = "No history loaded.";
    return;
  }

  metaEl.textContent = [
    `${runs.length} runs`,
    formatTimeViewRange(runs),
    formatTimeViewSpacingLabel(spacingMode),
    formatTimeViewChartModeLabel(chartMode),
    "drift = delta LOC + 10*delta fanIn + 10*delta fanOut",
  ].join(" · ");
}

function computeRowTotalDrift(row, keys) {
  return (keys || []).reduce(
    (sum, key) => sum + coerceNumber(row?.[key], 0),
    0
  );
}

function listModuleDriftDrivers(row, keys) {
  return (keys || [])
    .map((key) => ({
      key,
      driftValue: coerceNumber(row?.[key], 0),
    }))
    .sort((a, b) => b.driftValue - a.driftValue);
}

function formatSignedInteger(value) {
  return d3.format("+,d")(coerceNumber(value, 0));
}

function buildModuleDriftSnapshot(row, key) {
  return `${formatModuleLabel(key)}: drift ${formatRunValue(row?.[key] || 0)}, loc ${formatRunValue(row?.[`${key}_loc`] || 0)} (delta ${formatSignedInteger(row?.[`${key}_deltaLoc`])}), fanIn ${formatRunValue(row?.[`${key}_fanIn`] || 0)} (delta ${formatSignedInteger(row?.[`${key}_deltaFanIn`])}), fanOut ${formatRunValue(row?.[`${key}_fanOut`] || 0)} (delta ${formatSignedInteger(row?.[`${key}_deltaFanOut`])})`;
}

function buildRunMarkerTitle(row, totalRuns, keys) {
  const total = computeRowTotalDrift(row, keys);
  const topDrivers = listModuleDriftDrivers(row, keys)
    .filter((entry) => entry.driftValue > 0)
    .slice(0, 3)
    .map((entry) => buildModuleDriftSnapshot(row, entry.key));

  const lines = [
    buildRunLabel(coerceNumber(row?.runIndex, 0), totalRuns),
    String(row?.file || ""),
    formatUtcTimestamp(row?.timestamp),
    `total drift: ${formatRunValue(total)}`,
  ];

  if (topDrivers.length) {
    lines.push("top drivers:");
    lines.push(...topDrivers);
  } else {
    lines.push("baseline run");
  }

  return lines.join("\n");
}

function buildModulePointTitle(row, key, totalRuns, keys) {
  return [
    buildRunLabel(coerceNumber(row?.runIndex, 0), totalRuns),
    String(row?.file || ""),
    formatUtcTimestamp(row?.timestamp),
    buildModuleDriftSnapshot(row, key),
    `run total: ${formatRunValue(computeRowTotalDrift(row, keys))}`,
  ].join("\n");
}

function buildTimeViewSummary(series, keys) {
  const rows = Array.isArray(series) ? series : [];
  if (!rows.length) {
    return {
      runs: "-",
      latestDrift: "-",
      largestSpike: "-",
      mostUnstable: "-",
    };
  }

  const totalsByKey = new Map();
  rows.forEach((row) => {
    keys.forEach((key) => {
      totalsByKey.set(key, (totalsByKey.get(key) ?? 0) + coerceNumber(row?.[key], 0));
    });
  });

  const latestRow = rows[rows.length - 1];
  const latestDrift = computeRowTotalDrift(latestRow, keys);
  const largestSpike = rows.length <= 1
    ? null
    : rows
      .slice(1)
      .map((row) => ({
        row,
        total: computeRowTotalDrift(row, keys),
      }))
      .sort((a, b) => b.total - a.total)[0];

  const mostUnstable = [...totalsByKey.entries()]
    .sort((a, b) => b[1] - a[1])[0];

  return {
    runs: formatRunValue(rows.length),
    latestDrift: formatRunValue(latestDrift),
    largestSpike: largestSpike
      ? `${buildRunLabel(coerceNumber(largestSpike.row?.runIndex, 0), rows.length)} · ${formatRunValue(largestSpike.total)}`
      : "baseline only",
    mostUnstable: mostUnstable
      ? `${formatModuleLabel(mostUnstable[0])} · ${formatRunValue(mostUnstable[1])}`
      : "-",
  };
}

function syncTimeViewControls(container) {
  if (!container?.querySelectorAll) return;

  const spacingButtons = container.querySelectorAll("[data-graph-time-spacing]");
  spacingButtons.forEach((button) => {
    const isActive = button.getAttribute("data-graph-time-spacing") === timeViewUiState.spacingMode;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });

  const modeButtons = container.querySelectorAll("[data-graph-time-mode]");
  modeButtons.forEach((button) => {
    const isActive = button.getAttribute("data-graph-time-mode") === timeViewUiState.chartMode;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
}

function rerenderLatestTimeView() {
  if (!latestTimeViewContext) return;
  renderPreparedTimeView(latestTimeViewContext);
}

function bindTimeViewControls(container) {
  if (!container || container.dataset.timeViewControlsBound === "true") {
    syncTimeViewControls(container);
    return;
  }

  container.addEventListener("click", (event) => {
    const target = event?.target;
    if (!(target instanceof Element)) return;

    const button = target.closest("[data-graph-time-spacing], [data-graph-time-mode]");
    if (!(button instanceof HTMLElement) || !container.contains(button)) return;

    let changed = false;
    const spacingMode = button.getAttribute("data-graph-time-spacing");
    const chartMode = button.getAttribute("data-graph-time-mode");

    if (isTimeViewSpacingMode(spacingMode) && spacingMode !== timeViewUiState.spacingMode) {
      timeViewUiState.spacingMode = spacingMode;
      changed = true;
    }

    if (isTimeViewChartMode(chartMode) && chartMode !== timeViewUiState.chartMode) {
      timeViewUiState.chartMode = chartMode;
      changed = true;
    }

    if (!changed) return;

    syncTimeViewControls(container);
    rerenderLatestTimeView();
  });

  container.dataset.timeViewControlsBound = "true";
  syncTimeViewControls(container);
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
 * @param {{series: Array<object>, x: Function, innerH: number, xRead: Function}} args
 *   Run-guide render context.
 */
function renderRunGuides(g, { series, x, innerH, xRead }) {
  g.append("g")
    .attr("class", "time-run-guides")
    .selectAll("line")
    .data(series)
    .enter()
    .append("line")
    .attr("x1", (d) => x(xRead(d)))
    .attr("x2", (d) => x(xRead(d)))
    .attr("y1", 0)
    .attr("y2", innerH)
    .attr("stroke", "rgba(31,41,55,0.08)")
    .attr("stroke-dasharray", "3 4");
}

function getXAxisTotalRuns(series) {
  return Array.isArray(series) ? series.length : 0;
}

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

function formatXAxisTick(series, index, totalRuns) {
  const run = series[index];
  if (!run) return "";
  return `${buildRunLabel(index, totalRuns)} · ${d3.utcFormat("%d.%m %H:%M")(run.timestamp)}`;
}

function styleXAxisLabels(axisGroup) {
  axisGroup.selectAll("text")
    .style("font-size", "10px")
    .attr("transform", "rotate(-20)")
    .style("text-anchor", "end");
}

function renderXAxis(g, { x, innerH, tickCount, series, spacingMode }) {
  const axisGroup = g.append("g")
    .attr("transform", `translate(0,${innerH})`);

  if (spacingMode === "time") {
    axisGroup.call(
      d3.axisBottom(x)
        .ticks(Math.min(Math.max(series.length, 2), 5))
        .tickFormat(d3.utcFormat("%d.%m %H:%M"))
    );
    styleXAxisLabels(axisGroup);
    return;
  }

  const totalRuns = getXAxisTotalRuns(series);
  const tickIndexes = buildXAxisTickIndexes(totalRuns, tickCount);

  axisGroup.call(
    d3.axisBottom(x)
      .tickValues(tickIndexes)
      .tickFormat((index) => formatXAxisTick(series, index, totalRuns))
  );

  styleXAxisLabels(axisGroup);
}

function renderYAxis(g, y) {
  g.append("g")
    .call(
      d3.axisLeft(y)
        .ticks(6)
        .tickFormat(d3.format(","))
    )
    .call((sel) => sel.selectAll("text").style("font-size", "11px"));
}

function buildStackSeries(runs) {
  const topModules = selectTopModulesForStack(runs, 6);

  logInfo("Selected top modules for drift series", {
    runCount: runs.length,
    topModules,
  });

  return buildStackSeriesRows(runs, topModules);
}

function buildModulePalette(keys) {
  const palette = d3.schemeTableau10;
  const map = new Map();

  keys.forEach((key, index) => {
    map.set(key, palette[index % palette.length]);
  });

  return map;
}

function isStackSeriesMetaKey(key) {
  return key === "timestamp" || key === "file" || key === "runIndex";
}

function isStackSeriesDetailKey(key) {
  return key.endsWith("_loc") ||
    key.endsWith("_fanIn") ||
    key.endsWith("_fanOut") ||
    key.endsWith("_deltaLoc") ||
    key.endsWith("_deltaFanIn") ||
    key.endsWith("_deltaFanOut");
}

function selectStackKeys(series) {
  const firstRow = series[0] || {};

  return Object.keys(firstRow).filter((key) => {
    if (isStackSeriesMetaKey(key)) return false;
    if (isStackSeriesDetailKey(key)) return false;
    return true;
  });
}

function hasDriftSeriesValues(series, stackKeys) {
  return series.some((row) =>
    stackKeys.some((key) => coerceNumber(row?.[key], 0) > 0)
  );
}

function logTimeViewRender(appId, runs, series, stackKeys) {
  logInfo("Rendering drift overview chart", {
    appId,
    runCount: runs.length,
    seriesCount: series.length,
    stackKeys,
    spacingMode: timeViewUiState.spacingMode,
    chartMode: timeViewUiState.chartMode,
  });
}

function getChartInnerSize(width, height, margin) {
  return {
    innerW: width - margin.left - margin.right,
    innerH: height - margin.top - margin.bottom,
  };
}

function createChartRoot(svg, margin) {
  const root = svg.append("g");
  const g = root.append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  return { root, g };
}

function buildTimeViewMargin(width) {
  return {
    top: 24,
    right: Math.max(86, Math.min(132, width * 0.16)),
    bottom: 70,
    left: Math.max(58, Math.min(76, width * 0.11)),
  };
}

function readSeriesXValue(row, spacingMode) {
  if (spacingMode === "run") {
    return coerceNumber(row?.runIndex, 0);
  }

  return row?.timestamp instanceof Date ? row.timestamp : new Date(0);
}

function buildTimeScaleDomain(series) {
  const [start, end] = d3.extent(
    series,
    (row) => row?.timestamp instanceof Date ? row.timestamp : null
  );

  if (!(start instanceof Date) || !(end instanceof Date)) {
    const now = new Date();
    return [new Date(now.getTime() - 60 * 60 * 1000), now];
  }

  if (start.getTime() === end.getTime()) {
    return [
      new Date(start.getTime() - 30 * 60 * 1000),
      new Date(end.getTime() + 30 * 60 * 1000),
    ];
  }

  return [start, end];
}

function buildOverviewXScale(series, innerW, spacingMode) {
  if (spacingMode === "run") {
    return {
      x: d3.scaleLinear()
        .domain([0, Math.max(series.length - 1, 0)])
        .range([0, innerW]),
      xRead: (row) => readSeriesXValue(row, "run"),
    };
  }

  return {
    x: d3.scaleUtc()
      .domain(buildTimeScaleDomain(series))
      .range([0, innerW]),
    xRead: (row) => readSeriesXValue(row, "time"),
  };
}

function buildStackedOverviewScales(series, stackKeys, innerW, innerH, spacingMode) {
  const { x, xRead } = buildOverviewXScale(series, innerW, spacingMode);
  const y = d3.scaleLinear()
    .domain([0, d3.max(series, (row) => stackKeys.reduce(
      (sum, key) => sum + coerceNumber(row[key], 0),
      0
    )) || 1])
    .nice()
    .range([innerH, 0]);

  return { x, y, xRead };
}

function buildLineOverviewScales(series, stackKeys, innerW, innerH, spacingMode) {
  const { x, xRead } = buildOverviewXScale(series, innerW, spacingMode);
  const y = d3.scaleLinear()
    .domain([0, d3.max(series, (row) => d3.max(
      stackKeys,
      (key) => coerceNumber(row?.[key], 0)
    )) || 1])
    .nice()
    .range([innerH, 0]);

  return { x, y, xRead };
}

function renderOverviewAxes(g, { series, x, y, innerW, innerH, xRead, spacingMode }) {
  renderYGrid(g, y, innerW);
  renderRunGuides(g, { series, x, innerH, xRead });
  renderXAxis(g, {
    x,
    innerH,
    tickCount: Math.min(series.length, 6),
    series,
    spacingMode,
  });
  renderYAxis(g, y);
}

function buildStackedSeriesLayers(series, stackKeys) {
  const stack = d3.stack().keys(stackKeys);
  return stack(series);
}

function buildLineSeriesLayers(series, stackKeys) {
  return stackKeys.map((key) => ({
    key,
    points: series.map((row) => ({
      row,
      value: coerceNumber(row?.[key], 0),
    })),
  }));
}

function renderStackedAreas(g, { stacked, x, y, xRead, colorByKey }) {
  const area = d3.area()
    .curve(d3.curveStepAfter)
    .x((d) => x(xRead(d.data)))
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
    .attr("fill-opacity", 0.68)
    .attr("stroke", "none")
    .attr("d", area)
    .append("title")
    .text((d) => d.key);

  groups.append("path")
    .attr("class", "module-area-boundary")
    .attr("fill", "none")
    .attr("stroke", (d) => colorByKey.get(d.key))
    .attr("stroke-opacity", 0.78)
    .attr("stroke-width", 1.15)
    .attr("d", d3.line()
      .curve(d3.curveStepAfter)
      .x((point) => x(xRead(point.data)))
      .y((point) => y(point[1]))
    );
}

function renderRunMarkers(g, { series, keys, x, y, xRead }) {
  g.selectAll(".time-total-point")
    .data(series)
    .enter()
    .append("circle")
    .attr("class", "time-total-point")
    .attr("cx", (d) => x(xRead(d)))
    .attr("cy", (d) => y(computeRowTotalDrift(d, keys)))
    .attr("r", 3.2)
    .attr("fill", getCssToken("--cg-node-fill-root", "#111827"))
    .append("title")
    .text((d) => buildRunMarkerTitle(d, series.length, keys));
}

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
    .style("font-size", "10px")
    .style("font-weight", "600")
    .style("paint-order", "stroke")
    .style("stroke", "rgba(255,255,255,0.95)")
    .style("stroke-width", "3px")
    .style("stroke-linejoin", "round")
    .style("fill", (d) => colorByKey.get(d.key))
    .text((d) => formatModuleLabel(d.key));
}

function renderLineSeries(g, { layers, x, y, xRead, colorByKey, totalRuns, keys }) {
  const line = d3.line()
    .curve(d3.curveMonotoneX)
    .x((point) => x(xRead(point.row)))
    .y((point) => y(point.value));

  const groups = g.selectAll(".module-line-group")
    .data(layers)
    .enter()
    .append("g")
    .attr("class", "module-line-group");

  groups.append("path")
    .attr("fill", "none")
    .attr("stroke", (d) => colorByKey.get(d.key))
    .attr("stroke-width", 2)
    .attr("stroke-linecap", "round")
    .attr("stroke-linejoin", "round")
    .attr("d", (d) => line(d.points));

  groups.selectAll("circle")
    .data((layer) => layer.points.map((point) => ({
      ...point,
      key: layer.key,
    })))
    .enter()
    .append("circle")
    .attr("cx", (d) => x(xRead(d.row)))
    .attr("cy", (d) => y(d.value))
    .attr("r", 2.9)
    .attr("fill", "#ffffff")
    .attr("stroke", (d) => colorByKey.get(d.key))
    .attr("stroke-width", 1.6)
    .append("title")
    .text((d) => buildModulePointTitle(d.row, d.key, totalRuns, keys));
}

function renderLineEndLabels(g, { layers, y, innerW, colorByKey }) {
  const latestLayer = layers.map((layer) => ({
    key: layer.key,
    point: layer.points[layer.points.length - 1],
  }));

  const placed = [];
  const minGap = 14;

  g.selectAll(".line-end-label")
    .data(latestLayer)
    .enter()
    .append("text")
    .attr("class", "line-end-label")
    .attr("x", innerW - 6)
    .attr("y", (d) => {
      const targetY = y(d.point?.value || 0) - 10;
      const lastY = placed.length ? placed[placed.length - 1] : null;
      const nextY = lastY !== null && targetY - lastY < minGap ? lastY + minGap : targetY;
      placed.push(nextY);
      return nextY;
    })
    .attr("text-anchor", "end")
    .style("font-size", "10px")
    .style("font-weight", "600")
    .style("paint-order", "stroke")
    .style("stroke", "rgba(255,255,255,0.95)")
    .style("stroke-width", "3px")
    .style("stroke-linejoin", "round")
    .style("fill", (d) => colorByKey.get(d.key))
    .text((d) => formatModuleLabel(d.key));
}

function renderStackedOverviewChart(svg, { width, height, margin, series, stackKeys, colorByKey }) {
  clearSvg(svg);
  configureSvgViewport(svg, width, height);

  const { innerW, innerH } = getChartInnerSize(width, height, margin);
  const { g } = createChartRoot(svg, margin);
  const { x, y, xRead } = buildStackedOverviewScales(
    series,
    stackKeys,
    innerW,
    innerH,
    timeViewUiState.spacingMode
  );

  renderOverviewAxes(g, {
    series,
    x,
    y,
    innerW,
    innerH,
    xRead,
    spacingMode: timeViewUiState.spacingMode,
  });

  const stacked = buildStackedSeriesLayers(series, stackKeys);

  renderStackedAreas(g, {
    stacked,
    x,
    y,
    xRead,
    colorByKey,
  });

  renderRunMarkers(g, {
    series,
    keys: stackKeys,
    x,
    y,
    xRead,
  });

  renderEndLabels(g, {
    stacked,
    y,
    innerW,
    colorByKey,
  });
}

function renderLineOverviewChart(svg, { width, height, margin, series, stackKeys, colorByKey }) {
  clearSvg(svg);
  configureSvgViewport(svg, width, height);

  const { innerW, innerH } = getChartInnerSize(width, height, margin);
  const { g } = createChartRoot(svg, margin);
  const { x, y, xRead } = buildLineOverviewScales(
    series,
    stackKeys,
    innerW,
    innerH,
    timeViewUiState.spacingMode
  );

  renderOverviewAxes(g, {
    series,
    x,
    y,
    innerW,
    innerH,
    xRead,
    spacingMode: timeViewUiState.spacingMode,
  });

  const layers = buildLineSeriesLayers(series, stackKeys);

  renderLineSeries(g, {
    layers,
    x,
    y,
    xRead,
    colorByKey,
    totalRuns: series.length,
    keys: stackKeys,
  });

  renderLineEndLabels(g, {
    layers,
    y,
    innerW,
    colorByKey,
  });
}

function renderTimeViewEmpty(elements, width, height, message, metaMessage = "") {
  destroyTimeViewZoomController();
  renderTimeViewSummary(elements?.summaryRoot, null);
  renderTimeViewLegend(elements?.legendRoot, [], new Map());

  if (elements?.metaEl) {
    elements.metaEl.textContent = metaMessage || message;
  }

  renderEmpty(elements?.svg, width, height, message);
  return null;
}

function renderPreparedTimeView(context) {
  const elements = context?.elements;
  const svg = elements?.svg;
  const runs = Array.isArray(context?.runs) ? context.runs : [];
  const appId = String(context?.appId || "");

  if (!svg || svg.empty()) {
    return null;
  }

  const { width, height } = getSvgRenderSize(svg);
  const previousZoom = timeViewControllerProxy.getZoom();

  destroyTimeViewZoomController();

  if (!runs.length) {
    return renderTimeViewEmpty(
      elements,
      width,
      height,
      "No code-metrics history found for current app."
    );
  }

  const series = buildStackSeries(runs);
  if (!series.length) {
    return renderTimeViewEmpty(
      elements,
      width,
      height,
      "No module drift history found."
    );
  }

  STACK_KEYS = selectStackKeys(series);
  if (!STACK_KEYS.length || !hasDriftSeriesValues(series, STACK_KEYS)) {
    return renderTimeViewEmpty(
      elements,
      width,
      height,
      "No module drift across available runs."
    );
  }

  logTimeViewRender(appId, runs, series, STACK_KEYS);

  renderTimeViewSummary(elements?.summaryRoot, buildTimeViewSummary(series, STACK_KEYS));
  renderTimeViewMeta(elements?.metaEl, {
    series,
    spacingMode: timeViewUiState.spacingMode,
    chartMode: timeViewUiState.chartMode,
  });

  const colorByKey = buildModulePalette(STACK_KEYS);
  const margin = buildTimeViewMargin(width);
  renderTimeViewLegend(elements?.legendRoot, STACK_KEYS, colorByKey);

  if (timeViewUiState.chartMode === "stacked") {
    renderStackedOverviewChart(svg, {
      width,
      height,
      margin,
      series,
      stackKeys: STACK_KEYS,
      colorByKey,
    });
  } else {
    renderLineOverviewChart(svg, {
      width,
      height,
      margin,
      series,
      stackKeys: STACK_KEYS,
      colorByKey,
    });
  }

  replaceTimeViewZoomController(installSvgViewZoom(svg), previousZoom);
  return timeViewControllerProxy;
}

export async function initGraphTimeView(svgId, { appId, metrics } = {}) {
  const elements = resolveTimeViewElements(svgId);
  if (!elements?.svg) {
    logWarn("Time view host not found", { svgId });
    return null;
  }

  bindTimeViewControls(elements.container);
  renderTimeViewSummary(elements.summaryRoot, null);

  if (elements.metaEl) {
    elements.metaEl.textContent = "Loading history…";
  }

  const { width, height } = getSvgRenderSize(elements.svg);
  configureSvgViewport(elements.svg, width, height);
  elements.svg.attr("width", width).attr("height", height);
  renderEmpty(elements.svg, width, height, "Loading code-metrics history...");

  void metrics;
  logInfo("Initializing time view", { svgId, appId });

  let runs;
  try {
    runs = await loadTimeSeries(appId);
  } catch (err) {
    logError("Failed to load time-view series", err);
    return renderTimeViewEmpty(
      elements,
      width,
      height,
      "Could not load code-metrics history."
    );
  }

  latestTimeViewContext = {
    elements,
    runs,
    appId,
  };

  logInfo("Rendering time view with loaded runs", {
    appId,
    runCount: runs.length,
  });

  return renderPreparedTimeView(latestTimeViewContext);
}

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

const STACK_KEYS = ["loc", "fanIn", "fanOut"];
const STACK_COLOR_TOKENS = {
  loc: "--cg-node-kind-service",
  fanIn: "--cg-node-kind-config",
  fanOut: "--cg-node-kind-module",
};

function coerceNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function formatRunValue(value) {
  return d3.format(",")(coerceNumber(value, 0));
}

function buildSeriesLabel(appId) {
  return `Time view · normalized architecture drift · ${appId}`;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { Accept: "application/json" }
  });

  if (!res.ok) {
    throw new Error(`Request failed (${res.status}) for ${url}`);
  }

  return res.json();
}

function extractRunDate(fileName, appId) {
  const prefix = `${appId}-`;
  const suffix = `-code-metrics.csv`;

  if (!fileName?.startsWith(prefix) || !fileName?.endsWith(suffix)) {
    return null;
  }

  const raw = fileName.slice(prefix.length, -suffix.length);
  const iso = raw.replace(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    "$1T$2:$3:$4.$5Z"
  );

  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getCssToken(name, fallback) {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

function clearSvg(svg) {
  svg.selectAll("*").remove();
}

function configureSvgViewport(svg, width, height) {
  svg
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("preserveAspectRatio", "xMidYMid meet");
}

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

function normalizeModuleName(value) {
  return String(value || "")
    .trim()
    .replace(/^\.\//, "");
}

function isCodeModuleRow(row) {
  const moduleName = normalizeModuleName(row?.module || row?.file || row?.path || row?.name);
  if (!moduleName) return false;
  return /\.(js|mjs|cjs|ts|tsx|jsx)$/i.test(moduleName);
}

function summarizeRun(rows) {
  const codeRows = (rows || []).filter(isCodeModuleRow);
  const scopedRows = codeRows.length ? codeRows : (rows || []);

  return {
    loc: scopedRows.reduce((sum, row) => sum + coerceNumber(row?.loc ?? row?.lines, 0), 0),
    fanIn: scopedRows.reduce((sum, row) => sum + coerceNumber(row?.fanIn, 0), 0),
    fanOut: scopedRows.reduce((sum, row) => sum + coerceNumber(row?.fanOut, 0), 0),
  };
}

async function loadTimeSeries(appId) {
  const files = await fetchJson(
    `/api/output-files?appId=${encodeURIComponent(appId)}&type=code-metrics`
  );

  const matchingFiles = Array.isArray(files)
    ? files.filter((file) => file?.startsWith(`${appId}-`) && file?.endsWith("-code-metrics.csv"))
    : [];

  const runs = await Promise.all(
    matchingFiles.map(async (file) => {
      const timestamp = extractRunDate(file, appId);
      const rows = await d3.csv(`/output/${encodeURIComponent(file)}`);
      const totals = summarizeRun(rows);

      return {
        file,
        timestamp,
        ...totals,
      };
    })
  );

  return runs
    .filter((run) => run.timestamp instanceof Date)
    .sort((a, b) => d3.ascending(a.timestamp, b.timestamp));
}

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

function renderXAxis(g, x, innerH, tickCount) {
  g.append("g")
    .attr("transform", `translate(0,${innerH})`)
    .call(
      d3.axisBottom(x)
        .ticks(tickCount)
        .tickFormat(d3.timeFormat("%d.%m %H:%M"))
    )
    .call((sel) => sel.selectAll("text")
      .style("font-size", "10px")
      .attr("transform", "rotate(-20)")
      .style("text-anchor", "end"));
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
  return runs.map((run) => ({
    file: run.file,
    timestamp: run.timestamp,
    loc: coerceNumber(run.loc, 0),
    fanIn: coerceNumber(run.fanIn, 0),
    fanOut: coerceNumber(run.fanOut, 0),
  }));
}
function normalizeSeries(series) {
  const max = {};

  for (const key of STACK_KEYS) {
    max[key] = d3.max(series, (d) => coerceNumber(d[key], 0)) || 1;
  }

  return series.map((row) => {
    const normalized = { ...row };

    for (const key of STACK_KEYS) {
      normalized[key] = coerceNumber(row[key], 0) / max[key];
    }

    return normalized;
  });
}

function getMaxStackTotal(series) {
  return d3.max(
    series,
    (row) => STACK_KEYS.reduce((sum, key) => sum + coerceNumber(row?.[key], 0), 0)
  ) || 1;
}

function renderStackedAreas(g, stackedSeries, x, y) {
  const area = d3.area()
    .curve(d3.curveMonotoneX)
    .x((d) => x(d.data.timestamp))
    .y0((d) => y(d[0]))
    .y1((d) => y(d[1]));

  g.selectAll(".stack-area")
    .data(stackedSeries)
    .enter()
    .append("path")
    .attr("class", (d) => `stack-area stack-area-${d.key}`)
    .attr("fill", (d) => getCssToken(STACK_COLOR_TOKENS[d.key], "#adb5bd"))
    .attr("fill-opacity", 0.72)
    .attr("stroke", (d) => getCssToken(STACK_COLOR_TOKENS[d.key], "#adb5bd"))
    .attr("stroke-width", 1.2)
    .attr("d", area)
    .append("title")
    .text((d) => d.key);
}

function renderRunMarkers(g, series, x, y) {
  g.selectAll(".time-total-point")
    .data(series)
    .enter()
    .append("circle")
    .attr("class", "time-total-point")
    .attr("cx", (d) => x(d.timestamp))
    .attr("cy", (d) => y(STACK_KEYS.reduce((sum, key) => sum + coerceNumber(d?.[key], 0), 0)))
    .attr("r", 3.5)
    .attr("fill", getCssToken("--cg-node-fill-root", "#111827"))
    .append("title")
    .text((d) => {
      const details = STACK_KEYS.map((key) => `${key}: ${formatRunValue(d[key])}`).join("\n");
      const total = STACK_KEYS.reduce((sum, key) => sum + coerceNumber(d?.[key], 0), 0);
      return `${d.file}\n${d.timestamp.toISOString()}\n${details}\ntotal: ${formatRunValue(total)}`;
    });
}

function renderEndLabels(g, stackedSeries, x, y, innerW) {
  const latestLayer = stackedSeries.map((layer) => ({
    key: layer.key,
    point: layer[layer.length - 1]
  }));

  g.selectAll(".stack-end-label")
    .data(latestLayer)
    .enter()
    .append("text")
    .attr("class", "stack-end-label")
    .attr("x", innerW - 6)
    .attr("y", (d) => y((d.point[0] + d.point[1]) / 2) - 10)
    .attr("text-anchor", "end")
    .attr("dominant-baseline", "auto")
    .style("font-size", "10px")
    .style("font-weight", "600")
    .style("paint-order", "stroke")
    .style("stroke", "rgba(255,255,255,0.95)")
    .style("stroke-width", "3px")
    .style("stroke-linejoin", "round")
    .style("fill", (d) => getCssToken(STACK_COLOR_TOKENS[d.key], "#adb5bd"))
    .text((d) => d.key);
}

function renderChartHeader(root, { width, margin, appId, series }) {
  const latest = series[series.length - 1];
  const latestTotal = STACK_KEYS.reduce((sum, key) => sum + coerceNumber(latest?.[key], 0), 0);

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
    .text(`${series.length} runs · latest total ${formatRunValue(latestTotal)}`);
}

function renderStackedOverviewChart(svg, { width, height, margin, runs, appId }) {
  clearSvg(svg);

  const rawSeries = buildStackSeries(runs);
  const series = normalizeSeries(rawSeries);
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  const root = svg.append("g");
  const g = root.append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  const x = d3.scaleTime()
    .domain(d3.extent(series, (d) => d.timestamp))
    .range([0, innerW]);

  const y = d3.scaleLinear()
    .domain([0, getMaxStackTotal(series)])
    .nice()
    .range([innerH, 0]);

  renderYGrid(g, y, innerW);
  renderXAxis(g, x, innerH, Math.min(series.length, 6));
  renderYAxis(g, y);

  const stack = d3.stack().keys(STACK_KEYS);
  const stackedSeries = stack(series);

  renderStackedAreas(g, stackedSeries, x, y);
  renderRunMarkers(g, series, x, y);
  renderEndLabels(g, stackedSeries, x, y, innerW);
  renderChartHeader(root, { width, margin, appId, series });
}

export async function initGraphTimeView(svgId, { appId, metrics } = {}) {
  const svg = d3.select(`#${svgId}`);
  if (svg.empty()) {
    console.warn("Time view SVG not found:", svgId);
    return;
  }

  const { width, height } = getSvgRenderSize(svg);
  const margin = { top: 44, right: 88, bottom: 64, left: 88 };

  configureSvgViewport(svg, width, height);
  svg.attr("width", width).attr("height", height);

  void metrics;

  let runs;
  try {
    runs = await loadTimeSeries(appId);
  } catch (err) {
    console.warn("Failed to load time-view series:", err);
    renderEmpty(svg, width, height, "Could not load code-metrics history.");
    return;
  }

  if (!runs.length) {
    renderEmpty(svg, width, height, "No code-metrics history found for current app.");
    return;
  }

  renderStackedOverviewChart(svg, {
    width,
    height,
    margin,
    runs,
    appId
  });
}
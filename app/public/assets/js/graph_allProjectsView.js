"use strict";

import { getSelectedAppId } from "./uiState.js";

const SCORE_WEIGHTS = Object.freeze({
  hotness: 0.45,
  cc: 0.35,
  volatility: 0.20
});
const PORTFOLIO_APP_ACTION_EVENT = "nodeanalyzer:portfolio-app-action";
const PROJECT_REVIEW_LIMIT = 6;
let latestPortfolioState = null;
const projectReadmeCache = new Map();
const projectReadmePending = new Map();

export async function renderAllProjectsView(elementId) {
  const root = document.getElementById(String(elementId || ""));
  if (!root) return;

  root.innerHTML = `<div class="text-secondary small">Loading portfolio view…</div>`;

  const payload = await fetchJson("/api/projects-overview");
  const state = decoratePortfolioPayload(payload);
  renderPortfolioView(root, state);
}

export function syncPortfolioSelection(elementId, appId) {
  const root = document.getElementById(String(elementId || ""));
  if (!root || !latestPortfolioState?.apps?.length) return false;

  const nextState = {
    ...latestPortfolioState,
    selectedAppId: String(appId || "").trim()
  };

  latestPortfolioState = nextState;
  return renderPortfolioProjectList(root, nextState);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json" }
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `HTTP ${response.status}`);
  }

  return response.json();
}

function decoratePortfolioPayload(payload) {
  const baseApps = Array.isArray(payload?.apps) ? payload.apps : [];
  const decoratedApps = baseApps.map(decorateAppMetrics);
  const maxima = collectPortfolioMaxima(decoratedApps);

  const apps = decoratedApps
    .map((app) => attachCriticality(app, maxima))
    .sort((a, b) => b.criticality.score - a.criticality.score);

  return {
    generatedAt: String(payload?.generatedAt || ""),
    apps,
    selectedAppId: readSelectedAppId(),
    totalRuns: apps.reduce((sum, app) => sum + Number(app?.runCount || 0), 0)
  };
}

function readSelectedAppId() {
  return getSelectedAppId();
}

function decorateAppMetrics(app) {
  const history = Array.isArray(app?.history) ? app.history : [];
  const latest = app?.latest || null;
  const latestCodeLines = Number(latest?.codeLinesTotal ?? latest?.locTotal ?? 0) || 0;
  const latestHotness = Number(latest?.hotnessDensity ?? latest?.hotnessTotal ?? 0) || 0;
  const latestCc = Number(latest?.ccDensity ?? latest?.ccTotal ?? 0) || 0;

  return {
    ...app,
    latest,
    latestCodeLines,
    latestHotness,
    latestCc,
    locVolatility: computeRelativeVolatility(history, (run) => run?.codeLinesTotal ?? run?.locTotal),
    hotnessDelta: computeLatestDelta(history, (run) => run?.hotnessDensity ?? run?.hotnessTotal),
    ccDelta: computeLatestDelta(history, (run) => run?.ccDensity ?? run?.ccTotal)
  };
}

function collectPortfolioMaxima(apps) {
  return {
    hotness: maxMetric(apps, (app) => app.latestHotness),
    cc: maxMetric(apps, (app) => app.latestCc),
    volatility: maxMetric(apps, (app) => app.locVolatility),
    loc: maxMetric(apps, (app) => app.latestCodeLines)
  };
}

function maxMetric(items, readValue) {
  let max = 0;

  for (const item of items) {
    const value = Number(readValue(item) || 0);
    if (value > max) max = value;
  }

  return max;
}

function attachCriticality(app, maxima) {
  const hotnessNorm = normalizeMetric(app.latestHotness, maxima.hotness);
  const ccNorm = normalizeMetric(app.latestCc, maxima.cc);
  const volatilityNorm = normalizeMetric(app.locVolatility, maxima.volatility);

  const score =
    hotnessNorm * SCORE_WEIGHTS.hotness +
    ccNorm * SCORE_WEIGHTS.cc +
    volatilityNorm * SCORE_WEIGHTS.volatility;

  return {
    ...app,
    criticality: {
      hotnessNorm,
      ccNorm,
      volatilityNorm,
      score,
      scorePct: Math.round(score * 100),
      tone: criticalityTone(score)
    }
  };
}

function normalizeMetric(value, max) {
  const numericValue = Number(value || 0);
  const numericMax = Number(max || 0);
  if (!Number.isFinite(numericValue) || numericValue <= 0) return 0;
  if (!Number.isFinite(numericMax) || numericMax <= 0) return 0;
  return numericValue / numericMax;
}

function criticalityTone(score) {
  if (score >= 0.7) return "critical";
  if (score >= 0.45) return "watch";
  return "stable";
}

function computeRelativeVolatility(history, readValue) {
  const series = compactSeries(history, readValue);
  if (series.length < 2) return 0;

  let deltaSum = 0;
  for (let index = 1; index < series.length; index++) {
    deltaSum += Math.abs(series[index] - series[index - 1]);
  }

  const latest = series[series.length - 1] || 0;
  return deltaSum / Math.max(series.length - 1, 1) / Math.max(latest, 1);
}

function computeLatestDelta(history, readValue) {
  const series = compactSeries(history, readValue);
  if (series.length < 2) return 0;
  return series[series.length - 1] - series[series.length - 2];
}

function compactSeries(history, readValue) {
  const values = [];

  for (const item of history || []) {
    const value = Number(readValue(item));
    if (!Number.isFinite(value)) continue;
    values.push(value);
  }

  return values;
}

function renderPortfolioView(root, state) {
  if (!state.apps.length) {
    root.innerHTML = `<div class="text-secondary small">No project history available yet.</div>`;
    return;
  }

  latestPortfolioState = state;
  root.innerHTML = buildPortfolioMarkup(state);
  ensurePortfolioInteractionsBound(root);
  renderPortfolioProjectList(root, state);

  const riskMapSvg = root.querySelector("[data-role='portfolio-risk-map']");
  if (riskMapSvg) renderRiskMap(riskMapSvg, state.apps);
}

function renderPortfolioProjectList(root, state) {
  const list = root.querySelector(".portfolioProjectsList");
  if (!list) return false;

  list.innerHTML = buildProjectRowsMarkup(state);
  hydrateExpandedProjectReadme(root);
  return true;
}

function buildPortfolioMarkup(state) {
  return `
    <div class="portfolioView">
      <div class="portfolioSummaryBar">
        <div>
          <div class="small fw-semibold">Portfolio overview</div>
          <div class="small text-secondary">
            ${state.apps.length} projects · ${state.totalRuns} runs · generated ${formatTimestamp(state.generatedAt)}
          </div>
        </div>
        <div class="small text-secondary portfolioSummaryNote">
          Criticality = hotness + CC density + change volatility
        </div>
      </div>

      <div class="portfolioTopGrid">
        <section class="portfolioCard portfolioLegendCard">${buildRiskLegendMarkup()}</section>

        <section class="portfolioCard">
          <div class="small fw-semibold mb-2">Risk map</div>
          <svg class="portfolioRiskMap" data-role="portfolio-risk-map" viewBox="0 0 920 320" preserveAspectRatio="none"></svg>
        </section>
      </div>

      <section class="portfolioProjectsList"></section>
    </div>
  `;
}

function buildProjectRowsMarkup(state) {
  return (state.apps || [])
    .map((app) => buildProjectRowMarkup(app, state.selectedAppId))
    .join("");
}

function buildRiskLegendMarkup() {
  return `
    <section class="portfolioLegend">
      <div class="small fw-semibold">Legend</div>
      <div class="portfolioLegendRows">
        <div class="portfolioLegendRow">
          <span class="portfolioLegendSwatch tone-stable" aria-hidden="true"></span>
          <span class="small">stable</span>
        </div>
        <div class="portfolioLegendRow">
          <span class="portfolioLegendSwatch tone-watch" aria-hidden="true"></span>
          <span class="small">watch</span>
        </div>
        <div class="portfolioLegendRow">
          <span class="portfolioLegendSwatch tone-critical" aria-hidden="true"></span>
          <span class="small">critical</span>
        </div>
      </div>
      <div class="portfolioLegendMeta small text-secondary">
        <div>X: hotness density</div>
        <div>Y: CC density</div>
        <div>Size: code lines</div>
      </div>
    </section>
  `;
}

function getProjectReviewItems(app) {
  return Array.isArray(app?.latestModules)
    ? app.latestModules.slice(0, PROJECT_REVIEW_LIMIT)
    : [];
}

function buildProjectReviewQueueMarkup(app) {
  const reviewItems = getProjectReviewItems(app);

  if (!reviewItems.length) {
    return `
      <section class="portfolioProjectQueue">
        <div class="text-secondary small">No file-level review queue available yet.</div>
      </section>
    `;
  }

  return `
    <section class="portfolioProjectQueue">
      <div class="portfolioProjectQueueHeader">
        <div class="small fw-semibold">Next files to revise</div>
        <div class="small text-secondary">
          Top ${reviewItems.length} files for ${escapeHtml(app.appId)} by hotspot, CC density and size.
        </div>
      </div>
      <div class="table-responsive portfolioProjectReviewTableWrap">
        <table class="table table-sm portfolioReviewTable align-middle">
          <thead>
            <tr>
              <th scope="col">Module</th>
              <th scope="col">Hotness</th>
              <th scope="col">CC density</th>
              <th scope="col">CC</th>
              <th scope="col">Code lines</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            ${reviewItems.map((item) => buildProjectReviewRow(app, item)).join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function buildProjectReviewRow(app, item) {
  const appId = String(item?.appId || app?.appId || "");
  const moduleName = String(item?.module || "");
  const hotness = Number(item?.hotness || 0);
  const ccDensity = Number(item?.ccDensity || 0);
  const cc = Number(item?.cc || 0);
  const codeLines = Number(item?.codeLines || 0);

  return `
    <tr>
      <td class="portfolioReviewModule">${escapeHtml(moduleName)}</td>
      <td>${escapeHtml(formatMetricValue(hotness))}</td>
      <td>${escapeHtml(formatMetricValue(ccDensity))}</td>
      <td>${escapeHtml(formatIntegerMetric(cc))}</td>
      <td>${escapeHtml(formatIntegerMetric(codeLines))}</td>
      <td class="portfolioReviewAction">
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary portfolioNoteBtn"
          data-action="create-review-note"
          data-app-id="${escapeHtml(appId)}"
          data-module="${escapeHtml(moduleName)}"
          data-hotness="${escapeHtml(hotness)}"
          data-cc-density="${escapeHtml(ccDensity)}"
          data-cc="${escapeHtml(cc)}"
          data-code-lines="${escapeHtml(codeLines)}"
        >
          create note
        </button>
      </td>
    </tr>
  `;
}

function formatIntegerMetric(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "n/a";
  return String(Math.round(numeric));
}

function buildProjectRowMarkup(app, selectedAppId) {
  const isActiveApp = String(app?.appId || "") === String(selectedAppId || "");
  const detailsId = buildProjectDetailsId(app?.appId);

  return `
    <article class="portfolioProjectCard tone-${app.criticality?.tone || "stable"}${isActiveApp ? " is-active-app" : ""}">
      <div class="portfolioProjectShell">
        <button
          type="button"
          class="portfolioProjectToggle"
          data-portfolio-toggle-details="true"
          data-app-id="${escapeHtml(app.appId)}"
          aria-expanded="${isActiveApp ? "true" : "false"}"
          aria-controls="${escapeHtml(detailsId)}"
        >
          ${buildProjectToggleContentMarkup(app)}
        </button>

        <div class="portfolioProjectActions" aria-label="Project actions">
          ${buildProjectActionButtonsMarkup(app)}
        </div>
      </div>

      ${isActiveApp ? buildProjectDetailsMarkup(app, detailsId) : ""}
    </article>
  `;
}

function buildProjectDetailsId(appId) {
  return `portfolio-project-details-${noteFilenameToken(appId)}`;
}

function buildProjectToggleContentMarkup(app) {
  return `
    <div class="portfolioProjectHeader">
      ${buildProjectHeaderMetaMarkup(app)}
      <div class="portfolioProjectHeaderAside">${buildProjectScoreMarkup(app)}</div>
    </div>
    <div class="portfolioMetricGrid portfolioMetricGridInteractive">
      ${buildProjectMetricTilesMarkup(app)}
    </div>
  `;
}

function buildProjectHeaderMetaMarkup(app) {
  const latest = app.latest || {};

  return `
    <div>
      <div class="portfolioProjectNameRow">
        <div class="portfolioProjectName">${escapeHtml(app.name || app.appId)}</div>
      </div>
      <div class="small text-secondary">
        ${escapeHtml(app.appId)} · ${app.runCount} runs · latest ${formatTimestamp(latest.timestamp)}
      </div>
    </div>
  `;
}

function buildProjectScoreMarkup(app) {
  const score = app.criticality?.scorePct ?? 0;

  return `
    <div class="portfolioProjectScore">
      <span class="portfolioScoreBadge">${score}</span>
      <span class="small text-secondary">criticality</span>
    </div>
  `;
}

function buildProjectMetricTilesMarkup(app) {
  const latest = app.latest || {};

  return [
    buildMetricTile(
      "Code lines",
      latest.codeLinesTotal ?? latest.locTotal,
      buildSparklineSvg(app.history, (run) => run?.codeLinesTotal ?? run?.locTotal, "code")
    ),
    buildMetricTile(
      "Comment lines",
      latest.commentLinesTotal,
      buildSparklineSvg(app.history, (run) => run?.commentLinesTotal, "comment"),
      coverageLabel(latest.commentCoverage)
    ),
    buildMetricTile(
      "Hotness",
      latest.hotnessDensity ?? latest.hotnessTotal,
      buildSparklineSvg(app.history, (run) => run?.hotnessDensity ?? run?.hotnessTotal, "hotness"),
      coverageLabel(latest.hotnessCoverage)
    ),
    buildMetricTile(
      "CC",
      latest.ccDensity ?? latest.ccTotal,
      buildSparklineSvg(app.history, (run) => run?.ccDensity ?? run?.ccTotal, "cc"),
      coverageLabel(latest.ccCoverage)
    )
  ].join("");
}

function buildProjectActionButtonsMarkup(app) {
  return `
    <button
      type="button"
      class="btn btn-sm btn-outline-secondary"
      data-portfolio-action="restart"
      data-app-id="${escapeHtml(app.appId)}"
    >
      Restart
    </button>
    <button
      type="button"
      class="btn btn-sm btn-outline-primary"
      data-portfolio-action="open"
      data-app-id="${escapeHtml(app.appId)}"
      data-url="${escapeHtml(app.url || "")}"
    >
      Show
    </button>
    <button
      type="button"
      class="btn btn-sm btn-primary"
      data-portfolio-action="analyze"
      data-app-id="${escapeHtml(app.appId)}"
    >
      Analyze
    </button>
    <button
      type="button"
      class="btn btn-sm btn-outline-primary"
      data-portfolio-action="freeze"
      data-app-id="${escapeHtml(app.appId)}"
    >
      Freeze
    </button>
  `;
}

function buildProjectDetailsMarkup(app, detailsId) {
  return `
    <section
      class="portfolioProjectAccordionBody"
      id="${escapeHtml(detailsId)}"
      role="region"
      aria-label="Project details for ${escapeHtml(app.appId)}"
    >
      ${buildProjectReviewQueueMarkup(app)}
      ${buildProjectReadmeMarkup(app)}
    </section>
  `;
}

function buildProjectReadmeMarkup(app) {
  const appId = String(app?.appId || "");

  return `
    <section class="portfolioProjectReadme">
      <div class="portfolioProjectReadmeHeader">
        <div class="small fw-semibold">README</div>
        <div class="small text-secondary">App root context for ${escapeHtml(appId)}</div>
      </div>
      <div class="portfolioProjectReadmeBody" data-project-readme="${escapeHtml(appId)}">
        ${buildProjectReadmeBodyMarkup(appId)}
      </div>
    </section>
  `;
}

function buildMetricTile(label, value, sparklineSvg, note = "") {
  return `
    <section class="portfolioMetricTile">
      <div class="portfolioMetricHeader">
        <span class="small fw-semibold">${escapeHtml(label)}</span>
        <span class="small text-secondary">${escapeHtml(formatMetricValue(value))}</span>
      </div>
      ${sparklineSvg}
      ${note ? `<div class="portfolioMetricNote">${escapeHtml(note)}</div>` : ""}
    </section>
  `;
}

function buildProjectReadmeUrl(appId) {
  const a = encodeURIComponent(String(appId || ""));
  return `/readme?appId=${a}&file=.`;
}

function markdownToHtml(md) {
  const text = String(md || "");
  return window.marked?.parse ? window.marked.parse(text) : `<pre>${escapeHtml(text)}</pre>`;
}

function sanitizeHtml(rawHtml) {
  return window.DOMPurify?.sanitize ? window.DOMPurify.sanitize(rawHtml) : rawHtml;
}

function findPortfolioApp(appId) {
  const safeAppId = String(appId || "").trim();
  if (!safeAppId) return null;
  return latestPortfolioState?.apps?.find((app) => String(app?.appId || "").trim() === safeAppId) || null;
}

function normalizeProjectBaseUrl(url) {
  const safeUrl = String(url || "").trim();
  if (!safeUrl) return "";
  return safeUrl.endsWith("/") ? safeUrl : `${safeUrl}/`;
}

function isProjectAssetLink(rawValue) {
  const safeValue = String(rawValue || "").trim();
  if (!safeValue) return false;
  if (safeValue.startsWith("#")) return false;
  if (safeValue.startsWith("//")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(safeValue)) return false;
  return /^\.?\/?assets\//i.test(safeValue);
}

function resolveProjectAssetUrl(appId, rawValue) {
  const appUrl = normalizeProjectBaseUrl(findPortfolioApp(appId)?.url || "");
  if (!appUrl || !isProjectAssetLink(rawValue)) return rawValue;

  const relPath = String(rawValue || "")
    .trim()
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");

  try {
    return new URL(relPath, appUrl).toString();
  } catch {
    return rawValue;
  }
}

function rewriteProjectAssetLinks(rawHtml, appId) {
  const safeHtml = String(rawHtml || "");
  if (!safeHtml) return safeHtml;

  const template = document.createElement("template");
  template.innerHTML = safeHtml;

  for (const element of template.content.querySelectorAll("[href], [src]")) {
    if (element.hasAttribute("href")) {
      const href = String(element.getAttribute("href") || "");
      element.setAttribute("href", resolveProjectAssetUrl(appId, href));
    }

    if (element.hasAttribute("src")) {
      const src = String(element.getAttribute("src") || "");
      element.setAttribute("src", resolveProjectAssetUrl(appId, src));
    }
  }

  return template.innerHTML;
}

function buildProjectReadmeBodyMarkup(appId) {
  const entry = projectReadmeCache.get(String(appId || ""));

  if (!entry) {
    return `<div class="text-secondary small">Loading README…</div>`;
  }

  if (entry.status === "missing") {
    return `<div class="text-secondary small">No README found in the app root.</div>`;
  }

  if (entry.status === "error") {
    return `<div class="text-danger small">${escapeHtml(entry.message || "README could not be loaded.")}</div>`;
  }

  const rawHtml = markdownToHtml(entry.markdown || "");
  const safeHtml = sanitizeHtml(rawHtml);
  const linkedHtml = rewriteProjectAssetLinks(safeHtml, appId);

  return `
    <div class="small text-secondary mb-2">${escapeHtml(entry.readmePath || "")}</div>
    <div class="content markdown">${linkedHtml}</div>
  `;
}

async function loadProjectReadme(appId) {
  const safeAppId = String(appId || "").trim();
  if (!safeAppId) return { status: "missing" };

  if (projectReadmePending.has(safeAppId)) {
    return projectReadmePending.get(safeAppId);
  }

  const promise = fetchJson(buildProjectReadmeUrl(safeAppId))
    .then((data) => {
      const entry = !data || data.found === false
        ? { status: "missing" }
        : {
            status: "ready",
            readmePath: String(data.readmePath || ""),
            markdown: String(data.markdown || "")
          };

      projectReadmeCache.set(safeAppId, entry);
      return entry;
    })
    .catch((error) => {
      const entry = {
        status: "error",
        message: String(error?.message || error || "README could not be loaded.")
      };

      projectReadmeCache.set(safeAppId, entry);
      return entry;
    })
    .finally(() => {
      projectReadmePending.delete(safeAppId);
    });

  projectReadmePending.set(safeAppId, promise);
  return promise;
}

function getProjectReadmeContainer(root, appId) {
  return Array.from(root.querySelectorAll("[data-project-readme]"))
    .find((element) => String(element?.dataset?.projectReadme || "") === String(appId || "")) || null;
}

function hydrateExpandedProjectReadme(root) {
  const appId = String(latestPortfolioState?.selectedAppId || "");
  if (!appId) return;

  if (projectReadmeCache.has(appId)) return;

  loadProjectReadme(appId).then(() => {
    if (String(latestPortfolioState?.selectedAppId || "") !== appId) return;
    const container = getProjectReadmeContainer(root, appId);
    if (!container) return;
    container.innerHTML = buildProjectReadmeBodyMarkup(appId);
  });
}

function toggleProjectDetails(root, appId) {
  const safeAppId = String(appId || "").trim();
  if (!safeAppId) return;
  const selectedAppId = String(latestPortfolioState?.selectedAppId || "");
  const nextAppId = selectedAppId === safeAppId ? "" : safeAppId;

  dispatchPortfolioAppAction({
    action: "select",
    appId: nextAppId,
    url: ""
  });
}

function coverageLabel(coverage) {
  const value = Number(coverage);
  if (!Number.isFinite(value) || value <= 0) return "no data";
  if (value >= 0.999) return "";
  return `${Math.round(value * 100)}% coverage`;
}

function buildSparklineSvg(history, readValue, tone) {
  const values = (history || []).map((run) => {
    const value = Number(readValue(run));
    return Number.isFinite(value) ? value : null;
  });

  const pathData = buildSparklinePath(values, 140, 36);
  if (!pathData) {
    return `<div class="portfolioSparklineEmpty">n/a</div>`;
  }

  return `
    <svg class="portfolioSparkline tone-${escapeHtml(tone)}" viewBox="0 0 140 36" preserveAspectRatio="none">
      <path d="${pathData}" />
    </svg>
  `;
}

function buildSparklinePath(values, width, height) {
  const numericValues = values.filter((value) => Number.isFinite(value));
  if (!numericValues.length) return "";

  const min = Math.min(...numericValues);
  const max = Math.max(...numericValues);
  const segments = [];
  let activeSegment = [];

  values.forEach((value, index) => {
    if (!Number.isFinite(value)) {
      if (activeSegment.length) {
        segments.push(activeSegment);
        activeSegment = [];
      }
      return;
    }

    activeSegment.push({
      x: scaleLinear(index, 0, Math.max(values.length - 1, 1), 4, width - 4),
      y: scaleLinear(value, min, max, height - 4, 4)
    });
  });

  if (activeSegment.length) segments.push(activeSegment);
  return segments.map(pointsToPath).join(" ");
}

function pointsToPath(points) {
  if (!points.length) return "";
  return points.map((point, index) =>
    `${index === 0 ? "M" : "L"}${round(point.x)},${round(point.y)}`
  ).join(" ");
}

function renderRiskMap(svgElement, apps) {
  const d3 = window.d3;
  if (!d3) return;

  const plottedApps = (apps || []).filter((app) => app?.latest);
  const svg = d3.select(svgElement);
  svg.selectAll("*").remove();

  if (!plottedApps.length) {
    svg.append("text")
      .attr("x", 460)
      .attr("y", 160)
      .attr("text-anchor", "middle")
      .attr("class", "portfolioRiskLabel")
      .text("No project runs available yet.");
    return;
  }

  const width = 920;
  const height = 320;
  const margin = { top: 20, right: 24, bottom: 40, left: 52 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  const xMax = d3.max(plottedApps, (app) => Number(app.latestHotness || 0)) || 1;
  const yMax = d3.max(plottedApps, (app) => Number(app.latestCc || 0)) || 1;
  const rMax = d3.max(plottedApps, (app) => Number(app.latestCodeLines || 0)) || 1;

  const x = d3.scaleLinear().domain([0, xMax]).nice().range([0, innerW]);
  const y = d3.scaleLinear().domain([0, yMax]).nice().range([innerH, 0]);
  const r = d3.scaleSqrt().domain([0, rMax]).range([8, 28]);

  const root = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  root.append("g")
    .attr("transform", `translate(0,${innerH})`)
    .call(d3.axisBottom(x).ticks(5).tickFormat(d3.format(".2f")))
    .call((sel) => sel.selectAll("text").style("font-size", "10px"));

  root.append("g")
    .call(d3.axisLeft(y).ticks(5).tickFormat(d3.format(".2f")))
    .call((sel) => sel.selectAll("text").style("font-size", "10px"));

  root.append("text")
    .attr("x", innerW)
    .attr("y", innerH + 34)
    .attr("text-anchor", "end")
    .attr("class", "portfolioAxisLabel")
    .text("hotness density");

  root.append("text")
    .attr("x", 0)
    .attr("y", -8)
    .attr("class", "portfolioAxisLabel")
    .text("CC density");

  const nodes = root.selectAll(".portfolioRiskNode")
    .data(plottedApps)
    .enter()
    .append("g")
    .attr("class", "portfolioRiskNode")
    .attr("transform", (app) => `translate(${x(app.latestHotness)},${y(app.latestCc)})`);

  nodes.append("circle")
    .attr("r", (app) => r(app.latestCodeLines))
    .attr("class", (app) => `portfolioRiskBubble tone-${app.criticality?.tone || "stable"}`);

  nodes.append("text")
    .attr("y", (app) => r(app.latestCodeLines) + 14)
    .attr("text-anchor", "middle")
    .attr("class", "portfolioRiskLabel")
    .text((app) => app.appId);
}

function ensurePortfolioInteractionsBound(root) {
  if (root.__portfolioInteractionsBound) return;
  Object.defineProperty(root, "__portfolioInteractionsBound", { value: true });

  root.addEventListener("click", (event) => {
    const target = event?.target?.closest?.("[data-portfolio-action], [data-action='create-review-note'], [data-portfolio-toggle-details]");
    if (!target || !root.contains(target)) return;

    if (target.dataset.portfolioToggleDetails === "true") {
      toggleProjectDetails(root, String(target.dataset.appId || ""));
      return;
    }

    if (target.dataset.action === "create-review-note") {
      createReviewNote(target);
      return;
    }

    dispatchPortfolioAppAction({
      action: String(target.dataset.portfolioAction || ""),
      appId: String(target.dataset.appId || ""),
      url: String(target.dataset.url || "")
    });
  });
}

function dispatchPortfolioAppAction(detail) {
  document.dispatchEvent(new CustomEvent(PORTFOLIO_APP_ACTION_EVENT, { detail }));
}

function createReviewNote(button) {
  const appId = String(button?.dataset?.appId || "");
  const moduleName = String(button?.dataset?.module || "");
  const hotness = Number(button?.dataset?.hotness || 0);
  const ccDensity = Number(button?.dataset?.ccDensity || 0);
  const cc = Number(button?.dataset?.cc || 0);
  const codeLines = Number(button?.dataset?.codeLines || 0);
  const noteText = buildReviewNoteText({ appId, moduleName, hotness, ccDensity, cc, codeLines });
  const filename = buildReviewNoteFilename(appId, moduleName);

  downloadTextFile(filename, noteText);
  flashReviewNoteButton(button);
}

function buildReviewNoteText({ appId, moduleName, hotness, ccDensity, cc, codeLines }) {
  return [
    `# Review note: ${moduleName}`,
    "",
    `- App: ${appId}`,
    `- Module: ${moduleName}`,
    `- Hotness: ${formatMetricValue(hotness)}`,
    `- CC density: ${formatMetricValue(ccDensity)}`,
    `- CC: ${cc}`,
    `- Code lines: ${codeLines}`,
    `- Created: ${new Date().toISOString()}`,
    "",
    "## Why review now",
    "- High portfolio review priority based on hotspot, CC density and size.",
    "",
    "## Findings",
    "-",
    "",
    "## Refactor ideas",
    "-",
    "",
    "## Risks / tests",
    "-"
  ].join("\n");
}

function buildReviewNoteFilename(appId, moduleName) {
  return `${noteFilenameToken(appId)}-${noteFilenameToken(moduleName)}-review-note.md`;
}

function noteFilenameToken(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "note";
}

function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function flashReviewNoteButton(button) {
  if (!button) return;

  const originalText = button.textContent;
  button.textContent = "created";
  button.disabled = true;

  window.setTimeout(() => {
    button.textContent = originalText;
    button.disabled = false;
  }, 1400);
}

function scaleLinear(value, min, max, outMin, outMax) {
  if (!Number.isFinite(value)) return outMin;
  if (max <= min) return (outMin + outMax) / 2;
  const ratio = (value - min) / (max - min);
  return outMin + ratio * (outMax - outMin);
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function formatMetricValue(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "n/a";
  if (Math.abs(numeric) >= 1000) {
    return `${(numeric / 1000).toFixed(1)}k`;
  }
  if (Math.abs(numeric) >= 10) {
    return numeric.toFixed(1);
  }
  return numeric.toFixed(2);
}

function formatTimestamp(value) {
  const date = new Date(String(value || ""));
  if (!Number.isFinite(date.getTime())) return "n/a";
  return date.toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])
  );
}

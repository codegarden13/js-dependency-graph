"use strict";

import { getSelectedAppId } from "./uiState.js";
import { rewriteReadmeAssetLinks } from "./readmeLinks.js";

const SCORE_WEIGHTS = Object.freeze({
  hotness: 0.45,
  cc: 0.35,
  volatility: 0.20
});
const PORTFOLIO_SORT_OPTIONS = Object.freeze({
  codeLines: {
    label: "Code lines",
    readValue: (app) => Number(app?.latestCodeLines || 0)
  },
  commentLines: {
    label: "Comment lines",
    readValue: (app) => Number(app?.latestCommentLines || 0)
  },
  hotness: {
    label: "Hotness",
    readValue: (app) => Number(app?.latestHotness || 0)
  },
  cc: {
    label: "CC",
    readValue: (app) => Number(app?.latestCc || 0)
  },
  lastChange: {
    label: "Last change",
    readValue: (app) => Number(app?.latestLastTouchedEpoch || 0)
  }
});
const DEFAULT_PORTFOLIO_SORT_KEY = "criticality";
const DEFAULT_PORTFOLIO_SORT_DIRECTION = "desc";
const PORTFOLIO_APP_ACTION_EVENT = "nodeanalyzer:portfolio-app-action";
const PROJECT_REVIEW_LIMIT = 6;
let latestPortfolioState = null;
const screenshotStatusByAppId = new Map();
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

export function setPortfolioScreenshotStatus(elementId, appId, status = null) {
  const root = document.getElementById(String(elementId || ""));
  const safeAppId = String(appId || "").trim();
  if (!safeAppId) return false;

  if (status) {
    screenshotStatusByAppId.set(safeAppId, {
      state: String(status?.state || "idle"),
      label: String(status?.label || "").trim(),
      title: String(status?.title || "").trim()
    });
  } else {
    screenshotStatusByAppId.delete(safeAppId);
  }

  if (!root || !latestPortfolioState?.apps?.length) return false;

  const nextState = {
    ...latestPortfolioState,
    apps: latestPortfolioState.apps.map((app) =>
      String(app?.appId || "").trim() === safeAppId
        ? { ...app, screenshotStatus: status ? screenshotStatusByAppId.get(safeAppId) || null : null }
        : app
    )
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
  const sortKey = normalizePortfolioSortKey(latestPortfolioState?.sortKey);
  const sortDirection = normalizePortfolioSortDirection(latestPortfolioState?.sortDirection);
  const apps = sortPortfolioApps(
    decoratedApps.map((app) => attachCriticality(app, maxima)),
    sortKey,
    sortDirection
  );

  return {
    generatedAt: String(payload?.generatedAt || ""),
    apps,
    selectedAppId: readSelectedAppId(),
    sortKey,
    sortDirection,
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
  const latestCommentLines = Number(latest?.commentLinesTotal || 0) || 0;
  const latestHotness = Number(latest?.hotnessDensity ?? latest?.hotnessTotal ?? 0) || 0;
  const latestCc = Number(latest?.ccDensity ?? latest?.ccTotal ?? 0) || 0;
  const latestLastTouchedEpoch = readTimestampValue(latest?.lastTouchedEpoch ?? latest?.lastTouchedAt);

  return {
    ...app,
    latest,
    latestCodeLines,
    latestCommentLines,
    latestHotness,
    latestCc,
    latestLastTouchedEpoch,
    screenshotStatus: screenshotStatusByAppId.get(String(app?.appId || "").trim()) || null,
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

function normalizePortfolioSortKey(sortKey) {
  const safeKey = String(sortKey || "").trim();
  if (!safeKey) return DEFAULT_PORTFOLIO_SORT_KEY;
  if (safeKey === DEFAULT_PORTFOLIO_SORT_KEY) return safeKey;
  return Object.prototype.hasOwnProperty.call(PORTFOLIO_SORT_OPTIONS, safeKey)
    ? safeKey
    : DEFAULT_PORTFOLIO_SORT_KEY;
}

function normalizePortfolioSortDirection(direction) {
  return String(direction || "").trim().toLowerCase() === "asc"
    ? "asc"
    : DEFAULT_PORTFOLIO_SORT_DIRECTION;
}

function compareNumbers(leftValue, rightValue, direction) {
  const left = Number(leftValue || 0);
  const right = Number(rightValue || 0);
  if (left === right) return 0;
  const factor = direction === "asc" ? 1 : -1;
  return left > right ? factor : -factor;
}

function compareNames(leftApp, rightApp) {
  const left = String(leftApp?.name || leftApp?.appId || "");
  const right = String(rightApp?.name || rightApp?.appId || "");
  return left.localeCompare(right);
}

function readPortfolioSortValue(app, sortKey) {
  if (sortKey === DEFAULT_PORTFOLIO_SORT_KEY) {
    return Number(app?.criticality?.score || 0);
  }

  return PORTFOLIO_SORT_OPTIONS[sortKey]?.readValue(app) ?? 0;
}

function sortPortfolioApps(apps, sortKey, sortDirection) {
  const safeSortKey = normalizePortfolioSortKey(sortKey);
  const safeDirection = normalizePortfolioSortDirection(sortDirection);

  return [...(apps || [])].sort((leftApp, rightApp) => {
    const primary = compareNumbers(
      readPortfolioSortValue(leftApp, safeSortKey),
      readPortfolioSortValue(rightApp, safeSortKey),
      safeDirection
    );
    if (primary) return primary;

    const fallback = compareNumbers(
      Number(leftApp?.criticality?.score || 0),
      Number(rightApp?.criticality?.score || 0),
      "desc"
    );
    if (fallback) return fallback;

    return compareNames(leftApp, rightApp);
  });
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

function renderPortfolioSortBar(root, state) {
  const container = root.querySelector("[data-role='portfolio-sort-bar']");
  if (!container) return false;
  container.innerHTML = buildPortfolioSortMarkup(state);
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

      <section class="portfolioSortBar" data-role="portfolio-sort-bar">
        ${buildPortfolioSortMarkup(state)}
      </section>

      <section class="portfolioProjectsList"></section>
    </div>
  `;
}

function buildProjectRowsMarkup(state) {
  return (state.apps || [])
    .map((app) => buildProjectRowMarkup(app, state.selectedAppId))
    .join("");
}

function buildPortfolioSortMarkup(state) {
  return `
    <div class="portfolioSortMeta">
      <div class="small fw-semibold">Sort apps by latest value</div>
      <div class="small text-secondary">Current: ${escapeHtml(currentPortfolioSortLabel(state))}</div>
    </div>
    <div class="portfolioSortButtons" role="group" aria-label="Sort portfolio apps">
      ${Object.entries(PORTFOLIO_SORT_OPTIONS).map(([sortKey, option]) => buildPortfolioSortButtonMarkup(sortKey, option, state)).join("")}
    </div>
  `;
}

function currentPortfolioSortLabel(state) {
  const sortKey = normalizePortfolioSortKey(state?.sortKey);
  const sortDirection = normalizePortfolioSortDirection(state?.sortDirection);
  if (sortKey === DEFAULT_PORTFOLIO_SORT_KEY) return "Criticality";

  const label = PORTFOLIO_SORT_OPTIONS[sortKey]?.label || "Criticality";
  return `${label} ${sortDirection === "asc" ? "↑" : "↓"}`;
}

function buildPortfolioSortButtonMarkup(sortKey, option, state) {
  const isActive = normalizePortfolioSortKey(state?.sortKey) === sortKey;
  const direction = normalizePortfolioSortDirection(state?.sortDirection);
  const directionMarker = isActive ? ` ${direction === "asc" ? "↑" : "↓"}` : "";

  return `
    <button
      type="button"
      class="btn btn-sm ${isActive ? "btn-primary" : "btn-outline-secondary"} portfolioSortButton"
      data-portfolio-sort="${escapeHtml(sortKey)}"
      aria-pressed="${isActive ? "true" : "false"}"
    >
      ${escapeHtml(option.label)}${directionMarker}
    </button>
  `;
}

function applyPortfolioSort(root, sortKey) {
  if (!latestPortfolioState?.apps?.length) return;

  const safeSortKey = normalizePortfolioSortKey(sortKey);
  const currentSortKey = normalizePortfolioSortKey(latestPortfolioState.sortKey);
  const currentDirection = normalizePortfolioSortDirection(latestPortfolioState.sortDirection);
  const nextDirection = currentSortKey === safeSortKey && currentDirection === "desc"
    ? "asc"
    : "desc";

  const nextState = {
    ...latestPortfolioState,
    sortKey: safeSortKey,
    sortDirection: nextDirection,
    apps: sortPortfolioApps(latestPortfolioState.apps, safeSortKey, nextDirection)
  };

  latestPortfolioState = nextState;
  renderPortfolioSortBar(root, nextState);
  renderPortfolioProjectList(root, nextState);
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
  const toggleAttrs = [
    `data-portfolio-toggle-details="true"`,
    `data-app-id="${escapeHtml(app.appId)}"`,
    `aria-expanded="${isActiveApp ? "true" : "false"}"`,
    `aria-controls="${escapeHtml(detailsId)}"`
  ].join(" ");

  return `
    <article class="portfolioProjectCard tone-${app.criticality?.tone || "stable"}${isActiveApp ? " is-active-app" : ""}">
      <div class="portfolioProjectShell">
        <div class="portfolioProjectTopRow">
          <button
            type="button"
            class="portfolioProjectToggle portfolioProjectToggleHeader"
            ${toggleAttrs}
          >
            ${buildProjectToggleContentMarkup(app)}
          </button>

          <div class="portfolioProjectToolbar">
            ${buildProjectScoreMarkup(app)}
            <div class="portfolioProjectActions" aria-label="Project actions">
              ${buildProjectActionButtonsMarkup(app)}
            </div>
          </div>
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
    <div class="portfolioProjectToggleMeta">
      ${buildProjectHeaderMetaMarkup(app)}
    </div>
    <div class="portfolioProjectMetricsRail">
      <div class="portfolioMetricGrid portfolioMetricGridInteractive">
        ${buildProjectMetricTilesMarkup(app)}
      </div>
    </div>
  `;
}

function buildProjectHeaderMetaMarkup(app) {
  const latest = app.latest || {};

  return `
    <div class="portfolioProjectHeader">
      <div class="portfolioProjectNameRow">
        <div class="portfolioProjectName">${escapeHtml(app.name || app.appId)}</div>
        ${buildProjectAvailabilityMarkup(app)}
      </div>
      <div class="small text-secondary">
        ${escapeHtml(app.appId)} · ${app.runCount} runs · latest ${formatTimestamp(latest.timestamp)}
      </div>
    </div>
  `;
}

function buildProjectAvailabilityMarkup(app) {
  const isReachable = app?.availability?.reachable === true || String(app?.availability?.state || "") === "online";
  const tone = isReachable ? "online" : "offline";
  const label = String(app?.availability?.label || (isReachable ? "reachable" : "offline"));

  return `
    <span class="portfolioAppStatus is-${escapeHtml(tone)}">
      <span class="portfolioAppStatusDot" aria-hidden="true"></span>
      <span class="portfolioAppStatusLabel">${escapeHtml(label)}</span>
    </span>
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
  const metricTiles = [
    {
      label: "Code lines",
      value: latest.codeLinesTotal ?? latest.locTotal,
      sparklineSvg: buildSparklineSvg(app.history, (run) => run?.codeLinesTotal ?? run?.locTotal, "code")
    },
    {
      label: "Comment lines",
      value: latest.commentLinesTotal,
      sparklineSvg: buildSparklineSvg(app.history, (run) => run?.commentLinesTotal, "comment"),
      note: coverageLabel(latest.commentCoverage)
    },
    {
      label: "Hotness",
      value: latest.hotnessDensity ?? latest.hotnessTotal,
      sparklineSvg: buildSparklineSvg(app.history, (run) => run?.hotnessDensity ?? run?.hotnessTotal, "hotness"),
      note: coverageLabel(latest.hotnessCoverage)
    },
    {
      label: "CC",
      value: latest.ccDensity ?? latest.ccTotal,
      sparklineSvg: buildSparklineSvg(app.history, (run) => run?.ccDensity ?? run?.ccTotal, "cc"),
      note: coverageLabel(latest.ccCoverage)
    },
    {
      label: "Last change",
      value: latest.lastTouchedEpoch ?? latest.lastTouchedAt,
      displayValue: formatTimestamp(latest.lastTouchedAt || latest.lastTouchedEpoch),
      sparklineSvg: buildSparklineSvg(
        app.history,
        (run) => run?.lastTouchedEpoch ?? run?.lastTouchedAt,
        "change"
      )
    }
  ];

  return metricTiles.map((tile) => buildMetricTile(tile)).join("");
}

function buildProjectActionButtonsMarkup(app) {
  const restartLabel = app?.availability?.reachable ? "Restart" : "Start";
  const screenshotButton = buildScreenshotsButtonMarkup(app);

  return `
    <button
      type="button"
      class="btn btn-sm btn-outline-secondary"
      data-portfolio-action="restart"
      data-app-id="${escapeHtml(app.appId)}"
    >
      ${escapeHtml(restartLabel)}
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
    ${screenshotButton}
  `;
}

function buildScreenshotsButtonMarkup(app) {
  const status = app?.screenshotStatus || null;
  const state = String(status?.state || "").trim();
  const label = status?.label || "Create screenshots";
  const title = status?.title || label;
  const disabledAttr = state === "running" ? "disabled" : "";

  return `
    <button
      type="button"
      class="btn btn-sm btn-outline-primary"
      data-portfolio-action="screenshots"
      data-app-id="${escapeHtml(app.appId)}"
      title="${escapeHtml(title)}"
      ${disabledAttr}
    >
      ${escapeHtml(label)}
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
      <div class="portfolioProjectDetailsGrid">
        ${buildProjectReviewQueueMarkup(app)}
        ${buildProjectReadmeMarkup(app)}
      </div>
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

function buildMetricTile({ label, value, sparklineSvg, note = "", displayValue = "" }) {
  const renderedValue = String(displayValue || "").trim() || formatMetricValue(value);

  return `
    <section class="portfolioMetricTile">
      <div class="portfolioMetricHeader">
        <span class="small fw-semibold">${escapeHtml(label)}</span>
        <span class="small text-secondary">${escapeHtml(renderedValue)}</span>
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
  const linkedHtml = rewriteReadmeAssetLinks(safeHtml, appId, entry.readmePath || "");

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
    const value = readTimestampValue(readValue(run));
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
    const target = event?.target?.closest?.("[data-portfolio-action], [data-action='create-review-note'], [data-portfolio-toggle-details], [data-portfolio-sort]");
    if (!target || !root.contains(target)) return;

    if (target.dataset.portfolioSort) {
      applyPortfolioSort(root, String(target.dataset.portfolioSort || ""));
      return;
    }

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

function readTimestampValue(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : NaN;
  }

  const text = String(value || "").trim();
  if (!text) return NaN;

  const numeric = Number(text);
  if (Number.isFinite(numeric)) return numeric;

  const epoch = new Date(text).getTime();
  return Number.isFinite(epoch) ? epoch : NaN;
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
  const epoch = readTimestampValue(value);
  if (!Number.isFinite(epoch)) return "n/a";

  const date = new Date(epoch);
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

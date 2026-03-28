"use strict";

const SCORE_WEIGHTS = Object.freeze({
  hotness: 0.45,
  cc: 0.35,
  volatility: 0.20
});
const REVIEW_QUEUE_WEIGHTS = Object.freeze({
  hotness: 0.5,
  ccDensity: 0.3,
  codeLines: 0.2
});
const REVIEW_QUEUE_LIMIT = 18;

export async function renderAllProjectsView(elementId) {
  const root = document.getElementById(String(elementId || ""));
  if (!root) return;

  root.innerHTML = `<div class="text-secondary small">Loading portfolio view…</div>`;

  const payload = await fetchJson("/api/projects-overview");
  const state = decoratePortfolioPayload(payload);
  renderPortfolioView(root, state);
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
    reviewQueue: buildReviewQueue(apps),
    totalRuns: apps.reduce((sum, app) => sum + Number(app?.runCount || 0), 0)
  };
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

function buildReviewQueue(apps) {
  const modules = (apps || [])
    .flatMap((app) => Array.isArray(app?.latestModules) ? app.latestModules : []);
  const maxima = collectReviewQueueMaxima(modules);

  return modules
    .map((module) => attachReviewQueuePriority(module, maxima))
    .sort(compareReviewQueueItems)
    .slice(0, REVIEW_QUEUE_LIMIT);
}

function collectReviewQueueMaxima(modules) {
  return {
    hotness: maxMetric(modules, (module) => module.hotness),
    ccDensity: maxMetric(modules, (module) => module.ccDensity),
    codeLines: maxMetric(modules, (module) => module.codeLines)
  };
}

function attachReviewQueuePriority(module, maxima) {
  const hotnessNorm = normalizeMetric(module?.hotness, maxima.hotness);
  const ccDensityNorm = normalizeMetric(module?.ccDensity, maxima.ccDensity);
  const codeLinesNorm = normalizeMetric(module?.codeLines, maxima.codeLines);
  const priority =
    hotnessNorm * REVIEW_QUEUE_WEIGHTS.hotness +
    ccDensityNorm * REVIEW_QUEUE_WEIGHTS.ccDensity +
    codeLinesNorm * REVIEW_QUEUE_WEIGHTS.codeLines;

  return {
    ...module,
    priority,
    priorityPct: Math.round(priority * 100)
  };
}

function compareReviewQueueItems(a, b) {
  return (
    (Number(b?.priority) || 0) - (Number(a?.priority) || 0) ||
    (Number(b?.hotness) || 0) - (Number(a?.hotness) || 0) ||
    (Number(b?.ccDensity) || 0) - (Number(a?.ccDensity) || 0) ||
    (Number(b?.codeLines) || 0) - (Number(a?.codeLines) || 0) ||
    String(a?.module || "").localeCompare(String(b?.module || ""))
  );
}

function renderPortfolioView(root, state) {
  if (!state.apps.length) {
    root.innerHTML = `<div class="text-secondary small">No project history available yet.</div>`;
    return;
  }

  root.innerHTML = buildPortfolioMarkup(state);
  bindReviewNoteButtons(root);

  const riskMapSvg = root.querySelector("[data-role='portfolio-risk-map']");
  if (riskMapSvg) renderRiskMap(riskMapSvg, state.apps);
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
          <svg class="portfolioRiskMap" data-role="portfolio-risk-map" viewBox="0 0 920 320" preserveAspectRatio="xMidYMid meet"></svg>
        </section>
      </div>

      ${buildReviewQueueMarkup(state.reviewQueue)}

      <section class="portfolioProjectsList">
        ${state.apps.map(buildProjectRowMarkup).join("")}
      </section>
    </div>
  `;
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

function buildReviewQueueMarkup(reviewQueue) {
  if (!Array.isArray(reviewQueue) || !reviewQueue.length) {
    return `
      <section class="portfolioCard">
        <div class="text-secondary small">No module-level review queue available yet.</div>
      </section>
    `;
  }

  return `
    <section class="portfolioCard portfolioReviewQueue">
      <div class="portfolioReviewQueueHeader">
        <div class="small fw-semibold">Next files to revise</div>
        <div class="small text-secondary">Sorted globally by hotspot, CC density and size.</div>
      </div>
      <div class="table-responsive portfolioReviewTableWrap">
        <table class="table table-sm portfolioReviewTable align-middle">
          <thead>
            <tr>
              <th scope="col">App</th>
              <th scope="col">Module</th>
              <th scope="col">Hotness</th>
              <th scope="col">CC density</th>
              <th scope="col">CC</th>
              <th scope="col">Code lines</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            ${reviewQueue.map(buildReviewQueueRow).join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function buildReviewQueueRow(item) {
  const appId = String(item?.appId || "");
  const moduleName = String(item?.module || "");
  const hotness = Number(item?.hotness || 0);
  const ccDensity = Number(item?.ccDensity || 0);
  const cc = Number(item?.cc || 0);
  const codeLines = Number(item?.codeLines || 0);

  return `
    <tr>
      <td class="portfolioReviewApp">${escapeHtml(appId)}</td>
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

function buildProjectRowMarkup(app) {
  const latest = app.latest || {};
  const score = app.criticality?.scorePct ?? 0;

  return `
    <article class="portfolioProjectCard tone-${app.criticality?.tone || "stable"}">
      <div class="portfolioProjectHeader">
        <div>
          <div class="portfolioProjectName">${escapeHtml(app.name || app.appId)}</div>
          <div class="small text-secondary">
            ${escapeHtml(app.appId)} · ${app.runCount} runs · latest ${formatTimestamp(latest.timestamp)}
          </div>
        </div>
        <div class="portfolioProjectScore">
          <span class="portfolioScoreBadge">${score}</span>
          <span class="small text-secondary">criticality</span>
        </div>
      </div>

      <div class="portfolioMetricGrid">
        ${buildMetricTile("Code lines", latest.codeLinesTotal ?? latest.locTotal, buildSparklineSvg(app.history, (run) => run?.codeLinesTotal ?? run?.locTotal, "code"))}
        ${buildMetricTile("Comment lines", latest.commentLinesTotal, buildSparklineSvg(app.history, (run) => run?.commentLinesTotal, "comment"), coverageLabel(latest.commentCoverage))}
        ${buildMetricTile("Hotness", latest.hotnessDensity ?? latest.hotnessTotal, buildSparklineSvg(app.history, (run) => run?.hotnessDensity ?? run?.hotnessTotal, "hotness"), coverageLabel(latest.hotnessCoverage))}
        ${buildMetricTile("CC", latest.ccDensity ?? latest.ccTotal, buildSparklineSvg(app.history, (run) => run?.ccDensity ?? run?.ccTotal, "cc"), coverageLabel(latest.ccCoverage))}
      </div>
    </article>
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

function bindReviewNoteButtons(root) {
  root.querySelectorAll("[data-action='create-review-note']").forEach((button) => {
    button.addEventListener("click", () => createReviewNote(button));
  });
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

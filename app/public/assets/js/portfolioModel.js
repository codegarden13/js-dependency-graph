"use strict";

import { readTimestampValue } from "./browserShared.js";

const SCORE_WEIGHTS = Object.freeze({
  hotness: 0.45,
  cc: 0.35,
  volatility: 0.20
});

export const PORTFOLIO_SORT_OPTIONS = Object.freeze({
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
    label: "Last Git change",
    readValue: (app) => Number(app?.latestLastTouchedEpoch || 0)
  }
});

export const DEFAULT_PORTFOLIO_SORT_KEY = "criticality";
export const DEFAULT_PORTFOLIO_SORT_DIRECTION = "desc";

export function decoratePortfolioPayload(payload, {
  currentState = null,
  screenshotStatusByAppId = new Map(),
  selectedAppId = ""
} = {}) {
  const baseApps = Array.isArray(payload?.apps) ? payload.apps : [];
  const decoratedApps = baseApps.map((app) => decorateAppMetrics(app, screenshotStatusByAppId));
  const maxima = collectPortfolioMaxima(decoratedApps);
  const sortKey = normalizePortfolioSortKey(currentState?.sortKey);
  const sortDirection = normalizePortfolioSortDirection(currentState?.sortDirection);
  const apps = sortPortfolioApps(
    decoratedApps.map((app) => attachCriticality(app, maxima)),
    sortKey,
    sortDirection
  );

  return {
    generatedAt: String(payload?.generatedAt || ""),
    apps,
    selectedAppId: String(selectedAppId || "").trim(),
    sortKey,
    sortDirection,
    totalRuns: apps.reduce((sum, app) => sum + Number(app?.runCount || 0), 0)
  };
}

export function normalizePortfolioSortKey(sortKey) {
  const safeKey = String(sortKey || "").trim();
  if (!safeKey) return DEFAULT_PORTFOLIO_SORT_KEY;
  if (safeKey === DEFAULT_PORTFOLIO_SORT_KEY) return safeKey;
  return Object.prototype.hasOwnProperty.call(PORTFOLIO_SORT_OPTIONS, safeKey)
    ? safeKey
    : DEFAULT_PORTFOLIO_SORT_KEY;
}

export function normalizePortfolioSortDirection(direction) {
  return String(direction || "").trim().toLowerCase() === "asc"
    ? "asc"
    : DEFAULT_PORTFOLIO_SORT_DIRECTION;
}

export function sortPortfolioApps(apps, sortKey, sortDirection) {
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

export function compactSeries(history, readValue) {
  const values = [];

  for (const run of history || []) {
    const value = Number(readValue(run));
    if (!Number.isFinite(value)) continue;
    values.push(value);
  }

  return values;
}

export function isPortfolioAppOnline(app) {
  return app?.availability?.reachable === true || String(app?.availability?.state || "") === "online";
}

function decorateAppMetrics(app, screenshotStatusByAppId) {
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

function computeRelativeVolatility(history, readValue) {
  const series = compactSeries(history, readValue);
  if (series.length < 2) return 0;

  let totalDelta = 0;
  for (let index = 1; index < series.length; index += 1) {
    totalDelta += Math.abs(series[index] - series[index - 1]);
  }

  const latest = series[series.length - 1] || 0;
  return totalDelta / Math.max(series.length - 1, 1) / Math.max(latest, 1);
}

function computeLatestDelta(history, readValue) {
  const series = compactSeries(history, readValue);
  if (series.length < 2) return 0;
  return series[series.length - 1] - series[series.length - 2];
}

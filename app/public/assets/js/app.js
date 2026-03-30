/* public/assets/js/app.js (ESM)
 * ============================================================================
 * NodeAnalyzer UI bootstrap / page controller
 * ============================================================================
 *
 * This module wires the browser UI together. It does not parse code itself;
 * instead it orchestrates the backend + graph renderer:
 *
 * - loads configured apps from `/apps`
 * - stores the current selection in a shared UI state module
 * - lets the user explicitly trigger `/analyze` or `/freeze` for the selected app
 * - fetches the produced metrics JSON
 * - renders the main D3 graph via `initcodeStructureChart(...)`
 * - keeps workspace views in sync with graph selection and app state
 * - listens to SSE live events from `/events`
 * - forwards fs-change events into the active graph instance
 *
 * Design notes
 * ------------
 * - No window namespace bridge is used for the main graph callback.
 * - The selected app lives in a tiny shared state module so multiple views can
 *   reuse it without hidden DOM adapters.
 * - The graph renderer is treated like a controller object that can be replaced
 *   after each analyze run.
 *
 * Expected DOM
 * ------------
 * - #status
 * - #appViewPanel
 * - #appOverviewPanel
 * - #appGitPanel
 * - #appFreezePanel
 * - #codeStructureSvg
 */

"use strict";

import { initcodeStructureChart } from "./d3_codeStructure.js";
import { rewriteReadmeAssetLinks } from "./readmeLinks.js";
import {
  getApps,
  getSelectedAppId as getSelectedAppIdState,
  hasApp,
  setApps,
  setSelectedAppId as setSelectedAppIdState,
} from "./uiState.js";
import {
  buildVersionedUrl,
  escapeHtml as esc,
  fetchJson,
  formatBytes,
  formatInteger,
  formatIsoDate,
  markdownToHtml,
  sanitizeHtml,
  toDisplayText
} from "./browserShared.js";




// App-local state (no window globals)

// Currently selected graph node.
//
// Source of truth for the graph-detail state. The value is updated from the graph
// renderer callback (`onNodeSelected`) and occasionally refreshed from the
// latest rendered node instance after SSE updates.
let selectedNode = null;

// Active graph controller returned by `initcodeStructureChart(...)`.
//
// We keep the controller so the app module can:
// - destroy the previous graph before a rerender
// - mark changed nodes from SSE (`markChanged`)
// - read the latest rendered nodes for panel refreshes
let graphController = null;
let graphMriController = null;
let graphTimeController = null;
let activeGraphAppId = "";
let appInfoLoadToken = 0;
let freezeInFlight = false;
let screenshotsInFlight = false;
let screenshotJobPollTimer = 0;
let activeScreenshotJobId = "";
let activeScreenshotAppId = "";
let graphZoomUiBound = false;
let graphZoomTabsBound = false;
let latestCsvLoadToken = 0;
let latestStoredGraphLoadToken = 0;
let allProjectsLoadToken = 0;
let appViewScreenshotsLoadToken = 0;
let crossViewEventsBound = false;
let graphZoomScale = 1;

const SHELL_TITLE_BASE = "NodeAnalyzer";
const PORTFOLIO_APP_ACTION_EVENT = "nodeanalyzer:portfolio-app-action";
const ACTIVE_APP_CHANGED_EVENT = "nodeanalyzer:active-app-changed";
const APP_VIEW_PANEL_ID = "appViewPanel";
const APP_INFO_PANEL_IDS = Object.freeze({
  overview: "appOverviewPanel",
  git: "appGitPanel",
  freeze: "appFreezePanel"
});
const APP_GIT_HISTORY_CHART_ID = "graphGitHistorySvg";
const GRAPH_GIT_HISTORY_META_ID = "graphGitHistoryMeta";
const GRAPH_GIT_HISTORY_EMPTY_ID = "graphGitHistoryEmpty";

/* ======================================================================= */
/* DOM helpers                                                              */
/* ======================================================================= */

/** Get exactly one element by id; warns if duplicates exist. */
function byId(id) {
  const list = document.querySelectorAll("#" + id);
  if (list.length !== 1) {
    console.warn(`Expected exactly 1 #${id}, found ${list.length}`, list);
  }
  return /** @type {HTMLElement|null} */ (list[0] || null);
}

function maybeById(id) {
  return /** @type {HTMLElement|null} */ (document.getElementById(String(id || "")));
}

function normId(v) {
  return String(v || "");
}

function isSameId(a, b) {
  return normId(a) === normId(b);
}

function isSelectedNodeMessage(msg) {
  return isSameId(selectedNode?.id, msg?.id);
}

function setStatus(text) {
  const els = document.querySelectorAll("#status");

  els.forEach((el) => {
    try {
      el.textContent = text || "";
    } catch { }
  });
}

function buildShellTitle(appId = "") {
  const id = String(appId || "").trim();
  return id ? `${SHELL_TITLE_BASE} - /${id}/` : SHELL_TITLE_BASE;
}

function updateShellTitle(appId = "") {
  const title = buildShellTitle(appId);
  setTextById("shellTitle", title);

  try {
    document.title = title;
  } catch { }
}

function buildLatestCsvLabel(filename = "") {
  const safe = String(filename || "").trim();
  return safe ? `Latest CSV: ${safe}` : "Latest CSV: —";
}

function setLatestCsvName(filename = "") {
  const label = buildLatestCsvLabel(filename);
  const el = byId("latestCsvName");
  if (!el) return;

  el.textContent = label;
  el.setAttribute("title", label);
}

function emitActiveAppChanged(appId = "") {
  document.dispatchEvent(new CustomEvent(ACTIVE_APP_CHANGED_EVENT, {
    detail: { appId: String(appId || "").trim() }
  }));
}

function normalizeStatusSignalState(state = "neutral") {
  const safe = String(state || "").trim().toLowerCase();
  if (safe === "changed" || safe === "unchanged" || safe === "error") return safe;
  return "neutral";
}

function statusSignalTitle(state) {
  switch (normalizeStatusSignalState(state)) {
    case "changed":
      return "Analysis changed the CSV output";
    case "unchanged":
      return "Analysis produced no CSV change";
    case "error":
      return "Last action failed";
    default:
      return "No analysis state yet";
  }
}

function setStatusSignal(state = "neutral") {
  const el = byId("statusSignal");
  if (!el) return;

  const safe = normalizeStatusSignalState(state);
  el.className = `statusSignal is-${safe}`;
  el.setAttribute("title", statusSignalTitle(safe));
}

function clearAnalyzeStatusUi() {
  setStatus("");
  setStatusSignal("neutral");
}

function clearScreenshotJobPollTimer() {
  if (!screenshotJobPollTimer) return;
  window.clearTimeout(screenshotJobPollTimer);
  screenshotJobPollTimer = 0;
}

function latestFilenameFromOutputFiles(files) {
  const list = Array.isArray(files) ? files : [];
  return String(list[list.length - 1] || "").trim();
}

async function fetchLatestOutputFilename(appId, { type = "code-metrics", ext = "csv" } = {}) {
  const id = encodeURIComponent(String(appId || ""));
  const kind = encodeURIComponent(String(type || "code-metrics"));
  const suffix = encodeURIComponent(String(ext || "csv"));
  const files = await fetchJson(`/api/output-files?appId=${id}&type=${kind}&ext=${suffix}`);
  return latestFilenameFromOutputFiles(files);
}

async function fetchLatestCsvFilename(appId) {
  return fetchLatestOutputFilename(appId, { type: "code-metrics", ext: "csv" });
}

async function fetchLatestMetricsFilename(appId) {
  return fetchLatestOutputFilename(appId, { type: "code-metrics", ext: "json" });
}

function buildOutputFileUrl(filename = "") {
  const safe = String(filename || "").trim();
  return safe ? `/output/${encodeURIComponent(safe)}` : "";
}

async function loadLatestCsvForApp(appId) {
  const safeAppId = String(appId || "").trim();
  const requestToken = ++latestCsvLoadToken;

  if (!safeAppId) {
    setLatestCsvName("");
    return "";
  }

  try {
    const latestFilename = await fetchLatestCsvFilename(safeAppId);
    if (requestToken !== latestCsvLoadToken) return "";

    setLatestCsvName(latestFilename);
    return latestFilename;
  } catch (e) {
    if (requestToken !== latestCsvLoadToken) return "";

    console.warn("Latest CSV lookup failed:", e);
    setLatestCsvName("");
    return "";
  }
}

function findConfiguredApp(appId) {
  const safeAppId = String(appId || "").trim();
  if (!safeAppId) return null;
  return getApps().find((app) => String(app?.id || "").trim() === safeAppId) || null;
}

function buildAppViewEmptyMarkup(message) {
  return `<div class="workspaceAppFrameEmpty text-secondary small">${esc(message || "Select an app to preview it.")}</div>`;
}

function normalizePathname(pathname = "/") {
  const safe = String(pathname || "/").trim() || "/";
  return safe.length > 1 ? safe.replace(/\/+$/, "") : "/";
}

function normalizeUrlPort(url) {
  const explicitPort = Number(url?.port || 0);
  if (Number.isInteger(explicitPort) && explicitPort > 0) return String(explicitPort);
  return String(url?.protocol || "").toLowerCase() === "https:" ? "443" : "80";
}

function normalizeLoopbackHost(hostname = "") {
  const safeHost = String(hostname || "").trim().toLowerCase();
  if (safeHost === "localhost" || safeHost === "127.0.0.1" || safeHost === "::1" || safeHost === "[::1]") {
    return "loopback";
  }
  return safeHost;
}

function isEquivalentHost(currentUrl, targetUrl) {
  return normalizeLoopbackHost(currentUrl?.hostname) === normalizeLoopbackHost(targetUrl?.hostname);
}

function isAppViewActive() {
  const tab = byId("app-view-tab");
  return Boolean(tab?.classList.contains("active"));
}

function isSelfAppViewUrl(url) {
  const safeUrl = String(url || "").trim();
  if (!safeUrl) return false;

  try {
    const current = new URL(window.location.href);
    const target = new URL(safeUrl, current.href);

    return (
      String(target.protocol || "").toLowerCase() === String(current.protocol || "").toLowerCase() &&
      normalizeUrlPort(target) === normalizeUrlPort(current) &&
      isEquivalentHost(current, target) &&
      normalizePathname(target.pathname) === normalizePathname(current.pathname)
    );
  } catch {
    return false;
  }
}

function buildAppViewMarkup(app, { force = false } = {}) {
  const safeUrl = String(app?.url || "").trim();
  if (!safeUrl) {
    return buildAppViewEmptyMarkup("This app has no URL configured.");
  }

  if (isSelfAppViewUrl(safeUrl)) {
    return buildAppViewEmptyMarkup("NodeAnalyzer itself is not embedded recursively in App view.");
  }

  if (!force && !isAppViewActive()) {
    return buildAppViewEmptyMarkup("Open App view to load the selected app preview.");
  }

  return `
    <div class="workspaceAppFrameShell">
      <div class="workspaceAppFrameHeader">
        <div class="small fw-semibold">${esc(app?.name || app?.id || "App view")}</div>
        <a class="small" href="${esc(safeUrl)}" target="_blank" rel="noopener noreferrer">${esc(safeUrl)}</a>
      </div>
      <iframe
        class="workspaceAppFrame"
        src="${esc(safeUrl)}"
        title="${esc(app?.name || app?.id || "App view")}"
        loading="lazy"
        referrerpolicy="no-referrer"
      ></iframe>
      <section class="workspaceAppScreenshots" data-app-view-screenshots>
        <div class="workspaceAppScreenshotsEmpty text-secondary small">Loading screenshots...</div>
      </section>
    </div>
  `;
}

function syncAppViewPanel(appId, { force = false } = {}) {
  const root = byId(APP_VIEW_PANEL_ID);
  if (!root) return;

  const app = findConfiguredApp(appId);
  root.innerHTML = app
    ? buildAppViewMarkup(app, { force })
    : buildAppViewEmptyMarkup("Select an app to preview it.");

  loadAppViewScreenshots(appId, root).catch((error) => {
    console.warn("App view screenshots load failed:", error);
  });
}

async function loadLatestRenderedGraphForApp(appId) {
  const safeAppId = String(appId || "").trim();
  const requestToken = ++latestStoredGraphLoadToken;
  if (!safeAppId) return false;

  try {
    const latestMetricsFilename = await fetchLatestMetricsFilename(safeAppId);
    if (requestToken !== latestStoredGraphLoadToken) return false;
    if (!latestMetricsFilename) return false;

    const metricsUrl = buildOutputFileUrl(latestMetricsFilename);
    if (!metricsUrl) return false;

    const metrics = await fetchJson(metricsUrl);
    if (requestToken !== latestStoredGraphLoadToken) return false;
    if (getSelectedAppId() !== safeAppId) return false;

    activeGraphAppId = safeAppId;
    resetSupplementaryGraphViews();
    renderGraph(metrics);
    await renderSupplementaryCharts(metrics);
    updateGraphHeader(metrics);
    return true;
  } catch (e) {
    if (requestToken !== latestStoredGraphLoadToken) return false;
    console.warn("Stored graph load failed:", e);
    return false;
  }
}

function ensurePanelsExist() {
  return true;
}

function getGraphZoomSlider() {
  return /** @type {HTMLInputElement|null} */ (byId("graphZoomSlider"));
}

function getGraphViewTabs() {
  return Array.from(document.querySelectorAll("#workspaceTabs [data-bs-toggle='tab']"));
}

function getActiveGraphViewKey() {
  const activeTab = getGraphViewTabs().find((tab) => tab.classList.contains("active"));
  return String(activeTab?.dataset?.workspaceView || "graphs").trim() || "graphs";
}

function getActiveGraphViewLabel() {
  const activeTab = getGraphViewTabs().find((tab) => tab.classList.contains("active"));
  return String(activeTab?.textContent || "Graphs").trim();
}

function updateGraphZoomTargetLabel() {
  setTextById("graphZoomTarget", getActiveGraphViewLabel());
}

function getGraphZoomToolbar() {
  return byId("graphZoomToolbar");
}

function getGraphToolsAccordion() {
  return maybeById("graphToolsAccordion");
}

function viewSupportsZoom(viewKey = "graphs") {
  return viewKey === "graphs";
}

function viewSupportsGraphTools(viewKey = "graphs") {
  void viewKey;
  return false;
}

function syncWorkspaceChrome(viewKey = getActiveGraphViewKey()) {
  const zoomToolbar = getGraphZoomToolbar();
  const graphTools = getGraphToolsAccordion();

  if (zoomToolbar) {
    zoomToolbar.classList.toggle("d-none", !viewSupportsZoom(viewKey));
  }

  if (graphTools) {
    graphTools.classList.toggle("d-none", !viewSupportsGraphTools(viewKey));
  }

  updateWorkspaceHintForView(viewKey);
}

function getGraphZoomControllers() {
  return [graphController, graphMriController, graphTimeController]
    .filter((controller) => typeof controller?.setZoom === "function");
}

function normalizeGraphZoomScale(scale = 1) {
  const numericScale = Number(scale);
  if (!Number.isFinite(numericScale) || numericScale <= 0) return 1;
  return numericScale;
}

function applyGraphsZoom(scale = graphZoomScale) {
  const controllers = getGraphZoomControllers();
  let appliedScale = normalizeGraphZoomScale(scale);

  for (const controller of controllers) {
    try {
      const nextScale = controller.setZoom(appliedScale);
      if (Number.isFinite(nextScale) && nextScale > 0) {
        appliedScale = nextScale;
      }
    } catch { }
  }

  graphZoomScale = appliedScale;
  return appliedScale;
}

function getGraphZoomPercent(scale) {
  const numericScale = Number(scale);
  if (!Number.isFinite(numericScale) || numericScale <= 0) return 100;
  return Math.round(numericScale * 100);
}

function updateGraphZoomUi(scale = 1, disabled = true) {
  const slider = getGraphZoomSlider();
  const percent = getGraphZoomPercent(scale);
  const viewKey = getActiveGraphViewKey();

  updateGraphZoomTargetLabel();
  syncWorkspaceChrome(viewKey);

  if (slider) {
    slider.value = String(percent);
    slider.disabled = disabled || !viewSupportsZoom(viewKey);
  }

  setTextById("graphZoomValue", `${percent}%`);
}

function syncGraphZoomUi() {
  const viewKey = getActiveGraphViewKey();
  if (!viewSupportsZoom(viewKey)) {
    updateGraphZoomUi(graphZoomScale, true);
    return;
  }

  updateGraphZoomUi(graphZoomScale, getGraphZoomControllers().length === 0);
}

function handleGraphZoomInput(ev) {
  const slider = ev?.target;
  if (!(slider instanceof HTMLInputElement)) return;

  if (!viewSupportsZoom(getActiveGraphViewKey())) {
    updateGraphZoomUi(graphZoomScale, true);
    return;
  }

  const requestedScale = Number(slider.value) / 100;
  const appliedScale = applyGraphsZoom(requestedScale);
  updateGraphZoomUi(appliedScale, getGraphZoomControllers().length === 0);
}

function bindGraphZoomUi() {
  const slider = getGraphZoomSlider();
  if (slider && !graphZoomUiBound) {
    slider.addEventListener("input", handleGraphZoomInput);
    graphZoomUiBound = true;
  }

  if (!graphZoomTabsBound) {
    for (const tab of getGraphViewTabs()) {
      tab.addEventListener("shown.bs.tab", () => {
        syncGraphZoomUi();
        if (String(tab.id || "") === "app-view-tab") {
          syncAppViewPanel(getSelectedAppId(), { force: true });
        }
      });
    }
    graphZoomTabsBound = true;
  }

  syncGraphZoomUi();
}


/* ======================================================================= */
/* MessageBox                                                               */
/* ======================================================================= */

function msgBoxTitle(cfg) {
  return String(cfg?.title || "Message");
}

function msgBoxMessage(cfg) {
  return String(cfg?.message || "");
}

function safeJsonStringify(v) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return "";
  }
}

function msgBoxDetailsText(cfg) {
  if (cfg?.details == null) return "";

  const json = safeJsonStringify(cfg.details);
  if (json) return json;

  // Fallback for non-serializable values (e.g. circular references)
  return String(cfg?.details || "");
}

function hasUsefulDetails(detailsText) {
  const t = String(detailsText || "");
  return Boolean(t) && t !== "null";
}

function buildMessageBoxText(title, message, detailsText) {
  const head = `${title}\n\n${message}`;
  if (!hasUsefulDetails(detailsText)) return head;
  return `${head}\n\nDetails:\n${detailsText}`;
}

/**
 * Lightweight message box for analysis diagnostics.
 * @param {{
 *   title: string,
 *   message: string,
 *   details?: any,
 *   severity?: "info"|"warn"|"error"
 * }} cfg
 */
function showMessageBox(cfg) {
  const title = msgBoxTitle(cfg);
  const message = msgBoxMessage(cfg);
  const detailsText = msgBoxDetailsText(cfg);

  const full = buildMessageBoxText(title, message, detailsText);
  alert(full);
}

/**
 * Show a dedicated message for unsupported targets (e.g. CommonJS-only projects).
 * @param {any} data
 */
function unsupportedReason(data) {
  return String(data?.reason || data?.analysisStatus || "unsupported");
}

function unsupportedUserMessage(data) {
  return String(
    data?.message || "This target is not supported by the current analyzer mode."
  );
}

function unsupportedDetails(data) {
  return data?.details || data;
}

/**
 * Show a dedicated message for unsupported targets.
 *
 * Why we need this
 * ---------------
 * The analyzer cannot reliably analyze every project type/mode (e.g. CommonJS-only,
 * dynamic exports, missing entrypoint assumptions). In those cases the backend returns
 * `analysisStatus: "unsupported"` plus optional `reason/message/details`.
 *
 * Instead of failing with a generic error, we surface a clear, actionable explanation
 * to the user so they understand *why* no graph is shown and what to change.
 */
function showUnsupportedTargetMessage(data) {
  const msg = unsupportedUserMessage(data);
  const reason = unsupportedReason(data);

  showMessageBox({
    title: "Unsupported target",
    severity: "warn",
    message: `${msg}\n\nReason: ${reason}`,
    details: unsupportedDetails(data),
  });
}

/* ======================================================================= */
/* Fetch helpers                                                            */
/* ======================================================================= */

function isHttpNotFound(r) {
  return Number(r?.status) === 404;
}

function getContentType(r) {
  return String(r?.headers?.get?.("content-type") || "");
}

function isJsonContentType(ct) {
  return String(ct).includes("application/json");
}

function buildResponseContext(url, r) {
  const ct = getContentType(r);
  return {
    url: String(url || ""),
    status: Number(r?.status || 0),
    statusText: String(r?.statusText || ""),
    contentType: ct,
    isJson: isJsonContentType(ct)
  };
}

async function readResponseBodySafely(r, isJson) {
  try {
    return isJson ? await r.json() : await r.text();
  } catch {
    return null;
  }
}

function extractServerMessage(body) {
  const serverMsg = body?.error?.message || body?.message;
  if (serverMsg) return String(serverMsg);

  const text = typeof body === "string" ? body.trim() : "";
  return text || "";
}

function buildHttpError(ctx, body) {
  const serverMsg = extractServerMessage(body);
  const msg = serverMsg || `HTTP ${ctx.status} ${ctx.statusText}`;

  const err = new Error(msg);
    /** @type {any} */ (err).status = ctx.status;
    /** @type {any} */ (err).code = body?.error?.code;
    /** @type {any} */ (err).details = body?.error?.details;
  return err;
}

function assertJsonResponse(ctx) {
  if (ctx.isJson) return;
  throw new Error(
    `Expected JSON response from ${ctx.url}, got content-type: ${ctx.contentType || "(missing)"}`
  );
}

/**
 * Fetch JSON but treat HTTP 404 as a normal "not found" result.
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<any|null>}
 */
async function fetchJsonOrNullOn404(url, init) {
  const r = await fetch(url, init);
  if (isHttpNotFound(r)) return null;

  const ctx = buildResponseContext(url, r);
  const body = await readResponseBodySafely(r, ctx.isJson);

  if (!r.ok) throw buildHttpError(ctx, body);
  assertJsonResponse(ctx);

  return body;
}

async function postJsonAction(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {})
  });

  const ctx = buildResponseContext(url, response);
  const payload = await readResponseBodySafely(response, ctx.isJson);

  if (!response.ok) throw buildHttpError(ctx, payload);
  assertJsonResponse(ctx);

  return payload;
}

async function renderAllProjectsOverview() {
  const panel = byId("allProjectsPanel");
  if (!panel) return;

  const requestToken = ++allProjectsLoadToken;
  panel.innerHTML = `<div class="text-secondary small">Loading portfolio view…</div>`;

  try {
    const mod = await import("./graph_allProjectsView.js");
    if (requestToken !== allProjectsLoadToken) return;
    await mod.renderAllProjectsView("allProjectsPanel");
  } catch (e) {
    if (requestToken !== allProjectsLoadToken) return;

    console.warn("All projects view failed:", e);
    panel.innerHTML = `<div class="text-danger small">Could not load project portfolio.</div>`;
  }
}

async function syncPortfolioSelectionUi(appId) {
  const panel = byId("allProjectsPanel");
  if (!panel) return;

  try {
    const mod = await import("./graph_allProjectsView.js");
    const synced = typeof mod.syncPortfolioSelection === "function" &&
      mod.syncPortfolioSelection("allProjectsPanel", appId);
    if (synced) return;
  } catch (e) {
    console.warn("Portfolio selection sync failed:", e);
  }

  await renderAllProjectsOverview();
}

async function updatePortfolioScreenshotStatusUi(appId, status = null) {
  const safeAppId = normalizeAppId(appId);
  if (!safeAppId) return;

  try {
    const mod = await import("./graph_allProjectsView.js");
    if (typeof mod.setPortfolioScreenshotStatus === "function") {
      mod.setPortfolioScreenshotStatus("allProjectsPanel", safeAppId, status);
    }
  } catch (e) {
    console.warn("Portfolio screenshot status sync failed:", e);
  }
}

function getActiveGraphAppId() {
  return String(activeGraphAppId || "").trim();
}

function buildAppViewScreenshotsEmptyMarkup(message) {
  return `<div class="workspaceAppScreenshotsEmpty text-secondary small">${esc(message || "No screenshots created yet.")}</div>`;
}

function buildAppViewScreenshotCardMarkup(item) {
  const name = String(item?.name || "").trim() || "screenshot";
  const imageUrl = buildVersionedUrl(item?.imageUrl, item?.modifiedAt || item?.sizeBytes);
  const metaParts = [
    item?.modifiedAt ? formatIsoDate(item.modifiedAt) : "",
    item?.sizeBytes ? formatBytes(item.sizeBytes) : ""
  ].filter(Boolean);
  const meta = metaParts.join(" · ");
  const pageUrl = String(item?.pageUrl || "").trim();
  const title = [name, meta, pageUrl].filter(Boolean).join("\n");

  return `
    <a
      class="workspaceAppScreenshotCard"
      href="${esc(imageUrl)}"
      target="_blank"
      rel="noopener noreferrer"
      title="${esc(title)}"
    >
      <img
        class="workspaceAppScreenshotThumb"
        src="${esc(imageUrl)}"
        alt="${esc(name)}"
        loading="lazy"
      />
      <span class="workspaceAppScreenshotName">${esc(name)}</span>
      <span class="workspaceAppScreenshotMeta">${esc(meta || "Open screenshot")}</span>
    </a>
  `;
}

function buildAppViewScreenshotsMarkup(data) {
  const items = Array.isArray(data?.items) ? data.items : [];
  const metaParts = [
    `${items.length} screenshot${items.length === 1 ? "" : "s"}`,
    data?.generatedAt ? `manifest ${formatIsoDate(data.generatedAt)}` : ""
  ].filter(Boolean);

  return `
    <div class="workspaceAppScreenshotsHeader">
      <div class="small fw-semibold">Latest screenshots</div>
      <div class="small text-secondary">${esc(metaParts.join(" · "))}</div>
    </div>
    ${items.length
      ? `<div class="workspaceAppScreenshotsRail">${items.map(buildAppViewScreenshotCardMarkup).join("")}</div>`
      : buildAppViewScreenshotsEmptyMarkup("No screenshots created yet for this app.")}
  `;
}

async function fetchAppViewScreenshots(appId) {
  const safeAppId = normalizeAppId(appId);
  if (!safeAppId) return { items: [] };
  return fetchJson(`/apps/${encodeURIComponent(safeAppId)}/screenshots/latest`);
}

async function loadAppViewScreenshots(appId, root = byId(APP_VIEW_PANEL_ID)) {
  const safeAppId = normalizeAppId(appId);
  const section = root?.querySelector?.("[data-app-view-screenshots]");
  if (!safeAppId || !section) return false;

  const requestToken = ++appViewScreenshotsLoadToken;

  try {
    const data = await fetchAppViewScreenshots(safeAppId);
    if (requestToken !== appViewScreenshotsLoadToken) return false;
    if (getSelectedAppId() !== safeAppId) return false;

    const liveSection = root?.querySelector?.("[data-app-view-screenshots]");
    if (!liveSection) return false;
    liveSection.innerHTML = buildAppViewScreenshotsMarkup(data);
    return true;
  } catch (error) {
    if (requestToken !== appViewScreenshotsLoadToken) return false;

    const liveSection = root?.querySelector?.("[data-app-view-screenshots]");
    if (!liveSection) return false;
    liveSection.innerHTML = buildAppViewScreenshotsEmptyMarkup(
      String(error?.message || error || "Could not load screenshots.")
    );
    return false;
  }
}

function renderAppInfoRow(label, value, { html = false } = {}) {
  const cell = html ? String(value || "—") : esc(toDisplayText(value));
  return `
    <tr>
      <th scope="row">${esc(label)}</th>
      <td>${cell || "—"}</td>
    </tr>
  `;
}

function renderAppInfoTable(rows) {
  return `
    <div class="table-responsive">
      <table class="table table-sm appInfoTable">
        <tbody>${rows.join("")}</tbody>
      </table>
    </div>
  `;
}

function renderCommitAuthorCell(commit) {
  const authorName = esc(toDisplayText(commit?.authorName));
  const authorEmail = String(commit?.authorEmail || "").trim();
  if (!authorEmail) return authorName;

  return `
    <div>${authorName}</div>
    <div class="small text-secondary">${esc(authorEmail)}</div>
  `;
}

function readGitHistoryChartPoints(commits) {
  return (Array.isArray(commits) ? commits : [])
    .map((commit) => {
      const committedAt = String(commit?.committedAt || commit?.authoredAt || "").trim();
      const date = new Date(committedAt);
      const codeLines = Number(commit?.codeLines);
      if (!Number.isFinite(date.getTime()) || !Number.isFinite(codeLines)) return null;

      return {
        fullSha: String(commit?.fullSha || "").trim(),
        shortSha: String(commit?.shortSha || "").trim(),
        subject: String(commit?.subject || "").trim(),
        committedAt,
        date,
        codeLines: Math.max(0, codeLines)
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.date - right.date);
}

function setGraphGitHistoryPlaceholder(message, meta = "Select an app to load Git history.") {
  const emptyNode = maybeById(GRAPH_GIT_HISTORY_EMPTY_ID);
  const metaNode = maybeById(GRAPH_GIT_HISTORY_META_ID);
  const svgNode = maybeById(APP_GIT_HISTORY_CHART_ID);

  if (metaNode) metaNode.textContent = String(meta || "");
  if (emptyNode) {
    emptyNode.textContent = String(message || "");
    emptyNode.classList.remove("d-none");
  }

  if (svgNode) {
    svgNode.classList.add("d-none");
    window.d3?.select(svgNode).selectAll("*").remove();
  }
}

function renderCommitsTable(commits, gitAvailable) {
  if (!gitAvailable) {
    return `<div class="text-secondary small">No Git repository detected.</div>`;
  }

  if (!Array.isArray(commits) || commits.length === 0) {
    return `<div class="text-secondary small">No commits available.</div>`;
  }

  const rows = commits
    .map((commit) => `
      <tr>
        <td class="appInfoCommitDate">${esc(formatIsoDate(commit?.authoredAt))}</td>
        <td class="appInfoCommitShaCell">
          <span class="appInfoCommitSha">${esc(toDisplayText(commit?.shortSha || commit?.fullSha))}</span>
        </td>
        <td>${renderCommitAuthorCell(commit)}</td>
        <td class="appInfoCommitSubject">${esc(toDisplayText(commit?.subject))}</td>
      </tr>
    `)
    .join("");

  return `
    <div class="table-responsive">
      <table class="table table-sm appInfoTable appInfoCommitsTable">
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Commit</th>
            <th scope="col">Author</th>
            <th scope="col">Subject</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function gitHistoryChartTimeDomain(points) {
  const first = points[0]?.date;
  const last = points[points.length - 1]?.date;
  if (!(first instanceof Date) || !(last instanceof Date)) return [new Date(), new Date()];

  if (first.getTime() !== last.getTime()) return [first, last];

  const center = first.getTime();
  const halfDayMs = 12 * 60 * 60 * 1000;
  return [new Date(center - halfDayMs), new Date(center + halfDayMs)];
}

function buildGitHistoryTooltip(commit) {
  const lines = Number(commit?.codeLines || 0);
  const lineLabel = `${formatInteger(lines)} code lines`;
  const parts = [
    toDisplayText(commit?.subject, "No subject"),
    commit?.shortSha ? `Commit ${commit.shortSha}` : "",
    commit?.committedAt ? `Date ${formatIsoDate(commit.committedAt)}` : "",
    lineLabel
  ].filter(Boolean);

  return parts.join("\n");
}

function renderGitHistoryChart(commits, gitAvailable) {
  const svgNode = maybeById(APP_GIT_HISTORY_CHART_ID);
  if (!svgNode || !gitAvailable) return;

  const d3Global = window.d3;
  if (!d3Global) return;

  const points = readGitHistoryChartPoints(commits);
  if (!points.length) return;

  const width = 760;
  const height = 240;
  const margin = { top: 16, right: 20, bottom: 34, left: 58 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const xDomain = gitHistoryChartTimeDomain(points);
  const yMax = d3Global.max(points, (point) => point.codeLines) || 1;

  const x = d3Global.scaleUtc()
    .domain(xDomain)
    .range([margin.left, width - margin.right]);
  const y = d3Global.scaleLinear()
    .domain([0, yMax])
    .nice()
    .range([height - margin.bottom, margin.top]);

  const svg = d3Global.select(svgNode);
  svg.selectAll("*").remove();
  svg
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("preserveAspectRatio", "xMidYMid meet");

  svg.append("g")
    .attr("transform", `translate(0,${height - margin.bottom})`)
    .call(
      d3Global.axisBottom(x)
        .ticks(Math.max(3, Math.min(8, Math.round(points.length / 10) || 3)))
        .tickFormat(d3Global.utcFormat("%d.%m.%y"))
    )
    .call((group) => group.select(".domain").attr("stroke", "rgba(15, 23, 42, 0.18)"))
    .call((group) => group.selectAll("line").attr("stroke", "rgba(15, 23, 42, 0.12)"))
    .call((group) => group.selectAll("text").attr("fill", "rgba(15, 23, 42, 0.75)").style("font-size", "11px"));

  svg.append("g")
    .attr("transform", `translate(${margin.left},0)`)
    .call(
      d3Global.axisLeft(y)
        .ticks(5)
        .tickFormat(d3Global.format(","))
    )
    .call((group) => group.select(".domain").attr("stroke", "rgba(15, 23, 42, 0.18)"))
    .call((group) => group.selectAll("line").attr("stroke", "rgba(15, 23, 42, 0.12)"))
    .call((group) => group.selectAll("text").attr("fill", "rgba(15, 23, 42, 0.75)").style("font-size", "11px"));

  svg.append("g")
    .attr("class", "gitHistoryChartGrid")
    .attr("transform", `translate(${margin.left},0)`)
    .call(
      d3Global.axisLeft(y)
        .ticks(5)
        .tickSize(-innerWidth)
        .tickFormat("")
    )
    .call((group) => group.select(".domain").remove())
    .call((group) => group.selectAll("line").attr("stroke", "rgba(15, 23, 42, 0.08)"));

  const line = d3Global.line()
    .x((point) => x(point.date))
    .y((point) => y(point.codeLines))
    .curve(d3Global.curveMonotoneX);

  svg.append("path")
    .datum(points)
    .attr("fill", "none")
    .attr("stroke", "#2563eb")
    .attr("stroke-width", 2)
    .attr("d", line);

  svg.append("g")
    .selectAll("circle")
    .data(points)
    .join("circle")
    .attr("cx", (point) => x(point.date))
    .attr("cy", (point) => y(point.codeLines))
    .attr("r", points.length > 180 ? 2 : 3)
    .attr("fill", "#2563eb")
    .attr("opacity", 0.95);

  const hitDots = svg.append("g")
    .selectAll("circle")
    .data(points)
    .join("circle")
    .attr("cx", (point) => x(point.date))
    .attr("cy", (point) => y(point.codeLines))
    .attr("r", 9)
    .attr("fill", "transparent")
    .style("cursor", "pointer");

  hitDots.append("title")
    .text((point) => buildGitHistoryTooltip(point));
}

function renderGraphGitHistoryPanel(data, fallbackMessage = "Select an app to load Git history.") {
  if (!data) {
    setGraphGitHistoryPlaceholder(fallbackMessage, "Select an app to load Git history.");
    return;
  }

  const app = data.app || {};
  const git = data.git || {};
  const appLabel = String(app?.name || app?.id || "Selected app").trim();
  const codeLineHistory = Array.isArray(git.codeLineHistory) ? git.codeLineHistory : [];
  const points = readGitHistoryChartPoints(codeLineHistory);

  if (!git.available) {
    setGraphGitHistoryPlaceholder("No Git repository detected for this app.", `${appLabel} · no Git repository`);
    return;
  }

  if (!points.length) {
    setGraphGitHistoryPlaceholder("No code line history available for this app.", `${appLabel} · no code line history`);
    return;
  }

  const latest = points[points.length - 1];
  const metaNode = maybeById(GRAPH_GIT_HISTORY_META_ID);
  const emptyNode = maybeById(GRAPH_GIT_HISTORY_EMPTY_ID);
  const svgNode = maybeById(APP_GIT_HISTORY_CHART_ID);

  if (metaNode) {
    metaNode.textContent = `${appLabel} · ${points.length} commits · latest ${formatInteger(latest.codeLines)} lines`;
  }
  if (emptyNode) emptyNode.classList.add("d-none");
  if (svgNode) svgNode.classList.remove("d-none");

  renderGitHistoryChart(codeLineHistory, true);
}

function buildLinkHtml(url) {
  const href = String(url || "").trim();
  if (!href) return "—";
  return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(href)}</a>`;
}

function buildPathHtml(value) {
  const text = String(value || "").trim();
  if (!text) return "—";
  return `<span class="appInfoPath">${esc(text)}</span>`;
}

function buildWorktreeBadges(worktree, gitAvailable) {
  if (!gitAvailable) {
    return `<span class="badge text-bg-secondary">No Git repository detected</span>`;
  }

  const dirty = Boolean(worktree?.dirty);
  const badges = [
    `<span class="badge ${dirty ? "text-bg-warning" : "text-bg-success"}">${dirty ? "Dirty" : "Clean"}</span>`,
    `<span class="badge text-bg-light">Staged ${Number(worktree?.stagedCount || 0)}</span>`,
    `<span class="badge text-bg-light">Modified ${Number(worktree?.modifiedCount || 0)}</span>`,
    `<span class="badge text-bg-light">Untracked ${Number(worktree?.untrackedCount || 0)}</span>`
  ];

  if (Number(worktree?.conflictedCount || 0) > 0) {
    badges.push(
      `<span class="badge text-bg-danger">Conflicted ${Number(worktree?.conflictedCount || 0)}</span>`
    );
  }

  return `<div class="appInfoBadgeRow">${badges.join("")}</div>`;
}

function getAppInfoRoots() {
  return Object.values(APP_INFO_PANEL_IDS)
    .map((id) => byId(id))
    .filter(Boolean);
}

function renderAppInfoEmpty(message) {
  const markup = `<div class="text-secondary small">${esc(message)}</div>`;
  for (const root of getAppInfoRoots()) {
    root.innerHTML = markup;
  }
  renderGraphGitHistoryPanel(null, String(message || "Select an app to load Git history."));
}

function buildAppInfoHeader(app) {
  return `
    <div>
      <div class="h5 mb-1">${esc(app?.name || app?.id || "App")}</div>
      <div class="small text-secondary">${esc(app?.id || "")}</div>
    </div>
  `;
}

function renderAppInfoSectionPanel(section, app) {
  return `
    <div class="appInfoShell">
      ${buildAppInfoHeader(app)}
      <section class="appInfoSection appInfoTabPanel">
        <div class="appInfoSectionTitle">${esc(section.title)}</div>
        ${String(section.contentHtml || "")}
      </section>
    </div>
  `;
}

function renderAppInfoSectionsPanel(sections, app) {
  return `
    <div class="appInfoShell">
      ${buildAppInfoHeader(app)}
      ${(sections || []).map((section) => `
        <section class="appInfoSection appInfoTabPanel">
          <div class="appInfoSectionTitle">${esc(section.title)}</div>
          ${String(section.contentHtml || "")}
        </section>
      `).join("")}
    </div>
  `;
}

function renderAppInfoSectionInto(panelId, section, app) {
  const root = byId(panelId);
  if (!root) return;
  root.innerHTML = renderAppInfoSectionPanel(section, app);
}

function renderAppInfoSectionsInto(panelId, sections, app) {
  const root = byId(panelId);
  if (!root) return;
  root.innerHTML = renderAppInfoSectionsPanel(sections, app);
}

function renderAppInfoPanel(data) {
  const roots = getAppInfoRoots();
  if (!roots.length) return;

  if (!data) {
    renderAppInfoEmpty("Select an app to inspect details.");
    return;
  }

  const app = data.app || {};
  const git = data.git || {};
  const commits = Array.isArray(git.commits) ? git.commits : [];
  const freeze = data.freeze || {};
  const latestFreeze = freeze.latest || null;
  const sections = [
    {
      id: "overview",
      title: "Overview",
      contentHtml: renderAppInfoTable([
        renderAppInfoRow("URL", buildLinkHtml(app.url), { html: true }),
        renderAppInfoRow("Entrypoint", buildPathHtml(app.entry), { html: true }),
        renderAppInfoRow("Project root", buildPathHtml(app.appRootAbs || app.rootDir), { html: true }),
        renderAppInfoRow("Backup dir", buildPathHtml(freeze.backupDir || app.backupDir), { html: true })
      ])
    },
    {
      id: "git",
      title: "Git",
      contentHtml: renderAppInfoTable([
        renderAppInfoRow("Repository", buildPathHtml(git.repoRootAbs), { html: true }),
        renderAppInfoRow("Branch", toDisplayText(git.branch)),
        renderAppInfoRow("Upstream", toDisplayText(git.upstream)),
        renderAppInfoRow("HEAD", toDisplayText(git.head?.shortSha || git.head?.fullSha)),
        renderAppInfoRow("Origin", buildLinkHtml(git.remoteOriginUrl), { html: true }),
        renderAppInfoRow("Commits", String(Number(git.commitCount || 0))),
        renderAppInfoRow("Tracked files", String(Number(git.trackedFileCount || 0))),
        renderAppInfoRow(
          "Ahead / behind",
          git.available ? `${Number(git.ahead || 0)} / ${Number(git.behind || 0)}` : "—"
        ),
        renderAppInfoRow("Worktree", buildWorktreeBadges(git.worktree, git.available), { html: true })
      ])
    },
    {
      id: "freeze",
      title: "Freeze",
      contentHtml: renderAppInfoTable([
        renderAppInfoRow("Latest ZIP", buildPathHtml(latestFreeze?.zipPath), { html: true }),
        renderAppInfoRow("Filename", toDisplayText(latestFreeze?.zipFilename)),
        renderAppInfoRow("Modified", formatIsoDate(latestFreeze?.modifiedAt)),
        renderAppInfoRow("Size", formatBytes(latestFreeze?.sizeBytes))
      ])
    }
  ];

  renderAppInfoSectionInto(APP_INFO_PANEL_IDS.overview, sections[0], app);
  renderAppInfoSectionsInto(APP_INFO_PANEL_IDS.git, [
    sections[1],
    {
      title: "Commits",
      contentHtml: renderCommitsTable(commits, git.available)
    }
  ], app);
  renderGraphGitHistoryPanel(data);
  renderAppInfoSectionInto(APP_INFO_PANEL_IDS.freeze, sections[2], app);
}

async function fetchAppInfo(appId) {
  const id = encodeURIComponent(String(appId || ""));
  return fetchJson(`/apps/${id}/info`);
}

async function loadSelectedAppInfo() {
  const appId = getSelectedAppId();
  const requestToken = ++appInfoLoadToken;

  if (!appId) {
    renderAppInfoEmpty("Select an app to inspect details.");
    return null;
  }

  renderAppInfoEmpty("Loading app details…");

  try {
    const data = await fetchAppInfo(appId);
    if (requestToken !== appInfoLoadToken) return null;

    renderAppInfoPanel(data);
    return data;
  } catch (e) {
    if (requestToken !== appInfoLoadToken) return null;

    renderAppInfoEmpty(String(e?.message || e || "Could not load app details."));
    return null;
  }
}

/* ======================================================================= */
/* Panels                                                                   */
/* ======================================================================= */

function clearPanels() {
  const rp = maybeById("readmePanel");
  const ip = maybeById("graphInfoPanel");
  if (rp) {
    rp.innerHTML = "";
    setReadmeSummary("none");
  }
  if (ip) ip.innerHTML = "";
}

/**
 * Render selection details immediately on click.
 * @param {any} node
 */
function renderInfoPanel(node) {
  const root = maybeById("graphInfoPanel");
  if (!root) return;

  if (!node) {
    root.innerHTML = `<div class="text-muted small">No node selected.</div>`;
    return;
  }

  const id = node.id ?? "";
  const file = node.file ?? node.parent ?? "";
  const kind = node.kind ?? "";
  const name = node.name ?? "";
  const lines = node.__displayLines ?? node.lines ?? "—";
  const cx = node.__displayComplexity ?? node.complexity ?? "—";

  const comment = node.headerComment ?? node.fileComment ?? node.comment ?? "";

  const lastEv = node._lastChangeEv ?? "";
  const lastAt = node._lastChangedAt ?? "";

  root.innerHTML = `
      <div class="d-grid gap-2">
        <div class="small text-muted"><strong>ID:</strong> ${esc(id)}</div>
        ${file ? `<div class="small text-muted"><strong>File:</strong> ${esc(file)}</div>` : ""}
        ${kind ? `<div class="small text-muted"><strong>Kind:</strong> ${esc(kind)}</div>` : ""}
        ${name ? `<div class="small text-muted"><strong>Name:</strong> ${esc(name)}</div>` : ""}

        <div class="small text-muted"><strong>Lines:</strong> ${esc(lines)}</div>
        <div class="small text-muted"><strong>Complexity:</strong> ${esc(cx)}</div>

        ${lastAt ? `<div class="small text-muted"><strong>Last change:</strong> ${esc(lastEv)} @ ${esc(lastAt)}</div>` : ""}

        <hr class="my-2" />

        <div class="fw-semibold small">Comment</div>
        ${comment
      ? `<pre class="comment-pre mb-0">${esc(comment)}</pre>`
      : `<div class="text-muted small">No file header comment provided by analyzer.</div>`
    }
      </div>
    `;
}

function getReadmeRoot() {
  const root = maybeById("readmePanel");
  if (!root) return null;
  if (root.closest(".d-none")) return null;
  return root;
}

function setReadmeSummary(text = "none") {
  const summary = String(text || "").trim();
  const el = maybeById("readmeSummary");
  if (!el) return false;
  el.textContent = summary || "none";
  return true;
}

function getNodeRelPath(node) {
  return String(node?.file || node?.parent || node?.id || "").trim();
}

function clearReadme(root) {
  setReadmeSummary("none");
  root.innerHTML = "";
}

function showReadmeSearching(root) {
  setReadmeSummary("searching...");
  root.innerHTML = `<div class="text-muted small">Searching…</div>`;
}

function showReadmeSelectApp(root) {
  setReadmeSummary("none");
  root.innerHTML = `<div class="text-muted small">Select an app to load its root README.</div>`;
}

function showReadmeNotFound(root, message = "No README found for this context.") {
  setReadmeSummary("none");
  root.innerHTML = `<div class="text-muted small">${esc(message)}</div>`;
}

function buildReadmeUrl(appId, fileRel) {
  const a = encodeURIComponent(String(appId || ""));
  const f = encodeURIComponent(String(fileRel || ""));
  return `/readme?appId=${a}&file=${f}`;
}

function buildAppRootReadmeUrl(appId) {
  return buildReadmeUrl(appId, ".");
}

function isAbortError(e) {
  return String(e?.name || "") === "AbortError";
}

function isAborted(signal) {
  return Boolean(signal?.aborted);
}

async function fetchReadmeDataOrNull(url, signal) {
  try {
    return await fetchJsonOrNullOn404(url, { signal });
  } catch (e) {
    if (isAbortError(e) || isAborted(signal)) return null;
    console.warn("README fetch failed:", e);
    return null;
  }
}

function renderReadmeMarkdown(root, data, appId = "") {
  const md = String(data?.markdown || "");
  const rawHtml = markdownToHtml(md);
  const safeHtml = sanitizeHtml(rawHtml);
  const readmePath = String(data?.readmePath || "").trim();
  const linkedHtml = rewriteReadmeAssetLinks(safeHtml, appId, readmePath);

  setReadmeSummary(readmePath || "README");

  root.innerHTML = `
      <div class="small text-secondary mb-2">${esc(readmePath)}</div>
      <div class="content markdown">${linkedHtml}</div>
    `;
}

async function renderDefaultReadmeForApp(appId, signal) {
  const root = getReadmeRoot();
  if (!root) return;

  const safeAppId = String(appId || "").trim();
  if (!safeAppId) {
    showReadmeSelectApp(root);
    return;
  }

  showReadmeSearching(root);

  const url = buildAppRootReadmeUrl(safeAppId);
  const data = await fetchReadmeDataOrNull(url, signal);

  if (isAborted(signal)) return;

  if (!data || data.found === false) {
    showReadmeNotFound(root, "No README found in the app root.");
    return;
  }

  renderReadmeMarkdown(root, data, safeAppId);
}

async function renderReadmeForNode(node, signal) {
  const root = getReadmeRoot();
  if (!root) return;

  const fileRel = getNodeRelPath(node);
  if (!fileRel) {
    clearReadme(root);
    return;
  }

  showReadmeSearching(root);

  const appId = getActiveGraphAppId();
  if (!appId) {
    showReadmeSelectApp(root);
    return;
  }

  const url = buildReadmeUrl(appId, fileRel);
  const data = await fetchReadmeDataOrNull(url, signal);

  if (isAborted(signal)) return;

  if (!data || data.found === false) {
    showReadmeNotFound(root);
    return;
  }

  renderReadmeMarkdown(root, data, appId);
}

function createFreshReadmeController() {
  if (activeReadmeController) activeReadmeController.abort();
  activeReadmeController = new AbortController();
  return activeReadmeController;
}

function handleReadmeRenderFailure(e) {
  if (e?.name === "AbortError") return;
  console.warn("README render failed:", e);
  const root = getReadmeRoot();
  if (root) {
    setReadmeSummary("none");
    root.innerHTML = `<div class="text-muted small">Could not load README.</div>`;
  }
}

function requestDefaultReadmeForApp(appId = getSelectedAppId()) {
  if (!ensurePanelsExist()) return;
  const controller = createFreshReadmeController();

  renderDefaultReadmeForApp(appId, controller.signal).catch(handleReadmeRenderFailure);
}

/* ======================================================================= */
/* Graph state helpers                                                     */
/* ======================================================================= */

function getRenderedNodeById(id) {
  const nodes = graphController?.nodes;
  if (!Array.isArray(nodes) || !id) return null;
  return nodes.find((n) => n && n.id === id) || null;
}

function refreshSelectedPanels() {
  const selectedId = String(selectedNode?.id || "").trim();
  if (!selectedId) return;

  const latest = getRenderedNodeById(selectedId) || selectedNode;
  selectedNode = latest;

  if (ensurePanelsExist()) {
    renderInfoPanel(latest);
    const controller = createFreshReadmeController();
    renderReadmeForNode(latest, controller.signal).catch(handleReadmeRenderFailure);
  }
}

/* ======================================================================= */
/* D3 integration hook (ESM callback)                                       */
/* ======================================================================= */

let activeReadmeController = null;

/**
 * Called by the graph renderer when the user selects a node.
 * (No global window hook; passed as option to initcodeStructureChart.)
 * @param {any} node
 */
function onNodeSelected(node) {
  selectedNode = node || null;

  if (!ensurePanelsExist()) return;

  renderInfoPanel(node);
  const controller = createFreshReadmeController();

  if (!node) {
    renderDefaultReadmeForApp(getSelectedAppId(), controller.signal).catch(handleReadmeRenderFailure);
    return;
  }

  renderReadmeForNode(node, controller.signal).catch(handleReadmeRenderFailure);
}

/* ======================================================================= */
/* App selection + Actions (Restart / Show Website)                         */
/* ======================================================================= */

function setSelectedAppId(appId) {
  const previousId = getSelectedAppIdState();
  const nextId = setSelectedAppIdState(appId);
  updateShellTitle(nextId);

  if (nextId !== previousId) {
    emitActiveAppChanged(nextId);
  }
}

function getSelectedAppId() {
  return getSelectedAppIdState();
}

function openWebsite(url) {
  const u = String(url || "").trim();
  if (!u) {
    showMessageBox({
      title: "No URL",
      severity: "warn",
      message: "This app has no URL configured.",
    });
    return;
  }
  try {
    window.open(u, "_blank", "noopener,noreferrer");
  } catch (e) {
    showMessageBox({
      title: "Open failed",
      severity: "error",
      message: String(e?.message || e || "Could not open URL"),
    });
  }
}


function normalizeAppId(appId) {
  return String(appId || "").trim();
}

function buildRestartTries(appId) {
  const idEnc = encodeURIComponent(String(appId || ""));
  const body = { appId: String(appId || "") };

  // Try a few common endpoint patterns (first successful response wins).
  return [
    { url: "/restart", body },
    { url: "/apps/restart", body },
    { url: `/apps/${idEnc}/restart`, body },
  ];
}

function buildRestartRequestInit(body) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function postRestartTry(t) {
  return fetchJson(t.url, buildRestartRequestInit(t.body));
}

function restartStatusMessage(res) {
  return String(res?.message || res?.status || "Restart requested.");
}

function setRestartStatus(appId, res) {
  const msg = restartStatusMessage(res);
  setStatus(`Restart: ${appId} (${msg})`);
}

async function restartFirstSuccessful(appId) {
  let lastErr = null;

  for (const t of buildRestartTries(appId)) {
    try {
      const res = await postRestartTry(t);
      return { res, lastErr: null };
    } catch (e) {
      lastErr = e;
    }
  }

  return { res: null, lastErr };
}

/**
 * Request an app restart.
 *
 * Why this function tries multiple URLs
 * -------------------------------
 * NodeAnalyzer can be embedded / renamed across projects. Different backends
 * may expose different restart endpoints. To keep the UI resilient, we try a
 * small list of common patterns and accept the first that responds with 2xx.
 *
 * Outcome
 * -------
 * - On success: updates the status line with a short backend message.
 * - On failure: throws the last error (or a generic error if nothing responded).
 */
async function restartApp(appId) {
  const id = normalizeAppId(appId);
  if (!id) return;

  const { res, lastErr } = await restartFirstSuccessful(id);
  if (!res) throw lastErr || new Error("Restart failed (no endpoint responded).");

  setRestartStatus(id, res);
}

function buildScreenshotTries(appId) {
  const idEnc = encodeURIComponent(String(appId || ""));
  const body = { appId: String(appId || "") };

  return [
    { url: "/screenshots", body },
    { url: `/apps/${idEnc}/screenshots`, body }
  ];
}

async function createScreenshotsApp(appId) {
  const id = normalizeAppId(appId);
  if (!id) return null;

  let lastErr = null;
  for (const t of buildScreenshotTries(id)) {
    try {
      return await postJsonAction(t.url, t.body);
    } catch (error) {
      lastErr = error;
    }
  }

  throw lastErr || new Error("Create screenshots failed (no endpoint responded).");
}

async function fetchScreenshotJob(jobId) {
  const safeJobId = encodeURIComponent(String(jobId || "").trim());
  if (!safeJobId) throw new Error("Missing screenshot job id.");
  return fetchJson(`/screenshots/jobs/${safeJobId}`);
}

function formatScreenshotCreatedAt(value) {
  const raw = String(value || "").trim();
  if (!raw) return "now";

  try {
    return new Date(raw).toLocaleString("de-DE", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return raw;
  }
}

function buildRunningScreenshotStatus() {
  return {
    state: "running",
    label: "Creating screenshots…",
    title: "Screenshot creation is running."
  };
}

function buildFinishedScreenshotStatus(job) {
  const createdAt = formatScreenshotCreatedAt(job?.finishedAt || new Date().toISOString());
  const failedCount = Number(job?.failedCount || 0);
  const baseLabel = `Screenshots created at ${createdAt}`;
  const title = failedCount > 0
    ? `${baseLabel}. ${failedCount} screenshot(s) failed.`
    : baseLabel;

  return {
    state: failedCount > 0 ? "done_with_errors" : "done",
    label: baseLabel,
    title
  };
}

function screenshotJobSuccessMessage(job) {
  const created = Number(job?.createdCount || 0);
  const failed = Number(job?.failedCount || 0);
  const total = Number(job?.totalCount || created + failed);
  const dir = String(job?.screenshotsDirAbs || "").trim();
  const summary = failed > 0
    ? `Created ${created}/${total || created + failed} screenshot(s), ${failed} failed.`
    : `Created ${created} screenshot(s).`;
  return dir ? `${summary} ${dir}` : summary;
}

function finishScreenshotJob(job) {
  clearScreenshotJobPollTimer();
  activeScreenshotJobId = "";
  const finishedAppId = activeScreenshotAppId;
  activeScreenshotAppId = "";
  screenshotsInFlight = false;

  if (job?.status === "failed") {
    updatePortfolioScreenshotStatusUi(finishedAppId, {
      state: "idle",
      label: "Create screenshots",
      title: "Create screenshots"
    }).catch(() => { });
    showMessageBox({
      title: "Create screenshots failed",
      severity: "error",
      message: String(job?.errorMessage || job?.message || "Unknown error"),
      details: job?.errorDetails || job
    });
    setStatus("Create screenshots failed.");
    return;
  }

  updatePortfolioScreenshotStatusUi(finishedAppId, buildFinishedScreenshotStatus(job)).catch(() => { });
  loadAppViewScreenshots(finishedAppId).catch((error) => {
    console.warn("App view screenshots refresh failed:", error);
  });
  setStatus(screenshotJobSuccessMessage(job));
}

function scheduleScreenshotJobPoll(jobId, delayMs = 800) {
  clearScreenshotJobPollTimer();
  screenshotJobPollTimer = window.setTimeout(() => {
    fetchScreenshotJob(jobId)
      .then((job) => {
        if (String(job?.jobId || "") !== activeScreenshotJobId) return;

        if (job?.status === "queued" || job?.status === "running") {
          scheduleScreenshotJobPoll(jobId, 900);
          return;
        }

        finishScreenshotJob(job);
      })
      .catch((error) => {
        screenshotsInFlight = false;
        activeScreenshotJobId = "";
        clearScreenshotJobPollTimer();
        showCreateScreenshotsFailed(error);
      });
  }, Math.max(250, Number(delayMs || 0)));
}

/** Fetch `/apps` and return its `apps` array (throws on HTTP errors). */
async function fetchAppsOrThrow() {
  const data = await fetchJson("/apps");
  return data?.apps || [];
}

/**
 * Choose the app id that should be selected after loading the app config.
 * Priority:
 *  1) previously selected app stored in shared UI state
 *  2) first app from the backend
 */
function chooseInitialAppId(apps = getApps()) {
  const remembered = getSelectedAppId();
  if (remembered && (apps || []).some((app) => String(app?.id || "") === remembered)) {
    return remembered;
  }
  return String(apps?.[0]?.id || "");
}

function resolveSelectedAppId(appId) {
  const nextId = normalizeAppId(appId);
  if (!nextId) return "";
  return hasApp(nextId) ? nextId : "";
}

function applySelectedApp(appId) {
  const nextId = resolveSelectedAppId(appId);
  setSelectedAppId(nextId);
  selectedNode = null;
  renderInfoPanel(null);
  requestDefaultReadmeForApp(nextId);
  clearAnalyzeStatusUi();
  syncAppViewPanel(nextId);
  loadLatestCsvForApp(nextId).catch((e) => console.warn("Latest CSV load failed:", e));
  loadSelectedAppInfo().catch((e) => console.warn("App info load failed:", e));
}

function safeRunAnalysis() {
  runAnalysis().catch((e) => console.error(e));
}

function showRestartFailed(e) {
  console.error("Restart failed:", e);
  showMessageBox({
    title: "Restart failed",
    severity: "error",
    message: String(e?.message || e || "Unknown error"),
    details: { status: e?.status, code: e?.code, details: e?.details },
  });
  setStatus("Restart failed.");
}

function handleOpenAction(url) {
  openWebsite(url);
}

function handleRestartAction(appId) {
  setStatus("Restarting…");
  restartApp(appId)
    .then(() => {
      if (appId === getSelectedAppId()) {
        syncAppViewPanel(appId);
        loadSelectedAppInfo().catch(() => { });
      }

      window.setTimeout(() => {
        renderAllProjectsOverview().catch(() => { });
        if (appId === getSelectedAppId()) {
          syncAppViewPanel(appId);
        }
      }, 1200);
    })
    .catch(showRestartFailed);
}

function handleAnalyzeAction(appId) {
  applySelectedApp(appId);
  safeRunAnalysis();
}

function handleFreezeAction(appId) {
  applySelectedApp(appId);
  runFreeze().catch((e) => console.error(e));
}

function showCreateScreenshotsFailed(error) {
  clearScreenshotJobPollTimer();
  const failedAppId = activeScreenshotAppId;
  activeScreenshotJobId = "";
  activeScreenshotAppId = "";
  screenshotsInFlight = false;
  updatePortfolioScreenshotStatusUi(failedAppId, {
    state: "idle",
    label: "Create screenshots",
    title: "Create screenshots"
  }).catch(() => { });
  console.error("Create screenshots failed:", error);
  showMessageBox({
    title: "Create screenshots failed",
    severity: "error",
    message: String(error?.message || error || "Unknown error"),
    details: error?.details
  });
  setStatus("Create screenshots failed.");
}

function handleCreateScreenshotsAction(appId) {
  const id = normalizeAppId(appId);
  if (!id) return;

  applySelectedApp(id);
  if (screenshotsInFlight) {
    setStatus("Create screenshots already running…");
    return;
  }

  screenshotsInFlight = true;
  activeScreenshotAppId = id;
  setStatus("Creating screenshots…");
  updatePortfolioScreenshotStatusUi(id, buildRunningScreenshotStatus()).catch(() => { });

  createScreenshotsApp(id)
    .then((data) => {
      const job = data?.job || data;
      activeScreenshotJobId = String(data?.jobId || job?.jobId || "").trim();
      if (!activeScreenshotJobId) {
        throw new Error("Screenshot job did not return a job id.");
      }
      scheduleScreenshotJobPoll(activeScreenshotJobId, 250);
    })
    .catch(showCreateScreenshotsFailed)
    .finally(() => {
      if (!activeScreenshotJobId) {
        screenshotsInFlight = false;
      }
    });
}

function handlePortfolioAppActionEvent(ev) {
  const detail = ev?.detail || {};
  const action = String(detail.action || "");
  const appId = normalizeAppId(detail.appId);
  const url = String(detail.url || "");

  const handlers = {
    select: () => applySelectedApp(appId),
    open: () => handleOpenAction(url),
    restart: () => handleRestartAction(appId),
    analyze: () => handleAnalyzeAction(appId),
    freeze: () => handleFreezeAction(appId),
    screenshots: () => handleCreateScreenshotsAction(appId),
  };

  handlers[action]?.();
}

function handleActiveAppChangedEvent(ev) {
  const appId = normalizeAppId(ev?.detail?.appId);
  syncPortfolioSelectionUi(appId).catch((e) => console.warn("Portfolio refresh failed:", e));
}

function bindCrossViewEvents() {
  if (crossViewEventsBound) return;
  crossViewEventsBound = true;

  document.addEventListener(PORTFOLIO_APP_ACTION_EVENT, handlePortfolioAppActionEvent);
  document.addEventListener(ACTIVE_APP_CHANGED_EVENT, handleActiveAppChangedEvent);
}

/**
 * Lädt die App-Presets vom Backend (`/apps`) und synchronisiert den Shared State.
 *
 * Ablauf
 * ------
 * 1) `/apps` laden
 * 2) In den Shared State schreiben
 * 3) Auswahl festlegen (gemerkte Auswahl oder erstes Preset)
 * 4) App-Zustand und abhängige Panels synchronisieren
 * 5) Letzten gespeicherten Graph-Stand der Auswahl laden
 */
async function fetchAndStoreApps() {
  const apps = await fetchAppsOrThrow();
  setApps(apps);
  return apps;
}

function applyEmptyAppsState() {
  setApps([]);
  applySelectedApp("");
}

function applyInitialAppSelection(apps) {
  const current = chooseInitialAppId(apps);
  applySelectedApp(current);

  loadLatestRenderedGraphForApp(current).catch((e) => console.warn("Stored graph bootstrap failed:", e));
}

async function loadApps() {
  let apps = [];

  try {
    apps = await fetchAndStoreApps();
  } catch (e) {
    console.warn("Failed to load apps:", e);
    applyEmptyAppsState();
    return;
  }

  if (!apps.length) {
    applyEmptyAppsState();
    return;
  }

  applyInitialAppSelection(apps);
}

/* ======================================================================= */
/* Live change feed (SSE)                                                  */
/* ======================================================================= */


let currentRunToken = null;

// `currentRunToken` identifies the currently active analysis run.
//
// Why we track it
// ---------------
// SSE events are asynchronous and may arrive slightly late. Without a run token
// guard, an `fs-change` event from an older analysis could mark nodes in the
// graph that is currently visible, which would be misleading.
//
// Where it comes from
// -------------------
// - `hello` event:    `msg.activeAnalysis.runToken`
// - `analysis` event: `msg.runToken`
//
// Filtering rule
// --------------
// Ignore an `fs-change` event only when BOTH tokens exist and differ.
// If either side is missing, keep the event for compatibility / best effort.




/** @type {EventSource|null} */
let sse = null;

function hasToken(v) {
  return Boolean(String(v || "").trim());
}

function isStaleRunToken(currentToken, msgToken) {
  // Nur filtern, wenn BEIDE Tokens existieren (sonst best-effort kompatibel bleiben).
  if (!hasToken(currentToken)) return false;
  if (!hasToken(msgToken)) return false;
  return String(msgToken) !== String(currentToken);
}

function shouldIgnoreFsChange(msg, currentToken) {
  return isStaleRunToken(currentToken, msg?.runToken);
}

function parseEventPayload(ev) {
  try {
    return JSON.parse(ev?.data || "{}");
  } catch {
    return null;
  }
}

function updateCurrentRunToken(nextToken) {
  currentRunToken = nextToken || null;
}

function syncRunTokenFromEvent(ev, readToken) {
  const payload = parseEventPayload(ev);
  if (!payload) return;
  updateCurrentRunToken(readToken(payload));
}

function markGraphNodeChanged(msg) {
  try {
    graphController?.markChanged?.({ id: msg.id, ev: msg.ev, at: msg.at });
  } catch { }
}

function refreshSelectedNodeAfterFsChange(msg) {
  if (!isSelectedNodeMessage(msg)) return;
  refreshSelectedPanels();
}

function handleFsChangePayload(msg) {
  if (!msg || shouldIgnoreFsChange(msg, currentRunToken)) return;
  markGraphNodeChanged(msg);
  refreshSelectedNodeAfterFsChange(msg);
}

function handleFsChangeEvent(ev) {
  handleFsChangePayload(parseEventPayload(ev));
}

function handleFsWatchErrorEvent(ev) {
  const payload = parseEventPayload(ev);
  if (payload) {
    console.warn("[SSE] fs-watch-error:", payload?.message || payload);
    return;
  }

  console.warn("[SSE] fs-watch-error:", ev?.data);
}


/**
 * Start the shared SSE connection once.
 *
 * Event handling responsibilities:
 * - `hello` / `analysis`: refresh the current run token
 * - `fs-change`: mark changed nodes in the current graph and refresh panels
 *   if the selected node was affected
 * - `fs-watch-error`: log watcher problems without breaking the UI
 */
function startLiveEvents() {
  if (sse) return;

  sse = new EventSource("/events");

  sse.addEventListener("hello", (ev) => syncRunTokenFromEvent(ev, (msg) => msg?.activeAnalysis?.runToken || null));
  sse.addEventListener("analysis", (ev) => syncRunTokenFromEvent(ev, (msg) => msg?.runToken || null));
  sse.addEventListener("fs-change", handleFsChangeEvent);
  sse.addEventListener("fs-watch-error", handleFsWatchErrorEvent);

  sse.onerror = () => {
    // EventSource auto-reconnects; keep UI calm
  };
}

/* ======================================================================= */
/* Analyze action                                                           */
/* ======================================================================= */

let analyzeInFlight = false;
let analyzePending = false;

function requestAnalyzeRerun() {
  analyzePending = true;
}

function tryBeginAnalysis() {
  if (analyzeInFlight) {
    requestAnalyzeRerun();
    return false;
  }

  analyzeInFlight = true;
  analyzePending = false;
  return true;
}

function finishAnalysisAndMaybeRerun(runFn) {
  analyzeInFlight = false;

  if (!analyzePending) return;
  analyzePending = false;

  // Re-run once after the current run finishes.
  runFn().catch((err) => console.error(err));
}

function getSelectedAppIdOrShowStatus() {
  const appId = getSelectedAppId();
  if (appId) return appId;
  setStatus("Select an app first.");
  return "";
}

async function postAnalyze(appId) {
  return fetchJson("/analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appId }),
  });
}

async function postFreeze(appId) {
  return fetchJson("/freeze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appId }),
  });
}

function isUnsupportedAnalysis(data) {
  return String(data?.analysisStatus || "") === "unsupported";
}

function handleUnsupportedAnalysis(data) {
  resetGraphViews();
  showUnsupportedTargetMessage(data);
  setStatus("Unsupported target (see details).");
  setStatusSignal("error");
}

function prepareAnalysisUi() {
  setStatus("Running analysis…");
  setStatusSignal("neutral");
}

async function fetchAnalysisMetrics(data) {
  return fetchJson(data?.metricsUrl || "");
}

async function renderAnalysisMetrics(appId, metrics) {
  activeGraphAppId = appId;
  resetSupplementaryGraphViews();
  renderGraph(metrics);
  await renderSupplementaryCharts(metrics);
  updateGraphHeader(metrics);
}

async function applyAnalysisResult(appId, data) {
  if (isUnsupportedAnalysis(data)) {
    handleUnsupportedAnalysis(data);
    return false;
  }

  const metrics = await fetchAnalysisMetrics(data);
  await renderAnalysisMetrics(appId, metrics);
  statusDone(data);
  return true;
}


/**
 * Replace the current graph with a freshly rendered one.
 *
 * Important behavior:
 * - destroys any previous graph instance to stop simulations / timers
 * - clears panels because selection belongs to the previous render
 * - stores the new controller for SSE updates and later refreshes
 *
 * @param {any} metrics Analyzer metrics payload used by the D3 renderer.
 */

function clearSvgContent(id) {
  const el = byId(id);
  if (!el) return;
  el.innerHTML = "";
}

function buildGraphHeaderText(appId, metrics) {
  if (!appId || !metrics) return "Workspace";

  const stats = deriveGraphStats(metrics);
  return buildCurrentAppSummary({
    appId,
    functionCount: stats.functionCount,
    loc: stats.loc,
  });
}

function buildWorkspaceHintText(viewKey = getActiveGraphViewKey()) {
  const hasGraphApp = Boolean(getActiveGraphAppId());
  const hasSelectedApp = Boolean(getSelectedAppId());
  const missingAppText = "Select an app to inspect details.";

  switch (String(viewKey || "")) {
    case "app-view":
      return hasSelectedApp ? "Live iframe preview for the selected app." : missingAppText;
    case "portfolio":
      return "Portfolio trends and app-level review priorities.";
    case "overview":
      return hasSelectedApp ? "Entry point, URL and project roots for the selected app." : missingAppText;
    case "git":
      return hasSelectedApp ? "Repository state, branch tracking and worktree health." : missingAppText;
    case "freeze":
      return hasSelectedApp ? "Freeze archive output and latest snapshot metadata." : missingAppText;
    default:
      if (hasGraphApp) return "Accordion with structure, MRI, drift and Git history for the active app.";
      if (hasSelectedApp) return "Run Analyze to inspect the graph.";
      return "Select an app, then run Analyze.";
  }
}

function updateWorkspaceHintForView(viewKey = getActiveGraphViewKey()) {
  setTextById("workspaceHint", buildWorkspaceHintText(viewKey));
}

function updateGraphHeader(metrics) {
  const graphAppId = getActiveGraphAppId();

  setTextById("graphInfoHeader", buildGraphHeaderText(graphAppId, metrics));
  updateWorkspaceHintForView();
}

function activateTabById(id) {
  const el = byId(id);
  const tabApi = window.bootstrap?.Tab;
  if (!el || !tabApi?.getOrCreateInstance) return;
  tabApi.getOrCreateInstance(el).show();
}

function resetGraphViews() {
  try { graphController?.destroy?.(); } catch { }
  try { graphMriController?.destroy?.(); } catch { }
  try { graphTimeController?.destroy?.(); } catch { }

  graphController = null;
  graphMriController = null;
  graphTimeController = null;
  activeGraphAppId = "";
  selectedNode = null;
  clearPanels();
  clearSvgContent("codeStructureSvg");
  clearSvgContent("graphMriView");
  clearSvgContent("graphTimeView");
  updateGraphHeader(null);
  syncGraphZoomUi();
  renderInfoPanel(null);
  requestDefaultReadmeForApp(getSelectedAppId());
}

function renderGraph(metrics) {
  // Clean up any previous graph instance (stops simulation + clears svg)
  try { graphController?.destroy?.(); } catch { }

  clearPanels();
  selectedNode = null;

  // Init renderer and keep the controller so we can:
  // - mark changed nodes from SSE
  // - access the latest rendered nodes for panel refresh
  graphController = initcodeStructureChart("codeStructureSvg", metrics, {
    onNodeSelected
  });
  applyGraphsZoom(graphZoomScale);
  syncGraphZoomUi();
  renderInfoPanel(null);
  requestDefaultReadmeForApp(getSelectedAppId());
}

function resetSupplementaryGraphViews() {
  try { graphMriController?.destroy?.(); } catch { }
  try { graphTimeController?.destroy?.(); } catch { }

  graphMriController = null;
  graphTimeController = null;
  clearSvgContent("graphMriView");
  clearSvgContent("graphTimeView");
  syncGraphZoomUi();
}

/**
 * Render optional secondary graph views for the currently selected app.
 *
 * Why this is loaded dynamically
 * ------------------------------
 * The main UI must keep working even when an experimental graph module is
 * missing or not yet implemented. Therefore optional views are imported lazily
 * and treated as best-effort enhancements.
 */

function hasElement(id) {
  return Boolean(byId(id));
}

function getActiveGraphAppIdOrNull() {
  const appId = getActiveGraphAppId();
  return appId || "";
}

function pickChartRenderer(mod, preferredName, fallbackName) {
  return mod?.[preferredName] || mod?.[fallbackName] || mod?.default || null;
}

async function renderOptionalChart({
  elementId,
  modulePath,
  preferredName,
  fallbackName,
  warningLabel,
  metrics,
}) {
  if (!hasElement(elementId)) return;

  const appId = getActiveGraphAppIdOrNull();
  if (!appId) return;

  try {
    const mod = await import(modulePath);
    const renderFn = pickChartRenderer(mod, preferredName, fallbackName);

    if (typeof renderFn !== "function") {
      console.warn(`${modulePath} loaded, but no render function was exported.`);
      return;
    }

    return await renderFn(elementId, { appId, metrics });
  } catch (e) {
    console.warn(`${warningLabel} render skipped:`, e);
    return null;
  }
}

async function renderTimeViewChart(metrics) {
  graphTimeController = await renderOptionalChart({
    elementId: "graphTimePanel",
    modulePath: "./graph_timeView.js",
    preferredName: "initGraphTimeView",
    fallbackName: "renderGraphTimeView",
    warningLabel: "Drift history",
    metrics,
  });
  applyGraphsZoom(graphZoomScale);
  syncGraphZoomUi();
}

async function renderMriViewChart(metrics) {
  graphMriController = await renderOptionalChart({
    elementId: "graphMriView",
    modulePath: "./graph_mriView.js",
    preferredName: "initGraphMriView",
    fallbackName: "renderGraphMriView",
    warningLabel: "MRI view",
    metrics,
  });
  applyGraphsZoom(graphZoomScale);
  syncGraphZoomUi();
}

async function renderSupplementaryCharts(metrics) {
  await renderTimeViewChart(metrics);
  await renderMriViewChart(metrics);
}

function pickNodes(metrics) {
  return metrics?.nodes || metrics?.data?.nodes || [];
}

function countFunctions(nodes) {
  let count = 0;
  for (const n of nodes || []) {
    if (String(n?.kind || n?.type) === "function") count++;
  }
  return count;
}

function sumLoc(nodes) {
  let loc = 0;
  for (const n of nodes || []) {
    loc += Number(n?.lines ?? n?.locLines ?? 0) || 0;
  }
  return loc;
}

function setTextById(id, text) {
  const el = maybeById(id);
  if (!el) return false;
  el.textContent = String(text || "");
  return true;
}

function compactStat(label, value) {
  return `${label} ${Number(value || 0)}`;
}

function joinHeaderParts(parts) {
  return (parts || []).filter(Boolean).join(" · ");
}

function buildCurrentAppSummary(cfg = {}) {
  return joinHeaderParts([
    String(cfg.appLabel || cfg.appId || "Current app"),
    compactStat("ƒ", cfg.functionCount),
    compactStat("LOC", cfg.loc),
  ]);
}

function deriveGraphStats(metrics) {
  const nodes = pickNodes(metrics);
  return {
    functionCount: countFunctions(nodes),
    loc: sumLoc(nodes),
  };
}

function updateTextSummary(targetId, buildText) {
  try {
    const text = typeof buildText === "function" ? buildText() : "";
    if (!text) return false;
    return setTextById(targetId, text);
  } catch {
    return false;
  }
}

function syncAnalyzeArtifactUi(data) {
  const changed = data?.artifacts?.csvChanged;
  setLatestCsvName(data?.artifacts?.latestCsvFilename || "");

  if (changed === true) {
    setStatusSignal("changed");
    return;
  }

  if (changed === false) {
    setStatusSignal("unchanged");
    return;
  }

  setStatusSignal("neutral");
}

function statusDone(data) {
  setStatus(`Done. Nodes: ${data.summary?.nodes ?? "?"}, Links: ${data.summary?.links ?? "?"}`);
  syncAnalyzeArtifactUi(data);
  renderAllProjectsOverview().catch((e) => console.warn("Portfolio refresh failed:", e));
}

function handleAnalyzeError(e) {
  console.error("Analyze failed:", e);
  showMessageBox({
    title: "Analyze failed",
    severity: "error",
    message: String(e?.message || e || "Unknown error"),
    details: {
      status: e?.status,
      code: e?.code,
      details: e?.details,
    },
  });
  setStatus("Analysis failed.");
  setStatusSignal("error");
}

function handleFreezeError(e) {
  console.error("Freeze failed:", e);
  showMessageBox({
    title: "Freeze failed",
    severity: "error",
    message: String(e?.message || e || "Unknown error"),
    details: {
      status: e?.status,
      code: e?.code,
      details: e?.details,
    },
  });
  setStatus("Freeze failed.");
}

async function runFreeze() {
  if (freezeInFlight) return;

  const appId = getSelectedAppIdOrShowStatus();
  if (!appId) return;

  freezeInFlight = true;

  try {
    setStatus("Creating freeze…");
    const data = await postFreeze(appId);
    const zipPath = String(data?.freeze?.zipPath || "").trim();

    setStatus(zipPath ? `Freeze created: ${zipPath}` : "Freeze created.");
    await loadSelectedAppInfo();
    activateTabById("app-freeze-tab");
  } catch (e) {
    handleFreezeError(e);
  } finally {
    freezeInFlight = false;
  }
}


/**
 * Run analysis for the currently selected app and redraw the UI.
 *
 * Flow:
 * 1) guard against overlapping runs
 * 2) read selected app id from DOM state
 * 3) POST `/analyze`
 * 4) handle unsupported targets explicitly
 * 5) fetch the produced metrics JSON
 * 6) rerender graph + summary
 *
 * Concurrency note:
 * Multiple rapid triggers (e.g. repeated app clicks or restart follow-ups)
 * are coalesced through `analyzeInFlight` / `analyzePending` so we never run
 * more than one analyze request at the same time.
 */
async function runAnalysis() {
  if (!tryBeginAnalysis()) return;

  try {
    const appId = getSelectedAppIdOrShowStatus();
    if (!appId) return;

    prepareAnalysisUi();
    const data = await postAnalyze(appId);
    // Important:
    // `data.runToken` belongs to the analyze/metrics flow, not to the active
    // SSE stream state. The live event token is updated only from SSE events,
    // so we intentionally do NOT overwrite `currentRunToken` here.
    await applyAnalysisResult(appId, data);
  } catch (e) {
    handleAnalyzeError(e);
  } finally {
    finishAnalysisAndMaybeRerun(runAnalysis);
  }
}

/* ======================================================================= */
/* Bootstrap                                                                */
/* ======================================================================= */


/**
 * Bootstrap the browser UI once the document is ready.
 *
 * Order matters:
 * 1) verify side panels exist
 * 2) initialize static headers
 * 3) start SSE early so live events are available
 * 4) load apps and restore the latest stored graph for the default selection
 */
function init() {
  ensurePanelsExist();
  bindGraphZoomUi();
  bindCrossViewEvents();
  updateShellTitle("");
  setLatestCsvName("");
  setStatusSignal("neutral");
  updateGraphHeader(null);
  startLiveEvents();
  renderAllProjectsOverview().catch((e) => console.warn("Portfolio init failed:", e));
  syncAppViewPanel("");
  loadApps();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();

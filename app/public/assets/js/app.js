/* public/assets/js/app.js (ESM)
 * ============================================================================
 * NodeAnalyzer UI bootstrap / page controller
 * ============================================================================
 *
 * This module wires the browser UI together. It does not parse code itself;
 * instead it orchestrates the backend + graph renderer:
 *
 * - loads configured apps from `/apps`
 * - stores the current selection in hidden DOM state (`#appSelect`)
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
 * - The selected app is intentionally stored in the DOM, not in a separate
 *   global variable, so UI state stays inspectable and resilient to re-renders.
 * - The graph renderer is treated like a controller object that can be replaced
 *   after each analyze run.
 *
 * Expected DOM
 * ------------
 * - #appList
 * - #appSelect (hidden input)
 * - #status
 * - #appInfoPanel
 * - #codeStructureSvg
 */

"use strict";

import { initcodeStructureChart } from "./d3_codeStructure.js";




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
let graphZoomUiBound = false;
let graphZoomTabsBound = false;
let latestCsvLoadToken = 0;
let allProjectsLoadToken = 0;
let crossViewEventsBound = false;

const SHELL_TITLE_BASE = "NodeAnalyzer";
const PORTFOLIO_APP_ACTION_EVENT = "nodeanalyzer:portfolio-app-action";
const ACTIVE_APP_CHANGED_EVENT = "nodeanalyzer:active-app-changed";

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

/** Minimal HTML escape for safe innerHTML templating. */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
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

function latestFilenameFromOutputFiles(files) {
  const list = Array.isArray(files) ? files : [];
  return String(list[list.length - 1] || "").trim();
}

async function fetchLatestCsvFilename(appId) {
  const id = encodeURIComponent(String(appId || ""));
  const files = await fetchJson(`/api/output-files?appId=${id}&type=code-metrics`);
  return latestFilenameFromOutputFiles(files);
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
  if (byId("workspace-app-tab")?.classList.contains("active")) return "app";
  if (byId("graph-MRI-tab")?.classList.contains("active")) return "mri";
  if (byId("graph-time-tab")?.classList.contains("active")) return "time";
  if (byId("graph-projects-tab")?.classList.contains("active")) return "projects";
  return "main";
}

function getActiveGraphViewLabel() {
  const activeTab = getGraphViewTabs().find((tab) => tab.classList.contains("active"));
  return String(activeTab?.textContent || "Standard graph").trim();
}

function updateGraphZoomTargetLabel() {
  setTextById("graphZoomTarget", getActiveGraphViewLabel());
}

function getGraphZoomToolbar() {
  return byId("graphZoomToolbar");
}

function getGraphToolsAccordion() {
  return byId("graphToolsAccordion");
}

function viewSupportsZoom(viewKey = "main") {
  return viewKey === "main" || viewKey === "mri" || viewKey === "time";
}

function viewSupportsGraphTools(viewKey = "main") {
  return viewKey === "main";
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

function getGraphControllerByView(viewKey = "main") {
  switch (String(viewKey || "")) {
    case "mri":
      return graphMriController;
    case "time":
      return graphTimeController;
    case "projects":
    case "app":
      return null;
    default:
      return graphController;
  }
}

function getActiveGraphZoomController() {
  return getGraphControllerByView(getActiveGraphViewKey());
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
    updateGraphZoomUi(1, true);
    return;
  }

  const scale = getActiveGraphZoomController()?.getZoom?.();
  if (Number.isFinite(scale)) {
    updateGraphZoomUi(scale, false);
    return;
  }

  updateGraphZoomUi(1, true);
}

function handleGraphZoomInput(ev) {
  const slider = ev?.target;
  if (!(slider instanceof HTMLInputElement)) return;

  const controller = getActiveGraphZoomController();
  if (!controller?.setZoom) {
    updateGraphZoomUi(1, true);
    return;
  }

  const requestedScale = Number(slider.value) / 100;
  const appliedScale = controller.setZoom(requestedScale);
  updateGraphZoomUi(appliedScale, false);
}

function bindGraphZoomUi() {
  const slider = getGraphZoomSlider();
  if (slider && !graphZoomUiBound) {
    slider.addEventListener("input", handleGraphZoomInput);
    graphZoomUiBound = true;
  }

  if (!graphZoomTabsBound) {
    for (const tab of getGraphViewTabs()) {
      tab.addEventListener("shown.bs.tab", syncGraphZoomUi);
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

/**
 * Fetch JSON and throw on non-2xx.
 * @param {string} url
 * @param {RequestInit} [init]
 */
async function fetchJson(url, init) {
  const r = await fetch(url, init);
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    const err = new Error(text || `HTTP ${r.status}`);
      /** @type {any} */ (err).status = r.status;
    throw err;
  }
  return r.json();
}

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

function getActiveGraphAppId() {
  return String(activeGraphAppId || "").trim();
}

function toDisplayText(value, fallback = "—") {
  const text = String(value || "").trim();
  return text || fallback;
}

function formatIsoDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "—";

  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return raw;
  return date.toLocaleString();
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";

  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const digits = size >= 10 || unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(digits)} ${units[unitIndex]}`;
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

function renderAppInfoSectionPanel(section) {
  return `
    <section class="appInfoSection appInfoTabPanel">
      <div class="appInfoSectionTitle">${esc(section.title)}</div>
      ${String(section.contentHtml || "")}
    </section>
  `;
}

function renderAppInfoSectionTabs(sections) {
  const navItems = sections
    .map((section, index) => {
      const active = index === 0 ? " active" : "";
      const selected = index === 0 ? "true" : "false";
      const shown = index === 0 ? " show active" : "";
      const tabId = `app-info-${section.id}-tab`;
      const paneId = `app-info-${section.id}-pane`;

      return {
        nav: `
          <li class="nav-item" role="presentation">
            <button class="nav-link small${active}" id="${tabId}" data-bs-toggle="tab"
              data-bs-target="#${paneId}" type="button" role="tab" aria-controls="${paneId}"
              aria-selected="${selected}">
              ${esc(section.title)}
            </button>
          </li>
        `,
        pane: `
          <div class="tab-pane fade${shown}" id="${paneId}" role="tabpanel" aria-labelledby="${tabId}" tabindex="0">
            ${renderAppInfoSectionPanel(section)}
          </div>
        `
      };
    });

  return `
    <div class="appInfoTabs">
      <ul class="nav nav-tabs appInfoTabsNav" role="tablist">
        ${navItems.map((item) => item.nav).join("")}
      </ul>
      <div class="tab-content appInfoTabsContent">
        ${navItems.map((item) => item.pane).join("")}
      </div>
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

function renderAppInfoEmpty(message) {
  const root = byId("appInfoPanel");
  if (!root) return;
  root.innerHTML = `<div class="text-secondary small">${esc(message)}</div>`;
}

function renderAppInfoPanel(data) {
  const root = byId("appInfoPanel");
  if (!root) return;

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
      id: "commits",
      title: "Commits",
      contentHtml: renderCommitsTable(commits, git.available)
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

  root.innerHTML = `
    <div class="appInfoShell">
      <div>
        <div class="h5 mb-1">${esc(app.name || app.id || "App")}</div>
        <div class="small text-secondary">${esc(app.id || "")}</div>
      </div>
      ${renderAppInfoSectionTabs(sections)}
    </div>
  `;
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

function markdownToHtml(md) {
  const text = String(md || "");
  return window.marked?.parse ? window.marked.parse(text) : `<pre>${esc(text)}</pre>`;
}

function sanitizeHtml(rawHtml) {
  return window.DOMPurify?.sanitize ? window.DOMPurify.sanitize(rawHtml) : rawHtml;
}

function renderReadmeMarkdown(root, data) {
  const md = String(data?.markdown || "");
  const rawHtml = markdownToHtml(md);
  const safeHtml = sanitizeHtml(rawHtml);
  const readmePath = String(data?.readmePath || "").trim();

  setReadmeSummary(readmePath || "README");

  root.innerHTML = `
      <div class="small text-secondary mb-2">${esc(readmePath)}</div>
      <div class="content markdown">${safeHtml}</div>
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

  renderReadmeMarkdown(root, data);
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

  renderReadmeMarkdown(root, data);
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
/* Apps list + Actions (Restart / Show Website)                             */
/* ======================================================================= */

/**
 * Persist currently selected app id in the hidden `#appSelect` input.
 *
 * Why this exists
 * ---------------
 * We deliberately keep the selected app as DOM state (a hidden input) instead of
 * relying on a module-global variable. This makes selection:
 * - stable across re-renders,
 * - easy to inspect in DevTools,
 * - the single source of truth for `runAnalysis()`.
 *
 * Contract
 * --------
 * - `#appSelect` MUST exist in index.html:
 *     <input type="hidden" id="appSelect" value="">
 * - The value stored here is the *app id* from `/apps` (config id), e.g. "vscode".
 *
 * @param {string} appId Config id of the selected app.
 */
function setSelectedAppId(appId) {
  const nextId = String(appId || "").trim();
  const hidden = /** @type {HTMLInputElement|null} */ (byId("appSelect"));
  if (!hidden) {
    updateShellTitle(nextId);
    emitActiveAppChanged(nextId);
    return;
  }

  // Always store a string (defensive). Empty string means "no selection".
  const previousId = String(hidden.value || "").trim();
  hidden.value = nextId;
  updateShellTitle(nextId);

  if (nextId !== previousId) {
    emitActiveAppChanged(nextId);
  }
}

/**
 * Read the currently selected app id from `#appSelect`.
 *
 * Note
 * ----
 * Keep this as a helper even though it's one line: it prevents copy/paste
 * mistakes and makes it obvious where selection is sourced from.
 *
 * @returns {string} Current selected app id (trimmed). Empty string if none.
 */
function getSelectedAppId() {
  const hidden = /** @type {HTMLInputElement} */ (byId("appSelect"));
  return String(hidden?.value || "").trim();
}

/**
 * Visually mark the active app row in the internal app list.
 *
 * Implementation
 * --------------
 * - Rows are created by `loadApps()` with:
 *     - class `.appRow`
 *     - `data-app-id="..."`
 * - We toggle `.isActive` purely for styling (CSS), *not* for behavior.
 * - Selection behavior is driven by `#appSelect` + `runAnalysis()`.
 *
 * @param {HTMLElement} listEl Container element that holds the `.appRow` elements.
 * @param {string} appId App id that should be shown as selected.
 */
function setAppActiveRow(listEl, appId) {
  const id = String(appId || "");
  listEl.querySelectorAll(".appRow").forEach((el) => {
    el.classList.toggle("isActive", el.dataset.appId === id);
  });
}

function isActionClick(ev) {
  const t = /** @type {HTMLElement|null} */ (ev?.target || null);
  if (!t) return false;
  return !!t.closest?.("[data-action], .appActions");
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

/* ----------------------------------------------------------------------- */
/* Apps list helpers                                                       */
/* ----------------------------------------------------------------------- */

/** Render a compact status/placeholder message inside the apps list. */
function renderAppListMessage(list, html) {
  list.innerHTML = String(html || "");
}

/** Fetch `/apps` and return its `apps` array (throws on HTTP errors). */
async function fetchAppsOrThrow() {
  const data = await fetchJson("/apps");
  return data?.apps || [];
}

/**
 * Choose the app id that should be selected after loading the list.
 * Priority:
 *  1) previously selected app stored in the hidden `#appSelect`
 *  2) first app from the backend
 */
function chooseInitialAppId(apps) {
  const remembered = getSelectedAppId();
  if (remembered && (apps || []).some((app) => String(app?.id || "") === remembered)) {
    return remembered;
  }
  return String(apps?.[0]?.id || "");
}

function applySelectedApp(listEl, appId) {
  setSelectedAppId(appId);
  if (listEl) setAppActiveRow(listEl, appId);
  selectedNode = null;
  renderInfoPanel(null);
  requestDefaultReadmeForApp(appId);
  clearAnalyzeStatusUi();
  loadLatestCsvForApp(appId).catch((e) => console.warn("Latest CSV load failed:", e));
  loadSelectedAppInfo().catch((e) => console.warn("App info load failed:", e));
}

/** Render the static header row (column labels). */
function renderAppsHeader(list) {
  list.innerHTML = `
      <div class="appHdr">
        <div></div>
        <div>Name</div>
        <div class="appActionsHdr">Actions</div>
      </div>
    `;
}

/**
 * Build one `.appRow` element.
 * - Stores app id + url as data-* for delegated click handling.
 * - Escapes all user-visible values used in innerHTML.
 */
function buildAppRow(app, currentId) {
  const a = app || {};

  const id = String(a.id || "");
  const name = String(a.name || a.id || "");
  const url = String(a.url || "");

  const row = document.createElement("div");
  row.className = "appRow" + (id === currentId ? " isActive" : "");
  row.setAttribute("role", "listitem");

  row.dataset.appId = id;
  row.dataset.appUrl = url;

  row.innerHTML = `
      <span class="appDot" aria-hidden="true"></span>
      <div class="appPrimary">
        <div class="appName" title="${esc(name)}">${esc(name)}</div>
        <div class="appMeta" title="${esc(id)}">${esc(id)}</div>
      </div>

      <div class="appActions">
        <button type="button" class="btn btn-sm btn-outline-secondary"
                data-action="restart" data-app-id="${esc(id)}">
          Restart
        </button>
        <button type="button" class="btn btn-sm btn-outline-primary"
                data-action="open" data-url="${esc(url)}">
          Show
        </button>
        <button type="button" class="btn btn-sm btn-primary"
                data-action="analyze" data-app-id="${esc(id)}">
          Analyze
        </button>
        <button type="button" class="btn btn-sm btn-outline-primary"
                data-action="freeze" data-app-id="${esc(id)}">
          Freeze
        </button>
      </div>
    `;

  return row;
}

/** Render all apps below the header. */
function renderAppRows(list, apps, currentId) {
  for (const a of apps || []) {
    list.appendChild(buildAppRow(a, currentId));
  }
}

/* ----------------------------------------------------------------------- */
/* Delegated click handling (defined once, not recreated per loadApps run)  */
/* ----------------------------------------------------------------------- */

function getClosestActionButton(target) {
  return /** @type {HTMLElement|null} */ (target?.closest?.("[data-action]") || null);
}

function getClosestAppRow(target) {
  return /** @type {HTMLElement|null} */ (target?.closest?.(".appRow") || null);
}

function getAttr(el, name) {
  return String(el?.getAttribute?.(name) || "");
}

function getDataset(el, key) {
  return String(el?.dataset?.[key] || "");
}

function safeRunAnalysis() {
  runAnalysis().catch((e) => console.error(e));
}

function getActionContext(btn) {
  const action = getAttr(btn, "data-action");
  const row = getClosestAppRow(btn);
  const list = /** @type {HTMLElement|null} */ (row?.parentElement || null);

  const appId = getAttr(btn, "data-app-id") || getDataset(row, "appId");
  const url = getAttr(btn, "data-url") || getDataset(row, "appUrl");

  return { action, appId, url, list };
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
    .then(() => loadSelectedAppInfo().catch(() => { }))
    .catch(showRestartFailed);
}

function handleAnalyzeAction(listEl, appId) {
  applySelectedApp(listEl, appId);
  safeRunAnalysis();
}

function handleFreezeAction(listEl, appId) {
  applySelectedApp(listEl, appId);
  runFreeze().catch((e) => console.error(e));
}

function handlePortfolioAppActionEvent(ev) {
  const detail = ev?.detail || {};
  const action = String(detail.action || "");
  const appId = normalizeAppId(detail.appId);
  const url = String(detail.url || "");
  const listEl = byId("appList");

  if (action === "select") {
    applySelectedApp(listEl, appId);
    return;
  }

  if (action === "open") {
    handleOpenAction(url);
    return;
  }

  if (action === "restart") {
    handleRestartAction(appId);
    return;
  }

  if (action === "analyze") {
    handleAnalyzeAction(listEl, appId);
    return;
  }

  if (action === "freeze") {
    handleFreezeAction(listEl, appId);
  }
}

function handleActiveAppChangedEvent() {
  renderAllProjectsOverview().catch((e) => console.warn("Portfolio refresh failed:", e));
}

function bindCrossViewEvents() {
  if (crossViewEventsBound) return;
  crossViewEventsBound = true;

  document.addEventListener(PORTFOLIO_APP_ACTION_EVENT, handlePortfolioAppActionEvent);
  document.addEventListener(ACTIVE_APP_CHANGED_EVENT, handleActiveAppChangedEvent);
}

function tryHandleAppActionClick(ev, target) {
  const btn = getClosestActionButton(target);
  if (!btn) return false;

  // Button click: consume the event so the row doesn't get selected.
  ev.preventDefault();
  ev.stopPropagation();

  const ctx = getActionContext(btn);

  if (ctx.action === "open") {
    handleOpenAction(ctx.url);
    return true;
  }

  if (ctx.action === "restart") {
    handleRestartAction(ctx.appId);
    return true;
  }

  if (ctx.action === "analyze") {
    handleAnalyzeAction(ctx.list, ctx.appId);
    return true;
  }

  if (ctx.action === "freeze") {
    handleFreezeAction(ctx.list, ctx.appId);
    return true;
  }

  // Unknown action: ignore but consume.
  return true;
}

function handleAppRowSelectionClick(ev, target, listEl) {
  // Row selection: ignore clicks inside the actions area.
  if (isActionClick(ev)) return;

  const row = getClosestAppRow(target);
  if (!row) return;

  const newId = String(row.dataset.appId || "").trim();
  if (!newId) return;

  applySelectedApp(listEl, newId);
}

/**
 * Bind one delegated click handler to the list.
 * This is important because `loadApps()` may re-render the list multiple times.
 */
function ensureAppsListActionsBound(list) {
  if (list.__actionsBound) return;
  Object.defineProperty(list, "__actionsBound", { value: true });

  list.addEventListener("click", (ev) => {
    const target = /** @type {HTMLElement|null} */ (ev?.target || null);
    if (!target) return;

    if (tryHandleAppActionClick(ev, target)) return;
    handleAppRowSelectionClick(ev, target, list);
  });
}

function requestInitialAnalysis() {
  runAnalysis().catch((e) => console.error(e));
}

/**
 * Lädt die App-Presets vom Backend (`/apps`) und rendert den internen App-Zustand.
 *
 * Ablauf
 * ------
 * 1) DOM-Elemente finden (#appList, #appSelect)
 * 2) `/apps` laden
 * 3) Auswahl festlegen (gemerkte Auswahl oder erstes Preset)
 * 4) Liste rendern (Header + Rows)
 * 5) Delegierten Click-Handler einmalig binden (open/restart/select)
 * 6) App-Info für die Auswahl laden
 */
async function loadApps({ autoAnalyze = false } = {}) {
  const list = byId("appList");
  const hidden = /** @type {HTMLInputElement|null} */ (byId("appSelect"));
  if (!list || !hidden) return;

  // Sofortiges UI-Feedback.
  renderAppListMessage(list, `<div class="text-secondary small px-2 py-2">Loading…</div>`);

  let apps = [];
  try {
    apps = await fetchAppsOrThrow();
  } catch (e) {
    console.warn("Failed to load apps:", e);
    renderAppListMessage(list, `<div class="text-danger small px-2 py-2">Failed to load apps.</div>`);
    setSelectedAppId("");
    setLatestCsvName("");
    clearAnalyzeStatusUi();
    return;
  }

  if (!apps.length) {
    renderAppListMessage(list, `<div class="text-secondary small px-2 py-2">No apps configured.</div>`);
    setSelectedAppId("");
    setLatestCsvName("");
    clearAnalyzeStatusUi();
    return;
  }
  // Auswahl: gemerkt oder erstes Preset.
  const current = chooseInitialAppId(apps);

  // Rendern: Header + Rows.
  renderAppsHeader(list);
  renderAppRows(list, apps, current);

  // Delegierter Click-Handler (nur 1x binden).
  ensureAppsListActionsBound(list);

  applySelectedApp(list, current);
  renderAllProjectsOverview().catch((e) => console.warn("Portfolio refresh failed:", e));

  if (autoAnalyze) {
    requestInitialAnalysis();
  }
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

  sse.addEventListener("hello", (ev) => {
    try {
      const msg = JSON.parse(ev.data || "{}");
      currentRunToken = msg?.activeAnalysis?.runToken || null;
    } catch { }
  });

  sse.addEventListener("analysis", (ev) => {
    try {
      const msg = JSON.parse(ev.data || "{}");
      currentRunToken = msg?.runToken || null;
    } catch { }
  });

  sse.addEventListener("fs-change", (ev) => {
    let msg = null;
    try {
      msg = JSON.parse(ev.data || "{}");
    } catch {
      return;
    }

    // Ignoriere veraltete Change-Events aus einem anderen Analyse-Lauf.
    if (shouldIgnoreFsChange(msg, currentRunToken)) return;

    // Mark changed node in the *current* rendered graph (if present).
    try {
      graphController?.markChanged?.({ id: msg.id, ev: msg.ev, at: msg.at });
    
    } catch { }
    

    if (!isSelectedNodeMessage(msg)) return;
    refreshSelectedPanels();
  });

  sse.addEventListener("fs-watch-error", (ev) => {
    try {
      const msg = JSON.parse(ev.data || "{}");
      console.warn("[SSE] fs-watch-error:", msg?.message || msg);
    } catch {
      console.warn("[SSE] fs-watch-error:", ev.data);
    }
  });

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

  switch (String(viewKey || "")) {
    case "app":
      return hasSelectedApp ? "Repository details, Git state and freeze history." : "Select an app to inspect details.";
    case "projects":
      return "Portfolio trends and app-level review priorities.";
    default:
      if (hasGraphApp) return "Click a node to inspect.";
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

function showWorkspaceGraphTab() {
  activateTabById("graph-main-tab");
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
    elementId: "graphTimeView",
    modulePath: "./graph_timeView.js",
    preferredName: "initGraphTimeView",
    fallbackName: "renderGraphTimeView",
    warningLabel: "Drift history",
    metrics,
  });
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
  const el = byId(id);
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
    activateTabById("workspace-app-tab");
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

    setStatus("Running analysis…");
    setStatusSignal("neutral");


    const data = await postAnalyze(appId);
    if (isUnsupportedAnalysis(data)) {
      handleUnsupportedAnalysis(data);
      return;
    }

    // Important:
    // `data.runToken` belongs to the analyze/metrics flow, not to the active
    // SSE stream state. The live event token is updated only from SSE events,
    // so we intentionally do NOT overwrite `currentRunToken` here.
    const metrics = await fetchJson(data.metricsUrl);
    activeGraphAppId = appId;
    resetSupplementaryGraphViews();
    renderGraph(metrics);
    await renderSupplementaryCharts(metrics);

    updateGraphHeader(metrics);
    showWorkspaceGraphTab();

    statusDone(data);
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
 * 4) load apps and immediately analyze the default selection
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
  loadApps({ autoAnalyze: true });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();

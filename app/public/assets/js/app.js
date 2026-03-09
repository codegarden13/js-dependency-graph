/* public/assets/js/app.js (ESM)
 * NodeAnalyzer UI bootstrap (index.html companion)
 *
 * Responsibilities:
 * - Load app presets (/apps) into a compact selectable list (#appList)
 * - Auto-run analysis when selecting an app (no Analyze button)
 * - Provide `onNodeSelected` callback to the D3 graph (no window bridge)
 * - Render README + selection info panels
 * - Subscribe to SSE (/events) and mark changed nodes (color + timestamp)
 *
 * Notes:
 * - Requires marked + DOMPurify for README HTML rendering (optional fallback)
 * - Expects a hidden input: <input type="hidden" id="appSelect" value="">
 * - Expects: #appList, #status, #graphInfoPanel, #readmePanel, #codeStructureSvg
 * - Uses ESM imports: initcodeStructureChart(svgId, metrics, { onNodeSelected })
 * - Uses ESM imports for other helpers
 */

"use strict";

import { initcodeStructureChart } from "./d3_codeStructure.js";


// App-local state (no window globals)
let selectedNode = null;

let graphController = null;

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

function ensurePanelsExist() {
  const missing = [];
  if (!byId("readmePanel")) missing.push("#readmePanel");
  if (!byId("graphInfoPanel")) missing.push("#graphInfoPanel");
  if (missing.length) {
    console.warn("Panels missing in DOM:", missing.join(", "));
    return false;
  }
  return true;
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

/* ======================================================================= */
/* Panels                                                                   */
/* ======================================================================= */

function clearPanels() {
  const rp = byId("readmePanel");
  const ip = byId("graphInfoPanel");
  if (rp) rp.innerHTML = "";
  if (ip) ip.innerHTML = "";
}

/**
 * Render selection details immediately on click.
 * @param {any} node
 */
function renderInfoPanel(node) {
  const root = byId("graphInfoPanel");
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
  return byId("readmePanel");
}

function getNodeRelPath(node) {
  return String(node?.file || node?.parent || node?.id || "").trim();
}

function clearReadme(root) {
  root.innerHTML = "";
}

function showReadmeSearching(root) {
  root.innerHTML = `<div class="text-muted small">Searching…</div>`;
}

function showReadmeSelectApp(root) {
  root.innerHTML = `<div class="text-muted small">Select an app to load README.</div>`;
}

function showReadmeNotFound(root) {
  root.innerHTML = `<div class="text-muted small">No README found for this node.</div>`;
}

function buildReadmeUrl(appId, fileRel) {
  const a = encodeURIComponent(String(appId || ""));
  const f = encodeURIComponent(String(fileRel || ""));
  return `/readme?appId=${a}&file=${f}`;
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

  root.innerHTML = `
      <div class="small text-secondary mb-2">${esc(data?.readmePath || "")}</div>
      <div class="content markdown">${safeHtml}</div>
    `;
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

  const appId = getSelectedAppId();
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

    if (activeReadmeController) activeReadmeController.abort();
    activeReadmeController = new AbortController();
    renderReadmeForNode(latest, activeReadmeController.signal).catch(() => { });
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

  if (activeReadmeController) activeReadmeController.abort();
  activeReadmeController = new AbortController();

  renderReadmeForNode(node, activeReadmeController.signal).catch((e) => {
    if (e?.name === "AbortError") return;
    console.warn("README render failed:", e);
    const root = byId("readmePanel");
    if (root) root.innerHTML = "";
  });
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
  const hidden = /** @type {HTMLInputElement|null} */ (byId("appSelect"));
  if (!hidden) return;

  // Always store a string (defensive). Empty string means "no selection".
  hidden.value = String(appId || "");
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
 * Visually mark the active app row in the sidebar list.
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
  if (remembered) return remembered;
  return String(apps?.[0]?.id || "");
}

/** Render the static header row (column labels). */
function renderAppsHeader(list) {
  list.innerHTML = `
      <div class="appHdr">
        <div></div>
        <div>Name</div>
        <div>Entrypoint</div>
        <div class="appUrl">URL</div>
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
  const entry = String(a.entry || "(auto)");
  const url = String(a.url || "");

  const row = document.createElement("div");
  row.className = "appRow" + (id === currentId ? " isActive" : "");
  row.setAttribute("role", "listitem");

  row.dataset.appId = id;
  row.dataset.appUrl = url;

  row.innerHTML = `
      <span class="appDot" aria-hidden="true"></span>
      <div class="appName" title="${esc(name)}">${esc(name)}</div>
      <div class="appMeta" title="${esc(entry)}">${esc(entry)}</div>
      <div class="appMeta appUrl" title="${esc(url)}">${esc(url)}</div>

      <div class="appActions">
        <button type="button" class="btn btn-sm btn-outline-secondary"
                data-action="restart" data-app-id="${esc(id)}">
          Restart
        </button>
        <button type="button" class="btn btn-sm btn-outline-primary"
                data-action="open" data-url="${esc(url)}">
          Show
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

/**
 * Auto-run analysis once after the initial list load if no graph exists yet.
 * Uses a 0ms timeout so the DOM paint happens first.
 */
function maybeAutoAnalyzeOnFirstLoad() {
  setTimeout(() => {
    const hasGraph = Array.isArray(graphController?.nodes) && graphController.nodes.length > 0;
    if (!hasGraph) runAnalysis().catch((e) => console.error(e));
  }, 0);
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

function scheduleRerunAnalysis(delayMs = 300) {
  setTimeout(() => safeRunAnalysis(), delayMs);
}

function getActionContext(btn) {
  const action = getAttr(btn, "data-action");
  const row = getClosestAppRow(btn);

  const appId = getAttr(btn, "data-app-id") || getDataset(row, "appId");
  const url = getAttr(btn, "data-url") || getDataset(row, "appUrl");

  return { action, appId, url };
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
      // Optional: re-run analysis after restart (small delay so server can come up)
      scheduleRerunAnalysis(300);
    })
    .catch(showRestartFailed);
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

  setSelectedAppId(newId);
  setAppActiveRow(listEl, newId);
  safeRunAnalysis();
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

/**
 * Lädt die App-Presets vom Backend (`/apps`) und rendert sie in die Sidebar.
 *
 * Ablauf
 * ------
 * 1) DOM-Elemente finden (#appList, #appSelect)
 * 2) `/apps` laden
 * 3) Auswahl festlegen (gemerkte Auswahl oder erstes Preset)
 * 4) Liste rendern (Header + Rows)
 * 5) Delegierten Click-Handler einmalig binden (open/restart/select)
 * 6) Optional: initiale Analyse triggern, wenn noch kein Graph existiert
 */
async function loadApps() {
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
    return;
  }

  if (!apps.length) {
    renderAppListMessage(list, `<div class="text-secondary small px-2 py-2">No apps configured.</div>`);
    setSelectedAppId("");
    return;
  }

  // Auswahl: gemerkt oder erstes Preset.
  const current = chooseInitialAppId(apps);
  setSelectedAppId(current);

  // Rendern: Header + Rows.
  renderAppsHeader(list);
  renderAppRows(list, apps, current);

  // Delegierter Click-Handler (nur 1x binden).
  ensureAppsListActionsBound(list);

  // Initial-Analyse beim ersten Boot.
  maybeAutoAnalyzeOnFirstLoad();
}

/* ======================================================================= */
/* Live Change Feed (SSE) mit currentRunToken                                                 */
/* ======================================================================= */

let currentRunToken = null;

// currentRunToken ist eine Analyse-„Run-ID“ (Token), die vom Backend vergeben wird.
//
// Woher kommt er?
// - Das Backend sendet ihn über SSE:
//   - Event "hello": msg.activeAnalysis.runToken
//   - Event "analysis": msg.runToken
// - Zusätzlich kann /analyze ebenfalls `runToken` zurückgeben (wird in runAnalysis gesetzt).
//
// Wozu dient er?
// - Er verhindert, dass veraltete fs-change Events (von einem älteren Analyse-Lauf)
//   den aktuell angezeigten Graphen „falsch“ als geändert markieren.
// - Das ist wichtig, weil SSE-Events asynchron eintreffen und zwischen zwei Läufen
//   noch Events vom vorherigen Lauf nachlaufen können.
//
// Regel:
// - Wenn sowohl currentRunToken als auch msg.runToken vorhanden sind und NICHT gleich sind,
//   gilt das Event als „stale“ und wird ignoriert.
// - Wenn einer der Tokens fehlt, lassen wir das Event durch (best-effort / kompatibel).




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

function isUnsupportedAnalysis(data) {
  return String(data?.analysisStatus || "") === "unsupported";
}

function handleUnsupportedAnalysis(data) {
  clearPanels();
  selectedNode = null;
  showUnsupportedTargetMessage(data);
  setStatus("Unsupported target (see details).");
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

function updateCurrentAppSummary(metrics) {
  return updateTextSummary("currentAppSummary", () => {
    const appId = getSelectedAppId();
    const stats = deriveGraphStats(metrics);
    return buildCurrentAppSummary({
      appId,
      functionCount: stats.functionCount,
      loc: stats.loc,
    });
  });
}

function statusDone(data) {
  setStatus(`Done. Nodes: ${data.summary?.nodes ?? "?"}, Links: ${data.summary?.links ?? "?"}`);
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
}

async function runAnalysis() {
  if (!tryBeginAnalysis()) return;

  try {
    const appId = getSelectedAppIdOrShowStatus();
    if (!appId) return;

    setStatus("Running analysis…");


    const data = await postAnalyze(appId);
    if (isUnsupportedAnalysis(data)) {
      handleUnsupportedAnalysis(data);
      return;
    }

    // IMPORTANT:
    // `data.runToken` belongs to the metrics cache endpoint.
    // Live SSE events use the runToken managed by liveChangeFeed.js.
    // Therefore we must NOT overwrite `currentRunToken` here.
    const metrics = await fetchJson(data.metricsUrl);
    renderGraph(metrics);

    // Best-effort summary update for the current app accordion header.
    updateCurrentAppSummary(metrics);

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

function init() {
  ensurePanelsExist();
  startLiveEvents();
  loadApps();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();

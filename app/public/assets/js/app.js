/* public/assets/js/app.js
 * NodeAnalyzer UI bootstrap (index.html companion)
 *
 * Responsibilities:
 * - Load app presets (/apps) into a compact selectable list (#appList)
 * - Auto-run analysis when selecting an app (no Analyze button)
 * - Define window.onGraphNodeSelected(node) hook used by the D3 graph
 * - Render README + selection info panels
 * - Subscribe to SSE (/events) and mark changed nodes (color + timestamp)
 *
 * Notes:
 * - Requires marked + DOMPurify for README HTML rendering (optional fallback)
 * - Expects a hidden input: <input type="hidden" id="appSelect" value="">
 * - Expects: #appList, #status, #graphInfoPanel, #readmePanel, #codeStructureSvg
 * - Expects D3 renderer global: window.initcodeStructureChart(svgId, metrics)
 * - Expects D3 change hook global: window.graphMarkChanged({id, ev, at})
 */
(function () {
  "use strict";

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

  let __warnedStatusDup = false;
  function setStatus(text) {
    const els = document.querySelectorAll("#status");
    if (els.length > 1 && !__warnedStatusDup) {
      __warnedStatusDup = true;
      console.warn(`Expected 1 #status, found ${els.length}. Updating all.`);
    }
    els.forEach((el) => {
      try {
        el.textContent = text || "";
      } catch {}
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
    const title = String(cfg?.title || "Message");
    const message = String(cfg?.message || "");

    let detailsText = "";
    try {
      if (cfg?.details != null) {
        detailsText = JSON.stringify(cfg.details, null, 2);
      }
    } catch {
      detailsText = String(cfg?.details || "");
    }

    const full =
      detailsText && detailsText !== "null"
        ? `${title}\n\n${message}\n\nDetails:\n${detailsText}`
        : `${title}\n\n${message}`;

    alert(full);
  }

  /**
   * Show a dedicated message for unsupported targets (e.g. CommonJS-only projects).
   * @param {any} data
   */
  function showUnsupportedTargetMessage(data) {
    const reason = String(data?.reason || data?.analysisStatus || "unsupported");
    const msg = String(
      data?.message || "This target is not supported by the current analyzer mode."
    );

    showMessageBox({
      title: "Unsupported target",
      severity: "warn",
      message: `${msg}\n\nReason: ${reason}`,
      details: data?.details || data,
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

  /**
   * Fetch JSON but treat HTTP 404 as a normal "not found" result.
   * @param {string} url
   * @param {RequestInit} [init]
   * @returns {Promise<any|null>}
   */
  async function fetchJsonOrNullOn404(url, init) {
    const r = await fetch(url, init);
    if (r.status === 404) return null;

    const ct = String(r.headers.get("content-type") || "");
    const isJson = ct.includes("application/json");

    /** @type {any} */
    let body = null;

    try {
      body = isJson ? await r.json() : await r.text();
    } catch {
      body = null;
    }

    if (!r.ok) {
      const serverMsg = body?.error?.message || body?.message;
      const msg = serverMsg
        ? String(serverMsg)
        : typeof body === "string" && body.trim()
          ? body.trim()
          : `HTTP ${r.status} ${r.statusText}`;

      const err = new Error(msg);
      /** @type {any} */ (err).status = r.status;
      /** @type {any} */ (err).code = body?.error?.code;
      /** @type {any} */ (err).details = body?.error?.details;
      throw err;
    }

    if (!isJson) {
      throw new Error(
        `Expected JSON response from ${url}, got content-type: ${ct || "(missing)"}`
      );
    }

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
        ${
          comment
            ? `<pre class="comment-pre mb-0">${esc(comment)}</pre>`
            : `<div class="text-muted small">No file header comment provided by analyzer.</div>`
        }
      </div>
    `;
  }

  /**
   * Render README for a selected node.
   * @param {any} node
   * @param {AbortSignal} signal
   */
  async function renderReadmeForNode(node, signal) {
    const root = byId("readmePanel");
    if (!root) return;

    const fileRel = String(node?.file || node?.parent || node?.id || "").trim();
    if (!fileRel) {
      root.innerHTML = "";
      return;
    }

    root.innerHTML = `<div class="text-muted small">Searching…</div>`;

    const appId = String((/** @type {HTMLInputElement} */ (byId("appSelect"))).value || "").trim();
    if (!appId) {
      root.innerHTML = `<div class="text-muted small">Select an app to load README.</div>`;
      return;
    }

    const url = `/readme?appId=${encodeURIComponent(appId)}&file=${encodeURIComponent(fileRel)}`;

    let data = null;
    try {
      data = await fetchJsonOrNullOn404(url, { signal });
    } catch (e) {
      if (e?.name === "AbortError" || signal?.aborted) return;
      console.warn("README fetch failed:", e);
      root.innerHTML = "";
      return;
    }

    if (signal?.aborted) return;

    if (!data || data.found === false) {
      root.innerHTML = `<div class="text-muted small">No README found for this node.</div>`;
      return;
    }

    const md = String(data.markdown || "");
    const rawHtml = window.marked?.parse ? window.marked.parse(md) : `<pre>${esc(md)}</pre>`;
    const safeHtml = window.DOMPurify?.sanitize ? window.DOMPurify.sanitize(rawHtml) : rawHtml;

    root.innerHTML = `
      <div class="small text-secondary mb-2">${esc(data.readmePath || "")}</div>
      <div class="content markdown">${safeHtml}</div>
    `;
  }

  /* ======================================================================= */
  /* Graph state helpers                                                     */
  /* ======================================================================= */

  function getRenderedNodeById(id) {
    const nodes = window.lastGraphState?.nodes;
    if (!Array.isArray(nodes) || !id) return null;
    return nodes.find((n) => n && n.id === id) || null;
  }

  function refreshSelectedPanels() {
    const selectedId = String(window.__selectedNode?.id || "").trim();
    if (!selectedId) return;

    const latest = getRenderedNodeById(selectedId) || window.__selectedNode;
    window.__selectedNode = latest;

    if (ensurePanelsExist()) {
      renderInfoPanel(latest);

      if (activeReadmeController) activeReadmeController.abort();
      activeReadmeController = new AbortController();
      renderReadmeForNode(latest, activeReadmeController.signal).catch(() => {});
    }
  }

  /* ======================================================================= */
  /* D3 integration hook (global)                                             */
  /* ======================================================================= */

  let activeReadmeController = null;

  window.onGraphNodeSelected = function onGraphNodeSelected(node) {
    window.__selectedNode = node || null;

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
  };

  /* ======================================================================= */
  /* Apps list + Actions (Restart / Show Website)                             */
  /* ======================================================================= */

  function setSelectedAppId(appId) {
    const hidden = /** @type {HTMLInputElement} */ (byId("appSelect"));
    hidden.value = String(appId || "");
  }

  function getSelectedAppId() {
    const hidden = /** @type {HTMLInputElement} */ (byId("appSelect"));
    return String(hidden.value || "").trim();
  }

  function setAppActiveRow(listEl, appId) {
    listEl.querySelectorAll(".appRow").forEach((el) => {
      el.classList.toggle("isActive", el.dataset.appId === appId);
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

  /**
   * Restart action:
   * We intentionally try multiple endpoints because your backend naming may differ.
   * - If none exist, you still get a clean error message (instead of “nothing happens”).
   *
   * @param {string} appId
   */
  async function restartApp(appId) {
    const id = String(appId || "").trim();
    if (!id) return;

    // Try a few common patterns (first successful response wins).
    const tries = [
      { url: "/restart", body: { appId: id } },
      { url: "/apps/restart", body: { appId: id } },
      { url: `/apps/${encodeURIComponent(id)}/restart`, body: { appId: id } },
    ];

    let lastErr = null;

    for (const t of tries) {
      try {
        const res = await fetchJson(t.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(t.body),
        });

        // If backend returns something structured, show a short status.
        const msg =
          res?.message ||
          res?.status ||
          "Restart requested.";

        setStatus(`Restart: ${id} (${msg})`);
        return;
      } catch (e) {
        lastErr = e;
      }
    }

    throw lastErr || new Error("Restart failed (no endpoint responded).");
  }

  async function loadApps() {
    const list = byId("appList");
    const hidden = /** @type {HTMLInputElement|null} */ (byId("appSelect"));
    if (!list || !hidden) return;

    list.innerHTML = `<div class="text-secondary small px-2 py-2">Loading…</div>`;

    let data;
    try {
      data = await fetchJson("/apps");
    } catch (e) {
      console.warn("Failed to load apps:", e);
      list.innerHTML = `<div class="text-danger small px-2 py-2">Failed to load apps.</div>`;
      setSelectedAppId("");
      return;
    }

    const apps = data?.apps || [];
    if (!apps.length) {
      list.innerHTML = `<div class="text-secondary small px-2 py-2">No apps configured.</div>`;
      setSelectedAppId("");
      return;
    }

    const current = getSelectedAppId() || apps[0].id;
    setSelectedAppId(current);

    // Header row (keep it compact; style .appHdr/.appRow in CSS)
    list.innerHTML = `
      <div class="appHdr">
        <div></div>
        <div>Name</div>
        <div>Entrypoint</div>
        <div class="appUrl">URL</div>
        <div class="appActionsHdr">Actions</div>
      </div>
    `;

    // Build rows (no per-row click handlers; we use ONE delegated handler below)
    for (const a of apps) {
      const row = document.createElement("div");
      row.className = "appRow" + (a.id === current ? " isActive" : "");
      row.setAttribute("role", "listitem");
      row.dataset.appId = String(a.id || "");
      row.dataset.appUrl = String(a.url || "");

      row.innerHTML = `
        <span class="appDot" aria-hidden="true"></span>
        <div class="appName" title="${esc(a.name || a.id)}">${esc(a.name || a.id)}</div>
        <div class="appMeta" title="${esc(a.entry || "(auto)")}">${esc(a.entry || "(auto)")}</div>
        <div class="appMeta appUrl" title="${esc(a.url || "")}">${esc(a.url || "")}</div>

        <div class="appActions">
          <button type="button" class="btn btn-sm btn-outline-secondary"
                  data-action="restart" data-app-id="${esc(a.id || "")}">
            Restart
          </button>
          <button type="button" class="btn btn-sm btn-outline-primary"
                  data-action="open" data-url="${esc(a.url || "")}">
            Show
          </button>
        </div>
      `;

      list.appendChild(row);
    }

    // Ensure we only bind the delegated handler once, even if loadApps() runs again.
    if (!list.__actionsBound) {
      Object.defineProperty(list, "__actionsBound", { value: true });

      list.addEventListener("click", (ev) => {
        const target = /** @type {HTMLElement|null} */ (ev.target || null);
        if (!target) return;

        // 1) Button actions
        const btn = target.closest?.("[data-action]");
        if (btn) {
          ev.preventDefault();
          ev.stopPropagation();

          const action = String(btn.getAttribute("data-action") || "");
          const appId = String(btn.getAttribute("data-app-id") || btn.closest(".appRow")?.dataset?.appId || "");
          const url = String(btn.getAttribute("data-url") || btn.closest(".appRow")?.dataset?.appUrl || "");

          if (action === "open") {
            openWebsite(url);
            return;
          }

          if (action === "restart") {
            setStatus("Restarting…");
            restartApp(appId)
              .then(() => {
                // Optional: re-run analysis after restart (small delay so server can come up)
                setTimeout(() => {
                  // Keep current selection; just analyze again.
                  runAnalysis().catch((e) => console.error(e));
                }, 300);
              })
              .catch((e) => {
                console.error("Restart failed:", e);
                showMessageBox({
                  title: "Restart failed",
                  severity: "error",
                  message: String(e?.message || e || "Unknown error"),
                  details: { status: e?.status, code: e?.code, details: e?.details },
                });
                setStatus("Restart failed.");
              });
            return;
          }

          // Unknown action (ignore)
          return;
        }

        // 2) Row selection (ignore clicks inside actions container)
        if (isActionClick(ev)) return;

        const row = target.closest?.(".appRow");
        if (!row) return;

        const newId = String(row.dataset.appId || "").trim();
        if (!newId) return;

        setSelectedAppId(newId);
        setAppActiveRow(list, newId);
        runAnalysis().catch((e) => console.error(e));
      });
    }

    // Auto-analyze initially selected app (first load)
    setTimeout(() => {
      const hasGraph =
        Array.isArray(window.lastGraphState?.nodes) && window.lastGraphState.nodes.length > 0;
      if (!hasGraph) runAnalysis().catch((e) => console.error(e));
    }, 0);
  }

  /* ======================================================================= */
  /* Live Change Feed (SSE)                                                   */
  /* ======================================================================= */

  let currentRunToken = null;
  /** @type {EventSource|null} */
  let sse = null;

  function startLiveEvents() {
    if (sse) return;

    sse = new EventSource("/events");

    sse.addEventListener("hello", (ev) => {
      try {
        const msg = JSON.parse(ev.data || "{}");
        currentRunToken = msg?.activeAnalysis?.runToken || null;
      } catch {}
    });

    sse.addEventListener("analysis", (ev) => {
      try {
        const msg = JSON.parse(ev.data || "{}");
        currentRunToken = msg?.runToken || null;
      } catch {}
    });

    sse.addEventListener("fs-change", (ev) => {
      let msg = null;
      try {
        msg = JSON.parse(ev.data || "{}");
      } catch {
        return;
      }

      if (currentRunToken && msg.runToken && msg.runToken !== currentRunToken) return;

      if (typeof window.graphMarkChanged === "function") {
        window.graphMarkChanged({
          id: msg.id,
          ev: msg.ev,
          at: msg.at,
        });
      }

      if (String(window.__selectedNode?.id || "") === String(msg.id || "")) {
        refreshSelectedPanels();
      }
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

  async function runAnalysis() {
    if (analyzeInFlight) {
      analyzePending = true;
      return;
    }

    analyzeInFlight = true;
    analyzePending = false;

    try {
      const appIdEl = /** @type {HTMLInputElement|null} */ (byId("appSelect"));
      const appId = String(appIdEl?.value || "").trim();

      if (!appId) {
        setStatus("Select an app first.");
        return;
      }

      setStatus("Running analysis…");

      const data = await fetchJson("/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId }),
      });

      if (data?.analysisStatus === "unsupported") {
        clearPanels();
        window.__selectedNode = null;
        showUnsupportedTargetMessage(data);
        setStatus("Unsupported target (see details).");
        return;
      }

      currentRunToken = data?.runToken || currentRunToken;

      const metrics = await fetchJson(data.metricsUrl);

      if (typeof window.initcodeStructureChart !== "function") {
        throw new Error(
          "Graph renderer not loaded (initcodeStructureChart missing). Check script order."
        );
      }

      clearPanels();
      window.__selectedNode = null;

      window.initcodeStructureChart("codeStructureSvg", metrics);

      setStatus(
        `Done. Nodes: ${data.summary?.nodes ?? "?"}, Links: ${data.summary?.links ?? "?"}`
      );
    } catch (e) {
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
    } finally {
      analyzeInFlight = false;

      if (analyzePending) {
        analyzePending = false;
        runAnalysis().catch((err) => console.error(err));
      }
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
})();
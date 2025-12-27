/* public/assets/js/app.js
 * NodeAnalyzer UI bootstrap (index.html companion)
 *
 * Responsibilities:
 * - Load app presets (/apps) into a compact selectable list (#appList)
 * - Auto-run analysis when app selection changes
 * - Define window.onGraphNodeSelected(node) hook used by the D3 graph
 * - Render README + selection info panels
 */
(function () {
  "use strict";

  /* =======================================================================
   * DOM helpers
   * ======================================================================= */

  function byId(id) {
    const list = document.querySelectorAll("#" + id);
    if (list.length !== 1) {
      console.warn(`Expected exactly 1 #${id}, found ${list.length}`, list);
    }
    return /** @type {HTMLElement|null} */ (list[0] || null);
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  function setStatus(text) {
    const el = byId("status");
    if (el) el.textContent = text || "";
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

  /* =======================================================================
   * Fetch helpers
   * ======================================================================= */

  async function fetchJson(url, init) {
    const r = await fetch(url, init);
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      const err = new Error(text || `HTTP ${r.status}`);
      err.status = r.status;
      throw err;
    }
    return r.json();
  }

  async function fetchJsonAllow404(url, init) {
    const r = await fetch(url, init);
    if (r.status === 404) return null;
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      const err = new Error(text || `HTTP ${r.status}`);
      err.status = r.status;
      throw err;
    }
    return r.json();
  }

  /* =======================================================================
   * Panels
   * ======================================================================= */

  function clearPanels() {
    const rp = byId("readmePanel");
    const ip = byId("graphInfoPanel");
    if (rp) rp.innerHTML = "";
    if (ip) ip.innerHTML = "";
  }

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

    root.innerHTML = `
      <div class="d-grid gap-2">
        <div class="small text-muted"><strong>ID:</strong> ${esc(id)}</div>
        ${file ? `<div class="small text-muted"><strong>File:</strong> ${esc(file)}</div>` : ""}
        ${kind ? `<div class="small text-muted"><strong>Kind:</strong> ${esc(kind)}</div>` : ""}
        ${name ? `<div class="small text-muted"><strong>Name:</strong> ${esc(name)}</div>` : ""}

        <div class="small text-muted"><strong>Lines:</strong> ${esc(lines)}</div>
        <div class="small text-muted"><strong>Complexity:</strong> ${esc(cx)}</div>

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

  async function renderReadmeForNode(node, signal) {
    const root = byId("readmePanel");
    if (!root) return;

    const fileRel = String(node?.file || node?.parent || node?.id || "").trim();
    if (!fileRel) {
      root.innerHTML = "";
      return;
    }

    root.innerHTML = `<div class="text-muted small">Searching…</div>`;

    const url = `/readme?file=${encodeURIComponent(fileRel)}`;

    let data = null;
    try {
      data = await fetchJsonAllow404(url, { signal });
    } catch (e) {
      if (e?.name === "AbortError" || signal?.aborted) return;
      console.warn("README fetch failed:", e);
      root.innerHTML = "";
      return;
    }

    if (signal?.aborted) return;

    if (!data || !data.found) {
      root.innerHTML = "";
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

  /* =======================================================================
   * D3 integration hook (global)
   * ======================================================================= */

  let activeReadmeController = null;

  window.onGraphNodeSelected = function onGraphNodeSelected(node) {
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

  /* =======================================================================
   * Apps list (compact selectable rows)
   * ======================================================================= */

  function setSelectedAppId(appId) {
    const hidden = /** @type {HTMLInputElement|null} */ (byId("appSelect"));
    if (hidden) hidden.value = String(appId || "");
  }

  function getSelectedAppId() {
    const hidden = /** @type {HTMLInputElement|null} */ (byId("appSelect"));
    return String(hidden?.value || "").trim();
  }

  function setAppsListDisabled(disabled) {
    const list = byId("appList");
    if (!list) return;
    list.style.pointerEvents = disabled ? "none" : "";
    list.style.opacity = disabled ? "0.65" : "";
  }

  let analyzeTimer = null;
  function scheduleAnalysis(delayMs = 150) {
    if (analyzeTimer) clearTimeout(analyzeTimer);
    analyzeTimer = setTimeout(() => runAnalysis(), delayMs);
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

    list.innerHTML = `
      <div class="appHdr">
        <div></div>
        <div>Name</div>
        <div>Entrypoint</div>
        <div class="appUrl">URL</div>
      </div>
    `;

    for (const a of apps) {
      const row = document.createElement("div");
      row.className = "appRow" + (a.id === current ? " isActive" : "");
      row.setAttribute("role", "listitem");
      row.dataset.appId = a.id;

      row.innerHTML = `
        <span class="appDot" aria-hidden="true"></span>
        <div class="appName" title="${esc(a.name || a.id)}">${esc(a.name || a.id)}</div>
        <div class="appMeta" title="${esc(a.entry || "")}">${esc(a.entry || "")}</div>
        <div class="appMeta appUrl" title="${esc(a.url || "")}">${esc(a.url || "")}</div>
      `;

      row.addEventListener("click", () => {
        // Update selection
        setSelectedAppId(a.id);
        list.querySelectorAll(".appRow").forEach((el) => el.classList.remove("isActive"));
        row.classList.add("isActive");

        // Auto-run analysis on selection change
        scheduleAnalysis(100);
      });

      list.appendChild(row);
    }

    // Auto-run analysis once for initial selection
    scheduleAnalysis(0);
  }

  /* =======================================================================
   * Analysis (auto-run + abortable)
   * ======================================================================= */

  let activeAnalyzeController = null;

  async function runAnalysis() {
    const appId = getSelectedAppId();
    if (!appId) {
      setStatus("Select an app first.");
      return;
    }

    if (activeAnalyzeController) activeAnalyzeController.abort();
    activeAnalyzeController = new AbortController();

    setStatus("Running analysis…");
    setAppsListDisabled(true);

    try {
      const data = await fetchJson("/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId }),
        signal: activeAnalyzeController.signal
      });

      const metrics = await fetchJson(data.metricsUrl, { signal: activeAnalyzeController.signal });

      if (typeof window.initcodeStructureChart !== "function") {
        throw new Error("Graph renderer not loaded (initcodeStructureChart missing).");
      }

      clearPanels();
      window.initcodeStructureChart("codeStructureSvg", metrics);

      setStatus(`Done. Nodes: ${data.summary?.nodes ?? "?"}, Links: ${data.summary?.links ?? "?"}`);
    } catch (e) {
      if (e?.name === "AbortError") return;
      console.error("Analyze failed:", e);
      alert(`Analyze failed:\n${e.message || String(e)}`);
      setStatus("Analysis failed.");
    } finally {
      setAppsListDisabled(false);
    }
  }

  /* =======================================================================
   * Bootstrap
   * ======================================================================= */

  function init() {
    // Analyze button is no longer required; if it still exists, keep it as fallback.
    byId("run")?.addEventListener("click", () => scheduleAnalysis(0));

    ensurePanelsExist();
    loadApps();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
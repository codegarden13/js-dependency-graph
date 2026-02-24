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
      err.status = r.status;
      throw err;
    }
    return r.json();
  }

  /**
   * Fetch JSON but treat 404 as "not found".
   * @param {string} url
   * @param {RequestInit} [init]
   * @returns {Promise<any|null>}
   */
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
   * Expects #graphInfoPanel to be the BODY element of the "Selection" card.
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
   * Expects #readmePanel to be the BODY element of the "README" card.
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

 const appId = String(byId("appSelect")?.value || "").trim();
if (!appId) {
  // Kein aktives App-Selection → UI sauber halten (oder Hinweis anzeigen)
  root.innerHTML = `<div class="text-muted small">Select an app to load README.</div>`;
  return;
}

const url = `/readme?appId=${encodeURIComponent(appId)}&file=${encodeURIComponent(fileRel)}`;

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

  /* ======================================================================= */
  /* Graph state helpers                                                     */
  /* ======================================================================= */

  /**
   * Return the currently rendered graph node object for an id (if available).
   * This is important because the renderer may mutate node objects (e.g. live-change timestamps).
   * @param {string} id
   */
  function getRenderedNodeById(id) {
    const nodes = window.lastGraphState?.nodes;
    if (!Array.isArray(nodes) || !id) return null;
    return nodes.find((n) => n && n.id === id) || null;
  }

  /**
   * Re-render panels for the currently selected node, but using the latest node instance
   * from the rendered graph state.
   */
  function refreshSelectedPanels() {
    const selectedId = String(window.__selectedNode?.id || "").trim();
    if (!selectedId) return;

    const latest = getRenderedNodeById(selectedId) || window.__selectedNode;
    window.__selectedNode = latest;

    if (ensurePanelsExist()) {
      renderInfoPanel(latest);

      // Refresh README too (keep behavior consistent)
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
  /* Apps list (compact selectable rows)                                      */
  /* ======================================================================= */

  function setSelectedAppId(appId) {
    const hidden = /** @type {HTMLInputElement|null} */ (byId("appSelect"));
    if (hidden) hidden.value = String(appId || "");
  }

  function getSelectedAppId() {
    const hidden = /** @type {HTMLInputElement|null} */ (byId("appSelect"));
    return String(hidden?.value || "").trim();
  }

  function setAppActiveRow(listEl, appId) {
    listEl.querySelectorAll(".appRow").forEach((el) => {
      el.classList.toggle("isActive", el.dataset.appId === appId);
    });
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
        <div class="appMeta" title="${esc(a.entry || "(auto)")}" >${esc(a.entry || "(auto)")}</div>
        <div class="appMeta appUrl" title="${esc(a.url || "")}">${esc(a.url || "")}</div>
      `;

      row.addEventListener("click", () => {
        // Selecting an app triggers analysis immediately
        const newId = String(a.id || "");
        setSelectedAppId(newId);
        setAppActiveRow(list, newId);
        runAnalysis().catch((e) => console.error(e));
      });

      list.appendChild(row);
    }

    // Auto-analyze initially selected app (first load)
    // Guard: only run if we haven't rendered a graph yet.
    setTimeout(() => {
      const hasGraph = Array.isArray(window.lastGraphState?.nodes) && window.lastGraphState.nodes.length > 0;
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

      // Ignore stale events after re-analyze
      if (currentRunToken && msg.runToken && msg.runToken !== currentRunToken) return;

      // Mark node in graph (renderer supplies this)
      if (typeof window.graphMarkChanged === "function") {
        window.graphMarkChanged({
          id: msg.id,
          ev: msg.ev,
          at: msg.at
        });
      }

      // If the currently selected node changed, refresh panels using the latest node instance
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
  /* Analyze action (manual removed; runs on app selection)                    */
  /* ======================================================================= */

  let analyzeInFlight = false;
  let analyzePending = false;

  async function runAnalysis() {
    // If a run is already in flight, remember that we need one more run afterwards.
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
        body: JSON.stringify({ appId })
      });

      // Run token for SSE stale filtering
      currentRunToken = data?.runToken || currentRunToken;

      const metrics = await fetchJson(data.metricsUrl);

      if (typeof window.initcodeStructureChart !== "function") {
        throw new Error("Graph renderer not loaded (initcodeStructureChart missing). Check script order.");
      }

      clearPanels();
      window.__selectedNode = null;

      window.initcodeStructureChart("codeStructureSvg", metrics);

      setStatus(`Done. Nodes: ${data.summary?.nodes ?? "?"}, Links: ${data.summary?.links ?? "?"}`);
    } catch (e) {
      console.error("Analyze failed:", e);
      alert(`Analyze failed:\n${e.message || String(e)}`);
      setStatus("Analysis failed.");
    } finally {
      analyzeInFlight = false;

      // If the user switched apps during the run, run once more with the latest selection.
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
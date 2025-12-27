// public/assets/js/uiWidgets.js
/**
 * Graph UI Widgets (UI-side)
 * =========================
 * Houses optional DOM-bound widgets:
 * - Filters toolbar
 * - Legend
 * - Diagnostics table
 *
 * All functions are no-ops if the expected DOM anchor does not exist.
 *
 * Exposes: window.CodeGraphUI
 */

(function () {
  "use strict";

  const CodeGraphUI = {};

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  CodeGraphUI.escapeHtml = escapeHtml;

  CodeGraphUI.setupGraphFilters = function setupGraphFilters(svgId, metrics, nodeSel, linkSel) {
    const root = document.querySelector(`[data-graph-filter="${svgId}"]`);
    if (!root) return;

    const regexInput = root.querySelector('[data-filter="regex"]');
    const typeInput = root.querySelector('[data-filter="type"]');
    const clearBtn = root.querySelector('[data-filter="clear"]');
    const status = root.querySelector('[data-filter="status"]');

    if (!regexInput) return;

    function applyFilters() {
      const raw = regexInput.value.trim();
      const typeFilter = typeInput?.value || "";

      let regex = null;
      if (raw) {
        try {
          regex = new RegExp(raw, "i");
        } catch {
          if (status) {
            status.textContent = "Invalid regex";
            status.classList.add("text-danger");
          }
          return;
        }
      }

      const visibleLinks = new Set();

      linkSel.each(function (d) {
        let match = true;

        if (typeFilter) match = d.type === typeFilter;

        if (match && regex) {
          const haystack = `${d.source.id || d.source} ${d.target.id || d.target}`;
          match = regex.test(haystack);
        }

        d._visible = match;
        d3.select(this).style("opacity", match ? 0.9 : 0.05);
        if (match) visibleLinks.add(d);
      });

      let visibleNodeCount = 0;

      nodeSel.each(function (d) {
        let visible = true;

        if (regex) {
          const hay = `${d.id} ${d.label || ""} ${d.file || ""}`.toLowerCase();
          visible = regex.test(hay);
        }

        if (typeFilter) {
          const participates = [...visibleLinks].some((l) => l.source === d || l.target === d);
          visible = visible && participates;
        }

        d._visible = visible;
        if (visible) visibleNodeCount++;

        d3.select(this).style("opacity", visible ? 1 : 0.1);
      });

      if (status) {
        status.textContent =
          raw || typeFilter
            ? `Showing ${visibleNodeCount}/${(metrics.nodes || []).length}`
            : "";
        status.classList.remove("text-danger");
      }
    }

    regexInput.addEventListener("input", applyFilters);
    typeInput?.addEventListener("change", applyFilters);
    clearBtn?.addEventListener("click", () => {
      regexInput.value = "";
      if (typeInput) typeInput.value = "";
      applyFilters();
    });

    applyFilters();
  };

  CodeGraphUI.buildGraphLegend = function buildGraphLegend(svgId, nodes, links, nodeColors, linkColors, clusterColorScale) {
    const root = document.querySelector(`[data-graph-legend="${svgId}"]`);
    if (!root) return;

    root.innerHTML = "";
    root.style.display = "flex";
    root.style.flexWrap = "wrap";
    root.style.gap = "12px";
    root.style.alignItems = "center";

    const presentTypes = new Set(nodes.map((n) => n.type || "file"));
    presentTypes.forEach((type) => {
      const chip = document.createElement("div");
      chip.style.display = "flex";
      chip.style.alignItems = "center";
      chip.style.gap = "4px";

      const dot = document.createElement("span");
      dot.style.width = "12px";
      dot.style.height = "12px";
      dot.style.borderRadius = "50%";
      dot.style.backgroundColor = nodeColors[type] || nodeColors.file;

      const label = document.createElement("span");
      label.className = "text-muted small";
      label.textContent = type;

      chip.appendChild(dot);
      chip.appendChild(label);
      root.appendChild(chip);
    });

    const typeSet = new Set(links.map((l) => l.type).filter(Boolean));
    typeSet.forEach((type) => {
      const wrap = document.createElement("div");
      wrap.style.display = "flex";
      wrap.style.alignItems = "center";
      wrap.style.gap = "4px";

      const bar = document.createElement("span");
      bar.style.width = "20px";
      bar.style.height = "4px";
      bar.style.borderRadius = "2px";
      bar.style.backgroundColor = linkColors[type] || linkColors.default;

      const label = document.createElement("span");
      label.className = "text-muted small";
      label.textContent = type;

      wrap.appendChild(bar);
      wrap.appendChild(label);
      root.appendChild(wrap);
    });

    const clusters = new Set(nodes.map((n) => n.clusterId));
    clusters.forEach((cid) => {
      const chip = document.createElement("div");
      chip.style.display = "flex";
      chip.style.alignItems = "center";
      chip.style.gap = "4px";

      const box = document.createElement("span");
      box.style.width = "14px";
      box.style.height = "10px";
      box.style.borderRadius = "2px";
      box.style.opacity = "0.3";
      box.style.backgroundColor = clusterColorScale(cid);

      const txt = document.createElement("span");
      txt.className = "text-muted small";
      txt.textContent = cid;

      chip.appendChild(box);
      chip.appendChild(txt);
      root.appendChild(chip);
    });
  };

  CodeGraphUI.buildGraphDiagnosticsPanel = function buildGraphDiagnosticsPanel(svgId, nodes, links, width, height) {
    const root = document.querySelector(`[data-graph-stats="${svgId}"]`);
    if (!root) return;

    const cx = width / 2;
    const cy = height / 2;

    const deg = new Map();
    nodes.forEach((n) => deg.set(n.id, { in: 0, out: 0 }));

    links.forEach((l) => {
      const sid = typeof l.source === "object" ? l.source.id : l.source;
      const tid = typeof l.target === "object" ? l.target.id : l.target;
      if (deg.has(sid)) deg.get(sid).out++;
      if (deg.has(tid)) deg.get(tid).in++;
    });

    const enriched = nodes.map((n) => {
      const d = deg.get(n.id) || { in: 0, out: 0 };
      const inbound = d.in;
      const outbound = d.out;
      const degree = inbound + outbound;

      const dist = Math.round(Math.hypot((n.x ?? cx) - cx, (n.y ?? cy) - cy));

      const rawComplexity = n.complexity != null ? n.complexity : (n.cc != null ? n.cc : null);
      const normComplexity = n._complexityScore != null ? Number(n._complexityScore.toFixed(2)) : null;
      const complexity = rawComplexity != null ? rawComplexity : normComplexity;

      let status = "normal";
      if (degree === 0) status = "isolated";
      else if (inbound === 0 && outbound > 0) status = "producer";
      else if (inbound > 0 && outbound === 0) status = "consumer";
      else if (degree >= 6) status = "hub";

      return { id: n.id, type: n.type, degree, inbound, outbound, complexity, distance: dist, status };
    });

    root.innerHTML = `
      <div class="card border-0 shadow-sm">
        <div class="card-header py-2">
          <div class="d-flex justify-content-between align-items-center">
            <span class="fw-semibold">Graph Diagnostics</span>
            <div class="small text-muted">nodes: ${nodes.length}</div>
          </div>
        </div>
        <div class="card-body p-2">
          <div class="d-flex gap-2 mb-2">
            <select class="form-select form-select-sm" data-diag-filter="status" style="max-width:150px;">
              <option value="">All statuses</option>
              <option value="isolated">🟥 Isolated</option>
              <option value="producer">🔵 Producer</option>
              <option value="consumer">🟢 Consumer</option>
              <option value="hub">🟣 Hub</option>
            </select>

            <select class="form-select form-select-sm" data-diag-filter="type" style="max-width:150px;">
              <option value="">All types</option>
              <option value="controller">controller</option>
              <option value="service">service</option>
              <option value="repository">repository</option>
              <option value="config">config</option>
              <option value="core">core</option>
              <option value="helper">helper</option>
              <option value="file">file</option>
            </select>
          </div>

          <div class="table-responsive">
            <table class="table table-sm table-hover mb-0" style="font-size: 12px;">
              <thead>
                <tr>
                  <th data-sort="id">File</th>
                  <th data-sort="type">Type</th>
                  <th data-sort="status">Status</th>
                  <th data-sort="degree">Deg</th>
                  <th data-sort="inbound">In</th>
                  <th data-sort="outbound">Out</th>
                  <th data-sort="complexity">Cx</th>
                  <th data-sort="distance">Dist</th>
                </tr>
              </thead>
              <tbody></tbody>
            </table>
          </div>
        </div>
      </div>
    `;

    const tbody = root.querySelector("tbody");
    const sortState = { column: "distance", asc: false };

    const truncate = (s) => {
      if (!s) return "";
      if (s.length < 40) return s;
      return "…" + s.slice(-38);
    };

    const statusEmoji = (st) => ({ isolated: "🟥", producer: "🔵", consumer: "🟢", hub: "🟣" }[st] || "");

    function renderTable() {
      const statusFilter = root.querySelector('[data-diag-filter="status"]').value;
      const typeFilter = root.querySelector('[data-diag-filter="type"]').value;

      let rows = enriched.filter((r) => {
        if (statusFilter && r.status !== statusFilter) return false;
        if (typeFilter && r.type !== typeFilter) return false;
        return true;
      });

      rows.sort((a, b) => {
        const col = sortState.column;
        const av = a[col] ?? -Infinity;
        const bv = b[col] ?? -Infinity;
        if (av < bv) return sortState.asc ? -1 : 1;
        if (av > bv) return sortState.asc ? 1 : -1;
        return 0;
      });

      tbody.innerHTML = rows.map((r) => `
        <tr data-node="${escapeHtml(r.id)}">
          <td title="${escapeHtml(r.id)}">${escapeHtml(truncate(r.id))}</td>
          <td>${escapeHtml(r.type)}</td>
          <td>${statusEmoji(r.status)} ${escapeHtml(r.status)}</td>
          <td>${r.degree}</td>
          <td>${r.inbound}</td>
          <td>${r.outbound}</td>
          <td>${r.complexity ?? "–"}</td>
          <td>${r.distance}</td>
        </tr>
      `).join("");
    }

    tbody.addEventListener("click", (e) => {
      const tr = e.target.closest("tr");
      if (!tr) return;
      const id = tr.getAttribute("data-node");
      if (!id) return;
      window.highlightGraphNode(svgId, id);
    });

    root.querySelectorAll("th[data-sort]").forEach((th) => {
      th.style.cursor = "pointer";
      th.addEventListener("click", () => {
        const col = th.getAttribute("data-sort");
        if (sortState.column === col) sortState.asc = !sortState.asc;
        else { sortState.column = col; sortState.asc = true; }
        renderTable();
      });
    });

    root.querySelectorAll("[data-diag-filter]").forEach((sel) => {
      sel.addEventListener("change", renderTable);
    });

    renderTable();
  };

  window.CodeGraphUI = CodeGraphUI;
})();
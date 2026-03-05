/**
 * CodeGraph UI (ESM)
 * ==================
 *
 * This is the browser-side UI helper layer for the D3 code structure graph.
 *
 * Goals
 * -----
 * - Pure ESM (no `window.CodeGraphUI` globals / no bridge)
 * - Small, explicit surface area used by the renderer:
 *   - escapeHtml
 *   - updateGraphHeader
 *   - buildLegendFilterPanel
 *   - attachLegendFilterWiring
 *   - buildGraphLegend (lightweight)
 *   - setupGraphFilters (compat no-op)
 *   - buildGraphDiagnosticsPanel (compat no-op)
 */

// ---------------------------------------------------------------------------
// State (per SVG id)
// ---------------------------------------------------------------------------

/** @type {Map<string, any>} */
const stateBySvgId = new Map();

function defaultState() {
  return {
    preset: "architecture",
    showNodeGroups: {
      root: true,
      dir: true,
      code: true,
      doc: true,
      data: true,
      image: true,
    },
    visibleLinkTypes: {
      include: true,
      use: true,
      call: true,
      extends: true,
    },
    showFilesDirs: true,
    showFunctions: true,
    showUnused: false,
    unusedOnly: false,
    showVisitorHandlers: true,
    hideIsolates: false,
  };
}

export function getState(svgId) {
  const id = String(svgId || "");
  if (!id) return defaultState();
  if (!stateBySvgId.has(id)) stateBySvgId.set(id, defaultState());
  return stateBySvgId.get(id);
}

export function setState(svgId, patch) {
  const id = String(svgId || "");
  if (!id) return;
  const cur = getState(id);
  stateBySvgId.set(id, { ...cur, ...(patch || {}) });
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function hasOwn(obj, key) {
  return Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key);
}

function dispatchFiltersChanged(svgId) {
  const detail = { svgId: String(svgId || ""), state: getState(svgId) };
  window.dispatchEvent(new CustomEvent("codegraph:filters-changed", { detail }));
}

function isFunctionNode(n) {
  return String(n?.kind || n?.type || "") === "function";
}

function isUnusedFunctionNode(n) {
  return Boolean(n?._unused === true);
}

function isVisitorHandlerNode(n) {
  // Keep the heuristic lightweight; backend can tag `_role` later.
  if (n?._role === "visitor-handler") return true;
  const nm = String(n?.name || "");
  if (!nm) return false;
  // Common Babel visitor keys (subset).
  return (
    nm === "CallExpression" ||
    nm === "ImportDeclaration" ||
    nm === "ExportNamedDeclaration" ||
    nm === "Function" ||
    nm === "Identifier"
  );
}

function computeDegrees(nodes, links) {
  /** @type {Record<string,{in:number,out:number}>} */
  const deg = Object.create(null);

  for (const n of nodes || []) {
    const id = String(n?.id || "");
    if (!id) continue;
    deg[id] = { in: 0, out: 0 };
  }

  for (const l of links || []) {
    const s = typeof l?.source === "object" ? l.source?.id : l?.source;
    const t = typeof l?.target === "object" ? l.target?.id : l?.target;
    const sId = String(s || "");
    const tId = String(t || "");
    if (!sId || !tId) continue;
    if (!deg[sId]) deg[sId] = { in: 0, out: 0 };
    if (!deg[tId]) deg[tId] = { in: 0, out: 0 };
    deg[sId].out++;
    deg[tId].in++;
  }

  return deg;
}

function isIsolateNode(n, deg) {
  const id = String(n?.id || "");
  const d = deg?.[id];
  if (!d) return false;
  return (Number(d.in) + Number(d.out)) === 0;
}

// ---------------------------------------------------------------------------
// Public UI surface
// ---------------------------------------------------------------------------

/** Update the little header above the graph SVG. */
export function updateGraphHeader({ appName, functions, loc }) {
  const h = document.getElementById("graphInfoHeader");
  if (!h) return;
  h.textContent = `${String(appName || "Graph")} · ƒ ${Number(functions || 0)} · LOC ${Number(loc || 0)}`;
}

/**
 * Build the Legend & Filter panel.
 * Renders checkboxes and persists changes in `stateBySvgId`.
 */
export function buildLegendFilterPanel(svgId, nodes, links, opts = {}) {
  const root = document.getElementById("legendFilterPanel");
  if (!root) return;

  const id = String(svgId || "");
  const state = getState(id);

  const nodeGroups = ["root", "dir", "code", "doc", "data", "image"];
  const linkTypes = ["include", "use", "call", "extends"];

  const groupColors = opts.nodeGroupColors || Object.create(null);
  const linkColors = opts.linkTypeColors || Object.create(null);

  const checkbox = (name, checked, label, badgeHtml = "") => {
    const safe = escapeHtml;
    return `
      <label class="d-flex align-items-center justify-content-between gap-2 py-1">
        <span class="d-flex align-items-center gap-2">
          <input type="checkbox" class="form-check-input" data-cg-name="${safe(name)}" ${checked ? "checked" : ""} />
          <span class="small">${safe(label)}</span>
        </span>
        ${badgeHtml}
      </label>
    `;
  };

  const colorDot = (color) =>
    `<span class="rounded-circle" style="display:inline-block;width:10px;height:10px;background:${escapeHtml(color || "#999")}"></span>`;

  root.innerHTML = `
    <div class="small text-secondary mb-2">Filter what is visible in the graph.</div>

    <div class="mb-2">
      <div class="small fw-semibold mb-1">Node groups</div>
      ${nodeGroups
        .map((g) => {
          const badge = groupColors[g] ? `<span>${colorDot(groupColors[g])}</span>` : "";
          const checked = state.showNodeGroups[g] !== false;
          return checkbox(`group:${g}`, checked, g, badge);
        })
        .join("")}
    </div>

    <div class="mb-2">
      <div class="small fw-semibold mb-1">Link types</div>
      ${linkTypes
        .map((t) => {
          const badge = linkColors[t] ? `<span>${colorDot(linkColors[t])}</span>` : "";
          const checked = state.visibleLinkTypes[t] !== false;
          return checkbox(`link:${t}`, checked, t, badge);
        })
        .join("")}
    </div>

    <hr class="my-2" />

    <div class="mb-2">
      <div class="small fw-semibold mb-1">Options</div>
      ${checkbox("opt:showFilesDirs", state.showFilesDirs !== false, "Show files/dirs")}
      ${checkbox("opt:showFunctions", state.showFunctions !== false, "Show functions")}
      ${checkbox("opt:showUnused", state.showUnused === true, "Show unused")}
      ${checkbox("opt:unusedOnly", state.unusedOnly === true, "Unused only")}
      ${checkbox("opt:showVisitorHandlers", state.showVisitorHandlers !== false, "Show visitor handlers")}
      ${checkbox("opt:hideIsolates", state.hideIsolates === true, "Hide isolates")}
    </div>
  `;

  root.addEventListener(
    "change",
    (ev) => {
      const el = /** @type {HTMLInputElement|null} */ (ev?.target || null);
      if (!el) return;
      const key = String(el.getAttribute("data-cg-name") || "");
      if (!key) return;
      const checked = el.checked === true;

      const st = getState(id);

      if (key.startsWith("group:")) {
        const g = key.slice("group:".length);
        st.showNodeGroups = { ...(st.showNodeGroups || {}), [g]: checked };
        stateBySvgId.set(id, st);
        dispatchFiltersChanged(id);
        return;
      }

      if (key.startsWith("link:")) {
        const t = key.slice("link:".length);
        st.visibleLinkTypes = { ...(st.visibleLinkTypes || {}), [t]: checked };
        stateBySvgId.set(id, st);
        dispatchFiltersChanged(id);
        return;
      }

      if (key.startsWith("opt:")) {
        const opt = key.slice("opt:".length);

        if (opt === "unusedOnly") {
          st.unusedOnly = checked;
          if (checked) st.showUnused = true; // implied
        } else if (opt === "showUnused") {
          st.showUnused = checked;
          if (!checked) st.unusedOnly = false;
        } else {
          st[opt] = checked;
        }

        stateBySvgId.set(id, st);
        dispatchFiltersChanged(id);
      }
    },
    { passive: true }
  );

  // First paint should match state.
  dispatchFiltersChanged(id);

  // Keep badges in the accordion header up to date.
  try {
    const summary = document.getElementById("filterSummary");
    if (summary) summary.textContent = String(state.preset || "custom");
  } catch {
    // ignore
  }

  // Silence unused args (future: show counts)
  void nodes;
  void links;
}

/**
 * Apply the filter state to D3 selections.
 *
 * The renderer passes us the node/label/link selections so this module
 * stays DOM/renderer-agnostic.
 */
export function attachLegendFilterWiring(svgId, nodes, links, sels) {
  const id = String(svgId || "");
  if (!id) return;

  const nodeShapeSel = sels?.nodeShapeSel;
  const labelSel = sels?.labelSel;
  const linkSel = sels?.linkSel;
  const unusedBadgeSel = sels?.unusedBadgeSel;

  if (!nodeShapeSel || !labelSel || !linkSel) {
    console.warn("CodeGraphUI.attachLegendFilterWiring: missing selections", { svgId, sels });
    return;
  }

  const apply = (state) => {
    const st = state && typeof state === "object" ? state : defaultState();
    const effShowUnused = st.unusedOnly ? true : st.showUnused === true;
    const deg = computeDegrees(nodes, links);

    const hidden = new Set();

    for (const n of nodes || []) {
      const nid = String(n?.id || "");
      if (!nid) continue;

      const group = String(n?.group || "").trim();
      if (group && hasOwn(st.showNodeGroups, group) && st.showNodeGroups[group] === false) {
        hidden.add(nid);
        continue;
      }

      const isFn = isFunctionNode(n);
      if (st.showFunctions === false && isFn) {
        hidden.add(nid);
        continue;
      }
      if (st.showFilesDirs === false && !isFn) {
        hidden.add(nid);
        continue;
      }

      const unused = isUnusedFunctionNode(n);
      if (!effShowUnused && unused) {
        hidden.add(nid);
        continue;
      }
      if (st.unusedOnly === true && isFn && !unused) {
        hidden.add(nid);
        continue;
      }

      if (st.showVisitorHandlers === false && isFn && isVisitorHandlerNode(n)) {
        hidden.add(nid);
        continue;
      }

      if (st.hideIsolates === true && isIsolateNode(n, deg)) {
        hidden.add(nid);
        continue;
      }
    }

    const nodeDisplay = (d) => (hidden.has(String(d?.id || "")) ? "none" : null);
    nodeShapeSel.style("display", nodeDisplay);
    labelSel.style("display", nodeDisplay);

    if (unusedBadgeSel) {
      unusedBadgeSel.style("display", (d) => {
        const nid = String(d?.id || "");
        if (hidden.has(nid)) return "none";
        if (!effShowUnused) return "none";
        return isUnusedFunctionNode(d) ? "block" : "none";
      });
    }

    linkSel.style("display", (l) => {
      const sid = typeof l?.source === "object" ? l.source?.id : l?.source;
      const tid = typeof l?.target === "object" ? l.target?.id : l?.target;
      const sId = String(sid || "");
      const tId = String(tid || "");
      if (hidden.has(sId) || hidden.has(tId)) return "none";
      const ty = String(l?.type || "use");
      if (hasOwn(st.visibleLinkTypes, ty) && st.visibleLinkTypes[ty] === false) return "none";
      return null;
    });
  };

  const onFiltersChanged = (ev) => {
    try {
      const detail = ev?.detail;
      if (!detail) return;
      if (String(detail.svgId || "") !== id) return;
      apply(detail.state);
    } catch {
      // ignore
    }
  };

  window.addEventListener("codegraph:filters-changed", onFiltersChanged);

  // Apply immediately.
  apply(getState(id));
}

// ---------------------------------------------------------------------------
// Compatibility hooks used by the renderer (kept lightweight)
// ---------------------------------------------------------------------------

export function buildGraphLegend() {
  // The project uses a combined “Legend & Filter” panel.
  // Keep this function as a compatibility no-op.
}

export function setupGraphFilters() {
  // Legacy toolbar filters are no longer used.
  // Kept as a compatibility no-op.
}

export function buildGraphDiagnosticsPanel() {
  // Diagnostics table is optional; keep as no-op for now.
}

/**
 * CodeGraph UI state + filter wiring.
 * ---------------------------------------------------------------------------
 * Browserseitige UI‑Helfer für die D3 Code‑Strukturvisualisierung.
 *
 * Zweck
 * - Hält den Filterzustand pro Graph (`svgId`).
 * - Verdrahtet UI‑Filter mit den D3‑Selections des Renderers.
 * - Bietet kleine, stabile Hilfsfunktionen für Anzeige und Escaping.
 *
 * Grenzen
 * - Panel‑Markup und Panel‑Interaktion liegen in `ui.panel.js`.
 * - Dieses Modul kennt keine Chart‑Initialisierung und kein D3‑Layout.
 *
 * Öffentliche API
 * - getState()
 * - setState()
 * - escapeHtml()
 * - updateGraphHeader()
 * - attachLegendFilterWiring()
 */



import { escapeHtml, normalizeLinkType } from "./shared.js";
import { buildLegendFilterPanel as buildLegendFilterPanelModule } from "./ui.panel.js";

// ---------------------------------------------------------------------------
// Legend panel entrypoint (renderer API)
// ---------------------------------------------------------------------------

/**
 * Render the legend/filter panel for a graph instance.
 *
 * The renderer calls this through CodeGraphUI.buildLegendFilterPanel.
 * This wrapper injects the UI state helpers required by ui.panel.js.
 */
export function buildLegendFilterPanel(svgId, nodes, links, opts = {}) {
  return buildLegendFilterPanelModule(svgId, nodes, links, {
    ...opts,
    getState,
    stateBySvgId,
    dispatchFiltersChanged,
    updateGroupFilter,
    updateLinkFilter,
    updateOptionFilter,
    escapeHtml,
  });
}

// ---------------------------------------------------------------------------
// State (per SVG id)
// ---------------------------------------------------------------------------

// Per-graph filter state cache, keyed by rendered SVG id.
/** @type {Map<string, any>} */
export const stateBySvgId = new Map();

/**
 * Create the default filter state for the call graph visualization.
 *
 * This state is used as the initial configuration for a graph instance
 * before any user interaction or persisted settings are applied.
 *
 * The structure is intentionally flat and serializable so it can be
 * easily stored (e.g. localStorage, Map keyed by svgId) and merged
 * with partial updates.
 *
 * @returns {Object} Default filter configuration
 * @returns {string} returns.preset
 *   Name of the active preset configuration.
 *
 * @returns {Object.<string, boolean>} returns.showNodeGroups
 *   Visibility flags for node categories.
 *   If a group is `false`, nodes of that group will not be rendered.
 *
 * @returns {Object.<string, boolean>} returns.visibleLinkTypes
 *   Visibility flags for link/edge relationship types.
 *   Used to filter edges during graph rendering.
 *
 * @returns {boolean} returns.showFilesDirs
 *   Toggle visibility of file and directory nodes.
 *
 * @returns {boolean} returns.showFunctions
 *   Toggle visibility of function-level nodes.
 *
 * @returns {boolean} returns.showUnused
 *   If enabled, unused nodes are highlighted or included in filtering.
 *
 * @returns {boolean} returns.unusedOnly
 *   If enabled, the graph will display only unused nodes.
 *
 * @returns {boolean} returns.showVisitorHandlers
 *   Toggle visibility of visitor handler nodes.
 *
 * @returns {boolean} returns.hideIsolates
 *   If enabled, nodes without connections are hidden.
 */
function defaultState() {
  return {
    // Name of the active preset configuration
    preset: "architecture",

    // Visibility configuration for node groups
    showNodeGroups: {
      root: true,   // project root node
      dir: true,    // directories
      code: true,   // source code files
      doc: true,    // documentation files
      data: true,   // data/config files
      image: true,  // image/media assets
    },

    // Visibility configuration for edge/link types
    visibleLinkTypes: {
      include: true, // include/import relationship
      use: true,     // usage relationship
      call: true,    // function call relationship
      extends: true, // inheritance/extension relationship
    },

    // General visibility options
    showFilesDirs: true,       // show file and directory nodes
    showFunctions: true,       // show function nodes
    showUnused: false,         // highlight/include unused nodes
    unusedOnly: false,         // show only unused nodes
    showVisitorHandlers: true, // show AST visitor handler nodes
    hideIsolates: false,       // hide nodes without edges
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

function hasOwn(obj, key) {
  return Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key);
}

export { escapeHtml };

export function dispatchFiltersChanged(svgId) {
  const detail = { svgId: String(svgId || ""), state: getState(svgId) };
  window.dispatchEvent(new CustomEvent("codegraph:filters-changed", { detail }));
}

function isFunctionNode(n) {
  return String(n?.kind || n?.type || "") === "function";
}

function isUnusedFunctionNode(n) {
  return Boolean(n?._unused === true);
}

function hasVisitorHandlerRole(n) {
  return n?._role === "visitor-handler";
}

function isKnownVisitorHandlerName(name) {
  return (
    name === "CallExpression" ||
    name === "ImportDeclaration" ||
    name === "ExportNamedDeclaration" ||
    name === "Function" ||
    name === "Identifier"
  );
}

function isVisitorHandlerNode(n) {
  // Keep the heuristic lightweight; backend can tag `_role` later.
  if (hasVisitorHandlerRole(n)) return true;

  const nm = String(n?.name || "");
  if (!nm) return false;

  // Common Babel visitor keys (subset).
  return isKnownVisitorHandlerName(nm);
}

function computeDegrees(nodes, links) {
  /** @type {Record<string,{in:number,out:number}>} */
  const deg = Object.create(null);

  seedDegreeMapFromNodes(deg, nodes);
  applyDegreesFromLinks(deg, links);

  return deg;
}

function seedDegreeMapFromNodes(deg, nodes) {
  for (const n of nodes || []) {
    const id = nodeId(n);
    if (!id) continue;
    ensureDegreeEntry(deg, id);
  }
}

function applyDegreesFromLinks(deg, links) {
  for (const l of links || []) {
    const edge = readLinkEndpointIds(l);
    if (!edge) continue;

    ensureDegreeEntry(deg, edge.sId);
    ensureDegreeEntry(deg, edge.tId);

    deg[edge.sId].out++;
    deg[edge.tId].in++;
  }
}

function nodeId(n) {
  return String(n?.id || "");
}

function linkEndpointId(x) {
  return typeof x === "object" ? x?.id : x;
}

function readLinkEndpointIds(l) {
  const sId = String(linkEndpointId(l?.source) || "");
  const tId = String(linkEndpointId(l?.target) || "");
  if (!sId || !tId) return null;
  return { sId, tId };
}

function ensureDegreeEntry(deg, id) {
  if (deg[id]) return;
  deg[id] = { in: 0, out: 0 };
}

// ---------------------------------------------------------------------------
// Public UI surface
// ---------------------------------------------------------------------------

/**
 * Update the compact graph header shown above the SVG.
 *
 * @param {{ appName:any, functions:any, loc:any }} param0
 */
export function updateGraphHeader({ appName, functions, loc }) {
  const h = document.getElementById("graphInfoHeader");
  if (!h) return;
  h.textContent = `${String(appName || "Graph")} · ƒ ${Number(functions || 0)} · LOC ${Number(loc || 0)}`;
}

/**
 * Mutate one node-group visibility flag.
 *
 * Kept mutation-based on purpose because the panel already works on the live
 * per-graph state object before it is written back into the state map.
 */
export function updateGroupFilter(st, key, checked) {
  const group = key.slice("group:".length);
  st.showNodeGroups = { ...(st.showNodeGroups || {}), [group]: checked };
}

/**
 * Mutate one link-type visibility flag.
 */
export function updateLinkFilter(st, key, checked) {
  const type = key.slice("link:".length);
  st.visibleLinkTypes = { ...(st.visibleLinkTypes || {}), [type]: checked };
}

function optionNameFromKey(key) {
  return String(key || "").slice("opt:".length);
}

function updateUnusedOnlyOption(st, checked) {
  st.unusedOnly = checked;
  if (checked) st.showUnused = true;
}

function updateShowUnusedOption(st, checked) {
  st.showUnused = checked;
  if (!checked) st.unusedOnly = false;
}

/**
 * Mutate one boolean option flag.
 *
 * Special cases:
 * - `unusedOnly` implies `showUnused`
 * - disabling `showUnused` also disables `unusedOnly`
 */
export function updateOptionFilter(st, key, checked) {
  const opt = optionNameFromKey(key);

  if (opt === "unusedOnly") {
    updateUnusedOnlyOption(st, checked);
    return;
  }

  if (opt === "showUnused") {
    updateShowUnusedOption(st, checked);
    return;
  }

  st[opt] = checked;
}



/**
 * Verify that the minimum D3 selections required for live filter repaint exist.
 */
function hasRequiredSelections(nodeShapeSel, labelSel, linkSel) {
  return Boolean(nodeShapeSel && labelSel && linkSel);
}

/**
 * Emit one focused warning when live filter wiring cannot be attached.
 */
function warnMissingSelections(svgId, sels) {
  console.warn("CodeGraphUI.attachLegendFilterWiring: missing selections", { svgId, sels });
}

function readLegendSelections(sels) {
  return {
    nodeShapeSel: sels?.nodeShapeSel,
    labelSel: sels?.labelSel,
    linkSel: sels?.linkSel,
    unusedBadgeSel: sels?.unusedBadgeSel,
  };
}

/**
 * Attach live legend/filter wiring for one rendered graph instance.
 *
 * Flow
 * ----
 * - validate required D3 selections
 * - derive effective visibility state
 * - hide/show node, label, badge, and link selections
 * - subscribe to `codegraph:filters-changed`
 *
 * Design note
 * -----------
 * The renderer owns the D3 selections. This module only applies visibility
 * rules to those selections based on the current per-graph UI state.
 *
 * @param {string} svgId
 * @param {any[]} nodes
 * @param {any[]} links
 * @param {{ nodeShapeSel:any, labelSel:any, linkSel:any, unusedBadgeSel:any }} sels
 */
export function attachLegendFilterWiring(svgId, nodes, links, sels) {
  const id = String(svgId || "");
  if (!id) return;

  const selectionBundle = readLegendSelections(sels);
  const { nodeShapeSel, labelSel, linkSel, unusedBadgeSel } = selectionBundle;

  if (!hasRequiredSelections(nodeShapeSel, labelSel, linkSel)) {
    warnMissingSelections(svgId, sels);
    return;
  }

  function normalizeFilterState(state) {
    return state && typeof state === "object" ? state : defaultState();
  }

  function shouldShowUnused(st) {
    return st.unusedOnly ? true : st.showUnused === true;
  }

  function getNodeId(n) {
    return String(n?.id || "");
  }

  function isGroupHidden(n, st) {
    const group = String(n?.group || "").trim();
    if (!group) return false;
    if (!hasOwn(st.showNodeGroups, group)) return false;
    return st.showNodeGroups[group] === false;
  }

  function isHiddenByKindFilters(n, st) {
    const isFn = isFunctionNode(n);
    if (st.showFunctions === false && isFn) return true;
    if (st.showFilesDirs === false && !isFn) return true;
    return false;
  }

  function isHiddenByUnusedFilters(n, st, effShowUnused) {
    const isFn = isFunctionNode(n);
    const unused = isUnusedFunctionNode(n);

    if (!effShowUnused && unused) return true;
    if (st.unusedOnly !== true) return false;
    if (!isFn) return false;
    if (!unused) return true;
    return false;
  }

  function isHiddenByVisitorHandlerFilter(n, st) {
    if (st.showVisitorHandlers !== false) return false;
    if (!isFunctionNode(n)) return false;
    return isVisitorHandlerNode(n);
  }

  function isHiddenByIsolateFilter(n, st, deg) {
    if (st.hideIsolates !== true) return false;
    return isIsolateNode(n, deg);
  }

  function shouldHideNode(n, st, effShowUnused, deg) {
    if (isGroupHidden(n, st)) return true;
    if (isHiddenByKindFilters(n, st)) return true;
    if (isHiddenByUnusedFilters(n, st, effShowUnused)) return true;
    if (isHiddenByVisitorHandlerFilter(n, st)) return true;
    if (isHiddenByIsolateFilter(n, st, deg)) return true;
    return false;
  }

  function collectHiddenNodeIds(nodes, st, effShowUnused, deg) {
    const hidden = new Set();

    for (const n of nodes || []) {
      const nid = getNodeId(n);
      if (!nid) continue;
      if (!shouldHideNode(n, st, effShowUnused, deg)) continue;
      hidden.add(nid);
    }

    return hidden;
  }

  function nodeDisplayFromHidden(hidden) {
    return (d) => (hidden.has(getNodeId(d)) ? "none" : null);
  }

  function filterLinkEndpointId(x) {
    return typeof x === "object" ? x?.id : x;
  }

  function readLinkSourceId(l) {
    return String(filterLinkEndpointId(l?.source) || "");
  }

  function readLinkTargetId(l) {
    return String(filterLinkEndpointId(l?.target) || "");
  }

  function isHiddenByHiddenEndpoint(l, hidden) {
    const sId = readLinkSourceId(l);
    const tId = readLinkTargetId(l);
    return hidden.has(sId) || hidden.has(tId);
  }

  function readLinkFilterType(l) {
    return normalizeLinkType(l, "use");
  }

  function isHiddenByLinkTypeFilter(l, st) {
    const ty = readLinkFilterType(l);
    const visible = st?.visibleLinkTypes;
    if (!visible || typeof visible !== "object") return false;
    if (!hasOwn(visible, ty)) return false;
    return visible[ty] === false;
  }

  function isHiddenLink(l, hidden, st) {
    if (isHiddenByHiddenEndpoint(l, hidden)) return true;
    if (isHiddenByLinkTypeFilter(l, st)) return true;
    return false;
  }

  function applyNodeVisibility(nodeShapeSel, labelSel, hidden) {
    const nodeDisplay = nodeDisplayFromHidden(hidden);
    nodeShapeSel.style("display", nodeDisplay);
    labelSel.style("display", nodeDisplay);
  }

  function applyUnusedBadgeVisibility(unusedBadgeSel, hidden, effShowUnused) {
    if (!unusedBadgeSel) return;

    unusedBadgeSel.style("display", (d) => {
      const nid = getNodeId(d);
      if (hidden.has(nid)) return "none";
      if (!effShowUnused) return "none";
      return isUnusedFunctionNode(d) ? "block" : "none";
    });
  }

  function applyLinkVisibility(linkSel, hidden, st) {
  let total = 0;
  let hiddenCount = 0;
  const byType = Object.create(null);

  linkSel.each((l) => {
    total += 1;
    const ty = readLinkFilterType(l);
    byType[ty] = (byType[ty] || 0) + 1;
    if (isHiddenLink(l, hidden, st)) hiddenCount += 1;
  });




  linkSel.style("display", (l) => (isHiddenLink(l, hidden, st) ? "none" : null));
}

  // Recompute and apply all visibility rules for the current UI state.
  const apply = (state) => {
    const st = normalizeFilterState(state);
    const effShowUnused = shouldShowUnused(st);
    const deg = computeDegrees(nodes, links);

    const hidden = collectHiddenNodeIds(nodes, st, effShowUnused, deg);

    applyNodeVisibility(nodeShapeSel, labelSel, hidden);
    applyUnusedBadgeVisibility(unusedBadgeSel, hidden, effShowUnused);
    applyLinkVisibility(linkSel, hidden, st);
  };

  // React only to filter events for this graph instance.
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

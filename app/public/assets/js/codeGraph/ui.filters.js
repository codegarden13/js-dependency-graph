/**
 * CodeGraph legend/filter wiring.
 * ---------------------------------------------------------------------------
 * This module is the thin orchestration layer between:
 * - panel rendering
 * - live D3 filter wiring
 * - renderer-owned graph context (`d3_codeStructure.js`)
 *
 * Responsibilities
 * - normalize one graph-specific wiring context
 * - extract only the D3 selections needed for repaint
 * - render the legend/filter panel
 * - connect checkbox state changes to the live graph selections
 *
 * Dependency model
 * ----------------
 * This module does not import `ui.js` or `ui.panel.js` directly.
 * The renderer passes all required hooks through `ctx.deps`.
 */

/**
 * Check whether a value is callable.
 *
 * @param {any} fn
 * @returns {boolean}
 */
function isFn(fn) {
  return typeof fn === "function";
}

/**
 * Narrow value to a plain object.
 * Keeps downstream code branch-free.
 *
 * @param {any} v
 * @returns {Record<string, any>|null}
 */
function asPlainObject(v) {
  return (v && typeof v === "object") ? /** @type {any} */ (v) : null;
}

/**
 * Read and normalize `svgId` from a context object.
 *
 * @param {Record<string, any>|null} obj
 * @returns {string}
 */
function readSvgId(obj) {
  return String(obj?.svgId || "").trim();
}

/**
 * Read an array field or return an empty array.
 *
 * @param {any} v
 * @returns {any[]}
 */
function asArray(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * Read an object field or return an empty object.
 *
 * @param {any} v
 * @returns {Record<string, any>}
 */
function asObjectOrEmpty(v) {
  return (v && typeof v === "object") ? /** @type {any} */ (v) : Object.create(null);
}

/**
 * Normalize one legend/filter dependency bag.
 *
 * Output contract
 * ---------------
 * Always returns a plain object so downstream access stays predictable.
 *
 * @param {any} deps
 * @returns {Record<string, any>}
 */
function normalizeLegendFilterDeps(deps) {
  return asObjectOrEmpty(deps);
}

/**
 * Normalize one legend/filter wiring context.
 *
 * Why this exists
 * ---------------
 * The renderer may pass partially built objects while different pages evolve.
 * This helper creates one predictable shape so downstream code stays small and
 * branch-light.
 *
 * Output contract
 * ---------------
 * - `svgId` is required
 * - `nodes` and `links` are always arrays
 * - `sels` is always a plain object
 * - `deps` is always a plain object
 *
 * @param {any} ctx
 * @returns {{
 *   svgId:string,
 *   nodes:any[],
 *   links:any[],
 *   sels:Record<string, any>,
 *   deps:Record<string, any>
 * }|null}
 */
function normalizeLegendFilterCtx(ctx) {
  const input = asPlainObject(ctx);
  if (!input) return null;

  const svgId = readSvgId(input);
  if (!svgId) return null;

  return {
    svgId,
    nodes: asArray(input.nodes),
    links: asArray(input.links),
    sels: asObjectOrEmpty(input.sels),
    deps: normalizeLegendFilterDeps(input.deps),
  };
}

/**
 * Pick only the selections needed for live repaint.
 *
 * The graph renderer owns a larger selection bundle. The legend/filter logic
 * only needs the subset that is affected by visibility toggles.
 *
 * @param {Record<string, any>} sels
 * @returns {{
 *   nodeShapeSel:any,
 *   labelSel:any,
 *   linkSel:any,
 *   unusedBadgeSel:any
 * }}
 */
function pickLegendSelections(sels) {
  const safe = asObjectOrEmpty(sels);

  return {
    nodeShapeSel: safe.nodeShapeSel,
    labelSel: safe.labelSel,
    linkSel: safe.linkSel,
    unusedBadgeSel: safe.unusedBadgeSel,
  };
}

/**
 * Render the shared legend/filter panel.
 *
 * This is intentionally tolerant: if the panel builder is missing, wiring can
 * still continue without crashing the renderer.
 *
 * @param {string} svgId
 * @param {any[]} nodes
 * @param {any[]} links
 * @param {Record<string, any>} deps
 */
function renderLegendFilterPanel(svgId, nodes, links, deps) {
  const buildLegendFilterPanel = deps.buildLegendFilterPanel;
  if (!isFn(buildLegendFilterPanel)) return;

  buildLegendFilterPanel(svgId, nodes, links, deps);
}

/**
 * Attach checkbox-driven filter wiring to the live D3 selections.
 *
 * Failure to wire is non-fatal for chart rendering, but we warn because the UI
 * would otherwise look present while not affecting the graph.
 *
 * @param {string} svgId
 * @param {any[]} nodes
 * @param {any[]} links
 * @param {{nodeShapeSel:any,labelSel:any,linkSel:any,unusedBadgeSel:any}} sels
 * @param {Record<string, any>} deps
 */
function attachLegendFilterWiringOrWarn(svgId, nodes, links, sels, deps) {
  const attachLegendFilterWiring = deps.attachLegendFilterWiring;
  if (!isFn(attachLegendFilterWiring)) {
    console.warn(
      "attachLegendFilterWiring missing. Update UI dependencies to enable live filter repaint."
    );
    return;
  }

  attachLegendFilterWiring(svgId, nodes, links, sels);
}

/**
 * Wire legend + filters for one graph instance.
 *
 * Flow
 * ----
 * - normalize renderer input
 * - render the panel surface
 * - attach live visibility wiring to D3 selections
 *
 * Deliberate limits
 * -----------------
 * This module does not own filter state, panel markup internals, or renderer
 * selections. It only coordinates those pieces.
 *
 * @param {any} ctx
 */
export function wireLegendAndFilters(ctx) {
  const normalized = normalizeLegendFilterCtx(ctx);
  if (!normalized) return;

  const selections = pickLegendSelections(normalized.sels);

  renderLegendFilterPanel(
    normalized.svgId,
    normalized.nodes,
    normalized.links,
    normalized.deps
  );

  attachLegendFilterWiringOrWarn(
    normalized.svgId,
    normalized.nodes,
    normalized.links,
    selections,
    normalized.deps
  );
}

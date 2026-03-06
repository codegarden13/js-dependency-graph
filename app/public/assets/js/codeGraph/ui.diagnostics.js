/****
 * CodeGraph diagnostics helpers.
 * ---------------------------------------------------------------------------
 * Scope
 * - Dev-time dependency checks for the D3 renderer
 * - Graph diagnostics panel entrypoint
 *
 * This module is intentionally small and fail-soft.
 */

/**
 * Build the optional graph diagnostics panel.
 *
 * Deliberately a no-op for now. The renderer calls this hook after the
 * simulation settles so diagnostics can be attached without bloating the
 * renderer file.
 *
 * @param {string} svgId
 * @param {any[]} nodes
 * @param {any[]} links
 * @param {number} width
 * @param {number} height
 */
export function buildGraphDiagnosticsPanel(svgId, nodes, links, width, height) {
  void svgId;
  void nodes;
  void links;
  void width;
  void height;
}

/**
 * Run best-effort dependency checks for `d3_codeStructure.js`.
 *
 * Why this exists
 * ---------------
 * During refactors we want one focused warning when a renderer dependency is
 * missing, but we do not want to crash the page in development.
 *
 * @param {{
 *   d3Global:any,
 *   CodeGraphData:any,
 *   CodeGraphInteractions:any,
 *   renderTypeHulls:any,
 *   CodeGraphUI:any,
 * }} deps
 */
export function assertCodeStructureDeps(deps) {
  const missing = collectMissingDeps(deps);
  warnMissingDeps(missing);
}

/**
 * Collect missing dependencies from the supplied module bag.
 *
 * @param {{
 *   d3Global:any,
 *   CodeGraphData:any,
 *   CodeGraphInteractions:any,
 *   renderTypeHulls:any,
 *   CodeGraphUI:any,
 * }} deps
 * @returns {string[]}
 */
function collectMissingDeps(deps) {
  /** @type {string[]} */
  const missing = [];

  for (const check of getDepChecks(deps)) {
    if (!check || typeof check.isPresent !== "function") continue;
    if (check.isPresent()) continue;
    missing.push(String(check.label || "(unknown dep)"));
  }

  return missing;
}

/**
 * Define the dependencies required by the renderer.
 * Each entry is a small predicate so the warning stays data-driven.
 *
 * @param {{
 *   d3Global:any,
 *   CodeGraphData:any,
 *   CodeGraphInteractions:any,
 *   renderTypeHulls:any,
 *   CodeGraphUI:any,
 * }} deps
 */
function getDepChecks(deps) {
  const CodeGraphData = deps?.CodeGraphData;
  const CodeGraphInteractions = deps?.CodeGraphInteractions;
  const renderTypeHulls = deps?.renderTypeHulls;
  const CodeGraphUI = deps?.CodeGraphUI;

  return [
    { label: "d3 (global)", isPresent: () => Boolean(deps?.d3Global) },
    { label: "CodeGraphData.normalize", isPresent: () => Boolean(CodeGraphData?.normalize) },
    { label: "CodeGraphInteractions.attachNodeInteractions", isPresent: () => Boolean(CodeGraphInteractions?.attachNodeInteractions) },
    { label: "CodeGraphInteractions.drawHighlight", isPresent: () => Boolean(CodeGraphInteractions?.drawHighlight) },
    { label: "CodeGraphInteractions.anchorHighlight", isPresent: () => Boolean(CodeGraphInteractions?.anchorHighlight) },
    { label: "renderTypeHulls", isPresent: () => Boolean(renderTypeHulls) },
    { label: "CodeGraphUI.escapeHtml", isPresent: () => Boolean(CodeGraphUI?.escapeHtml) },
    { label: "CodeGraphUI.attachLegendFilterWiring", isPresent: () => Boolean(CodeGraphUI?.attachLegendFilterWiring) },
    { label: "CodeGraphUI.buildLegendFilterPanel", isPresent: () => Boolean(CodeGraphUI?.buildLegendFilterPanel) },
    { label: "CodeGraphUI.getState", isPresent: () => Boolean(CodeGraphUI?.getState) },
    { label: "CodeGraphUI.stateBySvgId", isPresent: () => Boolean(CodeGraphUI?.stateBySvgId) },
    { label: "CodeGraphUI.dispatchFiltersChanged", isPresent: () => Boolean(CodeGraphUI?.dispatchFiltersChanged) },
    { label: "CodeGraphUI.updateGroupFilter", isPresent: () => Boolean(CodeGraphUI?.updateGroupFilter) },
    { label: "CodeGraphUI.updateLinkFilter", isPresent: () => Boolean(CodeGraphUI?.updateLinkFilter) },
    { label: "CodeGraphUI.updateOptionFilter", isPresent: () => Boolean(CodeGraphUI?.updateOptionFilter) },
  ];
}

/**
 * Emit one focused warning only when dependencies are actually missing.
 *
 * @param {string[]} missing
 */
function warnMissingDeps(missing) {
  if (!Array.isArray(missing) || missing.length === 0) return;

  console.warn(
    "d3_codeStructure.js missing required deps:\n- " +
    missing.map(String).join("\n- ")
  );
}
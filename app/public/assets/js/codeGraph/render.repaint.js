/**
 * CodeGraph repaint helpers.
 * ---------------------------------------------------------------------------
 * Owns visual re-application for already-rendered node, ring, badge, and label
 * selections.
 *
 * When this module is used
 * ------------------------
 * It is called after the initial node render and again whenever live node
 * state changes without rebuilding the full graph, for example:
 * - changed-node markers
 * - exported / unused emphasis
 * - any host-triggered state refresh that only needs style updates
 */

/**
 * Read the current body fill for one node.
 *
 * Why it is called
 * ----------------
 * Called during repaint so fill color can reflect the latest encoder state.
 *
 * @param {any} d
 * @param {{ getNodeColor:(node:any) => string }} enc
 * @returns {string}
 */
function nodeFill(d, enc) {
  return enc.getNodeColor(d);
}

/**
 * Read the current body stroke for one node.
 *
 * Why it is called
 * ----------------
 * Called during repaint so changed/exported emphasis is kept in sync.
 *
 * @param {any} d
 * @param {{ getNodeStroke:(node:any) => string }} enc
 * @returns {string}
 */
function nodeStroke(d, enc) {
  return enc.getNodeStroke(d);
}

/**
 * Read the current body stroke width for one node.
 *
 * Why it is called
 * ----------------
 * Called during repaint when node emphasis may have changed.
 *
 * @param {any} d
 * @param {{ getNodeStrokeWidth:(node:any) => number }} enc
 * @returns {number}
 */
function nodeStrokeWidth(d, enc) {
  return enc.getNodeStrokeWidth(d);
}

/**
 * Read the current node opacity.
 *
 * Why it is called
 * ----------------
 * Called during repaint so unused nodes can be visually de-emphasized.
 *
 * @param {any} d
 * @param {(node:any) => boolean} isUnusedFunctionNode
 * @returns {number}
 */
function nodeOpacity(d, isUnusedFunctionNode) {
  return isUnusedFunctionNode(d) ? 0.25 : 1;
}

/**
 * Read the current node dash pattern.
 *
 * Why it is called
 * ----------------
 * Called during repaint to preserve the dashed styling for unused functions.
 *
 * @param {any} d
 * @param {(node:any) => boolean} isUnusedFunctionNode
 * @returns {string|null}
 */
function nodeDashArray(d, isUnusedFunctionNode) {
  return isUnusedFunctionNode(d) ? "4,3" : null;
}

/**
 * Read the current function-ring radius.
 *
 * Why it is called
 * ----------------
 * Called during repaint because node radius can drive the outer ring geometry.
 *
 * @param {any} d
 * @param {{ getRadius:(node:any) => number }} enc
 * @returns {number}
 */
function ringRadius(d, enc) {
  return enc.getRadius(d) + 4;
}

/**
 * Read the current function-ring stroke.
 *
 * Why it is called
 * ----------------
 * Called during repaint so exported functions keep the stronger ring color.
 *
 * @param {any} d
 * @param {(node:any) => boolean} isFunctionNode
 * @param {string} exportedFunctionColor
 * @returns {string}
 */
function ringStroke(d, isFunctionNode, exportedFunctionColor) {
  if (!isFunctionNode(d)) return "transparent";
  return (d?.exported === true) ? exportedFunctionColor : "rgba(0,0,0,0.25)";
}

/**
 * Read the current function-ring opacity.
 *
 * Why it is called
 * ----------------
 * Called during repaint so non-function nodes keep the ring fully hidden.
 *
 * @param {any} d
 * @param {(node:any) => boolean} isFunctionNode
 * @returns {number}
 */
function ringOpacity(d, isFunctionNode) {
  return isFunctionNode(d) ? 0.95 : 0;
}

/**
 * Read the current function-ring width.
 *
 * Why it is called
 * ----------------
 * Called during repaint so inbound-call emphasis remains accurate.
 *
 * @param {any} d
 * @param {(node:any) => boolean} isFunctionNode
 * @param {(node:any) => number} getFunctionRingWidth
 * @returns {number}
 */
function ringWidth(d, isFunctionNode, getFunctionRingWidth) {
  return isFunctionNode(d) ? getFunctionRingWidth(d) : 0;
}

/**
 * Read the current unused-badge display state.
 *
 * Why it is called
 * ----------------
 * Called during repaint so the badge only appears on unused function nodes.
 *
 * @param {any} d
 * @param {(node:any) => boolean} isUnusedFunctionNode
 * @returns {string}
 */
function badgeDisplay(d, isUnusedFunctionNode) {
  return isUnusedFunctionNode(d) ? "block" : "none";
}

/**
 * Compute the current unused-badge offset from the node center.
 *
 * Why it is called
 * ----------------
 * Called during repaint because badge placement depends on the current node
 * radius and must stay clear of the node body.
 *
 * @param {any} d
 * @param {{ getRadius:(node:any) => number }} enc
 * @returns {number}
 */
function badgeOffset(d, enc) {
  return Math.max(8, enc.getRadius(d) * 0.7);
}

/**
 * Read the current unused-badge opacity.
 *
 * Why it is called
 * ----------------
 * Called during repaint so badge visibility matches the unused state.
 *
 * @param {any} d
 * @param {(node:any) => boolean} isUnusedFunctionNode
 * @returns {number}
 */
function badgeOpacity(d, isUnusedFunctionNode) {
  return isUnusedFunctionNode(d) ? 0.95 : 0;
}

/**
 * Read the current label weight.
 *
 * Why it is called
 * ----------------
 * Called during repaint so recently changed nodes can keep stronger labels.
 *
 * @param {any} d
 * @returns {string}
 */
function labelWeight(d) {
  return d?._changed ? "700" : "400";
}

/**
 * Read the current label color.
 *
 * Why it is called
 * ----------------
 * Called during repaint so changed nodes can be emphasized in the label layer.
 *
 * @param {any} d
 * @returns {string}
 */
function labelFill(d) {
  return d?._changed ? "#111" : "#444";
}

/**
 * Read the current label opacity.
 *
 * Why it is called
 * ----------------
 * Called during repaint so unused nodes keep reduced text emphasis.
 *
 * @param {any} d
 * @param {(node:any) => boolean} isUnusedFunctionNode
 * @returns {number}
 */
function labelOpacity(d, isUnusedFunctionNode) {
  return isUnusedFunctionNode(d) ? 0.35 : 1;
}

/**
 * Re-apply node-body styles.
 *
 * When it is called
 * -----------------
 * Called by the shared repaint pipeline after initial render and after node
 * state updates that affect fill, stroke, or opacity.
 *
 * @param {any} nodeBodySel
 * @param {{ getNodeColor:(node:any)=>string, getNodeStroke:(node:any)=>string, getNodeStrokeWidth:(node:any)=>number }} enc
 * @param {(node:any) => boolean} isUnusedFunctionNode
 */
function repaintNodeBodies(nodeBodySel, enc, isUnusedFunctionNode) {
  nodeBodySel
    .attr("fill", (d) => nodeFill(d, enc))
    .attr("stroke", (d) => nodeStroke(d, enc))
    .attr("stroke-width", (d) => nodeStrokeWidth(d, enc))
    .style("opacity", (d) => nodeOpacity(d, isUnusedFunctionNode))
    .style("stroke-dasharray", (d) => nodeDashArray(d, isUnusedFunctionNode));
}

/**
 * Re-apply function-ring styles.
 *
 * When it is called
 * -----------------
 * Called by the shared repaint pipeline whenever node emphasis must be synced
 * to the ring layer.
 *
 * @param {any} fnRingSel
 * @param {{ getRadius:(node:any)=>number }} enc
 * @param {(node:any) => boolean} isFunctionNode
 * @param {(node:any) => number} getFunctionRingWidth
 * @param {string} exportedFunctionColor
 */
function repaintFunctionRings(fnRingSel, enc, isFunctionNode, getFunctionRingWidth, exportedFunctionColor) {
  fnRingSel
    .attr("r", (d) => ringRadius(d, enc))
    .attr("stroke", (d) => ringStroke(d, isFunctionNode, exportedFunctionColor))
    .attr("stroke-opacity", (d) => ringOpacity(d, isFunctionNode))
    .attr("stroke-width", (d) => ringWidth(d, isFunctionNode, getFunctionRingWidth));
}

/**
 * Re-apply unused-function badge styles.
 *
 * When it is called
 * -----------------
 * Called by the shared repaint pipeline whenever unused markers may have
 * changed or node radius has shifted.
 *
 * @param {any} unusedBadgeSel
 * @param {{ getRadius:(node:any)=>number }} enc
 * @param {(node:any) => boolean} isUnusedFunctionNode
 */
function repaintUnusedBadges(unusedBadgeSel, enc, isUnusedFunctionNode) {
  unusedBadgeSel
    .style("display", (d) => badgeDisplay(d, isUnusedFunctionNode))
    .attr("x", (d) => badgeOffset(d, enc))
    .attr("y", (d) => -badgeOffset(d, enc))
    .style("stroke", "#fff")
    .style("fill", "#111")
    .style("opacity", (d) => badgeOpacity(d, isUnusedFunctionNode));
}

/**
 * Re-apply label styles.
 *
 * When it is called
 * -----------------
 * Called by the shared repaint pipeline after state changes that affect label
 * emphasis or visibility.
 *
 * @param {any} labelSel
 * @param {(node:any) => boolean} isUnusedFunctionNode
 */
function repaintLabels(labelSel, isUnusedFunctionNode) {
  labelSel
    .style("font-weight", (d) => labelWeight(d))
    .style("fill", (d) => labelFill(d))
    .style("opacity", (d) => labelOpacity(d, isUnusedFunctionNode));
}

/**
 * Build the repaint function for one rendered graph instance.
 *
 * When it is called
 * -----------------
 * Created once after the initial render. The returned function is invoked
 * whenever node-local visual state changes and a full graph rebuild would be
 * unnecessary.
 *
 * @param {{
 *   nodes:any[],
 *   enc:{
 *     getNodeColor:(node:any)=>string,
 *     getRadius:(node:any)=>number,
 *     getNodeStroke:(node:any)=>string,
 *     getNodeStrokeWidth:(node:any)=>number
 *   },
 *   nodeBodySel:any,
 *   fnRingSel:any,
 *   unusedBadgeSel:any,
 *   labelSel:any,
 *   isFunctionNode:(node:any)=>boolean,
 *   isUnusedFunctionNode:(node:any)=>boolean,
 *   getFunctionRingWidth:(node:any)=>number,
 *   exportedFunctionColor:string
 * }} deps
 * @returns {() => void}
 */
export function makeRepaint(deps) {
  const safe = (deps && typeof deps === "object") ? deps : Object.create(null);

  return function repaintNodes() {
    repaintNodeBodies(safe.nodeBodySel, safe.enc, safe.isUnusedFunctionNode);
    repaintFunctionRings(
      safe.fnRingSel,
      safe.enc,
      safe.isFunctionNode,
      safe.getFunctionRingWidth,
      safe.exportedFunctionColor
    );
    repaintUnusedBadges(safe.unusedBadgeSel, safe.enc, safe.isUnusedFunctionNode);
    repaintLabels(safe.labelSel, safe.isUnusedFunctionNode);
  };
}

const CodeGraphRenderRepaint = {
  makeRepaint,
};

export { CodeGraphRenderRepaint };
export default CodeGraphRenderRepaint;

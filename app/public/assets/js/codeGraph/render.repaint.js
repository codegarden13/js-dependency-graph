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
  if (d?._changed) return "#ff3b30";

  const base = enc.getNodeColor(d);
  if (!isHotspotNode(d)) return base;

  return mixHex(base, hotspotFillColor(d), hotspotEmphasis01(d) * 0.55);
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
  if (d?._changed) return "#b42318";

  const base = enc.getNodeStroke(d);
  if (!isHotspotNode(d)) return base;

  return mixHex(base, hotspotOutlineColor(d), hotspotEmphasis01(d) * 0.85);
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
  if (d?._changed) return Math.max(2, Number(enc.getNodeStrokeWidth(d)) || 0);
  if (isHotspotNode(d)) return Math.max(2.5, Number(enc.getNodeStrokeWidth(d)) || 0);
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
  if (!shouldShowFunctionRing(d, isFunctionNode)) return "transparent";
  return hasExportedFunctionSignal(d, isFunctionNode)
    ? exportedFunctionColor
    : "rgba(0,0,0,0.25)";
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
  return shouldShowFunctionRing(d, isFunctionNode) ? 0.95 : 0;
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
  if (!shouldShowFunctionRing(d, isFunctionNode)) return 0;

  const ownWidth = Number(getFunctionRingWidth(d)) || 0;
  if (ownWidth > 0) return ownWidth;

  return hasExportedChildFunction(d) ? 2 : 1.5;
}

/** Read child functions from a module/file node. */
function getChildFunctions(d, isFunctionNode) {
  const items = Array.isArray(d?.children) ? d.children : [];
  return items.filter((child) => isFunctionNode(child));
}

/** Read whether a node owns at least one exported child function. */
function hasExportedChildFunction(d, isFunctionNode = (x) => x?.kind === "function") {
  return getChildFunctions(d, isFunctionNode).some((child) => child?.exported === true);
}

/** Read whether a node itself or one of its child functions is exported. */
function hasExportedFunctionSignal(d, isFunctionNode) {
  if (isFunctionNode(d)) return d?.exported === true;
  return hasExportedChildFunction(d, isFunctionNode);
}

/** Read whether the outer function ring should be visible. */
function shouldShowFunctionRing(d, isFunctionNode) {
  return isFunctionNode(d) || hasExportedChildFunction(d, isFunctionNode);
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
  if (d?._changed) return "#111";
  return isHotspotNode(d) ? null : "#444";
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

/** Read whether a node is marked as hotspot. */
function isHotspotNode(d) {
  return Boolean(d?.hotspot) || (Number(d?._hotspotScore) || 0) > 0;
}

/** Read whether a node is a top-ranked hotspot. */
function isTopHotspotNode(d) {
  const rank = Number(d?._hotspotRank);
  return Number.isFinite(rank) && rank > 0 && rank <= 5;
}

/** Clamp a scalar into the 0..1 range. */
function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

/** Read hotspot rank as a safe number. */
function readHotspotRank(d) {
  const rank = Number(d?._hotspotRank);
  return Number.isFinite(rank) && rank > 0 ? rank : null;
}

/** Read raw cyclomatic complexity for hotspot emphasis. */
function readHotspotCc(d) {
  const cc = Number(d?.complexity ?? d?.cc ?? 0);
  return Number.isFinite(cc) && cc > 0 ? cc : 0;
}

/** Convert a hex color into rgb channels. */
function hexToRgb(hex) {
  let safe = String(hex || "").trim().replace(/^#/, "");
  if (safe.length === 3) safe = safe.split("").map((c) => c + c).join("");
  const num = Number.parseInt(safe, 16);
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255
  };
}

/** Convert rgb channels into a hex color. */
function rgbToHex(r, g, b) {
  const toHex = (value) => {
    const safe = Math.max(0, Math.min(255, Math.round(value))).toString(16);
    return safe.length === 1 ? `0${safe}` : safe;
  };

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Interpolate two hex colors. */
function mixHex(a, b, t) {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  const k = clamp01(t);

  return rgbToHex(
    x.r + ((y.r - x.r) * k),
    x.g + ((y.g - x.g) * k),
    x.b + ((y.b - x.b) * k)
  );
}

/**
 * Build one hotspot emphasis score.
 *
 * Strongest nodes are:
 * - low rank number (rank 1 strongest)
 * - high CC
 *
 * The color fades towards weaker ranks and lower CC.
 */
function hotspotEmphasis01(d) {
  const rank = readHotspotRank(d);
  const cc = readHotspotCc(d);

  const rank01 = (rank == null)
    ? 0
    : clamp01(1 - ((Math.min(rank, 5) - 1) / 4));

  const cc01 = clamp01(Math.log1p(cc) / Math.log1p(120));

  return clamp01((rank01 * 0.6) + (cc01 * 0.4));
}

/** CSS variable / palette anchor for hotspot body fill. */
function hotspotFillVar() {
  return "var(--graph-hotspot-fill)";
}

/** CSS variable for hotspot badge text. */
function hotspotBadgeTextVar() {
  return "var(--graph-hotspot-badge-text)";
}

/** CSS variable / palette anchor for hotspot halo / outline. */
function hotspotOutlineVar() {
  return "var(--graph-hotspot-outline)";
}

/** Dynamic hotspot body fill from rank + CC. */
function hotspotFillColor(d) {
  const strong = "#ff1493";
  const weak = "#ffd6eb";
  return mixHex(weak, strong, hotspotEmphasis01(d));
}

/** Dynamic hotspot outline from rank + CC. */
function hotspotOutlineColor(d) {
  const strong = "#f0ffff";
  const weak = "#f7fbff";
  return mixHex(weak, strong, hotspotEmphasis01(d));
}

/** Ensure a parent node group has stable graph classes. */
function repaintNodeClasses(nodeBodySel) {
  nodeBodySel.each(function (d) {
    const group = this?.parentNode;
    if (!group || typeof group.setAttribute !== "function") return;

    const current = String(group.getAttribute("class") || "").trim();
    const tokens = new Set(current ? current.split(/\s+/) : []);

    tokens.add("codegraph-node");
    if (isHotspotNode(d)) tokens.add("is-hotspot");
    else tokens.delete("is-hotspot");

    if (isTopHotspotNode(d)) tokens.add("is-top-hotspot");
    else tokens.delete("is-top-hotspot");

    group.setAttribute("class", Array.from(tokens).join(" "));
  });
}

/** Ensure one halo circle exists per node group and keep it in sync. */
function repaintHotspotHalos(nodeBodySel, enc) {
  nodeBodySel.each(function (d) {
    const group = this?.parentNode;
    if (!group || typeof group.querySelector !== "function") return;

    let halo = group.querySelector(".node-halo");
    if (!halo) {
      halo = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      halo.setAttribute("class", "node-halo");
      group.insertBefore(halo, group.firstChild || null);
    }

    halo.setAttribute("r", String((Number(enc.getRadius(d)) || 0) + 5));
    halo.setAttribute("stroke", hotspotOutlineColor(d));
    halo.setAttribute("fill", "none");
  });
}

/** Build the visible hotspot badge label (rank + CC). */
function hotspotBadgeLabel(d) {
  const rank = Number(d?._hotspotRank);
  const cc = Number(d?.complexity);

  const safeRank = Number.isFinite(rank) && rank > 0 ? String(rank) : "?";
  const safeCc = Number.isFinite(cc) && cc >= 0 ? String(Math.round(cc)) : "0";
  return `${safeRank} · CC${safeCc}`;
}

/** Compute badge width from label length. */
function hotspotBadgeWidth(label) {
  const text = String(label || "");
  return Math.max(30, 12 + (text.length * 6));
}

/** Ensure one top-hotspot badge exists per node group and keep it in sync. */
function repaintHotspotBadges(nodeBodySel, enc) {
  nodeBodySel.each(function (d) {
    const group = this?.parentNode;
    if (!group || typeof group.querySelector !== "function") return;

    let badge = group.querySelector(".node-badge");
    if (!badge) {
      badge = document.createElementNS("http://www.w3.org/2000/svg", "g");
      badge.setAttribute("class", "node-badge");

      const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      bg.setAttribute("class", "node-badge-bg");
      bg.setAttribute("rx", "8");
      bg.setAttribute("ry", "8");
      badge.appendChild(bg);

      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("class", "node-badge-text");
      badge.appendChild(text);

      group.appendChild(badge);
    }

    const r = Number(enc.getRadius(d)) || 0;
    const isTop = isTopHotspotNode(d);
    const label = isTop ? hotspotBadgeLabel(d) : "";
    const width = hotspotBadgeWidth(label);
    const height = 18;

    badge.setAttribute("transform", `translate(${r + 10},${-r - 10})`);
    badge.setAttribute("aria-hidden", isTop ? "false" : "true");

    const bg = badge.querySelector(".node-badge-bg");
    if (bg) {
      bg.setAttribute("x", String(-width / 2));
      bg.setAttribute("y", String(-height / 2));
      bg.setAttribute("width", String(width));
      bg.setAttribute("height", String(height));
    }

    const text = badge.querySelector(".node-badge-text");
    if (text) {
      text.textContent = label;
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("dominant-baseline", "middle");
    }
  });
}

/**
 * Read the current node-body transition duration.
 *
 * Why it is called
 * ----------------
 * Called during repaint so live change markers update immediately without
 * needing a full graph rebuild.
 *
 * @returns {number}
 */
function nodeTransitionMs() {
  return 120;
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
  repaintNodeClasses(nodeBodySel);
  repaintHotspotHalos(nodeBodySel, enc);
  repaintHotspotBadges(nodeBodySel, enc);

  nodeBodySel
    .transition()
    .duration(nodeTransitionMs())
    .attr("fill", (d) => nodeFill(d, enc))
    .attr("stroke", (d) => nodeStroke(d, enc))
    .attr("stroke-width", (d) => nodeStrokeWidth(d, enc))
    .style("opacity", (d) => nodeOpacity(d, isUnusedFunctionNode))
    .style("stroke-dasharray", (d) => nodeDashArray(d, isUnusedFunctionNode));

  nodeBodySel.each(function (d) {
    const group = this?.parentNode;
    if (!group || typeof group.querySelector !== "function") return;

    const halo = group.querySelector(".node-halo");
    if (halo) {
      halo.setAttribute("fill", "none");
    }

    const badgeBg = group.querySelector(".node-badge-bg");
    if (badgeBg) {
      badgeBg.setAttribute(
        "fill",
        mixHex(nodeFill(d, enc), hotspotFillColor(d), hotspotEmphasis01(d) * 0.35)
      );
      badgeBg.setAttribute("stroke", hotspotOutlineColor(d));
    }

    const badgeText = group.querySelector(".node-badge-text");
    if (badgeText) {
      badgeText.setAttribute("fill", hotspotBadgeTextVar());
    }
  });
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

  labelSel.each(function (d) {
    const el = this;
    if (!el) return;

    if (isHotspotNode(d)) {
      el.style.fill = mixHex("#444444", hotspotFillColor(d), hotspotEmphasis01(d) * 0.75);
    } else if (!d?._changed) {
      el.style.fill = "#444";
    }
  });
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

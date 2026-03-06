/**
 * CodeGraph hull rendering.
 * ---------------------------------------------------------------------------
 * Owns cluster hull rendering for the code structure graph.
 *
 * Stage 1 goals
 * - keep convex hull rendering stable
 * - derive simple cluster stats from the live node set
 * - use radial gradients for stronger visual structure
 * - drive fill/stroke intensity from cluster density and importance
 */

/** Lower bound for hull fill opacity. */
const HULL_FILL_OPACITY_MIN = 0.12;

/** Upper bound for hull fill opacity. */
const HULL_FILL_OPACITY_MAX = 0.34;

/** Lower bound for hull stroke opacity. */
const HULL_STROKE_OPACITY_MIN = 0.22;

/** Upper bound for hull stroke opacity. */
const HULL_STROKE_OPACITY_MAX = 0.72;

/** Lower bound for hull stroke width. */
const HULL_STROKE_WIDTH_MIN = 1.5;

/** Upper bound for hull stroke width. */
const HULL_STROKE_WIDTH_MAX = 3.5;

/** Minimum node count required before a hull label is shown. */
const HULL_LABEL_MIN_COUNT = 6;

/** Minimum font size for hull labels. */
const HULL_LABEL_FONT_SIZE_MIN = 11;

/** Maximum font size for hull labels. */
const HULL_LABEL_FONT_SIZE_MAX = 16;

/**
 * Clamp a number into an inclusive range.
 *
 * @param {number} n
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Read the cluster key for one node.
 *
 * @param {any} node
 * @returns {string}
 */
function readClusterId(node) {
  return String(node?.clusterId || "");
}

/**
 * Group nodes by cluster id.
 *
 * Empty ids are kept as their own group key so the renderer can decide
 * uniformly whether enough points exist to form a hull.
 *
 * @param {any[]} nodes
 * @returns {Array<[string, any[]]>}
 */
function groupNodesByCluster(nodes) {
  const safeNodes = Array.isArray(nodes) ? nodes : [];
  return d3.groups(safeNodes, (node) => readClusterId(node));
}

/**
 * Determine whether a cluster has enough nodes for a hull.
 *
 * `d3.polygonHull` needs at least three points.
 *
 * @param {any[]} groupNodes
 * @returns {boolean}
 */
function hasEnoughHullPoints(groupNodes) {
  return Array.isArray(groupNodes) && groupNodes.length >= 3;
}

/**
 * Convert cluster nodes into `[x, y]` hull points.
 *
 * @param {any[]} groupNodes
 * @returns {Array<[number, number]>}
 */
function toHullPoints(groupNodes) {
  const pts = [];

  for (const node of groupNodes || []) {
    const x = Number(node?.x);
    const y = Number(node?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    pts.push([x, y]);
  }

  return pts;
}

/**
 * Compute the convex hull for one cluster.
 *
 * @param {any[]} groupNodes
 * @returns {Array<[number, number]>|null}
 */
function computeClusterHull(groupNodes) {
  if (!hasEnoughHullPoints(groupNodes)) return null;

  const pts = toHullPoints(groupNodes);
  if (pts.length < 3) return null;

  return d3.polygonHull(pts);
}

/**
 * Convert a hull point list into an SVG path string.
 *
 * @param {Array<[number, number]>|null} hull
 * @returns {string|null}
 */
function toHullPath(hull) {
  if (!Array.isArray(hull) || hull.length < 3) return null;
  return "M" + hull.join("L") + "Z";
}

/**
 * Read a safe importance score from one node.
 *
 * @param {any} node
 * @returns {number}
 */
function readNodeImportance(node) {
  const value = Number(node?._importance);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * Compute the centroid of one point cloud.
 *
 * @param {Array<[number, number]>} pts
 * @returns {{ x:number, y:number }}
 */
function computeCentroid(pts) {
  if (!Array.isArray(pts) || pts.length === 0) {
    return { x: 0, y: 0 };
  }

  let sumX = 0;
  let sumY = 0;

  for (const [x, y] of pts) {
    sumX += x;
    sumY += y;
  }

  return {
    x: sumX / pts.length,
    y: sumY / pts.length,
  };
}

/**
 * Compute the bounding box of one point cloud.
 *
 * @param {Array<[number, number]>} pts
 * @returns {{ minX:number, minY:number, maxX:number, maxY:number, width:number, height:number, area:number }}
 */
function computePointBounds(pts) {
  if (!Array.isArray(pts) || pts.length === 0) {
    return {
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0,
      width: 0,
      height: 0,
      area: 0,
    };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);

  return {
    minX,
    minY,
    maxX,
    maxY,
    width,
    height,
    area: width * height,
  };
}

/**
 * Compute simple cluster stats used by hull styling.
 *
 * Why it exists
 * -------------
 * Stage 1 avoids expensive overlap geometry and instead derives stable visual
 * signals from the live cluster footprint:
 * - node count
 * - average importance
 * - spatial density
 * - centroid / bounds for gradient placement
 *
 * @param {string} clusterId
 * @param {any[]} groupNodes
 * @returns {{
 *   clusterId:string,
 *   count:number,
 *   avgImportance:number,
 *   density:number,
 *   centroid:{x:number,y:number},
 *   bounds:{minX:number,minY:number,maxX:number,maxY:number,width:number,height:number,area:number}
 * }}
 */
function computeClusterStats(clusterId, groupNodes) {
  const pts = toHullPoints(groupNodes);
  const bounds = computePointBounds(pts);
  const centroid = computeCentroid(pts);

  let importanceSum = 0;
  for (const node of groupNodes || []) {
    importanceSum += readNodeImportance(node);
  }

  const count = Array.isArray(groupNodes) ? groupNodes.length : 0;
  const avgImportance = count > 0 ? importanceSum / count : 0;
  const density = count > 0 ? count / Math.max(1, bounds.area / 10000) : 0;

  return {
    clusterId,
    count,
    avgImportance,
    density,
    centroid,
    bounds,
  };
}

/**
 * Read the preferred display label for one hull.
 *
 * Why it exists
 * -------------
 * Cluster ids are often technical. This helper produces a short zone label
 * that explains what the area represents.
 *
 * @param {{ clusterId:string }} stats
 * @returns {string}
 */
function readHullLabel(stats) {
  const raw = String(stats?.clusterId || "").trim();
  if (!raw) return "cluster";

  return raw
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Decide whether a hull label should be shown.
 *
 * Why it exists
 * -------------
 * Very small clusters create noisy text and usually do not help orientation.
 *
 * @param {{ count:number }} stats
 * @returns {boolean}
 */
function shouldShowHullLabel(stats) {
  return Number(stats?.count || 0) >= HULL_LABEL_MIN_COUNT;
}

/**
 * Normalize one metric into a 0..1 score over the current cluster list.
 *
 * @param {number} value
 * @param {number[]} values
 * @returns {number}
 */
function normalizeMetric01(value, values) {
  const safeValues = Array.isArray(values) ? values.filter((v) => Number.isFinite(v)) : [];
  if (safeValues.length === 0) return 0;

  const min = Math.min(...safeValues);
  const max = Math.max(...safeValues);
  if (max <= min) return 0.5;

  return clamp((value - min) / (max - min), 0, 1);
}

/**
 * Compute the style model for one hull.
 *
 * @param {{
 *   clusterId:string,
 *   count:number,
 *   avgImportance:number,
 *   density:number,
 *   centroid:{x:number,y:number},
 *   bounds:{minX:number,minY:number,maxX:number,maxY:number,width:number,height:number,area:number}
 * }} stats
 * @param {Array<any>} allStats
 * @param {(clusterId:any) => string} clusterColorScale
 * @returns {{
 *   clusterId:string,
 *   gradientId:string,
 *   baseColor:string,
 *   fillOpacity:number,
 *   strokeOpacity:number,
 *   strokeWidth:number,
 *   label:string,
 *   labelVisible:boolean,
 *   labelFontSize:number,
 *   centroid:{x:number,y:number},
 *   bounds:{minX:number,minY:number,maxX:number,maxY:number,width:number,height:number,area:number}
 * }}
 */
function computeHullVisuals(stats, allStats, clusterColorScale) {
  const densityValues = allStats.map((item) => item.density);
  const importanceValues = allStats.map((item) => item.avgImportance);

  const density01 = normalizeMetric01(stats.density, densityValues);
  const importance01 = normalizeMetric01(stats.avgImportance, importanceValues);
  const emphasis01 = clamp((density01 * 0.65) + (importance01 * 0.35), 0, 1);

  const label = readHullLabel(stats);
  const labelVisible = shouldShowHullLabel(stats);
  const labelFontSize = interpolate(HULL_LABEL_FONT_SIZE_MIN, HULL_LABEL_FONT_SIZE_MAX, emphasis01);

  return {
    clusterId: stats.clusterId,
    gradientId: `cg-hull-grad-${sanitizeId(stats.clusterId)}`,
    baseColor: clusterColorScale(stats.clusterId),
    fillOpacity: interpolate(HULL_FILL_OPACITY_MIN, HULL_FILL_OPACITY_MAX, emphasis01),
    strokeOpacity: interpolate(HULL_STROKE_OPACITY_MIN, HULL_STROKE_OPACITY_MAX, emphasis01),
    strokeWidth: interpolate(HULL_STROKE_WIDTH_MIN, HULL_STROKE_WIDTH_MAX, emphasis01),
    label,
    labelVisible,
    labelFontSize,
    centroid: stats.centroid,
    bounds: stats.bounds,
  };
}

/**
 * Interpolate linearly between two bounds.
 *
 * @param {number} lo
 * @param {number} hi
 * @param {number} t
 * @returns {number}
 */
function interpolate(lo, hi, t) {
  return lo + (hi - lo) * clamp(t, 0, 1);
}

/**
 * Sanitize a value for SVG id usage.
 *
 * @param {string} value
 * @returns {string}
 */
function sanitizeId(value) {
  return String(value || "cluster")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "cluster";
}

/**
 * Resolve or create the local `<defs>` container for hull gradients.
 *
 * @param {any} hullGroup
 * @returns {any}
 */
function ensureHullDefs(hullGroup) {
  const rootSvg = hullGroup?.node?.()?.ownerSVGElement;
  if (!rootSvg) return null;

  const svgSel = d3.select(rootSvg);
  return svgSel.selectAll("defs.cg-hull-defs")
    .data([null])
    .join("defs")
    .attr("class", "cg-hull-defs");
}

/**
 * Create or update radial gradients for the current hull set.
 *
 * Why it is called
 * ----------------
 * Called during hull render so each cluster gets a stable gradient anchored to
 * its current centroid and footprint.
 *
 * @param {any} defsSel
 * @param {Array<any>} visuals
 */
function defineHullGradients(defsSel, visuals) {
  if (!defsSel) return;

  const gradSel = defsSel.selectAll("radialGradient.cg-hull-gradient")
    .data(visuals, (d) => d.gradientId)
    .join(
      (enter) => {
        const gradEnter = enter.append("radialGradient")
          .attr("class", "cg-hull-gradient");

        gradEnter.append("stop").attr("class", "cg-hull-stop-inner");
        gradEnter.append("stop").attr("class", "cg-hull-stop-outer");
        return gradEnter;
      },
      (update) => update,
      (exit) => exit.remove()
    )
    .attr("id", (d) => d.gradientId)
    .attr("gradientUnits", "userSpaceOnUse")
    .attr("cx", (d) => d.centroid.x)
    .attr("cy", (d) => d.centroid.y)
    .attr("r", (d) => Math.max(d.bounds.width, d.bounds.height) * 0.7);

  gradSel.select(".cg-hull-stop-inner")
    .attr("offset", "0%")
    .attr("stop-color", (d) => d.baseColor)
    .attr("stop-opacity", (d) => clamp(d.fillOpacity * 1.1, 0, 1));

  gradSel.select(".cg-hull-stop-outer")
    .attr("offset", "100%")
    .attr("stop-color", (d) => d.baseColor)
    .attr("stop-opacity", (d) => clamp(d.fillOpacity * 0.35, 0, 1));
}

/**
 * Build the visual model for all renderable hulls.
 *
 * @param {Array<[string, any[]]>} groups
 * @param {(clusterId:any) => string} clusterColorScale
 * @returns {Array<{ key:string, clusterId:string, nodes:any[], path:string, visual:any }>}
 */
function buildHullEntries(groups, clusterColorScale) {
  const statsList = [];
  const entries = [];

  for (const [clusterId, groupNodes] of groups) {
    const hull = computeClusterHull(groupNodes);
    const path = toHullPath(hull);
    if (!path) continue;

    const stats = computeClusterStats(clusterId, groupNodes);
    statsList.push(stats);
    entries.push({
      key: clusterId,
      clusterId,
      nodes: groupNodes,
      path,
      stats,
    });
  }

  for (const entry of entries) {
    entry.visual = computeHullVisuals(entry.stats, statsList, clusterColorScale);
  }

  return entries;
}

/**
 * Resolve the fill paint for one cluster hull.
 *
 * @param {{ gradientId:string }} visual
 * @returns {string}
 */
function readHullFill(visual) {
  return `url(#${visual.gradientId})`;
}

/**
 * Resolve the stroke color for one cluster hull.
 *
 * @param {{ baseColor:string }} visual
 * @returns {string}
 */
function readHullStroke(visual) {
  return visual.baseColor;
}

/**
 * Apply data-driven hull label styling.
 *
 * Why it is called
 * ----------------
 * Called during hull render so each cluster area can explain what it
 * represents without requiring hover.
 *
 * @param {any} textSel
 */
function styleHullLabels(textSel) {
  textSel
    .attr("x", (d) => d.visual.centroid.x)
    .attr("y", (d) => d.visual.centroid.y)
    .attr("text-anchor", "middle")
    .attr("dominant-baseline", "middle")
    .style("font-size", (d) => `${d.visual.labelFontSize}px`)
    .style("font-weight", "600")
    .style("fill", "#111")
    .style("opacity", (d) => (d.visual.labelVisible ? 0.72 : 0))
    .style("paint-order", "stroke")
    .style("stroke", "rgba(255,255,255,0.9)")
    .style("stroke-width", "3px")
    .style("pointer-events", "none")
    .text((d) => d.visual.label);
}

/**
 * Apply data-driven hull styling.
 *
 * @param {any} pathSel
 */
function styleHullPaths(pathSel) {
  pathSel
    .attr("fill", (d) => readHullFill(d.visual))
    .attr("fill-opacity", 1)
    .attr("stroke", (d) => readHullStroke(d.visual))
    .attr("stroke-width", (d) => d.visual.strokeWidth)
    .attr("stroke-opacity", (d) => d.visual.strokeOpacity);
}

/**
 * Render convex hulls per cluster.
 *
 * Stage 1 behavior
 * ----------------
 * - builds one convex hull per cluster
 * - computes light-weight cluster stats
 * - applies radial gradients and data-driven stroke emphasis
 *
 * @param {any} hullGroup
 * @param {any[]} nodes
 * @param {(clusterId:any) => string} clusterColorScale
 */
export function renderTypeHulls(hullGroup, nodes, clusterColorScale) {
  const groups = groupNodesByCluster(nodes);
  const entries = buildHullEntries(groups, clusterColorScale);
  const defsSel = ensureHullDefs(hullGroup);

  defineHullGradients(defsSel, entries.map((entry) => entry.visual));

  const pathSel = hullGroup.selectAll("path")
    .data(entries, (d) => d.key)
    .join("path")
    .attr("d", (d) => d.path);

  const textSel = hullGroup.selectAll("text.cg-hull-label")
    .data(entries.filter((entry) => entry.visual.labelVisible), (d) => d.key)
    .join("text")
    .attr("class", "cg-hull-label");

  styleHullPaths(pathSel);
  styleHullLabels(textSel);
}

const CodeGraphRenderHulls = {
  renderTypeHulls,
};

export { CodeGraphRenderHulls };
export default CodeGraphRenderHulls;
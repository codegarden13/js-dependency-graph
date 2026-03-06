

/**
 * CodeGraph hull rendering.
 * ---------------------------------------------------------------------------
 * Owns cluster hull rendering for the code structure graph.
 *
 * Scope
 * - groups nodes by cluster id
 * - derives polygon-hull input points
 * - renders one soft hull path per cluster
 */

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
 * Resolve the fill color for one cluster hull.
 *
 * @param {string} clusterId
 * @param {(clusterId:any) => string} clusterColorScale
 * @returns {string}
 */
function readHullFill(clusterId, clusterColorScale) {
  return clusterColorScale(clusterId);
}

/**
 * Resolve the stroke color for one cluster hull.
 *
 * @param {string} clusterId
 * @param {(clusterId:any) => string} clusterColorScale
 * @returns {string}
 */
function readHullStroke(clusterId, clusterColorScale) {
  return clusterColorScale(clusterId);
}

/**
 * Apply the standard hull visual style.
 *
 * @param {any} pathSel
 * @param {(clusterId:any) => string} clusterColorScale
 */
function styleHullPaths(pathSel, clusterColorScale) {
  pathSel
    .attr("fill", ([clusterId]) => readHullFill(clusterId, clusterColorScale))
    .attr("fill-opacity", 0.22)
    .attr("stroke", ([clusterId]) => readHullStroke(clusterId, clusterColorScale))
    .attr("stroke-width", 2)
    .attr("stroke-opacity", 0.35);
}

/**
 * Render convex hulls per cluster.
 *
 * Notes
 * -----
 * - groups by `clusterId`
 * - requires at least three valid `[x, y]` points per cluster
 * - uses `d3.polygonHull` for the outer contour
 *
 * @param {any} hullGroup
 * @param {any[]} nodes
 * @param {(clusterId:any) => string} clusterColorScale
 */
export function renderTypeHulls(hullGroup, nodes, clusterColorScale) {
  const groups = groupNodesByCluster(nodes);

  const pathSel = hullGroup.selectAll("path")
    .data(groups)
    .join("path")
    .attr("d", ([, groupNodes]) => {
      const hull = computeClusterHull(groupNodes);
      return toHullPath(hull);
    });

  styleHullPaths(pathSel, clusterColorScale);
}

const CodeGraphRenderHulls = {
  renderTypeHulls,
};

export { CodeGraphRenderHulls };
export default CodeGraphRenderHulls;
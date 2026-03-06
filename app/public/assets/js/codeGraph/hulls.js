/**
 * CodeGraph hull rendering.
 * ---------------------------------------------------------------------------
 * Renders soft convex hulls around node clusters.
 */

/**
 * Render convex hulls per cluster.
 *
 * Notes
 * -----
 * - groups by `clusterId`
 * - requires at least three points per cluster
 * - uses `d3.polygonHull` for the outer contour
 *
 * @param {any} hullGroup
 * @param {any[]} nodes
 * @param {(clusterId:any) => string} clusterColorScale
 */
export function renderTypeHulls(hullGroup, nodes, clusterColorScale) {
  const groups = d3.groups(nodes, (d) => d.clusterId);

  hullGroup.selectAll("path")
    .data(groups)
    .join("path")
    .attr("d", ([, groupNodes]) => {
      if (groupNodes.length < 3) return null;

      const pts = groupNodes.map((n) => [n.x, n.y]);
      const hull = d3.polygonHull(pts);
      return hull ? "M" + hull.join("L") + "Z" : null;
    })
    .attr("fill", ([cid]) => clusterColorScale(cid))
    .attr("fill-opacity", 0.22)
    .attr("stroke", ([cid]) => clusterColorScale(cid))
    .attr("stroke-width", 2)
    .attr("stroke-opacity", 0.35);
}

const CodeGraphHulls = {
  renderTypeHulls,
};

export { CodeGraphHulls };
export default CodeGraphHulls;
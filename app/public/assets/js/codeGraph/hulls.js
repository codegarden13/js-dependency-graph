// public/assets/js/hulls.js
/**
 * Cluster Hull Rendering (UI-side)
 * ===============================
 * Renders soft convex hulls around clusters.
 *
 * Exposes: window.CodeGraphHulls
 */

(function () {
  "use strict";

  const CodeGraphHulls = {};

  /**
   * Render convex hulls per cluster.
   *
   * Arguments:
   * - hullGroup: d3 selection for hull layer
   * - nodes: graph nodes with { x, y, clusterId }
   * - clusterColorScale: d3 ordinal color scale
   *
   * Notes:
   * - Uses d3.polygonHull; requires at least 3 points per cluster
   */
  CodeGraphHulls.renderTypeHulls = function renderTypeHulls(hullGroup, nodes, clusterColorScale) {
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
  };

  window.CodeGraphHulls = CodeGraphHulls;
})();
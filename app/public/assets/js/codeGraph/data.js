// public/assets/js/graphData.js
/**
 * Graph Data Utilities (UI-side)
 * ==============================
 * Provides normalization + enrichment helpers for the D3 graph renderer.
 *
 * Design goals:
 * - Tolerate incomplete backend payloads
 * - Apply consistent defaults (type inference, degree fill, score normalization)
 * - Keep renderer code focused on SVG + simulation
 *
 * Exposes: window.CodeGraphData
 */

(function () {
  "use strict";

  const CodeGraphData = {};

  /**
   * Shallow-clone incoming metrics arrays to prevent accidental mutation
   * of the original payload object.
   */
  CodeGraphData.extract = function extract(metrics) {
    const nodes = (metrics?.nodes || []).map((n) => ({ ...n }));
    const links = (metrics?.links || metrics?.edges || []).map((l) => ({ ...l }));
    return { nodes, links };
  };

  /**
   * Infer node type (UI heuristic) from path conventions.
   * Extend this when you add function-level or class-level nodes.
   */
  CodeGraphData.inferNodeType = function inferNodeType(node) {
    const p = String(node?.file || node?.id || "").toLowerCase();

    if (p.includes("/controllers/")) return "controller";
    if (p.includes("/services/")) return "service";
    if (p.includes("/repositories/")) return "repository";
    if (p.includes("/config/")) return "config";
    if (p.includes("/modules/")) return "module";
    if (p.includes("/core/")) return "core";
    if (p.includes("/support/") || p.includes("/helpers/") || p.includes("/utils/")) return "helper";

    return "file";
  };

  /**
   * Ensure _inbound/_outbound is present for complexity fallback and diagnostics.
   */
  CodeGraphData.hydrateDegrees = function hydrateDegrees(nodes, links) {
    const degreeMap = new Map();
    nodes.forEach((n) => degreeMap.set(n.id, { in: 0, out: 0 }));

    links.forEach((l) => {
      const sid = typeof l.source === "object" ? l.source.id : l.source;
      const tid = typeof l.target === "object" ? l.target.id : l.target;
      if (degreeMap.has(sid)) degreeMap.get(sid).out++;
      if (degreeMap.has(tid)) degreeMap.get(tid).in++;
    });

    nodes.forEach((n) => {
      const d = degreeMap.get(n.id) || { in: 0, out: 0 };
      if (n._inbound == null) n._inbound = d.in;
      if (n._outbound == null) n._outbound = d.out;
    });
  };

  /**
   * Compute normalized line/complexity scores (0..1) for visual encoding.
   *
   * Populates per node:
   * - _lineScore
   * - _complexityScore
   * - _sizeScore (legacy alias used by highlight ring)
   * - __displayLines / __displayComplexity (raw values for tooltip)
   */
  CodeGraphData.buildLineAndComplexityScores = function buildLineAndComplexityScores(nodes) {
    const eps = 1e-6;

    const getLines = (n) =>
      n.lines ?? n.loc ?? n.size ?? n.lineCount ?? n.length ?? 0;

    const getComplexity = (n) =>
      n.complexity ?? n.cc ?? ((n._inbound || 0) + (n._outbound || 0));

    const linesArr = nodes.map(getLines);
    const cxArr = nodes.map(getComplexity);

    // log-scale LOC normalization
    const logLinesArr = linesArr.map((v) => Math.log10(Math.max(1, v)));
    const minLog = Math.min(...logLinesArr);
    const maxLog = Math.max(...logLinesArr);

    const minCx = Math.min(...cxArr);
    const maxCx = Math.max(...cxArr);

    function norm(v, min, max) {
      if (!isFinite(v)) return 0;
      if (max - min < eps) return 0;
      return (v - min) / (max - min);
    }

    nodes.forEach((n, i) => {
      const lineScore = norm(logLinesArr[i], minLog, maxLog);
      const cxScore = norm(cxArr[i], minCx, maxCx);

      n._lineScore = lineScore;
      n._complexityScore = cxScore;
      n._sizeScore = lineScore;

      n.__displayLines = linesArr[i];
      n.__displayComplexity = cxArr[i];
    });
  };

  /**
   * Default clustering: clusterId = node type
   * Replace later if you add a "cluster mode" dropdown (type/folder/file).
   */
  CodeGraphData.assignTypeClusters = function assignTypeClusters(nodes) {
    nodes.forEach((n) => {
      n.clusterId = n.type || "file";
    });
  };

  /**
   * Convenience: apply all enrichment steps in a stable order.
   */
  CodeGraphData.normalize = function normalize(metrics) {
    const { nodes, links } = CodeGraphData.extract(metrics);

    nodes.forEach((n) => {
      n.type = CodeGraphData.inferNodeType(n);
    });

    CodeGraphData.hydrateDegrees(nodes, links);
    CodeGraphData.buildLineAndComplexityScores(nodes);
    CodeGraphData.assignTypeClusters(nodes);

    return { nodes, links };
  };

  window.CodeGraphData = CodeGraphData;
})();
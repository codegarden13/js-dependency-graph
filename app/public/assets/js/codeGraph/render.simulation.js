/**
 * CodeGraph force simulation helpers.
 * ---------------------------------------------------------------------------
 * Owns layout defaults and D3 force construction for the code structure graph.
 * The implementation mirrors the previously inlined renderer behavior so the
 * graph keeps its earlier density, spacing, and balance after extraction.
 */

// D3 is loaded globally via browser script.
const d3 = window.d3;

/**
 * Stable layout tuning shared by all graph renders.
 * Kept local so the simulation module stays self-contained.
 */
const CODE_STRUCTURE_CONFIG = {
  layoutScale: 1,
  clamps: {
    linkDistanceMin: 12,
    linkDistanceMax: 160,
    chargeMin: -420,
    chargeMax: -10,
    chargeDistanceMinMin: 6,
    chargeDistanceMinMax: 40,
    chargeDistanceMaxMin: 160,
    chargeDistanceMaxMax: 900,
  },
  typeWeights: {
    chargeByKind: {
      dir: 0.25,
      asset: 0.55,
      default: 1.0,
    },
    linkDistanceMul: {
      include: 0.8,
      use: 2.6,
      extends: 2.6,
      call: 3.4,
      default: 2.2,
    },
    linkStrength: {
      include: 0.08,
      use: 0.22,
      extends: 0.22,
      call: 0.16,
      default: 0.18,
    }
  }
};

/** Clamp a number into an inclusive range. */
function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/** Compute the arithmetic mean for a numeric array. */
function mean(arr) {
  if (!arr || !arr.length) return 0;
  let sum = 0;
  for (const value of arr) sum += value;
  return sum / arr.length;
}

/** Read the normalized simulation viewport. */
function readSimulationViewport(input) {
  return {
    width: readSimulationNumber(input.width),
    height: readSimulationNumber(input.height),
  };
}

/** Normalize the simulation input bag. */
function normalizeSimulationOptions(opts) {
  const input = (opts && typeof opts === "object") ? opts : Object.create(null);
  const viewport = readSimulationViewport(input);

  return {
    nodes: readSimulationNodes(input.nodes),
    links: readSimulationLinks(input.links),
    width: viewport.width,
    height: viewport.height,
    getRadius: readSimulationRadiusFn(input.getRadius),
  };
}

/** Read nodes as a stable array. */
function readSimulationNodes(value) {
  return Array.isArray(value) ? value : [];
}

/** Read links as a stable array. */
function readSimulationLinks(value) {
  return Array.isArray(value) ? value : [];
}

/** Read a numeric simulation field. */
function readSimulationNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Read the node radius resolver. */
function readSimulationRadiusFn(value) {
  return (typeof value === "function") ? value : () => 0;
}

/** Count nodes best-effort. */
function countNodes(nodes) {
  return Array.isArray(nodes) ? nodes.length : 0;
}

/** Compute the average node radius. */
function computeAverageRadius(nodes, getRadius) {
  const arr = Array.isArray(nodes) ? nodes : [];

  const radii = arr.map((node) => {
    try {
      return Number(getRadius(node) || 0) || 0;
    } catch {
      return 0;
    }
  });

  return Math.max(1, mean(radii));
}

/** Count link types used by the layout heuristics. */
function countLinkTypes(links) {
  const out = { include: 0, use: 0, call: 0, extends: 0, default: 0 };
  const arr = Array.isArray(links) ? links : [];

  for (const link of arr) {
    const type = String(link?.type || "default");
    if (Object.prototype.hasOwnProperty.call(out, type)) out[type] += 1;
    else out.default += 1;
  }

  return out;
}

/** Compute the ratio of structural include edges to all edges. */
function computeStructuralRatio(nodeCount, links, typeCounts) {
  const linkCount = Array.isArray(links) ? links.length : 0;
  if (nodeCount <= 0) return 0;
  return typeCounts.include / Math.max(1, linkCount);
}

/** Compress spacing as graphs grow. */
function computeNodeFactor(nodeCount) {
  if (nodeCount <= 0) return 1;
  return 1 / Math.max(0.7, Math.log10(nodeCount + 10));
}

/** Compute the base link distance before edge-type multipliers. */
function computeBaseLinkDistance({ rAvg, nFactor, structuralRatio, scale }) {
  const raw = (10 + rAvg * 2.2) * nFactor * (1.15 - 0.35 * structuralRatio) * scale;

  return clamp(
    raw,
    CODE_STRUCTURE_CONFIG.clamps.linkDistanceMin,
    CODE_STRUCTURE_CONFIG.clamps.linkDistanceMax
  );
}

/** Compute the base repulsion magnitude. */
function computeChargeBase({ rAvg, nodeCount, scale }) {
  const raw = (rAvg * 7.5 + 22 * Math.log(nodeCount + 1)) * scale;

  const abs = clamp(
    raw,
    Math.abs(CODE_STRUCTURE_CONFIG.clamps.chargeMax),
    Math.abs(CODE_STRUCTURE_CONFIG.clamps.chargeMin)
  );

  return -abs;
}

/** Compute the minimum charge distance. */
function computeChargeDistanceMin({ rAvg }) {
  return clamp(
    rAvg * 0.8,
    CODE_STRUCTURE_CONFIG.clamps.chargeDistanceMinMin,
    CODE_STRUCTURE_CONFIG.clamps.chargeDistanceMinMax
  );
}

/** Compute the maximum charge distance. */
function computeChargeDistanceMax({ rAvg, scale }) {
  return clamp(
    (rAvg * 14 + 220) * scale,
    CODE_STRUCTURE_CONFIG.clamps.chargeDistanceMaxMin,
    CODE_STRUCTURE_CONFIG.clamps.chargeDistanceMaxMax
  );
}

/** Compute the center force strength. */
function computeCenterStrength(nodeCount) {
  const raw = 0.02 + (nodeCount > 200 ? 0.02 : 0);
  return clamp(raw, 0.02, 0.06);
}

/** Build the edge-distance resolver. */
function makeLinkDistanceFn(baseLinkDistance) {
  return (link) => {
    const type = String(link?.type || "default");
    const mul =
      CODE_STRUCTURE_CONFIG.typeWeights.linkDistanceMul[type] ??
      CODE_STRUCTURE_CONFIG.typeWeights.linkDistanceMul.default;

    return clamp(
      baseLinkDistance * mul,
      CODE_STRUCTURE_CONFIG.clamps.linkDistanceMin,
      CODE_STRUCTURE_CONFIG.clamps.linkDistanceMax * 3
    );
  };
}

/** Build the edge-strength resolver. */
function makeLinkStrengthFn() {
  return (link) => {
    const type = String(link?.type || "default");
    return (
      CODE_STRUCTURE_CONFIG.typeWeights.linkStrength[type] ??
      CODE_STRUCTURE_CONFIG.typeWeights.linkStrength.default
    );
  };
}

/** Build the node-charge resolver. */
function makeChargeStrengthFn(chargeBase) {
  return (node) => {
    const kind = String(node?.kind || "default");
    const weight =
      CODE_STRUCTURE_CONFIG.typeWeights.chargeByKind[kind] ??
      CODE_STRUCTURE_CONFIG.typeWeights.chargeByKind.default;

    return clamp(
      chargeBase * weight,
      CODE_STRUCTURE_CONFIG.clamps.chargeMin,
      CODE_STRUCTURE_CONFIG.clamps.chargeMax
    );
  };
}

/** Count layout-driving graph metrics for one simulation input. */
function readLayoutMetrics(nodes, links, getRadius) {
  const nodeCount = countNodes(nodes);
  const rAvg = computeAverageRadius(nodes, getRadius);
  const typeCounts = countLinkTypes(links);
  const structuralRatio = computeStructuralRatio(nodeCount, links, typeCounts);
  const nFactor = computeNodeFactor(nodeCount);

  return {
    nodeCount,
    rAvg,
    typeCounts,
    structuralRatio,
    nFactor,
  };
}

/** Compute the bounded charge distances for one layout. */
function readChargeDistances(rAvg, scale) {
  return {
    chargeDistanceMin: computeChargeDistanceMin({ rAvg }),
    chargeDistanceMax: computeChargeDistanceMax({ rAvg, scale }),
  };
}

/** Derive the proven layout defaults for one graph instance. */
export function deriveLayoutDefaults(nodes, links, getRadius) {
  const scale = CODE_STRUCTURE_CONFIG.layoutScale;
  const metrics = readLayoutMetrics(nodes, links, getRadius);

  const baseLinkDistance = computeBaseLinkDistance({
    rAvg: metrics.rAvg,
    nFactor: metrics.nFactor,
    structuralRatio: metrics.structuralRatio,
    scale,
  });

  const chargeBase = computeChargeBase({
    rAvg: metrics.rAvg,
    nodeCount: metrics.nodeCount,
    scale,
  });

  const chargeDistances = readChargeDistances(metrics.rAvg, scale);

  return {
    baseLinkDistance,
    chargeDistanceMin: chargeDistances.chargeDistanceMin,
    chargeDistanceMax: chargeDistances.chargeDistanceMax,
    linkDistanceFn: makeLinkDistanceFn(baseLinkDistance),
    linkStrengthFn: makeLinkStrengthFn(),
    chargeStrengthFn: makeChargeStrengthFn(chargeBase),
    centerStrength: computeCenterStrength(metrics.nodeCount),
  };
}

/** Create the link force and resolve string ids through `node.id`. */
function createLinkForce(links, layout) {
  return d3.forceLink(links)
    .id((d) => d.id)
    .distance((link) => layout.linkDistanceFn(link))
    .strength((link) => layout.linkStrengthFn(link));
}

/** Create the charge force. */
function createChargeForce(layout) {
  return d3.forceManyBody()
    .strength((node) => layout.chargeStrengthFn(node))
    .distanceMin(layout.chargeDistanceMin)
    .distanceMax(layout.chargeDistanceMax);
}

/** Create the collision force. */
function createCollideForce(getRadius) {
  return d3.forceCollide()
    .radius((node) => getRadius(node) + 4)
    .iterations(2);
}

/** Create the horizontal centering force. */
function createForceX(width, layout) {
  return d3.forceX(width / 2).strength(layout.centerStrength);
}

/**
 * Resolve optional layer metadata embedded in the graph payload.
 * The backend may attach a shared `meta` object to nodes containing:
 *   - meta.layerY: explicit Y coordinates per layer
 *   - meta.layerOrder: preferred layer ordering
 */
function readLayerMeta(nodes) {
  const first = Array.isArray(nodes) && nodes.length ? nodes[0] : null;
  const meta = first?.meta || null;

  return {
    layerY: meta?.layerY || null,
    layerOrder: Array.isArray(meta?.layerOrder) ? meta.layerOrder : null
  };
}

/** Default architectural layer order used as last fallback. */
function defaultLayerOrder() {
  return ["structure", "ui", "http", "app", "graph", "io", "data", "doc"];
}

/** Build a stable layer → Y coordinate mapping. */
function buildLayerYMap(nodes, height) {
  const meta = readLayerMeta(nodes);

  if (meta.layerY && typeof meta.layerY === "object") {
    return meta.layerY;
  }

  const order = meta.layerOrder || defaultLayerOrder();
  const step = height / (order.length + 1);

  const map = Object.create(null);
  order.forEach((layer, i) => {
    map[layer] = step * (i + 1);
  });

  return map;
}

/** Create the vertical layer force. */
function createForceY(height, layout, nodes) {
  const layerY = buildLayerYMap(nodes, height);

  return d3.forceY((node) => {
    const layer = String(node?.layer || "");
    const y = layerY[layer];

    if (typeof y === "number") return y;

    return height / 2;
  }).strength(layout.centerStrength * 1.2);
}

/** Create the absolute center force. */
function createCenterForce(width, height) {
  return d3.forceCenter(width / 2, height / 2);
}

/** Create the configured force bundle for one simulation. */
function applySimulationForces(simulation, simOpts, layout) {
  return simulation
    .force("link", createLinkForce(simOpts.links, layout))
    .force("charge", createChargeForce(layout))
    .force("collide", createCollideForce(simOpts.getRadius))
    .force("x", createForceX(simOpts.width, layout))
    .force("y", createForceY(simOpts.height, layout, simOpts.nodes))
    .force("center", createCenterForce(simOpts.width, simOpts.height));
}

/**
 * Create and configure the D3 simulation.
 *
 * Accepts the renderer options bag used by `d3_codeStructure.js`.
 */
export function createSimulation(opts) {
  const simOpts = normalizeSimulationOptions(opts);
  const layout = deriveLayoutDefaults(simOpts.nodes, simOpts.links, simOpts.getRadius);
  const simulation = d3.forceSimulation(simOpts.nodes);

  return applySimulationForces(simulation, simOpts, layout);
}
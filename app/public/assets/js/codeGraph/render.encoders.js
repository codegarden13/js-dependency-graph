/**
 * CodeGraph node encoders.
 * ---------------------------------------------------------------------------
 * Owns visual encoding helpers that derive colors, radii, strokes, and node
 * classification from normalized graph nodes.
 */
import { normalizeLinkType } from "./shared.js";

/**
 * Central visual encoding schema for graph nodes.
 *
 * Keep all renderer-facing mapping rules in one place so size, fill, stroke,
 * and coupling stay explicit and easy to tune.
 */
const GRAPH_ENCODING = {
  fill: {
    nodeGroupColors: {
      root: "var(--cg-node-fill-root, #111827)",
      dir: "var(--cg-node-fill-dir, #6c8cff)",
      code: "var(--cg-node-fill-code, #adb5bd)",
      doc: "var(--cg-node-fill-doc, #2ec4b6)",
      data: "var(--cg-node-fill-data, #ff9933)",
      image: "var(--cg-node-fill-image, #9d4edd)"
    },
    nodeKindColors: {
      controller: "var(--cg-node-kind-controller, #ff6b6b)",
      service: "var(--cg-node-kind-service, #4d96ff)",
      module: "var(--cg-node-kind-module, #ff9933)",
      repository: "var(--cg-node-kind-repository, #ffd166)",
      config: "var(--cg-node-kind-config, #f72585)",
      core: "var(--cg-node-kind-core, #4361ee)",
      helper: "var(--cg-node-kind-helper, #9d4edd)",
      function: "var(--cg-node-kind-function, #22223b)",
      dir: "var(--cg-node-kind-dir, #6c8cff)",
      asset: "var(--cg-node-kind-asset, #2ec4b6)",
      file: "var(--cg-node-kind-file, #adb5bd)"
    },
    fallback: "var(--cg-node-fill-fallback, #adb5bd)"
  },
  radius: {
    function: {
      min: 5,
      max: 30,
      exponent: 0.58,
      maxBoost: 5,
      scoreBiasStep: 1.25
    },
    container: {
      min: 6,
      max: 24
    }
  },
  stroke: {
    defaultColor: "var(--cg-node-stroke-default, rgba(0,0,0,0.08))",
    changedColor: "var(--cg-node-stroke-changed, #ff3b30)",
    exportedColor: "var(--cg-node-stroke-exported, #22c55e)",
    importedColor: "var(--cg-node-stroke-imported, #3b82f6)",
    sharedColor: "var(--cg-node-stroke-shared, #14b8a6)",
    changedWidth: 3,
    exportedWidth: 3,
    importedWidth: 3,
    sharedWidth: 4,
    defaultWidth: 1,
    couplingMin: 1,
    couplingMax: 4,
    ringMin: 1,
    ringMax: 12,
    couplingReference: 16
  },
  edge: {
    defaultColor: "var(--cg-edge-default, rgba(100,116,139,0.22))",
    changedColor: "var(--cg-edge-changed, rgba(255,59,48,0.85))",
    callColor: "var(--cg-edge-call, rgba(99,102,241,0.30))",
    useColor: "var(--cg-edge-use, rgba(168,85,247,0.30))",
    includeColor: "var(--cg-edge-include, rgba(245,158,11,0.34))",
    extendsColor: "var(--cg-edge-extends, rgba(6,214,160,0.34))",
    resourceColors: {
      doc: "var(--cg-edge-resource-doc, rgba(46,196,182,0.16))",
      data: "var(--cg-edge-resource-data, rgba(255,153,51,0.16))",
      image: "var(--cg-edge-resource-image, rgba(157,78,221,0.18))",
      asset: "var(--cg-edge-resource-asset, rgba(46,196,182,0.14))"
    },
    defaultWidth: 1,
    minWidth: 1,
    maxWidth: 4,
    resourceMinWidth: 0.4,
    resourceMaxWidth: 1,
    weightReference: 12
  }
};

/** Clamp a number into an inclusive range. */
function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/** Determine whether a node represents a function. */
export function isFunctionNode(d) {
  const type = (d && typeof d.type === "string") ? d.type.trim() : "";
  if (type === "function") return true;

  const kind = (d && typeof d.kind === "string") ? d.kind.trim() : "";
  return kind === "function";
}

/** Read and trim a string field from an object. */
function readTrimmedString(obj, key) {
  const value = obj && typeof obj === "object" ? obj[key] : "";
  return (typeof value === "string") ? value.trim() : "";
}

/** Read a value from a map or return null. */
function lookupOrNull(key, map) {
  if (!key) return null;
  if (!map || typeof map !== "object") return null;
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
}

/** Return the first truthy value from a candidate list. */
function firstTruthy(...vals) {
  for (const value of vals) {
    if (value) return value;
  }
  return null;
}

const CSS_COLOR_CACHE = new Map();
const NODE_COUPLING_CACHE = new WeakMap();
const NODE_CHILD_FUNCTIONS_CACHE = new WeakMap();
const EDGE_TYPE_CACHE = new WeakMap();
const EDGE_WEIGHT_CACHE = new WeakMap();

function resolveCssColor(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("var(")) return trimmed;

  const cached = CSS_COLOR_CACHE.get(trimmed);
  if (cached) return cached;

  if (typeof window === "undefined" || typeof document === "undefined") return trimmed;

  const match = trimmed.match(/^var\(\s*(--[^,\s)]+)\s*,\s*([^)]*)\)$/);
  if (!match) return trimmed;

  const [, varName, fallback] = match;
  const cssValue = window.getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();

  const resolved = cssValue || String(fallback || "").trim();
  CSS_COLOR_CACHE.set(trimmed, resolved);
  return resolved;
}

function readEdgeEndpointId(endpoint) {
  if (endpoint && typeof endpoint === "object") {
    return readTrimmedString(endpoint, "id");
  }

  return String(endpoint || "").trim();
}

function resolveEdgeEndpointNode(endpoint, nodeById) {
  if (endpoint && typeof endpoint === "object") return endpoint;

  const id = readEdgeEndpointId(endpoint);
  if (!id || !(nodeById instanceof Map)) return null;
  return nodeById.get(id) || null;
}

function readEdgeTargetNode(edge, nodeById = null) {
  return resolveEdgeEndpointNode(edge?.target, nodeById);
}

function readResourceEdgeArt(node) {
  const kind = readTrimmedString(node, "kind");
  const type = readTrimmedString(node, "type");
  const group = readTrimmedString(node, "group");

  if (group === "doc" || group === "data" || group === "image") return group;
  if (kind === "asset" || type === "asset") return "asset";
  return "";
}

function getResourceEdgeColor(edge, nodeById = null) {
  const targetNode = readEdgeTargetNode(edge, nodeById);
  const art = readResourceEdgeArt(targetNode);
  if (!art) return null;

  return resolveCssColor(
    lookupOrNull(art, GRAPH_ENCODING.edge.resourceColors) || GRAPH_ENCODING.edge.defaultColor
  );
}

function buildNodeLookup(nodes) {
  const map = new Map();

  for (const node of nodes || []) {
    const id = readTrimmedString(node, "id");
    if (!id) continue;
    map.set(id, node);
  }

  return map;
}

/** Pick the semantic base color for a node. */
function getBaseNodeColor(d) {
  const group = readTrimmedString(d, "group");
  const kind = readTrimmedString(d, "kind");
  const type = readTrimmedString(d, "type");
  return resolveCssColor(firstTruthy(
    lookupOrNull(group, GRAPH_ENCODING.fill.nodeGroupColors),
    lookupOrNull(kind, GRAPH_ENCODING.fill.nodeKindColors),
    lookupOrNull(type, GRAPH_ENCODING.fill.nodeKindColors),
    GRAPH_ENCODING.fill.fallback
  ));
}

/** Convert a numeric-ish value to a safe integer. */
export function toSafeInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

/** Compute the visible function-ring width from real call coupling data. */
export function getFunctionRingWidth(d) {
  if (!isFunctionNode(d)) return 0;

  const { inboundCalls, outboundCalls } = readNodeCouplingMetrics(d);
  const callCoupling = inboundCalls + outboundCalls;
  if (!callCoupling) return 0;

  const spread01 = normalizeCoupling01(callCoupling);
  return Math.round(
    GRAPH_ENCODING.stroke.ringMin
      + (GRAPH_ENCODING.stroke.ringMax - GRAPH_ENCODING.stroke.ringMin) * spread01
  );
}

/** Determine whether a node is an unused function. */
export function isUnusedFunctionNode(d) {
  return isFunctionNode(d) && d?._unused === true;
}

/** Convert a hex color string into RGB components. */
function hexToRgb(hex) {
  let safeHex = String(hex || "").replace("#", "");
  if (safeHex.length === 3) safeHex = safeHex.split("").map((c) => c + c).join("");
  const num = parseInt(safeHex, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

/** Convert RGB components into a hex string. */
function rgbToHex(r, g, b) {
  const toHex = (value) => {
    const s = Math.max(0, Math.min(255, Math.round(value))).toString(16);
    return s.length === 1 ? "0" + s : s;
  };

  return "#" + toHex(r) + toHex(g) + toHex(b);
}

/** Adjust color intensity while preserving the base semantic hue. */
function adjustColorIntensity(baseHex, factor) {
  const { r, g, b } = hexToRgb(baseHex);
  const k = Math.max(0, Math.min(1.3, factor));
  const mixTo = k < 1 ? 255 : 0;
  const t = k < 1 ? (1 - k) : (k - 1);

  return rgbToHex(
    r * (1 - t) + mixTo * t,
    g * (1 - t) + mixTo * t,
    b * (1 - t) + mixTo * t
  );
}

/** Read the normalized complexity score if present. */
function readComplexityScore01(d) {
  const value = d?._complexityScore;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return clamp(value, 0, 1);
}

/** Read the raw complexity value from the node. */
function readRawComplexity(d) {
  return Number(d?.complexity ?? d?.cc ?? 0) || 0;
}

/** Normalize a raw complexity value into a 0..1 range. */
function normalizeRawComplexity01(rawCx) {
  return clamp(Math.log1p(Math.max(0, rawCx)) / Math.log1p(25), 0, 1);
}

/** Compute the tone factor for function nodes. */
function toneFactorForFunctionNode(d, score01) {
  const cx01 = (score01 != null) ? score01 : normalizeRawComplexity01(readRawComplexity(d));
  return 0.85 + 0.40 * cx01;
}

/** Compute the tone factor for non-function nodes. */
function toneFactorForNonFunctionNode(score01) {
  return 0.90 + 0.30 * score01;
}

/** Compute the final fill color for a node. */
export function computeNodeColor(d) {
  const base = getBaseNodeColor(d);
  const score01 = readComplexityScore01(d);

  if (isFunctionNode(d)) {
    return adjustColorIntensity(base, toneFactorForFunctionNode(d, score01));
  }

  if (score01 == null) return base;
  return adjustColorIntensity(base, toneFactorForNonFunctionNode(score01));
}

/**
 * Compute the node radius directly from cyclomatic complexity.
 *
 * Radius is always derived from raw CC data, never from hotspot state or from
 * a pre-normalized hotspot-like score. This keeps node size numeric,
 * data-driven, and stable across hotspot/non-hotspot views.
 */
export function computeNodeRadius(d) {
  if (isFunctionNode(d)) {
    return computeFunctionNodeRadius(d);
  }

  return computeContainerNodeRadius(d);
}

/** Compute the visible radius for function nodes from raw cyclomatic complexity. */
function computeFunctionNodeRadius(d) {
  const rawCc = readRawComplexity(d);
  const cc01 = normalizeRawComplexity01(rawCc);
  const score15 = computeComplexityScore15(rawCc);
  const { min, max, exponent, maxBoost, scoreBiasStep } = GRAPH_ENCODING.radius.function;
  const spread01 = Math.pow(cc01, exponent);
  const scoreBias = (score15 - 1) * scoreBiasStep;

  return clamp(
    min + (max - min) * spread01 + scoreBias,
    min,
    max + maxBoost
  );
}

/** Compute the visible radius for non-function/container nodes from related CC data. */
function computeContainerNodeRadius(d) {
  const rawCc = readContainerRawComplexity(d);
  const cc01 = normalizeRawComplexity01(rawCc);
  const { min, max } = GRAPH_ENCODING.radius.container;
  return min + (max - min) * cc01;
}

/** Map raw cyclomatic complexity to the app's canonical 1..5 score buckets. */
function computeComplexityScore15(rawCc) {
  const cc = Math.max(0, Number(rawCc) || 0);
  if (cc <= 1) return 1;
  if (cc <= 3) return 2;
  if (cc <= 6) return 3;
  if (cc <= 10) return 4;
  return 5;
}

/**
 * Read the CC source for non-function/container nodes.
 *
 * Container radius is still CC-derived. When a node has child functions, their
 * raw CC values are folded into the container signal so the size reflects the
 * code it contains instead of hotspot state.
 */
function readContainerRawComplexity(d) {
  const localCc = readRawComplexity(d);
  const childFunctions = getChildFunctionNodes(d);
  if (!childFunctions.length) return localCc;

  let childTotalCc = 0;
  let childMaxCc = 0;

  for (const fn of childFunctions) {
    const childCc = readRawComplexity(fn);
    childTotalCc += childCc;
    childMaxCc = Math.max(childMaxCc, childCc);
  }

  const childMeanCc = childTotalCc / childFunctions.length;
  return Math.max(localCc, childMeanCc, childMaxCc * 0.85);
}

/** Read child function nodes for a module-like parent node. */
function getChildFunctionNodes(d) {
  if (!d || typeof d !== "object") return [];

  const cached = NODE_CHILD_FUNCTIONS_CACHE.get(d);
  if (cached) return cached;

  const items = Array.isArray(d?.children) ? d.children : [];
  const childFunctions = items.filter((child) => isFunctionNode(child));
  NODE_CHILD_FUNCTIONS_CACHE.set(d, childFunctions);
  return childFunctions;
}

/** Determine whether a node behaves like a module/file container. */
function isModuleLikeNode(d) {
  if (!d || typeof d !== "object") return false;

  const group = readTrimmedString(d, "group");
  const kind = readTrimmedString(d, "kind");
  const type = readTrimmedString(d, "type");

  return group === "code"
    || kind === "module"
    || kind === "file"
    || type === "module"
    || type === "file";
}

/** Read a node-local raw line count. */
function readRawLineCount(d) {
  const candidates = [
    d?.loc,
    d?.lines,
    d?.lineCount,
    d?.sloc,
    d?.size,
    d?._lines
  ];

  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }

  return 0;
}

/** Normalize a raw line count into a 0..1 range. */
function normalizeRawLineCount01(rawLines) {
  return clamp(Math.log1p(Math.max(0, rawLines)) / Math.log1p(400), 0, 1);
}

/** Build an effective line score for radius calculation. */
function computeEffectiveLineScore01(d) {
  const normalized = Number(d?._lineScore);
  if (Number.isFinite(normalized)) return clamp(normalized, 0, 1);

  return normalizeRawLineCount01(readRawLineCount(d));
}

/** Read the first finite number from a candidate list. */
function firstFiniteNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Sum all finite positive numbers from a candidate list. */
function sumFiniteNumbers(...values) {
  let total = 0;

  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) total += n;
  }

  return total;
}

/** Normalize coupling volume into a stable 0..1 range. */
function normalizeCoupling01(rawCoupling) {
  const safe = Math.max(0, Number(rawCoupling) || 0);
  const ref = GRAPH_ENCODING.stroke.couplingReference;
  return clamp(Math.log1p(safe) / Math.log1p(ref), 0, 1);
}

/** Normalize raw edge weight into a stable 0..1 range. */
function normalizeEdgeWeight01(rawWeight) {
  const safe = Math.max(0, Number(rawWeight) || 0);
  const ref = GRAPH_ENCODING.edge.weightReference;
  return clamp(Math.log1p(safe) / Math.log1p(ref), 0, 1);
}

function getEdgeSemanticType(edge) {
  if (edge && typeof edge === "object") {
    const cached = EDGE_TYPE_CACHE.get(edge);
    if (cached) return cached;
  }

  const normalizedType = normalizeLinkType(edge, "default");

  if (edge && typeof edge === "object") {
    EDGE_TYPE_CACHE.set(edge, normalizedType);
  }

  return normalizedType;
}

/** Read a numeric edge weight from commonly used graph fields. */
function readEdgeWeight(edge) {
  if (edge && typeof edge === "object") {
    const cached = EDGE_WEIGHT_CACHE.get(edge);
    if (cached != null) return cached;
  }

  const weight = Math.max(0, firstFiniteNumber(
    edge?._weight,
    edge?.weight,
    edge?.count,
    edge?.value,
    edge?.strength,
    edge?.calls,
    edge?.uses,
    1
  ) || 0);

  if (edge && typeof edge === "object") {
    EDGE_WEIGHT_CACHE.set(edge, weight);
  }

  return weight;
}

/** Read canonical inbound/outbound dependency metrics from the graph model. */
function readNodeCouplingMetrics(d) {
  if (!d || typeof d !== "object") {
    return {
      inboundCalls: 0,
      outboundCalls: 0,
      inboundUses: 0,
      outboundUses: 0,
      inboundIncludes: 0,
      outboundIncludes: 0,
      inboundEdges: 0,
      outboundEdges: 0,
      inboundTotal: 0,
      outboundTotal: 0
    };
  }

  const cached = NODE_COUPLING_CACHE.get(d);
  if (cached) return cached;

  const inboundCalls = sumFiniteNumbers(d?._inCalls, d?.inCalls, d?.callsIn);
  const outboundCalls = sumFiniteNumbers(d?._outCalls, d?.outCalls, d?.callsOut);
  const inboundUses = sumFiniteNumbers(d?._inUses, d?.inUses, d?.usesIn);
  const outboundUses = sumFiniteNumbers(d?._outUses, d?.outUses, d?.usesOut);
  const inboundIncludes = sumFiniteNumbers(d?._inIncludes, d?.inIncludes, d?.includesIn);
  const outboundIncludes = sumFiniteNumbers(d?._outIncludes, d?.outIncludes, d?.includesOut);
  const inboundEdges = sumFiniteNumbers(d?._inbound, d?.inbound, d?.fanIn, d?._fanIn);
  const outboundEdges = sumFiniteNumbers(d?._outbound, d?.outbound, d?.fanOut, d?._fanOut);

  const metrics = {
    inboundCalls,
    outboundCalls,
    inboundUses,
    outboundUses,
    inboundIncludes,
    outboundIncludes,
    inboundEdges,
    outboundEdges,
    inboundTotal: inboundCalls + inboundUses + inboundIncludes + inboundEdges,
    outboundTotal: outboundCalls + outboundUses + outboundIncludes + outboundEdges
  };

  NODE_COUPLING_CACHE.set(d, metrics);
  return metrics;
}

/** Read the effective inbound dependency count from the graph model. */
function readImportCount(d) {
  const metrics = readNodeCouplingMetrics(d);
  return metrics.inboundTotal;
}

/** Read the effective outbound dependency count from the graph model. */
function readExportCount(d) {
  const metrics = readNodeCouplingMetrics(d);
  const exportedBias = d?.exported === true ? 1 : 0;
  return metrics.outboundTotal + exportedBias;
}

/** Resolve the API/dependency role encoded by the node border. */
function getNodeBorderRole(d) {
  const imports = readImportCount(d);
  const exports = readExportCount(d);
  const isExplicitExport = d?.exported === true;

  if (imports > 0 && (exports > 0 || isExplicitExport)) return "shared";
  if (exports > 0 || isExplicitExport) return "exported";
  if (imports > 0) return "imported";
  return "default";
}

/** Compute a coupling-based stroke width bonus from real dependency volume. */
function computeNodeCouplingWidth(d) {
  const metrics = readNodeCouplingMetrics(d);
  const coupling = metrics.inboundTotal + metrics.outboundTotal;
  if (!coupling) return GRAPH_ENCODING.stroke.defaultWidth;

  const spread01 = normalizeCoupling01(coupling);
  return GRAPH_ENCODING.stroke.couplingMin
    + (GRAPH_ENCODING.stroke.couplingMax - GRAPH_ENCODING.stroke.couplingMin) * spread01;
}

/** Compute the node stroke color. */
export function computeNodeStroke(d) {
  if (d?._changed) return resolveCssColor(GRAPH_ENCODING.stroke.changedColor);

  switch (getNodeBorderRole(d)) {
    case "shared":
      return resolveCssColor(GRAPH_ENCODING.stroke.sharedColor);
    case "exported":
      return resolveCssColor(GRAPH_ENCODING.stroke.exportedColor);
    case "imported":
      return resolveCssColor(GRAPH_ENCODING.stroke.importedColor);
    default:
      return resolveCssColor(GRAPH_ENCODING.stroke.defaultColor);
  }
}

/** Compute the node stroke width. */
export function computeNodeStrokeWidth(d) {
  if (d?._changed) return GRAPH_ENCODING.stroke.changedWidth;

  const couplingWidth = computeNodeCouplingWidth(d);

  switch (getNodeBorderRole(d)) {
    case "shared":
      return Math.max(GRAPH_ENCODING.stroke.sharedWidth, couplingWidth);
    case "exported":
      return Math.max(GRAPH_ENCODING.stroke.exportedWidth, couplingWidth);
    case "imported":
      return Math.max(GRAPH_ENCODING.stroke.importedWidth, couplingWidth);
    default:
      return Math.max(GRAPH_ENCODING.stroke.defaultWidth, couplingWidth);
  }
}

export function computeEdgeColor(edge, nodeById = null) {
  const resourceEdgeColor = getResourceEdgeColor(edge, nodeById);
  if (resourceEdgeColor) return resourceEdgeColor;

  if (edge?._changed) return resolveCssColor(GRAPH_ENCODING.edge.changedColor);

  switch (getEdgeSemanticType(edge)) {
    case "call":
      return resolveCssColor(GRAPH_ENCODING.edge.callColor);
    case "use":
      return resolveCssColor(GRAPH_ENCODING.edge.useColor);
    case "include":
      return resolveCssColor(GRAPH_ENCODING.edge.includeColor);
    case "extends":
      return resolveCssColor(GRAPH_ENCODING.edge.extendsColor);
    default:
      return resolveCssColor(GRAPH_ENCODING.edge.defaultColor);
  }
}

/** Compute the edge stroke width from its numeric weight. */
export function computeEdgeWidth(edge, nodeById = null) {
  if (readResourceEdgeArt(readEdgeTargetNode(edge, nodeById))) {
    const weight = readEdgeWeight(edge);
    if (!weight) return GRAPH_ENCODING.edge.resourceMinWidth;

    const spread01 = normalizeEdgeWeight01(weight);
    return GRAPH_ENCODING.edge.resourceMinWidth
      + ((GRAPH_ENCODING.edge.resourceMaxWidth - GRAPH_ENCODING.edge.resourceMinWidth) * spread01);
  }

  if (edge?._changed) return GRAPH_ENCODING.edge.maxWidth;

  const weight = readEdgeWeight(edge);
  if (!weight) return GRAPH_ENCODING.edge.defaultWidth;

  const spread01 = normalizeEdgeWeight01(weight);
  return GRAPH_ENCODING.edge.minWidth
    + (GRAPH_ENCODING.edge.maxWidth - GRAPH_ENCODING.edge.minWidth) * spread01;
}

/** Assemble the node encoder bundle used by render and repaint. */
export function makeEncoders(nodes) {
  const nodeById = buildNodeLookup(nodes);

  return {
    getNodeColor: computeNodeColor,
    getRadius: computeNodeRadius,
    getNodeStroke: computeNodeStroke,
    getNodeStrokeWidth: computeNodeStrokeWidth,
    getFunctionRingWidth,
    getEdgeColor: (edge) => computeEdgeColor(edge, nodeById),
    getEdgeWidth: (edge) => computeEdgeWidth(edge, nodeById)
  };
}

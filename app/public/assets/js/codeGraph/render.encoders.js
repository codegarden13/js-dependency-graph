

/**
 * CodeGraph node encoders.
 * ---------------------------------------------------------------------------
 * Owns visual encoding helpers that derive colors, radii, strokes, and node
 * classification from normalized graph nodes.
 */

/** Semantic node-group colors. */
const NODE_GROUP_COLORS = {
  root: "#111827",
  dir: "#6c8cff",
  code: "#adb5bd",
  doc: "#2ec4b6",
  data: "#ff9933",
  image: "#9d4edd"
};

/** Legacy kind/type fallback colors. */
const NODE_KIND_COLORS = {
  controller: "#ff6b6b",
  service: "#4d96ff",
  module: "#ff9933",
  repository: "#ffd166",
  config: "#f72585",
  core: "#4361ee",
  helper: "#9d4edd",
  function: "#22223b",
  dir: "#6c8cff",
  asset: "#2ec4b6",
  file: "#adb5bd"
};

/** Highlight color for exported function nodes. */
const EXPORTED_FUNCTION_COLOR = "#ff6666";

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

/** Pick the semantic base color for a node. */
function getBaseNodeColor(d) {
  const group = readTrimmedString(d, "group");
  const kind = readTrimmedString(d, "kind");
  const type = readTrimmedString(d, "type");

  return firstTruthy(
    lookupOrNull(group, NODE_GROUP_COLORS),
    lookupOrNull(kind, NODE_KIND_COLORS),
    lookupOrNull(type, NODE_KIND_COLORS),
    NODE_GROUP_COLORS.code
  );
}

/** Convert a numeric-ish value to a safe integer. */
export function toSafeInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

/** Compute the visible function-ring width from inbound calls. */
export function getFunctionRingWidth(d) {
  const width = toSafeInt(d?._inCalls);
  if (!width) return 0;
  return clamp(width, 1, 12);
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
 * Compute the node radius from a CodeScene-like complexity approximation plus
 * line volume.
 *
 * The score intentionally weights more than raw cyclomatic complexity:
 * complexity, nesting, and size all contribute. For module-like nodes, the
 * child-function scores are folded in so file/module nodes reflect the code
 * they contain.
 */
export function computeNodeRadius(d) {
  const score = computeRadiusScore01(d);
  const minR = 6;
  const maxR = 26;
  return minR + (maxR - minR) * score;
}

/** Read child function nodes for a module-like parent node. */
function getChildFunctionNodes(d) {
  const items = Array.isArray(d?.children) ? d.children : [];
  return items.filter((child) => isFunctionNode(child));
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

/** Read raw nested-complexity related data from a node. */
function readRawNestedComplexity(d) {
  return Math.max(0, firstFiniteNumber(
    d?._nestedComplexity,
    d?.nestedComplexity,
    d?.maxNestingDepth,
    d?.nestingDepth,
    d?.deepestNesting,
    d?.indentationComplexity,
    0
  ) || 0);
}

/**
 * Approximate a CodeScene-like complexity score.
 *
 * CodeScene does not rely on cyclomatic complexity alone. Their public docs
 * emphasize a combination of method size, cyclomatic complexity, and deeply
 * nested logic. We mirror that intention here with a weighted local score.
 */
function computeCodeSceneLikeFunctionScore01(d) {
  const cyclomatic01 = normalizeRawComplexity01(readRawComplexity(d));
  const nesting01 = clamp(Math.log1p(readRawNestedComplexity(d)) / Math.log1p(8), 0, 1);
  const lines01 = computeEffectiveLineScore01(d);

  return clamp(
    (cyclomatic01 * 0.45) +
    (nesting01 * 0.40) +
    (lines01 * 0.15),
    0,
    1
  );
}

function computeEffectiveComplexity01(d) {
  const localDeclaredScore = readComplexityScore01(d);
  const localScore = (localDeclaredScore != null)
    ? localDeclaredScore
    : computeCodeSceneLikeFunctionScore01(d);

  if (!isModuleLikeNode(d)) {
    return localScore;
  }

  const childFunctions = getChildFunctionNodes(d);
  if (!childFunctions.length) {
    return localScore;
  }

  let childTotal = 0;
  let childLines = 0;

  for (const fn of childFunctions) {
    childTotal += computeCodeSceneLikeFunctionScore01(fn);
    childLines += readRawLineCount(fn);
  }

  const childMean = childTotal / childFunctions.length;
  const localLines = readRawLineCount(d);
  const sizeWeight = clamp(
    childLines / Math.max(1, localLines + childLines),
    0.35,
    0.85
  );

  return clamp(
    (localScore * (1 - sizeWeight)) + (childMean * sizeWeight),
    0,
    1
  );
}

function computeRadiusScore01(d) {
  const complexity01 = computeEffectiveComplexity01(d);
  const lineScore01 = computeEffectiveLineScore01(d);

  return clamp(
    (complexity01 * 0.75) + (lineScore01 * 0.25),
    0,
    1
  );
}

/** Compute the node stroke color. */
export function computeNodeStroke(d) {
  if (d?._changed) return "#ff3b30";
  if (isFunctionNode(d) && d?.exported === true) return EXPORTED_FUNCTION_COLOR;
  return "rgba(0,0,0,0.08)";
}

/** Compute the node stroke width. */
export function computeNodeStrokeWidth(d) {
  if (d?._changed) return 3;
  if (isFunctionNode(d) && d?.exported === true) return 3;
  return 1;
}

/** Assemble the node encoder bundle used by render and repaint. */
export function makeEncoders(nodes) {
  void nodes;

  return {
    getNodeColor: computeNodeColor,
    getRadius: computeNodeRadius,
    getNodeStroke: computeNodeStroke,
    getNodeStrokeWidth: computeNodeStrokeWidth
  };
}
/**
 * CodeGraph node encoders.
 * ---------------------------------------------------------------------------
 * Owns visual encoding helpers that derive colors, radii, strokes, and node
 * classification from normalized graph nodes.
 */

/**
 * Central visual encoding schema for graph nodes.
 *
 * Keep all renderer-facing mapping rules in one place so size, fill, stroke,
 * and coupling stay explicit and easy to tune.
 */
const GRAPH_ENCODING = {
  fill: {
    nodeGroupColors: {
      root: "#111827",
      dir: "#6c8cff",
      code: "#adb5bd",
      doc: "#2ec4b6",
      data: "#ff9933",
      image: "#9d4edd"
    },
    nodeKindColors: {
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
    },
    fallback: "#adb5bd"
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
    defaultColor: "rgba(0,0,0,0.08)",
    changedColor: "#ff3b30",
    exportedColor: "#22c55e",
    importedColor: "#3b82f6",
    sharedColor: "#14b8a6",
    changedWidth: 3,
    exportedWidth: 3,
    importedWidth: 3,
    sharedWidth: 4,
    defaultWidth: 1,
    couplingMin: 1,
    couplingMax: 4
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

/** Pick the semantic base color for a node. */
function getBaseNodeColor(d) {
  const group = readTrimmedString(d, "group");
  const kind = readTrimmedString(d, "kind");
  const type = readTrimmedString(d, "type");
  return firstTruthy(
    lookupOrNull(group, GRAPH_ENCODING.fill.nodeGroupColors),
    lookupOrNull(kind, GRAPH_ENCODING.fill.nodeKindColors),
    lookupOrNull(type, GRAPH_ENCODING.fill.nodeKindColors),
    GRAPH_ENCODING.fill.fallback
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

  if (isFunctionNode(d)) {
    return clamp(
      (complexity01 * 0.85) + (lineScore01 * 0.15),
      0,
      1
    );
  }

  return clamp(
    (complexity01 * 0.70) + (lineScore01 * 0.30),
    0,
    1
  );
}

/** Read a safe import count from a node. */
function readImportCount(d) {
  return Math.max(0, firstFiniteNumber(
    d?._importCount,
    d?.importCount,
    d?.imports,
    d?._imports,
    d?.fanIn,
    d?._fanIn,
    0
  ) || 0);
}

/** Read a safe export count from a node. */
function readExportCount(d) {
  if (d?.exported === true) return 1;

  return Math.max(0, firstFiniteNumber(
    d?._exportCount,
    d?.exportCount,
    d?.exports,
    d?._exports,
    d?.fanOut,
    d?._fanOut,
    0
  ) || 0);
}

/** Resolve the API/dependency role encoded by the node border. */
function getNodeBorderRole(d) {
  const imports = readImportCount(d);
  const exports = readExportCount(d);

  if (imports > 0 && exports > 0) return "shared";
  if (exports > 0) return "exported";
  if (imports > 0) return "imported";
  return "default";
}

/** Compute a coupling-based stroke width bonus from import/export volume. */
function computeNodeCouplingWidth(d) {
  const coupling = readImportCount(d) + readExportCount(d);
  if (!coupling) return GRAPH_ENCODING.stroke.defaultWidth;

  const spread = clamp(
    Math.log1p(coupling) / Math.log1p(12),
    0,
    1
  );

  return GRAPH_ENCODING.stroke.couplingMin
    + (GRAPH_ENCODING.stroke.couplingMax - GRAPH_ENCODING.stroke.couplingMin) * spread;
}

/** Compute the node stroke color. */
export function computeNodeStroke(d) {
  if (d?._changed) return GRAPH_ENCODING.stroke.changedColor;

  switch (getNodeBorderRole(d)) {
    case "shared":
      return GRAPH_ENCODING.stroke.sharedColor;
    case "exported":
      return GRAPH_ENCODING.stroke.exportedColor;
    case "imported":
      return GRAPH_ENCODING.stroke.importedColor;
    default:
      return GRAPH_ENCODING.stroke.defaultColor;
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
/**
 * nodeClassification
 * ==================
 *
 * Backend-only node classification helpers.
 *
 * Purpose:
 * - Provide deterministic, canonical fields for the UI (group/layer/ext/type)
 * - Keep ALL architecture inference in the backend (frontend only renders)
 *
 * Strictness policy:
 * - These helpers never guess across the network boundary.
 * - ensureCanonicalNodeFields() fills missing *derived* fields (ext/type/group/layer)
 *   deterministically from id/kind/file.
 */

import path from "node:path";

/* ========================================================================== */
/* LOW-LEVEL HELPERS                                                          */
/* ========================================================================== */

/**
 * Extract the extension (including dot) from a project-relative id.
 * @param {string} id Project-relative file id.
 * @returns {string} Lowercased extension (e.g. ".md") or empty string.
 */
function extFromId(id) {
  const p = String(id || "");
  return String(path.extname(p) || "").toLowerCase();
}

/**
 * Convert an extension into a compact subtype.
 * @param {string} ext Extension with dot.
 * @returns {string} Subtype without dot (e.g. "md").
 */
function typeFromExt(ext) {
  const e = String(ext || "").toLowerCase();
  return e.startsWith(".") ? e.slice(1) : e;
}

/* ========================================================================== */
/* GROUP (COARSE UI BUCKET)                                                    */
/* ========================================================================== */

// Extension sets for deterministic coarse grouping.
const GROUP_DOC_EXTS = new Set([".md", ".txt"]);
const GROUP_DATA_EXTS = new Set([".json", ".jsonc", ".csv", ".tsv", ".yml", ".yaml", ".sql", ".env"]);
const GROUP_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico"]);
const GROUP_CODE_EXTS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"]);

function inExtSet(set, ext) {
  return set.has(String(ext || "").toLowerCase());
}

// Fast kind → group mapping (structural kinds override extension-based grouping).
const KIND_TO_GROUP = Object.freeze({
  root: "root",
  dir: "dir",
  function: "code"
});

// Ordered extension → group rules (first match wins).
const EXT_GROUP_RULES = Object.freeze([
  { group: "doc", exts: GROUP_DOC_EXTS },
  { group: "data", exts: GROUP_DATA_EXTS },
  { group: "image", exts: GROUP_IMAGE_EXTS },
  { group: "code", exts: GROUP_CODE_EXTS }
]);

function groupFromKindOnly(kind) {
  return KIND_TO_GROUP[String(kind || "")] || "";
}

function groupFromExtOnly(ext) {
  const e = String(ext || "").toLowerCase();
  for (const r of EXT_GROUP_RULES) {
    if (inExtSet(r.exts, e)) return r.group;
  }
  return "";
}

function defaultGroupForKind(kind) {
  // Conservative default: files are shown as code; non-file nodes as data.
  return String(kind || "") === "file" ? "code" : "data";
}

/**
 * Map a node kind + extension to the user-visible group.
 *
 * Groups are intentionally coarse: root, dir, code, doc, data, image.
 *
 * Precedence
 * ----------
 * 1) Structural kinds win (root/dir/function) to keep the UI stable.
 * 2) Otherwise classify by extension via ordered rules (first match wins).
 * 3) Fallback is conservative: kind "file" => "code", else "data".
 */
export function groupFromKindAndExt(kind, ext) {
  const byKind = groupFromKindOnly(kind);
  if (byKind) return byKind;

  const byExt = groupFromExtOnly(ext);
  if (byExt) return byExt;

  return defaultGroupForKind(kind);
}

/* ========================================================================== */
/* LAYER (ARCHITECTURE)                                                       */
/* ========================================================================== */

// Extension sets used for deterministic layer classification.
const DOC_EXTS = new Set([".md", ".txt"]);
const DATA_EXTS = new Set([
  ".json",
  ".jsonc",
  ".csv",
  ".tsv",
  ".yml",
  ".yaml",
  ".sql",
  ".env"
]);
const ASSET_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico"]);

function inSet(set, value) {
  return set.has(String(value || "").toLowerCase());
}

function includesAny(haystack, needles) {
  const h = String(haystack || "");
  for (const n of needles || []) {
    if (h.includes(n)) return true;
  }
  return false;
}

function endsWithAny(haystack, suffixes) {
  const h = String(haystack || "");
  for (const s of suffixes || []) {
    if (h.endsWith(s)) return true;
  }
  return false;
}

function normalizeLayerInputs(kind, ext, fileId) {
  return {
    k: String(kind || ""),
    e: String(ext || "").toLowerCase(),
    id: String(fileId || ""),
    lower: String(fileId || "").toLowerCase()
  };
}

function matchDirs(lower, dirs) {
  return includesAny(lower, dirs);
}

function matchEnds(lower, suffixes) {
  return endsWithAny(lower, suffixes);
}

function matchAny(lower, tokens) {
  // Token match is intentionally simple: substring checks for robustness.
  return includesAny(lower, tokens);
}

function firstMatchingLayer(rules, ctx) {
  for (const r of rules) {
    if (!r || typeof r.match !== "function") continue;
    if (r.match(ctx)) return r.layer;
  }
  return "";
}

// Ordered heuristics for code layers (first match wins).
const LAYER_RULES = [
  {
    layer: "ui",
    match: (ctx) => matchDirs(ctx.lower, ["/public/", "/assets/", "/views/"]) || matchEnds(ctx.lower, ["/app.js"])
  },
  {
    layer: "http",
    match: (ctx) => matchDirs(ctx.lower, ["/routes/", "/controllers/"])
  },
  {
    layer: "parse",
    match: (ctx) => matchAny(ctx.lower, ["parse", "@babel"]) || matchEnds(ctx.lower, ["parsefile.js", "parseast.js"])
  },
  {
    layer: "io",
    match: (ctx) => matchAny(ctx.lower, ["scan", "watch", "fs"]) || matchEnds(ctx.lower, ["scanprojecttree.js", "livechangefeed.js"])
  },
  {
    layer: "graph",
    match: (ctx) => matchAny(ctx.lower, ["graph"]) || matchEnds(ctx.lower, ["graphstore.js"])
  },
  {
    layer: "resolve",
    match: (ctx) => matchAny(ctx.lower, ["resolve"]) || matchEnds(ctx.lower, ["resolveimports.js"])
  }
];

/**
 * Map a node to an architecture layer.
 *
 * This is deterministic and conservative: the backend decides once,
 * the UI only renders.
 *
 * 1) Root/dir are structural layers.
 * 2) Non-code assets/docs/data are layered deterministically by extension.
 * 3) Code is layered by ordered heuristics over the project-relative path.
 */
export function layerFromKindExtAndFile(kind, ext, fileId) {
  const ctx = normalizeLayerInputs(kind, ext, fileId);

  if (ctx.k === "root") return "root";
  if (ctx.k === "dir") return "structure";

  // Non-code assets/docs/data
  if (inSet(DOC_EXTS, ctx.e)) return "doc";
  if (inSet(DATA_EXTS, ctx.e)) return "data";
  if (inSet(ASSET_EXTS, ctx.e)) return "asset";

  // Code heuristics (first match wins).
  const byRule = firstMatchingLayer(LAYER_RULES, ctx);
  return byRule || "app";
}

/* ========================================================================== */
/* LAYER META                                                                 */
/* ========================================================================== */

/**
 * Default layer order for the renderer (top -> bottom).
 * The UI may use these for forceY pinning and hull grouping.
 */
export const DEFAULT_LAYER_ORDER = [
  "root",
  "structure",
  "ui",
  "http",
  "io",
  "resolve",
  "parse",
  "graph",
  "app",
  "doc",
  "data",
  "asset"
];

/**
 * Provide stable Y anchors per layer (used optionally by the UI).
 * Values are arbitrary but consistent.
 */
export function defaultLayerY(order = DEFAULT_LAYER_ORDER) {
  /** @type {Record<string, number>} */
  const out = {};
  let y = 80;
  for (const l of order) {
    out[l] = y;
    y += 140;
  }
  return out;
}

/* ========================================================================== */
/* CANONICALIZATION                                                           */
/* ========================================================================== */

function isPlainObject(v) {
  return Boolean(v) && typeof v === "object";
}

function nodeId(n) {
  return String(n?.id || "");
}

function nodeKind(n) {
  return String(n?.kind || "file");
}

function computeExt(n, id) {
  return String(n?.ext || extFromId(id) || "").toLowerCase();
}

function computeType(n, ext) {
  if (n?.type) return String(n.type);
  if (!ext) return "";
  return String(typeFromExt(ext) || "");
}

function ensureExtTypeSubtype(n, id) {
  const ext = computeExt(n, id);
  const type = computeType(n, ext);

  n.ext = ext;
  n.type = type;
  n.subtype = String(n.subtype || type);

  return { ext, type };
}

function ensureGroup(n, kind, ext) {
  n.group = n.group || groupFromKindAndExt(kind, ext);
}

function hasValidLayer(n) {
  return typeof n?.layer === "string" && Boolean(n.layer);
}

/**
 * Ensure the node has a valid architecture layer.
 *
 * Refactoring rationale
 * ---------------------
 * CodeScene flagged the previous signature for having more than four
 * positional arguments. Using a parameter object makes the call-site
 * clearer and avoids argument-order mistakes.
 *
 * @param {{
 *   node:any,
 *   kind:string,
 *   ext:string,
 *   fileId?:string,
 *   fallbackId?:string
 * }} ctx
 */
function ensureLayer(ctx) {
  const { node, kind, ext, fileId, fallbackId } = ctx || {};

  if (hasValidLayer(node)) return;

  const fid = String(fileId || fallbackId || "");
  node.layer = layerFromKindExtAndFile(kind, ext, fid);
}

function ensureNumbers(n) {
  if (!Number.isFinite(n.lines)) n.lines = Number(n.lines || 0) || 0;
  if (!Number.isFinite(n.complexity)) n.complexity = Number(n.complexity || 0) || 0;
}

function ensureStrings(n, id) {
  if (typeof n.file !== "string") n.file = String(n.file || id);
  if (typeof n.headerComment !== "string") n.headerComment = String(n.headerComment || "");
}

/**
 * Ensure a node object contains the canonical classification fields.
 * This makes the exported JSON self-contained for UI rendering.
 *
 * Responsibilities (kept intentionally separate)
 * ---------------------------------------------
 * - ext/type/subtype: derived from `id` unless already provided
 * - group: derived from kind+ext unless already provided
 * - layer: derived from kind+ext+fileId unless already provided
 * - numeric/string hygiene: avoid undefined/null in the exported payload
 *
 * @param {any} n Node object (mutated).
 */
export function ensureCanonicalNodeFields(n) {
  if (!isPlainObject(n)) return;

  const id = nodeId(n);
  const kind = nodeKind(n);

  const { ext } = ensureExtTypeSubtype(n, id);

  ensureGroup(n, kind, ext);
  ensureLayer(n, kind, ext, n.file, id);

  ensureNumbers(n);
  ensureStrings(n, id);
}

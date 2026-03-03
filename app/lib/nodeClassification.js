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

/**
 * Map a node kind + extension to the user-visible group.
 * Groups are intentionally coarse: root, dir, code, doc, data, image.
 * @param {string} kind
 * @param {string} ext
 * @returns {"root"|"dir"|"code"|"doc"|"data"|"image"}
 */
export function groupFromKindAndExt(kind, ext) {
  const k = String(kind || "");
  const e = String(ext || "").toLowerCase();

  if (k === "root") return "root";
  if (k === "dir") return "dir";
  if (k === "function") return "code";

  // docs
  if (e === ".md" || e === ".txt") return "doc";

  // data
  if (e === ".json" || e === ".jsonc" || e === ".csv" || e === ".tsv" || e === ".yml" || e === ".yaml" || e === ".sql" || e === ".env") {
    return "data";
  }

  // images
  if (e === ".png" || e === ".jpg" || e === ".jpeg" || e === ".gif" || e === ".svg" || e === ".webp" || e === ".ico") {
    return "image";
  }

  // code
  if (e === ".js" || e === ".mjs" || e === ".cjs" || e === ".ts" || e === ".tsx" || e === ".jsx") {
    return "code";
  }

  // Default to code if the node is a file but extension is unknown.
  return k === "file" ? "code" : "data";
}

/* ========================================================================== */
/* LAYER (ARCHITECTURE)                                                       */
/* ========================================================================== */

/**
 * Map a node to an architecture layer.
 *
 * This is intentionally deterministic and conservative: the backend decides once,
 * the UI only renders.
 *
 * Layers are used for:
 * - hull grouping
 * - optional vertical pinning (forceY)
 * - legend/badges
 *
 * @param {string} kind
 * @param {string} ext
 * @param {string} fileId
 * @returns {string}
 */
export function layerFromKindExtAndFile(kind, ext, fileId) {
  const k = String(kind || "");
  const e = String(ext || "").toLowerCase();
  const id = String(fileId || "");

  if (k === "root") return "root";
  if (k === "dir") return "structure";

  // Non-code assets/docs/data
  if (e === ".md" || e === ".txt") return "doc";
  if (e === ".json" || e === ".jsonc" || e === ".csv" || e === ".tsv" || e === ".yml" || e === ".yaml" || e === ".sql" || e === ".env") return "data";
  if (e === ".png" || e === ".jpg" || e === ".jpeg" || e === ".gif" || e === ".svg" || e === ".webp" || e === ".ico") return "asset";

  // Heuristics for code layers by file path/name
  // NOTE: fileId is project-relative, POSIX separators.
  const lower = id.toLowerCase();

  // UI/public
  if (lower.includes("/public/") || lower.includes("/assets/") || lower.includes("/views/") || lower.endsWith("/app.js")) {
    return "ui";
  }

  // HTTP/routes
  if (lower.includes("/routes/") || lower.includes("/controllers/")) {
    return "http";
  }

  // Parsing/AST
  if (lower.includes("parse") || lower.includes("@babel") || lower.endsWith("parsefile.js") || lower.endsWith("parseast.js")) {
    return "parse";
  }

  // IO / filesystem / scanning
  if (lower.includes("scan") || lower.includes("watch") || lower.includes("fs") || lower.endsWith("scanprojecttree.js") || lower.endsWith("livechangefeed.js")) {
    return "io";
  }

  // Graph/storage
  if (lower.includes("graph") || lower.endsWith("graphstore.js")) {
    return "graph";
  }

  // Resolution/deps
  if (lower.includes("resolve") || lower.endsWith("resolveimports.js")) {
    return "resolve";
  }

  // Default: generic app logic
  return "app";
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

/**
 * Ensure a node object contains the canonical classification fields.
 * This makes the exported JSON self-contained for UI rendering.
 *
 * @param {any} n Node object (mutated).
 */
export function ensureCanonicalNodeFields(n) {
  if (!n || typeof n !== "object") return;

  const id = String(n.id || "");
  const kind = String(n.kind || "file");

  // ext/type/subtype
  const ext = String(n.ext || extFromId(id) || "").toLowerCase();
  const type = String(n.type || (ext ? typeFromExt(ext) : "") || "");

  n.ext = ext;
  n.type = type;
  n.subtype = String(n.subtype || type);

  // group
  n.group = n.group || groupFromKindAndExt(kind, ext);

  // layer (for hull grouping / forceY). UI should not guess.
  if (typeof n.layer !== "string" || !n.layer) {
    n.layer = layerFromKindExtAndFile(kind, ext, String(n.file || id));
  }

  // numbers (avoid undefined)
  if (!Number.isFinite(n.lines)) n.lines = Number(n.lines || 0) || 0;
  if (!Number.isFinite(n.complexity)) n.complexity = Number(n.complexity || 0) || 0;

  // strings
  if (typeof n.file !== "string") n.file = String(n.file || id);
  if (typeof n.headerComment !== "string") n.headerComment = String(n.headerComment || "");
}

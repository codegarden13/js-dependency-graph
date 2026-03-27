

/**
 * autoMode
 * ============================================================================
 *
 * Purpose
 * -------
 * This module adds best-effort structural enrichment for projects whose
 * architecture is only weakly visible through normal JS / TS import traversal.
 *
 * Real-world projects often reference important files and folders indirectly,
 * for example via:
 * - `express.static(...)`
 * - config files (`config.json`, `.env`, YAML)
 * - CSV / JSON data files
 * - HTML / CSS assets that reference further files
 *
 * Without extra help, those relationships may never appear in the graph.
 *
 * What this module adds
 * ---------------------
 * 1. AUTO REFS
 *    If `parseFile()` reports file / asset references, the module creates the
 *    referenced nodes and `include` edges.
 *
 * 2. Referenced directory expansion
 *    If a reference points to a directory, the module creates a directory node
 *    and expands a shallow, bounded child listing.
 *
 * 3. AUTO SKELETON support helpers
 *    The same file / directory classification helpers are reused by the graph
 *    builder when it needs a lightweight project skeleton fallback.
 *
 * Safety and performance guardrails
 * ---------------------------------
 * - never traverse outside the project root
 * - bounded directory expansion (depth + entry count)
 * - skip well-known noise folders (`node_modules`, `.git`, build output, ...)
 * - only parse cheap text-like files for secondary references
 *
 * Integration model
 * -----------------
 * This module is intentionally decoupled from the graph builder.
 * The caller provides callbacks such as:
 * - `ensureNode(node)`
 * - `ensureLink(sourceId, targetId, type)`
 * - `enqueue(absPath)`
 * - `hasVisited(absPath)`
 *
 * The builder decides when auto mode is invoked. This module only performs the
 * local enrichment work.
 */

import fs from "node:fs";
import path from "node:path";

import { parseFile } from "./parseFile.js";
import { isInsideRoot } from "./fsPaths.js";

/* ========================================================================== */
/* AUTO MODE CONFIGURATION                                                    */
/* ========================================================================== */

// Directory listing limits (shallow expansion).
export const AUTO_MAX_DIR_ENTRIES = 140;   // max direct children per referenced directory
export const AUTO_MAX_DIR_DEPTH = 2;       // recursion depth for referenced directories

// Skeleton fallback limits (only used if graph is nearly empty).
export const AUTO_MAX_SKELETON_DIRS = 16;          // number of top-level dirs to include
export const AUTO_MAX_SKELETON_FILES_PER_DIR = 100; // max files per skeleton directory

// Ignore noise / OS + build artifacts.
export const AUTO_SKIP_NAMES = new Set([
  ".DS_Store",
  "Thumbs.db",
  ".git",
  ".svn",
  ".hg",
  "node_modules",
  ".next",
  ".nuxt",
  "dist",
  "build",
  "out",
  ".cache",
  ".idea",
  ".vscode"
]);

// File extensions we consider useful for architectural context.
// Keep conservative: the goal is to show structure, not every binary.
export const AUTO_ASSET_EXT_ALLOW = new Set([
  // code
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
  // data
  ".json", ".jsonc", ".csv", ".tsv", ".yml", ".yaml", ".env", ".env.local", ".sql","csv",
  // docs (also parseable)
  ".md", ".txt", ".html", ".htm", ".css",
  // images
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico"
]);
// Image extensions (used for classification in `classifyFileByExt`).
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico"]);

// Code extensions (used for classification in `classifyFileByExt`).
const CODE_EXTS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"]);

// Documentation / text extensions (used for classification in `classifyFileByExt`).
const DOC_EXTS = new Set([".md", ".txt", ".html", ".htm", ".css"]);

function normalizeExt(fileAbs) {
  return String(path.extname(fileAbs || "")).toLowerCase();
}

function extTypeToken(ext) {
  // Stable subtype token: drop the leading dot.
  return ext ? ext.slice(1) : "";
}

function classifyBySet(ext, kind, set) {
  if (!set.has(ext)) return null;
  return { kind, type: extTypeToken(ext), ext };
}

function classifyDataFallback(ext) {
  return { kind: "data", type: ext ? extTypeToken(ext) : "data", ext };
}

// File types we can cheaply parse for additional references (non-JS).
export const AUTO_PARSEABLE_TEXT_EXT = new Set([
  ".json", ".jsonc",
  ".md", ".txt",
  ".html", ".htm", ".css",
  ".yml", ".yaml",
  ".env", ".env.local",
  ".sql"
]);

// Common directories that often encode architecture.
export const AUTO_PREFERRED_DIRS = [
  "app",
  "src",
  "routes",
  "controllers",
  "services",
  "lib",
  "config",
  "data",
  "public",
  "views",
  "static",
  "assets",
  "scripts",
  "tests"
];

// Also include a few top-level important files if present.
export const AUTO_TOP_FILES = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "README.md",
  "readme.md",
  "config.json",
  ".env"
];

/* ========================================================================== */
/* PUBLIC API                                                                */
/* ========================================================================== */

/**
 * Apply best-effort reference expansion for one already-parsed file.
 *
 * Expected call site
 * ------------------
 * The graph builder calls this after `parseFile()` returned metadata for a
 * source file. If parse output exposes referenced files or assets, this module
 * materializes those relationships as graph nodes and `include` edges.
 *
 * The function is intentionally fail-soft:
 * - invalid / incomplete args -> no-op
 * - missing references        -> no-op
 * - inaccessible targets      -> ignored
 *
 * @param {object} args
 */
export function applyAutoRefs(args) {
  const ctx = normalizeAutoRefsArgs(args);
  if (!ctx) return;

  const refs = collectAutoRefs(ctx.parsed);
  if (!refs.length) return;

  for (const ref of refs) {
    processAutoRef(ctx, ref);
  }
}

/**
 * Normalize and validate the AUTO REFS input payload once.
 *
 * Why this exists
 * ---------------
 * The public entrypoint accepts a broad callback-based argument object. This
 * helper converts that loose input into one compact internal context so helper
 * functions do not need to repeatedly validate the same fields.
 *
 * Returns `null` if the minimum required contract is missing.
 */

function normalizeAutoRefsArgs(args) {
  const a = args && typeof args === "object" ? args : null;
  if (!a) return null;

  const rootAbs = path.resolve(String(a.projectRootAbs || ""));
  const fromFileId = String(a.fromFileId || "");

  if (!rootAbs || !fromFileId) return null;

  return {
    rootAbs,
    fromFileId,
    parsed: a.parsed,
    toRelId: a.toRelId,
    ensureNode: a.ensureNode,
    ensureLink: a.ensureLink,
    enqueue: a.enqueue,
    hasVisited: a.hasVisited
  };
}

function pushArrayProp(into, obj, prop) {
  const arr = obj && Array.isArray(obj[prop]) ? obj[prop] : null;
  if (!arr || !arr.length) return;
  into.push(...arr);
}

/**
 * Merge all known parser reference buckets into one flat list.
 *
 * Why this exists
 * ---------------
 * `parseFile()` may expose slightly different property names depending on file
 * type or parser evolution. AUTO REFS does not care which bucket a reference
 * came from; it only needs one normalized list to process.
 *
 * @param {any} parsed
 * @returns {string[]}
 */
function collectAutoRefs(parsed) {
  const refs = [];
  const p = parsed && typeof parsed === "object" ? parsed : null;
  if (!p) return refs;

  // Merge ref buckets; parser may expose different properties across versions.
  // We keep them as-is and resolve to absolute paths later.
  const props = ["fileRefsAbs", "fileRefsRel", "assetRefsAbs", "assetRefsRel"];
  for (const key of props) pushArrayProp(refs, p, key);

  return refs;
}

/**
 * Resolve and materialize one parser-reported reference.
 *
 * The reference may point to:
 * - a file   -> create / link file node
 * - a dir    -> create / link dir node and expand it shallowly
 * - invalid  -> ignore
 *
 * Out-of-root targets are rejected defensively.
 */
function processAutoRef(ctx, ref) {
  const refAbs = toAbsFromRelMaybe(ctx.rootAbs, ref);
  if (!refAbs) return;
  if (!isInsideRoot(ctx.rootAbs, refAbs)) return;

  const st = safeStat(refAbs);
  if (!st) return;

  if (st.isDirectory()) {
    handleReferencedDirectory(ctx, refAbs);
    return;
  }

  if (!st.isFile()) return;
  handleReferencedFile(ctx, refAbs);
}

function handleReferencedDirectory(ctx, dirAbs) {
  linkReferencedDirectoryFromCtx(ctx, {
    parentId: ctx.fromFileId,
    projectRootAbs: ctx.rootAbs,
    dirAbs
  });
}

function buildLinkReferencedFileArgs(ctx, { parentId, projectRootAbs, fileAbs, parseTextRefs }) {
  const fileId = ctx.toRelId(fileAbs);
  return {
    parentId,
    projectRootAbs,
    fileAbs,
    fileId,
    toRelId: ctx.toRelId,
    ensureNode: ctx.ensureNode,
    ensureLink: ctx.ensureLink,
    enqueue: ctx.enqueue,
    hasVisited: ctx.hasVisited,
    parseTextRefs
  };
}

function linkReferencedFileFromCtx(ctx, { parentId, projectRootAbs, fileAbs, parseTextRefs }) {
  linkReferencedFile(
    buildLinkReferencedFileArgs(ctx, { parentId, projectRootAbs, fileAbs, parseTextRefs })
  );
}

function handleReferencedFile(ctx, fileAbs) {
  linkReferencedFileFromCtx(ctx, {
    parentId: ctx.fromFileId,
    projectRootAbs: ctx.rootAbs,
    fileAbs,
    parseTextRefs: true
  });
}

function ensureDirNode(ensureNode, dirId) {
  ensureNode({
    id: dirId,
    file: dirId,
    kind: "dir",
    type: "dir",
    lines: 0,
    complexity: 0,
    headerComment: ""
  });
}

/**
 * Ensure a directory node exists, link it from a parent, and expand it once (bounded).
 *
 * Removes duplication between:
 * - applyAutoRefs() directory handling
 * - tryParseReferencedTextFile() directory handling
 */
function linkAndExpandDirectory({
  parentId,
  projectRootAbs,
  dirAbs,
  dirId,
  toRelId,
  ensureNode,
  ensureLink,
  enqueue,
  hasVisited
}) {
  if (!parentId || !dirId) return;

  ensureDirNode(ensureNode, dirId);
  ensureLink(parentId, dirId, "include");

  // Expand referenced directory in a bounded way (depth-limited, entry-capped).
  expandDirectoryBounded({
    projectRootAbs,
    refDirAbs: dirAbs,
    refDirId: dirId,
    toRelId,
    ensureNode,
    ensureLink,
    enqueue,
    hasVisited,
    depth: 0
  });
}

function classifyOnce(fileAbs) {
  return classifyFileByExt(fileAbs);
}

function ensureFileNode(ensureNode, fileId, fileAbs) {
  const cls = classifyOnce(fileAbs);
  ensureNode({
    id: fileId,
    file: fileId,
    kind: cls.kind,
    type: cls.type,
    ext: cls.ext,
    lines: 0,
    complexity: 0,
    headerComment: ""
  });
}

function isSpecialTopFileName(name) {
  return name === "Dockerfile" || name === "Makefile" || name === "LICENSE";
}

function isAllowedSkeletonFile(name) {
  if (!name) return false;
  if (AUTO_SKIP_NAMES.has(name)) return false;
  if (name.startsWith(".")) return false;

  const ext = String(path.extname(name)).toLowerCase();
  const isSpecial = isSpecialTopFileName(name);

  // If it has an extension, it must be in the allowlist.
  // Special files are allowed even without an extension.
  if (isSpecial) return true;

  // Files without an extension are allowed (e.g. some config stubs).
  if (!ext) return true;

  // Non-special files with an extension must be explicitly allowed.
  if (!AUTO_ASSET_EXT_ALLOW.has(ext)) return false;

  return true;
}


/* ========================================================================== */
/* DIRECTORY EXPANSION                                                       */
/* ========================================================================== */

/**
 * Expand a referenced directory into a bounded subgraph.
 *
 * - Adds nodes for child directories and allowed files
 * - Adds include edges: refDir -> child
 * - Recurses into subdirectories up to AUTO_MAX_DIR_DEPTH
 * - Enqueues script files for deeper import traversal
 *
 * @param {object} args
 */
function expandDirectoryBounded(args) {
  const ctx = normalizeExpandDirArgs(args);
  if (!ctx) return;

  const entries = safeReadDir(ctx.refDirAbs);
  forEachDirEntry(entries, ctx, (name) => expandOneChildEntry(name, ctx));
}

function normalizeExpandDirArgs(args) {
  const a = args && typeof args === "object" ? args : null;
  if (!a) return null;

  const depth = Number(a.depth || 0) || 0;
  if (depth >= AUTO_MAX_DIR_DEPTH) return null;

  return {
    projectRootAbs: a.projectRootAbs,
    refDirAbs: a.refDirAbs,
    refDirId: a.refDirId,
    toRelId: a.toRelId,
    ensureNode: a.ensureNode,
    ensureLink: a.ensureLink,
    enqueue: a.enqueue,
    hasVisited: a.hasVisited,
    depth
  };
}

function forEachDirEntry(entries, ctx, fn) {
  if (!Array.isArray(entries) || !entries.length) return;

  let count = 0;
  for (const name of entries) {
    if (count >= AUTO_MAX_DIR_ENTRIES) break;
    if (!shouldConsiderDirEntry(name)) continue;

    fn(name);
    count++;
  }

  void ctx;
}

function shouldConsiderDirEntry(name) {
  if (!name) return false;
  if (AUTO_SKIP_NAMES.has(name)) return false;
  if (name.startsWith(".")) return false;
  return true;
}

function expandOneChildEntry(name, ctx) {
  const childAbs = path.join(ctx.refDirAbs, name);
  const st = safeStat(childAbs);
  if (!st) return;

  if (st.isDirectory()) {
    expandChildDirectory(childAbs, ctx);
    return;
  }

  if (!st.isFile()) return;
  expandChildFile(childAbs, name, ctx);
}

function expandChildDirectory(dirAbs, ctx) {
  const dirId = ctx.toRelId(dirAbs);

  ensureDirNode(ctx.ensureNode, dirId);
  ctx.ensureLink(ctx.refDirId, dirId, "include");

  expandDirectoryBounded({
    projectRootAbs: ctx.projectRootAbs,
    refDirAbs: dirAbs,
    refDirId: dirId,
    toRelId: ctx.toRelId,
    ensureNode: ctx.ensureNode,
    ensureLink: ctx.ensureLink,
    enqueue: ctx.enqueue,
    hasVisited: ctx.hasVisited,
    depth: ctx.depth + 1
  });
}

function expandChildFile(fileAbs, entryName, ctx) {
  if (!isAllowedSkeletonFile(entryName)) return;

  const fileId = ctx.toRelId(fileAbs);
  ensureFileNode(ctx.ensureNode, fileId, fileAbs);
  ctx.ensureLink(ctx.refDirId, fileId, "include");

  // Optional deeper traversal for code files.
  maybeEnqueueReferencedCode({
    cls: classifyOnce(fileAbs),
    fileAbs,
    enqueue: ctx.enqueue,
    hasVisited: ctx.hasVisited
  });

  // Parse lightweight text files to discover more references.
  maybeParseReferencedText({
    cls: classifyOnce(fileAbs),
    fileAbs,
    projectRootAbs: ctx.projectRootAbs,
    parentId: fileId,
    toRelId: ctx.toRelId,
    ensureNode: ctx.ensureNode,
    ensureLink: ctx.ensureLink,
    enqueue: ctx.enqueue,
    hasVisited: ctx.hasVisited
  });
}

function tryParseReferencedTextFile(args) {
  const ctx = normalizeTryParseTextArgs(args);
  if (!ctx) return;

  const text = readUtf8OrNull(ctx.fileAbs);
  if (text == null) return;

  const parsed = parseFile(text, ctx.fileAbs);
  const refs = collectAutoRefs(parsed);
  if (!refs.length) return;

  for (const ref of refs) {
    applyTextRef(ctx, ref);
  }
}

function asPlainObject(x) {
  return x && typeof x === "object" ? x : null;
}

function nonEmptyString(x) {
  const s = String(x || "").trim();
  return s ? s : "";
}

function normalizeTryParseTextArgs(args) {
  const a = asPlainObject(args);
  if (!a) return null;

  const projectRootAbs = path.resolve(nonEmptyString(a.projectRootAbs));
  const fileAbs = nonEmptyString(a.fileAbs);
  const parentId = nonEmptyString(a.parentId);

  if (!projectRootAbs) return null;
  if (!fileAbs) return null;
  if (!parentId) return null;

  return {
    projectRootAbs,
    fileAbs,
    parentId,
    toRelId: a.toRelId,
    ensureNode: a.ensureNode,
    ensureLink: a.ensureLink,
    enqueue: a.enqueue,
    hasVisited: a.hasVisited
  };
}

function readUtf8OrNull(absPath) {
  try {
    return fs.readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
}

function applyTextRef(ctx, ref) {
  const refAbs = toAbsFromRelMaybe(ctx.projectRootAbs, ref);
  if (!refAbs) return;
  if (!isInsideRoot(ctx.projectRootAbs, refAbs)) return;

  const st = safeStat(refAbs);
  if (!st) return;

  if (st.isDirectory()) {
    linkReferencedDirectoryFromText(ctx, refAbs);
    return;
  }

  if (!st.isFile()) return;
  linkReferencedFileFromText(ctx, refAbs);
}


/**
 * Link one discovered directory from the current caller context and expand it.
 *
 * Why this exists
 * ---------------
 * AUTO REFS and secondary text-reference parsing share the same directory
 * materialization logic. This helper keeps the shared wiring in one place.
 */
function linkReferencedDirectoryFromCtx(ctx, parentId, projectRootAbs, dirAbs) {
  linkAndExpandDirectory({
    parentId,
    projectRootAbs,
    dirAbs,
    dirId: ctx.toRelId(dirAbs),
    toRelId: ctx.toRelId,
    ensureNode: ctx.ensureNode,
    ensureLink: ctx.ensureLink,
    enqueue: ctx.enqueue,
    hasVisited: ctx.hasVisited
  });
}

/**
 * Link one directory discovered while parsing a lightweight text file.
 */
function linkReferencedDirectoryFromText(ctx, dirAbs) {
  linkReferencedDirectoryFromCtx(ctx, ctx.parentId, ctx.projectRootAbs, dirAbs);
}

function linkReferencedFileFromText(ctx, fileAbs) {
  linkReferencedFileFromCtx(ctx, {
    parentId: ctx.parentId,
    projectRootAbs: ctx.projectRootAbs,
    fileAbs,
    parseTextRefs: false
  });
}


/* ========================================================================== */
/* LOW-LEVEL HELPERS                                                         */
/* ========================================================================== */

function safeStat(abs) {
  try {
    return fs.statSync(abs);
  } catch {
    return null;
  }
}

function safeReadDir(dirAbs) {
  try {
    return fs.readdirSync(dirAbs);
  } catch {
    return [];
  }
}



function toAbsFromRelMaybe(projectRootAbs, relOrAbs) {
  const raw = String(relOrAbs || "").trim();
  if (!raw) return null;
  if (path.isAbsolute(raw)) return path.normalize(raw);
  return path.resolve(projectRootAbs, raw);
}

/**
 * Classify a file into one of the allowed graph groups.
 *
 * Contract:
 * - `kind` is one of: root, dir, code, doc, data, image
 * - `type` is a stable subtype token (usually derived from extension)
 *
 * @param {string} fileAbs Absolute file path.
 * @returns {{ kind: "code"|"doc"|"data"|"image", type: string, ext: string }}
 */
function classifyFileByExt(fileAbs) {
  const ext = normalizeExt(fileAbs);

  const code = classifyBySet(ext, "code", CODE_EXTS);
  if (code) return code;

  const doc = classifyBySet(ext, "doc", DOC_EXTS);
  if (doc) return doc;

  const img = classifyBySet(ext, "image", IMAGE_EXTS);
  if (img) return img;

  // data (default bucket for allowed non-binary artifacts)
  return classifyDataFallback(ext);
}
/**
 * Ensure a file node exists and link it from a parent.
 * Optionally enqueue code files and optionally parse lightweight text files
 * for additional references.
 */
function linkReferencedFile({
  parentId,
  projectRootAbs,
  fileAbs,
  fileId,
  toRelId,
  ensureNode,
  ensureLink,
  enqueue,
  hasVisited,
  parseTextRefs
}) {
  if (!parentId) return;
  if (!fileId) return;
  if (!fileAbs) return;

  ensureFileNode(ensureNode, fileId, fileAbs);
  ensureLink(parentId, fileId, "include");

  const cls = classifyOnce(fileAbs);
  maybeEnqueueReferencedCode({ cls, fileAbs, enqueue, hasVisited });

  if (parseTextRefs) {
    maybeParseReferencedText({
      cls,
      fileAbs,
      projectRootAbs,
      parentId: fileId,
      toRelId,
      ensureNode,
      ensureLink,
      enqueue,
      hasVisited
    });
  }
}

function maybeEnqueueReferencedCode({ cls, fileAbs, enqueue, hasVisited }) {
  if (cls?.kind !== "code") return;
  if (typeof enqueue !== "function") return;
  if (typeof hasVisited === "function" && hasVisited(fileAbs)) return;
  enqueue(fileAbs);
}

function maybeParseReferencedText({
  cls,
  fileAbs,
  projectRootAbs,
  parentId,
  toRelId,
  ensureNode,
  ensureLink,
  enqueue,
  hasVisited
}) {
  // Only parse cheap, non-JS text-ish files (html/css/md/json/etc.)
  const ext = cls?.ext || normalizeExt(fileAbs);
  if (!AUTO_PARSEABLE_TEXT_EXT.has(String(ext || "").toLowerCase())) return;

  tryParseReferencedTextFile({
    projectRootAbs,
    fileAbs,
    parentId,
    toRelId,
    ensureNode,
    ensureLink,
    enqueue,
    hasVisited
  });
}
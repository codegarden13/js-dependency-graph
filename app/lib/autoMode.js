

/**
 * autoMode
 * ========
 *
 * Best-effort “structure expansion” for projects that have few/no import edges.
 *
 * Problem
 * -------
 * Many real-world apps (especially small dashboards / Express servers) do not
 * express architecture purely via JS/TS imports. They reference:
 * - static directories (express.static(publicDir))
 * - config files (config.json)
 * - CSV/JSON datasets
 * - HTML/CSS assets that reference other files
 *
 * This module adds OPTIONAL graph enrichment to make that structure visible.
 *
 * Key Behaviors
 * -------------
 * 1) Reference expansion (AUTO REFS)
 *    - If parseFile() reports file/asset references, create nodes + `include` edges.
 *    - If a referenced directory is found, add directory node and bounded child listing.
 *
 * 2) Skeleton fallback (AUTO SKELETON)
 *    - If the graph is nearly empty after traversal, add a shallow “project skeleton”
 *      for common folders + a few important top-level files.
 *
 * Safety + Performance Guardrails
 * -------------------------------
 * - Never traverse outside project root.
 * - Bounded directory expansion (depth + entry count limits).
 * - Skip known noise dirs (node_modules, .git, dist, build, etc.).
 *
 * Integration
 * -----------
 * This module is intentionally decoupled from your graph builder implementation.
 * You provide callbacks:
 * - ensureNode(node)  -> boolean
 * - ensureLink(sourceId, targetId, type) -> boolean
 * - enqueue(absPath)  -> void (optional)
 * - hasVisited(absPath) -> boolean (optional)
 *
 * The builder (e.g. buildMetricsFromEntrypoint) decides WHEN to call auto mode.
 */

import fs from "node:fs";
import path from "node:path";

import { parseFile } from "./parseFile.js";

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
  ".json", ".jsonc", ".csv", ".tsv", ".yml", ".yaml", ".env", ".env.local", ".sql",
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
 * Normalize and validate inputs once.
 * Returns a compact context object used by helpers.
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
 * Merge ref buckets; parser may expose different properties across versions.
 * We keep them as-is and resolve to absolute paths later.
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



function shouldApplySkeletonFallback(nodeCount, linkCount) {
  // Conservative trigger: only if we basically found nothing.
  return !(nodeCount > 5 || linkCount > 1);
}

function ensureRootNode(ensureNode) {
  const rootId = ".";
  ensureNode({
    id: rootId,
    file: rootId,
    kind: "root",
    type: "root",
    lines: 0,
    complexity: 0,
    headerComment: ""
  });
  return rootId;
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

function addSkeletonFilesInDir({ rootAbs, dirAbs, dirId, ensureNode, ensureLink }) {
  const entries = safeReadDir(dirAbs);

  let fileCount = 0;
  for (const name of entries) {
    if (fileCount >= AUTO_MAX_SKELETON_FILES_PER_DIR) break;
    if (!isAllowedSkeletonFile(name)) continue;

    const childAbs = path.join(dirAbs, name);
    const st = safeStat(childAbs);
    if (!st || !st.isFile()) continue;

    const childId = toProjectRelativeId(rootAbs, childAbs);

    ensureFileNode(ensureNode, childId, childAbs);
    ensureLink(dirId, childId, "include");

    fileCount++;
  }
}

function addPreferredDirsSkeleton({ rootAbs, rootId, ensureNode, ensureLink }) {
  let addedDirs = 0;

  for (const dirName of AUTO_PREFERRED_DIRS) {
    if (addedDirs >= AUTO_MAX_SKELETON_DIRS) break;
    if (!dirName || AUTO_SKIP_NAMES.has(dirName)) continue;

    const dirAbs = path.join(rootAbs, dirName);
    const st = safeStat(dirAbs);
    if (!st || !st.isDirectory()) continue;

    const dirId = toProjectRelativeId(rootAbs, dirAbs);

    ensureDirNode(ensureNode, dirId);
    ensureLink(rootId, dirId, "include");

    addSkeletonFilesInDir({ rootAbs, dirAbs, dirId, ensureNode, ensureLink });

    addedDirs++;
  }
}

function addTopLevelFilesSkeleton({ rootAbs, rootId, ensureNode, ensureLink }) {
  for (const name of AUTO_TOP_FILES) {
    if (!name) continue;

    const abs = path.join(rootAbs, name);
    const st = safeStat(abs);
    if (!st || !st.isFile()) continue;

    const id = toProjectRelativeId(rootAbs, abs);

    ensureFileNode(ensureNode, id, abs);
    ensureLink(rootId, id, "include");
  }
}

/**
 * Skeleton fallback: add a shallow, read-only “project map” when the graph
 * is nearly empty (common for single-file apps).
 *
 * @param {object} args
 * @param {string} args.projectRootAbs
 * @param {number} args.nodeCount
 * @param {number} args.linkCount
 * @param {(node:object)=>boolean} args.ensureNode
 * @param {(sourceId:string,targetId:string,type:string)=>boolean} args.ensureLink
 */
export function applySkeletonFallback({
  projectRootAbs,
  nodeCount,
  linkCount,
  ensureNode,
  ensureLink
}) {
  if (!shouldApplySkeletonFallback(nodeCount, linkCount)) return;

  const rootAbs = path.resolve(projectRootAbs);
  const rootId = ensureRootNode(ensureNode);

  addPreferredDirsSkeleton({ rootAbs, rootId, ensureNode, ensureLink });
  addTopLevelFilesSkeleton({ rootAbs, rootId, ensureNode, ensureLink });
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
export function expandDirectoryBounded(args) {
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

export function tryParseReferencedTextFile(args) {
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


function linkReferencedDirectoryFromCtx(ctx, { parentId, projectRootAbs, dirAbs }) {
  const dirId = ctx.toRelId(dirAbs);

  linkAndExpandDirectory({
    parentId,
    projectRootAbs,
    dirAbs,
    dirId,
    toRelId: ctx.toRelId,
    ensureNode: ctx.ensureNode,
    ensureLink: ctx.ensureLink,
    enqueue: ctx.enqueue,
    hasVisited: ctx.hasVisited
  });
}

function linkReferencedDirectoryFromText(ctx, dirAbs) {
  linkReferencedDirectoryFromCtx(ctx, {
    parentId: ctx.parentId,
    projectRootAbs: ctx.projectRootAbs,
    dirAbs
  });
}

function linkReferencedFileFromText(ctx, fileAbs) {
  linkReferencedFileFromCtx(ctx, {
    parentId: ctx.parentId,
    projectRootAbs: ctx.projectRootAbs,
    fileAbs,
    parseTextRefs: false
  });
}

function maybeEnqueueTextReferencedCode(ctx, cls, fileAbs) {
  if (cls.kind !== "code") return;
  if (typeof ctx.enqueue !== "function") return;

  if (typeof ctx.hasVisited === "function" && ctx.hasVisited(fileAbs)) return;
  ctx.enqueue(fileAbs);
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

function isInsideRoot(rootAbs, fileAbs) {
  const root = path.resolve(rootAbs);
  const file = path.resolve(fileAbs);
  return file === root || file.startsWith(root + path.sep);
}

function toAbsFromRelMaybe(projectRootAbs, relOrAbs) {
  const raw = String(relOrAbs || "").trim();
  if (!raw) return null;
  if (path.isAbsolute(raw)) return path.normalize(raw);
  return path.resolve(projectRootAbs, raw);
}

function isScriptFile(p) {
  const ext = String(path.extname(p || "")).toLowerCase();
  return ext === ".js" || ext === ".mjs" || ext === ".cjs" || ext === ".ts" || ext === ".tsx" || ext === ".jsx";
}

function toProjectRelativeId(projectRootAbs, absPath) {
  const rootAbs = path.resolve(projectRootAbs);
  const fileAbs = path.resolve(absPath);

  let rel = path.relative(rootAbs, fileAbs);
  if (rel.startsWith(".." + path.sep) || rel === "..") {
    rel = path.basename(fileAbs);
  }
  return rel.replace(/\\/g, "/");
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
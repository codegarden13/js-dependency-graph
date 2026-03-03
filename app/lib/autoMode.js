

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
 * Apply “auto refs” discovered by parseFile() to the graph.
 *
 * @param {object} args
 * @param {string} args.projectRootAbs Absolute path of the selected app root
 * @param {string} args.fromFileAbs    Absolute file path for the current file
 * @param {string} args.fromFileId     Project-relative node id of the current file
 * @param {object} args.parsed         parseFile() result for the current file
 * @param {(absPath:string)=>string} args.toRelId Convert abs path -> project-relative id
 * @param {(node:object)=>boolean} args.ensureNode Dedupe+add node callback
 * @param {(sourceId:string,targetId:string,type:string)=>boolean} args.ensureLink Dedupe+add link callback
 * @param {(absPath:string)=>void} [args.enqueue] Optional: enqueue script file for deeper traversal
 * @param {(absPath:string)=>boolean} [args.hasVisited] Optional: visited check (prevents re-enqueue)
 */
export function applyAutoRefs({
  projectRootAbs,
  fromFileAbs,
  fromFileId,
  parsed,
  toRelId,
  ensureNode,
  ensureLink,
  enqueue,
  hasVisited
}) {
  const rootAbs = path.resolve(projectRootAbs);

  // Merge ref buckets; parser may expose different properties across versions.
  /** @type {string[]} */
  const refs = [];
  if (Array.isArray(parsed?.fileRefsAbs)) refs.push(...parsed.fileRefsAbs);
  if (Array.isArray(parsed?.fileRefsRel)) refs.push(...parsed.fileRefsRel);
  if (Array.isArray(parsed?.assetRefsAbs)) refs.push(...parsed.assetRefsAbs);
  if (Array.isArray(parsed?.assetRefsRel)) refs.push(...parsed.assetRefsRel);

  for (const ref of refs) {
    const refAbs = toAbsFromRelMaybe(rootAbs, ref);
    if (!refAbs) continue;

    // Safety boundary: never go outside selected app.
    if (!isInsideRoot(rootAbs, refAbs)) continue;

    const st = safeStat(refAbs);
    if (!st) continue;

    // ---------------------------------------------------------------------
    // Directory references (e.g. express.static(publicDir))
    // ---------------------------------------------------------------------
    if (st.isDirectory()) {
      const dirId = toRelId(refAbs);

      ensureNode({
        id: dirId,
        file: dirId,
        kind: "dir",
        type: "dir",
        lines: 0,
        complexity: 0,
        headerComment: ""
      });

      ensureLink(fromFileId, dirId, "include");

      // Expand referenced directory in a bounded way.
      expandDirectoryBounded({
        projectRootAbs: rootAbs,
        refDirAbs: refAbs,
        refDirId: dirId,
        toRelId,
        ensureNode,
        ensureLink,
        enqueue,
        hasVisited,
        depth: 0
      });

      continue;
    }

    // ---------------------------------------------------------------------
    // File references (config.json, CSVs, assets, etc.)
    // ---------------------------------------------------------------------
    if (!st.isFile()) continue;

    const refId = toRelId(refAbs);
    const cls = classifyFileByExt(refAbs);

    ensureNode({
      id: refId,
      file: refId,
      kind: cls.kind,
      type: cls.type,
      ext: cls.ext,
      lines: 0,
      complexity: 0,
      headerComment: ""
    });

    ensureLink(fromFileId, refId, "include");

    // Optional deeper traversal for code files.
    if (cls.kind === "code" && typeof enqueue === "function") {
      if (typeof hasVisited === "function" && hasVisited(refAbs)) continue;
      enqueue(refAbs);
    }

    // Optional: parse lightweight text files to discover more refs.
    const ext = String(path.extname(refAbs)).toLowerCase();
    if (AUTO_PARSEABLE_TEXT_EXT.has(ext)) {
      tryParseReferencedTextFile({
        projectRootAbs: rootAbs,
        fileAbs: refAbs,
        parentId: refId,
        toRelId,
        ensureNode,
        ensureLink,
        enqueue,
        hasVisited
      });
    }
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
  // Conservative trigger: only if we basically found nothing.
  if (nodeCount > 5 || linkCount > 1) return;

  const rootAbs = path.resolve(projectRootAbs);
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

  // Preferred dirs.
  let addedDirs = 0;
  for (const dirName of AUTO_PREFERRED_DIRS) {
    if (addedDirs >= AUTO_MAX_SKELETON_DIRS) break;
    if (!dirName || AUTO_SKIP_NAMES.has(dirName)) continue;

    const dirAbs = path.join(rootAbs, dirName);
    const st = safeStat(dirAbs);
    if (!st || !st.isDirectory()) continue;

    const dirId = toProjectRelativeId(rootAbs, dirAbs);

    ensureNode({
      id: dirId,
      file: dirId,
      kind: "dir",
      type: "dir",
      lines: 0,
      complexity: 0,
      headerComment: ""
    });

    ensureLink(rootId, dirId, "include");

    // Shallow list files in the directory.
    const entries = safeReadDir(dirAbs);

    let fileCount = 0;
    for (const name of entries) {
      if (fileCount >= AUTO_MAX_SKELETON_FILES_PER_DIR) break;
      if (!name) continue;
      if (AUTO_SKIP_NAMES.has(name)) continue;
      if (name.startsWith(".")) continue;

      const childAbs = path.join(dirAbs, name);
      const childSt = safeStat(childAbs);
      if (!childSt || !childSt.isFile()) continue;

      const ext = String(path.extname(name)).toLowerCase();
      const isSpecialNoExt = name === "Dockerfile" || name === "Makefile" || name === "LICENSE";
      if (!isSpecialNoExt && ext && !AUTO_ASSET_EXT_ALLOW.has(ext)) continue;

      const childId = toProjectRelativeId(rootAbs, childAbs);

      ensureNode({
        id: childId,
        file: childId,
        kind: classifyFileByExt(childAbs).kind,
        type: classifyFileByExt(childAbs).type,
        ext: classifyFileByExt(childAbs).ext,
        lines: 0,
        complexity: 0,
        headerComment: ""
      });

      ensureLink(dirId, childId, "include");
      fileCount++;
    }

    addedDirs++;
  }

  // Top-level files.
  for (const name of AUTO_TOP_FILES) {
    if (!name) continue;
    const abs = path.join(rootAbs, name);
    const st = safeStat(abs);
    if (!st || !st.isFile()) continue;

    const id = toProjectRelativeId(rootAbs, abs);

    ensureNode({
      id,
      file: id,
      kind: classifyFileByExt(abs).kind,
      type: classifyFileByExt(abs).type,
      ext: classifyFileByExt(abs).ext,
      lines: 0,
      complexity: 0,
      headerComment: ""
    });

    ensureLink(rootId, id, "include");
  }
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
export function expandDirectoryBounded({
  projectRootAbs,
  refDirAbs,
  refDirId,
  toRelId,
  ensureNode,
  ensureLink,
  enqueue,
  hasVisited,
  depth
}) {
  if (depth >= AUTO_MAX_DIR_DEPTH) return;

  const entries = safeReadDir(refDirAbs);

  let count = 0;
  for (const name of entries) {
    if (count >= AUTO_MAX_DIR_ENTRIES) break;
    if (!name) continue;
    if (AUTO_SKIP_NAMES.has(name)) continue;
    if (name.startsWith(".")) continue;

    const childAbs = path.join(refDirAbs, name);
    const st = safeStat(childAbs);
    if (!st) continue;

    // ---------------------------------------------------------------------
    // Directories
    // ---------------------------------------------------------------------
    if (st.isDirectory()) {
      const childId = toRelId(childAbs);

      ensureNode({
        id: childId,
        file: childId,
        kind: "dir",
        type: "dir",
        lines: 0,
        complexity: 0,
        headerComment: ""
      });

      ensureLink(refDirId, childId, "include");

      expandDirectoryBounded({
        projectRootAbs,
        refDirAbs: childAbs,
        refDirId: childId,
        toRelId,
        ensureNode,
        ensureLink,
        enqueue,
        hasVisited,
        depth: depth + 1
      });

      count++;
      continue;
    }

    // ---------------------------------------------------------------------
    // Files
    // ---------------------------------------------------------------------
    if (!st.isFile()) continue;

    const ext = String(path.extname(name)).toLowerCase();
    const isSpecialNoExt = name === "Dockerfile" || name === "Makefile" || name === "LICENSE";

    if (!isSpecialNoExt && ext && !AUTO_ASSET_EXT_ALLOW.has(ext)) continue;

    const childId = toRelId(childAbs);

    ensureNode({
      id: childId,
      file: childId,
      kind: classifyFileByExt(childAbs).kind,
      type: classifyFileByExt(childAbs).type,
      ext: classifyFileByExt(childAbs).ext,
      lines: 0,
      complexity: 0,
      headerComment: ""
    });

    ensureLink(refDirId, childId, "include");
    count++;

    // Optional deeper traversal for code files.
    if (classifyFileByExt(childAbs).kind === "code" && typeof enqueue === "function") {
      if (typeof hasVisited === "function" && hasVisited(childAbs)) continue;
      enqueue(childAbs);
      continue;
    }

    // Parse lightweight text files to discover more references.
    if (AUTO_PARSEABLE_TEXT_EXT.has(ext)) {
      tryParseReferencedTextFile({
        projectRootAbs,
        fileAbs: childAbs,
        parentId: childId,
        toRelId,
        ensureNode,
        ensureLink,
        enqueue,
        hasVisited
      });
    }
  }
}

/**
 * Parse a referenced *non-JS* text file (html/css/md/json) to discover
 * additional referenced files/directories and add them as include edges.
 *
 * This stays cheap + deterministic:
 * - parse once
 * - does NOT attempt deep recursion by itself
 */
export function tryParseReferencedTextFile({
  projectRootAbs,
  fileAbs,
  parentId,
  toRelId,
  ensureNode,
  ensureLink,
  enqueue,
  hasVisited
}) {
  let text = "";
  try {
    text = fs.readFileSync(fileAbs, "utf8");
  } catch {
    return;
  }

  const parsed = parseFile(text, fileAbs);

  /** @type {string[]} */
  const refs = [];
  if (Array.isArray(parsed?.fileRefsAbs)) refs.push(...parsed.fileRefsAbs);
  if (Array.isArray(parsed?.fileRefsRel)) refs.push(...parsed.fileRefsRel);
  if (Array.isArray(parsed?.assetRefsAbs)) refs.push(...parsed.assetRefsAbs);
  if (Array.isArray(parsed?.assetRefsRel)) refs.push(...parsed.assetRefsRel);

  for (const ref of refs) {
    const refAbs = toAbsFromRelMaybe(projectRootAbs, ref);
    if (!refAbs) continue;
    if (!isInsideRoot(projectRootAbs, refAbs)) continue;

    const st = safeStat(refAbs);
    if (!st) continue;

    if (st.isDirectory()) {
      const dirId = toRelId(refAbs);

      ensureNode({
        id: dirId,
        file: dirId,
        kind: "dir",
        type: "dir",
        lines: 0,
        complexity: 0,
        headerComment: ""
      });

      ensureLink(parentId, dirId, "include");

      // One bounded expansion to make the directory visible.
      expandDirectoryBounded({
        projectRootAbs,
        refDirAbs: refAbs,
        refDirId: dirId,
        toRelId,
        ensureNode,
        ensureLink,
        enqueue,
        hasVisited,
        depth: 0
      });

      continue;
    }

    if (!st.isFile()) continue;

    const refId = toRelId(refAbs);

    ensureNode({
      id: refId,
      file: refId,
      kind: classifyFileByExt(refAbs).kind,
      type: classifyFileByExt(refAbs).type,
      ext: classifyFileByExt(refAbs).ext,
      lines: 0,
      complexity: 0,
      headerComment: ""
    });

    ensureLink(parentId, refId, "include");

    if (classifyFileByExt(refAbs).kind === "code" && typeof enqueue === "function") {
      if (typeof hasVisited === "function" && hasVisited(refAbs)) continue;
      enqueue(refAbs);
    }
  }
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
  const ext = String(path.extname(fileAbs || "")).toLowerCase();

  // code
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs" || ext === ".ts" || ext === ".tsx" || ext === ".jsx") {
    return { kind: "code", type: ext.replace(/^\./, ""), ext };
  }

  // docs
  if (ext === ".md" || ext === ".txt" || ext === ".html" || ext === ".htm" || ext === ".css") {
    return { kind: "doc", type: ext.replace(/^\./, ""), ext };
  }

  // images
  if (ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".gif" || ext === ".svg" || ext === ".webp" || ext === ".ico") {
    return { kind: "image", type: ext.replace(/^\./, ""), ext };
  }

  // data (default bucket for allowed non-binary artifacts)
  return { kind: "data", type: ext ? ext.replace(/^\./, "") : "data", ext };
}
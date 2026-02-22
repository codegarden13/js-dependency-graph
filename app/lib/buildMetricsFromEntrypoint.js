/**
 * buildMetricsFromEntrypoint
 * ==========================
 *
 * Deterministic, entrypoint-driven dependency graph builder for Node-style projects.
 *
 * -----------------------------------------------------------------------------
 * ARCHITECTURAL ROLE
 * -----------------------------------------------------------------------------
 * Constructs a static file-level dependency graph starting from a single
 * entrypoint file.
 *
 * Performs a breadth-first traversal (BFS) across resolvable internal imports
 * and emits a D3-compatible metrics payload.
 *
 * -----------------------------------------------------------------------------
 * DESIGN PRINCIPLES
 * -----------------------------------------------------------------------------
 * • Deterministic traversal (BFS)
 * • No runtime execution or evaluation
 * • Only local/relative imports are resolved
 * • Resilient parsing via parseFile()
 * • Side-effect free (pure metrics builder)
 *
 * -----------------------------------------------------------------------------
 * OUTPUT CONTRACT
 * -----------------------------------------------------------------------------
 * {
 *   meta: {
 *     entry: string,
 *     urlInfo: any
 *   },
 *   nodes: Array<{
 *     id: string,
 *     file: string,
 *     lines: number,
 *     complexity: number,
 *     headerComment: string
 *   }>,
 *   links: Array<{
 *     source: string,
 *     target: string,
 *     type: "use" | "include"
 *   }>
 * }
 */

import fs from "node:fs";
import path from "node:path";

import { parseFile } from "./parseFile.js";
import { resolveImports } from "./resolveImports.js";

/* ========================================================================== */
/* AUTO MODE CONFIGURATION                                                    */
/* ========================================================================== */

// Auto-mode is designed to improve results for apps with few/no import edges
// (e.g. single-file Express servers). These guardrails prevent accidental
// massive walks on large projects.

// Directory listing limits (shallow expansion).
const MAX_DIR_ENTRIES = 140;               // max direct children per referenced directory
const MAX_DIR_DEPTH = 2;                   // how deep to expand referenced directories

// Skeleton fallback limits (only used if graph is nearly empty).
const MAX_SKELETON_DIRS = 16;              // number of top-level dirs to include
const MAX_SKELETON_FILES_PER_DIR = 100;    // max files per skeleton directory

// Ignore noise / OS + build artifacts.
const SKIP_NAMES = new Set([
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
// NOTE: Keep this conservative — the goal is to show *structure*, not every file.
const ASSET_EXT_ALLOW = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
  ".json", ".jsonc",
  ".csv", ".tsv",
  ".md", ".txt",
  ".html", ".htm", ".css",
  ".yml", ".yaml",
  ".env", ".env.local",
  ".sql",
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico"
]);

// File types we can cheaply parse for additional references (non-JS).
const PARSEABLE_TEXT_EXT = new Set([
  ".json", ".jsonc", ".md", ".txt", ".html", ".htm", ".css"
]);

/**
 * Build a file dependency graph starting at the given entrypoint.
 *
 * @param {object} args
 * @param {string} args.projectRoot Absolute path to the project root directory
 * @param {string} args.entryAbs    Absolute path to the entrypoint file
 * @param {any}    args.urlInfo     Optional metadata about a running app URL
 *
 * @returns {Promise<{meta: object, nodes: object[], links: object[]}>}
 */
export async function buildMetricsFromEntrypoint({ projectRoot, entryAbs, urlInfo }) {
  /* ------------------------------------------------------------------------- */
  /* 1) INITIALIZATION                                                          */
  /* ------------------------------------------------------------------------- */

  const visited = new Set();
  const nodes = [];
  const links = [];
  const queue = [entryAbs];

  const toRelId = (absPath) => toProjectRelativeId(projectRoot, absPath);

  // Fast lookup tables to avoid O(n) scans on every discovery.
  // - nodeIndex: nodeId -> node object
  // - linkIndex: "source|type|target" -> true
  const nodeIndex = new Map();
  const linkIndex = new Set();


  /* ------------------------------------------------------------------------- */
  /* 2) BREADTH-FIRST DEPENDENCY TRAVERSAL                                     */
  /* ------------------------------------------------------------------------- */

  while (queue.length > 0) {
    const abs = queue.shift();
    if (!abs) continue;

    if (visited.has(abs)) continue;
    visited.add(abs);

    const code = readUtf8(abs);
    const parsed = parseFile(code, abs);

    const nodeId = toRelId(abs);

    /* --------------------------------------------------------------------- */
    /* 2.1) Emit File-Level Node                                              */
    /* --------------------------------------------------------------------- */

    // Ensure the current file is represented as a node.
    ensureNode(nodeIndex, nodes, {
      id: nodeId,
      file: nodeId,
      lines: parsed.lines,
      complexity: parsed.complexity,
      headerComment: parsed.headerComment || ""
    });

    /* --------------------------------------------------------------------- */
    /* 2.1b) AUTO MODE: Discover referenced project files                      */
    /* --------------------------------------------------------------------- */

    // Auto mode is intentionally "best effort":
    // - If parseFile() provides `fileRefsAbs` / `fileRefsRel`, we create nodes + "include" edges.
    // - For script-like files, we optionally enqueue them for deeper traversal.
    // - If the parser does not provide refs, this section is a no-op.

    const projectRootAbs = path.resolve(projectRoot);

    /** @type {string[]} */
    const discoveredRefs = [];

    // parseFile() may provide different buckets of references.
    // We merge them so the renderer can show more than just import edges.
    if (Array.isArray(parsed.fileRefsAbs)) discoveredRefs.push(...parsed.fileRefsAbs);
    if (Array.isArray(parsed.fileRefsRel)) discoveredRefs.push(...parsed.fileRefsRel);
    if (Array.isArray(parsed.assetRefsAbs)) discoveredRefs.push(...parsed.assetRefsAbs);
    if (Array.isArray(parsed.assetRefsRel)) discoveredRefs.push(...parsed.assetRefsRel);

    for (const ref of discoveredRefs) {
      const refAbs = toAbsFromRelMaybe(projectRootAbs, ref);
      if (!refAbs) continue;

      // Safety boundary: never allow traversal outside the selected app root.
      if (!isInsideRoot(projectRootAbs, refAbs)) continue;
      if (!fs.existsSync(refAbs)) continue;

      const st = safeStat(refAbs);
      if (!st) continue;

      // -------------------------------------------------------------------
      // 1) Directory references (e.g. express.static(publicDir))
      // -------------------------------------------------------------------
      if (st.isDirectory()) {
        const dirId = toProjectRelativeId(projectRootAbs, refAbs);

        ensureNode(nodeIndex, nodes, {
          id: dirId,
          file: dirId,
          lines: 0,
          complexity: 0,
          headerComment: "",
          kind: "dir"
        });

        // Current file includes the directory.
        ensureLink(linkIndex, links, nodeId, dirId, "include");

        // Expand referenced directory in a shallow, bounded way.
        // This turns `express.static(publicDir)` into visible structure.
        expandDirectoryBounded({
          projectRootAbs,
          refDirAbs: refAbs,
          refDirId: dirId,
          nodeIndex,
          nodes,
          linkIndex,
          links,
          visited,
          queue,
          depth: 0
        });

        continue;
      }

      // -------------------------------------------------------------------
      // 2) File references (config.json, CSVs, etc.)
      // -------------------------------------------------------------------
      if (!st.isFile()) continue;

      const refId = toProjectRelativeId(projectRootAbs, refAbs);

      ensureNode(nodeIndex, nodes, {
        id: refId,
        file: refId,
        lines: 0,
        complexity: 0,
        headerComment: "",
        kind: isScriptFile(refAbs) ? "file" : "asset"
      });

      ensureLink(linkIndex, links, nodeId, refId, "include");

      // If this looks like a script file, enqueue it for deeper traversal.
      if (isScriptFile(refAbs) && !visited.has(refAbs)) {
        queue.push(refAbs);
      }
    }

    /* --------------------------------------------------------------------- */
    /* 2.2) Emit Dependency Edges                                             */
    /* --------------------------------------------------------------------- */

    for (const spec of parsed.imports) {
      const resolvedAbs = resolveImports(abs, spec, projectRoot);
      if (!resolvedAbs) continue;

      const targetId = toRelId(resolvedAbs);

      ensureLink(linkIndex, links, nodeId, targetId, "use");

      if (!visited.has(resolvedAbs)) {
        queue.push(resolvedAbs);
      }
    }
  }

  /* ----------------------------------------------------------------------- */
  /* 3.1) AUTO MODE FALLBACK: PROJECT SKELETON                                */
  /* ----------------------------------------------------------------------- */

  // If we discovered almost nothing via imports/refs (common for single-file
  // Express apps), add a shallow, read-only "skeleton" view of common folders.
  // This keeps the UI useful without doing an expensive full walk.
  if (nodes.length <= 5 && links.length <= 1) {
    discoverProjectSkeleton({
      projectRootAbs: path.resolve(projectRoot),
      nodeIndex,
      nodes,
      linkIndex,
      links
    });
  }

  /* ------------------------------------------------------------------------- */
  /* 3) RETURN METRICS PAYLOAD                                                 */
  /* ------------------------------------------------------------------------- */

  return {
    meta: {
      entry: toRelId(entryAbs),
      urlInfo
    },
    nodes,
    links
  };
}

/* ========================================================================== */
/* INTERNAL HELPERS                                                           */
/* ========================================================================== */

function toProjectRelativeId(projectRoot, absPath) {
  const rootAbs = path.resolve(projectRoot);
  const fileAbs = path.resolve(absPath);

  // Use path.relative for correctness across platforms and normalization.
  let rel = path.relative(rootAbs, fileAbs);

  // If `absPath` is outside root, keep the basename as a last resort (should
  // be prevented by boundary checks elsewhere).
  if (rel.startsWith(".." + path.sep) || rel === "..") {
    rel = path.basename(fileAbs);
  }

  return rel.replace(/\\/g, "/");
}

function readUtf8(absPath) {
  return fs.readFileSync(absPath, "utf8");
}


/* ========================================================================== */
/* AUTO MODE HELPERS                                                          */
/* ========================================================================== */

function isInsideRoot(rootAbs, fileAbs) {
  const root = path.resolve(rootAbs);
  const file = path.resolve(fileAbs);
  return file === root || file.startsWith(root + path.sep);
}

function toAbsFromRelMaybe(projectRootAbs, relOrAbs) {
  const raw = String(relOrAbs || "").trim();
  if (!raw) return null;

  // If the parser already produced an absolute path, keep it.
  if (path.isAbsolute(raw)) return path.normalize(raw);

  // Otherwise interpret as project-root relative.
  return path.resolve(projectRootAbs, raw);
}

function isScriptFile(p) {
  const ext = String(path.extname(p || "")).toLowerCase();
  return ext === ".js" || ext === ".mjs" || ext === ".cjs" || ext === ".ts" || ext === ".tsx" || ext === ".jsx";
}

/**
 * Safe stat helper (returns null on errors).
 * @param {string} abs
 */
function safeStat(abs) {
  try {
    return fs.statSync(abs);
  } catch {
    return null;
  }
}

/**
 * Ensure a node exists; dedupes via nodeIndex.
 *
 * @param {Map<string, any>} nodeIndex
 * @param {any[]} nodes
 * @param {any} node
 * @returns {boolean} true if added
 */
function ensureNode(nodeIndex, nodes, node) {
  const id = String(node?.id || "").trim();
  if (!id) return false;

  if (nodeIndex.has(id)) {
    // Merge: if we already created a lightweight asset node and later
    // we parse it as a real JS file, keep the richer metrics.
    const existing = nodeIndex.get(id);
    if (existing && node) {
      if ((existing.lines || 0) === 0 && (node.lines || 0) > 0) existing.lines = node.lines;
      if ((existing.complexity || 0) === 0 && (node.complexity || 0) > 0) existing.complexity = node.complexity;
      if (!existing.headerComment && node.headerComment) existing.headerComment = node.headerComment;
      if (!existing.kind && node.kind) existing.kind = node.kind;
      if (!existing.file && node.file) existing.file = node.file;
    }
    return false;
  }

  const normalized = {
    id,
    file: String(node?.file || id),
    lines: Number(node?.lines || 0),
    complexity: Number(node?.complexity || 0),
    headerComment: String(node?.headerComment || ""),
    ...(node?.kind ? { kind: String(node.kind) } : null)
  };

  nodes.push(normalized);
  nodeIndex.set(id, normalized);
  return true;
}

/**
 * Ensure a link exists; dedupes via linkIndex.
 *
 * @param {Set<string>} linkIndex
 * @param {any[]} links
 * @param {string} sourceId
 * @param {string} targetId
 * @param {string} type
 * @returns {boolean} true if added
 */
function ensureLink(linkIndex, links, sourceId, targetId, type) {
  const s = String(sourceId || "");
  const t = String(targetId || "");
  const ty = String(type || "use");
  if (!s || !t) return false;

  const key = `${s}|${ty}|${t}`;
  if (linkIndex.has(key)) return false;

  links.push({ source: s, target: t, type: ty });
  linkIndex.add(key);
  return true;
}
/**
 * Discover a shallow "project skeleton" (common folders + a few files).
 * This is a fallback for projects that have little/no import structure.
 */
function discoverProjectSkeleton({ projectRootAbs, nodeIndex, nodes, linkIndex, links }) {
  const rootId = ".";

  // Ensure a visible root node.
  ensureNode(nodeIndex, nodes, {
    id: rootId,
    file: rootId,
    lines: 0,
    complexity: 0,
    headerComment: "",
    kind: "root"
  });

  // Common directories that often encode architecture.
  const preferredDirs = [
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

  let addedDirs = 0;
  for (const dirName of preferredDirs) {
    if (addedDirs >= MAX_SKELETON_DIRS) break;
    if (!dirName || SKIP_NAMES.has(dirName)) continue;

    const dirAbs = path.join(projectRootAbs, dirName);
    const st = safeStat(dirAbs);
    if (!st || !st.isDirectory()) continue;

    const dirId = toProjectRelativeId(projectRootAbs, dirAbs);

    ensureNode(nodeIndex, nodes, {
      id: dirId,
      file: dirId,
      lines: 0,
      complexity: 0,
      headerComment: "",
      kind: "dir"
    });

    ensureLink(linkIndex, links, rootId, dirId, "include");

    // Shallow list files in the directory.
    let entries = [];
    try {
      entries = fs.readdirSync(dirAbs);
    } catch {
      entries = [];
    }

    let fileCount = 0;
    for (const name of entries) {
      if (fileCount >= MAX_SKELETON_FILES_PER_DIR) break;
      if (!name) continue;
      if (SKIP_NAMES.has(name)) continue;
      if (name.startsWith(".")) continue;

      const childAbs = path.join(dirAbs, name);
      const childSt = safeStat(childAbs);
      if (!childSt || !childSt.isFile()) continue;

      const ext = String(path.extname(name)).toLowerCase();
      const isSpecialNoExt = name === "Dockerfile" || name === "Makefile" || name === "LICENSE";
      if (!isSpecialNoExt && ext && !ASSET_EXT_ALLOW.has(ext)) continue;

      const childId = toProjectRelativeId(projectRootAbs, childAbs);

      ensureNode(nodeIndex, nodes, {
        id: childId,
        file: childId,
        lines: 0,
        complexity: 0,
        headerComment: "",
        kind: isScriptFile(childAbs) ? "file" : "asset"
      });

      ensureLink(linkIndex, links, dirId, childId, "include");
      fileCount++;
    }

    addedDirs++;
  }

  // Also include a few top-level important files if present.
  const topFiles = [
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "README.md",
    "readme.md",
    "config.json",
    ".env"
  ];

  for (const name of topFiles) {
    if (!name) continue;
    const abs = path.join(projectRootAbs, name);
    const st = safeStat(abs);
    if (!st || !st.isFile()) continue;

    const id = toProjectRelativeId(projectRootAbs, abs);

    ensureNode(nodeIndex, nodes, {
      id,
      file: id,
      lines: 0,
      complexity: 0,
      headerComment: "",
      kind: "asset"
    });

    ensureLink(linkIndex, links, rootId, id, "include");
  }
}

/**
 * Expand a referenced directory into a bounded subgraph.
 *
 * - Adds nodes for child directories and useful files
 * - Adds include edges: refDir -> child
 * - Recurses into subdirectories up to MAX_DIR_DEPTH
 * - Enqueues script files for deeper import traversal
 * - For parseable text files (html/css/md/json), parses them to discover more refs
 */
function expandDirectoryBounded({
  projectRootAbs,
  refDirAbs,
  refDirId,
  nodeIndex,
  nodes,
  linkIndex,
  links,
  visited,
  queue,
  depth
}) {
  if (depth >= MAX_DIR_DEPTH) return;

  let entries = [];
  try {
    entries = fs.readdirSync(refDirAbs);
  } catch {
    entries = [];
  }

  let count = 0;
  for (const name of entries) {
    if (count >= MAX_DIR_ENTRIES) break;
    if (!name) continue;
    if (SKIP_NAMES.has(name)) continue;
    if (name.startsWith(".")) continue;

    const childAbs = path.join(refDirAbs, name);
    const childSt = safeStat(childAbs);
    if (!childSt) continue;

    // ---------------------------------------------------------------------
    // Directories
    // ---------------------------------------------------------------------
    if (childSt.isDirectory()) {
      const childId = toProjectRelativeId(projectRootAbs, childAbs);

      ensureNode(nodeIndex, nodes, {
        id: childId,
        file: childId,
        lines: 0,
        complexity: 0,
        headerComment: "",
        kind: "dir"
      });

      ensureLink(linkIndex, links, refDirId, childId, "include");

      // Recurse shallowly.
      expandDirectoryBounded({
        projectRootAbs,
        refDirAbs: childAbs,
        refDirId: childId,
        nodeIndex,
        nodes,
        linkIndex,
        links,
        visited,
        queue,
        depth: depth + 1
      });

      count++;
      continue;
    }

    // ---------------------------------------------------------------------
    // Files
    // ---------------------------------------------------------------------
    if (!childSt.isFile()) continue;

    const ext = String(path.extname(name)).toLowerCase();
    const isSpecialNoExt = name === "Dockerfile" || name === "Makefile" || name === "LICENSE";

    // Keep files conservative and readable.
    if (!isSpecialNoExt && ext && !ASSET_EXT_ALLOW.has(ext)) continue;

    const childId = toProjectRelativeId(projectRootAbs, childAbs);

    ensureNode(nodeIndex, nodes, {
      id: childId,
      file: childId,
      lines: 0,
      complexity: 0,
      headerComment: "",
      kind: isScriptFile(childAbs) ? "file" : "asset"
    });

    ensureLink(linkIndex, links, refDirId, childId, "include");
    count++;

    // Enqueue scripts for deeper traversal.
    if (isScriptFile(childAbs) && !visited.has(childAbs)) {
      queue.push(childAbs);
      continue;
    }

    // Parse lightweight text files to discover more references.
    if (PARSEABLE_TEXT_EXT.has(ext)) {
      tryParseReferencedTextFile({
        projectRootAbs,
        fileAbs: childAbs,
        parentId: childId,
        nodeIndex,
        nodes,
        linkIndex,
        links,
        visited,
        queue
      });
    }
  }
}

/**
 * Parse a referenced *non-JS* text file (html/css/md/json) to discover additional
 * referenced files/directories and add them as include edges.
 */
function tryParseReferencedTextFile({
  projectRootAbs,
  fileAbs,
  parentId,
  nodeIndex,
  nodes,
  linkIndex,
  links,
  visited,
  queue
}) {
  // Keep deterministic + cheap: parse once, do not recurse aggressively.
  let text = "";
  try {
    text = fs.readFileSync(fileAbs, "utf8");
  } catch {
    return;
  }

  const parsed = parseFile(text, fileAbs);

  const discoveredRefs = [];
  if (Array.isArray(parsed.fileRefsAbs)) discoveredRefs.push(...parsed.fileRefsAbs);
  if (Array.isArray(parsed.fileRefsRel)) discoveredRefs.push(...parsed.fileRefsRel);
  if (Array.isArray(parsed.assetRefsAbs)) discoveredRefs.push(...parsed.assetRefsAbs);
  if (Array.isArray(parsed.assetRefsRel)) discoveredRefs.push(...parsed.assetRefsRel);

  for (const ref of discoveredRefs) {
    const refAbs = toAbsFromRelMaybe(projectRootAbs, ref);
    if (!refAbs) continue;
    if (!isInsideRoot(projectRootAbs, refAbs)) continue;
    if (!fs.existsSync(refAbs)) continue;

    const st = safeStat(refAbs);
    if (!st) continue;

    if (st.isDirectory()) {
      const dirId = toProjectRelativeId(projectRootAbs, refAbs);

      ensureNode(nodeIndex, nodes, {
        id: dirId,
        file: dirId,
        lines: 0,
        complexity: 0,
        headerComment: "",
        kind: "dir"
      });

      ensureLink(linkIndex, links, parentId, dirId, "include");

      // One bounded expansion to make the directory visible.
      expandDirectoryBounded({
        projectRootAbs,
        refDirAbs: refAbs,
        refDirId: dirId,
        nodeIndex,
        nodes,
        linkIndex,
        links,
        visited,
        queue,
        depth: 0
      });

      continue;
    }

    if (!st.isFile()) continue;

    const refId = toProjectRelativeId(projectRootAbs, refAbs);

    ensureNode(nodeIndex, nodes, {
      id: refId,
      file: refId,
      lines: 0,
      complexity: 0,
      headerComment: "",
      kind: isScriptFile(refAbs) ? "file" : "asset"
    });

    ensureLink(linkIndex, links, parentId, refId, "include");

    if (isScriptFile(refAbs) && !visited.has(refAbs)) {
      queue.push(refAbs);
    }
  }
}
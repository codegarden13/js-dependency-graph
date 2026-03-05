import fs from "node:fs";
import path from "node:path";

/**
 * scanProjectTree
 * ==============
 *
 * Purpose
 * -------
 * Deterministically walks a project directory tree up to a bounded depth and
 * reports directories/files via callbacks.
 *
 * This is the "structure" phase of NodeAnalyzer:
 * - emits nodes for dirs/files
 * - allows callers to create include/containment edges
 * - can be used to enqueue parseable files (caller decides)
 *
 * Safety / Guardrails
 * -------------------
 * - hard maxDepth (root=0)
 * - hard maxEntriesPerDir cap
 * - ignores common noise + huge dirs
 * - avoids symlink loops via realpath tracking
 *
 * Depth semantics
 * --------------
 * - depth=0: the root itself
 * - children of root are depth=1
 * - traversal stops when current depth >= maxDepth
 */

// Basenames to skip by default (applies to BOTH directories and files).
// The intent is to remove noise and avoid huge traversals.
const DEFAULT_IGNORE_NAMES = new Set([
  // Version control / tooling / build output
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".cache",
  "dist",
  "build",
  "out",
  "coverage",
  ".turbo",
  ".vite",
  ".parcel-cache",

  // OS noise
  ".DS_Store",
  "Thumbs.db",
  "__MACOSX"
]);

/**
 * Convert an absolute path to a stable project-relative id.
 * - Uses POSIX separators in ids, regardless of OS.
 * - Never returns a leading "./".
 *
 * @param {string} projectRootAbs
 * @param {string} abs
 * @returns {string}
 */
function defaultToId(projectRootAbs, abs) {
  const rel = path.relative(projectRootAbs, abs);
  return rel.split(path.sep).join("/").replace(/^\.\//, "");
}

/**
 * Guard against odd/broken Dirent entries.
 * @param {fs.Dirent} d
 * @returns {boolean}
 */
function isReadableDirent(d) {
  // Skip broken/odd entries defensively
  return d && typeof d.name === "string" && d.name.length > 0;
}

function requireProjectRootAbs(opts) {
  const projectRootAbs = String(opts?.projectRootAbs || "");
  if (!projectRootAbs) throw new Error("scanProjectTree: projectRootAbs is required");
  return projectRootAbs;
}

function logScanStart(projectRootAbs, opts) {
  // Keep this as a separate helper so scanProjectTree stays focused.
  console.log("────────────────────────────────────────────");
  console.log("NodeAnalyzer: scanProjectTree START");
  console.log("Root:", projectRootAbs);
  console.log("MaxDepth:", opts?.maxDepth ?? 2);
  console.log("MaxEntriesPerDir:", opts?.maxEntriesPerDir ?? 500);
  console.log("────────────────────────────────────────────");
}

function asPlainObject(x) {
  return x && typeof x === "object" ? x : Object.create(null);
}

function finiteNumberOr(value, fallback) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function pickFn(obj, key) {
  const fn = obj && typeof obj[key] === "function" ? obj[key] : null;
  return fn;
}

function normalizeIgnoreSet(ignoreDirs) {
  if (!ignoreDirs) return DEFAULT_IGNORE_NAMES;
  if (ignoreDirs instanceof Set) return ignoreDirs;
  return new Set(ignoreDirs);
}

function normalizeScanOptions(opts, projectRootAbs) {
  const o = asPlainObject(opts);

  const maxDepth = finiteNumberOr(o.maxDepth, 2);
  const maxEntriesPerDir = finiteNumberOr(o.maxEntriesPerDir, 500);

  const ignoreSet = normalizeIgnoreSet(o.ignoreDirs);

  const toId = pickFn(o, "toId") || defaultToId;
  const shouldIncludePath = pickFn(o, "shouldIncludePath");
  const onDir = pickFn(o, "onDir");
  const onFile = pickFn(o, "onFile");

  return {
    projectRootAbs,
    maxDepth,
    maxEntriesPerDir,
    ignoreSet,
    toId,
    shouldIncludePath,
    onDir,
    onFile
  };
}

function makeShouldSkipName(ignoreSet) {
  /**
   * Decide whether a directory entry name should be skipped.
   * - Skips explicit ignore names (caller-provided + defaults)
   * - Skips hidden dotfiles/dotdirs by default (e.g. `.DS_Store`)
   *
   * Note: Callers can still include hidden paths via `shouldIncludePath` by
   * providing a custom implementation that returns true.
   */
  return function shouldSkipName(name) {
    const n = String(name || "");
    if (!n) return true;
    if (ignoreSet && ignoreSet.has(n)) return true;
    if (n.startsWith(".")) return true;
    return false;
  };
}

/**
 * @typedef {Object} ScanOptions
 * @property {string} projectRootAbs Absolute path of the project root.
 * @property {number} [maxDepth=2] Max directory depth to traverse (root=0).
 * @property {number} [maxEntriesPerDir=500] Hard cap for entries per directory.
 * @property {Set<string>|string[]} [ignoreDirs] Basenames to skip (applies to BOTH dirs and files).
 * @property {(absPath: string) => boolean} [shouldIncludePath] Optional filter; if returns false, skip.
 * @property {(projectRootAbs: string, absPath: string) => string} [toId] Optional id mapping function.
 * @property {(dir: {abs: string, id: string, depth: number}, parent: {abs: string, id: string, depth: number} | null) => void} [onDir]
 * @property {(file: {abs: string, id: string, depth: number, ext: string}, parent: {abs: string, id: string, depth: number}) => void} [onFile]
 */

/**
 * Scan the project tree and invoke callbacks.
 * @param {ScanOptions} opts
 */
export function scanProjectTree(opts) {
  const projectRootAbs = requireProjectRootAbs(opts);
  logScanStart(projectRootAbs, opts);

  const cfg = normalizeScanOptions(opts, projectRootAbs);

  const maxDepth = cfg.maxDepth;
  const maxEntriesPerDir = cfg.maxEntriesPerDir;
  const toId = cfg.toId;
  const shouldIncludePath = cfg.shouldIncludePath;
  const onDir = cfg.onDir;
  const onFile = cfg.onFile;

  const shouldSkipName = makeShouldSkipName(cfg.ignoreSet);

  /** @type {Set<string>} */
  const visitedDirs = new Set();

  function walkDir(absDir, parentMeta, depth) {
    if (!shouldProcessDir(absDir)) return;

    const dirMeta = buildDirMeta(absDir, depth);
    if (onDir) onDir(dirMeta, parentMeta);

    if (!canDescend(depth)) return;

    const entries = readDirEntriesSorted(absDir);
    if (!entries.length) return;

    forEachCapped(entries, maxEntriesPerDir, (ent) => {
      processDirent(ent, absDir, dirMeta, depth);
    });
  }

  function shouldProcessDir(absDir) {
    const base = path.basename(absDir);
    if (shouldSkipName(base)) return false;

    // Prevent infinite recursion via symlink cycles by tracking real paths.
    const real = safeRealpath(absDir);
    if (!real) return true;

    if (visitedDirs.has(real)) return false;
    visitedDirs.add(real);
    return true;
  }

  function buildDirMeta(absDir, depth) {
    return { abs: absDir, id: toId(projectRootAbs, absDir), depth };
  }

  function canDescend(depth) {
    return depth < maxDepth;
  }

  function readDirEntriesSorted(absDir) {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return [];
    }

    // Deterministic ordering + defensive filtering
    return entries
      .filter(isReadableDirent)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function forEachCapped(items, limit, fn) {
    let count = 0;
    for (const it of items) {
      if (count >= limit) break;
      count++;
      fn(it);
    }
  }

  function processDirent(ent, absDir, dirMeta, depth) {
    if (shouldSkipName(ent.name)) return;

    const childAbs = path.join(absDir, ent.name);
    if (shouldIncludePath && !shouldIncludePath(childAbs)) return;

    if (ent.isDirectory()) {
      walkDir(childAbs, dirMeta, depth + 1);
      return;
    }

    if (ent.isFile()) {
      emitFileIfEnabled(childAbs, ent.name, dirMeta, depth + 1);
      return;
    }

    if (ent.isSymbolicLink()) {
      processSymlink(childAbs, ent.name, dirMeta, depth + 1);
    }
  }

  function emitFileIfEnabled(childAbs, name, dirMeta, depth) {
    if (!onFile) return;
    const fileMeta = buildFileMeta(childAbs, name, depth);
    onFile(fileMeta, dirMeta);
  }

  function buildFileMeta(childAbs, name, depth) {
    const ext = path.extname(name).toLowerCase();
    return { abs: childAbs, id: toId(projectRootAbs, childAbs), depth, ext };
  }

  // If symlink, try to follow if it points to a dir/file, but stay safe.
  function processSymlink(childAbs, name, dirMeta, depth) {
    const st = safeStat(childAbs);
    if (!st) return;

    if (st.isDirectory()) {
      walkDir(childAbs, dirMeta, depth);
      return;
    }

    if (st.isFile()) {
      emitFileIfEnabled(childAbs, name, dirMeta, depth);
    }
  }

  // Start traversal at root depth 0.
  walkDir(projectRootAbs, null, 0);
}

/**
 * Safe stat helper.
 * @param {string} p
 * @returns {import('node:fs').Stats|null}
 */
function safeStat(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

/**
 * Safe realpath helper (used for symlink loop detection).
 * @param {string} p
 * @returns {string|null}
 */
function safeRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}
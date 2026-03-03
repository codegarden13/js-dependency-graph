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
  const projectRootAbs = String(opts?.projectRootAbs || "");
  if (!projectRootAbs) {
    throw new Error("scanProjectTree: projectRootAbs is required");
  }


  console.log("────────────────────────────────────────────");
  console.log("NodeAnalyzer: scanProjectTree START");
  console.log("Root:", projectRootAbs);
  console.log("MaxDepth:", opts?.maxDepth ?? 2);
  console.log("MaxEntriesPerDir:", opts?.maxEntriesPerDir ?? 500);
  console.log("────────────────────────────────────────────");


  const maxDepth = Number.isFinite(opts?.maxDepth) ? Number(opts.maxDepth) : 2;
  const maxEntriesPerDir = Number.isFinite(opts?.maxEntriesPerDir)
    ? Number(opts.maxEntriesPerDir)
    : 500;

  const ignoreSet = opts?.ignoreDirs
    ? (opts.ignoreDirs instanceof Set ? opts.ignoreDirs : new Set(opts.ignoreDirs))
    : DEFAULT_IGNORE_NAMES;

  const toId = typeof opts?.toId === "function" ? opts.toId : defaultToId;
  const shouldIncludePath =
    typeof opts?.shouldIncludePath === "function" ? opts.shouldIncludePath : null;

  const onDir = typeof opts?.onDir === "function" ? opts.onDir : null;
  const onFile = typeof opts?.onFile === "function" ? opts.onFile : null;

  /** @type {Set<string>} */
  const visitedDirs = new Set();

  /**
   * Decide whether a directory entry name should be skipped.
   * - Skips explicit ignore names (caller-provided + defaults)
   * - Skips hidden dotfiles/dotdirs by default (e.g. `.DS_Store`)
   *
   * Note: Callers can still include hidden paths via `shouldIncludePath` by
   * providing a custom implementation that returns true. This helper is the
   * baseline policy.
   *
   * @param {string} name
   * @returns {boolean}
   */
  function shouldSkipName(name) {
    const n = String(name || "");
    if (!n) return true;
    if (ignoreSet && ignoreSet.has(n)) return true;
    if (n.startsWith(".")) return true;
    return false;
  }

  function walkDir(absDir, parentMeta, depth) {
    const base = path.basename(absDir);
    if (shouldSkipName(base)) return;

    // Prevent infinite recursion via symlink cycles by tracking real paths.
    const real = safeRealpath(absDir);
    if (real && visitedDirs.has(real)) return;
    if (real) visitedDirs.add(real);

    const dirMeta = { abs: absDir, id: toId(projectRootAbs, absDir), depth };
    if (onDir) onDir(dirMeta, parentMeta);

    if (depth >= maxDepth) return;

    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    // deterministic ordering
    entries = entries.filter(d => d && typeof d.name === "string" && d.name.length > 0).sort((a, b) => a.name.localeCompare(b.name));






    let count = 0;
    for (const ent of entries) {
      if (count >= maxEntriesPerDir) break;
      count++;

      if (shouldSkipName(ent.name)) continue;

      const childAbs = path.join(absDir, ent.name);
      if (shouldIncludePath && !shouldIncludePath(childAbs)) continue;

      if (ent.isDirectory()) {
        walkDir(childAbs, dirMeta, depth + 1);
        continue;
      }

      if (ent.isFile()) {
        if (!onFile) continue;
        const ext = path.extname(ent.name).toLowerCase();
        const fileMeta = { abs: childAbs, id: toId(projectRootAbs, childAbs), depth: depth + 1, ext };
        onFile(fileMeta, dirMeta);
        continue;
      }

      // If symlink, try to follow if it points to a dir/file, but stay safe.
      if (ent.isSymbolicLink()) {
        const st = safeStat(childAbs);
        if (!st) continue;
        if (st.isDirectory()) {
          walkDir(childAbs, dirMeta, depth + 1);
        } else if (st.isFile()) {
          if (!onFile) continue;
          const ext = path.extname(ent.name).toLowerCase();
          const fileMeta = { abs: childAbs, id: toId(projectRootAbs, childAbs), depth: depth + 1, ext };
          onFile(fileMeta, dirMeta);
        }
      }
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
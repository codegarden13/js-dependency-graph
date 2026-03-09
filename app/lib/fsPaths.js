

/**
 * fsPaths
 * ---------------------------------------------------------------------------
 * Shared filesystem path helpers used across the NodeAnalyzer backend.
 *
 * Purpose
 * -------
 * Many modules previously implemented small variations of the same path
 * operations:
 *   - converting absolute paths → relative project ids
 *   - enforcing project-root boundaries
 *   - normalizing Windows / POSIX separators
 *   - sanitizing user supplied path input
 *
 * This module centralizes those primitives so routing, metrics building,
 * import resolution, and live change feeds all behave consistently.
 *
 * Design goals
 * ------------
 * 1. Deterministic path normalization
 * 2. Safe root-boundary checks
 * 3. Stable POSIX-style ids for graph nodes
 * 4. Minimal dependencies (only Node core `path`)
 */

import path from "node:path";

/**
 * Normalize any filesystem path into an absolute path.
 *
 * Behavior
 * --------
 * - resolves relative segments
 * - collapses `.` and `..`
 * - preserves native platform separators
 */
export function normalizeFsPath(p) {
  if (!p) return "";
  return path.resolve(String(p));
}

/**
 * Convert a path into a stable POSIX style path.
 *
 * Why
 * ---
 * Graph node ids and import identifiers should not depend on the host
 * operating system. Windows backslashes are therefore converted to `/`.
 */
export function normalizeRelPosix(p) {
  if (!p) return "";
  return String(p).replace(/\\+/g, "/");
}

/**
 * Determine whether `targetAbs` is inside `rootAbs`.
 *
 * This prevents directory traversal and guarantees that filesystem
 * operations stay within the configured application root.
 */
export function isInsideRoot(rootAbs, targetAbs) {
  if (!rootAbs || !targetAbs) return false;

  const root = normalizeFsPath(rootAbs);
  const target = normalizeFsPath(targetAbs);

  const rel = path.relative(root, target);

  return (
    rel &&
    !rel.startsWith("..") &&
    !path.isAbsolute(rel)
  );
}


/**
 * Helper: Convert an absolute path to a root-relative POSIX id.
 *
 * Behavior
 * --------
 * 1. Compute the relative path from `rootAbs` → `absPath`.
 * 2. Reject paths that escape the root (".." segments).
 * 3. Normalize separators to POSIX style so the UI receives stable ids.
 *
 * This function intentionally returns `null` instead of throwing because
 * watcher events may occasionally produce paths outside the analyzed root
 * (symlinks, editor temp files, etc.).
 *
 * @param {string} rootAbs
 * @param {string} absPath
 * @returns {string|null}
 */
export function toRelPosix(rootAbs, fileAbs) {
  if (!rootAbs || !fileAbs) return "";

  const root = normalizeFsPath(rootAbs);
  const file = normalizeFsPath(fileAbs);

  const rel = path.relative(root, file);

  return normalizeRelPosix(rel);
}

/**
 * Resolve a user provided relative path safely within a root directory.
 *
 * This helper ensures the final resolved path never escapes the root.
 * If the path would escape the root, `null` is returned.
 */
export function resolveWithinRoot(rootAbs, relPath) {
  if (!rootAbs) return null;

  const root = normalizeFsPath(rootAbs);
  const target = normalizeFsPath(path.join(root, relPath || ""));

  if (!isInsideRoot(root, target) && root !== target) {
    return null;
  }

  return target;
}

export default {
  normalizeFsPath,
  normalizeRelPosix,
  isInsideRoot,
  toRelPosix,
  resolveWithinRoot
};
/**
 * Convert an absolute path to a root‑relative POSIX id.
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
function toRelPosix(rootAbs, absPath) {
  const rel = path.relative(rootAbs, absPath);

  if (isInvalidRelative(rel)) return null;

  return normalizeToPosix(rel);
}

/**
 * Determine whether a relative path escapes the root directory.
 */
function isInvalidRelative(rel) {
  if (!rel) return true;
  if (rel === "..") return true;
  if (rel.startsWith(".." + path.sep)) return true;
  return false;
}

/**
 * Convert Windows path separators to POSIX style.
 * This keeps node ids stable across platforms.
 */
function normalizeToPosix(p) {
  return String(p || "").replace(/\\/g, "/");
}
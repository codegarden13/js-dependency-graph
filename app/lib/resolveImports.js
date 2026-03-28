/**
 * resolveImports
 * ============================================================================
 *
 * Conservative internal module resolver used by NodeAnalyzer.
 *
 * Purpose
 * -------
 * Translate import specifiers found in parsed source files into absolute file
 * paths that physically exist inside the analyzed project root.
 *
 * Core guarantees
 * ---------------
 * - deterministic, best-effort resolution
 * - only resolves things that exist on disk
 * - never allows resolved paths to escape `projectRoot`
 * - intentionally ignores package / builtin imports
 *
 * Supported specifier forms
 * -------------------------
 * 1. Relative imports
 *    - `./x`, `../y`
 *
 * 2. Absolute web-path imports (browser-style)
 *    - `/assets/js/app.js`
 *    - `/css/app.css`
 *
 *    These are mapped into common static roots inside the project, e.g.
 *    - `<root>/app/public`
 *    - `<root>/public`
 *    - `<root>/www`
 *    - `<root>/static`
 *    - `<root>` (fallback)
 *
 * 3. Absolute filesystem paths (only if already inside projectRoot)
 *    - `/Users/.../project/app/index.js`
 *
 * 4. `file:` URLs
 *    - `file:///Users/.../project/app/index.js`
 *
 * Intentionally ignored
 * ---------------------
 * - bare package imports: `express`, `react`, `lodash`
 * - Node builtins: `fs`, `path`, `node:fs`
 *
 * Design notes
 * ------------
 * - extensionless imports are resolved by trying common code + asset extensions
 * - directory imports are resolved through `index.*`
 * - web-style path handling uses POSIX normalization
 */

import fs from "node:fs";
import path from "node:path";
import { isInsideRoot, normalizeFsPath } from "./fsPaths.js";

const CODE_EXTENSIONS = Object.freeze([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"]);
const DATA_EXTENSIONS = Object.freeze([".json", ".jsonc", ".yml", ".yaml", ".csv", ".tsv", ".sql", ".env"]);
const STYLE_EXTENSIONS = Object.freeze([".css", ".scss", ".sass", ".less"]);
const MARKUP_EXTENSIONS = Object.freeze([".html", ".htm"]);
const IMAGE_EXTENSIONS = Object.freeze([".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico"]);

const ALL_EXTENSIONS = Object.freeze([
  ...CODE_EXTENSIONS,
  ...DATA_EXTENSIONS,
  ...STYLE_EXTENSIONS,
  ...MARKUP_EXTENSIONS,
  ...IMAGE_EXTENSIONS
]);

/**
 * Normalize one raw import specifier into the internal resolver form.
 *
 * This trims whitespace and removes query / hash suffixes such as:
 * - `./app.js?v=1`
 * - `/assets/logo.svg#icon`
 */
function normalizeImportSpecifier(spec) {
  if (!spec || typeof spec !== "string") return "";
  const cleaned = stripQueryAndHash(String(spec).trim());
  return String(cleaned || "").trim();
}

/**
 * Decide whether a specifier should be treated as external / unsupported.
 *
 * Only path-like imports are resolved here. Bare package imports are ignored.
 */
function isExternalSpecifier(cleaned) {
  // Only resolve relative (./, ../) or path-like imports (/..., file:...)
  return !cleaned.startsWith(".") && !cleaned.startsWith("/") && !cleaned.startsWith("file:");
}

/**
 * Resolve a `file:` URL import if it points to a real file inside the project.
 */
function tryResolveFileUrl(cleaned, rootAbs) {
  if (!cleaned.startsWith("file:")) return null;

  const asPath = fileUrlToPathSafe(cleaned);
  if (!asPath) return null;

  return resolveInsideRoot(asPath, rootAbs);
}

/**
 * Resolve a relative import (`./`, `../`) from the importer directory.
 */
function tryResolveRelativeImport(cleaned, fromDir, rootAbs) {
  if (!cleaned.startsWith(".")) return null;

  const base = path.resolve(fromDir, cleaned);
  return resolveInsideRoot(base, rootAbs);
}

/**
 * Resolve either:
 * - an absolute filesystem path already inside the project, or
 * - an absolute web-path import such as `/assets/app.css`
 */
function tryResolveAbsoluteOrWebImport(cleaned, rootAbs) {
  // 1) Absolute filesystem paths (only if inside root)
  const fsAbs = resolveAbsoluteFilesystemPathIfInsideProject(cleaned, rootAbs);
  if (fsAbs) return fsAbs;

  // 2) Absolute web-path imports
  const relWeb = normalizeWebPathToRelative(cleaned);
  if (!relWeb) return null;

  return tryResolveAgainstPublicRoots(relWeb, rootAbs);
}

/**
 * Try resolving one normalized web-relative path against likely public roots.
 */
function tryResolveAgainstPublicRoots(relWeb, rootAbs) {
  const publicRoots = getPublicRoots(rootAbs);

  for (const pr of publicRoots) {
    const base = path.resolve(pr, relWeb);
    const hit = resolveInsideRoot(base, rootAbs);
    if (hit) return hit;
  }

  return null;
}

/**
 * Resolve an import specifier to an absolute file path inside projectRoot.
 *
 * @param {string} fromAbs     Absolute path of importing file
 * @param {string} spec        Raw import specifier
 * @param {string} projectRoot Absolute project root
 * @returns {string|null}
 */
export function resolveImports(fromAbs, spec, projectRoot) {
  const cleaned = normalizeImportSpecifier(spec);
  if (!cleaned) return null;

  if (isExternalSpecifier(cleaned)) return null;

  const rootAbs = normalizeFsPath(projectRoot);

  const fileUrlHit = tryResolveFileUrl(cleaned, rootAbs);
  if (fileUrlHit) return fileUrlHit;

  const fromDir = path.dirname(normalizeFsPath(fromAbs));

  const relativeHit = tryResolveRelativeImport(cleaned, fromDir, rootAbs);
  if (relativeHit) return relativeHit;

  return tryResolveAbsoluteOrWebImport(cleaned, rootAbs);
}

/**
 * Remove query / hash suffixes from a specifier.
 *
 * Example:
 * `./app.js?v=1#x` -> `./app.js`
 *
 * @param {string} s
 */
function stripQueryAndHash(s) {
  return String(s || "").split(/[?#]/)[0];
}

/**
 * Convert "file:///..." to a filesystem path.
 * Returns null if the URL is not parseable.
 *
 * NOTE: We intentionally avoid importing node:url here to keep this module
 * small and dependency-free; the conversion is conservative.
 *
 * @param {string} fileUrl
 */
function fileUrlToPathSafe(fileUrl) {
  const raw = String(fileUrl || "").trim();
  if (!raw.startsWith("file:")) return null;

  // Common shapes:
  // - file:///Users/me/project/app/index.js
  // - file://localhost/Users/me/project/app/index.js
  // - file:/Users/me/project/app/index.js
  let u = raw.replace(/^file:\/\//, "");

  // Drop an optional host ("localhost")
  u = u.replace(/^localhost\//, "");

  // Ensure leading slash for POSIX paths.
  if (!u.startsWith("/")) u = "/" + u;

  // Decode %20 etc.
  try {
    u = decodeURIComponent(u);
  } catch {
    // keep raw if decoding fails
  }

  return path.normalize(u);
}

/**
 * Convert an absolute browser-style path into a safe relative web path.
 *
 * Example:
 * `/assets/js/app.js` -> `assets/js/app.js`
 *
 * Security boundary
 * -----------------
 * Reject anything that normalizes outside the web root (`..` traversal).
 *
 * @param {string} web
 */
function normalizeWebPathToRelative(web) {
  const w = String(web || "").trim();
  if (!w.startsWith("/")) return "";

  // Avoid special Vite-like prefixes; treat as external/unsupported.
  // Examples: "/@fs/...", "/@id/..."
  if (w.startsWith("/@")) return "";

  // Use POSIX normalization for web paths.
  const normalized = path.posix.normalize(w.replace(/\\/g, "/"));

  // Reject traversal outside the web root.
  if (normalized === "/.." || normalized.startsWith("/../")) return "";

  return normalized.replace(/^\/+/, "");
}

/**
 * Resolve an absolute filesystem import only if it already points inside the
 * analyzed project root.
 *
 * This prevents mistakenly treating browser-style imports such as `/assets/...`
 * as real filesystem paths on POSIX systems.
 *
 * @param {string} absSpec
 * @param {string} rootAbs
 * @returns {string|null}
 */
function resolveAbsoluteFilesystemPathIfInsideProject(absSpec, rootAbs) {
  if (!path.isAbsolute(absSpec)) return null;

  const candidate = normalizeFsPath(absSpec);

  return resolveInsideRoot(candidate, rootAbs);
}

/**
 * Resolve a candidate path with extension probing and accept it only if the
 * final hit remains inside the project root.
 */
function resolveInsideRoot(candidateAbs, rootAbs) {
  const hit = resolveWithExtensions(candidateAbs);
  if (!hit) return null;
  return isInsideRoot(rootAbs, hit) ? hit : null;
}

/**
 * Read whether a path already has an explicit extension.
 */
function hasExtension(p) {
  return Boolean(path.extname(String(p || "")));
}

/**
 * Try resolving `<base><ext>` for each allowed extension.
 */
function tryResolveByExtensions(baseAbs, exts) {
  for (const ext of exts) {
    const cand = baseAbs + ext;
    if (existsFile(cand)) return cand;
  }
  return null;
}

/**
 * Try resolving `index.<ext>` inside one directory.
 */
function tryResolveIndexFile(dirAbs, exts) {
  for (const ext of exts) {
    const cand = path.join(dirAbs, "index" + ext);
    if (existsFile(cand)) return cand;
  }
  return null;
}

/**
 * Resolve a path candidate conservatively using three steps:
 *
 * 1. exact file
 * 2. extension probing (`<base>.<ext>`)
 * 3. directory index probing (`<base>/index.<ext>`)
 *
 * @param {string} baseAbs
 * @returns {string|null}
 */
function resolveWithExtensions(baseAbs) {
  const base = String(baseAbs || "");
  if (!base) return null;

  // 1) Exact file (already has extension)
  if (hasExtension(base) && existsFile(base)) return base;

  // 2) Try "<base>.<ext>" (only if extensionless)
  const direct = hasExtension(base) ? null : tryResolveByExtensions(base, ALL_EXTENSIONS);
  if (direct) return direct;

  // 3) Try "<base>/index.<ext>" (only if base is a directory)
  return existsDir(base) ? tryResolveIndexFile(base, ALL_EXTENSIONS) : null;
}

/**
 * Guess likely public/static roots inside the project.
 *
 * Order matters: more conventional roots are tried first.
 *
 * @param {string} rootAbs
 * @returns {string[]}
 */
function getPublicRoots(rootAbs) {
  const key = path.resolve(rootAbs);

  // Order matters: most common first.
  const roots = [
    path.join(key, "app", "public"),
    path.join(key, "public"),
    path.join(key, "src", "public"),
    path.join(key, "www"),
    path.join(key, "static"),
    key // fallback: allow direct mapping ("/assets" → "<root>/assets")
  ].filter(existsDir);

  return roots;
}

/**
 * Check whether one path exists and is a regular file.
 */
function existsFile(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Check whether one path exists and is a directory.
 */
function existsDir(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

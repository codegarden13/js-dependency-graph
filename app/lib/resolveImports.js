/**
 * resolveImports
 * ==============
 *
 * Industrial-grade internal module resolver used by NodeAnalyzer.
 *
 * Responsibilities
 * ----------------
 * - Translate import specifiers found in source files into absolute file paths
 *   within the analyzed `projectRoot`.
 * - Resolve only things that are on disk (conservative, deterministic).
 * - Never allow resolved paths to escape `projectRoot`.
 *
 * Supported specifier forms
 * -------------------------
 * 1) Relative imports
 *    - "./x", "../y"
 *
 * 2) Absolute web-path imports (browser-style)
 *    - "/assets/js/app.js"
 *    - "/css/app.css"
 *
 *    These are mapped into common static roots inside the project, e.g.
 *    - <root>/app/public
 *    - <root>/public
 *    - <root>/www
 *    - <root>/static
 *    - <root> (fallback)
 *
 * 3) Absolute filesystem paths (only if inside projectRoot)
 *    - "/Users/.../project/app/index.js"
 *
 * 4) file: URLs (tooling sometimes emits these)
 *    - "file:///Users/.../project/app/index.js"
 *
 * Intentionally ignored
 * ---------------------
 * - Bare package imports: "express", "react", "lodash"
 * - Node builtins: "fs", "path", "node:fs"
 *
 * Design notes
 * ------------
 * - Deterministic, best-effort resolver.
 * - Only resolves if the candidate exists as a file.
 * - Supports extensionless imports by trying common code + asset extensions.
 */

import fs from "node:fs";
import path from "node:path";

/* ========================================================================== */
/* Configuration                                                              */
/* ========================================================================== */

const CODE_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"];

const ASSET_EXTENSIONS = [
  ".json",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".html",
  ".htm",
  ".md",
  ".txt",
  ".csv",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot"
];

const ALL_EXTENSIONS = [...CODE_EXTENSIONS, ...ASSET_EXTENSIONS];

/** Cache public root guesses per project root (performance + determinism). */
const publicRootsCache = new Map();

/* ========================================================================== */
/* Public API                                                                 */
/* ========================================================================== */

function normalizeImportSpecifier(spec) {
  if (!spec || typeof spec !== "string") return "";
  const cleaned = stripQueryAndHash(String(spec).trim());
  return String(cleaned || "").trim();
}

function isExternalSpecifier(cleaned) {
  // Only resolve relative (./, ../) or path-like imports (/..., file:...)
  return !cleaned.startsWith(".") && !cleaned.startsWith("/") && !cleaned.startsWith("file:");
}

function tryResolveFileUrl(cleaned, rootAbs) {
  if (!cleaned.startsWith("file:")) return null;

  const asPath = fileUrlToPathSafe(cleaned);
  if (!asPath) return null;

  const hit = resolveWithExtensions(asPath);
  if (!hit) return null;

  return isInsideRoot(rootAbs, hit) ? hit : null;
}

function tryResolveRelativeImport(cleaned, fromDir, rootAbs) {
  if (!cleaned.startsWith(".")) return null;

  const base = path.resolve(fromDir, cleaned);
  const hit = resolveWithExtensions(base);
  if (!hit) return null;

  return isInsideRoot(rootAbs, hit) ? hit : null;
}

function tryResolveAbsoluteOrWebImport(cleaned, rootAbs) {
  // 1) Absolute filesystem paths (only if inside root)
  const fsAbs = resolveAbsoluteFilesystemPathIfInsideProject(cleaned, rootAbs);
  if (fsAbs) return fsAbs;

  // 2) Absolute web-path imports
  const relWeb = normalizeWebPathToRelative(cleaned);
  if (!relWeb) return null;

  return tryResolveAgainstPublicRoots(relWeb, rootAbs);
}

function tryResolveAgainstPublicRoots(relWeb, rootAbs) {
  const publicRoots = getPublicRoots(rootAbs);

  for (const pr of publicRoots) {
    const base = path.resolve(pr, relWeb);
    const hit = resolveWithExtensions(base);

    if (hit && isInsideRoot(rootAbs, hit)) return hit;
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

  const rootAbs = path.resolve(projectRoot);

  const fileUrlHit = tryResolveFileUrl(cleaned, rootAbs);
  if (fileUrlHit) return fileUrlHit;

  const fromDir = path.dirname(path.resolve(fromAbs));

  const relativeHit = tryResolveRelativeImport(cleaned, fromDir, rootAbs);
  if (relativeHit) return relativeHit;

  return tryResolveAbsoluteOrWebImport(cleaned, rootAbs);
}

/* ========================================================================== */
/* Internals                                                                  */
/* ========================================================================== */

/**
 * Strip query/hash ("?v=1#x") from import specifiers.
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
 * Convert "/assets/js/app.js" → "assets/js/app.js" and normalize slashes.
 *
 * Security boundary:
 * - Reject anything that normalizes outside the web root (".." segments).
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
 * Resolve an absolute filesystem path only if it is inside the analyzed project.
 * This prevents mistakenly treating web-paths like "/assets/..." as filesystem
 * paths on POSIX.
 *
 * @param {string} absSpec
 * @param {string} rootAbs
 * @returns {string|null}
 */
function resolveAbsoluteFilesystemPathIfInsideProject(absSpec, rootAbs) {
  if (!path.isAbsolute(absSpec)) return null;

  const candidate = path.resolve(absSpec);

  // Disambiguation: only accept the FS path if it is already inside the project.
  // Otherwise it is far more likely a web-path.
  if (!isInsideRoot(rootAbs, candidate)) return null;

  const hit = resolveWithExtensions(candidate);
  if (!hit) return null;

  return isInsideRoot(rootAbs, hit) ? hit : null;
}

/**
 * Resolve extensionless imports and directory imports (index.*).
 *
 * @param {string} baseAbs
 * @returns {string|null}
 */
function hasExtension(p) {
  return Boolean(path.extname(String(p || "")));
}

function tryResolveByExtensions(baseAbs, exts) {
  for (const ext of exts) {
    const cand = baseAbs + ext;
    if (existsFile(cand)) return cand;
  }
  return null;
}

function tryResolveIndexFile(dirAbs, exts) {
  for (const ext of exts) {
    const cand = path.join(dirAbs, "index" + ext);
    if (existsFile(cand)) return cand;
  }
  return null;
}

/**
 * Resolve extensionless imports and directory imports (index.*).
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
 * Guess and cache likely public/static roots inside the project.
 *
 * @param {string} rootAbs
 * @returns {string[]}
 */
function getPublicRoots(rootAbs) {
  const key = path.resolve(rootAbs);
  const cached = publicRootsCache.get(key);
  if (cached) return cached;

  // Order matters: most common first.
  const roots = [
    path.join(key, "app", "public"),
    path.join(key, "public"),
    path.join(key, "src", "public"),
    path.join(key, "www"),
    path.join(key, "static"),
    key // fallback: allow direct mapping ("/assets" → "<root>/assets")
  ].filter(existsDir);

  publicRootsCache.set(key, roots);
  return roots;
}

/**
 * Ensure the resolved file stays inside the project root.
 *
 * @param {string} rootAbs
 * @param {string} fileAbs
 */
function isInsideRoot(rootAbs, fileAbs) {
  const root = path.resolve(rootAbs);
  const file = path.resolve(fileAbs);
  return file === root || file.startsWith(root + path.sep);
}

function existsFile(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function existsDir(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
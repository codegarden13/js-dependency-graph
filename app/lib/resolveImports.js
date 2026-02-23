/**
 * resolveImports
 * ==============
 *
 * Industrial-grade internal module resolver used by NodeAnalyzer.
 *
 * Responsibility
 * --------------
 * Translate import specifiers found in source files into absolute file
 * paths within the analyzed project root.
 *
 * Supported
 * ---------
 * - Relative imports: "./x", "../y"
 * - Absolute web imports: "/assets/js/app.js"
 *   → mapped to common public/static roots
 *
 * Intentionally ignored
 * ----------------------
 * - Bare package imports: "express", "react", "lodash"
 * - Node builtins: "fs", "path", "node:fs"
 *
 * Design Goals
 * ------------
 * - Deterministic
 * - Conservative (must exist on disk)
 * - Never escapes projectRoot
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

/* ========================================================================== */
/* Public API                                                                 */
/* ========================================================================== */

/**
 * Resolve an import specifier to an absolute file path inside projectRoot.
 *
 * @param {string} fromAbs     Absolute path of importing file
 * @param {string} spec        Raw import specifier
 * @param {string} projectRoot Absolute project root
 * @returns {string|null}
 */
export function resolveImports(fromAbs, spec, projectRoot) {
  if (!spec || typeof spec !== "string") return null;

  const rootAbs = path.resolve(projectRoot);
  const fromDir = path.dirname(path.resolve(fromAbs));

  const cleaned = stripQueryAndHash(spec.trim());
  if (!cleaned) return null;

  // ---------------------------------------------------------------------------
  // 1) Ignore external imports early
  // ---------------------------------------------------------------------------
  if (!cleaned.startsWith(".") && !cleaned.startsWith("/")) {
    return null;
  }

  // ---------------------------------------------------------------------------
  // 2) Relative imports
  // ---------------------------------------------------------------------------
  if (cleaned.startsWith(".")) {
    const base = path.resolve(fromDir, cleaned);
    const hit = resolveWithExtensions(base);
    return hit && isInsideRoot(rootAbs, hit) ? hit : null;
  }

  // ---------------------------------------------------------------------------
  // 3) Absolute web imports ("/assets/...")
  // ---------------------------------------------------------------------------
  if (cleaned.startsWith("/")) {
    const relWeb = cleaned.replace(/^\/+/, "");

    const publicRoots = guessPublicRoots(rootAbs);

    for (const pr of publicRoots) {
      const base = path.resolve(pr, relWeb);
      const hit = resolveWithExtensions(base);
      if (hit && isInsideRoot(rootAbs, hit)) return hit;
    }

    return null;
  }

  return null;
}

/* ========================================================================== */
/* Internals                                                                  */
/* ========================================================================== */

function stripQueryAndHash(s) {
  return String(s || "").split(/[?#]/)[0];
}

function resolveWithExtensions(baseAbs) {
  // Exact file
  if (path.extname(baseAbs) && existsFile(baseAbs)) return baseAbs;

  // Try "<base>.<ext>"
  if (!path.extname(baseAbs)) {
    for (const ext of ALL_EXTENSIONS) {
      const cand = baseAbs + ext;
      if (existsFile(cand)) return cand;
    }
  }

  // Try "<base>/index.<ext>"
  if (existsDir(baseAbs)) {
    for (const ext of ALL_EXTENSIONS) {
      const cand = path.join(baseAbs, "index" + ext);
      if (existsFile(cand)) return cand;
    }
  }

  return null;
}

function guessPublicRoots(projectRoot) {
  // Order matters: most common first
  const roots = [
    path.join(projectRoot, "app", "public"),
    path.join(projectRoot, "public"),
    path.join(projectRoot, "src", "public"),
    path.join(projectRoot, "www"),
    path.join(projectRoot, "static"),
    projectRoot // fallback: allow direct mapping ("/assets" → "<root>/assets")
  ];

  return roots.filter(existsDir);
}

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
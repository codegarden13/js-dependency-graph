/**
 * README Lookup Route
 * ===================
 *
 * GET /readme?file=<relative-path>
 *
 * Behavior
 * --------
 * 1) If file points to the global help doc (app/public/readme.md), return it.
 * 2) Otherwise: find the nearest README in the file's directory and parents.
 *
 * Response
 * --------
 * { found: true, readmePath: string, markdown: string }
 * { found: false }
 */

import express from "express";
import path from "node:path";
import fs from "node:fs";

const router = express.Router();

router.get("/readme", (req, res) => {
  try {
    const fileRelRaw = getQueryString(req, "file");
    if (!fileRelRaw) return res.status(400).send("file query param missing");

    const fileRel = normalizeRel(fileRelRaw);

    // 1) Special-case: global help doc (NodeAnalyzer UI help)
    const helpResult = tryServeAnalyzerHelp(fileRel);
    if (helpResult) {
      return res.json(helpResult);
    }

    // 2) Resolve target project root (analyzed app)
    const appId = getQueryString(req, "appId");
    if (!appId) return res.status(400).send("appId query param missing");

    const appRootAbs = resolveAppRootAbs(appId);
    if (!appRootAbs) return res.status(400).send(`Unknown appId: ${appId}`);

    // Resolve absolute and enforce project boundary
    const fileAbs = resolveInsideRootOrNull(appRootAbs, fileRel);
    if (!fileAbs) return res.status(400).send("file outside target app rootDir");

    // 3) Validate target exists
    if (!fs.existsSync(fileAbs)) return res.status(404).send("file not found");

    // 4) Walk upward for README
    const found = findNearestReadme({ appRootAbs, fileAbs });
    if (!found) return res.json({ found: false });

    return res.json({
      found: true,
      readmePath: toRelPosix(appRootAbs, found.readmeAbs),
      markdown: found.markdown
    });
  } catch (err) {
    return res.status(500).send(err?.stack || String(err));
  }
});

export default router;

/* ====================================================================== */
/* Helpers                                                                */
/* ====================================================================== */

function loadAppsConfig() {
  const cfgPath = path.join(process.cwd(), "app/config/apps.json");
  if (!fs.existsSync(cfgPath)) return { apps: [] };
  return JSON.parse(fs.readFileSync(cfgPath, "utf8"));
}

function resolveAppRootAbs(appId) {
  const cfg = loadAppsConfig();
  const app = (cfg.apps || []).find((a) => String(a.id || "") === String(appId || ""));
  const rootDir = String(app?.rootDir || "").trim();
  if (!rootDir) return null;
  return path.resolve(rootDir);
}

function normalizeRel(p) {
  // Remove leading slashes so "/app/public/readme.md" still resolves within root
  return String(p || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();
}

function samePath(a, b) {
  return path.resolve(a) === path.resolve(b);
}

function isInsideRoot(absPath, rootAbs) {
  // Robust boundary check: "/root2" must not match "/root"
  const root = path.resolve(rootAbs);
  const abs = path.resolve(absPath);
  const rel = path.relative(root, abs);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? true : abs === root;
}

function toRelPosix(rootAbs, absPath) {
  return path.relative(rootAbs, absPath).replace(/\\/g, "/");
}

function readFileIfExists(absPath) {
  try {
    if (!fs.existsSync(absPath)) return null;
    const st = fs.statSync(absPath);
    if (!st.isFile()) return null;
    return fs.readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
}

function getQueryString(req, key) {
  return String(req?.query?.[key] || "").trim();
}

function tryServeAnalyzerHelp(fileRel) {
  const analyzerRoot = process.cwd();
  const HELP_RELS = new Set([
    "help",
    "app/public/readme.md",
    "app/public/README.md",
    "public/readme.md",
    "public/README.md"
  ]);

  if (!HELP_RELS.has(fileRel)) return null;

  const helpAbs = path.resolve(analyzerRoot, "app/public/readme.md");
  const out = readFileIfExists(helpAbs);
  if (!out) return { found: false };

  return {
    found: true,
    readmePath: toRelPosix(analyzerRoot, helpAbs),
    markdown: out
  };
}

function resolveInsideRootOrNull(rootAbs, relPosix) {
  const abs = path.resolve(rootAbs, relPosix);
  return isInsideRoot(abs, rootAbs) ? abs : "";
}

function findNearestReadme({ appRootAbs, fileAbs }) {
  // Starting directory: file's dir (or itself if already a directory)
  let dir = fs.statSync(fileAbs).isDirectory() ? fileAbs : path.dirname(fileAbs);

  while (true) {
    const readmeAbs = findReadmeInDir(dir);
    if (readmeAbs) {
      return {
        readmeAbs,
        markdown: fs.readFileSync(readmeAbs, "utf8")
      };
    }

    if (samePath(dir, appRootAbs)) return null;

    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * findReadmeInDir
 * ===============
 *
 * Purpose
 * -------
 * Locate a README file inside a given directory.
 *
 * Strategy
 * --------
 * - Prefer conventional naming (README.md).
 * - Accept common case variations (cross-platform friendliness).
 * - Fail safely (no thrown errors on permission/stat issues).
 *
 * Design Notes
 * ------------
 * - Case-sensitive filesystems (Linux) require explicit variants.
 * - We intentionally do NOT perform recursive lookup here.
 * - Caller is responsible for walking parent directories if needed.
 *
 * @param {string} dirAbs  Absolute directory path
 * @returns {string|null}  Absolute path to README file or null if none found
 */
function findReadmeInDir(dirAbs) {
  if (!dirAbs || typeof dirAbs !== "string") {
    return null;
  }

  // Ordered by convention priority
  const CANDIDATES = [
    "README.md",   // canonical
    "readme.md",   // common lowercase variant
    "Readme.md"    // Windows/macOS mixed-case variant
  ];

  for (const filename of CANDIDATES) {
    const absPath = path.join(dirAbs, filename);

    try {
      if (!fs.existsSync(absPath)) continue;

      const stat = fs.statSync(absPath);
      if (stat.isFile()) {
        return absPath;
      }
    } catch {
      // Intentionally ignore filesystem errors:
      // - Permission issues
      // - Race conditions (file deleted between existsSync + statSync)
      // Continue scanning remaining candidates.
    }
  }

  return null;
}
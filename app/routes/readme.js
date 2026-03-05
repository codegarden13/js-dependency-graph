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

router.get("/readme", handleReadmeRequest);

function sendText(res, status, message) {
  return res.status(status).send(String(message || ""));
}

function sendJson(res, status, body) {
  return res.status(status).json(body);
}

function requireQueryParam(req, res, key, errorMessage) {
  const value = getQueryString(req, key);
  if (value) return value;
  sendText(res, 400, errorMessage);
  return "";
}

function withRouteErrors(res, fn) {
  try {
    fn();
  } catch (err) {
    sendText(res, 500, err?.stack || String(err));
  }
}

function requireNormalizedFileRel(req, res) {
  const raw = requireQueryParam(req, res, "file", "file query param missing");
  if (!raw) return "";
  return normalizeRel(raw);
}

function tryReplyWithAnalyzerHelp(res, fileRel) {
  const helpResult = tryServeAnalyzerHelp(fileRel);
  if (!helpResult) return false;
  sendJson(res, 200, helpResult);
  return true;
}

function requireAppRootAbs(req, res) {
  const appId = requireQueryParam(req, res, "appId", "appId query param missing");
  if (!appId) return "";

  const appRootAbs = resolveAppRootAbs(appId);
  if (appRootAbs) return appRootAbs;

  sendText(res, 400, `Unknown appId: ${appId}`);
  return "";
}

function requireFileAbsInsideRoot(res, appRootAbs, fileRel) {
  const fileAbs = resolveInsideRootOrNull(appRootAbs, fileRel);
  if (fileAbs) return fileAbs;
  sendText(res, 400, "file outside target app rootDir");
  return "";
}

function requireExistingPath(res, absPath) {
  if (fs.existsSync(absPath)) return true;
  sendText(res, 404, "file not found");
  return false;
}

function replyWithNearestReadme(res, appRootAbs, fileAbs) {
  const found = findNearestReadme({ appRootAbs, fileAbs });

  if (!found) {
    sendJson(res, 200, { found: false });
    return;
  }

  sendJson(res, 200, {
    found: true,
    readmePath: toRelPosix(appRootAbs, found.readmeAbs),
    markdown: found.markdown
  });
}

function handleReadmeRequest(req, res) {
  return withRouteErrors(res, () => {
    const fileRel = requireNormalizedFileRel(req, res);
    if (!fileRel) return;

    if (tryReplyWithAnalyzerHelp(res, fileRel)) return;

    const appRootAbs = requireAppRootAbs(req, res);
    if (!appRootAbs) return;

    const fileAbs = requireFileAbsInsideRoot(res, appRootAbs, fileRel);
    if (!fileAbs) return;

    if (!requireExistingPath(res, fileAbs)) return;

    replyWithNearestReadme(res, appRootAbs, fileAbs);
  });
}

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
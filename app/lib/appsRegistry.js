import path from "path";
import fs from "fs";
import { normalizeFsPath, normalizeRelPosix } from "./fsPaths.js";

import { normalizeId } from "./stringUtils.js";

const PACKAGE_SCRIPT_KEYS = ["dev", "start", "serve", "preview"];
const ENTRY_GUESS_FILES = [
  "app/server.js",
  "src/server.js",
  "server.js",
  "app/index.js",
  "src/index.js",
  "index.js",
  "main.js",
  "app.js"
];
const PORT_GUESS_FILES = [
  "app/config/config.js",
  "app/config/app-config.js",
  "app/config.js",
  "config.js",
  "app/server.js",
  "src/server.js",
  "server.js"
];
const ENTRY_SCRIPT_RE = /\b(?:node|nodemon|tsx|ts-node(?:-dev)?|babel-node)\b\s+["']?([^"'`\s]+?\.(?:mjs|cjs|js|ts|tsx|jsx))["']?/i;
const PORT_SCRIPT_PATTERNS = [
  /\bPORT\s*=\s*(\d{2,5})\b/,
  /\b(?:--port|-p)\s*(?:=|\s)\s*(\d{2,5})\b/i,
  /localhost:(\d{2,5})\b/i
];
const PORT_FILE_PATTERNS = [
  /Number\s*\(\s*process\.env\.PORT\s*\)\s*\|\|\s*(\d{2,5})\b/,
  /Number\s*\(\s*process\.env\.PORT\s*\|\|\s*(\d{2,5})\s*\)/,
  /process\.env\.PORT\s*\|\|\s*(\d{2,5})\b/,
  /\bport\s*:\s*Number\([^)]*\)\s*\|\|\s*(\d{2,5})\b/i,
  /\bdefaultPort\s*:\s*(\d{2,5})\b/i,
  /\bconst\s+PORT\s*=\s*(\d{2,5})\b/,
  /\bPORT\s*[:=]\s*(\d{2,5})\b/,
  /localhost:(\d{2,5})\b/i
];
const TEXT_SCAN_LIMIT = 256 * 1024;
// ---------------------------------------------------------------------------
// Local path / identity helpers
// ---------------------------------------------------------------------------
/**
 * Normalize a loose identifier input to a trimmed string.
 *
 * @param {unknown} value
 *   Candidate identifier value.
 * @returns {string}
 *   Trimmed string representation, or an empty string for missing input.
 */
/**
 * Resolve either:
 * - an already absolute filesystem path, or
 * - a project-relative path anchored at `process.cwd()`.
 *
 * The result is normalized so downstream modules can compare / log stable paths.
 *
 * @param {string} inputPath
 *   Absolute or project-relative filesystem path.
 * @returns {string}
 *   Normalized absolute path.
 */
function resolveAbsoluteOrProjectPath(inputPath) {
  const raw = String(inputPath || "").trim();
  if (!raw) return "";

  const absolute = path.isAbsolute(raw)
    ? raw
    : path.resolve(process.cwd(), raw);

  return normalizeFsPath(absolute);
}

/**
 * Read and parse a JSON file synchronously.
 *
 * Why this exists
 * ---------------
 * Route bootstrap data is small and local. A synchronous read keeps the helper
 * simple and makes configuration failures immediate and explicit.
 *
 * @param {string} fileAbs
 *   Absolute path to the JSON file.
 * @returns {unknown}
 *   Parsed JSON payload.
 * @throws {Error}
 *   Propagates filesystem and JSON parse failures.
 */
function safeJsonRead(fileAbs) {
  const txt = fs.readFileSync(fileAbs, "utf8");
  return JSON.parse(txt);
}

function safeTextRead(fileAbs, maxBytes = TEXT_SCAN_LIMIT) {
  try {
    return fs.readFileSync(fileAbs, "utf8").slice(0, maxBytes);
  } catch {
    return "";
  }
}

function isExistingFile(fileAbs) {
  try {
    return fs.statSync(fileAbs).isFile();
  } catch {
    return false;
  }
}

function resolveExistingAppFile(appRootAbs, relativePath) {
  const safeRelativePath = String(relativePath || "").trim();
  if (!safeRelativePath) return "";

  const fileAbs = normalizeFsPath(path.resolve(appRootAbs, safeRelativePath));
  return isExistingFile(fileAbs) ? fileAbs : "";
}

function toRelativeAppPath(appRootAbs, fileAbs) {
  const relativePath = normalizeRelPosix(path.relative(appRootAbs, fileAbs));
  if (!relativePath) return "";
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return "";
  return relativePath;
}

function readPackageJson(appRootAbs) {
  const packageJsonAbs = normalizeFsPath(path.join(appRootAbs, "package.json"));
  if (!isExistingFile(packageJsonAbs)) return null;

  try {
    return safeJsonRead(packageJsonAbs);
  } catch {
    return null;
  }
}

function parseEntryFromScript(scriptText) {
  const match = String(scriptText || "").match(ENTRY_SCRIPT_RE);
  return String(match?.[1] || "").trim();
}

function readPortFromText(text, patterns) {
  const safeText = String(text || "");

  for (const pattern of patterns || []) {
    const match = safeText.match(pattern);
    const port = Number(match?.[1] || 0);
    if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
  }

  return 0;
}

function parsePortFromUrl(url) {
  const safeUrl = String(url || "").trim();
  if (!safeUrl) return 0;

  try {
    const parsed = new URL(safeUrl);
    const explicitPort = Number(parsed.port || 0);
    if (Number.isInteger(explicitPort) && explicitPort > 0) return explicitPort;
    return parsed.protocol === "https:" ? 443 : 80;
  } catch {
    return 0;
  }
}

function inferEntryFromPackageJson(appRootAbs, pkg) {
  const mainEntry = resolveExistingAppFile(appRootAbs, pkg?.main);
  if (mainEntry) return mainEntry;

  const scripts = pkg?.scripts || {};
  for (const key of PACKAGE_SCRIPT_KEYS) {
    const entryCandidate = resolveExistingAppFile(appRootAbs, parseEntryFromScript(scripts?.[key]));
    if (entryCandidate) return entryCandidate;
  }

  return "";
}

function inferPortFromPackageJson(pkg) {
  const packageConfigPort = Number(pkg?.config?.port || 0);
  if (Number.isInteger(packageConfigPort) && packageConfigPort > 0 && packageConfigPort <= 65535) {
    return packageConfigPort;
  }

  const scripts = pkg?.scripts || {};
  for (const key of PACKAGE_SCRIPT_KEYS) {
    const port = readPortFromText(scripts?.[key], PORT_SCRIPT_PATTERNS);
    if (port) return port;
  }

  return 0;
}

function inferPortFromFiles(appRootAbs, entryAbs) {
  const candidateFiles = new Set();

  if (entryAbs) candidateFiles.add(normalizeFsPath(entryAbs));
  for (const guess of PORT_GUESS_FILES) {
    const candidate = resolveExistingAppFile(appRootAbs, guess);
    if (candidate) candidateFiles.add(candidate);
  }

  for (const fileAbs of candidateFiles) {
    const port = readPortFromText(safeTextRead(fileAbs), PORT_FILE_PATTERNS);
    if (port) return port;
  }

  return 0;
}

function buildInferredUrl(configuredUrl, inferredPort) {
  const safeConfiguredUrl = String(configuredUrl || "").trim();
  if (safeConfiguredUrl) return safeConfiguredUrl;
  if (!Number.isInteger(inferredPort) || inferredPort <= 0) return "";
  return `http://localhost:${inferredPort}`;
}


// ---------------------------------------------------------------------------
// Apps config (app/config/apps.json)
// ---------------------------------------------------------------------------
/**
 * Resolve the absolute path to the apps configuration file.
 *
 * @returns {string}
 *   Normalized absolute path to `app/config/apps.json`.
 */
function appsConfigPath() {
  return normalizeFsPath(path.join(process.cwd(), "app", "config", "apps.json"));
}

/**
 * Load and validate the application registry from disk.
 *
 * @returns {Array<object>}
 *   Configured application records.
 * @throws {Error}
 *   Thrown when the config file is missing or structurally invalid.
 */
export function loadAppsConfig() {
  const configAbs = appsConfigPath();
  if (!fs.existsSync(configAbs)) {
    throw new Error(`Missing apps config: ${configAbs}`);
  }

  const data = safeJsonRead(configAbs);
  const apps = data?.apps || data;
  if (!Array.isArray(apps)) {
    throw new Error("apps.json must be an array or an object with an 'apps' array");
  }

  return apps.map((app) => normalizeConfiguredApp(app));
}


/**
 * Read the configured root directory field from an app record.
 *
 * Why this exists
 * ---------------
 * Historical config variants may use `rootDir`, `root`, or `path`. This helper
 * centralizes that compatibility rule.
 *
 * @param {object} app
 *   Application config record.
 * @returns {string}
 *   Trimmed configured root directory value, or an empty string.
 */
function readAppRootDir(app) {
  return String(app?.rootDir || app?.root || app?.path || "").trim();
}

/**
 * Resolve the absolute entry file for one application.
 *
 * Why this exists
 * ---------------
 * Some app records explicitly declare an entry file. Others rely on a small
 * set of conventional fallback filenames.
 *
 * @param {string} appRootAbs
 *   Absolute application root directory.
 * @param {object} app
 *   Application config record.
 * @returns {string | null}
 *   Absolute entry file path, or `null` when no candidate can be resolved.
 */
export function resolveEntryAbs(appRootAbs, app) {
  const configuredEntryAbs = resolveExistingAppFile(appRootAbs, app?.entry);
  if (configuredEntryAbs) return configuredEntryAbs;

  const pkg = readPackageJson(appRootAbs);
  const packageEntryAbs = inferEntryFromPackageJson(appRootAbs, pkg);
  if (packageEntryAbs) return packageEntryAbs;

  // Best-effort fallback if entry is omitted.
  for (const guess of ENTRY_GUESS_FILES) {
    const candidateAbs = resolveExistingAppFile(appRootAbs, guess);
    if (candidateAbs) {
      return candidateAbs;
    }
  }

  return null;
}

function normalizeConfiguredApp(app) {
  const rootDir = readAppRootDir(app);
  const appRootAbs = rootDir ? resolveAbsoluteOrProjectPath(rootDir) : "";
  const entryAbs = appRootAbs ? resolveEntryAbs(appRootAbs, app) : null;
  const entry = entryAbs && appRootAbs ? toRelativeAppPath(appRootAbs, entryAbs) : "";
  const configuredUrl = String(app?.url || "").trim();
  const configuredPort = parsePortFromUrl(configuredUrl);
  const pkg = appRootAbs ? readPackageJson(appRootAbs) : null;
  const inferredPort =
    configuredPort ||
    inferPortFromPackageJson(pkg) ||
    (appRootAbs ? inferPortFromFiles(appRootAbs, entryAbs) : 0);
  const url = buildInferredUrl(configuredUrl, inferredPort);

  return {
    ...app,
    rootDir,
    entry,
    url
  };
}



/**
 * Resolve the absolute root directory for one configured application.
 *
 * @param {object} app
 *   Application config record.
 * @returns {string | null}
 *   Normalized absolute root path, or `null` when no root is configured.
 */
export function resolveAppRootAbs(app) {
  const rootDir = readAppRootDir(app);
  if (!rootDir) return null;
  return resolveAbsoluteOrProjectPath(rootDir);
}

/**
 * Resolve the absolute backup directory for one configured application.
 *
 * @param {object} app
 *   Application config record.
 * @returns {string | null}
 *   Normalized absolute backup directory, or `null` when the app root is missing.
 */
export function resolveBackupDirAbs(app) {
  const appRootAbs = resolveAppRootAbs(app);
  if (!appRootAbs) return null;
  return normalizeFsPath(path.join(appRootAbs, "backups"));
}


/**
 * Find one configured application by normalized identifier.
 *
 * @param {Array<object>} apps
 *   Loaded application records.
 * @param {string} appId
 *   Requested application identifier.
 * @returns {object | null}
 *   Matching application config, or `null` when not found.
 */
export function findAppById(apps, appId) {
  const id = normalizeId(appId);
  if (!id) return null;
  return apps.find((a) => normalizeId(a?.id) === id) || null;
}

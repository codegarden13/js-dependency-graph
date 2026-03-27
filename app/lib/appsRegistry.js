import path from "path";
import fs from "fs";
import { normalizeFsPath } from "./fsPaths.js";

import { normalizeId } from "./stringUtils.js";
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

  return apps;
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
 * Read the configured backup target directory from an app record.
 *
 * Why this exists
 * ---------------
 * The scan-freeze feature may evolve across config variants. This helper keeps
 * backward-compatible field handling in one place.
 *
 * @param {object} app
 *   Application config record.
 * @returns {string}
 *   Trimmed configured backup directory, or an empty string.
 */
function readAppBackupDir(app) {
  return String(app?.backupDir || app?.backupPath || app?.freezeDir || "").trim();
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
  const entry = String(app?.entry || "").trim();
  if (entry) return normalizeFsPath(path.resolve(appRootAbs, entry));

  // Best-effort fallback if entry is omitted.
  const guesses = ["index.js", "src/index.js", "main.js", "app.js"];
  for (const guess of guesses) {
    const candidateAbs = normalizeFsPath(path.resolve(appRootAbs, guess));
    if (fs.existsSync(candidateAbs) && fs.statSync(candidateAbs).isFile()) {
      return candidateAbs;
    }
  }

  return null;
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
 *   Normalized absolute backup directory, or `null` when not configured.
 */
export function resolveBackupDirAbs(app) {
  const backupDir = readAppBackupDir(app);
  if (!backupDir) return null;
  return resolveAbsoluteOrProjectPath(backupDir);
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

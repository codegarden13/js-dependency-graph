import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { isInsideRoot, normalizeFsPath, normalizeRelPosix } from "../fsPaths.js";
import { normalizeId } from "../stringUtils.js";

const EXCLUDED_DIR_BASENAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".cache",
  ".turbo",
  ".vite"
]);

const EXCLUDED_REL_DIR_PREFIXES = [
  "app/public/output",
  "public/output"
];

const MEDIA_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".bmp",
  ".tif",
  ".tiff",
  ".ico",
  ".avif",
  ".heic",
  ".mp3",
  ".wav",
  ".ogg",
  ".oga",
  ".flac",
  ".aac",
  ".m4a",
  ".mp4",
  ".m4v",
  ".mov",
  ".avi",
  ".mkv",
  ".webm",
  ".mpg",
  ".mpeg",
  ".3gp"
]);

const ARCHIVE_EXTS = new Set([
  ".zip",
  ".7z",
  ".rar",
  ".tar",
  ".gz",
  ".tgz",
  ".bz2",
  ".xz"
]);

function normalizeTimestampToken(timestampIso) {
  return String(timestampIso || new Date().toISOString())
    .replace(/[:.]/g, "-")
    .trim();
}

export function normalizeFreezeIdToken(appId) {
  return String(normalizeId(appId) || "app");
}

function buildFreezeFilename(appId, timestampIso) {
  const safeAppId = normalizeFreezeIdToken(appId);
  return `${safeAppId}-${normalizeTimestampToken(timestampIso)}-freeze.zip`;
}

function normalizeRelPathToken(relPath) {
  return normalizeRelPosix(String(relPath || ""))
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .trim();
}

function toRelPosix(rootAbs, absPath) {
  return normalizeRelPathToken(path.relative(rootAbs, absPath));
}

function safeReadDir(absDir) {
  try {
    return fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isMediaRelPath(relPath) {
  return MEDIA_EXTS.has(String(path.extname(relPath || "")).toLowerCase());
}

function isArchiveRelPath(relPath) {
  return ARCHIVE_EXTS.has(String(path.extname(relPath || "")).toLowerCase());
}

function buildExcludedRelPrefixes(projectRootAbs, backupDirAbs) {
  const out = new Set(EXCLUDED_REL_DIR_PREFIXES.map(normalizeRelPathToken));

  if (backupDirAbs && isInsideRoot(projectRootAbs, backupDirAbs)) {
    const backupRel = normalizeRelPathToken(toRelPosix(projectRootAbs, backupDirAbs));
    if (backupRel) out.add(backupRel);
  }

  return out;
}

function isInsideExcludedPrefix(relPath, excludedPrefixes) {
  const rel = normalizeRelPathToken(relPath);
  if (!rel) return false;

  for (const prefix of excludedPrefixes || []) {
    if (!prefix) continue;
    if (rel === prefix) return true;
    if (rel.startsWith(`${prefix}/`)) return true;
  }

  return false;
}

function shouldSkipDirectory(entryName, relDirPath, excludedPrefixes) {
  if (EXCLUDED_DIR_BASENAMES.has(String(entryName || ""))) return true;
  return isInsideExcludedPrefix(relDirPath, excludedPrefixes);
}

function shouldIncludeFile(relFilePath, excludedPrefixes) {
  if (isInsideExcludedPrefix(relFilePath, excludedPrefixes)) return false;
  if (isMediaRelPath(relFilePath)) return false;
  if (isArchiveRelPath(relFilePath)) return false;
  return true;
}

function compareDirentsByName(a, b) {
  return String(a?.name || "").localeCompare(String(b?.name || ""), "de");
}

function collectFreezeFiles({ projectRootAbs, backupDirAbs }) {
  const projectRoot = normalizeFsPath(projectRootAbs);
  const excludedPrefixes = buildExcludedRelPrefixes(projectRoot, backupDirAbs);
  const relFiles = [];

  function walk(absDir) {
    const entries = safeReadDir(absDir).sort(compareDirentsByName);

    for (const entry of entries) {
      const name = String(entry?.name || "");
      if (!name) continue;

      const absPath = path.join(absDir, name);
      const relPath = toRelPosix(projectRoot, absPath);
      if (!relPath) continue;

      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (shouldSkipDirectory(name, relPath, excludedPrefixes)) continue;
        walk(absPath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (!shouldIncludeFile(relPath, excludedPrefixes)) continue;

      relFiles.push(relPath);
    }
  }

  walk(projectRoot);
  return relFiles.sort((a, b) => a.localeCompare(b, "de"));
}

function runZipCreate({ projectRootAbs, zipFileAbs, relFiles }) {
  if (!Array.isArray(relFiles) || relFiles.length === 0) {
    throw new Error("Freeze backup contains no includable files.");
  }

  const zipInput = `${relFiles.join("\n")}\n`;
  const result = spawnSync("zip", [zipFileAbs, "-q", "-@"], {
    cwd: projectRootAbs,
    input: zipInput,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });

  if (result.error) {
    if (result.error.code === "ENOENT") {
      throw new Error("Cannot create freeze backup because the 'zip' command is not available.");
    }
    throw result.error;
  }

  if (result.status !== 0) {
    const stderr = String(result.stderr || result.stdout || "zip failed").trim();
    throw new Error(stderr || "zip failed");
  }
}

function requireExistingProjectRoot(projectRootAbs) {
  const rootAbs = normalizeFsPath(projectRootAbs);
  if (!rootAbs) throw new Error("Missing projectRootAbs for freeze backup.");
  if (!fs.existsSync(rootAbs) || !fs.statSync(rootAbs).isDirectory()) {
    throw new Error(`Freeze project root does not exist or is not a directory: ${rootAbs}`);
  }
  return rootAbs;
}

function requireBackupDir(backupDirAbs) {
  const dirAbs = normalizeFsPath(backupDirAbs);
  if (!dirAbs) throw new Error("Missing backupDir for freeze backup.");
  fs.mkdirSync(dirAbs, { recursive: true });
  return dirAbs;
}

export function createProjectFreeze({ appId, projectRootAbs, backupDirAbs, timestampIso }) {
  const projectRoot = requireExistingProjectRoot(projectRootAbs);
  const backupDir = requireBackupDir(backupDirAbs);

  const zipFilename = buildFreezeFilename(appId, timestampIso);
  const zipPath = path.join(backupDir, zipFilename);
  const relFiles = collectFreezeFiles({
    projectRootAbs: projectRoot,
    backupDirAbs: backupDir
  });

  fs.rmSync(zipPath, { force: true });
  runZipCreate({
    projectRootAbs: projectRoot,
    zipFileAbs: zipPath,
    relFiles
  });

  return {
    zipFilename,
    zipPath,
    backupDir,
    fileCount: relFiles.length,
    createdAt: String(timestampIso || new Date().toISOString()),
    excludedMedia: true
  };
}

export function findLatestProjectFreeze({ appId, backupDirAbs }) {
  const backupDir = normalizeFsPath(backupDirAbs);
  if (!backupDir) return null;
  if (!fs.existsSync(backupDir) || !fs.statSync(backupDir).isDirectory()) return null;

  const prefix = `${normalizeFreezeIdToken(appId)}-`;
  const suffix = "-freeze.zip";

  const names = safeReadDir(backupDir)
    .filter((entry) => entry?.isFile?.())
    .map((entry) => String(entry.name || ""))
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
    .sort((a, b) => b.localeCompare(a, "de"));

  const zipFilename = names[0];
  if (!zipFilename) return null;

  const zipPath = path.join(backupDir, zipFilename);
  const stat = fs.statSync(zipPath);

  return {
    zipFilename,
    zipPath,
    sizeBytes: Number(stat.size || 0),
    modifiedAt: stat.mtime.toISOString()
  };
}

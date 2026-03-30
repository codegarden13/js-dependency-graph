import fs from "node:fs";
import path from "node:path";

import { normalizeFsPath } from "./fsPaths.js";
import { findLatestProjectFreeze } from "./analyze/projectFreeze.js";
import { readGitValue, runGit } from "./gitShell.js";

const COMMIT_HISTORY_MAX_BUFFER = 64 * 1024 * 1024;
const GIT_FIELD_SEPARATOR = "\x1f";
const GIT_RECORD_SEPARATOR = "\x1e";
const GIT_TIMELINE_MARKER = "@@@TIMELINE@@@";
const CODE_HISTORY_EXTS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"]);

function countNullSeparated(stdout) {
  if (!stdout) return 0;
  return String(stdout).split("\0").filter(Boolean).length;
}

function readGitHeadRecord(projectRootAbs) {
  const res = runGit(projectRootAbs, [
    "log",
    "-1",
    "--date=iso-strict",
    `--format=%H${GIT_FIELD_SEPARATOR}%h${GIT_FIELD_SEPARATOR}%cI`
  ]);

  if (!res.ok) return null;

  const [fullSha = "", shortSha = "", committedAt = ""] = String(res.stdout || "")
    .trim()
    .split(GIT_FIELD_SEPARATOR);

  if (!fullSha) return null;

  return {
    fullSha: String(fullSha || "").trim(),
    shortSha: String(shortSha || "").trim(),
    committedAt: String(committedAt || "").trim()
  };
}

function readGitTrackedFileCount(projectRootAbs) {
  const res = runGit(projectRootAbs, ["ls-files", "-z"]);
  if (!res.ok) return 0;
  return countNullSeparated(res.stdout);
}

function toIntegerOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function parseBranchHeader(line) {
  const header = String(line || "").replace(/^##\s*/, "").trim();
  if (!header) {
    return {
      branch: "",
      upstream: "",
      ahead: 0,
      behind: 0
    };
  }

  const bracketMatch = header.match(/\[(.+)\]\s*$/);
  const aheadBehindRaw = bracketMatch ? bracketMatch[1] : "";
  const branchPart = header.replace(/\s*\[.+\]\s*$/, "");
  const [branch = "", upstream = ""] = branchPart.split("...");

  const aheadMatch = aheadBehindRaw.match(/ahead\s+(\d+)/);
  const behindMatch = aheadBehindRaw.match(/behind\s+(\d+)/);

  return {
    branch: String(branch || "").trim(),
    upstream: String(upstream || "").trim(),
    ahead: toIntegerOrZero(aheadMatch?.[1]),
    behind: toIntegerOrZero(behindMatch?.[1])
  };
}

function isConflictStatus(x, y) {
  return x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
}

function parseGitStatus(stdout) {
  const lines = String(stdout || "").split(/\r?\n/).filter(Boolean);
  const branchInfo = parseBranchHeader(lines[0] || "");

  let stagedCount = 0;
  let modifiedCount = 0;
  let untrackedCount = 0;
  let conflictedCount = 0;

  for (const line of lines.slice(1)) {
    const x = line[0] || " ";
    const y = line[1] || " ";

    if (x === "?" && y === "?") {
      untrackedCount += 1;
      continue;
    }

    if (isConflictStatus(x, y)) {
      conflictedCount += 1;
    }

    if (x !== " " && x !== "?") stagedCount += 1;
    if (y !== " ") modifiedCount += 1;
  }

  return {
    branch: branchInfo.branch,
    upstream: branchInfo.upstream,
    ahead: branchInfo.ahead,
    behind: branchInfo.behind,
    dirty: lines.length > 1,
    stagedCount,
    modifiedCount,
    untrackedCount,
    conflictedCount
  };
}

function buildCommitRecord(fields) {
  const [
    fullSha = "",
    shortSha = "",
    authorName = "",
    authorEmail = "",
    authoredAt = "",
    subject = ""
  ] = fields;

  if (!fullSha) return null;

  return {
    fullSha,
    shortSha,
    authorName,
    authorEmail,
    authoredAt,
    subject
  };
}

function parseCommitHistory(stdout) {
  return String(stdout || "")
    .split(GIT_RECORD_SEPARATOR)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => buildCommitRecord(entry.split(GIT_FIELD_SEPARATOR)))
    .filter(Boolean);
}

function readCommitHistory(projectRootAbs) {
  const res = runGit(
    projectRootAbs,
    [
      "log",
      "--date=iso-strict",
      `--format=%H${GIT_FIELD_SEPARATOR}%h${GIT_FIELD_SEPARATOR}%an${GIT_FIELD_SEPARATOR}%ae${GIT_FIELD_SEPARATOR}%aI${GIT_FIELD_SEPARATOR}%s${GIT_RECORD_SEPARATOR}`
    ],
    { maxBuffer: COMMIT_HISTORY_MAX_BUFFER }
  );

  if (!res.ok) return [];
  return parseCommitHistory(res.stdout);
}

function normalizeNumstatPath(rawPath) {
  let text = String(rawPath || "").trim();
  if (!text) return "";

  text = text.replace(/\{([^{}]*?) => ([^{}]*?)\}/g, "$2");
  if (text.includes("=>")) {
    text = text.split("=>").pop() || text;
  }

  return String(text || "").trim().replace(/^"+|"+$/g, "");
}

function isCodeHistoryPath(filePath) {
  const ext = String(path.extname(normalizeNumstatPath(filePath) || "")).toLowerCase();
  return CODE_HISTORY_EXTS.has(ext);
}

function buildCommitTimelineRecord(fields, codeLines) {
  const [
    fullSha = "",
    shortSha = "",
    committedAt = "",
    subject = ""
  ] = fields;

  if (!fullSha) return null;

  return {
    fullSha: String(fullSha || "").trim(),
    shortSha: String(shortSha || "").trim(),
    committedAt: String(committedAt || "").trim(),
    subject: String(subject || "").trim(),
    codeLines: Math.max(0, Number(codeLines || 0))
  };
}

function parseCommitCodeLineHistory(stdout) {
  const lines = String(stdout || "").split(/\r?\n/);
  const history = [];
  let current = null;
  let codeLines = 0;

  for (const rawLine of lines) {
    const line = String(rawLine || "");
    if (!line.trim()) continue;

    if (line.startsWith(GIT_TIMELINE_MARKER)) {
      if (current) history.push(current);

      const fields = line.slice(GIT_TIMELINE_MARKER.length).split(GIT_FIELD_SEPARATOR);
      current = buildCommitTimelineRecord(fields, codeLines);
      continue;
    }

    if (!current) continue;

    const [addedRaw = "", deletedRaw = "", rawPath = ""] = line.split("\t");
    const added = Number(addedRaw);
    const deleted = Number(deletedRaw);
    if (!Number.isFinite(added) || !Number.isFinite(deleted)) continue;
    if (!isCodeHistoryPath(rawPath)) continue;

    codeLines = Math.max(0, codeLines + added - deleted);
    current.codeLines = codeLines;
  }

  if (current) history.push(current);
  return history.reverse();
}

function readCommitCodeLineHistory(projectRootAbs) {
  const res = runGit(
    projectRootAbs,
    [
      "log",
      "--reverse",
      "--first-parent",
      "--date=iso-strict",
      "--numstat",
      `--format=${GIT_TIMELINE_MARKER}%H${GIT_FIELD_SEPARATOR}%h${GIT_FIELD_SEPARATOR}%cI${GIT_FIELD_SEPARATOR}%s`
    ],
    { maxBuffer: COMMIT_HISTORY_MAX_BUFFER }
  );

  if (!res.ok) return [];
  return parseCommitCodeLineHistory(res.stdout);
}

function collectGitInfo(projectRootAbs) {
  const repoRootAbs = readGitValue(projectRootAbs, ["rev-parse", "--show-toplevel"]);
  if (!repoRootAbs) {
    return {
      available: false
    };
  }

  const status = parseGitStatus(
    readGitValue(projectRootAbs, ["status", "--short", "--branch"])
  );

  const headRecord = readGitHeadRecord(projectRootAbs);
  const fullSha = String(headRecord?.fullSha || readGitValue(projectRootAbs, ["rev-parse", "HEAD"]));
  const shortSha = String(headRecord?.shortSha || readGitValue(projectRootAbs, ["rev-parse", "--short", "HEAD"]));
  const branch =
    status.branch || readGitValue(projectRootAbs, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const commitCount = toIntegerOrZero(readGitValue(projectRootAbs, ["rev-list", "--count", "HEAD"]));
  const trackedFileCount = readGitTrackedFileCount(projectRootAbs);
  const remoteOriginUrl = readGitValue(projectRootAbs, ["remote", "get-url", "origin"]);
  const commits = readCommitHistory(projectRootAbs);
  const codeLineHistory = readCommitCodeLineHistory(projectRootAbs);
  const lastCommit = commits[0] || null;

  return {
    available: true,
    repoRootAbs: normalizeFsPath(repoRootAbs),
    branch: branch || "",
    upstream: status.upstream || "",
    ahead: status.ahead || 0,
    behind: status.behind || 0,
    remoteOriginUrl: remoteOriginUrl || "",
    head: {
      fullSha,
      shortSha,
      committedAt: String(headRecord?.committedAt || "")
    },
    commitCount,
    trackedFileCount,
    worktree: {
      dirty: Boolean(status.dirty),
      stagedCount: status.stagedCount || 0,
      modifiedCount: status.modifiedCount || 0,
      untrackedCount: status.untrackedCount || 0,
      conflictedCount: status.conflictedCount || 0
    },
    codeLineHistory,
    lastCommit,
    commits
  };
}

export function collectGitHeadInfo(projectRootAbs) {
  const repoRootAbs = readGitValue(projectRootAbs, ["rev-parse", "--show-toplevel"]);
  if (!repoRootAbs) {
    return {
      available: false,
      repoRootAbs: "",
      head: null
    };
  }

  const head = readGitHeadRecord(projectRootAbs);
  return {
    available: Boolean(head?.fullSha),
    repoRootAbs: normalizeFsPath(repoRootAbs),
    head: head || null
  };
}

function collectFreezeInfo(appId, backupDirAbs) {
  const backupDir = normalizeFsPath(backupDirAbs);
  const latest = backupDir ? findLatestProjectFreeze({ appId, backupDirAbs: backupDir }) : null;

  return {
    backupDir: backupDir || "",
    latest
  };
}

export function collectAppInfo({ app, appRootAbs, backupDirAbs }) {
  const rootAbs = normalizeFsPath(appRootAbs);

  return {
    app: {
      id: String(app?.id || ""),
      name: String(app?.name || app?.id || ""),
      url: String(app?.url || ""),
      entry: String(app?.entry || ""),
      rootDir: String(app?.rootDir || app?.root || app?.path || ""),
      appRootAbs: rootAbs,
      backupDir: String(backupDirAbs || "")
    },
    rootExists: Boolean(rootAbs && fs.existsSync(rootAbs)),
    git: rootAbs ? collectGitInfo(rootAbs) : { available: false },
    freeze: collectFreezeInfo(app?.id, backupDirAbs)
  };
}

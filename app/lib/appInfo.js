import fs from "node:fs";
import { spawnSync } from "node:child_process";

import { normalizeFsPath } from "./fsPaths.js";
import { findLatestProjectFreeze } from "./analyze/projectFreeze.js";

function runGit(projectRootAbs, args) {
  const res = spawnSync("git", args, {
    cwd: projectRootAbs,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024
  });

  if (res.error) {
    return {
      ok: false,
      stdout: String(res.stdout || ""),
      stderr: String(res.error.message || "")
    };
  }

  if (res.status !== 0) {
    return {
      ok: false,
      stdout: String(res.stdout || ""),
      stderr: String(res.stderr || res.stdout || "").trim()
    };
  }

  return {
    ok: true,
    stdout: String(res.stdout || ""),
    stderr: String(res.stderr || "")
  };
}

function readGitValue(projectRootAbs, args) {
  const res = runGit(projectRootAbs, args);
  if (!res.ok) return "";
  return String(res.stdout || "").trim();
}

function countNullSeparated(stdout) {
  if (!stdout) return 0;
  return String(stdout).split("\0").filter(Boolean).length;
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

function parseLastCommit(stdout) {
  const [
    fullSha = "",
    shortSha = "",
    authorName = "",
    authorEmail = "",
    authoredAt = "",
    subject = ""
  ] = String(stdout || "").split(/\r?\n/);

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

  const fullSha = readGitValue(projectRootAbs, ["rev-parse", "HEAD"]);
  const shortSha = readGitValue(projectRootAbs, ["rev-parse", "--short", "HEAD"]);
  const branch =
    status.branch || readGitValue(projectRootAbs, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const commitCount = toIntegerOrZero(readGitValue(projectRootAbs, ["rev-list", "--count", "HEAD"]));
  const trackedFileCount = readGitTrackedFileCount(projectRootAbs);
  const remoteOriginUrl = readGitValue(projectRootAbs, ["remote", "get-url", "origin"]);
  const lastCommit = parseLastCommit(
    readGitValue(
      projectRootAbs,
      ["log", "-1", "--date=iso-strict", "--format=%H%n%h%n%an%n%ae%n%aI%n%s"]
    )
  );

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
      shortSha
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
    lastCommit
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

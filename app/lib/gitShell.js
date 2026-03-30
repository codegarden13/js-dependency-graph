import { spawnSync } from "node:child_process";

export const DEFAULT_GIT_MAX_BUFFER = 8 * 1024 * 1024;

export function runGit(projectRootAbs, args, { maxBuffer = DEFAULT_GIT_MAX_BUFFER } = {}) {
  const result = spawnSync("git", args, {
    cwd: projectRootAbs,
    encoding: "utf8",
    maxBuffer
  });

  if (result.error) {
    return {
      ok: false,
      stdout: String(result.stdout || ""),
      stderr: String(result.error.message || "")
    };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      stdout: String(result.stdout || ""),
      stderr: String(result.stderr || result.stdout || "").trim()
    };
  }

  return {
    ok: true,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || "")
  };
}

export function readGitValue(projectRootAbs, args, options) {
  const result = runGit(projectRootAbs, args, options);
  if (!result.ok) return "";
  return String(result.stdout || "").trim();
}

export function hasGitRepo(projectRootAbs) {
  return runGit(projectRootAbs, ["rev-parse", "--show-toplevel"]).ok;
}

export function runGitOrThrow(projectRootAbs, args, {
  maxBuffer = DEFAULT_GIT_MAX_BUFFER,
  fallbackMessage = "git command failed"
} = {}) {
  const result = runGit(projectRootAbs, args, { maxBuffer });
  if (!result.ok) {
    const stderr = String(result.stderr || result.stdout || fallbackMessage).trim();
    throw new Error(stderr || fallbackMessage);
  }

  return String(result.stdout || "");
}

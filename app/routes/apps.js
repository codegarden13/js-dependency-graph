import express from "express";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import {
  loadAppsConfig,
  findAppById,
  resolveAppRootAbs,
  resolveBackupDirAbs,
  resolveEntryAbs
} from "../lib/appsRegistry.js";
import { normalizeFsPath } from "../lib/fsPaths.js";
import { collectAppInfo } from "../lib/appInfo.js";

const router = express.Router();

function safeLoadAppsConfig() {
  try {
    return loadAppsConfig();
  } catch {
    return [];
  }
}

function listAppPayload(app) {
  return {
    id: String(app?.id || ""),
    name: String(app?.name || app?.id || ""),
    rootDir: String(app?.rootDir || app?.root || app?.path || ""),
    entry: String(app?.entry || ""),
    url: String(app?.url || ""),
    backupDir: String(resolveBackupDirAbs(app) || "")
  };
}

function sendAppNotFound(res, appId) {
  return res.status(404).json({
    error: {
      message: `Unknown appId: ${String(appId || "")}`
    }
  });
}

function sendInvalidRoot(res, appRootAbs) {
  return res.status(400).json({
    error: {
      message: `App root does not exist or is not a directory: ${String(appRootAbs || "")}`
    }
  });
}

function resolveRestartApp(req) {
  const apps = loadAppsConfig();
  const appId = String(req.params.appId || req.body?.appId || "").trim();
  const app = findAppById(apps, appId);
  if (!app) return { appId, app: null, appRootAbs: null };

  const appRootAbs = resolveAppRootAbs(app);
  return { appId, app, appRootAbs };
}

function readPackageJson(appRootAbs) {
  try {
    return JSON.parse(fs.readFileSync(path.join(appRootAbs, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function readStartCommand(app, appRootAbs) {
  const pkg = readPackageJson(appRootAbs);
  const scripts = pkg?.scripts || {};

  if (typeof scripts.dev === "string" && scripts.dev.trim()) {
    return { command: "npm", args: ["run", "dev"], label: "npm run dev" };
  }

  if (typeof scripts.start === "string" && scripts.start.trim()) {
    return { command: "npm", args: ["run", "start"], label: "npm run start" };
  }

  const entryAbs = resolveEntryAbs(appRootAbs, app);
  if (!entryAbs) return null;

  const entryRel = path.relative(appRootAbs, entryAbs) || path.basename(entryAbs);
  return { command: process.execPath || "node", args: [entryRel], label: `node ${entryRel}` };
}

function readPortFromUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    const explicitPort = Number(parsed.port || 0);
    if (Number.isInteger(explicitPort) && explicitPort > 0) return explicitPort;
    return parsed.protocol === "https:" ? 443 : 80;
  } catch {
    return 0;
  }
}

function listPidsForPort(port) {
  const safePort = Number(port || 0);
  if (!Number.isInteger(safePort) || safePort <= 0) return [];

  try {
    const result = spawnSync("lsof", ["-ti", `tcp:${safePort}`], { encoding: "utf8" });
    return String(result.stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line, index, all) => all.indexOf(line) === index);
  } catch {
    return [];
  }
}

function stopProcessesForPort(port) {
  const pids = listPidsForPort(port);

  for (const pid of pids) {
    try {
      spawnSync("kill", ["-TERM", pid], { encoding: "utf8" });
    } catch { }
  }

  return pids;
}

function startDetachedProcess(startCommand, appRootAbs) {
  const child = spawn(startCommand.command, startCommand.args, {
    cwd: appRootAbs,
    detached: true,
    stdio: "ignore"
  });

  child.unref();
  return Number(child.pid || 0);
}

function isSelfRestart(appRootAbs) {
  return normalizeFsPath(appRootAbs) === normalizeFsPath(process.cwd());
}

function sendRestartUnavailable(res, message) {
  return res.status(409).json({
    error: {
      message: String(message || "Restart is not available.")
    }
  });
}

function sendRestartBadRequest(res, message) {
  return res.status(400).json({
    error: {
      message: String(message || "Restart could not be prepared.")
    }
  });
}

function buildRestartResponse(appId, port, stoppedPids, startCommand, childPid) {
  const restarted = stoppedPids.length > 0;

  return {
    status: restarted ? "restarting" : "starting",
    message: restarted ? "Restart requested." : "Start requested.",
    appId,
    port,
    stoppedPids,
    command: String(startCommand?.label || ""),
    pid: childPid
  };
}

function handleRestartRequest(req, res) {
  try {
    const { appId, app, appRootAbs } = resolveRestartApp(req);
    if (!app) return sendAppNotFound(res, appId);
    if (!appRootAbs || !fs.existsSync(appRootAbs) || !fs.statSync(appRootAbs).isDirectory()) {
      return sendInvalidRoot(res, appRootAbs);
    }
    if (isSelfRestart(appRootAbs)) {
      return sendRestartUnavailable(res, "Restarting the currently running NodeAnalyzer server from inside itself is blocked.");
    }

    const startCommand = readStartCommand(app, appRootAbs);
    if (!startCommand) {
      return sendRestartBadRequest(res, "No start command could be derived from package.json or entry file.");
    }

    const port = readPortFromUrl(app?.url);
    const stoppedPids = stopProcessesForPort(port);
    const childPid = startDetachedProcess(startCommand, appRootAbs);

    return res.json(buildRestartResponse(appId, port, stoppedPids, startCommand, childPid));
  } catch (err) {
    return res.status(500).json({
      error: {
        message: String(err?.message || err || "Could not restart app")
      }
    });
  }
}

router.get("/apps", (req, res) => {
  const apps = safeLoadAppsConfig().map(listAppPayload);
  res.json({ apps });
});

router.get("/apps/:appId/info", (req, res) => {
  try {
    const apps = loadAppsConfig();
    const app = findAppById(apps, req.params.appId);
    if (!app) return sendAppNotFound(res, req.params.appId);

    const appRootAbs = resolveAppRootAbs(app);
    if (!appRootAbs || !fs.existsSync(appRootAbs) || !fs.statSync(appRootAbs).isDirectory()) {
      return sendInvalidRoot(res, appRootAbs);
    }

    const backupDirAbs = resolveBackupDirAbs(app);
    return res.json(collectAppInfo({ app, appRootAbs, backupDirAbs }));
  } catch (err) {
    return res.status(500).json({
      error: {
        message: String(err?.message || err || "Could not load app info")
      }
    });
  }
});

router.post("/restart", handleRestartRequest);
router.post("/apps/restart", handleRestartRequest);
router.post("/apps/:appId/restart", handleRestartRequest);

export default router;

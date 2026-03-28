import express from "express";
import fs from "node:fs";

import {
  loadAppsConfig,
  findAppById,
  resolveAppRootAbs,
  resolveBackupDirAbs
} from "../lib/appsRegistry.js";
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

export default router;

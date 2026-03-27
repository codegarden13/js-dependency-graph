import express from "express";
import fs from "node:fs";

import {
  loadAppsConfig,
  findAppById,
  resolveAppRootAbs,
  resolveBackupDirAbs
} from "../lib/appsRegistry.js";
import { normalizeId } from "../lib/stringUtils.js";
import { createProjectFreeze } from "../lib/analyze/projectFreeze.js";

const router = express.Router();

function getRequestedAppId(req) {
  return normalizeId(req?.body?.appId);
}

function sendBadRequest(res, message) {
  return res.status(400).json({
    error: {
      message: String(message || "Bad Request")
    }
  });
}

function sendServerError(res, err) {
  return res.status(500).json({
    error: {
      message: String(err?.message || err || "Freeze failed")
    }
  });
}

function resolveRequestedApp(appId) {
  if (!appId) {
    return {
      ok: false,
      status: 400,
      message: "Missing appId"
    };
  }

  const apps = loadAppsConfig();
  const app = findAppById(apps, appId);
  if (!app) {
    return {
      ok: false,
      status: 404,
      message: `Unknown appId: ${appId}`
    };
  }

  return {
    ok: true,
    app
  };
}

function resolveFreezeTarget(app) {
  const appRootAbs = resolveAppRootAbs(app);
  if (!appRootAbs || !fs.existsSync(appRootAbs) || !fs.statSync(appRootAbs).isDirectory()) {
    return {
      ok: false,
      status: 400,
      message: `App root does not exist or is not a directory: ${String(appRootAbs || "")}`
    };
  }

  const backupDirAbs = resolveBackupDirAbs(app);
  if (!backupDirAbs) {
    return {
      ok: false,
      status: 400,
      message: "App config is missing backupDir/backupPath/freezeDir."
    };
  }

  return {
    ok: true,
    appRootAbs,
    backupDirAbs
  };
}

router.post("/freeze", (req, res) => {
  try {
    const appId = getRequestedAppId(req);
    const appResult = resolveRequestedApp(appId);
    if (!appResult.ok) {
      if (appResult.status === 404) {
        return res.status(404).json({ error: { message: appResult.message } });
      }
      return sendBadRequest(res, appResult.message);
    }

    const targetResult = resolveFreezeTarget(appResult.app);
    if (!targetResult.ok) {
      return sendBadRequest(res, targetResult.message);
    }

    const timestampIso = new Date().toISOString();
    const freeze = createProjectFreeze({
      appId,
      projectRootAbs: targetResult.appRootAbs,
      backupDirAbs: targetResult.backupDirAbs,
      timestampIso
    });

    return res.json({
      appId,
      message: "Freeze created.",
      freeze
    });
  } catch (err) {
    return sendServerError(res, err);
  }
});

export default router;

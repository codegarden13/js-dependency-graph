import express from "express";
import fs from "node:fs";

import {
  resolveAppRootAbs,
  resolveBackupDirAbs
} from "../lib/appsRegistry.js";
import { createProjectFreeze } from "../lib/analyze/projectFreeze.js";
import {
  resolveConfiguredApp,
  sendBadRequest,
  sendJsonError,
  sendServerError
} from "../lib/requestNormalization.js";

const router = express.Router();

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
    const appResult = resolveConfiguredApp(req?.body?.appId, { notFoundStatus: 404 });
    if (!appResult.ok) {
      return sendJsonError(res, appResult.status, appResult.message);
    }

    const targetResult = resolveFreezeTarget(appResult.app);
    if (!targetResult.ok) {
      return sendBadRequest(res, targetResult.message);
    }

    const timestampIso = new Date().toISOString();
    const freeze = createProjectFreeze({
      appId: appResult.appId,
      projectRootAbs: targetResult.appRootAbs,
      backupDirAbs: targetResult.backupDirAbs,
      timestampIso
    });

    return res.json({
      appId: appResult.appId,
      message: "Freeze created.",
      freeze
    });
  } catch (err) {
    return sendServerError(res, err, "Freeze failed");
  }
});

export default router;

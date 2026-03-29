import express from "express";
import fs from "node:fs";

import { resolveAppRootAbs } from "../lib/appsRegistry.js";
import { getScreenshotJob, startScreenshotJob } from "../lib/screenshotJobs.js";
import {
  resolveConfiguredApp,
  sendBadRequest,
  sendServerError,
  sendJsonError
} from "../lib/requestNormalization.js";

const router = express.Router();

function resolveScreenshotApp(req) {
  return resolveConfiguredApp(req?.params?.appId || req?.body?.appId, { notFoundStatus: 400 });
}

function validateScreenshotRoot(app) {
  const appRootAbs = resolveAppRootAbs(app);
  if (!appRootAbs) return { ok: false, message: "Configured app root is missing." };
  if (!fs.existsSync(appRootAbs)) return { ok: false, message: `App root does not exist: ${appRootAbs}` };
  if (!fs.statSync(appRootAbs).isDirectory()) return { ok: false, message: `App root is not a directory: ${appRootAbs}` };

  return { ok: true, appRootAbs };
}

async function handleCreateScreenshots(req, res) {
  try {
    const appResult = resolveScreenshotApp(req);
    if (!appResult.ok) return sendBadRequest(res, appResult.message);

    const rootResult = validateScreenshotRoot(appResult.app);
    if (!rootResult.ok) return sendBadRequest(res, rootResult.message);

    const job = startScreenshotJob({
      appId: appResult.appId,
      app: appResult.app,
      appRootAbs: rootResult.appRootAbs
    });

    return res.status(202).json({
      status: "queued",
      appId: appResult.appId,
      jobId: String(job.jobId || ""),
      job
    });
  } catch (error) {
    const message = String(error?.message || error || "Could not start screenshot job");
    if (message.includes("Puppeteer is not installed")) {
      return sendJsonError(res, 501, message, "Puppeteer is not installed in NodeAnalyzer");
    }
    return sendServerError(res, error, "Could not start screenshot job");
  }
}

function handleGetScreenshotJob(req, res) {
  const job = getScreenshotJob(req?.params?.jobId);
  if (!job) {
    return sendJsonError(res, 404, "Screenshot job not found.", "Screenshot job not found.");
  }
  return res.json(job);
}

router.post("/screenshots", handleCreateScreenshots);
router.post("/apps/:appId/screenshots", handleCreateScreenshots);
router.get("/screenshots/jobs/:jobId", handleGetScreenshotJob);

export default router;

import express from "express";

import { loadAppsConfig } from "../lib/appsRegistry.js";
import { buildPortfolioHistory } from "../lib/analyze/portfolioHistory.js";

const router = express.Router();

function safeLoadAppsConfig() {
  try {
    return loadAppsConfig();
  } catch {
    return [];
  }
}

function buildRequestUrl(req) {
  const host = String(req.get("x-forwarded-host") || req.get("host") || "")
    .split(",")[0]
    .trim();
  const protocol = String(req.get("x-forwarded-proto") || req.protocol || "http")
    .split(",")[0]
    .trim()
    .toLowerCase();
  const pathname = String(req.originalUrl || req.url || "/").trim() || "/";

  if (!host) return "";

  try {
    return new URL(pathname, `${protocol}://${host}`).toString();
  } catch {
    return "";
  }
}

router.get("/projects-overview", async (req, res) => {
  try {
    const apps = safeLoadAppsConfig();
    return res.json(await buildPortfolioHistory(apps, { requestUrl: buildRequestUrl(req) }));
  } catch (err) {
    return res.status(500).json({
      error: {
        message: String(err?.message || err || "Could not build projects overview")
      }
    });
  }
});

export default router;

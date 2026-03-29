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

router.get("/projects-overview", async (req, res) => {
  try {
    const apps = safeLoadAppsConfig();
    return res.json(await buildPortfolioHistory(apps));
  } catch (err) {
    return res.status(500).json({
      error: {
        message: String(err?.message || err || "Could not build projects overview")
      }
    });
  }
});

export default router;

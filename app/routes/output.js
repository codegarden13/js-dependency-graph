import fs from "fs/promises";
import express from "express";

import { OUTPUT_DIR } from "../lib/projectPaths.js";

const router = express.Router();

/**
 * List analyzer output files for a given app id.
 *
 * Intended for the frontend time-view chart, which needs all historic
 * `code-metrics.csv` snapshots belonging to the currently selected app.
 *
 * Query params:
 * - `appId` (required): configured app id, e.g. `nodeanalyzer`
 * - `type`  (optional): output suffix prefix before `.csv`, defaults to
 *   `code-metrics`
 */
router.get("/output-files", async (req, res) => {
  const { appId, type = "code-metrics", ext = "csv" } = req.query;

  if (!appId) {
    return res.status(400).json({ error: "appId required" });
  }

  let files;
  try {
    files = await fs.readdir(OUTPUT_DIR);
  } catch (error) {
    console.error("[output-files] Failed to read output directory:", OUTPUT_DIR, error);
    return res.status(500).json({
      error: "Could not read analyzer output directory.",
      outputDir: OUTPUT_DIR,
    });
  }

  const result = files
    .filter((file) => file.startsWith(`${appId}-`) && file.endsWith(`${type}.${String(ext || "csv")}`))
    .sort();

  res.json(result);
});

export default router;

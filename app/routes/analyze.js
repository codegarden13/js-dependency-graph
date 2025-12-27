import express from "express";
import path from "node:path";
import fs from "node:fs";

import { buildMetricsFromEntrypoint } from "../lib/buildMetricsFromEntrypoint.js";
import { probeAppUrl } from "../lib/probeAppUrl.js";

const router = express.Router();

const DEFAULT_ENTRY_PATH = "app/server.js";

/**
 * Load app registry config.
 * Source of truth: app/config/apps.json
 */
function loadAppsConfig() {
  const cfgPath = path.join(process.cwd(), "app/config/apps.json");
  if (!fs.existsSync(cfgPath)) return { apps: [] };
  return JSON.parse(fs.readFileSync(cfgPath, "utf8"));
}

router.post("/analyze", async (req, res) => {
  try {
    // ------------------------------------------------------------
    // 1) Normalize inputs
    // ------------------------------------------------------------
    let { appId, entryPath, appUrl } = req.body || {};

    const analyzerRoot = process.cwd(); // where NodeAnalyzer runs

    // Determine targetRoot/entryPath/appUrl:
    // - If appId provided, use registry (preferred)
    // - Else fallback to manual mode (analyze NodeAnalyzer itself by default)
    let targetRoot = analyzerRoot;

    if (appId && typeof appId === "string") {
      const cfg = loadAppsConfig();
      const app = (cfg.apps || []).find(a => a.id === appId);

      if (!app) {
        return res.status(400).send(`Unknown appId: ${appId}`);
      }

      targetRoot = String(app.rootDir || "").trim();
      entryPath = String(app.entry || "").trim();
      appUrl = String(app.url || "").trim() || null;

      if (!targetRoot) {
        return res.status(400).send(`Missing rootDir for appId: ${appId}`);
      }
      if (!entryPath) {
        return res.status(400).send(`Missing entry for appId: ${appId}`);
      }
    } else {
      // manual mode: default to analyzing NodeAnalyzer itself
      if (!entryPath || typeof entryPath !== "string" || !entryPath.trim()) {
        entryPath = DEFAULT_ENTRY_PATH;
      }
      if (typeof appUrl === "string") appUrl = appUrl.trim();
      if (!appUrl) appUrl = null;
    }

    // ------------------------------------------------------------
    // 2) Resolve + validate entrypoint under targetRoot
    // ------------------------------------------------------------
    const targetRootAbs = path.resolve(targetRoot);
    const entryAbs = path.isAbsolute(entryPath)
      ? path.normalize(entryPath)
      : path.resolve(targetRootAbs, entryPath);

    // Safety boundary: entry must be inside the selected app root
    if (!entryAbs.startsWith(targetRootAbs + path.sep) && entryAbs !== targetRootAbs) {
      return res.status(400).send("entryPath outside target app rootDir");
    }

    if (!fs.existsSync(entryAbs)) {
      return res.status(400).send(`entryPath does not exist: ${entryAbs}`);
    }
    if (!fs.statSync(entryAbs).isFile()) {
      return res.status(400).send(`entryPath is not a file: ${entryAbs}`);
    }

    // ------------------------------------------------------------
    // 3) Optional URL probe (metadata only)
    // ------------------------------------------------------------
    const urlInfo = appUrl ? await probeAppUrl(appUrl) : null;

    // ------------------------------------------------------------
    // 4) Analyze using *targetRoot* (not analyzerRoot)
    // ------------------------------------------------------------
    const metrics = await buildMetricsFromEntrypoint({
      projectRoot: targetRootAbs,
      entryAbs,
      urlInfo
    });

    // ------------------------------------------------------------
    // 5) Persist output under NodeAnalyzer public/output
    // ------------------------------------------------------------
    const outputFile = path.join(
      analyzerRoot,
      "app/public/output/code-structure.json"
    );

    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, JSON.stringify(metrics, null, 2), "utf8");

    // ------------------------------------------------------------
    // 6) Respond
    // ------------------------------------------------------------
    return res.json({
      metricsUrl: "/output/code-structure.json",
      analyzedAppId: appId || null,
      targetRoot: targetRootAbs,
      entryUsed: entryAbs,
      summary: { nodes: metrics.nodes.length, links: metrics.links.length }
    });
  } catch (err) {
    return res.status(500).send(err?.stack || String(err));
  }
});

export default router;
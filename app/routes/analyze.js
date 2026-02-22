import express from "express";
import path from "node:path";
import fs from "node:fs";

import { buildMetricsFromEntrypoint } from "../lib/buildMetricsFromEntrypoint.js";
import { probeAppUrl } from "../lib/probeAppUrl.js";

const router = express.Router();

// Fallback entrypoint candidates (used when entry is missing or invalid)
const ENTRY_CANDIDATES = [
  "app/server.js",
  "app/index.js",
  "src/server.js",
  "src/index.js",
  "server.js",
  "index.js"
];

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
      // Note: entry is NOT stored in config (by design). We always resolve via
      // request-provided entryPath (optional) or fallback candidates.
      if (typeof entryPath === "string") entryPath = entryPath.trim();
      else entryPath = "";

      appUrl = String(app.url || "").trim() || null;

      if (!targetRoot) {
        return res.status(400).send(`Missing rootDir for appId: ${appId}`);
      }
    } else {
      // manual mode: default to analyzing NodeAnalyzer itself
      if (typeof entryPath === "string") entryPath = entryPath.trim();
      else entryPath = ""; // will be resolved via fallback candidates
      if (typeof appUrl === "string") appUrl = appUrl.trim();
      if (!appUrl) appUrl = null;
    }

    // ------------------------------------------------------------
    // 2) Resolve + validate entrypoint under targetRoot
    // ------------------------------------------------------------
    const targetRootAbs = path.resolve(targetRoot);

    // ------------------------------------------------------------
    // Resolve entrypoint (explicit entry OR fallback candidates)
    // ------------------------------------------------------------
    let effectiveEntryAbs = null;

    // 1) If entryPath provided, try it first
    if (entryPath) {
      const candidate = path.isAbsolute(entryPath)
        ? path.normalize(entryPath)
        : path.resolve(targetRootAbs, entryPath);

      if (
        candidate.startsWith(targetRootAbs + path.sep) &&
        fs.existsSync(candidate) &&
        fs.statSync(candidate).isFile()
      ) {
        effectiveEntryAbs = candidate;
      }
    }

    // 2) If no valid explicit entry, try fallback candidates
    if (!effectiveEntryAbs) {
      for (const rel of ENTRY_CANDIDATES) {
        const candidate = path.resolve(targetRootAbs, rel);
        if (!candidate.startsWith(targetRootAbs + path.sep)) continue;
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          effectiveEntryAbs = candidate;
          entryPath = rel;
          break;
        }
      }
    }

    if (!effectiveEntryAbs) {
      return res.status(400).send(
        `No valid entrypoint found under ${targetRootAbs}. ` +
        `Tried request entryPath (if any) and fallback candidates: ${ENTRY_CANDIDATES.join(", ")}`
      );
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
      entryAbs: effectiveEntryAbs,
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
      entryUsed: effectiveEntryAbs,
      entryRel: entryPath || null,
      summary: { nodes: metrics.nodes.length, links: metrics.links.length }
    });
  } catch (err) {
    return res.status(500).send(err?.stack || String(err));
  }
});

export default router;
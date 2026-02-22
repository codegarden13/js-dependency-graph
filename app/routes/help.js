/**
 * Help Markdown Route
 * ===================
 *
 * Purpose
 * -------
 * The frontend has a "Help" button that opens a floating panel.
 * This route returns the markdown content for that panel.
 *
 * Contract
 * --------
 * GET /help
 *   -> { found: true, helpPath: string, markdown: string }
 *   -> { found: false }
 *
 * Notes
 * -----
 * - This route is intentionally NOT the "nearest README" logic.
 *   That behavior belongs to `GET /readme?file=...`.
 * - This route always serves a single, project-owned help file:
 *     app/public/readme.md (case-insensitive fallback)
 */

import express from "express";
import path from "node:path";
import fs from "node:fs";

const router = express.Router();

function findHelpFileAbs(projectRoot) {
  // Primary file (as you described): app/public/readme.md
  // Fallback (case variants for different OS / git histories)
  const candidates = [
    path.resolve(projectRoot, "app/public/readme.md"),
    path.resolve(projectRoot, "app/public/README.md"),
  ];

  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch {
      // Ignore FS race/permission errors and keep trying candidates.
    }
  }

  return null;
}

router.get("/help", (req, res) => {
  try {
    const projectRoot = process.cwd();

    const fileAbs = findHelpFileAbs(projectRoot);
    if (!fileAbs) {
      // Keep response shape stable for the UI.
      return res.json({ found: false });
    }

    const markdown = fs.readFileSync(fileAbs, "utf8");
    const helpPath = path.relative(projectRoot, fileAbs).replace(/\\/g, "/");

    // Helpful for dev tooling; you can remove if you prefer.
    res.setHeader("Cache-Control", "no-store");

    return res.json({
      found: true,
      helpPath,
      markdown,
    });
  } catch (err) {
    return res.status(500).send(err?.stack || String(err));
  }
});

export default router;
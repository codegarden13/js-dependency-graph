/**
 * README Lookup Route
 * ===================
 *
 * GET /readme?file=<relative-path>
 *
 * Behavior
 * --------
 * 1) If file points to the global help doc (app/public/readme.md), return it.
 * 2) Otherwise: find the nearest README in the file's directory and parents.
 *
 * Response
 * --------
 * { found: true, readmePath: string, markdown: string }
 * { found: false }
 */

import express from "express";
import path from "node:path";
import fs from "node:fs";

const router = express.Router();

router.get("/readme", (req, res) => {
  try {
    const projectRoot = process.cwd();

    const fileRelRaw = String(req.query?.file || "").trim();
    if (!fileRelRaw) return res.status(400).send("file query param missing");

    // Normalize URL-ish paths and Windows separators to forward slash
    const fileRel = normalizeRel(fileRelRaw);

    // Resolve absolute and enforce project boundary
    const fileAbs = path.resolve(projectRoot, fileRel);
    if (!isInsideRoot(fileAbs, projectRoot)) {
      return res.status(400).send("file outside project root");
    }

    // ------------------------------------------------------------
    // 1) Special-case: global help file
    // ------------------------------------------------------------
    // You said you created: app/public/readme.md
    // Accept a few equivalent inputs to reduce friction.
    const HELP_RELS = new Set([
      "app/public/readme.md",
      "app/public/README.md",
      "public/readme.md",
      "public/README.md"
    ]);

    if (HELP_RELS.has(fileRel)) {
      const helpAbs = path.resolve(projectRoot, fileRel);
      const out = readFileIfExists(helpAbs);
      if (!out) return res.json({ found: false });

      return res.json({
        found: true,
        readmePath: toRelPosix(projectRoot, helpAbs),
        markdown: out
      });
    }

    // ------------------------------------------------------------
    // 2) Validate target exists (for non-help requests)
    // ------------------------------------------------------------
    if (!fs.existsSync(fileAbs)) {
      return res.status(404).send("file not found");
    }

    // Starting directory: file's dir (or itself if already a directory)
    let dir = fs.statSync(fileAbs).isDirectory() ? fileAbs : path.dirname(fileAbs);

    // ------------------------------------------------------------
    // 3) Walk upward for README (case-sensitive + case-insensitive fallback)
    // ------------------------------------------------------------
    while (true) {
      const readmeAbs = findReadmeInDir(dir);
      if (readmeAbs) {
        const markdown = fs.readFileSync(readmeAbs, "utf8");
        return res.json({
          found: true,
          readmePath: toRelPosix(projectRoot, readmeAbs),
          markdown
        });
      }

      if (samePath(dir, projectRoot)) break;

      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    return res.json({ found: false });
  } catch (err) {
    return res.status(500).send(err?.stack || String(err));
  }
});

export default router;

/* ====================================================================== */
/* Helpers                                                                */
/* ====================================================================== */

function normalizeRel(p) {
  // Remove leading slashes so "/app/public/readme.md" still resolves within root
  return String(p || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();
}

function samePath(a, b) {
  return path.resolve(a) === path.resolve(b);
}

function isInsideRoot(absPath, rootAbs) {
  // Robust boundary check: "/root2" must not match "/root"
  const root = path.resolve(rootAbs);
  const abs = path.resolve(absPath);
  const rel = path.relative(root, abs);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? true : abs === root;
}

function toRelPosix(rootAbs, absPath) {
  return path.relative(rootAbs, absPath).replace(/\\/g, "/");
}

function readFileIfExists(absPath) {
  try {
    if (!fs.existsSync(absPath)) return null;
    const st = fs.statSync(absPath);
    if (!st.isFile()) return null;
    return fs.readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
}

function findReadmeInDir(dirAbs) {
  // Prefer conventional README.md, but also accept readme.md (your new file)
  const candidates = ["README.md", "readme.md"];

  for (const name of candidates) {
    const p = path.join(dirAbs, name);
    if (fs.existsSync(p)) {
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        // ignore
      }
    }
  }
  return null;
}
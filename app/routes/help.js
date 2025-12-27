import express from "express";
import path from "node:path";
import fs from "node:fs";

const router = express.Router();

router.get("/help", (req, res) => {
  try {
    const projectRoot = process.cwd();

    const candidates = [
      path.resolve(projectRoot, "app/public/readme.md"),
      path.resolve(projectRoot, "app/public/README.md"),
    ];

    const fileAbs = candidates.find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
    if (!fileAbs) return res.json({ found: false });

    const markdown = fs.readFileSync(fileAbs, "utf8");
    return res.json({
      found: true,
      path: path.relative(projectRoot, fileAbs).replace(/\\/g, "/"),
      markdown,
    });
  } catch (err) {
    return res.status(500).send(err?.stack || String(err));
  }
});

export default router;
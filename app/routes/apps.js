//endpoint for my apps dropdown

import express from "express";
import fs from "node:fs";
import path from "node:path";

const router = express.Router();

router.get("/apps", (req, res) => {
  const cfgPath = path.join(process.cwd(), "app/config/apps.json");
  if (!fs.existsSync(cfgPath)) {
    return res.json({ apps: [] });
  }

  const raw = fs.readFileSync(cfgPath, "utf8");
  const cfg = JSON.parse(raw);

  // Send only what the UI needs
  const apps = (cfg.apps || []).map(a => ({
    id: a.id,
    name: a.name,
    rootDir: a.rootDir,
    entry: a.entry,
    url: a.url
  }));

  res.json({ apps });
});

export default router;
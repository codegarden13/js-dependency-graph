/**
 * NodeAnalyzer HTTP Server
 * =======================
 *
 * Responsibilities
 * ----------------
 * - Serve the browser-based UI (index.html + JS/CSS assets)
 * - Expose API routes for:
 *     - /analyze   → trigger static analysis (route module may also provide GET /events)
 *     - /apps      → list known applications
 *     - /readme    → resolve nearest README.md
 *     - /help      → return NodeAnalyzer UI help markdown (app/public/readme.md)
 * - Serve generated analysis output as static JSON
 *
 * Design Notes
 * ------------
 * - This server is intentionally thin: no business logic lives here.
 * - All filesystem access and analysis logic is delegated to /routes and /lib.
 * - Static serving is configured BEFORE API routes to avoid accidental shadowing
 *   or HTML fallbacks for JS files (which can trigger browser "nosniff" errors).
 */

import express from "express";
import path from "node:path";

import { getServerConfig } from "./config/config.js";

import analyzeRoute from "./routes/analyze.js";
import appsRoute from "./routes/apps.js";
import readmeRoute from "./routes/readme.js";
import helpRoute from "./routes/help.js";

const app = express();

const { PORT, PROJECT_ROOT, PUBLIC_ROOT, OUTPUT_ROOT } = getServerConfig({
  publicDir: path.join("app", "public")
});

app.use(express.json());

// Static UI + assets
app.use(express.static(PUBLIC_ROOT));

// Generated output
app.use("/output", express.static(OUTPUT_ROOT));

// API
app.use(appsRoute);
app.use(readmeRoute);
app.use(helpRoute);
app.use(analyzeRoute);

app.listen(PORT, () => {
  console.log(`NodeAnalyzer running at http://localhost:${PORT}`);
  console.log(`Project root: ${PROJECT_ROOT}`);
});
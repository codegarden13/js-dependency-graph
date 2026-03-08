/**
 * NodeAnalyzer HTTP Server
 * =======================
 *
 * Responsibilities
 * ----------------
 * - Serve the browser-based UI (index.html + JS/CSS assets)
 * - Expose API routes for:
 *     - /analyze   → trigger static analysis
 *     - /apps      → list known applications
 *     - /readme    → resolve nearest README.md
 *     - /help      → return NodeAnalyzer UI help markdown (app/public/readme.md)
 *     - /events    → Server-Sent Events stream for live file changes
 * - Serve generated analysis output as static JSON
 */

import express from "express";
import path from "node:path";

import { getServerConfig } from "./config/config.js";

import analyzeRoute from "./routes/analyze.js";
import appsRoute from "./routes/apps.js";
import readmeRoute from "./routes/readme.js";
import helpRoute from "./routes/help.js";
import { attachSseEndpoint } from "./lib/liveChangeFeed.js";

const app = express();
const sseRouter = express.Router();

const { PORT, PROJECT_ROOT, PUBLIC_ROOT, OUTPUT_ROOT } = getServerConfig({
  publicDir: path.join("app", "public")
});

app.use(express.json());

// Static UI + assets
app.use(express.static(PUBLIC_ROOT));

// Generated output
app.use("/output", express.static(OUTPUT_ROOT));

// SSE
attachSseEndpoint(sseRouter);
app.use(sseRouter);

// API
app.use(appsRoute);
app.use(readmeRoute);
app.use(helpRoute);
app.use(analyzeRoute);

app.listen(PORT, () => {
  console.log(`NodeAnalyzer running at http://localhost:${PORT}`);
  console.log(`Project root: ${PROJECT_ROOT}`);
});
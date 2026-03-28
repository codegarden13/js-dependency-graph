/**
 * NodeAnalyzer HTTP Server
 * =======================
 *
 * This file is the single entry point of the NodeAnalyzer web server.
 * It wires together:
 *
 *  - Express HTTP server
 *  - Static UI hosting
 *  - API routes
 *  - Server‑Sent Events (live updates)
 *  - Generated analysis output
 *
 * The server intentionally stays thin. Most real logic lives in
 * route modules inside /routes or library modules inside /lib.
 */

import express from "express";
import path from "node:path";

import { getServerConfig } from "./config/config.js";

// -----------------------------------------------------------------------------
// Route Modules
// -----------------------------------------------------------------------------
// Each route module encapsulates one logical API responsibility.

import analyzeRoute from "./routes/analyze.js"; // POST /analyze → trigger analysis
import appsRoute from "./routes/apps.js";       // GET  /apps    → list known apps
import freezeRoute from "./routes/freeze.js";   // POST /freeze  → create ZIP freeze
import readmeRoute from "./routes/readme.js";   // GET  /readme  → resolve nearest README
import helpRoute from "./routes/help.js";       // GET  /help    → UI help markdown
import portfolioRoute from "./routes/portfolio.js";

// Output routes expose generated analysis artifacts
import outputRoutes from "./routes/output.js";  // /api/output-files etc.

// Live change feed (SSE)
import { attachSseEndpoint } from "./lib/liveChangeFeed.js";


// -----------------------------------------------------------------------------
// Express Application
// -----------------------------------------------------------------------------

const app = express();

// Dedicated router for Server‑Sent Events
const sseRouter = express.Router();


// -----------------------------------------------------------------------------
// Server Configuration
// -----------------------------------------------------------------------------
// getServerConfig resolves all important runtime paths:
//
//  PORT          → HTTP port
//  PROJECT_ROOT  → root of the analyzed workspace
//  PUBLIC_ROOT   → location of UI assets
//  OUTPUT_ROOT   → directory containing generated analysis results

const { PORT, PROJECT_ROOT, PUBLIC_ROOT, OUTPUT_ROOT } = getServerConfig({
  publicDir: path.join("app", "public")
});


// -----------------------------------------------------------------------------
// Middleware
// -----------------------------------------------------------------------------

// Enable JSON request bodies for API routes
app.use(express.json());


// -----------------------------------------------------------------------------
// API Routes
// -----------------------------------------------------------------------------

/**
 * /api
 * ----
 * Output related endpoints used by the visualization layer.
 * Example:
 *
 *   GET /api/output-files?appId=xyz&type=code-metrics
 */
app.use("/api", outputRoutes);
app.use("/api", portfolioRoute);


// -----------------------------------------------------------------------------
// Static UI
// -----------------------------------------------------------------------------

/**
 * PUBLIC_ROOT contains the browser UI:
 *
 *   index.html
 *   /assets/js
 *   /assets/css
 *   /assets/img
 *
 * Express serves these files directly.
 */
app.use(express.static(PUBLIC_ROOT));


// -----------------------------------------------------------------------------
// Generated Analysis Output
// -----------------------------------------------------------------------------

/**
 * The analyzer writes JSON / CSV snapshots into OUTPUT_ROOT.
 *
 * They are exposed under:
 *
 *   /output/<file>
 */
app.use("/output", express.static(OUTPUT_ROOT));


// -----------------------------------------------------------------------------
// Live Change Feed (Server‑Sent Events)
// -----------------------------------------------------------------------------

/**
 * SSE endpoint streams file change events to the UI.
 * This allows the graph to refresh automatically when the
 * underlying project changes.
 */
attachSseEndpoint(sseRouter);
app.use(sseRouter);


// -----------------------------------------------------------------------------
// Core API Routes
// -----------------------------------------------------------------------------

/**
 * These routes implement the main NodeAnalyzer API.
 * They intentionally do NOT use an "/api" prefix to keep URLs short.
 */

app.use(appsRoute);
app.use(freezeRoute);
app.use(readmeRoute);
app.use(helpRoute);
app.use(analyzeRoute);


// -----------------------------------------------------------------------------
// Server Startup
// -----------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`NodeAnalyzer running at http://localhost:${PORT}`);
  console.log(`Project root: ${PROJECT_ROOT}`);
});

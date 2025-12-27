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
 * - Serve generated analysis output as static JSON
 *
 * Design Notes
 * ------------
 * - This server is intentionally "thin":
 *   no business logic lives here.
 * - All filesystem access and analysis logic
 *   is delegated to /routes and /lib.
 * - Static serving is configured BEFORE API routes
 *   to avoid accidental shadowing or 404 fallbacks.
 */

import express from "express";
import path from "node:path";
import process from "node:process";

// ---------------------------------------------------------------------
// Route modules (pure HTTP controllers)
// ---------------------------------------------------------------------
import analyzeRoute from "./routes/analyze.js";
import appsRoute from "./routes/apps.js";
import readmeRoute from "./routes/readme.js";

// ---------------------------------------------------------------------
// helpfile Route  (fs controllers)
// ---------------------------------------------------------------------

import helpRoute from "./routes/help.js";


// ---------------------------------------------------------------------
// App bootstrap
// ---------------------------------------------------------------------
const app = express();
const PORT = 3003;

// Resolve project paths once (avoid repeating process.cwd())
const PROJECT_ROOT = process.cwd();
const PUBLIC_ROOT = path.join(PROJECT_ROOT, "app/public");
const OUTPUT_ROOT = path.join(PUBLIC_ROOT, "output");

// ---------------------------------------------------------------------
// Global middleware
// ---------------------------------------------------------------------

/**
 * Parse JSON request bodies.
 * Required for POST /analyze and similar endpoints.
 */
app.use(express.json());

// ---------------------------------------------------------------------
// Static assets (GUI + JS modules)
// ---------------------------------------------------------------------

/**
 * Serve the frontend application:
 * - index.html
 * - /assets/js/*
 * - /assets/codeGraph/*
 *
 * IMPORTANT:
 * This must come BEFORE API routes.
 * Otherwise Express may respond with HTML for JS files,
 * causing browser "nosniff" execution errors.
 */
app.use(express.static(PUBLIC_ROOT));

/**
 * Serve generated analysis output explicitly under /output.
 * This keeps output URLs stable and intention-revealing.
 *
 * Example:
 *   GET /output/code-structure.json
 */
app.use("/output", express.static(OUTPUT_ROOT));



// ---------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------

/**
 * GET /apps
 * Returns known applications (for dropdown selection).
 */
app.use(appsRoute);

/**
 * GET /readme?file=<relative-path>
 * Returns nearest README.md for a given file.
 */
app.use(readmeRoute);

app.use(helpRoute);

/**
 * POST /analyze
 * Triggers static analysis and writes output JSON.
 */
app.use(analyzeRoute);

// ---------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`NodeAnalyzer running at http://localhost:${PORT}`);
});
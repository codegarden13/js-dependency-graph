/**
 * Server / Path Configuration
 * ==========================
 *
 * Central place for:
 * - PORT
 * - PROJECT_ROOT
 * - PUBLIC_ROOT
 * - OUTPUT_ROOT
 *
 * Keeps server.js clean and prevents path drift during refactors.
 */

import path from "node:path";
import process from "node:process";

/**
 * @param {object} [opts]
 * @param {string} [opts.publicDir] - path relative to project root, e.g. "app/public"
 */
export function getServerConfig(opts = {}) {
  const PROJECT_ROOT = process.cwd();

  const PORT =
    Number(process.env.PORT) ||
    3003;

  const publicDir = String(opts.publicDir || path.join("app", "public"));
  const PUBLIC_ROOT = path.join(PROJECT_ROOT, publicDir);
  const OUTPUT_ROOT = path.join(PUBLIC_ROOT, "output");

  return { PORT, PROJECT_ROOT, PUBLIC_ROOT, OUTPUT_ROOT };
}
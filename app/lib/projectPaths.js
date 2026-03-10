// app/lib/projectPaths.js
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// project root = /app
export const APP_ROOT = path.resolve(__dirname, "..");

// public folder
export const PUBLIC_DIR = path.join(APP_ROOT, "public");

// analyzer output
export const OUTPUT_DIR = path.join(PUBLIC_DIR, "output");

export default {
  APP_ROOT,
  PUBLIC_DIR,
  OUTPUT_DIR
};
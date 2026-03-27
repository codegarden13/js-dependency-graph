/*


Alles rund um Output-Dateien:
	•	outputDirAbs
	•	ensureOutputDir
	•	buildArtifactPrefix
	•	metricsBaseName
	•	metricsArtifacts
	•	writeMetricsArtifacts





*/
import { normalizeFsPath } from "../fsPaths.js";
import fs from "fs";
import path from "path";
import { normalizeId } from "../stringUtils.js";


import {

buildMetricsCsv
  
} from "../analyze/csvExport.js"




/**
 * Resolve the absolute output directory for generated analysis artifacts.
 *
 * @returns {string}
 *   Normalized absolute path to `app/public/output`.
 */
function outputDirAbs() {
  return normalizeFsPath(path.join(process.cwd(), "app", "public", "output"));
}


/**
 * Ensure the artifact output directory exists before writing files.
 *
 * @returns {string}
 *   Normalized absolute path to the ensured directory.
 */
function ensureOutputDir() {
  const dir = outputDirAbs();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}







/**
 * Build the stable filename prefix for one analysis run.
 *
 * Why this exists
 * ---------------
 * All artifacts for a run share the same prefix so downstream code can derive
 * related filenames and URLs deterministically.
 *
 * @param {string} appId
 *   Requested application identifier.
 * @param {string} timestampIso
 *   Run timestamp in ISO form.
 * @returns {string}
 *   Filesystem-safe artifact prefix.
 */
function buildArtifactPrefix(appId, timestampIso) {
  const safeAppId = normalizeId(appId) || "app";
  const safeTimestamp = String(timestampIso || new Date().toISOString())
    .replace(/[:.]/g, "-")
    .trim();

  return `${safeAppId}-${safeTimestamp}`;
}





/**
 * Build the common basename for metrics artifacts.
 *
 * @param {string} appId
 *   Requested application identifier.
 * @param {string} timestampIso
 *   Run timestamp in ISO form.
 * @returns {string}
 *   Basename without file extension.
 */
function metricsBaseName(appId, timestampIso) {
  return `${buildArtifactPrefix(appId, timestampIso)}-code-metrics`;
}

/**
 * Build the full artifact descriptor for one analysis run.
 *
 * Keeping the derived names/paths/urls in one place prevents tiny helper
 * functions from drifting apart over time.
 */
export function metricsArtifacts(appId, timestampIso) {
  const baseName = metricsBaseName(appId, timestampIso);
  const jsonFilename = `${baseName}.json`;
  const csvFilename = `${baseName}.csv`;

  return {
    baseName,
    jsonFilename,
    csvFilename,
    jsonPath: path.join(outputDirAbs(), jsonFilename),
    csvPath: path.join(outputDirAbs(), csvFilename),
    jsonUrl: `/output/${jsonFilename}`,
    csvUrl: `/output/${csvFilename}`
  };
}

// ---------------------------------------------------------------------------
// Metrics artifact paths
// ---------------------------------------------------------------------------

/**
 * Persist JSON and CSV metrics artifacts for one analysis run.
 *
 * @param {string} appId
 *   Requested application identifier.
 * @param {string} timestampIso
 *   Run timestamp in ISO form.
 * @param {Record<string, unknown>} metrics
 *   Metrics payload to persist.
 */
export function writeMetricsArtifacts(appId, timestampIso, metrics) {
  ensureOutputDir();

  const artifacts = metricsArtifacts(appId, timestampIso);

  fs.writeFileSync(
    artifacts.jsonPath,
    JSON.stringify(metrics, null, 2),
    "utf8"
  );

  fs.writeFileSync(
    artifacts.csvPath,
    buildMetricsCsv(metrics),
    "utf8"
  );
}

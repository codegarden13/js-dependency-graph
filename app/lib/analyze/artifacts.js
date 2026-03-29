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

function codeMetricsSuffix(ext = "csv") {
  return `-code-metrics.${String(ext || "csv").trim() || "csv"}`;
}

function artifactFromFilename(filename) {
  const safeFilename = String(filename || "").trim();
  return {
    filename: safeFilename,
    path: path.join(outputDirAbs(), safeFilename),
    url: `/output/${safeFilename}`
  };
}

function listCodeMetricsFilenames(appId, ext = "csv") {
  const safeAppId = normalizeId(appId) || "app";
  const prefix = `${safeAppId}-`;
  const suffix = codeMetricsSuffix(ext);

  try {
    return fs.readdirSync(outputDirAbs())
      .filter((filename) => filename.startsWith(prefix) && filename.endsWith(suffix))
      .sort();
  } catch {
    return [];
  }
}

function latestCodeMetricsCsvArtifact(appId) {
  const filenames = listCodeMetricsFilenames(appId, "csv");
  const latestFilename = String(filenames[filenames.length - 1] || "").trim();
  if (!latestFilename) return null;

  const artifact = artifactFromFilename(latestFilename);
  return {
    csvFilename: artifact.filename,
    csvPath: artifact.path,
    csvUrl: artifact.url
  };
}

export function latestCodeMetricsJsonArtifact(appId) {
  const filenames = listCodeMetricsFilenames(appId, "json");
  const latestFilename = String(filenames[filenames.length - 1] || "").trim();
  if (!latestFilename) return null;

  const artifact = artifactFromFilename(latestFilename);
  return {
    jsonFilename: artifact.filename,
    jsonPath: artifact.path,
    jsonUrl: artifact.url
  };
}

function readFileUtf8OrNull(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

export function readLatestCodeMetricsJson(appId) {
  const artifact = latestCodeMetricsJsonArtifact(appId);
  if (!artifact?.jsonPath) return null;

  const content = readFileUtf8OrNull(artifact.jsonPath);
  if (!content) return null;

  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
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
  const latestCsvBeforeWrite = latestCodeMetricsCsvArtifact(appId);
  const csvContent = buildMetricsCsv(metrics);
  const previousCsvContent = latestCsvBeforeWrite
    ? readFileUtf8OrNull(latestCsvBeforeWrite.csvPath)
    : null;

  fs.writeFileSync(
    artifacts.jsonPath,
    JSON.stringify(metrics, null, 2),
    "utf8"
  );

  const csvChanged = previousCsvContent !== csvContent;
  const latestCsvArtifact = csvChanged
    ? {
      csvFilename: artifacts.csvFilename,
      csvPath: artifacts.csvPath,
      csvUrl: artifacts.csvUrl
    }
    : latestCsvBeforeWrite;

  if (csvChanged) {
    fs.writeFileSync(
      artifacts.csvPath,
      csvContent,
      "utf8"
    );
  }

  return {
    ...artifacts,
    csvChanged,
    latestCsvFilename: String(latestCsvArtifact?.csvFilename || artifacts.csvFilename),
    latestCsvPath: String(latestCsvArtifact?.csvPath || artifacts.csvPath),
    latestCsvUrl: String(latestCsvArtifact?.csvUrl || artifacts.csvUrl)
  };
}

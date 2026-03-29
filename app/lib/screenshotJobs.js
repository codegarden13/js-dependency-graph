import crypto from "node:crypto";

import { createScreenshotsForApp } from "./appScreenshots.js";

const MAX_JOB_COUNT = 30;
const FINISHED_JOB_TTL_MS = 1000 * 60 * 60 * 6;
const RUNNING_STATUSES = new Set(["queued", "running"]);

function nowIso() {
  return new Date().toISOString();
}

function toPositiveInt(value, fallback = 0) {
  const num = Number(value || 0);
  return Number.isFinite(num) && num >= 0 ? Math.trunc(num) : fallback;
}

function clampProgress(value) {
  return Math.max(0, Math.min(100, toPositiveInt(value, 0)));
}

function calcProgressPct(completedCount, totalCount) {
  const total = toPositiveInt(totalCount, 0);
  if (!total) return 0;
  return clampProgress(Math.round((toPositiveInt(completedCount, 0) / total) * 100));
}

function buildJobMessage({ createdCount, failedCount, totalCount }) {
  const created = toPositiveInt(createdCount, 0);
  const failed = toPositiveInt(failedCount, 0);
  const total = toPositiveInt(totalCount, 0);

  if (failed > 0) {
    return `Created ${created}/${total || created + failed} screenshot(s), ${failed} failed.`;
  }
  return `Created ${created}/${total || created} screenshot(s).`;
}

function buildJobSnapshot(job) {
  return {
    jobId: String(job.jobId || ""),
    appId: String(job.appId || ""),
    appName: String(job.appName || ""),
    status: String(job.status || "queued"),
    phase: String(job.phase || ""),
    message: String(job.message || ""),
    totalCount: toPositiveInt(job.totalCount, 0),
    completedCount: toPositiveInt(job.completedCount, 0),
    createdCount: toPositiveInt(job.createdCount, 0),
    failedCount: toPositiveInt(job.failedCount, 0),
    progressPct: clampProgress(job.progressPct),
    currentIndex: toPositiveInt(job.currentIndex, 0),
    currentPageName: String(job.currentPageName || ""),
    screenshotsDirAbs: String(job.screenshotsDirAbs || ""),
    manifestPath: String(job.manifestPath || ""),
    created: Array.isArray(job.created) ? [...job.created] : [],
    failed: Array.isArray(job.failed) ? [...job.failed] : [],
    startedAt: String(job.startedAt || ""),
    finishedAt: String(job.finishedAt || ""),
    errorMessage: String(job.errorMessage || ""),
    errorDetails: job.errorDetails || null
  };
}

function jobBase({ appId, app }) {
  return {
    jobId: crypto.randomUUID(),
    appId: String(appId || ""),
    appName: String(app?.name || appId || ""),
    status: "queued",
    phase: "queued",
    message: "Queued screenshot job.",
    totalCount: 0,
    completedCount: 0,
    createdCount: 0,
    failedCount: 0,
    progressPct: 0,
    currentIndex: 0,
    currentPageName: "",
    screenshotsDirAbs: "",
    manifestPath: "",
    created: [],
    failed: [],
    startedAt: "",
    finishedAt: "",
    errorMessage: "",
    errorDetails: null
  };
}

const jobs = new Map();

function pruneJobs() {
  const entries = [...jobs.values()];
  const now = Date.now();

  for (const job of entries) {
    if (RUNNING_STATUSES.has(job.status)) continue;
    const finishedAtMs = Date.parse(String(job.finishedAt || ""));
    if (Number.isFinite(finishedAtMs) && now - finishedAtMs > FINISHED_JOB_TTL_MS) {
      jobs.delete(job.jobId);
    }
  }

  const ordered = [...jobs.values()].sort((a, b) => {
    const aTime = Date.parse(String(a.finishedAt || a.startedAt || "")) || 0;
    const bTime = Date.parse(String(b.finishedAt || b.startedAt || "")) || 0;
    return bTime - aTime;
  });

  for (const job of ordered.slice(MAX_JOB_COUNT)) {
    jobs.delete(job.jobId);
  }
}

function applyProgress(job, progress) {
  if (!job || !progress) return;

  if (progress.phase) job.phase = String(progress.phase);
  if (progress.message) job.message = String(progress.message);
  if (progress.screenshotsDirAbs) job.screenshotsDirAbs = String(progress.screenshotsDirAbs);
  if (progress.manifestPath) job.manifestPath = String(progress.manifestPath);

  if (progress.totalCount !== undefined) job.totalCount = toPositiveInt(progress.totalCount, job.totalCount);
  if (progress.currentIndex !== undefined) job.currentIndex = toPositiveInt(progress.currentIndex, job.currentIndex);
  if (progress.currentPageName !== undefined) job.currentPageName = String(progress.currentPageName || "");

  if (progress.lastCreated) {
    job.created.push(progress.lastCreated);
  }
  if (progress.lastFailed) {
    job.failed.push(progress.lastFailed);
  }

  job.createdCount = job.created.length;
  job.failedCount = job.failed.length;
  job.completedCount = toPositiveInt(
    progress.completedCount,
    job.createdCount + job.failedCount
  );
  job.progressPct = clampProgress(
    progress.progressPct ?? calcProgressPct(job.completedCount, job.totalCount)
  );
}

async function runScreenshotJob(job, { appId, app, appRootAbs }) {
  job.status = "running";
  job.phase = "preparing";
  job.message = "Preparing screenshots…";
  job.startedAt = nowIso();
  job.finishedAt = "";
  job.errorMessage = "";
  job.errorDetails = null;

  try {
    const result = await createScreenshotsForApp({
      appId,
      app,
      appRootAbs,
      onProgress(progress) {
        applyProgress(job, progress);
      }
    });

    job.status = result.failedCount > 0 ? "done_with_errors" : "done";
    job.phase = "complete";
    job.totalCount = toPositiveInt(result.totalCount, job.totalCount);
    job.completedCount = toPositiveInt(result.totalCount, job.completedCount);
    job.created = Array.isArray(result.created) ? [...result.created] : [];
    job.failed = Array.isArray(result.failed) ? [...result.failed] : [];
    job.createdCount = job.created.length;
    job.failedCount = job.failed.length;
    job.progressPct = 100;
    job.currentPageName = "";
    job.currentIndex = job.totalCount;
    job.screenshotsDirAbs = String(result.screenshotsDirAbs || job.screenshotsDirAbs || "");
    job.manifestPath = String(result?.manifest?.manifestPath || job.manifestPath || "");
    job.message = buildJobMessage(job);
    job.finishedAt = nowIso();
  } catch (error) {
    job.status = "failed";
    job.phase = "failed";
    job.progressPct = calcProgressPct(job.completedCount, job.totalCount);
    job.currentPageName = "";
    job.errorMessage = String(error?.message || error || "Could not create screenshots.");
    job.errorDetails = error?.details || null;
    job.message = job.errorMessage;
    job.finishedAt = nowIso();
  } finally {
    pruneJobs();
  }
}

export function startScreenshotJob({ appId, app, appRootAbs }) {
  pruneJobs();

  const job = jobBase({ appId, app });
  jobs.set(job.jobId, job);

  setImmediate(() => {
    runScreenshotJob(job, { appId, app, appRootAbs }).catch((error) => {
      job.status = "failed";
      job.phase = "failed";
      job.errorMessage = String(error?.message || error || "Could not create screenshots.");
      job.errorDetails = error?.details || null;
      job.message = job.errorMessage;
      job.finishedAt = nowIso();
    });
  });

  return buildJobSnapshot(job);
}

export function getScreenshotJob(jobId) {
  const safeJobId = String(jobId || "").trim();
  if (!safeJobId) return null;
  const job = jobs.get(safeJobId);
  return job ? buildJobSnapshot(job) : null;
}

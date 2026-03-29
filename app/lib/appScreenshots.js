import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { normalizeFsPath } from "./fsPaths.js";
import { readLatestCodeMetricsJson } from "./analyze/artifacts.js";
import { discoverScreenshotPages } from "./screenshotRouteDiscovery.js";

const localRequire = createRequire(import.meta.url);

const DEFAULT_MANIFEST_FILENAME = "puppetier.json";
const DEFAULT_SCREENSHOTS_DIR = "app/public/screenshots";
const DEFAULT_VIEWPORT = Object.freeze({ width: 1440, height: 1024 });
const DEFAULT_WAIT_UNTIL = "domcontentloaded";
const DEFAULT_DELAY_MS = 250;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 15000;
const DEFAULT_SELECTOR_TIMEOUT_MS = 5000;
const HOT_FILE_LIMIT = 10;
const ALLOWED_WAIT_UNTIL = new Set(["load", "domcontentloaded", "networkidle0", "networkidle2"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toPositiveInt(value, fallback) {
  const num = Number(value || 0);
  return Number.isInteger(num) && num > 0 ? num : fallback;
}

function normalizeWaitUntil(value, fallback = DEFAULT_WAIT_UNTIL) {
  const safe = String(value || "").trim().toLowerCase();
  return ALLOWED_WAIT_UNTIL.has(safe) ? safe : fallback;
}

function normalizeViewport(viewport) {
  const config = isPlainObject(viewport) ? viewport : {};
  return {
    width: toPositiveInt(config.width, DEFAULT_VIEWPORT.width),
    height: toPositiveInt(config.height, DEFAULT_VIEWPORT.height)
  };
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function normalizeRelativePath(filePath) {
  return String(filePath || "").replace(/\\/g, "/").trim();
}

function sanitizeScreenshotName(name, fallback = "page") {
  const safe = String(name || "").trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe || fallback;
}

function readPuppetierConfig(app) {
  if (isPlainObject(app?.puppetier)) return app.puppetier;
  if (isPlainObject(app?.puppeteer)) return app.puppeteer;
  return {};
}

function resolveAppAssetsDirAbs(appRootAbs) {
  return normalizeFsPath(path.join(appRootAbs, "app", "public", "assets"));
}

function resolveManifestPath(appRootAbs) {
  return normalizeFsPath(path.join(resolveAppAssetsDirAbs(appRootAbs), DEFAULT_MANIFEST_FILENAME));
}

function resolveScreenshotsDirAbs(appRootAbs) {
  return normalizeFsPath(path.resolve(appRootAbs, DEFAULT_SCREENSHOTS_DIR));
}

function buildDefaultPages(app) {
  const safeUrl = String(app?.url || "").trim();
  if (!safeUrl) return [];

  return [{
    name: "home",
    url: safeUrl,
    path: "01-home.png",
    fullPage: true
  }];
}

function readConfiguredPages(app) {
  const config = readPuppetierConfig(app);
  return Array.isArray(config?.pages) ? config.pages : [];
}

function resolvePageUrl(appUrl, pageUrl) {
  const baseUrl = String(appUrl || "").trim();
  const targetUrl = String(pageUrl || "").trim();

  try {
    if (targetUrl) return new URL(targetUrl, baseUrl || undefined).toString();
    if (baseUrl) return new URL("/", baseUrl).toString();
  } catch {
    return "";
  }

  return "";
}

function resolveScreenshotOutputPath(page, index, screenshotsDirAbs) {
  const rawPath = String(page?.path || page?.file || page?.filename || "").trim();
  const fallbackName = `${String(index + 1).padStart(2, "0")}-${sanitizeScreenshotName(page?.name, "page")}.png`;
  const chosen = rawPath || fallbackName;
  const absolute = path.isAbsolute(chosen)
    ? chosen
    : path.resolve(screenshotsDirAbs, chosen);

  return normalizeFsPath(absolute);
}

function normalizeScreenshotActions(actions) {
  const list = Array.isArray(actions) ? actions : [];

  return list
    .map((action) => ({
      type: String(action?.type || "").trim().toLowerCase(),
      selector: String(action?.selector || "").trim(),
      delayMs: toPositiveInt(action?.delayMs, DEFAULT_DELAY_MS)
    }))
    .filter((action) => action.type === "click" && action.selector);
}

function normalizeTimeoutMs(value, fallback) {
  return toPositiveInt(value, fallback);
}

function normalizePageSpec(page, index, app, defaults, screenshotsDirAbs) {
  const url = resolvePageUrl(app?.url, page?.url);
  if (!url) return null;

  const outputPath = resolveScreenshotOutputPath(page, index, screenshotsDirAbs);
  return {
    name: String(page?.name || `page-${index + 1}`).trim() || `page-${index + 1}`,
    url,
    outputPath,
    relativeOutputPath: normalizeRelativePath(path.relative(screenshotsDirAbs, outputPath)),
    fullPage: page?.fullPage !== false,
    waitUntil: normalizeWaitUntil(page?.waitUntil, defaults.waitUntil),
    waitForSelector: String(page?.waitForSelector || "").trim(),
    delayMs: toPositiveInt(page?.delayMs, defaults.delayMs),
    navigationTimeoutMs: normalizeTimeoutMs(
      page?.navigationTimeoutMs ?? page?.timeoutMs,
      defaults.navigationTimeoutMs
    ),
    selectorTimeoutMs: normalizeTimeoutMs(
      page?.selectorTimeoutMs ?? page?.timeoutMs,
      defaults.selectorTimeoutMs
    ),
    viewport: normalizeViewport(page?.viewport || defaults.viewport),
    actions: normalizeScreenshotActions(page?.actions)
  };
}

function sortHotFileNodes(a, b) {
  return (
    (Number(b?._hotspotScore) || 0) - (Number(a?._hotspotScore) || 0) ||
    (Number(b?.complexity) || 0) - (Number(a?.complexity) || 0) ||
    (Number(b?.lines) || 0) - (Number(a?.lines) || 0) ||
    String(a?.file || "").localeCompare(String(b?.file || ""))
  );
}

function buildHotFiles(metrics) {
  const nodes = Array.isArray(metrics?.nodes) ? metrics.nodes : [];

  return nodes
    .filter((node) => String(node?.kind || "") === "file")
    .filter((node) => String(node?.file || "").trim() && String(node?.file || "").trim() !== ".")
    .sort(sortHotFileNodes)
    .slice(0, HOT_FILE_LIMIT)
    .map((node) => ({
      file: String(node?.file || ""),
      hotspotScore: Number(node?._hotspotScore || 0) || 0,
      complexity: Number(node?.complexity || 0) || 0,
      lines: Number(node?.lines || 0) || 0,
      lastTouchedAt: String(node?._lastTouchedAt || ""),
      group: String(node?.group || ""),
      layer: String(node?.layer || "")
    }));
}

function buildAutoPages(app, appRootAbs, metrics) {
  const discovered = discoverScreenshotPages({ appRootAbs, metrics });
  if (discovered.length) return discovered;
  return buildDefaultPages(app);
}

function buildManifestPages(app, appRootAbs, screenshotsDirAbs, defaults, metrics) {
  const configuredPages = readConfiguredPages(app);
  const sourcePages = configuredPages.length
    ? configuredPages
    : buildAutoPages(app, appRootAbs, metrics);

  return sourcePages
    .map((page, index) => normalizePageSpec(page, index, app, defaults, screenshotsDirAbs))
    .filter(Boolean);
}

function readLaunchOptions(app) {
  const config = readPuppetierConfig(app);
  return isPlainObject(config?.launch) ? config.launch : {};
}

export function buildPuppetierManifest({
  appId,
  app,
  appRootAbs,
  metrics = null,
  generatedAt = new Date().toISOString(),
  source = "analyze"
}) {
  const config = readPuppetierConfig(app);
  const assetsDirAbs = resolveAppAssetsDirAbs(appRootAbs);
  const screenshotsDirAbs = resolveScreenshotsDirAbs(appRootAbs);
  const defaults = {
    viewport: normalizeViewport(config?.viewport),
    waitUntil: normalizeWaitUntil(config?.waitUntil),
    delayMs: toPositiveInt(config?.delayMs, DEFAULT_DELAY_MS),
    navigationTimeoutMs: normalizeTimeoutMs(
      config?.navigationTimeoutMs ?? config?.timeoutMs,
      DEFAULT_NAVIGATION_TIMEOUT_MS
    ),
    selectorTimeoutMs: normalizeTimeoutMs(
      config?.selectorTimeoutMs ?? config?.timeoutMs,
      DEFAULT_SELECTOR_TIMEOUT_MS
    )
  };
  const pages = buildManifestPages(app, appRootAbs, screenshotsDirAbs, defaults, metrics);
  const hotFiles = buildHotFiles(metrics);

  return {
    schemaVersion: 1,
    generator: "NodeAnalyzer",
    source: String(source || "analyze"),
    generatedAt,
    app: {
      id: String(appId || ""),
      name: String(app?.name || appId || ""),
      url: String(app?.url || ""),
      entry: String(app?.entry || ""),
      rootDir: String(appRootAbs || "")
    },
    manifestPath: resolveManifestPath(appRootAbs),
    assetsDirAbs,
    screenshotsDirAbs,
    defaults,
    pages,
    focusFiles: hotFiles,
    analysis: {
      nodeCount: Array.isArray(metrics?.nodes) ? metrics.nodes.length : 0,
      linkCount: Array.isArray(metrics?.links) ? metrics.links.length : 0,
      hotspotCount: hotFiles.length
    }
  };
}

export function writePuppetierManifest({
  appId,
  app,
  appRootAbs,
  metrics = null,
  generatedAt = new Date().toISOString(),
  source = "analyze"
}) {
  const manifest = buildPuppetierManifest({
    appId,
    app,
    appRootAbs,
    metrics,
    generatedAt,
    source
  });

  fs.mkdirSync(manifest.assetsDirAbs, { recursive: true });
  fs.mkdirSync(manifest.screenshotsDirAbs, { recursive: true });
  fs.writeFileSync(manifest.manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  return manifest;
}

export function writeLatestPuppetierManifest({ appId, app, appRootAbs, source = "screenshots" }) {
  return writePuppetierManifest({
    appId,
    app,
    appRootAbs,
    metrics: readLatestCodeMetricsJson(appId),
    generatedAt: new Date().toISOString(),
    source
  });
}

function loadPuppeteer() {
  try {
    const runtime = localRequire("puppeteer");
    return runtime?.default || runtime;
  } catch (localError) {
    const error = new Error("Puppeteer is not installed in NodeAnalyzer.");
    error.details = {
      localError: String(localError?.message || localError || "")
    };
    throw error;
  }
}

function screenshotWait(delayMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function isTimeoutError(error) {
  const name = String(error?.name || "");
  const message = String(error?.message || "");
  return name === "TimeoutError" || /timeout/i.test(message);
}

function buildWaitUntilAttempts(waitUntil) {
  const safeWaitUntil = normalizeWaitUntil(waitUntil);
  if (safeWaitUntil === "networkidle0" || safeWaitUntil === "networkidle2") {
    return uniqueStrings([safeWaitUntil, "load", "domcontentloaded"]);
  }
  if (safeWaitUntil === "load") {
    return uniqueStrings([safeWaitUntil, "domcontentloaded"]);
  }
  return [safeWaitUntil];
}

async function gotoWithFallback(page, screenshot) {
  const attempts = buildWaitUntilAttempts(screenshot.waitUntil);
  let lastError = null;

  for (const waitUntil of attempts) {
    try {
      await page.goto(screenshot.url, {
        waitUntil,
        timeout: screenshot.navigationTimeoutMs
      });
      return waitUntil;
    } catch (error) {
      lastError = error;
      if (!isTimeoutError(error) || waitUntil === attempts[attempts.length - 1]) {
        break;
      }
    }
  }

  throw lastError || new Error(`Navigation failed for ${screenshot.url}`);
}

async function waitForSelectorSoft(page, selector, timeoutMs) {
  if (!selector) return true;

  try {
    await page.waitForSelector(selector, { timeout: timeoutMs });
    return true;
  } catch (error) {
    if (isTimeoutError(error)) return false;
    throw error;
  }
}

async function runScreenshotActions(page, screenshot) {
  for (const action of screenshot.actions || []) {
    const selectorFound = await waitForSelectorSoft(page, action.selector, screenshot.selectorTimeoutMs);
    if (!selectorFound) continue;

    await page.click(action.selector);
    if (action.delayMs > 0) {
      await screenshotWait(action.delayMs);
    }
  }
}

function buildCreatedItem(screenshot) {
  return {
    name: screenshot.name,
    url: screenshot.url,
    outputPath: screenshot.outputPath,
    relativeOutputPath: screenshot.relativeOutputPath
  };
}

function buildFailedItem(screenshot, error) {
  return {
    name: screenshot.name,
    url: screenshot.url,
    outputPath: screenshot.outputPath,
    relativeOutputPath: screenshot.relativeOutputPath,
    error: String(error?.message || error || "Unknown screenshot error")
  };
}

function emitScreenshotProgress(onProgress, payload) {
  if (typeof onProgress !== "function") return;

  try {
    onProgress(payload);
  } catch {
    // Ignore consumer-side progress handler errors.
  }
}

function buildProgressPayload({
  manifest,
  created,
  failed,
  currentIndex = 0,
  currentPageName = "",
  phase = "running",
  message = ""
}) {
  const totalCount = Array.isArray(manifest?.pages) ? manifest.pages.length : 0;
  const completedCount = created.length + failed.length;

  return {
    phase,
    message,
    totalCount,
    completedCount,
    createdCount: created.length,
    failedCount: failed.length,
    progressPct: totalCount ? Math.round((completedCount / totalCount) * 100) : 0,
    currentIndex,
    currentPageName,
    screenshotsDirAbs: String(manifest?.screenshotsDirAbs || ""),
    manifestPath: String(manifest?.manifestPath || "")
  };
}

async function captureSinglePage(page, screenshot) {
  await page.setViewport(screenshot.viewport);
  await gotoWithFallback(page, screenshot);

  if (screenshot.waitForSelector) {
    await waitForSelectorSoft(page, screenshot.waitForSelector, screenshot.selectorTimeoutMs);
  }

  if (screenshot.delayMs > 0) {
    await screenshotWait(screenshot.delayMs);
  }

  await runScreenshotActions(page, screenshot);

  fs.mkdirSync(path.dirname(screenshot.outputPath), { recursive: true });
  await page.screenshot({
    path: screenshot.outputPath,
    fullPage: screenshot.fullPage
  });
}

export async function createScreenshotsForApp({ appId, app, appRootAbs, onProgress = null }) {
  const manifest = writeLatestPuppetierManifest({ appId, app, appRootAbs, source: "create-screenshots" });
  if (!manifest.pages.length) {
    throw new Error("No screenshot pages configured and the app has no usable URL.");
  }

  const created = [];
  const failed = [];

  emitScreenshotProgress(onProgress, buildProgressPayload({
    manifest,
    created,
    failed,
    phase: "preparing",
    message: "Preparing screenshots…"
  }));

  const puppeteer = loadPuppeteer();
  const browser = await puppeteer.launch({
    headless: true,
    ...readLaunchOptions(app)
  });

  try {
    for (const [index, screenshot] of manifest.pages.entries()) {
      emitScreenshotProgress(onProgress, buildProgressPayload({
        manifest,
        created,
        failed,
        currentIndex: index + 1,
        currentPageName: screenshot.name,
        phase: "capturing",
        message: `Capturing ${screenshot.name}…`
      }));

      const page = await browser.newPage();
      try {
        await captureSinglePage(page, screenshot);
        const createdItem = buildCreatedItem(screenshot);
        created.push(createdItem);
        emitScreenshotProgress(onProgress, {
          ...buildProgressPayload({
            manifest,
            created,
            failed,
            currentIndex: index + 1,
            phase: "captured",
            message: `Captured ${screenshot.name}.`
          }),
          lastCreated: createdItem
        });
      } catch (error) {
        const failedItem = buildFailedItem(screenshot, error);
        failed.push(failedItem);
        emitScreenshotProgress(onProgress, {
          ...buildProgressPayload({
            manifest,
            created,
            failed,
            currentIndex: index + 1,
            phase: "failed",
            message: `Failed ${screenshot.name}.`
          }),
          lastFailed: failedItem
        });
      } finally {
        await page.close().catch(() => { });
      }
    }
  } finally {
    await browser.close().catch(() => { });
  }

  return {
    manifest,
    created,
    failed,
    createdCount: created.length,
    failedCount: failed.length,
    totalCount: manifest.pages.length,
    screenshotsDirAbs: manifest.screenshotsDirAbs
  };
}

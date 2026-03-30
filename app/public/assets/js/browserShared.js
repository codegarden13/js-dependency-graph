"use strict";

function getContentType(response) {
  return String(response?.headers?.get?.("content-type") || "");
}

function isJsonContentType(contentType) {
  return String(contentType || "").includes("application/json");
}

async function readResponseBodySafely(response, isJson) {
  try {
    return isJson ? await response.json() : await response.text();
  } catch {
    return null;
  }
}

function extractServerMessage(body) {
  const serverMessage = body?.error?.message || body?.message;
  if (serverMessage) return String(serverMessage);

  const text = typeof body === "string" ? body.trim() : "";
  return text || "";
}

function buildHttpError(url, response, body) {
  const status = Number(response?.status || 0);
  const statusText = String(response?.statusText || "");
  const serverMessage = extractServerMessage(body);
  const error = new Error(serverMessage || `HTTP ${status} ${statusText}`.trim());

  /** @type {any} */ (error).status = status;
  /** @type {any} */ (error).code = body?.error?.code;
  /** @type {any} */ (error).details = body?.error?.details;
  /** @type {any} */ (error).url = String(url || "");
  return error;
}

function assertJsonResponse(url, response, isJson) {
  if (isJson) return;

  throw new Error(
    `Expected JSON response from ${String(url || "")}, got content-type: ${getContentType(response) || "(missing)"}`
  );
}

export async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const contentType = getContentType(response);
  const isJson = isJsonContentType(contentType);
  const body = await readResponseBodySafely(response, isJson);

  if (!response.ok) throw buildHttpError(url, response, body);
  assertJsonResponse(url, response, isJson);

  return body;
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])
  );
}

export function toDisplayText(value, fallback = "—") {
  const text = String(value || "").trim();
  return text || fallback;
}

export function formatIsoDate(value, fallback = "—") {
  const raw = String(value || "").trim();
  if (!raw) return fallback;

  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return raw;
  return date.toLocaleString();
}

export function formatBytes(value, fallback = "—") {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return fallback;

  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const digits = size >= 10 || unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(digits)} ${units[unitIndex]}`;
}

export function formatInteger(value, locale = "en-US") {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "0";
  return Math.round(numeric).toLocaleString(locale);
}

export function buildVersionedUrl(url, version) {
  const safeUrl = String(url || "").trim();
  const safeVersion = String(version || "").trim();
  if (!safeUrl || !safeVersion) return safeUrl;
  return `${safeUrl}${safeUrl.includes("?") ? "&" : "?"}v=${encodeURIComponent(safeVersion)}`;
}

export function markdownToHtml(markdown) {
  const text = String(markdown || "");
  return window.marked?.parse ? window.marked.parse(text) : `<pre>${escapeHtml(text)}</pre>`;
}

export function sanitizeHtml(rawHtml) {
  return window.DOMPurify?.sanitize ? window.DOMPurify.sanitize(rawHtml) : rawHtml;
}

export function readTimestampValue(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : NaN;
  }

  const text = String(value || "").trim();
  if (!text) return NaN;

  const numeric = Number(text);
  if (Number.isFinite(numeric)) return numeric;

  const epoch = new Date(text).getTime();
  return Number.isFinite(epoch) ? epoch : NaN;
}

export function formatTimestamp(value, {
  fallback = "n/a",
  locale = "de-DE",
  year = false
} = {}) {
  const epoch = readTimestampValue(value);
  if (!Number.isFinite(epoch)) return fallback;

  const date = new Date(epoch);
  return date.toLocaleString(locale, {
    day: "2-digit",
    month: "2-digit",
    ...(year ? { year: "2-digit" } : {}),
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function formatMetricValue(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "n/a";
  if (Math.abs(numeric) >= 1000) {
    return `${(numeric / 1000).toFixed(1)}k`;
  }
  if (Math.abs(numeric) >= 10) {
    return numeric.toFixed(1);
  }
  return numeric.toFixed(2);
}

export function formatAppEndpointLabel(value, baseUrl = window.location.href) {
  const safeValue = String(value || "").trim();
  if (!safeValue) return "";

  try {
    const url = new URL(safeValue, baseUrl);
    const protocol = String(url.protocol || "").trim().toLowerCase();
    const host = String(url.hostname || "").trim();
    const port = String(
      url.port ||
      (protocol === "https:" ? "443" : protocol === "http:" ? "80" : "")
    ).trim();
    const pathname = String(url.pathname || "").trim();
    const normalizedPath = pathname && pathname !== "/" ? pathname.replace(/\/+$/, "") : "";

    if (!host) return safeValue;
    return `${host}${port ? `:${port}` : ""}${normalizedPath}`;
  } catch {
    return safeValue;
  }
}

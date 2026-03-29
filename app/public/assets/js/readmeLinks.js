"use strict";

function isLocalReadmePath(rawValue) {
  const safeValue = String(rawValue || "").trim();
  if (!safeValue) return false;
  if (safeValue.startsWith("#")) return false;
  if (safeValue.startsWith("//")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(safeValue)) return false;
  return true;
}

function buildReadmeAssetUrl(appId, readmePath, rawValue) {
  const safeAppId = String(appId || "").trim();
  const safeReadmePath = String(readmePath || "").trim();
  const safeValue = String(rawValue || "").trim();
  if (!safeAppId || !safeReadmePath || !isLocalReadmePath(safeValue)) return rawValue;

  const params = new URLSearchParams({
    appId: safeAppId,
    readmePath: safeReadmePath,
    asset: safeValue
  });

  return `/readme-asset?${params.toString()}`;
}

export function rewriteReadmeAssetLinks(rawHtml, appId, readmePath) {
  const safeHtml = String(rawHtml || "");
  if (!safeHtml) return safeHtml;

  const template = document.createElement("template");
  template.innerHTML = safeHtml;

  for (const element of template.content.querySelectorAll("[href], [src]")) {
    if (element.hasAttribute("href")) {
      const href = String(element.getAttribute("href") || "");
      element.setAttribute("href", buildReadmeAssetUrl(appId, readmePath, href));
    }

    if (element.hasAttribute("src")) {
      const src = String(element.getAttribute("src") || "");
      element.setAttribute("src", buildReadmeAssetUrl(appId, readmePath, src));
    }
  }

  return template.innerHTML;
}

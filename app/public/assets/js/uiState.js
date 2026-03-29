"use strict";

let selectedAppId = "";
let apps = [];

function normalizeAppId(appId) {
  return String(appId || "").trim();
}

export function getSelectedAppId() {
  return selectedAppId;
}

export function setSelectedAppId(appId) {
  selectedAppId = normalizeAppId(appId);
  return selectedAppId;
}

export function getApps() {
  return apps.slice();
}

export function setApps(nextApps) {
  apps = Array.isArray(nextApps) ? nextApps.slice() : [];
  return getApps();
}

export function hasApp(appId) {
  const wantedId = normalizeAppId(appId);
  if (!wantedId) return false;

  return apps.some((app) => normalizeAppId(app?.id) === wantedId);
}

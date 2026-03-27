import { findAppById, loadAppsConfig } from "./appsRegistry.js";
import { normalizeId } from "./stringUtils.js";

export function resolveConfiguredApp(appId, options = {}) {
  const {
    missingStatus = 400,
    notFoundStatus = 400
  } = options;

  const normalizedAppId = normalizeId(appId);
  if (!normalizedAppId) {
    return {
      ok: false,
      status: missingStatus,
      message: "Missing appId"
    };
  }

  const apps = loadAppsConfig();
  const app = findAppById(apps, normalizedAppId);
  if (!app) {
    return {
      ok: false,
      status: notFoundStatus,
      message: `Unknown appId: ${normalizedAppId}`
    };
  }

  return {
    ok: true,
    appId: normalizedAppId,
    app
  };
}

export function sendJsonError(res, status, message, fallbackMessage = "Error") {
  return res.status(status).json({
    error: {
      message: String(message || fallbackMessage)
    }
  });
}

export function sendBadRequest(res, message) {
  return sendJsonError(res, 400, message, "Bad Request");
}

export function sendServerError(res, err, fallbackMessage = "Request failed") {
  return sendJsonError(
    res,
    500,
    String(err?.message || err || fallbackMessage),
    fallbackMessage
  );
}

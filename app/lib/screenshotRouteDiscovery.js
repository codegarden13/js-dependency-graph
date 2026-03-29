import fs from "node:fs";
import path from "node:path";

import { parse } from "@babel/parser";
import traverse from "@babel/traverse";

const traverseAst = (typeof traverse === "function")
  ? traverse
  : (typeof traverse?.default === "function" ? traverse.default : null);

const ROUTE_METHODS = new Set(["get"]);
const NAVIGATION_FUNCTIONS = new Set(["navigate", "redirect"]);
const LINK_ATTRIBUTE_NAMES = new Set(["href", "to"]);
const SCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"]);
const ROUTE_ROOT_RE = /(?:^|\/)(?:app\/routes|routes?|pages?|views?|screens?)(?:\/|$)/i;
const FRONTEND_ROOT_RE = /(?:^|\/)(?:app\/public|public|src|client|web|ui|frontend)(?:\/|$)/i;
const BACKEND_ROUTE_RE = /(?:^|\/)(?:app\/routes|routes?)(?:\/|$)/i;
const UI_NAME_RE = /(index|home|dashboard|about|login|settings|admin|profile|start|landing)/i;
const SAFE_CLICK_NAME_RE = /(choose|browse|open|toggle|tab|preview|source|src|dest|folder|dialog|picker)/i;
const UNSAFE_CLICK_NAME_RE = /(delete|remove|destroy|import|scan|render|restart|freeze|analyze|submit|save|upload|download|select)/i;
const SKIP_ROUTE_PREFIXES = ["/api", "/events", "/output", "/readme", "/readme-asset", "/help", "/freeze", "/analyze", "/screenshots", "/restart"];
const SKIP_ROUTE_SEGMENTS = new Set(["api", "apps", "restart", "freeze", "analyze", "readme", "readme-asset", "help", "events", "output", "screenshots"]);
const MAX_CANDIDATE_FILES = 48;
const DEFAULT_DISCOVERY_LIMIT = 6;
const MAX_HTML_STATE_FILES = 8;

function safeReadUtf8(fileAbs) {
  try {
    return fs.readFileSync(fileAbs, "utf8");
  } catch {
    return "";
  }
}

function parseAst(src, filenameAbs) {
  try {
    return parse(String(src || ""), {
      sourceType: "unambiguous",
      sourceFilename: String(filenameAbs || ""),
      allowReturnOutsideFunction: true,
      allowImportExportEverywhere: true,
      errorRecovery: true,
      plugins: [
        "jsx",
        "typescript",
        "classProperties",
        "classPrivateProperties",
        "classPrivateMethods",
        "decorators-legacy",
        "dynamicImport",
        "importMeta",
        "topLevelAwait"
      ]
    });
  } catch {
    return null;
  }
}

function isStringLiteralNode(node) {
  return node?.type === "StringLiteral" && typeof node?.value === "string";
}

function isJsxStringAttribute(node) {
  return node?.type === "JSXAttribute" &&
    LINK_ATTRIBUTE_NAMES.has(String(node?.name?.name || "").trim()) &&
    node?.value?.type === "StringLiteral";
}

function normalizeFilePath(filePath) {
  return String(filePath || "").replace(/\\/g, "/").trim();
}

function isFrontendFilePath(filePath) {
  return FRONTEND_ROOT_RE.test(normalizeFilePath(filePath));
}

function isBackendRouteFilePath(filePath) {
  return BACKEND_ROUTE_RE.test(normalizeFilePath(filePath));
}

function isObjectPathProperty(node) {
  const keyName = String(node?.key?.name || node?.key?.value || "").trim();
  return node?.type === "ObjectProperty" && keyName === "path" && isStringLiteralNode(node?.value);
}

function normalizeRoutePath(rawPath) {
  const input = String(rawPath || "").trim();
  if (!input) return "";

  let value = input;
  try {
    if (/^https?:\/\//i.test(value)) {
      value = new URL(value).pathname || "/";
    }
  } catch {
    return "";
  }

  value = value.split(/[?#]/, 1)[0] || "/";
  if (!value.startsWith("/")) value = `/${value}`;
  value = value.replace(/\/{2,}/g, "/");
  if (value.length > 1) value = value.replace(/\/+$/, "");

  if (!value) return "";
  if (/[:*$\[\]]/.test(value)) return "";
  if (SKIP_ROUTE_PREFIXES.some((prefix) => value === prefix || value.startsWith(`${prefix}/`))) return "";
  if (value.split("/").filter(Boolean).some((segment) => SKIP_ROUTE_SEGMENTS.has(segment))) return "";

  return value;
}

function routeNameFromPath(routePath) {
  const safePath = normalizeRoutePath(routePath);
  if (!safePath || safePath === "/") return "home";

  const last = safePath.split("/").filter(Boolean).pop();
  return String(last || "page").trim().toLowerCase() || "page";
}

function stripHtml(text) {
  return String(text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function sanitizePageName(name, fallback = "page") {
  const safe = String(name || "").trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe || fallback;
}

function pathBonus(routePath) {
  if (routePath === "/") return 5;
  if (UI_NAME_RE.test(routePath)) return 2;
  return 0;
}

function addRouteScore(routes, routePath, score) {
  const normalized = normalizeRoutePath(routePath);
  if (!normalized) return;

  const nextScore = Number(score || 0) + pathBonus(normalized);
  const current = Number(routes.get(normalized) || 0);
  if (nextScore > current) routes.set(normalized, nextScore);
}

function memberExpressionName(node) {
  if (!node || node.type !== "MemberExpression") return "";
  return String(node?.property?.name || node?.property?.value || "").trim();
}

function memberExpressionTarget(node) {
  if (!node || node.type !== "MemberExpression") return null;
  const objectName = identifierName(node.object);
  const propertyName = String(node?.property?.name || node?.property?.value || "").trim();
  if (!objectName || !propertyName) return null;
  return { objectName, propertyName };
}

function identifierName(node) {
  return node?.type === "Identifier" ? String(node.name || "").trim() : "";
}

function isDocumentGetElementByIdCall(node) {
  if (node?.type !== "CallExpression") return false;
  if (!isStringLiteralNode(node?.arguments?.[0])) return false;

  const callee = node.callee;
  return callee?.type === "MemberExpression" &&
    identifierName(callee.object) === "document" &&
    memberExpressionName(callee) === "getElementById";
}

function fileContext(filePath) {
  const safeFile = normalizeFilePath(filePath);
  return {
    filePath: safeFile,
    isFrontend: isFrontendFilePath(safeFile),
    isBackendRoute: isBackendRouteFilePath(safeFile)
  };
}

function extractRouteStringsFromAst(ast, context = fileContext("")) {
  const routes = new Set();
  if (!ast || !traverseAst) return routes;

  traverseAst(ast, {
    CallExpression(pathRef) {
      const callee = pathRef.node?.callee;
      const firstArg = pathRef.node?.arguments?.[0];
      const memberName = memberExpressionName(callee);
      const calleeName = identifierName(callee);

      if (ROUTE_METHODS.has(memberName) && isStringLiteralNode(firstArg)) {
        routes.add(firstArg.value);
      }

      if (context.isFrontend && NAVIGATION_FUNCTIONS.has(calleeName) && isStringLiteralNode(firstArg)) {
        routes.add(firstArg.value);
      }
    },
    ObjectProperty(pathRef) {
      const node = pathRef.node;
      if (!context.isFrontend) return;
      if (!isObjectPathProperty(node)) return;
      routes.add(node.value.value);
    },
    JSXAttribute(pathRef) {
      const node = pathRef.node;
      if (!context.isFrontend) return;
      if (!isJsxStringAttribute(node)) return;
      routes.add(node.value.value);
    }
  });

  return routes;
}

function filePathLooksRelevant(filePath) {
  const safe = normalizeFilePath(filePath);
  return ROUTE_ROOT_RE.test(safe) || FRONTEND_ROOT_RE.test(safe) || UI_NAME_RE.test(path.basename(safe));
}

function candidateNodeScore(node) {
  const file = String(node?.file || "");
  const hotspot = Number(node?._hotspotScore || 0) || 0;
  const complexity = Number(node?.complexity || 0) || 0;
  const lines = Number(node?.lines || 0) || 0;
  const relevance = filePathLooksRelevant(file) ? 4 : 0;
  return hotspot * 100 + complexity * 0.15 + lines * 0.01 + relevance;
}

function sortCandidateNodes(a, b) {
  return (
    candidateNodeScore(b) - candidateNodeScore(a) ||
    String(a?.file || "").localeCompare(String(b?.file || ""))
  );
}

function collectCandidateNodes(metrics) {
  const nodes = Array.isArray(metrics?.nodes) ? metrics.nodes : [];
  return nodes
    .filter((node) => String(node?.kind || "") === "file")
    .filter((node) => filePathLooksRelevant(node?.file))
    .sort(sortCandidateNodes)
    .slice(0, MAX_CANDIDATE_FILES);
}

function collectHtmlNodes(metrics) {
  const nodes = Array.isArray(metrics?.nodes) ? metrics.nodes : [];
  return nodes
    .filter((node) => String(node?.ext || "").toLowerCase() === ".html")
    .filter((node) => String(node?.file || "").trim())
    .slice(0, MAX_HTML_STATE_FILES);
}

function removeKnownRouteRoots(filePath) {
  const safe = normalizeFilePath(filePath);
  return safe
    .replace(/^.*?\/app\/routes\//i, "")
    .replace(/^.*?\/routes\//i, "")
    .replace(/^.*?\/app\/public\//i, "")
    .replace(/^.*?\/public\//i, "")
    .replace(/^.*?\/pages\//i, "")
    .replace(/^.*?\/views\//i, "")
    .replace(/^.*?\/screens\//i, "");
}

function inferRouteFromFilePath(filePath) {
  if (isBackendRouteFilePath(filePath)) return "";

  const stripped = removeKnownRouteRoots(filePath)
    .replace(/\.[^.]+$/, "")
    .replace(/\/index$/i, "")
    .replace(/^index$/i, "")
    .replace(/\/_index$/i, "")
    .replace(/^_index$/i, "")
    .trim();

  if (!stripped) return "/";

  const segments = stripped
    .split("/")
    .flatMap((segment) => segment.split("."))
    .map((segment) => segment.trim())
    .filter(Boolean)
    .filter((segment) => !segment.startsWith("$"))
    .filter((segment) => !segment.startsWith("[") && !segment.endsWith("]"));

  if (!segments.length) return "/";
  return `/${segments.join("/")}`;
}

function shouldInferRouteFromFilePath(filePath) {
  const safe = normalizeFilePath(filePath);
  if (!safe || isBackendRouteFilePath(safe)) return false;

  const base = path.basename(safe);
  if (UI_NAME_RE.test(base)) return true;
  return /(?:^|\/)(?:pages?|views?|screens?)(?:\/|$)/i.test(safe);
}

function fileAbsFromNode(appRootAbs, node) {
  return path.resolve(appRootAbs, String(node?.file || ""));
}

function hasScriptFileExtension(filePath) {
  return SCRIPT_EXTENSIONS.has(String(path.extname(String(filePath || "")).toLowerCase() || ""));
}

function domBindingKey(objectName, propertyName) {
  return `${String(objectName || "").trim()}.${String(propertyName || "").trim()}`;
}

function humanizeBindingName(name) {
  const base = String(name || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b(btn|button|modal|dialog)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return base
    .replace(/\bsel src\b/i, "source picker")
    .replace(/\bchoose dest\b/i, "destination picker");
}

function isSafeClickBindingName(name) {
  const safe = String(name || "").trim();
  if (!safe) return false;
  if (UNSAFE_CLICK_NAME_RE.test(safe)) return false;
  return SAFE_CLICK_NAME_RE.test(safe);
}

function extractDomBindingsFromAst(ast) {
  const bindings = new Map();
  if (!ast || !traverseAst) return bindings;

  traverseAst(ast, {
    VariableDeclarator(pathRef) {
      const objectName = identifierName(pathRef.node?.id);
      const init = pathRef.node?.init;
      if (!objectName || init?.type !== "ObjectExpression") return;

      for (const property of init.properties || []) {
        if (property?.type !== "ObjectProperty") continue;
        const propertyName = String(property?.key?.name || property?.key?.value || "").trim();
        if (!propertyName || !isDocumentGetElementByIdCall(property.value)) continue;

        const elementId = String(property.value.arguments[0].value || "").trim();
        if (!elementId) continue;

        bindings.set(domBindingKey(objectName, propertyName), {
          objectName,
          propertyName,
          elementId
        });
      }
    }
  });

  return bindings;
}

function bindingFromNode(node, bindings) {
  const target = memberExpressionTarget(node);
  if (!target) return null;
  return bindings.get(domBindingKey(target.objectName, target.propertyName)) || null;
}

function buildActionPageFromBinding(binding, prefix = "") {
  const rawName = prefix || binding?.propertyName || binding?.elementId || "page";
  const safeName = sanitizePageName(humanizeBindingName(rawName), "page");
  return {
    name: safeName,
    url: "/",
    path: `${safeName}.png`,
    fullPage: true,
    actions: [{
      type: "click",
      selector: `#${String(binding?.elementId || "").trim()}`,
      delayMs: 350
    }]
  };
}

function extractFrontendActionPagesFromAst(ast) {
  const pages = [];
  const bindings = extractDomBindingsFromAst(ast);
  if (!bindings.size || !traverseAst) return pages;

  traverseAst(ast, {
    CallExpression(pathRef) {
      const callee = pathRef.node?.callee;
      const firstArg = pathRef.node?.arguments?.[0];
      const secondArg = pathRef.node?.arguments?.[1];

      if (identifierName(callee) === "on" && bindingFromNode(firstArg, bindings) && isStringLiteralNode(secondArg)) {
        if (String(secondArg.value || "").trim().toLowerCase() !== "click") return;
        const binding = bindingFromNode(firstArg, bindings);
        if (!binding) return;

        const nameHint = `${binding.propertyName} ${binding.elementId}`;
        if (!isSafeClickBindingName(nameHint)) return;
        pages.push(buildActionPageFromBinding(binding));
        return;
      }

      if (memberExpressionName(callee) !== "addEventListener") return;
      if (!isStringLiteralNode(firstArg) || String(firstArg.value || "").trim().toLowerCase() !== "click") return;

      const binding = bindingFromNode(callee.object, bindings);
      if (!binding) return;

      const nameHint = `${binding.propertyName} ${binding.elementId}`;
      if (!isSafeClickBindingName(nameHint)) return;
      pages.push(buildActionPageFromBinding(binding));
    }
  });

  return pages;
}

function discoverFrontendActionPages(appRootAbs, metrics) {
  const pages = [];

  for (const node of collectCandidateNodes(metrics)) {
    const filePath = String(node?.file || "");
    if (!isFrontendFilePath(filePath) || !hasScriptFileExtension(filePath)) continue;

    const fileAbs = fileAbsFromNode(appRootAbs, node);
    const source = safeReadUtf8(fileAbs);
    if (!source) continue;

    const ast = parseAst(source, fileAbs);
    pages.push(...extractFrontendActionPagesFromAst(ast));
  }

  return pages;
}

function extractTabStatesFromHtml(source) {
  const states = [];
  const re = /<(button|a)\b[^>]*\bid=["']([^"']+)["'][^>]*\b(?:data-bs-target|href)=["']#([^"']+)["'][^>]*>([\s\S]*?)<\/\1>/gi;
  let match = null;

  while ((match = re.exec(String(source || "")))) {
    const id = String(match[2] || "").trim();
    const label = stripHtml(match[4] || "");
    if (!id || !label) continue;

    states.push({
      name: label,
      selector: `#${id}`
    });
  }

  return states;
}

function discoverHtmlStatePages(appRootAbs, metrics) {
  const pages = [];

  for (const node of collectHtmlNodes(metrics)) {
    const source = safeReadUtf8(fileAbsFromNode(appRootAbs, node));
    if (!source) continue;

    for (const state of extractTabStatesFromHtml(source)) {
      const safeName = sanitizePageName(state.name, "page");
      pages.push({
        name: safeName,
        url: "/",
        path: `${safeName}.png`,
        fullPage: true,
        actions: [{
          type: "click",
          selector: state.selector,
          delayMs: 250
        }]
      });
    }
  }

  return pages;
}

function dedupeDiscoveredPages(pages, limit) {
  const seen = new Set();
  const result = [];

  for (const page of pages) {
    const key = `${String(page?.url || "")}::${String(page?.name || "")}::${String(page?.actions?.[0]?.selector || "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(page);
    if (result.length >= limit) break;
  }

  return result;
}

export function discoverScreenshotPages({ appRootAbs, metrics, limit = DEFAULT_DISCOVERY_LIMIT }) {
  const routes = new Map();
  addRouteScore(routes, "/", 1000);

  for (const node of collectCandidateNodes(metrics)) {
    const fileAbs = fileAbsFromNode(appRootAbs, node);
    const source = safeReadUtf8(fileAbs);
    if (!source) continue;

    const baseScore = candidateNodeScore(node);
    const ast = parseAst(source, fileAbs);
    const context = fileContext(node?.file);
    for (const routePath of extractRouteStringsFromAst(ast, context)) {
      addRouteScore(routes, routePath, baseScore + 8);
    }

    if (context.isFrontend && !context.isBackendRoute && shouldInferRouteFromFilePath(node?.file)) {
      addRouteScore(routes, inferRouteFromFilePath(node?.file), baseScore);
    }
  }

  const routePages = Array.from(routes.entries())
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0) || a[0].localeCompare(b[0]))
    .map(([routePath], index) => ({
      name: routeNameFromPath(routePath),
      url: routePath,
      path: `${String(index + 1).padStart(2, "0")}-${routeNameFromPath(routePath)}.png`,
      fullPage: true
    }));

  const htmlPages = discoverHtmlStatePages(appRootAbs, metrics);
  const actionPages = discoverFrontendActionPages(appRootAbs, metrics);
  const combined = htmlPages.length
    ? [
      ...routePages.filter((page) => page.url === "/"),
      ...htmlPages,
      ...actionPages,
      ...routePages.filter((page) => page.url !== "/")
    ]
    : [
      ...routePages.filter((page) => page.url === "/"),
      ...actionPages,
      ...routePages.filter((page) => page.url !== "/")
    ];

  return dedupeDiscoveredPages(combined, Math.max(1, Number(limit || DEFAULT_DISCOVERY_LIMIT)));
}

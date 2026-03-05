/**
 * parseAst / parseJsTsAst
 * =======================
 *
 * Canonical JS/TS AST extractor (Babel).
 *
 * Contract (mutates `out`)
 * ------------------------
 * - out.imports:        string[]
 * - out.importBindings: Record<localName, { source: string, imported: string }>
 * - out.functions:      Array<{ id, name, exported, complexity, startLine, endLine, locLines }>
 * - out.calls:          Array<{ from: string|null, callee: string }>
 * - out.symbols:        optional legacy list (safe to keep)
 * - out.complexity:     file-level heuristic counter (incremental)
 *
 * Design
 * ------
 * - Best-effort: never throws, syntax errors are expected.
 * - Deterministic: no runtime evaluation.
 * - Neutral: call attribution records what we can see statically.
 *
 * Notes
 * -----
 * This module intentionally does NOT perform path/asset resolution. That belongs
 * in a separate pass once the call/import/function graph is stable.
 */

import { parse } from "@babel/parser";
import traverse from "@babel/traverse";

// -----------------------------------------------------------------------------
// Babel traverse interop (ESM/CJS)
// -----------------------------------------------------------------------------
// Depending on module system, `@babel/traverse` may be:
// - a callable function
// - an object with `.default`
const traverseAst = (typeof traverse === "function")
  ? traverse
  : (typeof traverse?.default === "function" ? traverse.default : null);

/**
 * parseJsTsAst
 * ------------
 * Parse JS/TS source and enrich the shared `out` structure.
 *
 * @param {string} src
 * @param {string} filename
 * @param {string} baseDir
 * @param {any} out
 * @param {any} helpers  (reserved; currently unused)
 */
// Helper: ensure output structure shape
function ensureOutShape(out) {
  if (!Array.isArray(out.imports)) out.imports = [];
  if (!Array.isArray(out.symbols)) out.symbols = [];
  if (!Array.isArray(out.functions)) out.functions = [];
  if (!Array.isArray(out.calls)) out.calls = [];
  if (!out.importBindings || typeof out.importBindings !== "object") out.importBindings = {};
  if (!Number.isFinite(out.complexity)) out.complexity = 0;
}

// Helper: read parser config from helpers
function readParserConfig(helpers) {
  /**
   * Config model
   * ------------
   * `parseJsTsAst` supports a small feature-toggle surface that lets the caller
   * trade graph noise vs. detail.
   *
   * - mode: "architecture" (default) keeps the graph high-signal
   * - mode: "full" enables ALL optional details
   *
   * The effective flags (prefixed with `eff`) are what the rest of the parser
   * uses. In "full" mode we force them to `true` so callers don't have to set
   * each flag manually.
   */

  const cfg = readConfigObject(helpers);
  const mode = readMode(cfg);
  const isFullMode = mode === "full";

  return {
    effIncludeInlineCallbacks: effectiveFlag(isFullMode, cfg.includeInlineCallbacks),
    effIncludeClassAccessors: effectiveFlag(isFullMode, cfg.includeClassAccessors),
    effIncludeClassConstructor: effectiveFlag(isFullMode, cfg.includeClassConstructor),
    effIncludeAnonymousFunctions: effectiveFlag(isFullMode, cfg.includeAnonymousFunctions)
  };
}

function readConfigObject(helpers) {
  const cfg = helpers?.config;
  return cfg && typeof cfg === "object" ? cfg : Object.create(null);
}

function readMode(cfg) {
  return String(cfg?.mode || "architecture").toLowerCase();
}

function effectiveFlag(isFullMode, value) {
  // In full mode every optional detail is enabled.
  if (isFullMode) return true;
  return value === true;
}

// Helper: parse AST, best-effort
function tryParseAst(code, filename) {
  try {
    return parse(code, {
      sourceType: "unambiguous",
      sourceFilename: String(filename || ""),
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

// Helper: function index seeding from out.functions
function seedFunctionIndex(out) {
  const fnById = new Map();
  const fnIdSeen = new Set();
  for (const f of out.functions) {
    const id = String(f?.id || "");
    if (id) {
      fnIdSeen.add(id);
      fnById.set(id, f);
    }
  }
  return { fnById, fnIdSeen };
}

function isObj(v) {
  return Boolean(v) && typeof v === "object";
}

function fnNameTrimmed(fn) {
  return String(fn?.name || "").trim();
}

function shouldMarkExported(name, exportedNames) {
  if (!exportedNames) return false;
  if (name && exportedNames.has(name)) return true;
  // Default exports without a stable name (or emitted as anon) are considered exported.
  return exportedNames.has("default") && (!name || name === "anon");
}

function normalizeFnComplexity(fn) {
  const c = Number(fn?.complexity);
  if (!Number.isFinite(c) || c <= 0) fn.complexity = 1;

  const cc = Number(fn?.cc);
  if (!Number.isFinite(cc) || cc <= 0) fn.cc = fn.complexity;
}

// Helper: finalize exported flags and cc normalization
function finalizeExportFlags(out, exportedNames) {
  const fns = Array.isArray(out?.functions) ? out.functions : [];

  for (const fn of fns) {
    if (!isObj(fn)) continue;

    const name = fnNameTrimmed(fn);
    if (shouldMarkExported(name, exportedNames)) fn.exported = true;

    normalizeFnComplexity(fn);
  }
}

// Helper: build visitors for traverseAst
function buildVisitors(api) {
  return {
    ImportDeclaration(p) {
      api.handleImportDeclaration(p);
    },
    CallExpression(p) {
      api.handleCallExpression(p);
    },
    ExportNamedDeclaration(p) {
      api.handleExportNamedDeclaration(p);
    },
    ExportDefaultDeclaration(p) {
      api.handleExportDefaultDeclaration(p);
    },
    IfStatement() { api.bumpCx(1); },
    ForStatement() { api.bumpCx(1); },
    WhileStatement() { api.bumpCx(1); },
    DoWhileStatement() { api.bumpCx(1); },
    ForInStatement() { api.bumpCx(1); },
    ForOfStatement() { api.bumpCx(1); },
    SwitchCase() { api.bumpCx(1); },
    CatchClause() { api.bumpCx(1); },
    ConditionalExpression() { api.bumpCx(1); },
    LogicalExpression(p) {
      const op = p.node?.operator;
      if (op === "&&" || op === "||") api.bumpCx(1);
    },
    Function: {
      enter(p) { api.enterFunction(p); },
      exit(p) { api.exitFunction(p); }
    }
  };
}

export function parseJsTsAst(src, filename, baseDir, out, helpers) {
  const code = String(src || "");

  // 0) Ensure containers exist (backward compatible out)
  ensureOutShape(out);

  // 1) Config (passed from parseFile)
  const cfg = readParserConfig(helpers);

  // 2) Parse (best-effort)
  const ast = tryParseAst(code, filename);
  if (!ast || !traverseAst) return;

  // 3) Local state
  /** @type {Set<string>} */
  const exportedNames = new Set();

  /** @type {string[]} */
  const fnStack = [];

  const { fnById, fnIdSeen } = seedFunctionIndex(out);

  // Inline callbacks (e.g. arr.every(x => ...)) are NOT architecture nodes.
  // We skip registering them as functions and keep call attribution on the
  // enclosing function / toplevel.
  const skippedFnNodes = new WeakSet();

  // -------------------------------------------------------------------------
  // Helpers (kept local, but wired via a small API surface)
  // -------------------------------------------------------------------------

  const lineOf = (node) => {
    const l = node?.loc?.start?.line;
    return Number.isFinite(l) ? Number(l) : 0;
  };

  const mkFnId = (name, line) => {
    const n = String(name || "anon").trim() || "anon";
    const ln = Number(line) || 0;
    return `${n}@${ln}`;
  };

  const currentFn = () => {
    if (!fnStack.length) return null;
    const top = fnStack[fnStack.length - 1];
    if (!top) return null;

    const s = String(top);
    if (s.startsWith("<anon@")) return null;
    return s;
  };

  const bumpCx = (n = 1) => {
    const inc = Number(n || 0) || 0;
    out.complexity += inc;

    // Attribute complexity to the nearest function (best-effort)
    const cur = currentFn();
    if (!cur) return;

    const fnObj = fnById.get(cur);
    if (!fnObj || typeof fnObj !== "object") return;

    const next = Number(fnObj.complexity || 0) + inc;
    fnObj.complexity = next;
    fnObj.cc = next; // explicit alias for cyclomatic complexity
  };

  const getKeyName = (key) => {
    if (!key) return null;
    if (key.type === "Identifier") return key.name;
    if (key.type === "StringLiteral") return key.value;
    return null;
  };

  const getAssignmentTargetName = (left) => {
    if (!left) return null;
    if (left.type === "Identifier") return left.name;
    if (left.type === "MemberExpression" && left.property) return getKeyName(left.property);
    return null;
  };

  const isAccessorMethod = (n) => {
    const kind = n?.kind;
    const ty = n?.type;
    const isMethod = ty === "ClassMethod" || ty === "ObjectMethod";
    return isMethod && (kind === "get" || kind === "set");
  };

  const isConstructorMethod = (n) => n?.type === "ClassMethod" && n.kind === "constructor";

  function inlineCallbacksEnabled() {
    // In full mode (or when explicitly enabled), we treat inline callbacks as real function nodes.
    return cfg.effIncludeInlineCallbacks === true;
  }

  function isAnonymousFnExpression(node) {
    if (!node) return false;
    const isFn = node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression";
    return isFn && !node.id?.name;
  }

  function isDirectCallArgumentPath(p) {
    // Babel exposes both `listKey` and `key` depending on traversal shape.
    return p?.listKey === "arguments" || p?.key === "arguments";
  }

  function isParentCallExpression(p) {
    return p?.parentPath?.node?.type === "CallExpression";
  }

  /**
   * Inline callback detection
   * ------------------------
   * In architecture mode we usually do NOT emit function nodes for callbacks like:
   *   arr.map(x => x * 2)
   *   promise.then(() => ...)
   * because they create lots of low-signal nodes and clutter the graph.
   *
   * This predicate returns true only when ALL are true:
   * 1) Inline callbacks are NOT enabled in config (architecture mode default)
   * 2) The current node is an anonymous function/arrow expression
   * 3) That node sits directly in a CallExpression's arguments list
   */
  const isInlineCallback = (p) => {
    if (inlineCallbacksEnabled()) return false;

    const node = p?.node;
    if (!isAnonymousFnExpression(node)) return false;

    if (!isParentCallExpression(p)) return false;
    if (!isDirectCallArgumentPath(p)) return false;

    return true;
  };

  const allowAnonymousName = () => (cfg.effIncludeAnonymousFunctions ? "anon" : null);

  const shouldSkipLowSignalClassFragment = (n) =>
    (!cfg.effIncludeClassAccessors && isAccessorMethod(n)) ||
    (!cfg.effIncludeClassConstructor && isConstructorMethod(n));

  const inferNameFromNodeType = (n) => {
    if (!n) return null;

    if (n.type === "FunctionDeclaration") return n.id?.name || null;

    const isMethod = n.type === "ClassMethod" || n.type === "ObjectMethod";
    if (isMethod && n.key) return getKeyName(n.key);

    return null;
  };

  const inferNameFromParent = (parent) => {
    if (!parent) return null;

    if (parent.type === "VariableDeclarator" && parent.id?.type === "Identifier") {
      return parent.id.name;
    }

    if (parent.type === "AssignmentExpression") {
      return getAssignmentTargetName(parent.left);
    }

    return null;
  };

  const inferFnName = (p) => {
    const n = p?.node;
    if (!n) return null;

    // Architecture mode: skip low-signal class fragments.
    if (shouldSkipLowSignalClassFragment(n)) return null;

    const direct = inferNameFromNodeType(n);
    if (direct) return direct;

    const parentName = inferNameFromParent(p?.parentPath?.node);
    if (parentName) return parentName;

    // Deliberately do NOT invent callback names.
    return allowAnonymousName();
  };

  const pushFnStackMarker = (fnIdOrNull) => {
    fnStack.push(fnIdOrNull || null);
  };

  const ensureFnBaseline = (fnObj) => {
    if (!fnObj || typeof fnObj !== "object") return;

    const base = Number(fnObj.complexity);
    fnObj.complexity = Number.isFinite(base) && base > 0 ? base : 1;

    const cc = Number(fnObj.cc);
    fnObj.cc = Number.isFinite(cc) && cc > 0 ? cc : fnObj.complexity;
  };

  const createFunctionRecord = (fnId, name, line) => ({
    id: fnId,
    name: String(name || ""),
    exported: false,
    complexity: 1,
    cc: 1,
    startLine: Number(line) || 0,
    endLine: Number(line) || 0,
    locLines: 0
  });

  const registerFunctionIfNew = (fnId, name, line) => {
    if (fnIdSeen.has(fnId)) return;

    fnIdSeen.add(fnId);

    out.functions.push(createFunctionRecord(fnId, name, line));

    const fnObj = out.functions[out.functions.length - 1];
    fnById.set(fnId, fnObj);

    ensureFnBaseline(fnObj);

    out.symbols.push({ name: String(name || ""), kind: "function" });
  };

  const computeEmittedFnId = (p) => {
    const inferred = inferFnName(p);
    if (!inferred) return null;

    const name = String(inferred).trim();
    if (!name) return null;

    const line = lineOf(p.node);
    return { fnId: mkFnId(name, line), name, line };
  };

  /**
   * Enter function scope
   * --------------------
   * Maintains `fnStack` so calls can be attributed to the nearest enclosing
   * *emitted* function node.
   *
   * Rules:
   * - Inline callbacks (e.g. arr.map(x => ...)) may be skipped in architecture mode.
   *   When skipped, we also avoid pushing to the stack so nesting stays correct.
   * - If we cannot infer a stable name/id, we push a `null` marker. That preserves
   *   traversal nesting without emitting noisy anonymous function nodes.
   * - When we do emit a function node, we register it once and push its id.
   */
  const enterFunction = (p) => {
    // Skip inline callbacks entirely in architecture mode.
    if (isInlineCallback(p)) {
      skippedFnNodes.add(p.node);
      return;
    }

    const info = computeEmittedFnId(p);

    // Keep call attribution stable even when we do not emit a function node.
    if (!info) {
      pushFnStackMarker(null);
      return;
    }

    registerFunctionIfNew(info.fnId, info.name, info.line);
    pushFnStackMarker(info.fnId);
  };

  const peekFnStack = () => (fnStack.length ? fnStack[fnStack.length - 1] : null);

  const popFnStack = () => {
    fnStack.pop();
  };

  const getFnObjById = (fnId) => {
    if (!fnId) return null;
    const o = fnById.get(fnId);
    return o && typeof o === "object" ? o : null;
  };

  const computeLocLines = (startLine, endLine) => {
    const s = Number(startLine) || 0;
    const e = Number(endLine) || 0;
    return s && e && e >= s ? (e - s + 1) : 0;
  };

  const updateFnEndAndLoc = (p, fnObj) => {
    if (!fnObj) return;

    const end = Number(p?.node?.loc?.end?.line) || 0;
    if (end) fnObj.endLine = end;

    fnObj.locLines = computeLocLines(fnObj.startLine, fnObj.endLine);
  };

  const exitFunction = (p) => {
    if (skippedFnNodes.has(p?.node)) return;

    const fnId = peekFnStack();
    const fnObj = getFnObjById(fnId);
    updateFnEndAndLoc(p, fnObj);

    popFnStack();
  };

  // -------------------------------------------------------------------------
  // Traversal helpers (imports / calls / exports)
  // -------------------------------------------------------------------------

  const recordImportBinding = (local, spec, imported) => {
    if (!local || !spec) return;
    out.importBindings[local] = { source: spec, imported: String(imported || "") };
  };

  const getImportSourceSpec = (p) => String(p?.node?.source?.value || "").trim();
  const getImportedName = (s) => s?.imported?.name || s?.imported?.value || "";

  const importSpecifierHandlers = {
    ImportSpecifier: (s, spec) => {
      const local = s?.local?.name;
      const imported = getImportedName(s);
      recordImportBinding(local, spec, imported);
    },
    ImportDefaultSpecifier: (s, spec) => {
      const local = s?.local?.name;
      recordImportBinding(local, spec, "default");
    },
    ImportNamespaceSpecifier: (s, spec) => {
      const local = s?.local?.name;
      recordImportBinding(local, spec, "*");
    }
  };

  const applyImportSpecifier = (s, spec) => {
    const ty = s?.type;
    const fn = importSpecifierHandlers[ty];
    if (fn) fn(s, spec);
  };

  const handleImportDeclaration = (p) => {
    const spec = getImportSourceSpec(p);
    if (spec) out.imports.push(spec);

    for (const s of p?.node?.specifiers || []) {
      applyImportSpecifier(s, spec);
    }
  };

  const isRequireCall = (callee, arg0) =>
    callee?.type === "Identifier" &&
    callee.name === "require" &&
    arg0?.type === "StringLiteral";

  const recordCall = (calleeName) => {
    const nm = String(calleeName || "").trim();
    if (!nm) return;
    out.calls.push({ from: currentFn(), callee: nm });
  };

  const getCalleeAndFirstArg = (p) => {
    const node = p?.node;
    const callee = node?.callee;
    const arg0 = node?.arguments && node.arguments[0];
    return { callee, arg0 };
  };

  const maybeRecordRequireImport = (callee, arg0) => {
    if (!isRequireCall(callee, arg0)) return false;
    const spec = String(arg0.value || "").trim();
    if (spec) out.imports.push(spec);
    return true;
  };

  const maybeRecordIdentifierCall = (callee) => {
    if (callee?.type !== "Identifier") return false;
    recordCall(callee.name);
    return true;
  };

  const isMemberLike = (callee) =>
    callee?.type === "MemberExpression" || callee?.type === "OptionalMemberExpression";

  const hasOwn = (obj, key) =>
    Boolean(obj) && Boolean(key) && Object.prototype.hasOwnProperty.call(obj, key);

  const maybeRecordMemberCall = (callee) => {
    if (!isMemberLike(callee)) return false;

    const obj = callee.object;
    const prop = callee.property;

    const objName = obj?.type === "Identifier" ? obj.name : "";

    // Imported namespace call: keep attribution on the namespace identifier.
    if (hasOwn(out.importBindings, objName)) {
      recordCall(objName);
      return true;
    }

    // Local object method call: attribute to the property.
    const propName = getKeyName(prop);
    if (propName) {
      recordCall(propName);
      return true;
    }

    // Fallback: if we only have an object identifier, keep old behavior.
    if (objName) {
      recordCall(objName);
      return true;
    }

    return true;
  };

  const handleCallExpression = (p) => {
    const { callee, arg0 } = getCalleeAndFirstArg(p);

    if (maybeRecordRequireImport(callee, arg0)) return;
    if (maybeRecordIdentifierCall(callee)) return;

    maybeRecordMemberCall(callee);
  };

  const getExportedFromSpecifier = (s) => s?.exported?.name || s?.exported?.value || "";
  const getLocalFromSpecifier = (s) => s?.local?.name || s?.local?.value || "";

  const declExportNameExtractors = {
    FunctionDeclaration: (decl) => {
      const nm = decl?.id?.name;
      return nm ? [nm] : [];
    },
    VariableDeclaration: (decl) => {
      const names = [];
      for (const d of decl?.declarations || []) {
        const nm = d?.id?.type === "Identifier" ? d.id.name : "";
        if (nm) names.push(nm);
      }
      return names;
    }
  };

  const extractExportNamesFromDeclaration = (decl) => {
    const ty = decl?.type;
    const fn = ty ? declExportNameExtractors[ty] : null;
    return fn ? fn(decl) : [];
  };

  // --- Export helpers (for exportedNames set) ---
  function addExportedNameToSet(exportedNamesSet, name) {
    const s = String(name || "").trim();
    if (s) exportedNamesSet.add(s);
  }

  function addExportedNamesFromDeclaration(exportedNamesSet, decl) {
    for (const nm of extractExportNamesFromDeclaration(decl)) {
      addExportedNameToSet(exportedNamesSet, nm);
    }
  }

  function exportedNameFromSpecifier(s) {
    return getExportedFromSpecifier(s) || getLocalFromSpecifier(s) || "";
  }

  function addExportedNamesFromSpecifiers(exportedNamesSet, specifiers) {
    for (const s of specifiers || []) {
      addExportedNameToSet(exportedNamesSet, exportedNameFromSpecifier(s));
    }
  }

  /**
   * Handle `export { ... }` and `export const/let/var` / `export function` forms.
   *
   * What we record
   * --------------
   * We only collect *names* of exported symbols so we can later mark matching
   * function records in `out.functions` as `exported: true`.
   *
   * Supported shapes
   * ----------------
   * - `export function foo() {}`             -> "foo"
   * - `export const a = 1, b = 2`           -> "a", "b"
   * - `export { foo as bar }`               -> "bar" (exported name)
   * - `export { foo }`                      -> "foo"
   *
   * Note: we intentionally ignore re-exports with `from "..."` here because
   * they do not define local functions in this file.
   */
  const handleExportNamedDeclaration = (p) => {
    const node = p?.node;
    if (!node) return;

    addExportedNamesFromDeclaration(exportedNames, node.declaration);
    addExportedNamesFromSpecifiers(exportedNames, node.specifiers);
  };

  const handleExportDefaultDeclaration = (p) => {
    const decl = p.node.declaration;

    if (decl?.type === "FunctionDeclaration" && decl.id?.name) {
      exportedNames.add(decl.id.name);
      return;
    }

    exportedNames.add("default");
  };

  // -------------------------------------------------------------------------
  // 4) Traverse
  // -------------------------------------------------------------------------

  const api = {
    bumpCx,
    enterFunction,
    exitFunction,
    handleImportDeclaration,
    handleCallExpression,
    handleExportNamedDeclaration,
    handleExportDefaultDeclaration
  };

  traverseAst(ast, buildVisitors(api));

  // 5) Finalize: mark exported functions + normalize cc
  finalizeExportFlags(out, exportedNames);

  // Reserved parameters (kept for future AST-based path extraction)
  void baseDir;
  void helpers;
}
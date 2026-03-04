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
export function parseJsTsAst(src, filename, baseDir, out, helpers) {
  const code = String(src || "");

  // ---------------------------------------------------------------------------
  // 0) Ensure containers exist (backward compatible out)
  // ---------------------------------------------------------------------------
  if (!Array.isArray(out.imports)) out.imports = [];
  if (!Array.isArray(out.symbols)) out.symbols = [];
  if (!Array.isArray(out.functions)) out.functions = [];
  if (!Array.isArray(out.calls)) out.calls = [];
  if (!out.importBindings || typeof out.importBindings !== "object") out.importBindings = {};

  // Complexity is incremental (parseFile initializes it).
  if (!Number.isFinite(out.complexity)) out.complexity = 0;

  // ---------------------------------------------------------------------------
  // Config (passed from parseFile)
  // ---------------------------------------------------------------------------
  // Defaults are architecture-first (high-signal graph).
  const cfg = (helpers && typeof helpers === "object" && helpers.config && typeof helpers.config === "object")
    ? helpers.config
    : Object.create(null);

  const mode = String(cfg.mode || "architecture").toLowerCase();

  // Inline callbacks like `.every(x => ...)` are never architecture nodes.
  const includeInlineCallbacks = cfg.includeInlineCallbacks === true ? true : false;

  // Accessors/constructors tend to clutter architecture graphs.
  const includeClassAccessors = cfg.includeClassAccessors === true ? true : false;
  const includeClassConstructor = cfg.includeClassConstructor === true ? true : false;

  // Anonymous functions (`anon@line`) create lots of low-signal fragments.
  // Keep call attribution, but do not emit them as nodes by default.
  const includeAnonymousFunctions = cfg.includeAnonymousFunctions === true ? true : false;

  // Convenience: in "full" mode, keep more details.
  const isFullMode = mode === "full";
  const effIncludeInlineCallbacks = isFullMode ? true : includeInlineCallbacks;
  const effIncludeClassAccessors = isFullMode ? true : includeClassAccessors;
  const effIncludeClassConstructor = isFullMode ? true : includeClassConstructor;
  const effIncludeAnonymousFunctions = isFullMode ? true : includeAnonymousFunctions;

  // ---------------------------------------------------------------------------
  // 1) Parse (best-effort)
  // ---------------------------------------------------------------------------
  let ast = null;
  try {
    ast = parse(code, {
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
    // Syntax errors are expected; keep minimal output.
    return;
  }

  if (!traverseAst) return;

  // ---------------------------------------------------------------------------
  // 2) Local state
  // ---------------------------------------------------------------------------

  /** @type {Set<string>} */
  const exportedNames = new Set();

  /** @type {string[]} */
  const fnStack = [];

  /** @type {Map<string, any>} */
  const fnById = new Map();

  /** @type {Set<string>} */
  const fnIdSeen = new Set();

  for (const f of out.functions) {
    const id = String(f?.id || "");
    if (id) {
      fnIdSeen.add(id);
      fnById.set(id, f);
    }
  }

  // Inline callbacks (e.g. arr.every(x => ...)) are NOT architecture nodes.
  // We skip registering them as functions and keep call attribution on the
  // enclosing function / toplevel.
  const skippedFnNodes = new WeakSet();

  const isInlineCallback = (p) => {
    if (effIncludeInlineCallbacks) return false;
    const node = p?.node;
    if (!node) return false;

    // Only skip anonymous function/arrow expressions.
    const isAnonFnExpr =
      (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") &&
      !node.id?.name;

    if (!isAnonFnExpr) return false;

    // Must be directly inside a CallExpression arguments list.
    const parent = p?.parentPath?.node;
    if (!parent || parent.type !== "CallExpression") return false;

    // Babel uses listKey/key metadata; be permissive.
    return p?.listKey === "arguments" || p?.key === "arguments";
  };

  // ---------------------------------------------------------------------------
  // 3) Helpers
  // ---------------------------------------------------------------------------

  const lineOf = (node) => {
    const l = node?.loc?.start?.line;
    return Number.isFinite(l) ? Number(l) : 0;
  };

  const mkFnId = (name, line) => {
    const n = String(name || "anon").trim() || "anon";
    const ln = Number(line) || 0;
    return `${n}@${ln}`;
  };

  /**
   * currentFn
   * ---------
   * Returns the current *emitted* function id for call attribution.
   *
   * IMPORTANT:
   * - We keep the stack stable for traversal, but we must NEVER leak anonymous
   *   pseudo-ids (like `<anon@123>`) to downstream phases.
   * - Anonymous scopes therefore return `null`, which downstream treats as
   *   "toplevel".
   *
   * @returns {string|null}
   */
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

    // Cyclomatic complexity is 1 + decision points. The +1 baseline is
    // initialized when the function node is created; here we only add deltas.
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

  const inferFnName = (p) => {
    const n = p?.node;
    if (!n) return null;

    // Architecture mode: skip low-signal class fragments.
    if (!effIncludeClassAccessors && isAccessorMethod(n)) return null;
    if (!effIncludeClassConstructor && isConstructorMethod(n)) return null;

    // FunctionDeclaration
    if (n.type === "FunctionDeclaration") return n.id?.name || null;

    // ClassMethod / ObjectMethod (real methods)
    if ((n.type === "ClassMethod" || n.type === "ObjectMethod") && n.key) {
      return getKeyName(n.key);
    }

    const parent = p?.parentPath?.node;
    if (!parent) return effIncludeAnonymousFunctions ? "anon" : null;

    // const foo = () => {}
    if (parent.type === "VariableDeclarator" && parent.id?.type === "Identifier") {
      return parent.id.name;
    }

    // foo.bar = function() {}
    if (parent.type === "AssignmentExpression") {
      return getAssignmentTargetName(parent.left);
    }

    // Deliberately do NOT invent callback names.
    return effIncludeAnonymousFunctions ? "anon" : null;
  };

  const enterFunction = (p) => {
    // Skip inline callbacks entirely in architecture mode.
    if (isInlineCallback(p)) {
      skippedFnNodes.add(p.node);
      return; // do not push onto fnStack
    }

    const inferred = inferFnName(p);
    const line = lineOf(p.node);

    // Keep call attribution stable even when we do not emit a function node.
    if (!inferred) {
      fnStack.push(null);
      return;
    }

    const name = String(inferred || "").trim();
    if (!name) {
      fnStack.push(null);
      return;
    }

    const fnId = mkFnId(name, line);

    if (!fnIdSeen.has(fnId)) {
      fnIdSeen.add(fnId);

      out.functions.push({
        id: fnId,
        name: String(name || ""),
        exported: false,
        complexity: 1,
        cc: 1,
        startLine: Number(line) || 0,
        endLine: Number(line) || 0,
        locLines: 0
      });

      fnById.set(fnId, out.functions[out.functions.length - 1]);
      // Ensure any pre-existing fnObj has baseline and alias
      const fnObj = fnById.get(fnId);
      if (fnObj && typeof fnObj === "object") {
        const base = Number(fnObj.complexity);
        fnObj.complexity = Number.isFinite(base) && base > 0 ? base : 1;
        fnObj.cc = Number(fnObj.cc);
        if (!Number.isFinite(fnObj.cc) || fnObj.cc <= 0) fnObj.cc = fnObj.complexity;
      }
      out.symbols.push({ name: String(name || ""), kind: "function" });
    }

    fnStack.push(fnId);
  };

  const exitFunction = (p) => {
    if (skippedFnNodes.has(p?.node)) return;

    const fnId = fnStack.length ? fnStack[fnStack.length - 1] : null;

    if (fnId) {
      const fnObj = fnById.get(fnId);

      // Anonymous stack markers (e.g. <anon@123>) are used for call attribution only.
      if (fnObj && typeof fnObj === "object") {
        const end = Number(p?.node?.loc?.end?.line) || 0;
        if (end) fnObj.endLine = end;

        const s = Number(fnObj.startLine) || 0;
        const e = Number(fnObj.endLine) || 0;
        fnObj.locLines = s && e && e >= s ? (e - s + 1) : 0;
      }
    }

    fnStack.pop();
  };

  // ---------------------------------------------------------------------------
  // 4) Traverse
  // ---------------------------------------------------------------------------

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

    // Member calls (best-effort)
    maybeRecordMemberCall(callee);
  };

  const addExportedName = (name) => {
    const n = String(name || "").trim();
    if (n) exportedNames.add(n);
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

  const addExportedFromDeclaration = (decl) => {
    for (const nm of extractExportNamesFromDeclaration(decl)) {
      addExportedName(nm);
    }
  };

  const addExportedFromSpecifiers = (specifiers) => {
    for (const s of specifiers || []) {
      const exported = getExportedFromSpecifier(s);
      if (exported) {
        addExportedName(exported);
        continue;
      }

      const local = getLocalFromSpecifier(s);
      if (local) addExportedName(local);
    }
  };

  const handleExportNamedDeclaration = (p) => {
    const node = p?.node;
    if (!node) return;

    addExportedFromDeclaration(node.declaration);
    addExportedFromSpecifiers(node.specifiers);
  };

  traverseAst(ast, {
    // -----------------------------------------------------------------------
    // Imports + bindings
    // -----------------------------------------------------------------------
    ImportDeclaration(p) {
      handleImportDeclaration(p);
    },

    // require("x")
    CallExpression(p) {
      handleCallExpression(p);
    },

    // -----------------------------------------------------------------------
    // Export discovery (names)
    // -----------------------------------------------------------------------
    ExportNamedDeclaration(p) {
      handleExportNamedDeclaration(p);
    },

    ExportDefaultDeclaration(p) {
      const decl = p.node.declaration;

      // default export: if named function, use its name; else mark "default"
      if (decl?.type === "FunctionDeclaration" && decl.id?.name) {
        exportedNames.add(decl.id.name);
      } else {
        exportedNames.add("default");
      }
    },

    // -----------------------------------------------------------------------
    // Complexity heuristic (cheap)
    // -----------------------------------------------------------------------
    IfStatement() { bumpCx(1); },
    ForStatement() { bumpCx(1); },
    WhileStatement() { bumpCx(1); },
    DoWhileStatement() { bumpCx(1); },
    ForInStatement() { bumpCx(1); },
    ForOfStatement() { bumpCx(1); },
    SwitchCase() { bumpCx(1); },
    CatchClause() { bumpCx(1); },
    ConditionalExpression() { bumpCx(1); },
    LogicalExpression(p) {
      const op = p.node?.operator;
      if (op === "&&" || op === "||") bumpCx(1);
    },

    // -----------------------------------------------------------------------
    // Function tracking (valid visitor form)
    // -----------------------------------------------------------------------
    Function: {
      enter(p) { enterFunction(p); },
      exit(p) { exitFunction(p); }
    }
  });

  // ---------------------------------------------------------------------------
  // 5) Finalize: mark exported functions
  // ---------------------------------------------------------------------------
  for (const fn of out.functions) {
    if (!fn || typeof fn !== "object") continue;

    const n = String(fn.name || "").trim();

    if (n && exportedNames.has(n)) fn.exported = true;
    if (exportedNames.has("default") && (!n || n === "anon")) fn.exported = true;
  }

  // Normalize: ensure cc is present for all emitted functions.
  for (const fn of out.functions) {
    if (!fn || typeof fn !== "object") continue;
    const c = Number(fn.complexity);
    if (!Number.isFinite(c) || c <= 0) fn.complexity = 1;
    const cc = Number(fn.cc);
    if (!Number.isFinite(cc) || cc <= 0) fn.cc = fn.complexity;
  }

  // Reserved parameters (kept for future AST-based path extraction)
  void baseDir;
  void helpers;
}
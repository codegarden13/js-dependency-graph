/**
 * parseFile
 * =========
 *
 * Best-effort static signal extraction for project files.
 *
 * Why this exists
 * ---------------
 * Many apps (especially “single-file” servers) have few or no internal JS imports,
 * but still depend on lots of *files and folders*:
 *   - public/ (static frontend)
 *   - config.json / .env
 *   - CSVs, templates, images, CSS
 *
 * To keep the graph meaningful across styles, we parse multiple formats.
 *
 * Supported formats
 * -----------------
 * - JS/TS/JSX/TSX: AST-based extraction via @babel/parser + @babel/traverse
 * - HTML: extract <script src>, <link href>, <img src>, etc.
 * - CSS: extract url(...)
 * - JSON: extract path-like values from common keys (path/file/dir/...)
 * - MD: extract markdown links/images
 *
 * Output Contract (stable)
 * ------------------------
 * {
 *   imports: string[],                 // module specifiers (JS only)
 *   lines: number,                     // non-empty LOC
 *   complexity: number,                // heuristic (JS only)
 *   headerComment: string,             // file header comment (JS/TS only)
 *   symbols: Array<{name, kind}>,       // top-level declarations (JS only)
 *   callsBy: Record<string, string[]>,  // best-effort call attribution (JS only)
 *   assetRefs: string[],               // suspicious string refs that look like assets/data/config
 *   fileRefsAbs: string[]              // absolute file/folder refs resolved from safe patterns
 * }
 *
 * Determinism / Safety
 * --------------------
 * - No runtime execution
 * - No evaluation of dynamic expressions
 * - Only resolve paths from string literals + known base anchors
 */

import path from "node:path";
import { parse } from "@babel/parser";
import traverse from "@babel/traverse";

/**
 * Parse a file and extract graph + diagnostics signals.
 *
 * @param {string} code      Raw file contents
 * @param {string} filename  Absolute or relative path (used for diagnostics)
 */
export function parseFile(code, filename) {
  const src = String(code || "");
  const file = String(filename || "");
  const ext = path.extname(file).toLowerCase();

  // ---------------------------------------------------------------------------
  // Cheap signals even when AST parsing fails
  // ---------------------------------------------------------------------------
  const lines = countNonEmptyLines(src);
  const headerComment = isJsLikeExt(ext) ? extractHeaderComment(src) : "";

  const out = emptyOut({ lines, headerComment });
  const baseDir = safeDirname(file);

  // ---------------------------------------------------------------------------
  // Route by file type
  // ---------------------------------------------------------------------------
  if (isJsLikeExt(ext)) return parseJsTs(src, file, baseDir, out);

  if (ext === ".html" || ext === ".htm") {
    parseHtml(src, baseDir, out);
    scanForAssetyStrings(src, baseDir, out);
    return finalize(out);
  }

  if (ext === ".css") {
    parseCss(src, baseDir, out);
    scanForAssetyStrings(src, baseDir, out);
    return finalize(out);
  }

  if (ext === ".json") {
    parseJson(src, baseDir, out);
    // fallback scan for “loose” refs in JSON that aren’t under known keys
    scanForAssetyStrings(src, baseDir, out);
    return finalize(out);
  }

  if (ext === ".md") {
    parseMarkdown(src, baseDir, out);
    scanForAssetyStrings(src, baseDir, out);
    return finalize(out);
  }

  // Fallback: just scan strings
  scanForAssetyStrings(src, baseDir, out);
  return finalize(out);
}

/* ========================================================================== */
/* JS/TS (AST-based)                                                          */
/* ========================================================================== */

function parseJsTs(src, filename, baseDir, out) {
  let ast;
  try {
    ast = parse(src, {
      sourceType: "unambiguous",
      sourceFilename: filename,
      errorRecovery: true,
      plugins: [
        "jsx",
        "typescript",
        "dynamicImport",
        "classProperties",
        "classPrivateProperties",
        "classPrivateMethods",
        "topLevelAwait"
      ]
    });
  } catch {
    // If syntax is broken, keep stable outputs
    scanForAssetyStrings(src, baseDir, out);
    return finalize(out);
  }

  // ---------------------------------------------------------------------------
  // Call attribution: track which function body we are currently inside.
  // ---------------------------------------------------------------------------
  const fnStack = [];
  const currentCaller = () => (fnStack.length ? fnStack[fnStack.length - 1] : "<toplevel>");

  const pushCall = (caller, callee) => {
    if (!callee) return;
    if (!out.callsBy[caller]) out.callsBy[caller] = [];
    out.callsBy[caller].push(callee);
  };

  // ---------------------------------------------------------------------------
  // File ref resolution: safe patterns only
  // ---------------------------------------------------------------------------
  const constPathVars = new Map(); // varName -> absPath
  const baseVars = new Set(["__dirname"]); // varNames that behave like base dirs

  const addAbsRef = (absPath) => {
    const resolved = safeResolve(absPath);
    if (resolved) out._fileRefsAbs.add(resolved);
  };

  const resolveStringPath = (p) => {
    const v = String(p || "").trim();
    if (!v) return null;
    if (isNonLocalRef(v)) return null;
    return path.isAbsolute(v) ? v : path.resolve(baseDir, v);
  };

  const tryResolvePathCall = (callNode) => {
    if (!callNode || callNode.type !== "CallExpression") return null;

    const callee = callNode.callee;
    if (!callee || callee.type !== "MemberExpression") return null;

    const obj = callee.object;
    const prop = callee.property;

    if (!obj || obj.type !== "Identifier" || obj.name !== "path") return null;
    if (!prop || prop.type !== "Identifier") return null;

    const fn = prop.name;
    if (fn !== "join" && fn !== "resolve") return null;

    const args = callNode.arguments || [];
    if (args.length < 2) return null;

    const base = args[0];
    const rest = args.slice(1);

    let baseAbs = null;

    // base: __dirname-like var
    if (base?.type === "Identifier" && baseVars.has(base.name)) {
      baseAbs = baseDir;
    }

    // base: process.cwd()
    if (!baseAbs && base?.type === "CallExpression") {
      const c = base.callee;
      if (
        c?.type === "MemberExpression" &&
        c.object?.type === "Identifier" &&
        c.object.name === "process" &&
        c.property?.type === "Identifier" &&
        c.property.name === "cwd" &&
        (base.arguments || []).length === 0
      ) {
        // Not evaluating cwd(); use baseDir as deterministic anchor
        baseAbs = baseDir;
      }
    }

    if (!baseAbs) return null;

    const segs = [];
    for (const a of rest) {
      if (!a) return null;
      if (a.type === "StringLiteral" && typeof a.value === "string") {
        segs.push(a.value);
        continue;
      }
      return null; // disallow non-literals
    }

    return path.resolve(baseAbs, ...segs);
  };

  const tryCaptureBaseVar = (id, init) => {
    if (!id || id.type !== "Identifier") return;
    if (!init) return;

    if (init.type === "Identifier" && init.name === "__dirname") {
      baseVars.add(id.name);
      constPathVars.set(id.name, baseDir);
      addAbsRef(baseDir);
      return;
    }

    if (init.type === "CallExpression") {
      const c = init.callee;
      if (
        c?.type === "MemberExpression" &&
        c.object?.type === "Identifier" &&
        c.object.name === "process" &&
        c.property?.type === "Identifier" &&
        c.property.name === "cwd" &&
        (init.arguments || []).length === 0
      ) {
        baseVars.add(id.name);
        constPathVars.set(id.name, baseDir);
        addAbsRef(baseDir);
      }
    }
  };

  traverse.default(ast, {
    Program: {
      enter() {
        if (!out.callsBy["<toplevel>"]) out.callsBy["<toplevel>"] = [];
      }
    },

    // ----------------------------- Imports -----------------------------
    ImportDeclaration(p) {
      const spec = p.node.source && p.node.source.value;
      if (spec) out.imports.push(spec);
    },

    // dynamic import("x")
    Import(p) {
      const parent = p.parent;
      if (parent?.type === "CallExpression") {
        const a0 = parent.arguments && parent.arguments[0];
        if (a0?.type === "StringLiteral") out.imports.push(a0.value);
      }
    },

    // ----------------------------- Variables -----------------------------
    VariableDeclarator(p) {
      const id = p.node.id;
      const init = p.node.init;
      if (!id || id.type !== "Identifier") return;

      tryCaptureBaseVar(id, init);

      // symbols: const foo = () => {}
      const isFn = init && (init.type === "FunctionExpression" || init.type === "ArrowFunctionExpression");
      if (isFn) out.symbols.push({ name: id.name, kind: "const-fn" });

      // file refs: const X = path.join(BASE, "...")
      const abs = tryResolvePathCall(init);
      if (abs) {
        constPathVars.set(id.name, abs);
        addAbsRef(abs);
      }

      // file refs: const X = "./config.json"
      if (init?.type === "StringLiteral") {
        const v = String(init.value || "");
        if (looksLikeAssetPath(v)) {
          out.assetRefs.push(v);
          const abs2 = resolveStringPath(v);
          if (abs2) addAbsRef(abs2);
        }
      }
    },

    // ----------------------------- Calls -----------------------------
    CallExpression(p) {
      const node = p.node;
      const callee = node.callee;
      const arg0 = node.arguments && node.arguments[0];

      // require("x")
      const isRequireCall =
        callee?.type === "Identifier" &&
        callee.name === "require" &&
        arg0?.type === "StringLiteral";

      if (isRequireCall) {
        out.imports.push(arg0.value);
        return;
      }

      // foo(...)
      if (callee?.type === "Identifier") {
        pushCall(currentCaller(), callee.name);
      }

      // string literal path-like argument -> assetRefs
      if (arg0?.type === "StringLiteral") {
        const s = String(arg0.value || "");
        if (looksLikeAssetPath(s)) out.assetRefs.push(s);
      }

      // inline path.join/path.resolve
      const absInline = tryResolvePathCall(node);
      if (absInline) addAbsRef(absInline);

      // fs.*(X) with safe arg forms
      const isFsCall =
        callee?.type === "MemberExpression" &&
        callee.object?.type === "Identifier" &&
        callee.object.name === "fs" &&
        callee.property?.type === "Identifier" &&
        [
          "readFileSync",
          "readFile",
          "writeFileSync",
          "writeFile",
          "createReadStream",
          "createWriteStream",
          "existsSync",
          "statSync",
          "lstatSync",
          "readdirSync",
          "mkdirSync"
        ].includes(callee.property.name);

      if (isFsCall && arg0) {
        if (arg0.type === "Identifier") {
          const abs = constPathVars.get(arg0.name);
          if (abs) addAbsRef(abs);
        } else if (arg0.type === "StringLiteral") {
          const abs = resolveStringPath(String(arg0.value || ""));
          if (abs) addAbsRef(abs);
        } else {
          const abs2 = tryResolvePathCall(arg0);
          if (abs2) addAbsRef(abs2);
        }
      }

      // express.static(X)
      const isExpressStatic =
        callee?.type === "MemberExpression" &&
        callee.property?.type === "Identifier" &&
        callee.property.name === "static";

      if (isExpressStatic && arg0) {
        if (arg0.type === "Identifier") {
          const abs = constPathVars.get(arg0.name);
          if (abs) addAbsRef(abs);
        } else {
          const abs2 = tryResolvePathCall(arg0);
          if (abs2) addAbsRef(abs2);
        }
      }
    },

    // ----------------------------- Broad asset hinting -----------------------------
    StringLiteral(p) {
      const v = String(p.node.value || "");
      if (looksLikeAssetPath(v)) out.assetRefs.push(v);
    },

    TemplateElement(p) {
      const raw = String(p.node.value?.cooked || p.node.value?.raw || "");
      if (looksLikeAssetPath(raw)) out.assetRefs.push(raw);
    },

    // ----------------------------- Complexity heuristic -----------------------------
    IfStatement() { out.complexity++; },
    ForStatement() { out.complexity++; },
    ForInStatement() { out.complexity++; },
    ForOfStatement() { out.complexity++; },
    WhileStatement() { out.complexity++; },
    DoWhileStatement() { out.complexity++; },
    CatchClause() { out.complexity++; },
    ConditionalExpression() { out.complexity++; },

    SwitchCase(p) {
      if (p.node.test != null) out.complexity++;
    },

    LogicalExpression(p) {
      const op = p.node.operator;
      if (op === "&&" || op === "||") out.complexity++;
    },

    // ----------------------------- Symbols + call attribution -----------------------------
    FunctionDeclaration: {
      enter(p) {
        const name = p.node.id && p.node.id.name;
        if (name) out.symbols.push({ name, kind: "function" });
        fnStack.push(name || "<anonymous>");
      },
      exit() {
        fnStack.pop();
      }
    },

    FunctionExpression: {
      enter(p) {
        const parent = p.parent;
        let name = "<anonymous>";

        if (p.node.id?.name) name = p.node.id.name;
        else if (parent?.type === "VariableDeclarator" && parent.id?.type === "Identifier") name = parent.id.name;
        else if (parent?.type === "ObjectProperty" && parent.key) {
          name = parent.key.name ? parent.key.name : (parent.key.value ? parent.key.value : "<anonymous>");
        }

        fnStack.push(String(name || "<anonymous>"));
      },
      exit() {
        fnStack.pop();
      }
    },

    ArrowFunctionExpression: {
      enter(p) {
        const parent = p.parent;
        let name = "<anonymous>";

        if (parent?.type === "VariableDeclarator" && parent.id?.type === "Identifier") name = parent.id.name;
        else if (parent?.type === "ObjectProperty" && parent.key) {
          name = parent.key.name ? parent.key.name : (parent.key.value ? parent.key.value : "<anonymous>");
        }

        fnStack.push(String(name || "<anonymous>"));
      },
      exit() {
        fnStack.pop();
      }
    },

    ClassDeclaration(p) {
      const name = p.node.id && p.node.id.name;
      if (name) out.symbols.push({ name, kind: "class" });
    },

    ExportNamedDeclaration(p) {
      if (p.node.declaration?.type === "FunctionDeclaration") {
        const name = p.node.declaration.id?.name;
        if (name) out.symbols.push({ name, kind: "export" });
      }

      if (p.node.declaration?.type === "VariableDeclaration") {
        for (const decl of p.node.declaration.declarations || []) {
          if (decl.id?.type === "Identifier") out.symbols.push({ name: decl.id.name, kind: "export" });
        }
      }

      for (const spec of p.node.specifiers || []) {
        const local = spec.local?.name;
        const exported = spec.exported?.name;
        const nm = exported || local;
        if (nm) out.symbols.push({ name: nm, kind: "export" });
      }
    },

    ExportDefaultDeclaration(p) {
      const decl = p.node.declaration;
      if (!decl) return;

      if (decl.type === "FunctionDeclaration") out.symbols.push({ name: decl.id?.name || "default", kind: "export" });
      if (decl.type === "ClassDeclaration") out.symbols.push({ name: decl.id?.name || "default", kind: "export" });
    }
  });

  // Extra scan catches “simple” single-file refs
  scanForAssetyStrings(src, baseDir, out);

  return finalize(out);
}

/* ========================================================================== */
/* HTML/CSS/JSON/MD (lightweight extractors)                                  */
/* ========================================================================== */

function parseHtml(src, baseDir, out) {
  // src/href/data-src/data-href
  const ATTR_RE = /\b(?:src|href|data-src|data-href)\s*=\s*(["'])(.*?)\1/gi;
  let m;
  while ((m = ATTR_RE.exec(src))) {
    addRefFromText(m[2], baseDir, out);
  }
}

function parseCss(src, baseDir, out) {
  // url(...)
  const URL_RE = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;
  let m;
  while ((m = URL_RE.exec(src))) {
    addRefFromText(m[2], baseDir, out);
  }
}

function parseMarkdown(src, baseDir, out) {
  // [text](path) and ![alt](path)
  const MD_LINK_RE = /!\[[^\]]*]\(([^)]+)\)|\[[^\]]*]\(([^)]+)\)/g;
  let m;
  while ((m = MD_LINK_RE.exec(src))) {
    const ref = String(m[1] || m[2] || "").trim().replace(/^<|>$/g, "");
    addRefFromText(ref, baseDir, out);
  }
}

function parseJson(src, baseDir, out) {
  let obj;
  try {
    obj = JSON.parse(src);
  } catch {
    return;
  }

  const PATH_KEYS = new Set([
    "path", "file", "filepath", "filename", "dir", "folder",
    "root", "rootdir", "rootDir",
    "csvPath", "dataPath",
    "publicDir", "staticDir", "assetsDir",
    "template", "templates", "view", "views"
  ]);

  const walk = (v, parentKey) => {
    if (v == null) return;

    if (Array.isArray(v)) {
      for (const item of v) walk(item, parentKey);
      return;
    }

    if (typeof v === "object") {
      for (const [k, val] of Object.entries(v)) walk(val, k);
      return;
    }

    if (typeof v === "string") {
      const key = String(parentKey || "");
      const keyLc = key.toLowerCase();

      if (PATH_KEYS.has(key) || PATH_KEYS.has(keyLc) || keyLc.endsWith("path") || keyLc.endsWith("dir")) {
        addRefFromText(v, baseDir, out);
        return;
      }

      if (looksLikeAssetPath(v)) addRefFromText(v, baseDir, out);
    }
  };

  walk(obj, "");
}

/* ========================================================================== */
/* Shared helpers                                                             */
/* ========================================================================== */

function emptyOut({ lines, headerComment }) {
  return {
    imports: [],
    lines: Number(lines || 0),
    complexity: 0,
    headerComment: String(headerComment || ""),
    symbols: [],
    callsBy: {},
    assetRefs: [],
    _fileRefsAbs: new Set()
  };
}

function finalize(out) {
  out.imports = uniq(out.imports);
  out.assetRefs = uniq(out.assetRefs);

  out.callsBy = Object.fromEntries(
    Object.entries(out.callsBy).map(([k, v]) => [k, uniq(v)])
  );

  out.symbols = uniq(out.symbols.map((s) => `${s.kind}:${s.name}`)).map((x) => {
    const [kind, name] = x.split(":");
    return { kind, name };
  });

  out.fileRefsAbs = Array.from(out._fileRefsAbs);
  delete out._fileRefsAbs;

  return out;
}

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function safeDirname(file) {
  try {
    const d = path.dirname(String(file || ""));
    return d && d !== "." ? d : process.cwd();
  } catch {
    return process.cwd();
  }
}

function safeResolve(p) {
  try {
    const s = String(p || "").trim();
    if (!s) return null;
    return path.resolve(s);
  } catch {
    return null;
  }
}

function isJsLikeExt(ext) {
  return ext === ".js" || ext === ".mjs" || ext === ".cjs" || ext === ".ts" || ext === ".tsx" || ext === ".jsx";
}

function isNonLocalRef(v) {
  const s = String(v || "").trim();
  if (!s) return true;
  if (/^https?:\/\//i.test(s)) return true;
  if (/^data:/i.test(s)) return true;
  if (/^mailto:/i.test(s)) return true;
  if (s.startsWith("#")) return true;
  return false;
}

function addRefFromText(ref, baseDir, out) {
  const s0 = String(ref || "").trim();
  if (!s0) return;
  if (isNonLocalRef(s0)) return;

  // strip query/hash
  const s = s0.split("#")[0].split("?")[0].trim();
  if (!s) return;

  if (looksLikeAssetPath(s)) out.assetRefs.push(s);

  const abs = path.isAbsolute(s) ? s : path.resolve(baseDir, s);
  const absResolved = safeResolve(abs);
  if (absResolved) out._fileRefsAbs.add(absResolved);
}

function scanForAssetyStrings(src, baseDir, out) {
  // conservative: quoted strings only
  const STR_RE = /(["'`])([^\n\r]*?)\1/g;
  let m;
  while ((m = STR_RE.exec(src))) {
    const raw = String(m[2] || "");
    if (!raw || raw.length > 260) continue;
    if (!looksLikeAssetPath(raw)) continue;
    addRefFromText(raw, baseDir, out);
  }
}

function countNonEmptyLines(code) {
  return String(code || "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .length;
}

function extractHeaderComment(code) {
  let s = String(code || "").replace(/\r\n/g, "\n");

  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);

  if (s.startsWith("#!")) {
    const nl = s.indexOf("\n");
    s = nl >= 0 ? s.slice(nl + 1) : "";
  }

  s = s.replace(/^\s+/, "");

  const block = s.match(/^\/\*\*?[\s\S]*?\*\//);
  if (block) return cleanupBlock(block[0]);

  const lines = s.split("\n");
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      if (out.length === 0) continue;
      break;
    }
    if (t.startsWith("//")) {
      out.push(t.replace(/^\/\/\s?/, ""));
      continue;
    }
    break;
  }
  return out.join("\n").trim();

  function cleanupBlock(b) {
    return b
      .replace(/^\/\*\*?/, "")
      .replace(/\*\/$/, "")
      .split("\n")
      .map((l) => l.replace(/^\s*\*\s?/, "").trimEnd())
      .join("\n")
      .trim();
  }
}

function looksLikeAssetPath(s) {
  const v = String(s || "").trim();
  if (!v) return false;

  if (/^https?:\/\//i.test(v)) return false;
  if (/^\.DS_Store$/i.test(v)) return false;

  // leading slash (web paths) count as refs too
  if (v.startsWith("/") && !v.startsWith("//")) return true;

  // extensions
  if (/\.(json|ya?ml|toml|ini|env|csv|tsv|txt|md|html?|css|svg|png|jpe?g|gif|webp|ico|map)$/i.test(v)) return true;

  // folders
  if (/^(config|data|public|assets|static|views|templates)\//i.test(v)) return true;
  if (/^(\.\/|\.\.\/)/.test(v) && /(config|data|public|assets|static|views|templates)\//i.test(v)) return true;

  // filenames
  if (/^(config|settings)\.(json|ya?ml|toml|ini)$/i.test(v)) return true;

  return false;
}
/**
 * parseFile
 * =========
 *
 * Lightweight static extraction for JS/TS source files.
 *
 * Purpose
 * -------
 * - Module dependency hints (ESM imports + CommonJS require())
 * - Basic size metric (non-empty LOC)
 * - Heuristic complexity score (control-flow + boolean logic indicators)
 * - File header comment extraction (top-of-file docblock / line block)
 *
 * Design Notes
 * ------------
 * - Best-effort parsing: errorRecovery is enabled to keep analysis resilient
 * - Mixed JS/TS: Babel parser plugins support typical Node/Web projects
 * - Not a full semantic model: no type resolution or runtime evaluation
 *
 * Output Contract
 * ---------------
 * {
 *   imports: string[],
 *   lines: number,
 *   complexity: number,
 *   headerComment: string
 * }
 */

import { parse } from "@babel/parser";
import traverse from "@babel/traverse";

/**
 * Parse a JS/TS file and extract imports + basic metrics + header comment.
 *
 * @param {string} code      Raw file contents
 * @param {string} filename  Absolute or relative path (used for diagnostics)
 * @returns {{imports: string[], lines: number, complexity: number, headerComment: string}}
 */
export function parseFile(code, filename) {
  const src = String(code || "");

  // 1) Always compute cheap signals (even if AST parse fails)
  const lines = countNonEmptyLines(src);
  const headerComment = extractHeaderComment(src);

  // 2) Parse to AST (best-effort) + traverse
  const imports = [];
  let complexity = 0;

  let ast = null;
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
    // If parsing fails, return what we have (lines/headerComment) and defaults.
    return { imports, lines, complexity, headerComment };
  }

  traverse.default(ast, {
    // ---- ESM import ... from "x" ----
    ImportDeclaration(p) {
      const spec = p.node.source && p.node.source.value;
      if (spec) imports.push(spec);
    },

    // ---- CommonJS require("x") ----
    CallExpression(p) {
      const callee = p.node.callee;
      const arg0 = p.node.arguments && p.node.arguments[0];

      const isRequireCall =
        callee &&
        callee.type === "Identifier" &&
        callee.name === "require" &&
        arg0 &&
        arg0.type === "StringLiteral";

      if (isRequireCall) imports.push(arg0.value);
    },

    // ---- Complexity heuristic ----
    IfStatement() { complexity++; },
    ForStatement() { complexity++; },
    ForInStatement() { complexity++; },
    ForOfStatement() { complexity++; },
    WhileStatement() { complexity++; },
    DoWhileStatement() { complexity++; },

    SwitchCase(p) {
      if (p.node.test != null) complexity++;
    },

    CatchClause() { complexity++; },
    ConditionalExpression() { complexity++; },

    LogicalExpression(p) {
      const op = p.node.operator;
      if (op === "&&" || op === "||") complexity++;
    }
  });

  return { imports, lines, complexity, headerComment };
}

/* ====================================================================== */
/* Helpers                                                                */
/* ====================================================================== */

function countNonEmptyLines(code) {
  return String(code || "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .length;
}

/**
 * Extract a "file header" comment from the very top of a file.
 *
 * Supported patterns (at the start of the file):
 * - Block comment starting with "/*" or "/**" (docblock)
 * - One or more consecutive "//" lines
 *
 * Skips BOM, shebang, and leading whitespace.
 *
 * @param {string} code
 * @returns {string}
 */
function extractHeaderComment(code) {
  let s = String(code || "").replace(/\r\n/g, "\n");

  // strip BOM
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);

  // strip shebang
  if (s.startsWith("#!")) {
    const nl = s.indexOf("\n");
    s = nl >= 0 ? s.slice(nl + 1) : "";
  }

  // trim leading whitespace/newlines
  s = s.replace(/^\s+/, "");

  // 1) block comment at top
  const block = s.match(/^\/\*\*?[\s\S]*?\*\//);
  if (block) return cleanupBlock(block[0]);

  // 2) consecutive // lines at top
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
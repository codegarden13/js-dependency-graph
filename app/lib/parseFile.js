/**
 * parseFile
 * ========
 *
 * Stable, backend-facing per-file parser wrapper.
 *
 * Responsibilities
 * ----------------
 * - Never throw
 * - Always return a consistent result shape
 * - Delegate JS/TS AST extraction to `parseJsTsAst` (app/lib/parseAst.js)
 *
 * Notes
 * -----
 * - This module intentionally contains *no* Babel parser/traverse logic.
 * - Avoid self-imports (direct or indirect) to prevent ESM circular evaluation issues.
 */
import path from "node:path";
import { parseJsTsAst } from "./parseAst.js";
import { summarizeLineMetrics } from "./lineMetrics.js";

/* ========================================================================== */
/* PUBLIC API: parseFile                                                      */
/* ========================================================================== */

/**
 * parseFile
 * ---------
 * Stable, backend-facing wrapper used by the graph builder.
 *
 * Responsibilities:
 * - Never throw
 * - Provide a consistent result shape across file types
 * - Delegate JS/TS parsing to parseJsTsAst()
 *
 * @param {string} src
 * @param {string} filenameAbs
 * @returns {{
 *   imports: string[],
 *   importBindings: Record<string, {source: string, imported: string}>,
 *   functions: Array<{id: string, name: string, exported: boolean, complexity: number, startLine: number, endLine: number, locLines: number}>,
 *   calls: Array<{from: string|null, callee: string}>,
 *   lines: number,
 *   codeLines: number,
 *   commentLines: number,
 *   blankLines: number,
 *   complexity: number,
 *   headerComment: string,
 *   fileRefsAbs: string[],
 *   fileRefsRel: string[],
 *   assetRefsAbs: string[],
 *   assetRefsRel: string[]
 * }}
 */
export function parseFile(src, filenameAbs) {
  // -----------------------------------------------------------------------
  // 0) Defensive normalization
  // -----------------------------------------------------------------------
  const code = String(src || "");
  const filename = String(filenameAbs || "");
  const ext = String(path.extname(filename)).toLowerCase();
  const lineMetrics = summarizeLineMetrics(code, ext);

  // -----------------------------------------------------------------------
  // 1) Stable output contract (always return this shape)
  // -----------------------------------------------------------------------
  const out = {
    imports: [],
    importBindings: {},
    functions: [],
    calls: [],
    symbols: [],

    lines: lineMetrics.lines,
    codeLines: lineMetrics.codeLines,
    commentLines: lineMetrics.commentLines,
    blankLines: lineMetrics.blankLines,
    complexity: 0,
    headerComment: extractHeaderComment(code),

    // Auto-mode reference buckets (may stay empty)
    fileRefsAbs: [],
    fileRefsRel: [],
    assetRefsAbs: [],
    assetRefsRel: []
  };

  // -----------------------------------------------------------------------
  // 2) JS/TS: enrich using AST extractor
  // -----------------------------------------------------------------------
  if (isJsTsExt(ext)) {
    try {
      const baseDir = filename ? path.dirname(filename) : "";
      parseJsTsAst(code, filename, baseDir, out, {
        // AST extraction config (architecture-first)
        // - keeps the graph high-signal
        // - avoids synthetic fragment nodes (inline callbacks)
        // - avoids class accessors (get/set) which look like “functions” in AST
        config: {
          mode: "architecture",
          includeInlineCallbacks: false,
          includeClassAccessors: false,
          includeClassConstructor: false,
        }
      });
    } catch {
      // Never throw – keep the minimal out object.
    }
  }

  return out;
}

/* ========================================================================== */
/* INTERNAL HELPERS                                                          */
/* ========================================================================== */

function isJsTsExt(ext) {
  return ext === ".js" || ext === ".mjs" || ext === ".cjs" || ext === ".jsx" ||
    ext === ".ts" || ext === ".tsx";
}

function stripUtf8Bom(src) {
  // Strip UTF-8 BOM if present
  return String(src || "").replace(/^\ufeff?/, "");
}

function removeShebangLine(src) {
  const s = String(src || "");
  if (!s.startsWith("#!")) return s;

  // Remove the first line (shebang) and keep the rest.
  return s.split(/\r\n|\r|\n/).slice(1).join("\n");
}

function readLeadingJSDocBlock(src) {
  // Prefer a leading block comment (/** ... */) at the top of file.
  const m = String(src || "").match(/^\s*\/\*\*([\s\S]*?)\*\//);
  if (!m || !m[1]) return "";

  return normalizeJSDocBody(m[1]);
}

function normalizeJSDocBody(body) {
  return String(body || "")
    .split("\n")
    .map((l) => String(l).replace(/^\s*\*\s?/, "").trimEnd())
    .join("\n")
    .trim();
}

function readLeadingLineCommentBlock(src) {
  // Fallback: leading // comment block (consecutive lines)
  const lines = String(src || "").split(/\r\n|\r|\n/);
  const buf = collectLeadingLineComments(lines);
  return buf.join("\n").trim();
}

function collectLeadingLineComments(lines) {
  const buf = [];

  for (const line of lines || []) {
    const t = String(line || "").trim();

    if (!t) {
      if (buf.length) break; // stop once started and hit blank
      continue;
    }

    if (!t.startsWith("//")) break;

    buf.push(t.replace(/^\/\/\s?/, ""));
  }

  return buf;
}

function extractHeaderComment(code) {
  const src = String(code || "");
  if (!src) return "";

  const base = stripUtf8Bom(src);
  const text = removeShebangLine(base);

  const block = readLeadingJSDocBlock(text);
  if (block) return block;

  return readLeadingLineCommentBlock(text);
}

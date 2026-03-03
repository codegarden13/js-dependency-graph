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

  // -----------------------------------------------------------------------
  // 1) Stable output contract (always return this shape)
  // -----------------------------------------------------------------------
  const out = {
    imports: [],
    importBindings: {},
    functions: [],
    calls: [],
    symbols: [],

    lines: countLines(code),
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

function countLines(code) {
  if (!code) return 0;
  // Count newline occurrences + 1 (handles files without trailing newline)
  return String(code).split(/\r\n|\r|\n/).length;
}

function extractHeaderComment(code) {
  const src = String(code || "");

  // ---------------------------------------------------------------------
  // Prefer a leading block comment (/** ... */) at the top of file.
  // ---------------------------------------------------------------------
  const trimmed = src.replace(/^\ufeff?/, ""); // strip UTF-8 BOM if present

  // Allow a shebang first line.
  const afterShebang = trimmed.startsWith("#!")
    ? trimmed.split(/\r\n|\r|\n/).slice(1).join("\n")
    : trimmed;

  const m = afterShebang.match(/^\s*\/\*\*([\s\S]*?)\*\//);
  if (m && m[1]) {
    return m[1]
      .split("\n")
      .map((l) => l.replace(/^\s*\*\s?/, "").trimEnd())
      .join("\n")
      .trim();
  }

  // ---------------------------------------------------------------------
  // Fallback: leading // comment block (consecutive lines)
  // ---------------------------------------------------------------------
  const lines = afterShebang.split(/\r\n|\r|\n/);
  const buf = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      // Stop once we have started collecting and hit a blank line.
      if (buf.length) break;
      continue;
    }
    if (t.startsWith("//")) {
      buf.push(t.replace(/^\/\/\s?/, ""));
      continue;
    }
    break;
  }

  return buf.join("\n").trim();
}

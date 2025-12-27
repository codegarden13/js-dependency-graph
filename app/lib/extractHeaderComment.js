// app/lib/extractHeaderComment.js
/**
 * Extracts an "industry-style" file header comment from source text.
 *
 * Supported:
 * - /** ... *\/  (JSDoc/block header at top)
 * - // ...       (one or many line comments at top)
 *
 * Ignores:
 * - shebang (#!/usr/bin/env node)
 * - leading blank lines
 *
 * Returns:
 * - string (trimmed) or "" if none found
 */
export function extractHeaderComment(src) {
  if (!src) return "";

  let s = String(src);

  // Normalize newlines
  s = s.replace(/\r\n/g, "\n");

  // Strip BOM
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);

  // Strip shebang
  if (s.startsWith("#!")) {
    const nl = s.indexOf("\n");
    s = nl >= 0 ? s.slice(nl + 1) : "";
  }

  // Skip leading whitespace/newlines
  s = s.replace(/^\s+/, "");

  // 1) Block comment at top (/** ... */ or /* ... */)
  const blockMatch = s.match(/^\/\*\*?[\s\S]*?\*\//);
  if (blockMatch) {
    return cleanupBlock(blockMatch[0]);
  }

  // 2) One or more // lines at top
  const lineMatches = [];
  const lines = s.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      // allow initial blank lines only if we haven't started collecting
      if (lineMatches.length === 0) continue;
      break;
    }
    if (trimmed.startsWith("//")) {
      lineMatches.push(trimmed.replace(/^\/\/\s?/, ""));
      continue;
    }
    break; // first non-comment line => stop
  }
  return lineMatches.join("\n").trim();

  function cleanupBlock(block) {
    // Remove /*, */, and leading stars
    return block
      .replace(/^\/\*\*?/, "")
      .replace(/\*\/$/, "")
      .split("\n")
      .map((l) => l.replace(/^\s*\*\s?/, "").trimEnd())
      .join("\n")
      .trim();
  }
}
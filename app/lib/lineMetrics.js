import path from "node:path";

const JS_LIKE_EXTS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".css",
  ".scss",
  ".sass",
  ".less"
]);

const HTML_LIKE_EXTS = new Set([
  ".html",
  ".htm",
  ".xml",
  ".svg",
  ".vue",
  ".svelte"
]);

export function summarizeLineMetrics(source, fileExt) {
  const ext = String(fileExt || "").toLowerCase();
  const lines = splitLines(source);

  if (JS_LIKE_EXTS.has(ext)) {
    return summarizeJsLikeLines(lines);
  }

  if (HTML_LIKE_EXTS.has(ext)) {
    return summarizeHtmlLikeLines(lines);
  }

  return summarizePlainTextLines(lines);
}

export function summarizeLineMetricsForFile(source, filenameAbs) {
  return summarizeLineMetrics(source, path.extname(String(filenameAbs || "")));
}

function splitLines(source) {
  const text = String(source || "");
  if (!text) return [];
  return text.split(/\r\n|\r|\n/);
}

function emptyLineMetrics() {
  return {
    lines: 0,
    codeLines: 0,
    commentLines: 0,
    blankLines: 0
  };
}

function summarizePlainTextLines(lines) {
  const summary = emptyLineMetrics();
  summary.lines = lines.length;

  for (const line of lines) {
    if (!String(line || "").trim()) {
      summary.blankLines++;
      continue;
    }

    summary.codeLines++;
  }

  return summary;
}

function summarizeJsLikeLines(lines) {
  const summary = emptyLineMetrics();
  let inBlockComment = false;

  summary.lines = lines.length;

  for (const line of lines) {
    const state = classifyJsLikeLine(line, inBlockComment);
    inBlockComment = state.inBlockComment;
    applyLineState(summary, state);
  }

  return summary;
}

function summarizeHtmlLikeLines(lines) {
  const summary = emptyLineMetrics();
  let inComment = false;

  summary.lines = lines.length;

  for (const line of lines) {
    const state = classifyHtmlLikeLine(line, inComment);
    inComment = state.inComment;
    applyLineState(summary, state);
  }

  return summary;
}

function applyLineState(summary, state) {
  if (state.hasCode) {
    summary.codeLines++;
    return;
  }

  if (state.hasComment) {
    summary.commentLines++;
    return;
  }

  summary.blankLines++;
}

function classifyJsLikeLine(line, inBlockComment) {
  const text = String(line || "");
  let index = 0;
  let hasCode = false;
  let hasComment = false;
  let insideBlockComment = Boolean(inBlockComment);

  while (index < text.length) {
    if (insideBlockComment) {
      hasComment = true;
      const endIndex = text.indexOf("*/", index);
      if (endIndex === -1) {
        return { hasCode, hasComment, inBlockComment: true };
      }

      insideBlockComment = false;
      index = endIndex + 2;
      continue;
    }

    const ch = text[index];

    if (/\s/.test(ch)) {
      index++;
      continue;
    }

    if (ch === "/" && text[index + 1] === "/") {
      hasComment = true;
      break;
    }

    if (ch === "/" && text[index + 1] === "*") {
      hasComment = true;
      insideBlockComment = true;
      index += 2;
      continue;
    }

    if (ch === `"` || ch === `'` || ch === "`") {
      hasCode = true;
      index = skipQuotedSegment(text, index + 1, ch);
      continue;
    }

    hasCode = true;
    index++;
  }

  return {
    hasCode,
    hasComment,
    inBlockComment: insideBlockComment
  };
}

function classifyHtmlLikeLine(line, inComment) {
  const text = String(line || "");
  let index = 0;
  let hasCode = false;
  let hasComment = false;
  let insideComment = Boolean(inComment);

  while (index < text.length) {
    if (insideComment) {
      hasComment = true;
      const endIndex = text.indexOf("-->", index);
      if (endIndex === -1) {
        return { hasCode, hasComment, inComment: true };
      }

      insideComment = false;
      index = endIndex + 3;
      continue;
    }

    const ch = text[index];

    if (/\s/.test(ch)) {
      index++;
      continue;
    }

    if (text.startsWith("<!--", index)) {
      hasComment = true;
      insideComment = true;
      index += 4;
      continue;
    }

    if (ch === `"` || ch === `'`) {
      hasCode = true;
      index = skipQuotedSegment(text, index + 1, ch);
      continue;
    }

    hasCode = true;
    index++;
  }

  return {
    hasCode,
    hasComment,
    inComment: insideComment
  };
}

function skipQuotedSegment(text, startIndex, quoteChar) {
  let index = startIndex;

  while (index < text.length) {
    const ch = text[index];

    if (ch === "\\") {
      index += 2;
      continue;
    }

    if (ch === quoteChar) {
      return index + 1;
    }

    index++;
  }

  return index;
}



/**
 * CodeGraph tooltip content helpers.
 * ---------------------------------------------------------------------------
 * Owns graph-specific tooltip HTML generation.
 * DOM lifecycle and positioning stay in `ui.tooltip.js`.
 */

/**
 * Build the tooltip HTML for one graph node.
 *
 * @param {any} d
 * @param {{
 *   escapeHtml?: ((value:any) => string)|null,
 *   isFunctionNode?: ((node:any) => boolean)|null,
 *   toSafeInt?: ((value:any) => number)|null
 * }=} opts
 * @returns {string}
 */
export function buildTooltipHtml(d, opts = {}) {
  const esc = getTooltipEscaper(opts);
  const isFunctionNode = readIsFunctionNode(opts);

  const lines = getTooltipLines(d);
  const complexity = getTooltipComplexity(d);
  const display = getTooltipDisplayLabel(d, esc);
  const typeLabel = getTooltipTypeLabel(d, esc);
  const fnDiagHtml = isFunctionNode(d) ? buildFunctionDiagHtml(d, opts) : "";

  return (
    `<strong>${display}</strong>` +
    `<br><small>Type: ${typeLabel}</small>` +
    `<br><small>Lines: ${esc(lines)}</small>` +
    `<br><small>Complexity: ${esc(complexity)}</small>` +
    fnDiagHtml
  );
}

/**
 * Resolve the HTML escaper used by tooltip rendering.
 *
 * @param {{ escapeHtml?: ((value:any) => string)|null }=} opts
 * @returns {(value:any) => string}
 */
function getTooltipEscaper(opts = {}) {
  return typeof opts.escapeHtml === "function"
    ? opts.escapeHtml
    : defaultEscapeHtml;
}

/**
 * Read the line metric shown in the tooltip.
 * Prefers normalized display fields, then common legacy fields.
 *
 * @param {any} d
 * @returns {any}
 */
function getTooltipLines(d) {
  return pickFirst(d?.__displayLines, d?.lines, d?.loc, d?.size, "?");
}

/**
 * Read the complexity metric shown in the tooltip.
 * Falls back to a simple degree proxy when no complexity field exists.
 *
 * @param {any} d
 * @returns {any}
 */
export function getTooltipComplexity(d) {
  const degreeProxy = (d?._inbound || 0) + (d?._outbound || 0);
  return pickFirst(d?.__displayComplexity, d?.complexity, d?.cc, degreeProxy, "?");
}

/**
 * Read the preferred display label for a node.
 *
 * @param {any} d
 * @param {(value:any) => string} esc
 * @returns {string}
 */
function getTooltipDisplayLabel(d, esc) {
  const label = d?.__displayLabel ? d.__displayLabel : d?.id;
  return esc(label);
}

/**
 * Read the preferred type label for a node.
 *
 * @param {any} d
 * @param {(value:any) => string} esc
 * @returns {string}
 */
function getTooltipTypeLabel(d, esc) {
  return esc(d?.type || d?.kind || "file");
}

/**
 * Build the function-specific diagnostics block.
 *
 * @param {any} d
 * @param {{
 *   escapeHtml?: ((value:any) => string)|null,
 *   toSafeInt?: ((value:any) => number)|null
 * }=} opts
 * @returns {string}
 */
function buildFunctionDiagHtml(d, opts = {}) {
  const esc = getTooltipEscaper(opts);
  const calls = readFunctionCallStats(d, opts);
  const flags = readFunctionFlags(d);

  return (
    buildCallsLine(calls, esc) +
    buildFlagsLine(flags, esc) +
    buildTopListLine("Top x callers", calls.callers, esc) +
    buildTopListLine("Top callees", calls.callees, esc)
  );
}

/**
 * Read function call counts and caller/callee lists.
 *
 * @param {any} d
 * @param {{ toSafeInt?: ((value:any) => number)|null }=} opts
 * @returns {{ inCalls:number, outCalls:number, callers:any[], callees:any[] }}
 */
function readFunctionCallStats(d, opts = {}) {
  const toSafeInt = readToSafeInt(opts);

  return {
    inCalls: toSafeInt(d?._inCalls),
    outCalls: toSafeInt(d?._outCalls),
    callers: Array.isArray(d?._callers) ? d._callers : [],
    callees: Array.isArray(d?._callees) ? d._callees : [],
  };
}

/**
 * Read boolean function flags used by the tooltip.
 *
 * @param {any} d
 * @returns {{ exported:boolean, unused:boolean }}
 */
function readFunctionFlags(d) {
  return {
    exported: d?.exported === true,
    unused: d?._unused === true,
  };
}

/**
 * Render the compact call count line.
 *
 * @param {{ inCalls:number, outCalls:number }} calls
 * @param {(value:any) => string} esc
 * @returns {string}
 */
function buildCallsLine(calls, esc) {
  return `<br><small>Calls: in ${esc(String(calls.inCalls))} / out ${esc(String(calls.outCalls))}</small>`;
}

/**
 * Render the exported/unused flags line.
 *
 * @param {{ exported:boolean, unused:boolean }} flags
 * @param {(value:any) => string} esc
 * @returns {string}
 */
function buildFlagsLine(flags, esc) {
  const exported = flags.exported ? "yes" : "no";
  const unused = flags.unused ? "yes" : "no";
  return `<br><small>Exported: ${esc(exported)} | Unused: ${esc(unused)}</small>`;
}

/**
 * Render a short id list line.
 * Limits output to five entries.
 *
 * @param {string} label
 * @param {any[]} arr
 * @param {(value:any) => string} esc
 * @returns {string}
 */
function buildTopListLine(label, arr, esc) {
  const items = Array.isArray(arr) ? arr : [];
  if (!items.length) return `<br><small>${esc(label)}: (none)</small>`;

  const top = items
    .slice(0, 5)
    .map((item) => esc(String(item)))
    .join(", ");

  return `<br><small>${esc(label)}: ${top}</small>`;
}

/**
 * Pick the first non-nullish value.
 *
 * @param  {...any} vals
 * @returns {any}
 */
function pickFirst(...vals) {
  for (const value of vals) {
    if (value !== null && value !== undefined) return value;
  }
  return undefined;
}

/**
 * Default function-node predicate.
 *
 * @param {any} opts
 * @returns {(node:any) => boolean}
 */
function readIsFunctionNode(opts) {
  return typeof opts?.isFunctionNode === "function"
    ? opts.isFunctionNode
    : defaultIsFunctionNode;
}

/**
 * Default safe-int helper.
 *
 * @param {any} opts
 * @returns {(value:any) => number}
 */
function readToSafeInt(opts) {
  return typeof opts?.toSafeInt === "function"
    ? opts.toSafeInt
    : defaultToSafeInt;
}

/**
 * Default function-node detection.
 *
 * @param {any} d
 * @returns {boolean}
 */
function defaultIsFunctionNode(d) {
  const type = (d && typeof d.type === "string") ? d.type.trim() : "";
  if (type === "function") return true;

  const kind = (d && typeof d.kind === "string") ? d.kind.trim() : "";
  return kind === "function";
}

/**
 * Default numeric guard for count-like fields.
 *
 * @param {any} value
 * @returns {number}
 */
function defaultToSafeInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

/**
 * Default HTML escaper.
 *
 * @param {any} value
 * @returns {string}
 */
function defaultEscapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
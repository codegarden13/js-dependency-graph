export function normalizeId(value) {
  return String(value || "").trim();
}

/**
 * Normalize a loose value to a trimmed string.
 *
 * @param {unknown} v
 *   Candidate value.
 * @returns {string}
 *   Trimmed string representation, or an empty string.
 */
export function toTrimmedString(v) {
  return String(v || "").trim();
}



export function isNonEmptyString(x) {
  return typeof x === "string" && x.trim().length > 0;
}

/**
 * Return unique, trimmed, non-empty strings (preserves first-seen order).
 */
export function uniqStrings(list) {
  const out = [];
  const seen = new Set();

  for (const v of list || []) {
    const s = String(v ?? "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}
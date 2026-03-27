



// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

/**
 * Escape one value for RFC-4180-style CSV output.
 *
 * @param {unknown} value
 *   Cell value to serialize.
 * @returns {string}
 *   Escaped CSV cell content.
 */
export function csvEscape(value) {
  const s = String(value ?? "");
  if (!/[",\n]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

// ---------------------------------------------------------------------------
// CSV row projection
// ---------------------------------------------------------------------------

export const NODE_ROW_FIELDS = [
  ["kind", "kind"],
  ["id", "id"],
  ["file", "file"],
  ["label", "label"],
  ["type", "type"],
  ["group", "group"],
  ["layer", "layer"],
  ["lines", "lines"],
  ["complexity", "complexity"],
  ["exported", "exported"],
  ["imported", "imported"],
  ["unused", "unused"],
  ["hotspot", "hotspot"],
  ["hotspotRank", "_hotspotRank"],
  ["hotspotScore", "_hotspotScore"],
  ["changeFreq", "_changeFreq"],
  ["lastTouchedAt", "_lastTouchedAt"],
  ["x", "x"],
  ["y", "y"]
];

//#TODO:Für was brauche ich das ?

/**
 * Project an object into a flat row object using a field mapping table.
 *
 * @param {Record<string, unknown>} source
 *   Source object to project.
 * @param {Array<[string, string]>} fields
 *   `[targetKey, sourceKey]` tuples describing the projection.
 * @returns {Record<string, unknown>}
 *   Projected row object.
 */
export function projectRow(source, fields) {
  return Object.fromEntries(
    fields.map(([targetKey, sourceKey]) => [targetKey, source?.[sourceKey]])
  );
}

/**
 * Convert one graph node into its CSV row representation.
 *
 * @param {Record<string, unknown>} node
 *   Graph node payload.
 * @returns {Record<string, unknown>}
 *   Flat row object aligned to `NODE_ROW_FIELDS`.
 */
export function nodeRow(node) {
  return projectRow(node, NODE_ROW_FIELDS);
}

/**
 * Convert one graph link into its CSV row representation.
 *
 * @param {Record<string, unknown>} link
 *   Graph link payload.
 * @returns {Record<string, unknown>}
 *   Flat row object for CSV export.
 */
export function linkRow(link) {
  return {
    relation: "link",
    source: link?.source,
    target: link?.target,
    kind: link?.kind,
    type: link?.type,
    value: link?.value
  };
}

/**
 * Serialize the metrics graph to CSV.
 *
 * Why this exists
 * ---------------
 * The JSON artifact is canonical, but CSV makes ad-hoc inspection and import
 * into spreadsheet tools straightforward for debugging and reporting.
 *
 * @param {Record<string, unknown>} metrics
 *   Metrics payload containing `nodes` and `links` arrays.
 * @returns {string}
 *   Complete CSV document including header row.
 */
export function buildMetricsCsv(metrics) {
  const rows = [];

  for (const node of Array.isArray(metrics?.nodes) ? metrics.nodes : []) {
    rows.push({ relation: "node", ...nodeRow(node) });
  }

  for (const link of Array.isArray(metrics?.links) ? metrics.links : []) {
    rows.push(linkRow(link));
  }

  const headers = [
    "relation",
    "kind",
    "id",
    "file",
    "label",
    "type",
    "group",
    "layer",
    "lines",
    "complexity",
    "exported",
    "imported",
    "unused",
    "hotspot",
    "hotspotRank",
    "hotspotScore",
    "changeFreq",
    "lastTouchedAt",
    "x",
    "y",
    "source",
    "target",
    "value"
  ];

  const body = rows.map((row) => headers.map((key) => csvEscape(row?.[key])).join(","));
  return [headers.join(","), ...body].join("\n");
}




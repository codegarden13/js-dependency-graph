/**
 * GraphStore
 * ==========
 *
 * Small in-memory graph accumulator used by the analyzer.
 *
 * Responsibilities
 * ----------------
 * - Maintain a de-duplicated `nodes[]` list
 * - Maintain a de-duplicated `links[]` list
 * - Merge “stub nodes” into “real nodes” when richer data arrives later
 *
 * Design Notes
 * ------------
 * - Framework agnostic
 * - No filesystem access
 * - No traversal strategy (BFS/DFS) knowledge
 */

const NUMERIC_NODE_METRIC_KEYS = ["lines", "codeLines", "commentLines", "blankLines", "complexity"];

export class GraphStore {
  constructor() {
    /** @type {any[]} */
    this.nodes = [];

    /** @type {any[]} */
    this.links = [];

    /** @type {Map<string, any>} */
    this._nodeIndex = new Map();

    /** @type {Set<string>} */
    this._linkIndex = new Set();
  }

  toNonEmptyId(value) {
    const id = String(value || "").trim();
    return id ? id : "";
  }

  getExistingNode(id) {
    return this._nodeIndex.has(id) ? (this._nodeIndex.get(id) || null) : null;
  }

  mergeStubMetrics(existing, incoming) {
    for (const key of NUMERIC_NODE_METRIC_KEYS) {
      this.mergeMetric(existing, incoming, key);
    }

    if (!existing.headerComment && incoming.headerComment) {
      existing.headerComment = String(incoming.headerComment || "");
    }
  }

  metricNumber(obj, key) {
    if (!obj) return 0;
    const raw = obj[key];
    const n = Number(raw || 0);
    return Number.isFinite(n) ? n : 0;
  }

  shouldMergeMetricValue(currentValue, nextValue) {
    if (currentValue !== 0) return false;
    return nextValue > 0;
  }

  mergeMetric(existing, incoming, key) {
    if (!existing || !incoming) return;

    const currentValue = this.metricNumber(existing, key);
    const nextValue = this.metricNumber(incoming, key);

    if (!this.shouldMergeMetricValue(currentValue, nextValue)) return;

    existing[key] = nextValue;
  }

  mergeIdentity(existing, incoming) {
    if (!existing.file && incoming.file) existing.file = String(incoming.file);
    if (!existing.kind && incoming.kind) existing.kind = String(incoming.kind);
  }

  mergeFunctionMeta(existing, incoming) {
    if (existing.name == null && incoming.name != null) existing.name = String(incoming.name);
    if (existing.exported == null && incoming.exported != null) existing.exported = Boolean(incoming.exported);
  }

  mergeExistingNode(existing, incoming) {
    if (!existing || !incoming) return;
    this.mergeStubMetrics(existing, incoming);
    this.mergeIdentity(existing, incoming);
    this.mergeFunctionMeta(existing, incoming);
  }

  normalizeFile(node, fallbackId) {
    const f = node && node.file;
    return String(f || fallbackId);
  }

  normalizeNumber(value) {
    return Number(value || 0);
  }

  normalizeString(value) {
    return String(value || "");
  }

  buildMetricFields(node) {
    return Object.fromEntries(
      NUMERIC_NODE_METRIC_KEYS.map((key) => [key, this.normalizeNumber(node?.[key])])
    );
  }

  buildBaseNode(id, node) {
    const file = this.normalizeFile(node, id);
    const headerComment = this.normalizeString(node?.headerComment);

    return {
      id,
      file,
      ...this.buildMetricFields(node),
      headerComment
    };
  }

  applyOptionalNodeFields(out, node) {
    if (!out || !node) return;

    // kind: only keep meaningful values
    const kind = node.kind;
    if (kind) out.kind = String(kind);

    // name: preserve even empty-string names if explicitly present
    if (node.name != null) out.name = String(node.name);

    // exported: preserve explicit boolean-ish value if present
    if (node.exported != null) out.exported = Boolean(node.exported);
  }

  buildNormalizedNode(id, node) {
    const out = this.buildBaseNode(id, node);
    this.applyOptionalNodeFields(out, node);
    return out;
  }

  /**
   * Ensure a node exists; returns true if added.
   *
   * Merge rules:
   * - Prefer richer metrics (lines/complexity/headerComment)
   * - Prefer meaningful kind/file when missing
   * - Preserve function metadata (name/exported) when present
   */
  ensureNode(node) {
    const id = this.toNonEmptyId(node?.id);
    if (!id) return false;

    const existing = this.getExistingNode(id);
    if (existing) {
      this.mergeExistingNode(existing, node);
      return false;
    }

    const normalized = this.buildNormalizedNode(id, node);
    this.nodes.push(normalized);
    this._nodeIndex.set(id, normalized);
    return true;
  }


  
  /**
   * Ensure a link exists; returns true if added.
   */

  
  ensureLink(sourceId, targetId, type) {
    const s = String(sourceId || "").trim();
    const t = String(targetId || "").trim();
    const ty = String(type || "use").trim();
    if (!s || !t) return false;

    const key = `${s}|${ty}|${t}`;
    if (this._linkIndex.has(key)) return false;

    this.links.push({ source: s, target: t, type: ty });
    this._linkIndex.add(key);
    return true;
  }
  

  get nodeCount() {
    return this.nodes.length;
  }

  get linkCount() {
    return this.links.length;
  }

  toNonEmptyPrefix(prefix) {
    const p = String(prefix || "").trim();
    return p ? p : "";
  }

  findPrefixInNodeIndex(nodeIndex, prefix) {
    if (!nodeIndex) return null;
    if (typeof nodeIndex.keys !== "function") return null;

    for (const id of nodeIndex.keys()) {
      if (typeof id !== "string") continue;
      if (id.startsWith(prefix)) return id;
    }

    return null;
  }

  findPrefixInNodesArray(nodes, prefix) {
    if (!Array.isArray(nodes) || !nodes.length) return null;

    const match = nodes.find((n) => typeof n?.id === "string" && n.id.startsWith(prefix));
    return match?.id || null;
  }

  /**
   * findNodeIdByPrefix(prefix)
   * --------------------------
   * Best-effort lookup used by deferred call-edge resolution.
   *
   * Why:
   * - Function nodes are emitted as "<fileId>::<name@line>".
   * - Call edges often only know the export name ("boot"), not the exact line.
   * - We therefore resolve by prefix match "<fileId>::boot@".
   *
   * Contract:
   * - Returns the FIRST matching node id (deterministic: insertion order)
   * - Returns null if no match exists
   *
   * @param {string} prefix
   * @returns {string|null}
   */
  findNodeIdByPrefix(prefix) {
    const p = this.toNonEmptyPrefix(prefix);
    if (!p) return null;

    const idFromIndex = this.findPrefixInNodeIndex(this._nodeIndex, p);
    if (idFromIndex) return idFromIndex;

    return this.findPrefixInNodesArray(this.nodes, p);
  }

  /**
   * findNodeByPrefix(prefix)
   * ------------------------
   * Backward-compatible alias returning the node object.
   *
   * @param {string} prefix
   * @returns {any|null}
   */
  findNodeByPrefix(prefix) {
    const id = this.findNodeIdByPrefix(prefix);
    return id ? (this._nodeIndex?.get(id) || this.nodes.find((n) => n?.id === id) || null) : null;
  }
}

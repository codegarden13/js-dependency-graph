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

  /**
   * Ensure a node exists; returns true if added.
   *
   * Merge rules:
   * - Prefer richer metrics (lines/complexity/headerComment)
   * - Prefer meaningful kind/file when missing
   * - Preserve function metadata (name/exported) when present
   */
  ensureNode(node) {
    const id = String(node?.id || "").trim();
    if (!id) return false;

    if (this._nodeIndex.has(id)) {
      const existing = this._nodeIndex.get(id);
      if (!existing || !node) return false;

      if ((existing.lines || 0) === 0 && (node.lines || 0) > 0) existing.lines = Number(node.lines || 0);
      if ((existing.complexity || 0) === 0 && (node.complexity || 0) > 0) existing.complexity = Number(node.complexity || 0);
      if (!existing.headerComment && node.headerComment) existing.headerComment = String(node.headerComment || "");

      if (!existing.file && node.file) existing.file = String(node.file);
      if (!existing.kind && node.kind) existing.kind = String(node.kind);

      if (existing.name == null && node.name != null) existing.name = String(node.name);
      if (existing.exported == null && node.exported != null) existing.exported = Boolean(node.exported);

      return false;
    }

    const normalized = {
      id,
      file: String(node?.file || id),
      lines: Number(node?.lines || 0),
      complexity: Number(node?.complexity || 0),
      headerComment: String(node?.headerComment || ""),
      ...(node?.kind ? { kind: String(node.kind) } : null),
      ...(node?.name != null ? { name: String(node.name) } : null),
      ...(node?.exported != null ? { exported: Boolean(node.exported) } : null)
    };

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
    const p = String(prefix || "").trim();
    if (!p) return null;

    // Prefer the index for speed + determinism.
    // Falls back to the nodes array if the index ever changes shape.
    if (this._nodeIndex && typeof this._nodeIndex.keys === "function") {
      for (const id of this._nodeIndex.keys()) {
        if (typeof id === "string" && id.startsWith(p)) return id;
      }
      return null;
    }

    const match = this.nodes.find((n) => typeof n?.id === "string" && n.id.startsWith(p));
    return match?.id || null;
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
// public/assets/js/codeGraph/data.js
/**
 * Graph Data Utilities (UI-side)
 * =============================
 * Normalizes and enriches the backend metrics payload for the D3 renderer.
 *
 * Why this exists
 * --------------
 * The backend payload is allowed to evolve (file nodes, dir/asset nodes,
 * function nodes, call edges, include edges, etc.). The renderer should stay
 * focused on SVG/simulation. All “make it consistent” logic lives here.
 *
 * Design Goals
 * ------------
 * - Tolerate incomplete / partially-upgraded payloads
 * - Preserve backend-provided semantics (kind/type) when present
 * - Add UI-friendly defaults (type inference, degrees, normalized scores)
 * - Never drop nodes/links just because they are new (e.g. kind:function)
 * - Optionally synthesize function nodes from file-node metadata if available
 *
 * Exposes:
 *   window.CodeGraphData.normalize(metrics) -> { nodes, links }
 */

// ESM: no global namespace. Keep everything as explicit exports.

const CodeGraphData = {};

  /* ====================================================================== */
  /* UI-side enrichment helpers (kept OUT of the D3 renderer)                */
  /* ====================================================================== */

  /**
   * Parse function-node ids of the form:
   *   "path/to/file.js::symbol@53"
   * and attach UI-friendly fields:
   *   - __fileFromId   (string)
   *   - __symbol       (string)
   *   - __startLine    (number)
   *   - __displayLabel (string)
   *
   * Why here?
   * ---------
   * This is *data shaping*, not rendering. Keeping it in data.js makes the
   * D3 renderer smaller and prevents duplicated parsing logic.
   *
   * Safe-by-default:
   * - If the id doesn't match the format, we leave the node unchanged.
   * - We never overwrite existing __* fields if they already exist.
   *
   * @param {Array<object>} nodes
   */
  CodeGraphData.enrichFunctionIdsForUi = function enrichFunctionIdsForUi(nodes) {
    if (!Array.isArray(nodes)) return;

    for (const n of nodes) {
      const id = String(n?.id || "");
      if (!id) continue;

      // Only applies to ids that contain our function delimiter.
      const idx = id.indexOf("::");
      if (idx === -1) continue;

      const filePart = id.slice(0, idx);
      const rest = id.slice(idx + 2);
      if (!filePart || !rest) continue;

      // We use the last "@" so symbols may contain "@" safely (rare but possible).
      const at = rest.lastIndexOf("@");
      if (at === -1) continue;

      const sym = rest.slice(0, at);
      const lineStr = rest.slice(at + 1);
      const line = Number.parseInt(lineStr, 10);

      if (n.__fileFromId == null && filePart) n.__fileFromId = filePart;
      if (n.__symbol == null && sym) n.__symbol = sym;
      if (n.__startLine == null && Number.isFinite(line)) n.__startLine = line;

      // Prefer a short label in the graph: symbol name only.
      if (n.__displayLabel == null) n.__displayLabel = sym || rest;
    }
  };

  /**
   * Validate the canonical backend contract for node.group.
   *
   * The renderer uses `group` for stable colors (root/dir/code/doc/data/image).
   * We don't hard-error here; we return a compact diagnostics object so the
   * UI layer can decide how to notify (toast/alert/panel).
   *
   * @param {Array<object>} nodes
   * @param {Record<string, string>} groupColorMap
   * @returns {{ missing: Array<object>, unknown: Array<object> }}
   */
  CodeGraphData.validateNodeGroups = function validateNodeGroups(nodes, groupColorMap) {
    const out = { missing: [], unknown: [] };
    if (!Array.isArray(nodes)) return out;

    const known = groupColorMap && typeof groupColorMap === "object" ? groupColorMap : Object.create(null);

    for (const n of nodes) {
      const g = (n && typeof n.group === "string") ? n.group.trim() : "";
      if (!g) {
        out.missing.push(n);
      } else if (!Object.prototype.hasOwnProperty.call(known, g)) {
        out.unknown.push(n);
      }

      // Keep this cheap; callers can slice examples.
      if (out.missing.length + out.unknown.length >= 50) break;
    }

    return out;
  };

  /**
   * Best-effort: prefer an id label that is readable.
   * Used by tooltips and filter summaries.
   * @param {string} id
   * @returns {string}
   */
  CodeGraphData.shortIdLabel = function shortIdLabel(id) {
    const s = String(id || "");
    if (!s) return "";
    return s.split("/").pop() || s;
  };

  /* ====================================================================== */
  /* Extraction + shallow normalization                                      */
  /* ====================================================================== */

  /**
   * Extract nodes and links arrays from the metrics payload.
   * @param {object} metrics - The backend metrics payload.
   * @returns {{nodes: Array, links: Array}} Extracted nodes and links.
   */
  CodeGraphData.extract = function extract(metrics) {
    const nodes = (metrics?.nodes || []).map((n) => ({ ...n }));
    const links = (metrics?.links || metrics?.edges || []).map((l) => ({ ...l }));
    return { nodes, links };
  };

  /**
   * Ensure every node has a stable string id.
   * - Prefer node.id
   * - Fallback to node.file / node.path
   * - For function nodes missing id: derive from file + name: "file::name"
   */
  CodeGraphData.ensureNodeIds = function ensureNodeIds(nodes) {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];

      const file = String(n?.file || n?.path || "").trim();
      const name = String(n?.name || n?.func || n?.fn || "").trim();
      const kind = String(n?.kind || "").trim();

      let id = String(n?.id || "").trim();

      if (!id) {
        if (kind === "function" && file && name) id = `${file}::${name}`;
        else id = file;
      }

      n.id = id || `node_${i}`;

      // keep file aligned for non-function nodes
      if (!n.file && kind !== "function") n.file = n.id;
    }
  };

  /**
   * Normalize link endpoints to string ids.
   * (D3 may replace `source/target` with objects; we support both.)
   * @param {Array} links - The array of link objects.
   * @returns {void}
   */
  CodeGraphData.normalizeLinkEndpoints = function normalizeLinkEndpoints(links) {
    for (const l of links) {
      const sid = typeof l.source === "object" ? l.source?.id : l.source;
      const tid = typeof l.target === "object" ? l.target?.id : l.target;

      l.source = String(sid ?? "");
      l.target = String(tid ?? "");

      // Important: don't lose new edge types.
      if (!l.type) l.type = "use";
    }
  };

  /* ====================================================================== */
  /* Optional: synthesize function nodes (forward compatible)                */
  /* ====================================================================== */

  /**
   * If backend attaches function metadata to file nodes, we can create real
   * function nodes + edges so the UI already shows them.
   *
   * Supported shapes (best-effort):
   * - fileNode.functions: [{ name, exported?, lines?, complexity?, headerComment? }]
   * - fileNode.exports:   [{ name, lines?, complexity? }]
   * - fileNode.exportedFunctions: [...]
   *
   * Adds:
   * - function node: id = "fileId::fnName", kind="function", type="function"
   * - edge: file -> function  type="declares"
   * - edge: file -> function  type="export"  (if exported===true)
   */
  CodeGraphData.synthesizeFunctionNodes = function synthesizeFunctionNodes(nodes, links) {
    /**
     * Fast lookup for already-present nodes.
     * Backend may already emit function nodes with richer metadata.
     */
    const nodeById = new Map(nodes.map((n) => [String(n.id), n]));

    /** Dedupe added links (source|type|target). */
    const linkKey = (s, t, ty) => `${s}|${ty}|${t}`;
    const linkSeen = new Set(links.map((l) => linkKey(String(l.source||""), String(l.target||""), String(l.type||"use"))));

    function pushLink(source, target, type) {
      const k = linkKey(source, target, type);
      if (linkSeen.has(k)) return;
      linkSeen.add(k);
      links.push({ source, target, type });
    }

    function addFn(fileNode, fn) {
      const fileId = String(fileNode?.id || fileNode?.file || "").trim();
      if (!fileId) return;

      const name =
        String(fn?.id || fn?.name || fn?.key || fn?.exportedName || "").trim();
      if (!name) return;

      const fnId = `${fileId}::${name}`;
      const exported = fn?.exported === true;

      // Size driver: prefer loc/span information when present.
      const locLines = Number(fn?.locLines ?? fn?.loc ?? fn?.lines ?? 0) || 0;
      const safeLines = locLines > 0 ? locLines : 1;
      const startLine = Number(fn?.startLine ?? 0) || 0;

      // Backend may already have emitted this function node.
      // If present, only backfill missing fields; do not overwrite.
      if (nodeById.has(fnId)) {
        const existing = nodeById.get(fnId);
        if (existing && (existing.lines == null || Number(existing.lines) <= 0)) {
          existing.lines = safeLines;
        }
        if (existing && (existing.startLine == null || Number(existing.startLine) <= 0) && startLine) {
          existing.startLine = startLine;
        }
      } else {
        const fnNode = {
          id: fnId,
          file: String(fileNode.file || fileId),
          name,
          kind: "function",
          type: "function",
          lines: safeLines,
          complexity: Number(fn?.complexity ?? fn?.cc ?? 0) || 0,
          exported,
          startLine,
          headerComment: String(fn?.headerComment || fn?.comment || "")
        };
        nodes.push(fnNode);
        nodeById.set(fnId, fnNode);
      }

      pushLink(fileId, fnId, "declares");
      if (exported) pushLink(fileId, fnId, "export");
    }

    // iterate over a snapshot (since we push to nodes)
    const snapshot = nodes.slice();
    for (const n of snapshot) {
      const kind = String(n?.kind || "");
      if (kind === "function") continue;

      const buckets = [];
      if (Array.isArray(n.functions)) buckets.push(n.functions);
      if (Array.isArray(n.exports)) buckets.push(n.exports);
      if (Array.isArray(n.exportedFunctions)) buckets.push(n.exportedFunctions);

      for (const b of buckets) for (const fn of b) addFn(n, fn);
    }
  };

  /* ====================================================================== */
  /* Node kind/type inference                                                */
  /* ====================================================================== */

  /**
   * Infer the kind of a node from its properties.
   * @param {object} node - The node object.
   * @returns {string} The inferred kind (e.g., "function", "file", "dir", "asset").
   */
  CodeGraphData.inferNodeKind = function inferNodeKind(node) {
    if (node?.kind) return String(node.kind);

    const id = String(node?.id || "");
    if (id.includes("::")) return "function";

    const p = String(node?.file || node?.id || "");
    if (p === "." || id === ".") return "root";
    if (p.endsWith("/")) return "dir";

    // simple extension-based asset inference
    const m = p.split("?")[0].match(/\.[a-zA-Z0-9]+$/);
    const ext = (m ? m[0] : "").toLowerCase();
    if (ext && ![".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"].includes(ext)) return "asset";

    return "file";
  };

  /**
   * Infer the type of a node from its properties.
   * @param {object} node - The node object.
   * @returns {string} The inferred type (e.g., "function", "controller", "service").
   */
  CodeGraphData.inferNodeType = function inferNodeType(node) {
    if (node?.type) return String(node.type);

    const kind = String(node?.kind || "file");
    if (kind === "function") return "function";
    if (kind === "dir") return "dir";
    if (kind === "asset") return "asset";
    if (kind === "root") return "root";

    const p = String(node?.file || node?.id || "").toLowerCase();

    if (p.includes("/controllers/")) return "controller";
    if (p.includes("/services/")) return "service";
    if (p.includes("/repositories/")) return "repository";
    if (p.includes("/config/")) return "config";
    if (p.includes("/modules/")) return "module";
    if (p.includes("/core/")) return "core";
    if (p.includes("/support/") || p.includes("/helpers/") || p.includes("/utils/")) return "helper";

    return "file";
  };

  /* ====================================================================== */
  /* Degrees + scoring                                                       */
  /* ====================================================================== */

  /**
   * Best-effort cyclomatic complexity getter.
   *
   * Notes:
   * - True "logical paths" (cyclomatic complexity) should ideally be computed on the backend AST.
   * - UI can only use fields present on nodes; we do not parse source code here.
   */
  CodeGraphData.getCyclomaticComplexity = function getCyclomaticComplexity(n) {
    if (!n || typeof n !== "object") return 0;

    // Prefer explicit cyclomatic fields if backend provides them.
    const v =
      n.cyclomatic ??
      n.cyclomaticComplexity ??
      n.cc ??
      n.complexity;

    const num = Number(v);
    if (Number.isFinite(num)) return num;

    // Fallback heuristic: degree-based proxy (keeps old behavior).
    const inbound = Number(n._inbound || 0);
    const outbound = Number(n._outbound || 0);
    return inbound + outbound;
  };

  /** Extract a best-effort "line count" metric from a node. */
  function getNodeLines(n) {
    return n?.lines ?? n?.loc ?? n?.size ?? n?.lineCount ?? n?.length ?? 0;
  }

  /**
   * Normalize to 0..1 with safety guards.
   * Returns 0 if v is not finite or range is too small.
   */
  function safeNormalize(v, min, max, eps) {
    if (!Number.isFinite(v)) return 0;
    const range = max - min;
    if (!Number.isFinite(range) || range < eps) return 0;
    return (v - min) / range;
  }

  /** Compute min/max in one pass (faster and avoids Math.min(...bigArray)). */
  function minMax(arr) {
    let min = Infinity;
    let max = -Infinity;
    for (const v of arr) {
      const x = Number(v);
      if (!Number.isFinite(x)) continue;
      if (x < min) min = x;
      if (x > max) max = x;
    }
    if (min === Infinity) min = 0;
    if (max === -Infinity) max = 0;
    return { min, max };
  }

  /**
   * Compute and assign inbound and outbound degree counts for each node.
   * @param {Array} nodes - The array of node objects.
   * @param {Array} links - The array of link objects.
   * @returns {void}
   */
  CodeGraphData.hydrateDegrees = function hydrateDegrees(nodes, links) {
    const degreeMap = new Map();
    nodes.forEach((n) => degreeMap.set(n.id, { in: 0, out: 0 }));

    for (const l of links) {
      const sid = String(l.source || "");
      const tid = String(l.target || "");
      if (degreeMap.has(sid)) degreeMap.get(sid).out++;
      if (degreeMap.has(tid)) degreeMap.get(tid).in++;
    }

    nodes.forEach((n) => {
      const d = degreeMap.get(n.id) || { in: 0, out: 0 };
      if (n._inbound == null) n._inbound = d.in;
      if (n._outbound == null) n._outbound = d.out;
    });
  };

  /**
   * Build normalized line and complexity scores for nodes.
   * @param {Array} nodes - The array of node objects.
   * @returns {void}
   */
  CodeGraphData.buildLineAndComplexityScores = function buildLineAndComplexityScores(nodes) {
    if (!Array.isArray(nodes) || nodes.length === 0) return;

    const eps = 1e-6;

    const linesArr = nodes.map((n) => Number(getNodeLines(n) || 0));
    const cxArr = nodes.map((n) => Number(CodeGraphData.getCyclomaticComplexity(n) || 0));

    // Log-scale lines so very large files don't dominate.
    const logLinesArr = linesArr.map((v) => Math.log10(Math.max(1, v)));

    const { min: minLog, max: maxLog } = minMax(logLinesArr);
    const { min: minCx, max: maxCx } = minMax(cxArr);

    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];

      const lineScore = safeNormalize(logLinesArr[i], minLog, maxLog, eps);
      const cxScore = safeNormalize(cxArr[i], minCx, maxCx, eps);

      n._lineScore = lineScore;
      n._complexityScore = cxScore;

      // legacy alias (some renderers use it)
      n._sizeScore = lineScore;

      n.__displayLines = linesArr[i];
      n.__displayComplexity = cxArr[i];
    }
  };

  /**
   * Assign cluster IDs based on node types.
   * @param {Array} nodes - The array of node objects.
   * @returns {void}
   */
  CodeGraphData.assignTypeClusters = function assignTypeClusters(nodes) {
    nodes.forEach((n) => {
      n.clusterId = n.type || "file";
    });
  };

  /* ====================================================================== */
  /* Public API: normalize                                                   */
  /* ====================================================================== */

  /**
   * Normalize the entire metrics payload for UI consumption.
   * @param {object} metrics - The backend metrics payload.
   * @returns {{nodes: Array, links: Array}} The normalized nodes and links.
   */
  CodeGraphData.normalize = function normalize(metrics) {
    const { nodes, links } = CodeGraphData.extract(metrics);

    // 1) base normalization
    CodeGraphData.ensureNodeIds(nodes);
    CodeGraphData.normalizeLinkEndpoints(links);

    // 2) infer kind/type if missing
    nodes.forEach((n) => {
      n.kind = CodeGraphData.inferNodeKind(n);
      n.type = CodeGraphData.inferNodeType(n);
    });

    // 3) synthesize function nodes if backend attaches them to file nodes
    CodeGraphData.synthesizeFunctionNodes(nodes, links);

    // 4) links may have been added
    CodeGraphData.normalizeLinkEndpoints(links);

    // 5) degrees + scores
    CodeGraphData.hydrateDegrees(nodes, links);
    CodeGraphData.buildLineAndComplexityScores(nodes);
    CodeGraphData.assignTypeClusters(nodes);

    // 6) UI enrichment (keeps renderer small)
    CodeGraphData.enrichFunctionIdsForUi(nodes);

    return { nodes, links };
  };

export { CodeGraphData };
export default CodeGraphData;
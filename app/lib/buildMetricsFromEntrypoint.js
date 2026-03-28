/**
 * buildMetricsFromEntrypoint
 * ==========================
 *
 * Deterministic, entrypoint-driven dependency graph builder for Node-style projects.
 *
 * -----------------------------------------------------------------------------
 * ARCHITECTURAL ROLE
 * -----------------------------------------------------------------------------
 * Constructs a static dependency graph starting from a single entrypoint file.
 *
 * Performs a breadth-first traversal (BFS) across resolvable internal imports
 * and emits a D3-compatible metrics payload.
 *
 * -----------------------------------------------------------------------------
 * DESIGN PRINCIPLES
 * -----------------------------------------------------------------------------
 * • Deterministic traversal (BFS)
 * • No runtime execution or evaluation
 * • Only local/relative imports are resolved
 * • Resilient parsing via parseFile()
 * • Side-effect free (pure metrics builder)
 *
 * -----------------------------------------------------------------------------
 * OUTPUT CONTRACT (Canonical JSON)
 * -----------------------------------------------------------------------------
 * The frontend renders directly from this JSON. No UI-only inference is required.
 *
 * {
 *   meta: {
 *     entry: string,
 *     urlInfo: any,
 *     layerOrder?: string[],
 *     layerY?: Record<string, number>
 *   },
 *   nodes: Array<{
 *     id: string,
 *     file: string,
 *     kind: "root"|"dir"|"file"|"asset"|"function",
 *     group: "root"|"dir"|"code"|"doc"|"data"|"image",
 *     layer?: string,    // backend-assigned architecture layer (for hulls/forceY)
 *     ext: string,        // original extension incl dot (e.g. ".md")
 *     type: string,       // subtype (usually ext w/o dot: "md", "js", "png")
 *     subtype?: string,   // alias for type (kept for clarity)
 *     lines: number,
 *     complexity: number,
 *     headerComment: string,
 *     name?: string,
 *     exported?: boolean,
 *     startLine?: number,
 *
 *     // Derived stats (computed once on backend)
 *     _inbound?: number,
 *     _outbound?: number,
 *     _inCalls?: number,
 *     _outCalls?: number,
 *     _inUses?: number,
 *     _outUses?: number,
 *     _inIncludes?: number,
 *     _outIncludes?: number,
 *     _callers?: string[],
 *     _callees?: string[],
 *     _importance?: number, // backend importance score (degree-weighted)
 *     _radiusHint?: number,  // suggested node radius (UI may clamp)
 *     _unused?: boolean     // backend flag: true if function is likely unused (no inbound calls and not exported)
 *   }>,
 *   links: Array<{
 *     source: string,
 *     target: string,
 *     type: "use" | "include" | "call"
 *   }>
 * }
 */

import fs from "node:fs";
import path from "node:path";

import { scanProjectTree } from "./scanProjectTree.js";
import { parseFile } from "./parseFile.js";
import { resolveImports } from "./resolveImports.js";
import { GraphStore } from "./graphStore.js";
import { applyAutoRefs } from "./autoMode.js";
import { ensureCanonicalNodeFields, DEFAULT_LAYER_ORDER, defaultLayerY } from "./nodeClassification.js";
import { finalizeGraphStats } from "./graph/graphFinalize.js";
import { isInsideRoot } from "./fsPaths.js";
import { toTrimmedString} from "../lib/stringUtils.js"


/* ========================================================================== */
/* MODULE CONSTANTS                                                           */
/* ========================================================================== */

// File extensions we consider cheap/valuable to parse for dependency extraction.
// This list is intentionally conservative (avoid binaries / huge vendor files).

const PARSEABLE_EXTS = new Set([
  ".js", ".mjs", ".cjs",
  ".ts", ".tsx", ".jsx",
  ".json", ".md",
  ".html", ".css"
]);

// Code extensions (used to classify scanned files as "file" vs "asset").
const CODE_EXTS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"]);

/**
 * Normalize a file extension to lowercase string form.
 *
 * @param {unknown} ext
 *   Candidate extension value.
 * @returns {string}
 *   Lowercased extension string, or an empty string.
 */
function normalizeExt(ext) {
  return String(ext || "").toLowerCase();
}

/**
 * Classify a scanned file as code-bearing `file` or non-code `asset`.
 *
 * @param {string} ext
 *   Normalized file extension including leading dot.
 * @returns {"file" | "asset"}
 *   Graph node kind derived from the extension class.
 */
function kindFromExt(ext) {
  return CODE_EXTS.has(ext) ? "file" : "asset";
}

/**
 * Add a minimal scanned file node emitted by the structure scan.
 *
 * Why this exists
 * ---------------
 * The structure scan runs before parsing and therefore only knows filesystem
 * facts. This helper materializes a stable placeholder node that later parse
 * passes may enrich.
 *
 * @param {{addNode: Function, file: {id: string}, kind: string, ext: string}} args
 *   Structure-scan file node arguments.
 */
function addScannedFileNode({ addNode, file, kind, ext }) {
  addNode({
    id: file.id,
    file: file.id,
    lines: 0,
    codeLines: 0,
    commentLines: 0,
    blankLines: 0,
    complexity: 0,
    headerComment: "",
    kind,
    ext
  });
}

/**
 * Add an `include` edge from a parent scan node to its child when a parent exists.
 *
 * @param {Function} addLink
 *   Link insertion callback.
 * @param {{id: string} | null | undefined} parent
 *   Parent scan node, when present.
 * @param {string} childId
 *   Child node identifier.
 */
function linkIncludeIfParent(addLink, parent, childId) {
  if (!parent) return;
  addLink(parent.id, childId, "include");
}

/**
 * Enqueue a scanned file for BFS parsing only when its extension is parseable.
 *
 * @param {Function} enqueue
 *   BFS enqueue callback.
 * @param {string} ext
 *   Normalized file extension.
 * @param {string} absPath
 *   Absolute filesystem path of the scanned file.
 */
function enqueueIfParseable(enqueue, ext, absPath) {
  if (!PARSEABLE_EXTS.has(ext)) return;
  enqueue(absPath);
}


/* ========================================================================== */
/* PUBLIC API                                                                 */
/* ========================================================================== */

/**
 * Build the canonical dependency graph and metrics payload from one entrypoint.
 *
 * Architectural flow
 * ------------------
 * 1. Validate root and entry boundaries
 * 2. Scan project structure for stable include nodes/edges
 * 3. Traverse parseable files with deterministic BFS
 * 4. Add import/call relations and defer unresolved cross-file calls
 * 5. Resolve deferred calls after traversal
 * 6. Finalize graph statistics and canonical node fields
 * 7. Emit optional CSV side artifact
 *
 * @param {object} args
 * @param {string} args.projectRoot
 *   Absolute path to the project root directory.
 * @param {string} args.entryAbs
 *   Absolute path to the entrypoint file.
 * @param {any} args.urlInfo
 *   Optional runtime/app metadata to attach into `meta.urlInfo`.
 * @param {number} [args.maxDirDepth=3]
 *   Maximum directory scan depth for the initial include graph.
 * @returns {Promise<{meta: object, nodes: Array<object>, links: Array<object>}>
 * }
 *   Canonical graph payload consumed directly by the frontend.
 * @throws {Error}
 *   Thrown when arguments are invalid, parsing fails strictly, or the graph has
 *   no meaningful dependency output.
 */
export async function buildMetricsFromEntrypoint({
  projectRoot,
  entryAbs,
  urlInfo,
  maxDirDepth = 3
}) {
  /* ------------------------------------------------------------------------ */
  /* 1) INITIALIZATION                                                        */
  /* ------------------------------------------------------------------------ */

  const { projectRootAbs, entryNorm } = validateEntrypointArgs(projectRoot, entryAbs);

  // BFS state
  const visited = new Set();
  const queue = [];
  const queued = new Set();

  // Graph storage (dedupe + stable output arrays)
  const store = new GraphStore();

  const addNode = (n) => {
    ensureCanonicalNodeFields(n);
    store.ensureNode(n);
  };

  const addLink = (s, t, ty) => {
    store.ensureLink(s, t, ty);
  };

  addStableRootNode(addNode);

  const enqueue = createEnqueue({ visited, queued, queue });

  /* ------------------------------------------------------------------------ */
  /* 1.1) PROJECT STRUCTURE SCAN (include-graph)                               */
  /* ------------------------------------------------------------------------ */

  scanStructure({ projectRootAbs, maxDirDepth, addNode, addLink, enqueue });

  // Always ensure the entrypoint is analyzed, even if outside scan depth
  enqueue(entryNorm);

  const toRelId = (absPath) => toProjectRelativeId(projectRootAbs, absPath);

  // Deferred calls (resolved after BFS when target modules/functions exist)
  /** @type {Array<{ fromId: string, targetFileId: string, targetExport: string|null }>} */
  const pendingCalls = [];

  /** @type {Array<{ kind: string, message: string, fromId?: string, targetFileId?: string, targetExport?: string|null }>} */
  const warnings = [];

  /* ------------------------------------------------------------------------ */
  /* 2) BFS TRAVERSAL                                                         */
  /* ------------------------------------------------------------------------ */

  bfsTraverse({
    queue,
    queued,
    visited,
    projectRootAbs,
    store,
    addNode,
    addLink,
    enqueue,
    toRelId,
    pendingCalls,
    warnings
  });

  /* ------------------------------------------------------------------------ */
  /* 3) RESOLVE DEFERRED CALL TARGETS                                          */
  /* ------------------------------------------------------------------------ */

  resolveDeferredCalls({ pendingCalls, store, addLink, warnings });

  /* ------------------------------------------------------------------------ */
  /* 4) STRICT SANITY CHECK (NO FALLBACKS)                                     */
  /* ------------------------------------------------------------------------ */

  strictSanityCheck(store);

  /* ------------------------------------------------------------------------ */
  /* 5) FINALIZE + RETURN PAYLOAD                                              */
  /* ------------------------------------------------------------------------ */

  finalizeGraphStats(store.nodes, store.links);

  attachFunctionChildren(store.nodes);
  markUnusedFunctions(store.nodes);
  enforceCanonicalFields(store.nodes);

  /* ---------------------------------------------------------------------- */
  /* 5.1) WRITE CODE METRICS CSV                                            */
  /* ---------------------------------------------------------------------- */

  writeCodeMetricsCsv({
    nodes: store.nodes,
    links: store.links,
    appId: String(urlInfo?.appId || "app")
  });

  return {
    meta: {
      entry: toRelId(entryNorm),
      urlInfo,
      layerOrder: DEFAULT_LAYER_ORDER,
      layerY: defaultLayerY(DEFAULT_LAYER_ORDER),
      warnings
    },
    nodes: store.nodes,
    links: store.links
  };
}

/* ========================================================================== */
/* INTERNAL HELPERS                                                           */
/* ========================================================================== */

/**
 * Validate and normalize the entrypoint builder arguments.
 *
 * Validation rules
 * ----------------
 * - `projectRoot` must be a non-empty string and an existing directory
 * - `entryAbs` must be a non-empty string and an existing file
 * - `entryAbs` must remain inside `projectRoot`
 *
 * @param {string} projectRoot
 *   Candidate project root path.
 * @param {string} entryAbs
 *   Candidate absolute entry file path.
 * @returns {{projectRootAbs: string, entryNorm: string}}
 *   Normalized absolute root and entry paths.
 * @throws {Error}
 *   Thrown when validation or boundary checks fail.
 */
function validateEntrypointArgs(projectRoot, entryAbs) {
  assertNonEmptyString(projectRoot, "projectRoot");
  assertNonEmptyString(entryAbs, "entryAbs");

  const projectRootAbs = path.resolve(projectRoot);
  statDirOrThrow(projectRootAbs, "projectRoot");

  const entryNorm = path.resolve(entryAbs);
  statFileOrThrow(entryNorm);

  assertInsideRootOrThrow(projectRootAbs, entryNorm);

  return { projectRootAbs, entryNorm };
}

/**
 * Create the BFS enqueue function with duplicate prevention.
 *
 * Why this exists
 * ---------------
 * Traversal order must be deterministic and each absolute path should appear in
 * the queue at most once before being visited.
 *
 * @param {{visited: Set<string>, queued: Set<string>, queue: string[]}} state
 *   Mutable BFS state containers.
 * @returns {(absPath: string) => void}
 *   Enqueue function that normalizes absolute paths and suppresses duplicates.
 */
function createEnqueue({ visited, queued, queue }) {
  return (absPath) => {
    const p = path.resolve(absPath);
    if (!p) throw new Error("enqueue(): empty path");
    if (visited.has(p)) return;
    if (queued.has(p)) return;
    queued.add(p);
    queue.push(p);
  };
}

/**
 * Insert the stable synthetic root node used to anchor the rendered graph.
 *
 * @param {Function} addNode
 *   Node insertion callback.
 */
function addStableRootNode(addNode) {
  addNode({
    id: ".",
    file: ".",
    lines: 0,
    complexity: 0,
    headerComment: "",
    kind: "root"
  });
}

/**
 * Scan the project directory tree and build the include-graph skeleton.
 *
 * Why this exists
 * ---------------
 * The parser-driven BFS only sees parseable files. The structure scan ensures
 * directories, assets, shallow files, and containment edges are still present
 * in the graph even when they are never parsed.
 *
 * @param {{
 *   projectRootAbs: string,
 *   maxDirDepth: number,
 *   addNode: Function,
 *   addLink: Function,
 *   enqueue: Function
 * }} args
 *   Structure-scan dependencies and callbacks.
 */
function scanStructure({ projectRootAbs, maxDirDepth, addNode, addLink, enqueue }) {
  scanProjectTree({
    projectRootAbs,
    maxDepth: maxDirDepth,
    ignoreDirs: ["node_modules", ".git", "dist", "build", ".next", ".cache", "coverage"],
    onDir: (dir, parent) => {
      addNode({
        id: dir.id,
        file: dir.id,
        lines: 0,
        complexity: 0,
        headerComment: "",
        kind: "dir"
      });

      if (parent) addLink(parent.id, dir.id, "include");
    },
    onFile: (file, parent) => {
      const ext = normalizeExt(file.ext);
      const kind = kindFromExt(ext);

      addScannedFileNode({ addNode, file, kind, ext });
      linkIncludeIfParent(addLink, parent, file.id);
      enqueueIfParseable(enqueue, ext, file.abs);
    }
  });
}

/**
 * Iterate parsed function descriptors safely.
 *
 * @param {Record<string, any>} parsed
 *   Parsed file result.
 * @param {(fn: object) => void} fn
 *   Callback invoked for each parsed function.
 */
function forEachParsedFunction(parsed, fn) {
  const fns = parsed?.functions;
  if (!Array.isArray(fns) || fns.length === 0) return;
  for (const item of fns) fn(item);
}



/**
 * Convert a loose value to a finite non-negative number.
 *
 * @param {unknown} v
 *   Candidate numeric value.
 * @returns {number}
 *   Finite non-negative number, or `0` when invalid.
 */
function toNonNegativeNumber(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Convert a loose numeric value to a positive number with fallback `1`.
 *
 * @param {unknown} v
 *   Candidate numeric value.
 * @returns {number}
 *   Positive finite number, or `1` when the value is missing/non-positive.
 */
function positiveOrOne(v) {
  const n = toNonNegativeNumber(v);
  return n > 0 ? n : 1;
}

/**
 * Derive the normalized file extension from a graph file id.
 *
 * @param {unknown} fileId
 *   Graph file identifier.
 * @returns {string}
 *   Lowercased extension including leading dot, or an empty string.
 */
function extFromFileId(fileId) {
  return normalizeExt(path.extname(String(fileId || "")));
}

/**
 * Convert an extension to its subtype token without a leading dot.
 *
 * @param {unknown} ext
 *   Candidate extension value.
 * @returns {string}
 *   Extension token without leading dot.
 */
function subtypeFromExt(ext) {
  return String(ext || "").replace(/^\./, "");
}

/**
 * Build the canonical function node for one parsed function descriptor.
 *
 * @param {string} fileId
 *   Owning file identifier.
 * @param {Record<string, any>} fn
 *   Parsed function descriptor.
 * @returns {object | null}
 *   Canonical function node, or `null` when the function has no usable id.
 */
function buildFunctionNode(fileId, fn) {
  const functionId = readFunctionNodeId(fn);
  if (!functionId) return null;

  const fileExt = extFromFileId(fileId);

  return createFunctionNode({
    fileId,
    functionId,
    fileExt,
    fn
  });
}

/**
 * Read the canonical function id from a parsed function descriptor.
 *
 * @param {Record<string, any>} fn
 *   Parsed function descriptor.
 * @returns {string}
 *   Trimmed function id, or an empty string.
 */
function readFunctionNodeId(fn) {
  return toTrimmedString(fn?.id);
}

/**
 * Materialize the canonical graph node shape for a parsed function.
 *
 * @param {{fileId: string, functionId: string, fileExt: string, fn: Record<string, any>}} args
 *   Parsed function metadata and owning file context.
 * @returns {object}
 *   Canonical function node ready for graph insertion.
 */
function createFunctionNode({ fileId, functionId, fileExt, fn }) {
  return {
    id: `${fileId}::${functionId}`,
    file: fileId,

    // Use function span (LOC) as size driver in the renderer.
    // Falls back to 1 so functions are not all identical in size.
    lines: positiveOrOne(fn?.locLines),
    complexity: toNonNegativeNumber(fn?.complexity),
    headerComment: "",

    kind: "function",
    name: toTrimmedString(fn?.name),
    exported: Boolean(fn?.exported),
    startLine: toNonNegativeNumber(fn?.startLine),
    ext: fileExt,
    type: "function",
    subtype: subtypeFromExt(fileExt) || "function"
  };
}

/**
 * Add all parsed function nodes for one file.
 *
 * @param {{parsed: Record<string, any>, fileId: string, addNode: Function}} args
 *   Parsed file result and insertion callback.
 */
function addFunctionNodes({ parsed, fileId, addNode }) {
  forEachParsedFunction(parsed, (fn) => {
    const node = buildFunctionNode(fileId, fn);
    if (!node) return;
    addNode(node);
  });
}

/**
 * Add `use` edges for resolvable internal imports and enqueue discovered modules.
 *
 * @param {{
 *   parsed: Record<string, any>,
 *   absNorm: string,
 *   projectRootAbs: string,
 *   fileId: string,
 *   toRelId: Function,
 *   addLink: Function,
 *   enqueue: Function,
 *   visited: Set<string>
 * }} args
 *   Import-edge resolution context.
 */
function addImportEdges({ parsed, absNorm, projectRootAbs, fileId, toRelId, addLink, enqueue, visited }) {
  const specs = parsed?.imports || [];
  for (const spec of specs) {
    const resolvedAbs = resolveImports(absNorm, spec, projectRootAbs);
    if (!resolvedAbs) continue;

    const targetAbs = path.resolve(resolvedAbs);
    if (!isInsideRoot(projectRootAbs, targetAbs)) continue;

    const targetId = toRelId(targetAbs);
    addLink(fileId, targetId, "use");

    if (!visited.has(targetAbs)) enqueue(targetAbs);
  }
}

/**
 * Add `call` edges for local and cross-file function calls.
 *
 * Resolution strategy
 * -------------------
 * 1. Try bare local function names in the same file
 * 2. Try qualified local ids in the same file
 * 3. Try imported bindings for cross-file calls
 * 4. Defer export-target resolution until BFS has materialized all nodes
 *
 * @param {{
 *   parsed: Record<string, any>,
 *   store: GraphStore,
 *   fileId: string,
 *   absNorm: string,
 *   projectRootAbs: string,
 *   toRelId: Function,
 *   addLink: Function,
 *   pendingCalls: Array<object>,
 *   warnings: Array<object>
 * }} args
 *   Call-edge resolution context.
 */
function addCallEdges({ parsed, store, fileId, absNorm, projectRootAbs, toRelId, addLink, pendingCalls, warnings }) {
  if (!Array.isArray(parsed?.calls) || parsed.calls.length === 0) return;

  // Local helper: resolve a function node in a given file by "<name>@" prefix.
  const resolveFnIdByNameInFile = (fileIdForSearch, fnName) => {
    const nm = String(fnName || "").trim();
    if (!nm) return null;
    const prefix = `${fileIdForSearch}::${nm}@`;
    return store.findNodeIdByPrefix(prefix);
  };

  const moduleLevelImportKinds = new Set(["*", "namespace", "default"]);

  const resolveFromId = (fromFnRaw) => {
    const raw = String(fromFnRaw || "").trim();
    if (!raw) return fileId;
    return raw.includes("::") ? raw : `${fileId}::${raw}`;
  };

  const linkBareLocalIfPossible = (fromId, calleeName) => {
    const localByName = resolveFnIdByNameInFile(fileId, calleeName);
    if (!localByName) return false;
    addLink(fromId, localByName, "call");
    return true;
  };

  const linkQualifiedLocalIfPossible = (fromId, calleeQualified) => {
    if (!calleeQualified.startsWith(`${fileId}::`)) return false;

    if (store.findNodeIdByPrefix(calleeQualified) === calleeQualified) {
      addLink(fromId, calleeQualified, "call");
      return true;
    }

    const tail = calleeQualified.slice((fileId + "::").length);
    const nameOnly = tail.split("@")[0];
    const match = resolveFnIdByNameInFile(fileId, nameOnly);
    if (match) {
      addLink(fromId, match, "call");
      return true;
    }

    warnings.push({
      kind: "unresolved-local-call",
      message: `Unresolved local call target '${calleeQualified}' in '${fileId}'.`,
      fromId,
      targetFileId: fileId,
      targetExport: null
    });
    return true;
  };

  const getImportBinding = (calleeName) => parsed.importBindings?.[calleeName] ?? null;

  const resolveTargetFileIdFromSource = (source) => {
    const resolvedAbs = resolveImports(absNorm, source, projectRootAbs);
    if (!resolvedAbs) return "";

    const targetAbs = path.resolve(resolvedAbs);
    if (!isInsideRoot(projectRootAbs, targetAbs)) return "";

    return toRelId(targetAbs);
  };

  const normalizeImported = (importedRaw) => (importedRaw != null ? String(importedRaw) : "");

  const linkCrossFileIfPossible = (fromId, calleeName) => {
    const binding = getImportBinding(calleeName);
    if (!binding?.source) return false;

    const targetFileId = resolveTargetFileIdFromSource(binding.source);
    if (!targetFileId) return false;

    const imported = normalizeImported(binding.imported);

    const isModuleLevelCall = !imported || moduleLevelImportKinds.has(imported);
    if (isModuleLevelCall) {
      addLink(fromId, targetFileId, "call");
      return true;
    }

    pendingCalls.push({ fromId, targetFileId, targetExport: imported });
    return true;
  };

  for (const call of parsed.calls) {
    const calleeRaw = String(call?.callee || "").trim();
    if (!calleeRaw) continue;

    const fromId = resolveFromId(call?.from);

    if (linkBareLocalIfPossible(fromId, calleeRaw)) continue;
    if (linkQualifiedLocalIfPossible(fromId, calleeRaw)) continue;

    linkCrossFileIfPossible(fromId, calleeRaw);
  }
}

/**
 * Resolve deferred cross-file call targets after BFS traversal.
 *
 * @param {{
 *   pendingCalls: Array<{fromId: string, targetFileId: string, targetExport: string | null}>,
 *   store: GraphStore,
 *   addLink: Function,
 *   warnings: Array<object>
 * }} args
 *   Deferred call-resolution context.
 */
function resolveDeferredCalls({ pendingCalls, store, addLink, warnings }) {
  if (!pendingCalls.length) return;

  for (const c of pendingCalls) {
    const fromId = c.fromId;
    const targetFileId = c.targetFileId;
    const exp = c.targetExport;

    if (exp) {
      const prefix = `${targetFileId}::${exp}@`;
      const match = store.findNodeIdByPrefix(prefix);
      if (match) {
        addLink(fromId, match, "call");
        continue;
      }

      warnings.push({
        kind: "unresolved-call-target",
        message:
          `Unresolved call target: cannot find exported function '${exp}' in '${targetFileId}'. ` +
          `Falling back to a module-level call edge.`,
        fromId,
        targetFileId,
        targetExport: exp
      });

      addLink(fromId, targetFileId, "call");
      continue;
    }

    addLink(fromId, targetFileId, "call");
  }
}

/**
 * Enforce strict post-analysis sanity checks.
 *
 * @param {GraphStore} store
 *   Graph store after traversal and deferred resolution.
 * @throws {Error}
 *   Thrown when analysis produced no usable nodes or no meaningful non-include links.
 */
function strictSanityCheck(store) {
  if (store.nodes.length <= 1) {
    throw new Error(
      "Analysis produced no nodes. Check that your entryAbs points to an existing file inside projectRoot."
    );
  }

  const meaningfulLinks = store.links.filter(l => String(l?.type || "") !== "include");
  if (meaningfulLinks.length === 0) {
    throw new Error(
      "Analysis produced no dependency links (use/call). This usually means the entry file has no resolvable local imports, or parsing failed."
    );
  }
}

/**
 * Materialize child-function references on file nodes.
 *
 * Why this exists
 * ---------------
 * The frontend encoder computes module/file radius from the complexity of the
 * functions contained in that file. The graph itself stays flat (`nodes[]`),
 * but we attach a lightweight `children` array to file nodes so renderer code
 * can inspect contained function nodes without rebuilding that relation on the
 * client.
 */
function attachFunctionChildren(nodes) {
  const fileNodes = collectFileNodesForChildren(nodes);
  const functionsByFile = groupFunctionChildrenByFile(nodes);

  assignFunctionChildrenToFiles(fileNodes, functionsByFile);
}

/**
 * Collect all file nodes that can receive a `children` array.
 *
 * We initialize `children` eagerly so the frontend can rely on the field
 * being present even when a file currently has no parsed functions.
 */
function collectFileNodesForChildren(nodes) {
  const fileNodes = new Map();

  for (const node of nodes) {
    if (!isObjectNode(node)) continue;
    if (node.kind !== "file") continue;

    node.children = [];
    fileNodes.set(getNodeFileId(node), node);
  }

  return fileNodes;
}

/**
 * Group all function nodes by their owning file id.
 */
function groupFunctionChildrenByFile(nodes) {
  const functionsByFile = new Map();

  for (const node of nodes) {
    if (!isObjectNode(node)) continue;
    if (node.kind !== "function") continue;

    const fileId = String(node.file || "").trim();
    if (!fileId) continue;

    const bucket = functionsByFile.get(fileId) || [];
    bucket.push(node);
    functionsByFile.set(fileId, bucket);
  }

  return functionsByFile;
}

/**
 * Attach grouped function nodes back onto their owning file nodes.
 */
function assignFunctionChildrenToFiles(fileNodes, functionsByFile) {
  for (const [fileId, fileNode] of fileNodes) {
    fileNode.children = functionsByFile.get(fileId) || [];
  }
}

/**
 * Guard helper for node-like values used during graph post-processing.
 */
function isObjectNode(node) {
  return Boolean(node) && typeof node === "object";
}

/**
 * Canonical file id lookup for file nodes.
 */
function getNodeFileId(node) {
  return String(node.file || node.id || "");
}

/**
 * Mark function nodes as unused using a conservative best-effort heuristic.
 *
 * Heuristic
 * ---------
 * A function is marked unused when it is not exported and has zero inbound
 * call edges.
 *
 * @param {Array<object>} nodes
 *   Canonical graph nodes mutated in place.
 */
function markUnusedFunctions(nodes) {
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    if (n.kind !== "function") continue;

    const exported = Boolean(n.exported);
    const inCalls = Number(n._inCalls || 0);
    n._unused = !exported && inCalls === 0;
  }
}

/**
 * Re-apply canonical node fields and hard requirements after graph finalization.
 *
 * @param {Array<object>} nodes
 *   Canonical graph nodes mutated in place.
 */
function enforceCanonicalFields(nodes) {
  console.log("START: buildMetricsFromEntrypoint: enforceCanonicalFields");
  for (const n of nodes) {
    ensureCanonicalNodeFields(n);

    delete n._radiusHint;

    if (n.kind === "function") {
      const fileExt = extFromFileId(n.file || n.id || "");
      const fileSubtype = subtypeFromExt(fileExt);

      if (typeof n.exported !== "boolean") n.exported = false;
      if (!Number.isFinite(n.startLine)) n.startLine = 0;

      n.ext = fileExt;
      n.type = "function";
      n.subtype = fileSubtype || "function";
    }
  }
}

/**
 * Pull the next unvisited absolute path from the BFS queue.
 *
 * @param {string[]} queue
 *   Pending BFS queue.
 * @param {Set<string>} queued
 *   Set of currently queued absolute paths.
 * @param {Set<string>} visited
 *   Set of already visited absolute paths.
 * @returns {string}
 *   Normalized absolute path, or an empty string when the queue is exhausted.
 */
function dequeueNextAbs(queue, queued, visited) {
  while (queue.length > 0) {
    const abs = queue.shift();
    if (!abs) continue;

    const absNorm = path.resolve(abs);
    queued.delete(absNorm);

    if (visited.has(absNorm)) continue;
    visited.add(absNorm);

    return absNorm;
  }

  return "";
}

/**
 * Parse one queued file strictly.
 *
 * @param {string} absNorm
 *   Normalized absolute file path.
 * @returns {Record<string, any>}
 *   Parsed file descriptor returned by `parseFile()`.
 * @throws {Error}
 *   Thrown when the path is invalid or parsing returns no usable object.
 */
function parseOrThrow(absNorm) {
  // Strict: queued paths must exist and be files.
  statFileOrThrow(absNorm);

  const code = readUtf8(absNorm);
  const parsed = parseFile(code, absNorm);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`parseFile returned no result for: ${absNorm}`);
  }
  return parsed;
}

/**
 * Add the canonical file node for one parsed file.
 *
 * @param {{fileId: string, parsed: Record<string, any>, addNode: Function}} args
 *   Parsed file result and insertion callback.
 */
function addFileNode({ fileId, parsed, addNode }) {
  addNode({
    id: fileId,
    file: fileId,
    lines: Number(parsed?.lines || 0),
    codeLines: Number(parsed?.codeLines || 0),
    commentLines: Number(parsed?.commentLines || 0),
    blankLines: Number(parsed?.blankLines || 0),
    complexity: Number(parsed?.complexity || 0),
    headerComment: String(parsed?.headerComment || ""),
    kind: "file"
  });
}

/**
 * Execute the deterministic BFS traversal over parseable project files.
 *
 * @param {{
 *   queue: string[],
 *   queued: Set<string>,
 *   visited: Set<string>,
 *   projectRootAbs: string,
 *   store: GraphStore,
 *   addNode: Function,
 *   addLink: Function,
 *   enqueue: Function,
 *   toRelId: Function,
 *   pendingCalls: Array<object>,
 *   warnings: Array<object>
 * }} args
 *   Full traversal state and callbacks.
 */
function bfsTraverse({
  queue,
  queued,
  visited,
  projectRootAbs,
  store,
  addNode,
  addLink,
  enqueue,
  toRelId,
  pendingCalls,
  warnings
}) {
  while (true) {
    const absNorm = dequeueNextAbs(queue, queued, visited);
    if (!absNorm) break;

    const parsed = parseOrThrow(absNorm);
    const fileId = toRelId(absNorm);

    addFileNode({ fileId, parsed, addNode });

    addFunctionNodes({ parsed, fileId, addNode });

    applyAutoRefs({
      projectRootAbs,
      fromFileAbs: absNorm,
      fromFileId: fileId,
      parsed,
      toRelId,
      ensureNode: (n) => addNode(n),
      ensureLink: (s, t, ty) => addLink(s, t, ty),
      enqueue,
      hasVisited: (absPath) => visited.has(path.resolve(absPath))
    });

    addImportEdges({ parsed, absNorm, projectRootAbs, fileId, toRelId, addLink, enqueue, visited });

    addCallEdges({ parsed, store, fileId, absNorm, projectRootAbs, toRelId, addLink, pendingCalls, warnings });
  }
}

/**
 * Convert an absolute filesystem path into the canonical project-relative graph id.
 *
 * Rules
 * -----
 * - Output always uses POSIX separators
 * - Paths outside the project root are rejected strictly
 *
 * @param {string} projectRootAbs
 *   Absolute project root path.
 * @param {string} absPath
 *   Absolute file path to convert.
 * @returns {string}
 *   Canonical project-relative graph id.
 * @throws {Error}
 *   Thrown when the path escapes the project root.
 */
function toProjectRelativeId(projectRootAbs, absPath) {
  const rootAbs = path.resolve(projectRootAbs);
  const fileAbs = path.resolve(absPath);

  let rel = path.relative(rootAbs, fileAbs);

  // Strict: never allow ids outside root. Caller config/boundary checks must guarantee this.
  if (rel.startsWith(".." + path.sep) || rel === "..") {
    throw new Error(`Path escapes project root: ${fileAbs}`);
  }

  return rel.replace(/\\/g, "/");
}

/**
 * Read a UTF-8 text file strictly.
 *
 * @param {string} absPath
 *   Absolute file path.
 * @returns {string}
 *   UTF-8 file contents.
 * @throws {Error}
 *   Propagates filesystem read failures.
 */
function readUtf8(absPath) {
  return fs.readFileSync(absPath, "utf8");
}

/**
 * Stat a path strictly and require that it is a file.
 *
 * @param {string} abs
 *   Candidate absolute file path.
 * @returns {import("node:fs").Stats}
 *   Filesystem stat result.
 * @throws {Error}
 *   Thrown when the path does not exist or is not a file.
 */
function statFileOrThrow(abs) {
  const p = path.resolve(abs);
  const st = fs.statSync(p, { throwIfNoEntry: false });
  if (!st) {
    throw new Error(`File does not exist: ${p}`);
  }
  if (!st.isFile()) {
    throw new Error(`Not a file: ${p}`);
  }
  return st;
}

/**
 * Assert that a value is a non-empty string.
 *
 * @param {unknown} value
 *   Candidate value.
 * @param {string} name
 *   Logical argument name for error reporting.
 * @throws {Error}
 *   Thrown when the value is missing or not a non-empty string.
 */
function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid ${name} (missing or not a string).`);
  }
}

/**
 * Stat a path strictly and require that it is a directory.
 *
 * @param {string} abs
 *   Candidate absolute directory path.
 * @param {string} [label="path"]
 *   Logical label for error reporting.
 * @returns {import("node:fs").Stats}
 *   Filesystem stat result.
 * @throws {Error}
 *   Thrown when the path does not exist or is not a directory.
 */
function statDirOrThrow(abs, label = "path") {
  const p = path.resolve(abs);
  const st = fs.statSync(p, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) {
    throw new Error(`${label} is not a directory or does not exist: ${p}`);
  }
  return st;
}

/**
 * Assert that a file path remains inside the configured project root.
 *
 * @param {string} rootAbs
 *   Absolute project root path.
 * @param {string} fileAbs
 *   Absolute file path to validate.
 * @throws {Error}
 *   Thrown when the file escapes the root boundary.
 */
function assertInsideRootOrThrow(rootAbs, fileAbs) {
  if (!isInsideRoot(rootAbs, fileAbs)) {
    const root = path.resolve(rootAbs);
    const file = path.resolve(fileAbs);
    throw new Error(`entryAbs is outside projectRoot. entry=${file} root=${root}`);
  }
}
/**
 * Persist the module-level code metrics CSV side artifact.
 *
 * Why this exists
 * ---------------
 * The graph JSON is canonical, but the CSV provides a lightweight module-level
 * metrics export for spreadsheet inspection and historical snapshots.
 * Export failure is intentionally non-fatal.
 *
 * @param {{nodes: Array<object>, links: Array<object>, appId: string}} args
 *   Graph payload and app identifier used for artifact naming.
 */
function writeCodeMetricsCsv({ nodes, links, appId }) {
  try {
    const timestampIso = new Date().toISOString();
    const filePrefix = `${appId}-${timestampIso.replace(/[:.]/g, "-")}`;

    const analyzerRoot = path.resolve(import.meta.dirname, "..", "..");
    const outputDir = path.join(analyzerRoot, "public/output");
    const csvPath = path.join(outputDir, `${filePrefix}-code-metrics.csv`);

    const rows = buildCodeMetricsRows({ nodes, links, timestampIso });
    const csvText = buildCodeMetricsCsvText(rows);

    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(csvPath, csvText, "utf8");
  } catch (err) {
    // Non-fatal: metrics export must never break graph generation
    console.warn("code metrics CSV write failed:", err?.message || err);
  }
}

/**
 * Build one CSV row per file/module from the finalized graph.
 *
 * @param {{nodes: Array<object>, links: Array<object>, timestampIso: string}} args
 *   Finalized graph payload and run timestamp.
 * @returns {Array<object>}
 *   Module-level metrics rows for CSV serialization.
 */
function buildCodeMetricsRows({ nodes, links, timestampIso }) {
  const fileNodes = nodes.filter((n) => n?.kind === "file");
  const functionNodes = nodes.filter((n) => n?.kind === "function");
  const functionsByFile = groupFunctionsByFile(functionNodes);

  const rows = [];

  for (const fileNode of fileNodes) {
    const fileId = String(fileNode.id || "");
    const functions = functionsByFile.get(fileId) || [];
    const functionIds = new Set(functions.map((fn) => String(fn.id || "")).filter(Boolean));

    const complexity = summarizeFunctionComplexity(functions);
    const linkStats = summarizeFileLinkStats(links, functionIds);

    rows.push({
      timestamp: timestampIso,
      module: fileId,
      loc: Number(fileNode.lines || 0),
      functionCount: functions.length,
      avgCc: complexity.avgCc,
      minCc: complexity.minCc,
      maxCc: complexity.maxCc,
      unusedFunctionCount: complexity.unusedFunctionCount,
      fanIn: linkStats.fanIn,
      fanOut: linkStats.fanOut,
      useCount: linkStats.useCount,
      callCount: linkStats.callCount,
      includeCount: linkStats.includeCount
    });
  }

  return rows;
}

/**
 * Group function nodes by their owning file id.
 *
 * @param {Array<object>} functionNodes
 *   Function-node collection.
 * @returns {Map<string, Array<object>>}
 *   Function buckets keyed by owning file id.
 */
function groupFunctionsByFile(functionNodes) {
  const functionsByFile = new Map();

  for (const fn of functionNodes) {
    const fileId = String(fn?.file || "");
    if (!fileId) continue;

    const bucket = functionsByFile.get(fileId) || [];
    bucket.push(fn);
    functionsByFile.set(fileId, bucket);
  }

  return functionsByFile;
}

/**
 * Summarize complexity metrics across the functions of one file.
 *
 * @param {Array<object>} functions
 *   Function nodes belonging to one file.
 * @returns {{avgCc: number, minCc: number, maxCc: number, unusedFunctionCount: number}}
 *   Aggregate complexity and unused-function summary.
 */
function summarizeFunctionComplexity(functions) {
  if (!Array.isArray(functions) || functions.length === 0) {
    return {
      avgCc: 0,
      minCc: 0,
      maxCc: 0,
      unusedFunctionCount: 0
    };
  }

  let minCc = Number.POSITIVE_INFINITY;
  let maxCc = 0;
  let ccTotal = 0;
  let unusedFunctionCount = 0;

  for (const fn of functions) {
    const cc = readFunctionComplexity(fn);

    minCc = Math.min(minCc, cc);
    maxCc = Math.max(maxCc, cc);
    ccTotal += cc;

    if (isUnusedFunctionNode(fn)) {
      unusedFunctionCount++;
    }
  }

  return {
    avgCc: ccTotal / functions.length,
    minCc: Number.isFinite(minCc) ? minCc : 0,
    maxCc,
    unusedFunctionCount
  };
}

/**
 * Read a function complexity metric from a function node.
 *
 * @param {object} fn
 *   Function node.
 * @returns {number}
 *   Finite complexity value.
 */
function readFunctionComplexity(fn) {
  const cc = Number(fn?.complexity ?? fn?.cc ?? 0);
  return Number.isFinite(cc) ? cc : 0;
}

/**
 * Check whether a function node has already been marked unused.
 *
 * @param {object} fn
 *   Function node.
 * @returns {boolean}
 *   `true` when the node is flagged as unused.
 */
function isUnusedFunctionNode(fn) {
  return fn?._unused === true;
}

/**
 * Summarize all graph links that touch at least one function of the current file.
 *
 * Counted dimensions
 * ------------------
 * - `useCount` / `callCount` / `includeCount`:
 *   number of link types touching one of the file's functions
 * - `fanIn`:
 *   links whose target is one of the file's functions
 * - `fanOut`:
 *   links whose source is one of the file's functions
 *
 * @param {Array<object>} links
 *   Finalized graph links.
 * @param {Set<string>} functionIds
 *   Function ids belonging to the current file.
 * @returns {{useCount: number, callCount: number, includeCount: number, fanIn: number, fanOut: number}}
 *   Coupling and link-type summary for the file.
 */
function summarizeFileLinkStats(links, functionIds) {
  const stats = createEmptyLinkStats();

  for (const link of links) {
    const normalized = normalizeLinkEndpoints(link);

    if (!linkTouchesFunctionSet(normalized, functionIds)) {
      continue;
    }

    incrementLinkTypeCount(stats, normalized.type);
    incrementFanDirectionCounts(stats, normalized, functionIds);
  }

  return stats;
}

/**
 * Create the stable zero-initialized link-stat accumulator.
 *
 * @returns {{useCount: number, callCount: number, includeCount: number, fanIn: number, fanOut: number}}
 *   Empty link-stat object.
 */
function createEmptyLinkStats() {
  return {
    useCount: 0,
    callCount: 0,
    includeCount: 0,
    fanIn: 0,
    fanOut: 0
  };
}

/**
 * Normalize one graph link into plain string endpoint fields.
 *
 * @param {object} link
 *   Raw graph link.
 * @returns {{source: string, target: string, type: string}}
 *   Normalized link descriptor.
 */
function normalizeLinkEndpoints(link) {
  return {
    source: String(link?.source || ""),
    target: String(link?.target || ""),
    type: String(link?.type || "")
  };
}

/**
 * Check whether a normalized link touches at least one function in the file set.
 *
 * @param {{source: string, target: string}} link
 *   Normalized graph link.
 * @param {Set<string>} functionIds
 *   Function ids belonging to the current file.
 * @returns {boolean}
 *   `true` when either endpoint belongs to the file's function set.
 */
function linkTouchesFunctionSet(link, functionIds) {
  return functionIds.has(link.source) || functionIds.has(link.target);
}

/**
 * Increment the semantic link-type counters on the accumulator.
 *
 * @param {{useCount: number, callCount: number, includeCount: number}} stats
 *   Mutable link-stat accumulator.
 * @param {string} linkType
 *   Normalized link type.
 */
function incrementLinkTypeCount(stats, linkType) {
  if (linkType === "use") {
    stats.useCount++;
    return;
  }

  if (linkType === "call") {
    stats.callCount++;
    return;
  }

  if (linkType === "include") {
    stats.includeCount++;
  }
}

/**
 * Increment directional coupling counters relative to the file's function set.
 *
 * @param {{fanIn: number, fanOut: number}} stats
 *   Mutable link-stat accumulator.
 * @param {{source: string, target: string}} link
 *   Normalized graph link.
 * @param {Set<string>} functionIds
 *   Function ids belonging to the current file.
 */
function incrementFanDirectionCounts(stats, link, functionIds) {
  if (functionIds.has(link.target)) {
    stats.fanIn++;
  }

  if (functionIds.has(link.source)) {
    stats.fanOut++;
  }
}

/**
 * Serialize module-level code metric rows to CSV text.
 *
 * @param {Array<object>} rows
 *   Module-level metric rows.
 * @returns {string}
 *   Complete CSV document including header row.
 */
function buildCodeMetricsCsvText(rows) {
  const header = [
    "timestamp",
    "module",
    "loc",
    "functionCount",
    "avgCc",
    "minCc",
    "maxCc",
    "unusedFunctionCount",
    "fanIn",
    "fanOut",
    "useCount",
    "callCount",
    "includeCount"
  ];

  const csvLines = [header.join(",")];

  for (const row of rows) {
    csvLines.push([
      row.timestamp,
      row.module,
      row.loc,
      row.functionCount,
      row.avgCc,
      row.minCc,
      row.maxCc,
      row.unusedFunctionCount,
      row.fanIn,
      row.fanOut,
      row.useCount,
      row.callCount,
      row.includeCount
    ].join(","));
  }

  return csvLines.join("\n");
}

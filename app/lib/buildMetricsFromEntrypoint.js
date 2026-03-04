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

function normalizeExt(ext) {
  return String(ext || "").toLowerCase();
}

function kindFromExt(ext) {
  return CODE_EXTS.has(ext) ? "file" : "asset";
}

function addScannedFileNode({ addNode, file, kind, ext }) {
  addNode({
    id: file.id,
    file: file.id,
    lines: 0,
    complexity: 0,
    headerComment: "",
    kind,
    ext
  });
}

function linkIncludeIfParent(addLink, parent, childId) {
  if (!parent) return;
  addLink(parent.id, childId, "include");
}

function enqueueIfParseable(enqueue, ext, absPath) {
  if (!PARSEABLE_EXTS.has(ext)) return;
  enqueue(absPath);
}


/* ========================================================================== */
/* PUBLIC API                                                                 */
/* ========================================================================== */

/**
 * Build a dependency graph starting at a given entrypoint.
 *
 * @param {object} args
 * @param {string} args.projectRoot Absolute path to the project root directory
 * @param {string} args.entryAbs    Absolute path to the entrypoint file
 * @param {any}    args.urlInfo     Optional metadata about a running app URL
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

  markUnusedFunctions(store.nodes);
  enforceCanonicalFields(store.nodes);

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

/** Validate and normalize the entrypoint builder arguments (strict). */
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

/** Create a strict BFS enqueue function with duplicate prevention. */
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

/** Add the stable root node (".") so the UI can anchor the graph. */
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

/** Scan project structure (include-graph) and enqueue parseable files. */
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

/** Iterate parsed functions safely (no-op if missing/empty). */
function forEachParsedFunction(parsed, fn) {
  const fns = parsed?.functions;
  if (!Array.isArray(fns) || fns.length === 0) return;
  for (const item of fns) fn(item);
}

function toTrimmedString(v) {
  return String(v || "").trim();
}

function toNonNegativeNumber(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? n : 0;
}

function positiveOrOne(v) {
  const n = toNonNegativeNumber(v);
  return n > 0 ? n : 1;
}

/** Build a canonical function node (returns null if fn has no usable id). */
function buildFunctionNode(fileId, fn) {
  const fnIdRaw = toTrimmedString(fn?.id);
  if (!fnIdRaw) return null;

  const fnNodeId = `${fileId}::${fnIdRaw}`;

  return {
    id: fnNodeId,
    file: fileId,

    // Use function span (LOC) as size driver in the renderer.
    // Falls back to 1 so functions are not all identical in size.
    lines: positiveOrOne(fn?.locLines),

    complexity: toNonNegativeNumber(fn?.complexity),
    headerComment: "",

    kind: "function",
    name: toTrimmedString(fn?.name),
    exported: Boolean(fn?.exported),
    startLine: toNonNegativeNumber(fn?.startLine)
  };
}

/** Add function nodes for a parsed file (and containment edges). */
function addFunctionNodes({ parsed, fileId, addNode, addLink }) {
  forEachParsedFunction(parsed, (fn) => {
    const node = buildFunctionNode(fileId, fn);
    if (!node) return;

    addNode(node);
    // Containment edge: file -> function
    addLink(fileId, node.id, "include");
  });
}

/** Import edges ("use") + enqueue discovered internal modules. */
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

/** Call edges ("call"): intra-file + best-effort cross-file via importBindings. */
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

/** Resolve deferred call targets after BFS, emitting best-effort edges/warnings. */
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

/** Strict sanity checks to fail fast when analysis produced no usable output. */
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

/** Mark unused functions (best-effort heuristic). */
function markUnusedFunctions(nodes) {
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    if (n.kind !== "function") continue;

    const exported = Boolean(n.exported);
    const inCalls = Number(n._inCalls || 0);
    n._unused = !exported && inCalls === 0;
  }
}

/** Enforce canonical fields and hard requirements for function nodes. */
function enforceCanonicalFields(nodes) {
  for (const n of nodes) {
    ensureCanonicalNodeFields(n);

    if (n.kind === "function") {
      if (typeof n.exported !== "boolean") n.exported = false;
      if (!Number.isFinite(n.startLine)) n.startLine = 0;
    }
  }
}

/** BFS traversal: parse files, add nodes/edges, and enqueue discovered modules. */
/**
 * Pull the next unvisited absolute path from the BFS queue.
 * Returns a normalized absolute path, or "" when the queue is exhausted.
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

/** Parse a file strictly (throws if missing/invalid). */
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

/** Add the file node for a parsed file. */
function addFileNode({ fileId, parsed, addNode }) {
  addNode({
    id: fileId,
    file: fileId,
    lines: Number(parsed?.lines || 0),
    complexity: Number(parsed?.complexity || 0),
    headerComment: String(parsed?.headerComment || ""),
    kind: "file"
  });
}

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

    addFunctionNodes({ parsed, fileId, addNode, addLink });

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
 * Convert an absolute path into a project-relative id used as node ids.
 *
 * Always returns POSIX-style separators.
 * Strict: never allows ids outside root.
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

/** Read a UTF-8 text file. Throws on error (strict). */
function readUtf8(absPath) {
  return fs.readFileSync(absPath, "utf8");
}

/** Strict stat helper: throws on error or if not a file. */
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
 * Safety boundary: ensure a path stays inside the selected project root.
 * Accepts the root itself.
 */
function isInsideRoot(rootAbs, fileAbs) {
  const root = path.resolve(rootAbs);
  const file = path.resolve(fileAbs);
  return file === root || file.startsWith(root + path.sep);
}


/* ========================================================================== */
/* GRAPH FINALIZATION (DERIVED STATS)                                          */
/* ========================================================================== */

/**
 * Initialize a node with derived-stat fields used by the UI.
 *
 * Contract (fields written):
 * - _inbound / _outbound: total degree counts across all edge types
 * - _inCalls / _outCalls: counts for `call` edges
 * - _inUses / _outUses: counts for `use` edges
 * - _inIncludes / _outIncludes: counts for `include` edges
 * - _callers / _callees: small capped lists (IDs) for quick UI display
 *
 * The UI treats these as optional; they are safe additive fields.
 *
 * @param {any} n Node object (mutated).
 */
function initDerivedStats(n) {
  if (!n || typeof n !== "object") return;

  const ensureFinite = (key, fallback = 0) => {
    if (!Number.isFinite(n[key])) n[key] = fallback;
  };

  const ensureArray = (key) => {
    if (!Array.isArray(n[key])) n[key] = [];
  };

  // Total degree + by edge type
  for (const k of [
    "_inbound",
    "_outbound",
    "_inCalls",
    "_outCalls",
    "_inUses",
    "_outUses",
    "_inIncludes",
    "_outIncludes",
    "_importance",
    "_radiusHint"
  ]) {
    ensureFinite(k, 0);
  }

  // Small relationship lists (capped) for tooltips / diagnostics.
  for (const k of ["_callers", "_callees"]) {
    ensureArray(k);
  }
}

/**
 * Push a value into an array if not already present, but keep the array small.
 * @param {any[]} arr Target array.
 * @param {string} v Value to push.
 * @param {number} cap Maximum length.
 */
function pushUniqueCapped(arr, v, cap) {
  if (!Array.isArray(arr)) return;
  const s = String(v || "");
  if (!s) return;
  if (arr.includes(s)) return;
  if (arr.length >= cap) return;
  arr.push(s);
}

/**
 * Finalize derived graph stats on the backend.
 *
 * Why here?
 * - The backend already has the full `nodes`/`links` arrays.
 * - Computing inbound/outbound counts once is cheaper than recomputing on every UI render.
 * - Enables richer function-node visuals (badges, ring widths, etc.) without extra UI passes.
 *
 * This function is intentionally tolerant:
 * - Links may use either id strings or {id: ...} objects for source/target.
 * - Unknown node ids are ignored.
 *
 * @param {any[]} nodes Graph nodes (mutated in place).
 * @param {any[]} links Graph links.
 */
/** Build a node index by id and initialize derived stats. */
function indexNodesById(nodes) {
  /** @type {Map<string, any>} */
  const byId = new Map();

  for (const n of nodes) {
    const id = String(n?.id || "").trim();
    if (!id) continue;
    initDerivedStats(n);
    byId.set(id, n);
  }

  return byId;
}

/** Normalize link endpoints to ids (supports string ids or {id}). */
function getEndpointId(x) {
  if (!x) return "";
  if (typeof x === "string") return x;
  if (typeof x === "object" && x.id) return String(x.id);
  return "";
}

function normalizeId(x) {
  return String(x || "").trim();
}

function getLinkType(l) {
  return normalizeId(l?.type) || "default";
}

function getValidLinkIdsOrNull(l) {
  const sId = normalizeId(getEndpointId(l?.source));
  const tId = normalizeId(getEndpointId(l?.target));
  if (!sId || !tId) return null;
  return { sId, tId };
}

/** Iterate links and yield only those with valid (non-empty) endpoint ids. */
function forEachValidLink(links, fn) {
  for (const l of links || []) {
    const ids = getValidLinkIdsOrNull(l);
    if (!ids) continue;
    fn(ids.sId, ids.tId, getLinkType(l));
  }
}

/** Resolve source/target node objects from ids (returns null if missing). */
function resolveNodePair(byId, sId, tId) {
  const s = byId.get(sId);
  const t = byId.get(tId);
  if (!s || !t) return null;
  return { s, t };
}

/** Apply total degree increments. */
function applyDegree(s, t) {
  s._outbound++;
  t._inbound++;
}

/**
 * Look up the handler for a given edge type.
 *
 * Why a lookup?
 * - We keep edge-type logic in `edgeTypeHandlers` (single source of truth)
 * - `applyEdgeTypeStats` stays as a tiny dispatcher
 *
 * @param {string} ty link.type (e.g. "call" | "use" | "include")
 * @returns {(s:any, t:any, sId:string, tId:string)=>void | null}
 */
function getEdgeTypeHandler(ty) {
  const type = normalizeId(ty);
  return edgeTypeHandlers[type] || null;
}

/**
 * Apply edge-type-specific derived stats.
 *
 * What this does
 * --------------
 * - This is a small dispatcher that routes each link to the matching handler
 *   in `edgeTypeHandlers`.
 * - Handlers mutate the involved node objects (`s` and `t`) in place by
 *   incrementing derived counters (e.g. _outCalls/_inCalls) and maintaining
 *   small capped relationship lists (e.g. _callers/_callees).
 *
 * Why this uses `getEdgeTypeHandler(ty)`
 * -------------------------------------
 * - Normalizes `ty` (trim, defaulting handled elsewhere) so callers can pass
 *   raw `link.type` values safely.
 * - Centralizes the handler lookup and keeps this function flat / low-branch.
 *
 * Tolerance / robustness
 * ----------------------
 * - Unknown edge types are intentionally ignored (no throw). This keeps the
 *   graph builder resilient if new link types are introduced or if a link is
 *   partially malformed.
 *
 * @param {any} s Resolved source node object (mutated).
 * @param {any} t Resolved target node object (mutated).
 * @param {string} sId Source node id (used for relationship lists).
 * @param {string} tId Target node id (used for relationship lists).
 * @param {string} ty Link type (e.g. "call" | "use" | "include").
 */
function applyEdgeTypeStats(s, t, sId, tId, ty) {
  const fn = getEdgeTypeHandler(ty);
  if (!fn) return;
  fn(s, t, sId, tId);
}
const edgeTypeHandlers = {
  call: (s, t, sId, tId) => {
    s._outCalls++;
    t._inCalls++;
    // Relationship lists: cap to avoid huge payloads
    pushUniqueCapped(t._callers, sId, 20);
    pushUniqueCapped(s._callees, tId, 20);
  },
  use: (s, t) => {
    s._outUses++;
    t._inUses++;
  },
  include: (s, t) => {
    s._outIncludes++;
    t._inIncludes++;
  }
};

/** Iterate only object-like nodes (skips nulls/primitives). */
function forEachNodeObject(nodes, fn) {
  for (const n of nodes || []) {
    if (!n || typeof n !== "object") continue;
    fn(n);
  }
}

function readMetric(n, key) {
  const v = Number(n?.[key] || 0);
  return Number.isFinite(v) ? v : 0;
}

function computeImportanceRaw({ inbound, outbound, inCalls, outCalls }) {
  // Calls are usually more semantically important than includes.
  return (inbound + outbound) + 2.5 * (inCalls + outCalls);
}

function safeLogImportance(raw) {
  const r = Math.max(0, Number(raw || 0));
  const imp = Math.log1p(r);
  return Number.isFinite(imp) ? imp : 0;
}

function safeRadiusFromImportance(importance) {
  const r = 5 + 6 * Number(importance || 0);
  return Number.isFinite(r) ? r : 8;
}

/** Compute per-node importance score + suggested radius. */
function applyImportanceAndRadius(nodes) {
  forEachNodeObject(nodes, (n) => {
    const inbound = readMetric(n, "_inbound");
    const outbound = readMetric(n, "_outbound");
    const inCalls = readMetric(n, "_inCalls");
    const outCalls = readMetric(n, "_outCalls");

    const raw = computeImportanceRaw({ inbound, outbound, inCalls, outCalls });
    const importance = safeLogImportance(raw);

    n._importance = importance;
    n._radiusHint = safeRadiusFromImportance(importance);
  });
}

function finalizeGraphStats(nodes, links) {
  if (!Array.isArray(nodes) || !Array.isArray(links)) return;

  const byId = indexNodesById(nodes);

  forEachValidLink(links, (sId, tId, ty) => {
    const pair = resolveNodePair(byId, sId, tId);
    if (!pair) return;

    applyDegree(pair.s, pair.t);
    applyEdgeTypeStats(pair.s, pair.t, sId, tId, ty);
  });

  applyImportanceAndRadius(nodes);
}
/** Strict string arg check: throws if missing or not a non-empty string. */
function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid ${name} (missing or not a string).`);
  }
}

/** Strict stat helper: throws on error or if not a directory. */
function statDirOrThrow(abs, label = "path") {
  const p = path.resolve(abs);
  const st = fs.statSync(p, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) {
    throw new Error(`${label} is not a directory or does not exist: ${p}`);
  }
  return st;
}

/** Safety boundary assertion: throws if file is outside root. */
function assertInsideRootOrThrow(rootAbs, fileAbs) {
  if (!isInsideRoot(rootAbs, fileAbs)) {
    const root = path.resolve(rootAbs);
    const file = path.resolve(fileAbs);
    throw new Error(`entryAbs is outside projectRoot. entry=${file} root=${root}`);
  }
}
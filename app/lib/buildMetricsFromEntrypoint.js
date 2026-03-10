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

function extFromFileId(fileId) {
  return normalizeExt(path.extname(String(fileId || "")));
}

function subtypeFromExt(ext) {
  return String(ext || "").replace(/^\./, "");
}

/** Build a canonical function node (returns null if fn has no usable id). */
function buildFunctionNode(fileId, fn) {
  const fnIdRaw = toTrimmedString(fn?.id);
  if (!fnIdRaw) return null;

  const fnNodeId = `${fileId}::${fnIdRaw}`;
  const fileExt = extFromFileId(fileId);
  const fileSubtype = subtypeFromExt(fileExt);

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
    startLine: toNonNegativeNumber(fn?.startLine),
    ext: fileExt,
    type: "function",
    subtype: fileSubtype || "function"
  };
}

/** Add function nodes for a parsed file. Containment stays on the node model only. */
function addFunctionNodes({ parsed, fileId, addNode }) {
  forEachParsedFunction(parsed, (fn) => {
    const node = buildFunctionNode(fileId, fn);
    if (!node) return;
    addNode(node);
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
// CSV code metrics helpers
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

function summarizeFunctionComplexity(functions) {
  let minCc = Number.POSITIVE_INFINITY;
  let maxCc = 0;
  let ccTotal = 0;
  let unusedFunctionCount = 0;

  for (const fn of functions) {
    const cc = Number(fn?.complexity || fn?.cc || 0);
    if (Number.isFinite(cc)) {
      minCc = Math.min(minCc, cc);
      maxCc = Math.max(maxCc, cc);
      ccTotal += cc;
    }

    if (fn?._unused === true) {
      unusedFunctionCount++;
    }
  }

  if (!functions.length) {
    minCc = 0;
    maxCc = 0;
  } else if (!Number.isFinite(minCc)) {
    minCc = 0;
  }

  return {
    avgCc: functions.length ? (ccTotal / functions.length) : 0,
    minCc,
    maxCc,
    unusedFunctionCount
  };
}

/**
 * Summarize all graph links that touch at least one function of the current file.
 *
 * Counted dimensions
 * ------------------
 * - useCount / callCount / includeCount:
 *   number of link types touching one of the file's functions
 *
 * - fanIn:
 *   links whose target is one of the file's functions
 *
 * - fanOut:
 *   links whose source is one of the file's functions
 *
 * Important
 * ---------
 * We only look at links that touch at least one function node of this file.
 * Links unrelated to the file are ignored.
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
 * Create a stable empty stats object.
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
 * Normalize one link into plain string fields so downstream logic
 * does not need to deal with null/undefined values.
 */
function normalizeLinkEndpoints(link) {
  return {
    source: String(link?.source || ""),
    target: String(link?.target || ""),
    type: String(link?.type || "")
  };
}

/**
 * A link is relevant if either endpoint belongs to one of the file's functions.
 */
function linkTouchesFunctionSet(link, functionIds) {
  return functionIds.has(link.source) || functionIds.has(link.target);
}

/**
 * Count the semantic link type.
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
 * Count directional coupling relative to the file's function set.
 *
 * fanIn  = link points into one of the file's functions
 * fanOut = link starts from one of the file's functions
 */
function incrementFanDirectionCounts(stats, link, functionIds) {
  if (functionIds.has(link.target)) {
    stats.fanIn++;
  }

  if (functionIds.has(link.source)) {
    stats.fanOut++;
  }
}

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
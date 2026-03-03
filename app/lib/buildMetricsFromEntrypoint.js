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

  // Strict invariants: fail fast on invalid configuration.
  if (!projectRoot || typeof projectRoot !== "string") {
    throw new Error("Invalid projectRoot (missing or not a string)." );
  }
  if (!entryAbs || typeof entryAbs !== "string") {
    throw new Error("Invalid entryAbs (missing or not a string)." );
  }

  const projectRootAbs = path.resolve(projectRoot);

  const rootStat = fs.statSync(projectRootAbs, { throwIfNoEntry: false });
  if (!rootStat || !rootStat.isDirectory()) {
    throw new Error(`projectRoot is not a directory or does not exist: ${projectRootAbs}`);
  }

  const entryNorm = path.resolve(entryAbs);
  const entryStat = fs.statSync(entryNorm, { throwIfNoEntry: false });
  if (!entryStat || !entryStat.isFile()) {
    throw new Error(`entryAbs is not a file or does not exist: ${entryNorm}`);
  }

  if (!isInsideRoot(projectRootAbs, entryNorm)) {
    throw new Error(`entryAbs is outside projectRoot. entry=${entryNorm} root=${projectRootAbs}`);
  }

  // BFS state
  // - `visited`: files already processed
  // - `queue`:   pending files to process (BFS)
  // - `queued`:  fast membership check to prevent duplicate queue entries
  const visited = new Set();
  const queue = [];
  const queued = new Set();

  // Graph storage (dedupe + stable output arrays)
  const store = new GraphStore();

  /**
   * Add a node after enforcing the canonical fields contract.
   * @param {any} n
   */
  const addNode = (n) => {
    ensureCanonicalNodeFields(n);
    store.ensureNode(n);
  };

  /**
   * Add a link (deduped by GraphStore).
   * @param {string} s
   * @param {string} t
   * @param {string} ty
   */
  const addLink = (s, t, ty) => {
    store.ensureLink(s, t, ty);
  };

  // Always include a stable root node (".") so the UI can anchor the structure graph.
  addNode({
    id: ".",
    file: ".",
    lines: 0,
    complexity: 0,
    headerComment: "",
    kind: "root"
  });

  // ------------------------------------------------------------------------
  // 1.1) PROJECT STRUCTURE SCAN (include-graph)
  // ------------------------------------------------------------------------
  // Project structure scan depth is controlled by `maxDirDepth` (UI-selected).

  /**
   * Enqueue a file for BFS parsing.
   *
   * - Normalizes the path
   * - Skips already-visited files
   * - Avoids duplicates in the queue
   */
  const enqueue = (absPath) => {
    const p = path.resolve(absPath);
    if (!p) throw new Error("enqueue(): empty path");
    if (visited.has(p)) return;
    if (queued.has(p)) return;
    queued.add(p);
    queue.push(p);
  };

  scanProjectTree({
    projectRootAbs,
    maxDepth: maxDirDepth,
    ignoreDirs: ["node_modules", ".git", "dist", "build", ".next", ".cache", "coverage"],
    onDir: (dir, parent) => {
      const n = {
        id: dir.id,
        file: dir.id,
        lines: 0,
        complexity: 0,
        headerComment: "",
        kind: "dir"
      };
      addNode(n);

      if (parent) {
        addLink(parent.id, dir.id, "include");
      }
    },
    onFile: (file, parent) => {
      const ext = String(file.ext || "").toLowerCase();
      const kind = (ext === ".js" || ext === ".mjs" || ext === ".cjs" || ext === ".ts" || ext === ".tsx" || ext === ".jsx")
        ? "file"
        : "asset";

      const n = {
        id: file.id,
        file: file.id,
        lines: 0,
        complexity: 0,
        headerComment: "",
        kind,
        ext
      };
      addNode(n);

      if (parent) {
        addLink(parent.id, file.id, "include");
      }

      if (PARSEABLE_EXTS.has(ext)) {
        enqueue(file.abs);
      }
    }
  });

  // Always ensure the entrypoint is analyzed, even if outside scan depth
  enqueue(entryAbs);

  const toRelId = (absPath) => toProjectRelativeId(projectRootAbs, absPath);

  // Deferred calls (resolved after BFS when target modules/functions exist)
  /** @type {Array<{ fromId: string, targetFileId: string, targetExport: string|null }>} */
  const pendingCalls = [];

  // Non-fatal diagnostics collected during analysis.
  // The analyzer is intentionally conservative and must not crash on unresolved
  // symbols (globals, DI, monkey-patching, CommonJS dynamic exports, etc.).
  /** @type {Array<{ kind: string, message: string, fromId?: string, targetFileId?: string, targetExport?: string|null }>} */
  const warnings = [];

  /* ------------------------------------------------------------------------ */
  /* 2) BFS TRAVERSAL                                                         */
  /* ------------------------------------------------------------------------ */

  while (queue.length > 0) {
    const abs = queue.shift();
    if (!abs) continue;

    const absNorm = path.resolve(abs);
    queued.delete(absNorm);

    if (visited.has(absNorm)) continue;
    visited.add(absNorm);

    // Strict: queued paths must exist and be files.
    statFileOrThrow(absNorm);

    const code = readUtf8(absNorm);
    const parsed = parseFile(code, absNorm);
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`parseFile returned no result for: ${absNorm}`);
    }

    const fileId = toRelId(absNorm);

    /* --------------------------------------------------------------------- */
    /* 2.1) FILE NODE                                                         */
    /* --------------------------------------------------------------------- */

    const fileNode = {
      id: fileId,
      file: fileId,
      lines: Number(parsed?.lines || 0),
      complexity: Number(parsed?.complexity || 0),
      headerComment: String(parsed?.headerComment || ""),
      kind: "file"
    };
    addNode(fileNode);

    /* --------------------------------------------------------------------- */
    /* 2.2) FUNCTION NODES (exported + internal)                               */
    /* --------------------------------------------------------------------- */
    // Convention:
    // - parseFile(): fn.id like "boot@12"
    // - graph: function node id becomes "<fileId>::<fn.id>"
    if (Array.isArray(parsed?.functions) && parsed.functions.length) {
      for (const fn of parsed.functions) {
        const fnIdRaw = String(fn?.id || "").trim();
        if (!fnIdRaw) continue;

        const fnNodeId = `${fileId}::${fnIdRaw}`;

        const locLines = Number(fn?.locLines || 0);
        const startLine = Number(fn?.startLine || 0);

        const fnNode = {
          id: fnNodeId,
          file: fileId,

          // Use function span (LOC) as size driver in the renderer.
          // Falls back to 1 so functions are not all identical in size.
          lines: locLines > 0 ? locLines : 1,

          complexity: Number(fn?.complexity || 0),
          headerComment: "",

          kind: "function",
          name: String(fn?.name || ""),
          exported: Boolean(fn?.exported),
          startLine
        };
        addNode(fnNode);

        // Containment edge: file -> function
        addLink(fileId, fnNodeId, "include");
      }
    }

    /* --------------------------------------------------------------------- */
    /* 2.3) AUTO MODE: FILE/DIR/ASSET REFS                                     */
    /* --------------------------------------------------------------------- */
    // Delegated to autoMode.js (keeps this builder slim).
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

    /* --------------------------------------------------------------------- */
    /* 2.4) IMPORT EDGES ("use")                                               */
    /* --------------------------------------------------------------------- */
    for (const spec of parsed?.imports || []) {
      const resolvedAbs = resolveImports(absNorm, spec, projectRootAbs);
      if (!resolvedAbs) continue;

      const targetAbs = path.resolve(resolvedAbs);

      // Safety: never traverse outside selected app root
      if (!isInsideRoot(projectRootAbs, targetAbs)) continue;

      const targetId = toRelId(targetAbs);

      addLink(fileId, targetId, "use");

      if (!visited.has(targetAbs)) {
        enqueue(targetAbs);
      }
    }

    /* --------------------------------------------------------------------- */
    /* 2.5) CALL EDGES ("call")                                               */
    /* --------------------------------------------------------------------- */
    // parseFile(): calls like
    //   { from: "requestRedraw@22" | null, callee: "boot" }
    //   { from: "normalizeYears@353", callee: "app/public/assets/js/ui.js::clampToDom@342" }
    //
    // We resolve two classes of calls:
    //  (A) Intra-file calls to locally declared functions (best-effort)
    //  (B) Cross-file calls to imported symbols via parsed.importBindings
    if (Array.isArray(parsed?.calls) && parsed.calls.length) {
      // Local helper: resolve a function node in a given file by "<name>@" prefix.
      const resolveFnIdByNameInFile = (fileIdForSearch, fnName) => {
        const nm = String(fnName || "").trim();
        if (!nm) return null;
        const prefix = `${fileIdForSearch}::${nm}@`;
        return store.findNodeIdByPrefix(prefix);
      };

      for (const call of parsed.calls) {
        const calleeRaw = String(call?.callee || "").trim();
        if (!calleeRaw) continue;

        // Source: function node if available, else file node.
        const fromFnRaw = String(call?.from || "").trim();

        // parseAst/parseFile may already emit fully-qualified function ids
        // ("<fileId>::<name>@<line>"). Only prefix when we got a raw token
        // like "normalizeYears@353".
        const fromId = fromFnRaw
          ? (fromFnRaw.includes("::") ? fromFnRaw : `${fileId}::${fromFnRaw}`)
          : fileId;


        // ------------------------------------------------------------------
// (A0) Intra-file call by bare name (most common output from parseFile.js)
// ------------------------------------------------------------------
// parseFile.js emits identifier calls as bare names (e.g. "clampToDom").
// If a function node exists in the SAME file with "<name>@<line>", link it.
const localByName = resolveFnIdByNameInFile(fileId, calleeRaw);
if (localByName) {
  addLink(fromId, localByName, "call");
  continue;
}

        // ------------------------------------------------------------------
        // (A) Intra-file calls (local helpers)
        // ------------------------------------------------------------------
        // If parseAst/parseFile already provides a qualified function node id,
        // we can link directly. This is the most reliable case.
        if (calleeRaw.startsWith(`${fileId}::`)) {
          // 1) Direct hit
          if (store.findNodeIdByPrefix(calleeRaw) === calleeRaw) {
            addLink(fromId, calleeRaw, "call");
            continue;
          }

          // 2) Best-effort: if the callee is missing line info or differs slightly,
          // try to resolve by "<name>@" prefix.
          // Example input: "<fileId>::clampToDom" -> match "<fileId>::clampToDom@342"
          const tail = calleeRaw.slice((fileId + "::").length);
          const nameOnly = tail.split("@")[0];
          const match = resolveFnIdByNameInFile(fileId, nameOnly);
          if (match) {
            addLink(fromId, match, "call");
            continue;
          }

          // If we cannot resolve locally, stay neutral: do not crash.
          warnings.push({
            kind: "unresolved-local-call",
            message: `Unresolved local call target '${calleeRaw}' in '${fileId}'.`,
            fromId,
            targetFileId: fileId,
            targetExport: null
          });
          continue;
        }

        // ------------------------------------------------------------------
        // (B) Cross-file calls via import bindings
        // ------------------------------------------------------------------
        // Only resolve calls if the callee maps to an import binding.
        if (!parsed.importBindings) continue;

        const binding = parsed.importBindings[calleeRaw];
        if (!binding || !binding.source) continue;

        const resolvedAbs = resolveImports(absNorm, binding.source, projectRootAbs);
        if (!resolvedAbs) continue;

        const targetAbs = path.resolve(resolvedAbs);
        if (!isInsideRoot(projectRootAbs, targetAbs)) continue;

        const targetFileId = toRelId(targetAbs);

        // Prefer binding.imported (named/default) as exported function target
        const imported = binding.imported != null ? String(binding.imported) : null;

        if (imported && imported !== "*" && imported !== "namespace" && imported !== "default") {
          // NOTE:
          // Function node ids are "<fileId>::<name@line>".
          // Without a symbol table, we resolve via prefix match in a second pass.
          pendingCalls.push({ fromId, targetFileId, targetExport: imported });
        } else {
          // Namespace/default/CJS: only module-level call edge is known
          addLink(fromId, targetFileId, "call");
        }
      }
    }
  }

  /* ------------------------------------------------------------------------ */
  /* 3) RESOLVE DEFERRED CALL TARGETS                                          */
  /* ------------------------------------------------------------------------ */

  if (pendingCalls.length) {
    for (const c of pendingCalls) {
      const fromId = c.fromId;
      const targetFileId = c.targetFileId;
      const exp = c.targetExport;

      if (exp) {
        // Find any function node in that file whose id starts with "<name>@"
        const prefix = `${targetFileId}::${exp}@`;
        const match = store.findNodeIdByPrefix(prefix);

        if (match) {
          addLink(fromId, match, "call");
          continue;
        }
      }

      // Neutral: if a named import was requested but no function node matches, do not crash.
      // This can happen in CommonJS projects, with dynamic exports, or when the parser cannot
      // reliably map symbols to function-node ids.
      if (exp) {
        warnings.push({
          kind: "unresolved-call-target",
          message:
            `Unresolved call target: cannot find exported function '${exp}' in '${targetFileId}'. ` +
            `Falling back to a module-level call edge.`,
          fromId,
          targetFileId,
          targetExport: exp
        });

        // Fallback: preserve the semantic that "something in that module was called".
        addLink(fromId, targetFileId, "call");
        continue;
      }

      // Namespace/CJS: module-level call edge is acceptable because the target is not a named symbol.
      addLink(fromId, targetFileId, "call");
    }
  }

  /* ------------------------------------------------------------------------ */
  /* 4) STRICT SANITY CHECK (NO FALLBACKS)                                     */
  /* ------------------------------------------------------------------------ */

  // If we only have the root node or no meaningful edges, the entry/config is wrong.
  // Fail fast with a clear message so the frontend can show it.
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

  /* ------------------------------------------------------------------------ */
  /* 5) FINALIZE + RETURN PAYLOAD                                              */
  /* ------------------------------------------------------------------------ */

  // Backend enrichment: compute derived per-node stats (in/out degree, call counts,
  // and small caller/callee lists). The frontend can use these for badges/rings
  // without recalculating on every render.
  finalizeGraphStats(store.nodes, store.links);

  /* ------------------------------------------------------------------------ */
  /* 5.1) UNUSED FUNCTIONS (BEST-EFFORT)                                      */
  /* ------------------------------------------------------------------------ */
  // Definition (pragmatic):
  // - kind === "function"
  // - not exported
  // - no inbound call edges
  //
  // Notes:
  // - This is a static, best-effort heuristic.
  // - Exported functions are treated as "public API" and therefore not marked.
  // - Dynamic dispatch / reflection can produce false positives.
  for (const n of store.nodes) {
    if (!n || typeof n !== "object") continue;
    if (n.kind !== "function") continue;

    const exported = Boolean(n.exported);
    const inCalls = Number(n._inCalls || 0);

    n._unused = !exported && inCalls === 0;
  }

  // Ensure every exported node contains the canonical fields required by the UI.
  for (const n of store.nodes) {
    ensureCanonicalNodeFields(n);

    // Hard requirements for function filtering (no UI defaults).
    if (n.kind === "function") {
      if (typeof n.exported !== "boolean") n.exported = false;
      if (!Number.isFinite(n.startLine)) n.startLine = 0;
    }
  }

  return {
    meta: {
      entry: toRelId(entryAbs),
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

  // Total degree
  if (!Number.isFinite(n._inbound)) n._inbound = 0;
  if (!Number.isFinite(n._outbound)) n._outbound = 0;

  // By edge type
  if (!Number.isFinite(n._inCalls)) n._inCalls = 0;
  if (!Number.isFinite(n._outCalls)) n._outCalls = 0;

  if (!Number.isFinite(n._inUses)) n._inUses = 0;
  if (!Number.isFinite(n._outUses)) n._outUses = 0;

  if (!Number.isFinite(n._inIncludes)) n._inIncludes = 0;
  if (!Number.isFinite(n._outIncludes)) n._outIncludes = 0;

  // Small relationship lists (capped) for tooltips / diagnostics.
  if (!Array.isArray(n._callers)) n._callers = [];
  if (!Array.isArray(n._callees)) n._callees = [];

  // Visualization hints (backend-computed)
  if (!Number.isFinite(n._importance)) n._importance = 0;
  if (!Number.isFinite(n._radiusHint)) n._radiusHint = 0;
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
function finalizeGraphStats(nodes, links) {
  if (!Array.isArray(nodes) || !Array.isArray(links)) return;

  /** @type {Map<string, any>} */
  const byId = new Map();

  for (const n of nodes) {
    const id = String(n?.id || "").trim();
    if (!id) continue;
    initDerivedStats(n);
    byId.set(id, n);
  }

  const getId = (x) => {
    if (!x) return "";
    if (typeof x === "string") return x;
    if (typeof x === "object" && x.id) return String(x.id);
    return "";
  };

  for (const l of links) {
    const sId = String(getId(l?.source) || "").trim();
    const tId = String(getId(l?.target) || "").trim();
    if (!sId || !tId) continue;

    const s = byId.get(sId);
    const t = byId.get(tId);
    if (!s || !t) continue;

    // Total degree
    s._outbound++;
    t._inbound++;

    const ty = String(l?.type || "default");

    if (ty === "call") {
      s._outCalls++;
      t._inCalls++;

      // Relationship lists: cap to avoid huge payloads
      pushUniqueCapped(t._callers, sId, 20);
      pushUniqueCapped(s._callees, tId, 20);
    } else if (ty === "use") {
      s._outUses++;
      t._inUses++;
    } else if (ty === "include") {
      s._outIncludes++;
      t._inIncludes++;
    }
  }

  // Derive a compact importance score (degree + call emphasis).
  // UI can map this to size/labels without recomputing.
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;

    const inbound = Number(n._inbound || 0);
    const outbound = Number(n._outbound || 0);
    const inCalls = Number(n._inCalls || 0);
    const outCalls = Number(n._outCalls || 0);

    // Calls are usually more semantically important than includes.
    const raw = (inbound + outbound) + 2.5 * (inCalls + outCalls);

    // Log-scale to keep values stable across project sizes.
    const importance = Math.log1p(Math.max(0, raw));
    n._importance = Number.isFinite(importance) ? importance : 0;

    // Suggested radius. Keep it conservative; UI may clamp.
    const radius = 5 + 6 * n._importance;
    n._radiusHint = Number.isFinite(radius) ? radius : 8;
  }
}
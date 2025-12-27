/**
 * buildMetricsFromEntrypoint
 * =========================
 *
 * Entrypoint-based static dependency graph builder for Node-style projects.
 *
 * Purpose
 * -------
 * Starting from a single entrypoint file, this module walks the project’s
 * internal import graph and emits a D3-friendly metrics payload:
 *
 * - nodes: file-level nodes with basic metrics (LOC, heuristic complexity)
 * - links: directed edges representing "uses/imports"
 *
 * Design Notes
 * ------------
 * - Deterministic traversal: breadth-first walk from the entrypoint
 * - Best-effort resolution: only resolves local/relative imports (./, ../)
 * - Resilient parsing: relies on parseFile() to tolerate common syntax errors
 * - Intended as MVP: does not model exports, runtime loading, or dynamic requires
 *
 * Output Contract
 * ---------------
 * {
 *   meta: { entry: string, urlInfo: any },
 *   nodes: Array<{ id, file, lines, complexity }>,
 *   links: Array<{ source, target, type }>
 * }
 */

import fs from "node:fs";
import path from "node:path";

import { parseFile } from "./parseFile.js";
import { resolveImports } from "./resolveImports.js";

/**
 * Build a file dependency graph starting at the given entrypoint.
 *
 * @param {object} args
 * @param {string} args.projectRoot Absolute path to the project root directory
 * @param {string} args.entryAbs    Absolute path to the entrypoint file
 * @param {any}    args.urlInfo     Optional metadata about a running app URL
 * @returns {Promise<{meta: object, nodes: object[], links: object[]}>}
 */
export async function buildMetricsFromEntrypoint({ projectRoot, entryAbs, urlInfo }) {
  // ------------------------------------------------------------
  // 1) Initialize traversal state
  // ------------------------------------------------------------
  const visited = new Set();
  const nodes = [];
  const links = [];

  const queue = [entryAbs];

  // Path normalization helper: absolute -> project-relative POSIX
  const toRelId = (absPath) => toProjectRelativeId(projectRoot, absPath);

  // ------------------------------------------------------------
  // 2) Traverse import graph (BFS)
  // ------------------------------------------------------------
  while (queue.length > 0) {
    const abs = queue.shift();
    if (!abs) continue;

    // Avoid reprocessing files
    if (visited.has(abs)) continue;
    visited.add(abs);

    // Read and parse file
    const code = readUtf8(abs);
    const parsed = parseFile(code, abs);

    const nodeId = toRelId(abs);

    // Emit node (file-level)
    nodes.push({
      id: nodeId,
      file: nodeId,
      lines: parsed.lines,
      complexity: parsed.complexity,
      comment: parsed.headerComment || ""   
    });

    // Emit edges (dependency links)
    for (const spec of parsed.imports) {
      const resolvedAbs = resolveImports(abs, spec, projectRoot);
      if (!resolvedAbs) continue;

      const targetId = toRelId(resolvedAbs);

      links.push({
        source: nodeId,
        target: targetId,
        type: "use"
      });

      // Continue traversal for newly discovered internal modules
      if (!visited.has(resolvedAbs)) {
        queue.push(resolvedAbs);
      }
    }
  }

  // ------------------------------------------------------------
  // 3) Return metrics payload
  // ------------------------------------------------------------
  return {
    meta: {
      entry: toRelId(entryAbs),
      urlInfo
    },
    nodes,
    links
  };
}

/* ====================================================================== */
/* Helpers                                                                */
/* ====================================================================== */

/**
 * Convert an absolute path to a project-relative id using forward slashes.
 *
 * @param {string} projectRoot
 * @param {string} absPath
 * @returns {string}
 */
function toProjectRelativeId(projectRoot, absPath) {
  const rel = absPath.replace(projectRoot + path.sep, "");
  return rel.replace(/\\/g, "/");
}

/**
 * Read a file as UTF-8.
 * Kept as a helper so it can later be swapped for async I/O or caching.
 *
 * @param {string} absPath
 * @returns {string}
 */
function readUtf8(absPath) {
  return fs.readFileSync(absPath, "utf8");
}
/**
 * graphFinalize.js
 * ===============
 * Backend-Graph-Finalisierung: berechnet abgeleitete Statistiken einmalig,
 * damit die UI nicht bei jedem Rendern teure Passes machen muss.
 *
 * Mutiert Nodes in-place (adds _inbound/_outbound/_inCalls/.../_importance/_radiusHint/_depth/_callers/_callees).
 *
 * Export:
 * - finalizeGraphStats(nodes, links, entryId)
 */

/**
 * Finalize derived graph stats on the backend.
 *
 * - Robust gegen Links, deren source/target entweder string ids oder {id: "..."} sind.
 * - Unbekannte/kaputte Links werden ignoriert (fail-soft).
 *
 * @param {any[]} nodes
 * @param {any[]} links
 * @param {string} [entryId] Entry/root node id used for BFS depth calculation.
 */
export function finalizeGraphStats(nodes, links, entryId) {
  if (!Array.isArray(nodes) || !Array.isArray(links)) return;

  const byId = indexNodesById(nodes);

  forEachValidLink(links, ({ sId, tId, ty }) => {
    const pair = resolveNodePair(byId, sId, tId);
    if (!pair) return;

    applyDegree(pair.s, pair.t);
    applyEdgeTypeStats({
      s: pair.s,
      t: pair.t,
      sId,
      tId,
      ty
    });
  });

  applyImportanceAndRadius(nodes);
  applyDepth(nodes, links, entryId);
}

/* ========================================================================== */
/* Internals                                                                  */
/* ========================================================================== */

function normalizeId(x) {
  return String(x || "").trim();
}

function getEndpointId(x) {
  if (!x) return "";
  if (typeof x === "string") return x;
  if (typeof x === "object" && x.id) return String(x.id);
  return "";
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

function forEachValidLink(links, fn) {
  for (const l of links || []) {
    const ids = getValidLinkIdsOrNull(l);
    if (!ids) continue;
    fn({ sId: ids.sId, tId: ids.tId, ty: getLinkType(l) });
  }
}

function resolveNodePair(byId, sId, tId) {
  const s = byId.get(sId);
  const t = byId.get(tId);
  if (!s || !t) return null;
  return { s, t };
}

function indexNodesById(nodes) {
  /** @type {Map<string, any>} */
  const byId = new Map();

  for (const n of nodes || []) {
    const id = normalizeId(n?.id);
    if (!id) continue;

    initDerivedStats(n);
    byId.set(id, n);
  }

  return byId;
}

function initDerivedStats(n) {
  if (!n || typeof n !== "object") return;

  ensureFinite(n, "_inbound", 0);
  ensureFinite(n, "_outbound", 0);

  ensureFinite(n, "_inCalls", 0);
  ensureFinite(n, "_outCalls", 0);

  ensureFinite(n, "_inUses", 0);
  ensureFinite(n, "_outUses", 0);

  ensureFinite(n, "_inIncludes", 0);
  ensureFinite(n, "_outIncludes", 0);

  ensureFinite(n, "_importance", 0);
  ensureFinite(n, "_radiusHint", 0);
  ensureFinite(n, "_depth", -1);

  ensureArray(n, "_callers");
  ensureArray(n, "_callees");
}

function ensureFinite(obj, key, fallback) {
  if (!Number.isFinite(obj?.[key])) obj[key] = fallback;
}

function ensureArray(obj, key) {
  if (!Array.isArray(obj?.[key])) obj[key] = [];
}

function applyDegree(s, t) {
  s._outbound++;
  t._inbound++;
}

function getEdgeTypeHandler(ty) {
  const type = normalizeId(ty);
  return edgeTypeHandlers[type] || null;
}

/**
 * Parameter-Object statt 5 Parameter (CodeScene: "Excess Number of Arguments").
 *
 * @param {{
 *  s:any, t:any,
 *  sId:string, tId:string,
 *  ty:string
 * }} edge
 */
function applyEdgeTypeStats(edge) {
  const fn = getEdgeTypeHandler(edge?.ty);
  if (!fn) return;

  // Handler behalten die alte Signatur (s, t, sId, tId).
  fn(edge.s, edge.t, edge.sId, edge.tId);
}

const edgeTypeHandlers = {
  call: (s, t, sId, tId) => {
    s._outCalls++;
    t._inCalls++;
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

function pushUniqueCapped(arr, v, cap) {
  if (!Array.isArray(arr)) return;

  const s = normalizeId(v);
  if (!s) return;

  if (arr.includes(s)) return;
  if (arr.length >= cap) return;

  arr.push(s);
}

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

function shouldCountForDepth(ty) {
  const type = normalizeId(ty);
  return type === "use" || type === "include";
}

function buildForwardAdjacency(nodes, links) {
  /** @type {Map<string, string[]>} */
  const adj = new Map();

  forEachNodeObject(nodes, (n) => {
    const id = normalizeId(n?.id);
    if (!id) return;
    adj.set(id, []);
  });

  forEachValidLink(links, ({ sId, tId, ty }) => {
    if (!shouldCountForDepth(ty)) return;
    const out = adj.get(sId);
    if (!out) return;
    out.push(tId);
  });

  return adj;
}

function indexNodeObjects(nodes) {
  /** @type {Map<string, any>} */
  const byId = new Map();
  forEachNodeObject(nodes, (n) => {
    const id = normalizeId(n?.id);
    if (!id) return;
    byId.set(id, n);
  });
  return byId;
}

function resetDepth(nodes) {
  forEachNodeObject(nodes, (n) => {
    n._depth = -1;
  });
}

function applyDepth(nodes, links, entryId) {
  resetDepth(nodes);

  const startId = normalizeId(entryId);
  if (!startId) return;

  const adj = buildForwardAdjacency(nodes, links);
  const byId = indexNodeObjects(nodes);
  if (!adj.has(startId) || !byId.has(startId)) return;

  const queue = [startId];
  const seen = new Set([startId]);

  byId.get(startId)._depth = 0;

  while (queue.length > 0) {
    const current = queue.shift();
    const nextIds = adj.get(current) || [];

    const currentNode = byId.get(current);
    const currentDepth = Number.isFinite(currentNode?._depth) ? currentNode._depth : -1;

    for (const nextId of nextIds) {
      if (seen.has(nextId)) continue;
      seen.add(nextId);

      const nextNode = byId.get(nextId);
      if (nextNode && typeof nextNode === "object") {
        nextNode._depth = currentDepth + 1;
      }

      queue.push(nextId);
    }
  }
}

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
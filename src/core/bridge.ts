// ============================================================
// BRIDGE — ephemeral wormhole edges read off the atlas (pure static core)
//
// The "Einstein–Rosen bridge" intuition, made computational: rather than
// expanding outward through the graph node-by-node, find the pairs the
// MANIFOLD says are adjacent that the TOPOLOGY says are far — nodes proximal
// in the ℍⁿ×𝕋ᵈ product space but many hops apart (or disconnected) on the
// raw edge set — and expose them as temporary bridge edges a traversal may
// use for one query. This is the actionable form of product.ts's
// "same rhythm, different lineage" disagreement: the two charts agree the
// pair belongs together; only the edge set never recorded it.
//
// Ephemeral by construction: bridges are RETURNED, never written into the
// graph. The write path does not exist here, same as everywhere else in this
// repo — the manifold deforms for the query and relaxes after, because the
// deformation only ever lived in the caller's hands.
//
// Whether these bridges BUY anything is not asserted — it is measured, by
// metrics.ts, as hops saved / coverage gained / expansions avoided against
// the plain walk on the same graph.
//
// Pure and deterministic. Same atlas + edges → identical bridge set.
// ============================================================

import { poincareDist } from './hyper';
import { productDist, type Mix } from './product';
import type { Edge } from './structure';

// A candidate wormhole: geodesically near (geo), topologically far (hops;
// -1 = the endpoints are in different components — no finite path at all).
// gain = graph hops the bridge removes (disconnected pairs use the node
// count as the finite stand-in, an upper bound on any simple path).
export interface BridgeEdge { a: string; b: string; geo: number; hops: number; gain: number }

export interface BridgeSet {
  bridges: BridgeEdge[];
  threshold: number;   // the geo-distance cut actually applied (quantile of all pair distances)
  considered: number;  // pairs examined
}

export interface BridgeOpts {
  torusPoints?: Record<string, number[]>; // present → product-space distance; absent → ball only
  mix?: Mix;             // curvature mix for the product distance (resolveMix output)
  quantile?: number;     // geo-closeness cut: keep pairs in the closest q of all pair distances (default 0.2)
  minHops?: number;      // topological farness cut: bridge only pairs ≥ this many hops apart (default 3)
  maxBridges?: number;   // size of the returned set (default 8)
  maxNodes?: number;     // O(n²) cap, same discipline as disagreements() (default 128, hard 256)
}

// ── BFS hop distances from one source over the undirected raw graph ───────

function adjacency(edges: Edge[]): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  const add = (a: string, b: string) => { if (!adj.has(a)) adj.set(a, []); adj.get(a)!.push(b); };
  const seen = new Set<string>();
  for (const e of edges) {
    if (!e || !e.src || !e.dst || e.src === e.dst) continue;
    const k = e.src < e.dst ? `${e.src} ${e.dst}` : `${e.dst} ${e.src}`;
    if (seen.has(k)) continue;
    seen.add(k);
    add(e.src, e.dst); add(e.dst, e.src);
  }
  return adj;
}

function hopsFrom(adj: Map<string, string[]>, source: string): Map<string, number> {
  const dist = new Map<string, number>([[source, 0]]);
  const queue = [source];
  let head = 0;
  while (head < queue.length) {
    const u = queue[head++];
    const du = dist.get(u)!;
    for (const w of adj.get(u) || []) if (!dist.has(w)) { dist.set(w, du + 1); queue.push(w); }
  }
  return dist;
}

// ── the bridge set ─────────────────────────────────────────────────────────

export function bridgeEdges(
  hyperPoints: Record<string, number[]>,
  edges: Edge[],
  opts: BridgeOpts = {},
): BridgeSet {
  const maxNodes = Math.min(256, opts.maxNodes ?? 128);
  const quantile = Math.min(1, Math.max(0, opts.quantile ?? 0.2));
  const minHops = Math.max(2, Math.round(opts.minHops ?? 3));
  const maxBridges = Math.max(1, Math.min(64, Math.round(opts.maxBridges ?? 8)));
  const torus = opts.torusPoints;
  const mix = opts.mix ?? { hyperbolic: 1, toroidal: 1 };

  // Sorted ids → the whole computation is order-independent of input maps.
  const ids = Object.keys(hyperPoints)
    .filter((id) => !torus || torus[id])
    .sort()
    .slice(0, maxNodes);
  if (ids.length < 2) return { bridges: [], threshold: 0, considered: 0 };

  const geoDist = (a: string, b: string) =>
    torus
      ? productDist({ ball: hyperPoints[a], torus: torus[a] }, { ball: hyperPoints[b], torus: torus[b] }, mix)
      : poincareDist(hyperPoints[a], hyperPoints[b]);

  const adj = adjacency(edges);
  const hops = new Map<string, Map<string, number>>();
  for (const id of ids) hops.set(id, hopsFrom(adj, id));

  const pairs: Array<{ a: string; b: string; geo: number; hops: number }> = [];
  const geos: number[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const geo = geoDist(ids[i], ids[j]);
      geos.push(geo);
      pairs.push({ a: ids[i], b: ids[j], geo, hops: hops.get(ids[i])!.get(ids[j]) ?? -1 });
    }
  }

  // The geo cut: the closest `quantile` of ALL pair distances. Relative, not
  // absolute — "near" means near for THIS atlas, whatever its scale.
  geos.sort((x, y) => x - y);
  const threshold = geos[Math.min(geos.length - 1, Math.floor(quantile * (geos.length - 1)))];

  const unreachGain = ids.length; // finite stand-in: longer than any simple path
  const candidates = pairs
    .filter((p) => p.geo <= threshold && (p.hops === -1 || p.hops >= minHops))
    .map((p) => ({ ...p, gain: (p.hops === -1 ? unreachGain : p.hops) - 1 }));

  // Rank: most hops saved per unit of geodesic distance — the strongest claim
  // the manifold makes against the topology. Deterministic tie-break on ids.
  candidates.sort((x, y) => {
    const sx = x.gain / (1e-9 + x.geo), sy = y.gain / (1e-9 + y.geo);
    if (sy !== sx) return sy - sx;
    return x.a === y.a ? (x.b < y.b ? -1 : 1) : (x.a < y.a ? -1 : 1);
  });

  return {
    bridges: candidates.slice(0, maxBridges).map((c) => ({ a: c.a, b: c.b, geo: round(c.geo, 4), hops: c.hops, gain: c.gain })),
    threshold: round(threshold, 4),
    considered: pairs.length,
  };
}

// ── query-induced bridges (the deformation that actually folds) ───────────
// `bridgeEdges` picks ONE global bridge set for the whole graph, which turns
// out to be the wrong shape for the claim: a handful of global shortcuts only
// helps the queries that happen to sit on their endpoints, and loses badly to
// random rewiring, which shortens the diameter for everyone (see bench.ts).
//
// The deformation the architecture actually wants is INDUCED BY THE QUERY:
// for this query, and only while it runs, fold the manifold so the nodes it
// is geodesically near become adjacent to it. Every query gets its own
// wormholes, anchored at its own source, and they vanish with the query.
// Same ephemerality rule as above — returned, never written.

export function queryBridges(
  source: string,
  hyperPoints: Record<string, number[]>,
  edges: Edge[],
  opts: BridgeOpts & { count?: number; diversify?: boolean; minSep?: number } = {},
): BridgeEdge[] {
  const count = Math.max(1, Math.min(32, Math.round(opts.count ?? 3)));
  const minHops = Math.max(2, Math.round(opts.minHops ?? 3));
  const minSep = Math.max(1, Math.round(opts.minSep ?? 3));
  const torus = opts.torusPoints;
  const mix = opts.mix ?? { hyperbolic: 1, toroidal: 1 };
  if (!hyperPoints[source] || (torus && !torus[source])) return [];

  const geoDist = (b: string) =>
    torus
      ? productDist({ ball: hyperPoints[source], torus: torus[source] }, { ball: hyperPoints[b], torus: torus[b] }, mix)
      : poincareDist(hyperPoints[source], hyperPoints[b]);

  const adj = adjacency(edges);
  const hops = hopsFrom(adj, source);
  const ids = Object.keys(hyperPoints).filter((id) => id !== source && (!torus || torus[id])).sort();
  const unreachGain = ids.length + 1;

  const ranked = ids
    .map((id) => ({ id, geo: geoDist(id), h: hops.get(id) ?? -1 }))
    .filter((c) => c.h === -1 || c.h >= minHops)
    .sort((x, y) => x.geo - y.geo || (x.id < y.id ? -1 : 1));

  // Nearest-first alone is REDUNDANT: the top-k manifold neighbours often sit
  // in the same graph neighbourhood, so k bridges buy barely more reach than
  // one. Measured against random scattering, that costs more recall than the
  // precision gains (bench.ts). Diversifying fixes it — take the nearest
  // candidate, then the nearest one at least `minSep` hops away from every
  // endpoint already chosen, so the bridges land in distinct regions while
  // staying manifold-near.
  const chosen: typeof ranked = [];
  if (opts.diversify) {
    const blocked = new Map<string, number>();
    for (const c of ranked) {
      if (chosen.length >= count) break;
      if ((blocked.get(c.id) ?? Infinity) < minSep) continue;
      chosen.push(c);
      const from = hopsFrom(adj, c.id);
      for (const [n, d] of from) blocked.set(n, Math.min(blocked.get(n) ?? Infinity, d));
    }
  } else {
    chosen.push(...ranked.slice(0, count));
  }

  return chosen.map((c) => ({
    a: source, b: c.id, geo: round(c.geo, 4), hops: c.h,
    gain: (c.h === -1 ? unreachGain : c.h) - 1,
  }));
}

function round(x: number, p: number): number { const f = 10 ** p; return Math.round(x * f) / f; }

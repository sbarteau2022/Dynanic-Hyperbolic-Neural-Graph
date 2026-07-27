// ============================================================
// METRICS — does the bridge actually change the search? (pure static core)
//
// The claim under test: bridging (bridge.ts) reparameterizes the traversal
// metric so that structurally relevant nodes become proximal in the search
// manifold. That is a measurable claim, and this module is the measurement:
// the SAME breadth-first evidence walk, run twice over the SAME graph — once
// on the raw edge set (baseline), once with the ephemeral bridges admitted —
// scored on the axes that matter for retrieval:
//
//   • traversal length — hops to reach each relevant node (unreached targets
//     are charged budget+1, so a miss is a cost, not a silent drop)
//   • evidence coverage — fraction of relevant nodes reached within budget
//   • compute — nodes expanded before the walk could stop (the deterministic
//     stand-in for latency: no wall clock anywhere in this repo)
//   • contradiction exposure — how often BOTH sides of a `contradicts` pair
//     land inside one query's horizon, because tension you can't see is
//     tension you can't resolve
//
// "Relevant" is defined by the manifold itself: a query's evidence set is
// its k geodesically-nearest nodes in the product space. That is the honest
// framing of what the atlas is FOR — if geometry names the evidence, the
// walk should be judged on reaching what geometry named.
//
// Pure and deterministic. Same atlas + edges → identical report.
// ============================================================

import { poincareDist } from './hyper';
import { productDist, resolveMix, type Mix } from './product';
import { asEdges, type Edge } from './structure';
import type { MemEdge } from './types';
import { bridgeEdges, type BridgeEdge, type BridgeSet, type BridgeOpts } from './bridge';

// ── the walk (shared by baseline and bridged runs) ─────────────────────────

export interface WalkMetrics {
  coverage: number;        // reached / targets, ∈ [0,1]
  mean_hops: number;       // mean hops over REACHED targets (0 if none reached)
  effective_hops: number;  // mean hops with unreached targets charged budget+1
  expanded: number;        // nodes dequeued before the walk stopped
  reached: number;
  targets: number;
}

export interface WalkOpts {
  budget?: number;                          // hop horizon (default 6)
  bridges?: Array<{ a: string; b: string }>; // ephemeral edges admitted for this walk only
}

function walkAdjacency(edges: Edge[], bridges?: Array<{ a: string; b: string }>): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  const add = (a: string, b: string) => { if (!adj.has(a)) adj.set(a, []); adj.get(a)!.push(b); };
  const seen = new Set<string>();
  const put = (a: string, b: string) => {
    if (!a || !b || a === b) return;
    const k = a < b ? `${a} ${b}` : `${b} ${a}`;
    if (seen.has(k)) return;
    seen.add(k);
    add(a, b); add(b, a);
  };
  for (const e of edges) put(e.src, e.dst);
  for (const b of bridges || []) put(b.a, b.b);
  return adj;
}

// Breadth-first evidence walk: expand until every target is found, the hop
// budget is exhausted, or the frontier dies. Early stop on full coverage is
// the point — a geometry that surfaces evidence sooner does less work, and
// `expanded` records exactly how much less.
export function evidenceWalk(edges: Edge[], source: string, targets: string[], opts: WalkOpts = {}): WalkMetrics {
  const budget = Math.max(1, Math.round(opts.budget ?? 6));
  const want = new Set(targets.filter((t) => t !== source));
  const found = new Map<string, number>();
  const adj = walkAdjacency(edges, opts.bridges);

  const dist = new Map<string, number>([[source, 0]]);
  const queue = [source];
  let head = 0, expanded = 0;
  while (head < queue.length && found.size < want.size) {
    const u = queue[head++];
    const du = dist.get(u)!;
    expanded++;
    if (du >= budget) continue;
    for (const w of adj.get(u) || []) {
      if (dist.has(w)) continue;
      dist.set(w, du + 1);
      if (want.has(w)) found.set(w, du + 1);
      queue.push(w);
    }
  }

  const n = want.size;
  const hops = [...found.values()];
  const sum = hops.reduce((a, b) => a + b, 0);
  const effSum = sum + (n - hops.length) * (budget + 1);
  return {
    coverage: n ? round(found.size / n, 4) : 1,
    mean_hops: hops.length ? round(sum / hops.length, 4) : 0,
    effective_hops: n ? round(effSum / n, 4) : 0,
    expanded,
    reached: found.size,
    targets: n,
  };
}

// ── the query set: geometry names the evidence ─────────────────────────────

export interface EvidenceQuery { source: string; targets: string[] }

export interface QueryOpts {
  torusPoints?: Record<string, number[]>;
  mix?: Mix;
  k?: number;           // evidence set size per query (default 4)
  maxQueries?: number;  // deterministic strided sample of sources (default 16)
}

export function evidenceQueries(
  hyperPoints: Record<string, number[]>,
  opts: QueryOpts = {},
): EvidenceQuery[] {
  const k = Math.max(1, Math.min(16, Math.round(opts.k ?? 4)));
  const maxQ = Math.max(1, Math.min(64, Math.round(opts.maxQueries ?? 16)));
  const torus = opts.torusPoints;
  const mix = opts.mix ?? { hyperbolic: 1, toroidal: 1 };
  const ids = Object.keys(hyperPoints).filter((id) => !torus || torus[id]).sort();
  if (ids.length < 2) return [];

  const geoDist = (a: string, b: string) =>
    torus
      ? productDist({ ball: hyperPoints[a], torus: torus[a] }, { ball: hyperPoints[b], torus: torus[b] }, mix)
      : poincareDist(hyperPoints[a], hyperPoints[b]);

  // Evenly strided over the sorted id list — deterministic, no PRNG.
  const stride = Math.max(1, Math.floor(ids.length / maxQ));
  const sources: string[] = [];
  for (let i = 0; i < ids.length && sources.length < maxQ; i += stride) sources.push(ids[i]);

  return sources.map((source) => ({
    source,
    targets: ids
      .filter((id) => id !== source)
      .map((id) => ({ id, d: geoDist(source, id) }))
      .sort((x, y) => x.d - y.d || (x.id < y.id ? -1 : 1))
      .slice(0, k)
      .map((t) => t.id),
  }));
}

// ── baseline vs. bridged, aggregated over the query set ───────────────────

export interface TraversalComparison {
  queries: number;
  baseline: WalkMetrics;
  bridged: WalkMetrics;
  delta: { coverage: number; effective_hops: number; expanded: number }; // bridged − baseline
}

export function aggregateWalks(runs: WalkMetrics[]): WalkMetrics {
  const n = runs.length || 1;
  const reached = runs.reduce((a, r) => a + r.reached, 0);
  const targets = runs.reduce((a, r) => a + r.targets, 0);
  const hopSum = runs.reduce((a, r) => a + r.mean_hops * r.reached, 0);
  return {
    coverage: targets ? round(reached / targets, 4) : 1,
    mean_hops: reached ? round(hopSum / reached, 4) : 0,
    effective_hops: round(runs.reduce((a, r) => a + r.effective_hops, 0) / n, 4),
    expanded: runs.reduce((a, r) => a + r.expanded, 0),
    reached,
    targets,
  };
}

export function compareTraversal(
  edges: Edge[],
  queries: EvidenceQuery[],
  bridges: BridgeEdge[],
  opts: { budget?: number } = {},
): TraversalComparison {
  const budget = opts.budget ?? 6;
  const base = aggregateWalks(queries.map((q) => evidenceWalk(edges, q.source, q.targets, { budget })));
  const brid = aggregateWalks(queries.map((q) => evidenceWalk(edges, q.source, q.targets, { budget, bridges })));
  return {
    queries: queries.length,
    baseline: base,
    bridged: brid,
    delta: {
      coverage: round(brid.coverage - base.coverage, 4),
      effective_hops: round(brid.effective_hops - base.effective_hops, 4),
      expanded: brid.expanded - base.expanded,
    },
  };
}

// ── contradiction exposure ─────────────────────────────────────────────────
// A `contradicts` pair is EXPOSED for a query when both endpoints sit inside
// the walk's horizon — the precondition for resolving it at all. The walk
// deliberately EXCLUDES the contradiction edges themselves: hopping the
// tension edge from one side is not resolving anything — both claims must be
// reachable through independent evidence paths (or an ephemeral bridge the
// geometry vouched for). The rate is the mean, over a deterministic source
// sample, of the fraction of pairs a query can see whole.

export interface ContradictionExposure { rate: number; pairs: number; sources: number }

export function contradictionExposure(
  memEdges: MemEdge[],
  opts: { budget?: number; bridges?: Array<{ a: string; b: string }>; maxSources?: number } = {},
): ContradictionExposure {
  const budget = Math.max(1, Math.round(opts.budget ?? 6));
  const maxSources = Math.max(1, Math.min(64, Math.round(opts.maxSources ?? 16)));
  const contras = memEdges.filter((e) => e.kind === 'contradicts' && e.src !== e.dst);
  const edges = asEdges(memEdges.filter((e) => e.kind !== 'contradicts'));
  const ids = [...new Set(edges.flatMap((e) => [e.src, e.dst]))].sort();
  if (!contras.length || !ids.length) return { rate: 0, pairs: contras.length, sources: 0 };

  const adj = walkAdjacency(edges, opts.bridges);
  const stride = Math.max(1, Math.floor(ids.length / maxSources));
  const sources: string[] = [];
  for (let i = 0; i < ids.length && sources.length < maxSources; i += stride) sources.push(ids[i]);

  let total = 0;
  for (const s of sources) {
    const dist = new Map<string, number>([[s, 0]]);
    const queue = [s];
    let head = 0;
    while (head < queue.length) {
      const u = queue[head++];
      const du = dist.get(u)!;
      if (du >= budget) continue;
      for (const w of adj.get(u) || []) if (!dist.has(w)) { dist.set(w, du + 1); queue.push(w); }
    }
    const exposed = contras.filter((c) => dist.has(c.src) && dist.has(c.dst)).length;
    total += exposed / contras.length;
  }
  return { rate: round(total / sources.length, 4), pairs: contras.length, sources: sources.length };
}

// ── the report: one call, every number the claim needs ────────────────────

export interface BridgeReport {
  mix: Mix;
  bridges: BridgeSet;
  traversal: TraversalComparison;
  contradictions: { baseline: ContradictionExposure; bridged: ContradictionExposure; delta: number };
  budget: number;
}

export interface BridgeReportOpts {
  torusPoints?: Record<string, number[]>;
  budget?: number;
  k?: number;
  maxQueries?: number;
  bridge?: Omit<BridgeOpts, 'torusPoints' | 'mix'>;
}

export function bridgeReport(
  hyperPoints: Record<string, number[]>,
  memEdges: MemEdge[],
  opts: BridgeReportOpts = {},
): BridgeReport {
  const edges = asEdges(memEdges);
  const { mix } = resolveMix({ edges });
  const budget = Math.max(1, Math.round(opts.budget ?? 6));

  const bridges = bridgeEdges(hyperPoints, edges, { ...opts.bridge, torusPoints: opts.torusPoints, mix });
  const queries = evidenceQueries(hyperPoints, { torusPoints: opts.torusPoints, mix, k: opts.k, maxQueries: opts.maxQueries });
  const traversal = compareTraversal(edges, queries, bridges.bridges, { budget });

  const baseC = contradictionExposure(memEdges, { budget });
  const bridC = contradictionExposure(memEdges, { budget, bridges: bridges.bridges });

  return {
    mix,
    bridges,
    traversal,
    contradictions: { baseline: baseC, bridged: bridC, delta: round(bridC.rate - baseC.rate, 4) },
    budget,
  };
}

function round(x: number, p: number): number { const f = 10 ** p; return Math.round(x * f) / f; }

// ============================================================
// STRUCTURE — the graph's own shape (pure static core)
//
// Lifted from elle-worker/src/structure.ts, with the LLM-tool router stripped:
// this file has no env, no model, no I/O — graph topology, nothing else.
//
// The source of truth the geometric charts (hyper.ts, torus.ts) are shadows
// of. The recognition invariant — "same identity across recurrence" — is the
// class of a memory path in the graph's OWN fundamental group, and the graph
// has that structure with no embedding at all:
//
//   • a graph's π₁ is free of rank b₁ = E − V + C   (its independent cycles)
//   • H₁ = ℤ^{b₁}                                    (those cycles, counted)
//
// The torus "winding number" is a representation of this — a homomorphism
// from the graph's π₁ into ℤⁿ. So the SHAPE OF THE GRAPH is the object; the
// charts are lenses on it. This module computes that shape directly (Betti
// number, components, δ-hyperbolicity, and the homology class of a walk from
// the actual graph cycles), and reads the curvature SIGNATURE off the graph
// so the charts are fit to what the graph already is rather than imposed on
// it (Gu, Sala, Gunel & Ré, ICLR 2019, is the learned version of this last
// step; ours is the honest heuristic).
//
// Pure and deterministic. No embedding, no model.
// ============================================================

import type { MemEdge } from './types';

export interface Edge { src: string; dst: string }

// Undirected dedupe key.
const ukey = (a: string, b: string) => (a < b ? `${a} ${b}` : `${b} ${a}`);
// The canonical undirected-edge key, exported so consumers (e.g. cycle-aware
// traversal) match the exact keys nonBridgeEdges returns.
export const edgeKey = ukey;

// ── connected components + cycle rank (union-find) ────────────────────────

interface UF { find: (x: string) => string; union: (a: string, b: string) => boolean; roots: () => Set<string> }
function makeUF(nodes: Iterable<string>): UF {
  const parent = new Map<string, string>();
  for (const n of nodes) parent.set(n, n);
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) { const nx = parent.get(x)!; parent.set(x, r); x = nx; }
    return r;
  };
  const union = (a: string, b: string): boolean => {
    const ra = find(a), rb = find(b);
    if (ra === rb) return false;
    parent.set(ra, rb);
    return true;
  };
  const roots = () => new Set([...parent.keys()].map(find));
  return { find, union, roots };
}

export interface GraphInvariants {
  nodes: number;
  edges: number;          // distinct undirected edges
  components: number;
  cycle_rank: number;     // b₁ = E − V + C, the first Betti number
  cycle_density: number;  // b₁ / max(1, E) — chord fraction
}

function distinctEdges(edges: Edge[]): Edge[] {
  const seen = new Set<string>();
  const out: Edge[] = [];
  for (const e of edges) {
    if (!e || !e.src || !e.dst || e.src === e.dst) continue;
    const k = ukey(e.src, e.dst);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ src: e.src, dst: e.dst });
  }
  return out;
}

function nodeSet(edges: Edge[]): Set<string> {
  const s = new Set<string>();
  for (const e of edges) { s.add(e.src); s.add(e.dst); }
  return s;
}

export function graphInvariants(edgesIn: Edge[]): GraphInvariants {
  const edges = distinctEdges(edgesIn);
  const nodes = nodeSet(edges);
  const uf = makeUF(nodes);
  for (const e of edges) uf.union(e.src, e.dst);
  const V = nodes.size, E = edges.length, C = nodes.size ? uf.roots().size : 0;
  const b1 = Math.max(0, E - V + C);
  return { nodes: V, edges: E, components: C, cycle_rank: b1, cycle_density: round(b1 / Math.max(1, E), 4) };
}

// ── the cycle basis: spanning forest + chords (the b₁ generators) ─────────

export interface CycleBasis { chords: Edge[]; tree_edges: number }

export function cycleBasis(edgesIn: Edge[]): CycleBasis {
  const edges = distinctEdges(edgesIn);
  const uf = makeUF(nodeSet(edges));
  const chords: Edge[] = [];
  let tree = 0;
  for (const e of edges) {
    if (uf.union(e.src, e.dst)) tree++;
    else chords.push(e);           // both endpoints already connected → a chord
  }
  return { chords, tree_edges: tree };
}

// ── the recognition invariant, from the actual cycles (no embedding) ──────
// The H₁ class of a walk = its signed crossing count on each chord. Tree-edge
// steps carry no independent info (their counts are determined by the chords
// for a closed walk), so the chord-crossing vector IS the class. Integer,
// exact, finite-time — the graph-native twin of the torus winding number.
// Two walks are the same recurrence identity iff their vectors match.

export function homologyClass(walk: string[], edgesIn: Edge[]): number[] {
  const { chords } = cycleBasis(edgesIn);
  const idx = new Map<string, { i: number; src: string }>();
  chords.forEach((c, i) => idx.set(ukey(c.src, c.dst), { i, src: c.src }));
  const vec = new Array(chords.length).fill(0);
  for (let k = 1; k < walk.length; k++) {
    const a = walk[k - 1], b = walk[k];
    if (a === b) continue;
    const hit = idx.get(ukey(a, b));
    if (!hit) continue;                    // tree edge or non-edge: no chord coordinate
    vec[hit.i] += a === hit.src ? 1 : -1;  // signed by the chord's stored orientation
  }
  return vec;
}

export function sameRecurrenceClass(walkA: string[], walkB: string[], edges: Edge[]): boolean {
  const a = homologyClass(walkA, edges), b = homologyClass(walkB, edges);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// ── cycle membership (which edges carry recurrence) ───────────────────────
// An edge is ON A CYCLE iff it is not a bridge (a cut-edge whose removal
// disconnects). Bridge edges are pure derivation/hierarchy; non-bridge edges
// participate in a loop — the recurrence structure π₁ is built from. Exact,
// O(V+E), iterative DFS (no recursion — stack-safe).

export function nonBridgeEdges(edgesIn: Edge[]): Set<string> {
  const edges = distinctEdges(edgesIn);
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.src)) adj.set(e.src, []);
    if (!adj.has(e.dst)) adj.set(e.dst, []);
    adj.get(e.src)!.push(e.dst);
    adj.get(e.dst)!.push(e.src);
  }
  const disc = new Map<string, number>();
  const low = new Map<string, number>();
  const bridges = new Set<string>();
  let timer = 0;
  for (const start of adj.keys()) {
    if (disc.has(start)) continue;
    disc.set(start, timer); low.set(start, timer); timer++;
    const stack: Array<{ u: string; parent: string | null; it: number }> = [{ u: start, parent: null, it: 0 }];
    while (stack.length) {
      const f = stack[stack.length - 1];
      const nbrs = adj.get(f.u)!;
      if (f.it < nbrs.length) {
        const v = nbrs[f.it++];
        if (v === f.parent) continue;           // skip the tree edge we came in on (simple graph)
        if (!disc.has(v)) {
          disc.set(v, timer); low.set(v, timer); timer++;
          stack.push({ u: v, parent: f.u, it: 0 });
        } else {
          low.set(f.u, Math.min(low.get(f.u)!, disc.get(v)!)); // back edge
        }
      } else {
        stack.pop();
        if (f.parent !== null) {
          low.set(f.parent, Math.min(low.get(f.parent)!, low.get(f.u)!));
          if (low.get(f.u)! > disc.get(f.parent)!) bridges.add(ukey(f.parent, f.u)); // (parent,u) is a bridge
        }
      }
    }
  }
  const onCycle = new Set<string>();
  for (const e of edges) { const k = ukey(e.src, e.dst); if (!bridges.has(k)) onCycle.add(k); }
  return onCycle;
}

// ── δ-hyperbolicity (Gromov 4-point) — how tree-like the graph is ─────────
// 0 for a tree, grows with cyclic "fatness". Sampled over the first `sample`
// nodes (deterministic — no PRNG), BFS distances on the unweighted graph.

function adjacency(edges: Edge[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const add = (a: string, b: string) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a)!.add(b); };
  for (const e of distinctEdges(edges)) { add(e.src, e.dst); add(e.dst, e.src); }
  return adj;
}

function bfs(adj: Map<string, Set<string>>, source: string, cap = 4000): Map<string, number> {
  const dist = new Map<string, number>([[source, 0]]);
  const queue = [source];
  let head = 0;
  while (head < queue.length && dist.size < cap) {
    const u = queue[head++];
    const du = dist.get(u)!;
    for (const w of adj.get(u) || []) if (!dist.has(w)) { dist.set(w, du + 1); queue.push(w); }
  }
  return dist;
}

export function deltaHyperbolicity(edges: Edge[], opts: { sample?: number } = {}): number {
  const adj = adjacency(edges);
  const nodes = [...adj.keys()].sort();
  if (nodes.length < 4) return 0;
  const S = nodes.slice(0, Math.min(opts.sample ?? 32, nodes.length));
  const D = new Map<string, Map<string, number>>();
  for (const s of S) D.set(s, bfs(adj, s));
  const d = (a: string, b: string) => D.get(a)?.get(b) ?? Infinity;
  let best = 0;
  for (let i = 0; i < S.length; i++)
    for (let j = i + 1; j < S.length; j++)
      for (let k = j + 1; k < S.length; k++)
        for (let l = k + 1; l < S.length; l++) {
          const [x, y, u, v] = [S[i], S[j], S[k], S[l]];
          const s1 = d(x, y) + d(u, v), s2 = d(x, u) + d(y, v), s3 = d(x, v) + d(y, u);
          if (!Number.isFinite(s1 + s2 + s3)) continue;
          const sorted = [s1, s2, s3].sort((p, q) => q - p);
          best = Math.max(best, (sorted[0] - sorted[1]) / 2);
        }
  return round(best, 4);
}

// ── the curvature signature: read the charts off the graph, don't impose them ─
// Heuristic (the learned version is Gu et al. 2019), honestly labeled. Two
// things must be disambiguated that a naive "small δ ⇒ tree" conflates: δ = 0
// holds for BOTH a tree AND a clique (complete graphs are 0-hyperbolic), so δ
// alone cannot tell hierarchy from dense recurrence. We gate each pull on the
// actual cycle count:
//   • hyperbolic pull = (acyclic edge fraction) · (1/(1+δ)) — high only when
//     the graph is BOTH metrically tree-like AND made mostly of tree edges.
//   • toroidal   pull = b₁ / (b₁ + C) — rises with independent loops per
//     component; exactly 0 for a forest, so a tree can never read cyclic.

export interface CurvatureSignature {
  delta: number;
  cycle_rank: number;
  tree_likeness: number;    // 1/(1+δ) ∈ (0,1]
  cycle_density: number;    // b₁/E ∈ [0,1]
  suggested: { hyperbolic: number; toroidal: number };
}

export function curvatureSignature(edges: Edge[]): CurvatureSignature {
  const inv = graphInvariants(edges);
  const delta = deltaHyperbolicity(edges);
  const treeLikeness = 1 / (1 + delta);
  const acyclicFraction = inv.edges ? (inv.edges - inv.cycle_rank) / inv.edges : 1; // tree-edge share = (V−C)/E
  const h = acyclicFraction * treeLikeness;
  const t = inv.cycle_rank / (inv.cycle_rank + Math.max(1, inv.components)); // b₁/(b₁+C); 0 for a forest
  const sum = h + t || 1;
  return {
    delta, cycle_rank: inv.cycle_rank,
    tree_likeness: round(treeLikeness, 4),
    cycle_density: inv.cycle_density,
    suggested: { hyperbolic: round(h / sum, 4), toroidal: round(t / sum, 4) },
  };
}

function round(x: number, p: number): number { const f = 10 ** p; return Math.round(x * f) / f; }

// Convenience: accept the memory graph's MemEdge[] directly.
export const asEdges = (edges: MemEdge[]): Edge[] => edges.map((e) => ({ src: e.src, dst: e.dst }));

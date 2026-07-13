// ============================================================
// HYPER — Poincaré-ball graph embedding (pure static core)
//
// Lifted verbatim from elle-worker/src/hyper.ts, with the LLM router stripped:
// this file has no env, no model, no I/O — geometry, a deterministic encoder,
// and Riemannian SGD, nothing else. Same input → identical atlas.
//
// Doctrine: Nickel & Kiela 2017. Hyperbolic space is the home of hierarchy —
// volume grows exponentially with radius, so a tree embeds with low distortion:
// general things near the origin, specific things near the boundary, tree
// distance ≈ geodesic distance.
// ============================================================

import { CONDUCTANCE, HIERARCHY, type EdgeKind, type MemEdge } from './types';

const BOUNDARY_EPS = 1e-5;
const EPS = 1e-12;

export function dot(u: number[], v: number[]): number {
  let s = 0;
  for (let i = 0; i < u.length; i++) s += u[i] * v[i];
  return s;
}
export function norm(u: number[]): number { return Math.sqrt(dot(u, u)); }

export function project(x: number[]): number[] {
  const n = norm(x);
  const max = 1 - BOUNDARY_EPS;
  if (n <= max) return x;
  const s = max / n;
  return x.map((v) => v * s);
}

// Möbius addition — the ball's group operation.
export function mobiusAdd(u: number[], v: number[]): number[] {
  const uv = dot(u, v), uu = dot(u, u), vv = dot(v, v);
  const den = 1 + 2 * uv + uu * vv;
  const a = (1 + 2 * uv + vv) / (den || EPS);
  const b = (1 - uu) / (den || EPS);
  return project(u.map((ui, i) => a * ui + b * v[i]));
}

// Geodesic distance: arcosh(1 + 2‖u−v‖² / ((1−‖u‖²)(1−‖v‖²))).
export function poincareDist(u: number[], v: number[]): number {
  const alpha = Math.max(EPS, 1 - dot(u, u));
  const beta = Math.max(EPS, 1 - dot(v, v));
  let duv = 0;
  for (let i = 0; i < u.length; i++) duv += (u[i] - v[i]) ** 2;
  const gamma = 1 + (2 * duv) / (alpha * beta);
  return Math.acosh(Math.max(1, gamma));
}

export function depth(x: number[]): number { return 2 * Math.atanh(Math.min(1 - BOUNDARY_EPS, norm(x))); }

export function expMap0(t: number[]): number[] {
  const n = norm(t);
  if (n < EPS) return t.map(() => 0);
  const s = Math.tanh(n) / n;
  return project(t.map((v) => v * s));
}
export function logMap0(y: number[]): number[] {
  const n = norm(y);
  if (n < EPS) return y.map(() => 0);
  const s = Math.atanh(Math.min(1 - BOUNDARY_EPS, n)) / n;
  return y.map((v) => v * s);
}

// Euclidean gradient of d(u,v) w.r.t. u (Nickel & Kiela eq. 4).
export function distGrad(u: number[], v: number[]): number[] {
  const alpha = Math.max(EPS, 1 - dot(u, u));
  const beta = Math.max(EPS, 1 - dot(v, v));
  let duv = 0;
  for (let i = 0; i < u.length; i++) duv += (u[i] - v[i]) ** 2;
  const gamma = 1 + (2 * duv) / (alpha * beta);
  const denom = beta * Math.sqrt(Math.max(EPS, gamma * gamma - 1));
  const a = (dot(v, v) - 2 * dot(u, v) + 1) / (alpha * alpha);
  return u.map((ui, i) => (4 / denom) * (a * ui - v[i] / alpha));
}

// ── deterministic PRNG + hash ──────────────────────────────────────────────

export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A deterministic unit vector in ℝᵈ from a string (Box–Muller over mulberry32).
// Exported so the temporal layer can seat new nodes deterministically.
export function hashDirection(key: string, dim: number): number[] {
  const rand = mulberry32(fnv1a(key));
  const v: number[] = new Array(dim);
  for (let i = 0; i < dim; i++) {
    const u1 = Math.max(EPS, rand()), u2 = rand();
    v[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  const n = norm(v) || 1;
  return v.map((x) => x / n);
}

// ── the encoder ────────────────────────────────────────────────────────────

export const RIP_DIM = 16;
const MAX_LEAVES = 512;
const TANGENT_SCALE = 0.9;

export function numericLeaves(x: unknown, prefix = '', out: Array<[string, number]> = []): Array<[string, number]> {
  if (out.length >= MAX_LEAVES) return out;
  if (typeof x === 'number') {
    if (Number.isFinite(x)) out.push([prefix, x]);
    return out;
  }
  if (Array.isArray(x)) {
    for (let i = 0; i < x.length && out.length < MAX_LEAVES; i++) numericLeaves(x[i], `${prefix}[${i}]`, out);
    return out;
  }
  if (x && typeof x === 'object') {
    for (const k of Object.keys(x as Record<string, unknown>).sort()) {
      if (out.length >= MAX_LEAVES) break;
      numericLeaves((x as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k, out);
    }
  }
  return out;
}

const symlog = (v: number) => Math.sign(v) * Math.log1p(Math.abs(v));

export function ripVector(rip: unknown, dim = RIP_DIM): number[] {
  const f = new Array(dim).fill(0);
  const leaves = numericLeaves(rip);
  for (const [path, value] of leaves) {
    const dir = hashDirection(path, dim);
    const s = Math.tanh(symlog(value));
    for (let i = 0; i < dim; i++) f[i] += s * dir[i];
  }
  const n = norm(f);
  if (n > 1) for (let i = 0; i < dim; i++) f[i] /= n;
  return f;
}

export function placeFeatures(features: number[], dim: number): number[] {
  const f = features.slice(0, dim);
  while (f.length < dim) f.push(0);
  const n = norm(f);
  const t = n > 1 ? f.map((v) => (v / n) * TANGENT_SCALE) : f.map((v) => v * TANGENT_SCALE);
  return expMap0(t);
}

// ── the mapping: Riemannian SGD over the ball ──────────────────────────────

const MAX_NODES = 256;
const MAX_EDGES = 2048;
const MAX_EPOCHS = 1000;
const DELTA_NEAR = 0.3, DELTA_FAR = 1.6;
const NEG_MARGIN = 2.4;
const HIER_MARGIN = 0.08;
const HIER_WEIGHT = 1.0;
const INIT_RADIUS = 0.1;

export interface HyperNode { id: string; features?: number[] }

export interface HyperMapOpts {
  dim?: number; epochs?: number; lr?: number; seed?: number; negatives?: number;
}

export interface HyperAtlas {
  dim: number;
  points: Record<string, number[]>;
  stats: {
    nodes: number; edges: number; epochs: number; loss: number;
    mean_edge_dist: number;
    depth: { min: number; max: number; mean: number };
  };
}

export function edgeStrength(e: MemEdge): number {
  return Math.min(1, (Math.max(0, e.weight) * (CONDUCTANCE[e.kind] ?? 0.5)) / 2);
}
export function targetDist(w: number): number { return DELTA_FAR - (DELTA_FAR - DELTA_NEAR) * w; }

export function hyperMap(nodesIn: HyperNode[], edgesIn: MemEdge[], opts: HyperMapOpts = {}): HyperAtlas {
  const dim = Math.max(2, Math.min(16, Math.round(opts.dim ?? 2)));
  const epochs = Math.max(1, Math.min(MAX_EPOCHS, Math.round(opts.epochs ?? 300)));
  const lr = Math.max(1e-4, Math.min(0.5, opts.lr ?? 0.05));
  const seed = (opts.seed ?? 42) >>> 0;
  const negPerEdge = Math.max(0, Math.min(8, Math.round(opts.negatives ?? 2)));

  const byId = new Map<string, HyperNode>();
  for (const n of nodesIn) {
    if (n && n.id && !byId.has(n.id) && byId.size < MAX_NODES) byId.set(n.id, n);
  }
  const edges = edgesIn.filter((e) => e && e.src && e.dst && e.src !== e.dst).slice(0, MAX_EDGES);
  for (const e of edges) {
    for (const id of [e.src, e.dst]) {
      if (!byId.has(id) && byId.size < MAX_NODES) byId.set(id, { id });
    }
  }
  const ids = [...byId.keys()];
  const usable = edges.filter((e) => byId.has(e.src) && byId.has(e.dst));

  const X = new Map<string, number[]>();
  for (const id of ids) {
    const node = byId.get(id)!;
    const jitter = hashDirection(`jitter:${id}`, dim).map((v) => v * 0.01);
    if (node.features && node.features.some((v) => Number.isFinite(v) && v !== 0)) {
      const p = placeFeatures(node.features.filter(Number.isFinite), dim);
      X.set(id, project(p.map((v, i) => v + jitter[i])));
    } else {
      const d0 = hashDirection(`init:${id}`, dim);
      X.set(id, project(d0.map((v, i) => v * INIT_RADIUS + jitter[i])));
    }
  }

  const rand = mulberry32(seed);
  const adj = new Set<string>();
  for (const e of usable) { adj.add(`${e.src} ${e.dst}`); adj.add(`${e.dst} ${e.src}`); }

  const step = (id: string, gradE: number[], eta: number) => {
    const x = X.get(id)!;
    const scale = ((1 - dot(x, x)) ** 2) / 4;
    X.set(id, project(x.map((v, i) => v - eta * scale * gradE[i])));
  };

  let loss = 0;
  for (let epoch = 0; epoch < epochs; epoch++) {
    loss = 0;
    const eta = lr * (1 - (0.9 * epoch) / epochs);
    for (const e of usable) {
      const u = X.get(e.src)!, v = X.get(e.dst)!;
      const w = edgeStrength(e);
      const target = targetDist(w);
      const d = poincareDist(u, v);
      const diff = d - target;
      loss += Math.max(w, 0.1) * diff * diff;
      const coef = 2 * Math.max(w, 0.1) * diff;
      step(e.src, distGrad(u, v).map((g) => coef * g), eta);
      step(e.dst, distGrad(v, u).map((g) => coef * g), eta);

      if (HIERARCHY.has(e.kind)) {
        const xu = X.get(e.src)!, xv = X.get(e.dst)!;
        const ru = norm(xu), rv = norm(xv);
        const viol = HIER_MARGIN + ru - rv;
        if (viol > 0) {
          loss += HIER_WEIGHT * viol * viol;
          const c = 2 * HIER_WEIGHT * viol;
          if (ru > EPS) step(e.src, xu.map((x) => (c * x) / ru), eta);
          if (rv > EPS) step(e.dst, xv.map((x) => (-c * x) / rv), eta);
        }
      }

      for (let k = 0; k < negPerEdge && ids.length > 2; k++) {
        const other = ids[Math.floor(rand() * ids.length)];
        if (other === e.src || other === e.dst || adj.has(`${e.src} ${other}`)) continue;
        const a = X.get(e.src)!, b = X.get(other)!;
        const gap = NEG_MARGIN - poincareDist(a, b);
        if (gap <= 0) continue;
        loss += gap * gap;
        const coef2 = -2 * gap;
        step(e.src, distGrad(a, b).map((g) => coef2 * g), eta);
        step(other, distGrad(b, a).map((g) => coef2 * g), eta);
      }
    }
  }

  const points: Record<string, number[]> = {};
  for (const id of ids) points[id] = X.get(id)!.map((v) => roundTo(v, 6));
  return { dim, points, stats: buildStats(ids, usable, X, epochs, loss) };
}

export function buildStats(ids: string[], usable: MemEdge[], X: Map<string, number[]>, epochs: number, loss: number): HyperAtlas['stats'] {
  const depths = ids.map((id) => depth(X.get(id)!));
  const edgeDists = usable.map((e) => poincareDist(X.get(e.src)!, X.get(e.dst)!));
  return {
    nodes: ids.length, edges: usable.length, epochs, loss: roundTo(loss, 6),
    mean_edge_dist: roundTo(edgeDists.length ? edgeDists.reduce((a, b) => a + b, 0) / edgeDists.length : 0, 4),
    depth: {
      min: roundTo(depths.length ? Math.min(...depths) : 0, 4),
      max: roundTo(depths.length ? Math.max(...depths) : 0, 4),
      mean: roundTo(depths.length ? depths.reduce((a, b) => a + b, 0) / depths.length : 0, 4),
    },
  };
}

export function hyperNeighbors(atlas: HyperAtlas, query: string | number[], k = 5): Array<{ id: string; dist: number; depth: number }> {
  const q = typeof query === 'string' ? atlas.points[query] : query;
  if (!q || q.length !== atlas.dim) return [];
  const skip = typeof query === 'string' ? query : null;
  return Object.entries(atlas.points)
    .filter(([id]) => id !== skip)
    .map(([id, p]) => ({ id, dist: roundTo(poincareDist(q, p), 4), depth: roundTo(depth(p), 4) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, Math.max(1, Math.min(50, k)));
}

export function roundTo(x: number, p: number): number {
  const f = 10 ** p;
  return Math.round(x * f) / f;
}

export { CONDUCTANCE, HIERARCHY };
export type { EdgeKind, MemEdge };
export const constants = { MAX_NODES, MAX_EDGES, DELTA_NEAR, DELTA_FAR, NEG_MARGIN, HIER_MARGIN, HIER_WEIGHT, INIT_RADIUS };

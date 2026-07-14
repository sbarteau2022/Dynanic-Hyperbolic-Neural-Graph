// ============================================================
// TORUS — Toroidal Graph Mapping (pure static core)
//
// Lifted from elle-worker/src/torus.ts, with the LLM-tool router and the
// PAMI-specific phase decoder stripped: this file has no env, no model, no
// I/O. It accepts a bare phase vector (numbers), not a PAMI index — the
// caller (the on-device cartographer) is responsible for producing whatever
// phase signature it wants placed on the torus.
//
// HYPER's twin. The hyperbolic chart (hyper.ts) answers "what DERIVES from
// what" — depth in the Poincaré ball is depth in the derivation. It cannot
// answer "what RECURS": the ball is simply connected, so a trajectory
// through it has no memory of having gone around anything, and anything
// cyclic (a phase, an orientation, a regime) has to be cut open to embed,
// putting 1° and 359° maximally far apart at the seam.
//
// The flat torus 𝕋ⁿ = ℝⁿ/2πℤⁿ is the opposite instrument:
//   • closure   — cyclic quantities live on it natively, no seam.
//   • winding   — a trajectory carries an integer winding number per circle,
//                 a topological invariant. Recurrence vs. drift becomes exact.
//   • no center — homogeneous, so it cannot be fooled into inventing a root
//                 for flat data the way the ball's optimizer will.
//
// SCOPE: this factor carries PERIODIC STRUCTURE only — winding, phase
// kinship, discrepancy. It claims nothing about identity/recognition beyond
// the exact winding-number invariant (see product.ts).
//
// Pure and deterministic. Same input → identical atlas.
// ============================================================

const PHI = (1 + Math.sqrt(5)) / 2;
export const TORUS_DIM = 8;                 // the phase-block dimension, 𝕋⁸
const TWO_PI = 2 * Math.PI;
// The golden angle: a full turn scaled by the most-irrational fraction 2 − φ.
export const GOLDEN_ANGLE = TWO_PI * (2 - PHI);   // ≈ 2.39996 rad ≈ 137.507°

// ── angle primitives ──────────────────────────────────────────────────────

// Any real → [0, 2π).
export function norm2pi(a: number): number {
  const x = a % TWO_PI;
  return x < 0 ? x + TWO_PI : x;
}

// Signed angular difference in (−π, π].
export function wrap(delta: number): number {
  let d = delta % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  else if (d <= -Math.PI) d += TWO_PI;
  return d;
}

// ── distance on the torus (per-axis wrapped L2, optional weights) ──────────

export function torusDist(a: number[], b: number[], weights?: number[]): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const d = wrap(a[i] - b[i]);
    const w = weights ? weights[i] : 1;
    s += w * w * d * d;
  }
  return Math.sqrt(s);
}

// φ-scale weights: axis i (a finer wavelet scale) carries φ^(−i) of the
// squared weight — the per-scale form of the framework's φ^(−n) retention law.
export function phiScaleWeights(dim = TORUS_DIM): number[] {
  return Array.from({ length: dim }, (_, i) => Math.pow(PHI, -i / 2));
}

// ── the golden low-discrepancy sequence (bare-node placement) ─────────────
// Roberts' R_d sequence: the generalized golden ratio g solves g^(d+1) = g+1
// (g = φ for d = 1), and axis j advances by g^(−(j+1)). Deterministic, and
// the most uniform additive-recurrence cover of 𝕋ᵈ — the discrepancy-optimal
// way to seat nodes that carry no phase of their own.

function generalizedGolden(d: number): number {
  let g = 2;
  for (let k = 0; k < 64; k++) g = Math.pow(1 + g, 1 / (d + 1));
  return g;
}

export function goldenSequence(n: number, dim = TORUS_DIM, seed = 0.5): number[][] {
  const g = generalizedGolden(dim);
  const alpha = Array.from({ length: dim }, (_, j) => Math.pow(g, -(j + 1)));
  const out: number[][] = [];
  for (let k = 1; k <= n; k++) {
    out.push(alpha.map((a) => norm2pi(TWO_PI * ((seed + k * a) % 1))));
  }
  return out;
}

// ── winding number (recurrence vs. drift — the invariant the ball lacks) ──
// Unwrap a sequence of torus points and count net turns per axis. A sequence
// that cycles once through a phase regime and returns has winding 1; one
// that jittered in place has winding 0. This readout does not exist on the
// ball.

export function windingNumbers(seq: number[][]): { winding: number[]; turns: number[] } {
  if (seq.length < 2) {
    const dim = seq[0]?.length ?? 0;
    return { winding: new Array(dim).fill(0), turns: new Array(dim).fill(0) };
  }
  const dim = seq[0].length;
  const acc = new Array(dim).fill(0);
  for (let k = 1; k < seq.length; k++) {
    for (let j = 0; j < dim; j++) acc[j] += wrap(seq[k][j] - seq[k - 1][j]);
  }
  return {
    winding: acc.map((a) => Math.round(a / TWO_PI)),
    turns: acc.map((a) => round(a / TWO_PI, 4)),
  };
}

// ── translation alignment ("the same note at different scales") ───────────
// Two memories whose phase signatures differ by a single global shift are
// the same structural note at a different scale/origin. Find the best shift
// τ (the circular mean of the per-axis differences) and score the fit in
// [−1, 1]; score ≈ 1 means scale-transposed kin, score ≈ 0 means unrelated.

export function translationAlign(a: number[], b: number[]): { shift: number; score: number } {
  const n = Math.min(a.length, b.length);
  if (!n) return { shift: 0, score: 0 };
  let sinS = 0, cosS = 0;
  for (let i = 0; i < n; i++) { const d = wrap(a[i] - b[i]); sinS += Math.sin(d); cosS += Math.cos(d); }
  const shift = Math.atan2(sinS, cosS);
  let score = 0;
  for (let i = 0; i < n; i++) score += Math.cos(wrap(a[i] - b[i] - shift));
  return { shift: round(shift, 5), score: round(score / n, 5) };
}

// ── star discrepancy per axis (coverage / uniformity — the torus metric) ──
// One-sided star discrepancy of one axis's values on the circle. The
// multi-axis atlas reports the per-axis mean and max; lower = more uniform.
// (True d-dim star discrepancy is intractable; per-axis 1-D is the honest,
// computable proxy for a product-of-circles design.)

export function axisDiscrepancy(anglesOneAxis: number[]): number {
  const N = anglesOneAxis.length;
  if (N < 1) return 1;
  const pts = anglesOneAxis.map((a) => norm2pi(a) / TWO_PI).sort((x, y) => x - y);
  let D = 0;
  for (let i = 0; i < N; i++) D = Math.max(D, Math.abs((i + 1) / N - pts[i]), Math.abs(i / N - pts[i]));
  return D;
}

export function atlasDiscrepancy(points: number[][], dim: number): { mean: number; max: number; per_axis: number[] } {
  if (!points.length) return { mean: 0, max: 0, per_axis: [] };
  const perAxis: number[] = [];
  for (let j = 0; j < dim; j++) perAxis.push(axisDiscrepancy(points.map((p) => p[j] ?? 0)));
  return {
    mean: round(perAxis.reduce((a, b) => a + b, 0) / dim, 5),
    max: round(Math.max(...perAxis), 5),
    per_axis: perAxis.map((d) => round(d, 5)),
  };
}

// ── nobility: is a winding ratio φ-like (noble) or rational (resonant)? ────
// δ_inf(ω) = inf_{n=1..N} n·‖nω‖. Maximal (φ^(−2) ≈ 0.382) for φ and its
// noble equivalents; near 0 for rationals and near-rationals. Tells genuine
// φ-structured coherence from performative rational-frequency entrainment.

export function nobility(omega: number, nMax = 300): number {
  let w = omega % 1; if (w < 0) w += 1;
  let best = Infinity;
  for (let n = 1; n <= nMax; n++) {
    const nw = n * w;
    const val = n * Math.abs(nw - Math.round(nw));
    if (val < best) best = val;
    if (best < 1e-12) break;
  }
  return round(best, 5);
}

// ── the encoder: a raw phase vector → a torus point (no hashing) ──────────
// Phases are expected in (−π, π]; 0 is treated as "no signal on this axis".
// We seat them directly on 𝕋⁸ (norm to [0, 2π)). Any non-finite or missing
// value reads as phase 0, indistinguishable from a measured 0 — the φ-scale
// weights already down-weight that at finer scales.

export function phasesToTorus(phases: number[], dim = TORUS_DIM): number[] {
  const out: number[] = [];
  for (let i = 0; i < dim; i++) out.push(norm2pi(Number.isFinite(phases[i]) ? phases[i] : 0));
  return out;
}

function round(x: number, p: number): number { const f = 10 ** p; return Math.round(x * f) / f; }

// ── the mapping: place nodes, report the shape ────────────────────────────
// PLACEMENT, not a re-fit: a node with a phase signature is seated where its
// phases put it; a bare node gets a golden-sequence seat. We read the shape
// (coverage, kinship); we don't drag points around with an optimizer the way
// the hierarchy chart does.

const MAX_NODES = 1024;

export interface TorusNode { id: string; phases?: number[] }

export interface TorusAtlas {
  dim: number;
  points: Record<string, number[]>;
  stats: { nodes: number; placed: number; bare: number; discrepancy: { mean: number; max: number; per_axis: number[] } };
}

export function torusMap(nodesIn: TorusNode[], opts: { dim?: number } = {}): TorusAtlas {
  const dim = Math.max(1, Math.min(TORUS_DIM, Math.round(opts.dim ?? TORUS_DIM)));
  const points: Record<string, number[]> = {};
  const bare: string[] = [];
  let placed = 0;
  for (const n of nodesIn) {
    if (!n || !n.id || points[n.id] || Object.keys(points).length + bare.length >= MAX_NODES) continue;
    const phases = n.phases;
    if (phases && phases.some((v) => Number.isFinite(v) && v !== 0)) {
      points[n.id] = phasesToTorus(phases, dim);
      placed++;
    } else {
      bare.push(n.id);
    }
  }
  if (bare.length) {
    const seq = goldenSequence(bare.length, dim);
    bare.forEach((id, i) => { points[id] = seq[i]; });
  }
  const pts = Object.values(points);
  return {
    dim, points,
    stats: {
      nodes: pts.length, placed, bare: bare.length,
      discrepancy: atlasDiscrepancy(pts, dim),
    },
  };
}

export function torusNeighbors(atlas: TorusAtlas, query: string | number[], k = 5, weighted = true):
  Array<{ id: string; dist: number; align: number }> {
  const q = typeof query === 'string' ? atlas.points[query] : query;
  if (!q) return [];
  const w = weighted ? phiScaleWeights(atlas.dim) : undefined;
  const skip = typeof query === 'string' ? query : null;
  return Object.entries(atlas.points)
    .filter(([id]) => id !== skip)
    .map(([id, p]) => ({ id, dist: round(torusDist(q, p, w), 5), align: translationAlign(q, p).score }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, Math.max(1, Math.min(50, k)));
}

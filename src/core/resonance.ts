// ============================================================
// RESONANCE — superposition instead of mixture (pure static core)
//
// The convex mix is zero-sum. `productDist` scores d² = w_ℍ·d_ℍ² + w_𝕋·d_𝕋²
// with the weights read off the graph's own topology, and on a FOREST the
// toroidal pull is b₁/(b₁+C) = 0 exactly — not damped, ZEROED. Measured on
// the benchmark's star corpus the mix comes out {hyperbolic: 1, toroidal: 0}
// and the torus contributes 0.0% of the distance, which is why bridge
// precision there collapsed to 2/8 (chance). The chart that carries
// cross-lineage kinship gets switched off precisely when the graph is
// hierarchical — exactly the case where cross-lineage kinship is the only
// thing worth knowing.
//
// The fix is to stop making the two charts compete for one scalar. Treat the
// ball as AMPLITUDE (the structural baseline) and the torus as FREQUENCY (the
// semantic resonance), and let phase agreement MODULATE hyperbolic distance
// rather than be averaged against it:
//
//     D(a,b) = d_ℍ(a,b) · f(r(a,b))
//
// where r ∈ [−1,1] is phase resonance and f is the regulator. Nodes whose
// phases resonate pinch together wherever they sit on the tree; nodes whose
// phases clash keep their true topological distance. No weight to choose, no
// topology inference, no veto.
//
// ── WHAT THIS IS NOT ──
// This is NOT a metric and must not be described as one. Multiplying a
// distance by a pairwise gate breaks the triangle inequality: if a resonates
// with b and b with c while a clashes with c, D(a,c) can exceed
// D(a,b) + D(b,c). That is acceptable — arguably the point — for a
// QUERY-TIME ROUTING SCORE that decides which wormholes to open, and it is
// disqualifying for a geometry. `productDist` remains the metric (Gu, Sala,
// Gunel & Ré, ICLR 2019); this sits beside it as a second instrument.
//
// Pure and deterministic.
// ============================================================

import { poincareDist } from './hyper';
import { phiScaleWeights, translationAlign, wrap } from './torus';

// ── resonance: how much two phase signatures agree ────────────────────────
// φ-scale-weighted mean of cos(Δθ) per axis, so coarse scales dominate the
// same way they do in `torusDist`. +1 = phase-locked, 0 = unrelated, −1 =
// antiphase. `transposed` uses the translation-invariant score instead — the
// "same note at a different origin" kinship torus.ts already computes — which
// catches rhythms that match up to a global shift.
export function resonance(a: number[], b: number[], opts: { transposed?: boolean } = {}): number {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  if (opts.transposed) return translationAlign(a.slice(0, n), b.slice(0, n)).score;
  const w = phiScaleWeights(n);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const wi = w[i] * w[i];
    num += wi * Math.cos(wrap(a[i] - b[i]));
    den += wi;
  }
  return den ? round(num / den, 6) : 0;
}

// ── the regulator ─────────────────────────────────────────────────────────
// f(r) = max(floor, 1 − gain · max(0, r)^sharpness)
//
// Three deliberate choices:
//   • ONE-SIDED (max(0,r)). Only agreement pulls; disagreement never pushes
//     past the true distance. Unrelated pairs sit at r ≈ 0 by construction,
//     so the NEUTRAL case must map to f = 1 — a two-sided regulator (e.g.
//     exp(−κ(1+r)/2)) collapses the whole graph by a constant factor at
//     r = 0, which is a global rescale masquerading as a fold.
//   • SHARPNESS. Random phase vectors carry a non-zero |r| by chance; raising
//     r to a power makes only strong agreement earn a fold and keeps the
//     noise floor from opening spurious wormholes.
//   • FLOOR. Without one, a spuriously resonant pair lands at distance ~0
//     regardless of true separation, and the deformation is unbounded. The
//     floor is the maximum fold this instrument is allowed to apply.
export interface RegulatorOpts { gain?: number; sharpness?: number; floor?: number }

export function regulator(r: number, opts: RegulatorOpts = {}): number {
  const gain = clamp(opts.gain ?? 0.95, 0, 1);
  const sharpness = Math.max(1, opts.sharpness ?? 3);
  const floor = clamp(opts.floor ?? 0.05, 1e-6, 1);
  const pull = Math.pow(Math.max(0, r), sharpness);
  return round(Math.max(floor, 1 - gain * pull), 6);
}

// ── the routing score ─────────────────────────────────────────────────────
// Hyperbolic distance modulated by phase resonance. No mix parameter exists
// to be inferred, so a tree can keep its deep hyperbolic embedding AND still
// route semantically — the topological veto is structurally impossible here.
export interface ResonantOpts extends RegulatorOpts { transposed?: boolean }

export function resonantDist(
  a: { ball: number[]; torus: number[] },
  b: { ball: number[]; torus: number[] },
  opts: ResonantOpts = {},
): number {
  const d = poincareDist(a.ball, b.ball);
  return round(d * regulator(resonance(a.torus, b.torus, opts), opts), 6);
}

// How far a pair actually folded, as a diagnostic: 1 = untouched, 0 = fully
// collapsed. Reported by the bridge layer so a fold is inspectable rather
// than implicit.
export function foldFactor(a: number[], b: number[], opts: ResonantOpts = {}): number {
  return regulator(resonance(a, b, opts), opts);
}

function clamp(x: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, x)); }
function round(x: number, p: number): number { const f = 10 ** p; return Math.round(x * f) / f; }

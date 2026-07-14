// ============================================================
// PRODUCT — Mixed-curvature graph mapping: ℍⁿ × 𝕋ᵈ (pure static core)
//
// Lifted from elle-worker/src/product.ts, with the LLM-tool router stripped:
// this file has no env, no model, no I/O.
//
// The two charts made one instrument. HYPER (hyper.ts) places a memory by
// DERIVATION DEPTH in the Poincaré ball; TORUS (torus.ts) places it by PHASE
// on the flat torus. Neither alone is the memory: the ball has no sense of
// what recurs (it is simply connected — no loop remembers going around), the
// torus has no sense of what is general (it is homogeneous — no center).
// Together each node is a pair (depth ρ, phase θ), and the PAYOFF is the
// disagreements:
//
//   • close on the torus, far in the ball  → same rhythm, different lineage
//     (convergent structure across unrelated derivations).
//   • close in the ball, far on the torus  → same lineage, drifted phase
//     (a derived memory that no longer rhymes with its source).
//
// Signature and distance follow Gu, Sala, Gunel & Ré, "Learning
// Mixed-Curvature Representations in Product Spaces" (ICLR 2019):
// d² = d_ℍ² + d_𝕋².
//
// ── the exact recognition invariant ──
// The ball's fundamental group is trivial (π₁(ℍⁿ)=0) — it cannot certify
// "same identity across recurrence." The torus can: a memory trajectory's
// identity-continuity class is its WINDING NUMBER, the class of the ordered
// phase path in π₁(𝕋ⁿ) = ℤⁿ — an integer, exact at every finite time, computed
// here by `recognitionInvariant`. That is distinct from METRIC return (does
// the orbit come back to the same POINT), which for irrational winding is
// only asymptotic (`metricReturn`). The gap between these two numbers is
// exactly the case for holding the topological invariant over the metric one.
// ============================================================

import { depth as ballDepth, poincareDist } from './hyper';
import { torusDist, windingNumbers, phiScaleWeights, phasesToTorus, norm2pi } from './torus';
import { curvatureSignature, type Edge } from './structure';

// How the two factors are mixed. Read off the graph by curvatureSignature —
// tree-like graphs weight the ball, cyclic graphs weight the torus — so the
// charts are fit to the graph's own shape, not imposed on it. Equal by default.
export interface Mix { hyperbolic: number; toroidal: number }
const EQUAL_MIX: Mix = { hyperbolic: 1, toroidal: 1 };

// ── (depth, phase) pairing over the shared node set ───────────────────────

export interface ProductNode { id: string; depth: number; phase: number[] }

export function productPairs(
  hyperPoints: Record<string, number[]>,
  torusPoints: Record<string, number[]>,
): ProductNode[] {
  const out: ProductNode[] = [];
  for (const id of Object.keys(hyperPoints)) {
    if (!torusPoints[id]) continue;
    out.push({ id, depth: round(ballDepth(hyperPoints[id]), 4), phase: torusPoints[id] });
  }
  return out;
}

// Product distance d² = wₕ·d_ℍ² + wₜ·d_𝕋². The mix comes from the graph's own
// curvature signature. Back-compatible: a bare number is the legacy torus
// scalar (hyperbolic weight 1); a Mix object sets both factors.
export function productDist(
  a: { ball: number[]; torus: number[] },
  b: { ball: number[]; torus: number[] },
  weight: number | Mix = 1,
): number {
  const { hyperbolic, toroidal } = typeof weight === 'number' ? { hyperbolic: 1, toroidal: weight * weight } : weight;
  const dH = poincareDist(a.ball, b.ball);
  const dT = torusDist(a.torus, b.torus, phiScaleWeights(Math.min(a.torus.length, b.torus.length)));
  return Math.sqrt(hyperbolic * dH * dH + toroidal * dT * dT);
}

// ── the disagreements (the reason to hold both charts) ────────────────────

export interface Disagreement { a: string; b: string; ball: number; torus: number }
export interface Disagreements {
  same_rhythm_diff_lineage: Disagreement[]; // torus-close, ball-far
  same_lineage_drift_phase: Disagreement[]; // ball-close, torus-far
}

// Over the shared node set, rank the pairs where the two charts most disagree.
// Distances are min-max normalized within each chart so "close/far" is
// comparable across curvatures. O(n²) — capped at `maxNodes`.
export function disagreements(
  hyperPoints: Record<string, number[]>,
  torusPoints: Record<string, number[]>,
  opts: { maxNodes?: number; topK?: number; mix?: Mix } = {},
): Disagreements {
  const maxNodes = Math.min(256, opts.maxNodes ?? 128);
  const topK = Math.min(50, opts.topK ?? 8);
  const mix = opts.mix ?? EQUAL_MIX;
  const ids = Object.keys(hyperPoints).filter((id) => torusPoints[id]).slice(0, maxNodes);
  const w = phiScaleWeights(ids.length ? torusPoints[ids[0]].length : 0);

  const pairs: Array<{ a: string; b: string; ball: number; torus: number }> = [];
  let ballMax = 1e-9, torusMax = 1e-9;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const ball = poincareDist(hyperPoints[ids[i]], hyperPoints[ids[j]]);
      const torus = torusDist(torusPoints[ids[i]], torusPoints[ids[j]], w);
      ballMax = Math.max(ballMax, ball); torusMax = Math.max(torusMax, torus);
      pairs.push({ a: ids[i], b: ids[j], ball, torus });
    }
  }
  // Normalize each chart to [0,1], then weight by the graph's curvature mix: a
  // hierarchical graph trusts ball-distance more, a cyclic one trusts phase.
  const norm = (p: { ball: number; torus: number }) => ({ nb: mix.hyperbolic * (p.ball / ballMax), nt: mix.toroidal * (p.torus / torusMax) });
  const mk = (p: typeof pairs[number]): Disagreement => ({ a: p.a, b: p.b, ball: round(p.ball, 4), torus: round(p.torus, 4) });

  const rhythm = [...pairs].sort((x, y) => {
    const nx = norm(x), ny = norm(y);
    return (ny.nb - ny.nt) - (nx.nb - nx.nt); // ball-far AND torus-close
  }).slice(0, topK).map(mk);
  const lineage = [...pairs].sort((x, y) => {
    const nx = norm(x), ny = norm(y);
    return (ny.nt - ny.nb) - (nx.nt - nx.nb); // torus-far AND ball-close
  }).slice(0, topK).map(mk);

  return { same_rhythm_diff_lineage: rhythm, same_lineage_drift_phase: lineage };
}

// Resolve the curvature mix: an explicit signature wins, else read it off the
// graph edges, else equal. Returns the mix plus the signature it came from.
export function resolveMix(input: { signature?: Mix; edges?: Edge[] }): { mix: Mix; signature?: ReturnType<typeof curvatureSignature> } {
  if (input.signature) return { mix: input.signature };
  if (input.edges?.length) {
    const sig = curvatureSignature(input.edges);
    return { mix: { hyperbolic: sig.suggested.hyperbolic, toroidal: sig.suggested.toroidal }, signature: sig };
  }
  return { mix: EQUAL_MIX };
}

// ── the exact recognition invariant ────────────────────────────────────────
// A memory trajectory's identity-continuity class is its winding vector — the
// class of the ordered phase path in π₁(𝕋ⁿ) = ℤⁿ. Integer, and exactly
// defined at every finite time. Two sub-trajectories are the SAME recurrence
// identity iff their winding vectors match.

export function recognitionInvariant(phaseSeq: number[][]): number[] {
  return windingNumbers(phaseSeq).winding;
}

export function sameRecurrenceClass(a: number[][], b: number[][]): boolean {
  const wa = recognitionInvariant(a), wb = recognitionInvariant(b);
  if (wa.length !== wb.length) return false;
  return wa.every((v, i) => v === wb[i]);
}

// The metric counterpart: the closest a trajectory re-approaches its own
// start. For an irrational (φ) winding this is > 0 at every finite N and
// only → 0 as N → ∞ (asymptotic, never exact) — while `recognitionInvariant`
// is an exact integer the whole time.
export function metricReturn(phaseSeq: number[][]): number {
  if (phaseSeq.length < 2) return Infinity;
  const start = phaseSeq[0];
  let best = Infinity;
  for (let k = 1; k < phaseSeq.length; k++) best = Math.min(best, torusDist(start, phaseSeq[k]));
  return round(best, 6);
}

function round(x: number, p: number): number { const f = 10 ** p; return Math.round(x * f) / f; }

// Convenience re-export so callers assembling a phase sequence from raw
// phase vectors (rather than already-wrapped torus points) don't need to
// import torus.ts directly.
export { phasesToTorus, norm2pi };

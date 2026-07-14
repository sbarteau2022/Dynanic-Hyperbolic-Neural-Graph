// ============================================================
// RECOVERY — recovery-rate regulating function, stop-loss, recovery-time
// dynamics (pure static core)
//
// The layer the README promised on top of the measurement primitives:
//
//   atlasDrift (temporal.ts)      → how much the map moved this build
//   disagreements (product.ts)    → same-rhythm/different-lineage pairs
//
// Three instruments, one loop:
//
//   1. recoveryRate / recoveryTime — MEASURE. After a perturbation (a burst
//      of new events shoves the frontier), drift should decay geometrically
//      back toward the stable-interior baseline. The rate λ of that decay
//      (drift_t ≈ peak·e^{−λt}) is the recovery rate; the number of builds
//      until drift re-crosses a threshold is the recovery time.
//
//   2. regulate — the RECOVERY-RATE REGULATING FUNCTION. Maps the recent
//      drift history to the next build's relaxation parameters: high or
//      rising drift buys more relax epochs at a gentler learning rate (a
//      longer, softer anneal); a quiet map gets a cheap incremental build.
//      This is the secondary optimization that falls out of the first as a
//      byproduct — measuring recovery hands you the knob settings for free.
//
//   3. stopLoss — the CUT. Three triggers, each an actual failure mode of
//      this system (not invented thresholds looking for a purpose):
//        • reroll   — drift.mean past REROLL_DRIFT: the build did not evolve
//          the map, it re-rolled it, so every downstream reading (recovery,
//          lineage motion) is meaningless this build.
//        • diverging — drift rising across the last DIVERGE_RUNS builds:
//          perturbations decay, divergence compounds; a map that moves more
//          every build is not recovering.
//        • runaway_lineage — a disagreement pair that is phase-close but
//          lineage-far past bounds: the same rhythm recurring at ever
//          greater derivational remove, the shape a runaway recovery loop
//          takes before either chart alone would flag it (see README).
//      A triggered stop-loss means: keep the local snapshot, do NOT publish
//      it. The device holds the loss instead of propagating it.
//
// Pure and deterministic throughout — same history in, same verdict out.
// ============================================================

export interface BuildRecord {
  version: string;
  created_at: number;
  drift_mean: number;
  drift_max: number;
  new_nodes: number;
}

export interface DisagreementPair { a: string; b: string; ball: number; torus: number }

// ── measurement ────────────────────────────────────────────────────────────

// Fit drift_t ≈ peak·e^(−λt) on the tail after the series' peak, by least
// squares on ln(drift). Returns λ per build (>0 = decaying, <0 = growing),
// or null when there is nothing to measure (short series, or drift already
// at baseline everywhere — a quiet map has no recovery to rate).
const BASELINE = 1e-4;   // matches atlasDrift's "moved" epsilon: below this a node hasn't meaningfully moved

export function recoveryRate(driftSeries: number[]): number | null {
  const s = driftSeries.filter((d) => Number.isFinite(d) && d >= 0);
  if (s.length < 3) return null;
  const peakIdx = s.indexOf(Math.max(...s));
  if (s[peakIdx] <= BASELINE) return null;
  let tail = s.slice(peakIdx).filter((d) => d > BASELINE);
  // A still-growing series peaks at its end, leaving no post-peak segment —
  // fit the whole above-baseline series instead, so growth reads as the
  // negative rate it is rather than as "nothing to measure".
  if (tail.length < 2) tail = s.filter((d) => d > BASELINE);
  if (tail.length < 2) return null;
  // least squares: ln(d_t) = ln(peak) − λ·t
  const n = tail.length;
  let st = 0, sy = 0, stt = 0, sty = 0;
  for (let t = 0; t < n; t++) {
    const y = Math.log(tail[t]);
    st += t; sy += y; stt += t * t; sty += t * y;
  }
  const denom = n * stt - st * st;
  if (denom === 0) return null;
  const slope = (n * sty - st * sy) / denom;
  return round(-slope, 6);
}

// Builds from the peak until drift first re-crosses `threshold`. null when
// it never does within the series — recovery not (yet) observed.
export function recoveryTime(driftSeries: number[], threshold = 0.01): number | null {
  const s = driftSeries.filter((d) => Number.isFinite(d) && d >= 0);
  if (!s.length) return null;
  const peakIdx = s.indexOf(Math.max(...s));
  if (s[peakIdx] <= threshold) return 0;
  for (let t = peakIdx + 1; t < s.length; t++) {
    if (s[t] <= threshold) return t - peakIdx;
  }
  return null;
}

// ── the regulating function ────────────────────────────────────────────────

export interface RelaxParams { relaxEpochs: number; lr: number }

const EPOCHS_MIN = 20, EPOCHS_MAX = 200;
const LR_MIN = 0.01, LR_MAX = 0.05;
// Drift at or above this maps to the full anneal (max epochs, min lr).
const DRIFT_SATURATION = 0.25;

// Recent drift → next build's relaxation parameters. Monotone by design:
// more drift ⇒ more epochs and a gentler lr, saturating at the bounds. The
// "recent" signal is the max of the last three builds, so one quiet build
// after a shove doesn't instantly drop the anneal back to minimum while the
// frontier is still settling.
export function regulate(history: Array<Pick<BuildRecord, 'drift_mean'>> | number[]): RelaxParams {
  const drifts = (history as Array<Pick<BuildRecord, 'drift_mean'> | number>)
    .map((h) => (typeof h === 'number' ? h : h.drift_mean))
    .filter((d) => Number.isFinite(d) && d >= 0);
  const recent = drifts.slice(-3);
  const signal = recent.length ? Math.max(...recent) : 0;
  const x = Math.min(1, signal / DRIFT_SATURATION);      // 0 = quiet, 1 = saturated
  return {
    relaxEpochs: Math.round(EPOCHS_MIN + x * (EPOCHS_MAX - EPOCHS_MIN)),
    lr: round(LR_MAX - x * (LR_MAX - LR_MIN), 4),
  };
}

// ── the stop-loss ──────────────────────────────────────────────────────────

export interface StopLossOpts {
  rerollDrift?: number;       // drift.mean past this = the build re-rolled, not evolved
  divergeRuns?: number;       // strictly-rising drift across this many builds = diverging
  runawayBall?: number;       // lineage distance past this...
  runawayTorus?: number;      // ...while phase distance is under this = runaway lineage
}

export interface StopLossVerdict {
  triggered: boolean;
  reasons: Array<{ kind: 'reroll' | 'diverging' | 'runaway_lineage'; detail: string }>;
}

const DEFAULTS: Required<StopLossOpts> = {
  rerollDrift: 0.5,     // a warm build's stable interior moving this much geodesically is a re-roll, not evolution
  divergeRuns: 3,
  runawayBall: 2.5,     // deeper than targetDist's far anchor (1.6) by a full near-band — genuinely unrelated lineages
  runawayTorus: 0.5,    // φ-weighted phase distance this small = the same rhythm
};

export function stopLoss(
  input: {
    driftSeries: number[];                       // oldest → newest, current build last
    disagreements?: { same_rhythm_diff_lineage?: DisagreementPair[] };
  },
  opts: StopLossOpts = {},
): StopLossVerdict {
  const o = { ...DEFAULTS, ...opts };
  const reasons: StopLossVerdict['reasons'] = [];
  const s = input.driftSeries.filter((d) => Number.isFinite(d) && d >= 0);
  const current = s.length ? s[s.length - 1] : 0;

  if (current > o.rerollDrift) {
    reasons.push({ kind: 'reroll', detail: `drift.mean ${round(current, 4)} > ${o.rerollDrift}: the build re-rolled the map instead of evolving it` });
  }

  if (s.length >= o.divergeRuns) {
    const tail = s.slice(-o.divergeRuns);
    const rising = tail.every((d, i) => i === 0 || d > tail[i - 1]);
    if (rising && tail[tail.length - 1] > BASELINE) {
      reasons.push({ kind: 'diverging', detail: `drift rising across the last ${o.divergeRuns} builds (${tail.map((d) => round(d, 4)).join(' → ')}): compounding motion, not perturbation-and-recovery` });
    }
  }

  for (const p of input.disagreements?.same_rhythm_diff_lineage ?? []) {
    if (p.ball > o.runawayBall && p.torus < o.runawayTorus) {
      reasons.push({ kind: 'runaway_lineage', detail: `${p.a}↔${p.b}: phase-close (𝕋 ${round(p.torus, 4)}) at lineage distance ℍ ${round(p.ball, 4)} — the same rhythm recurring at runaway derivational remove` });
    }
  }

  return { triggered: reasons.length > 0, reasons };
}

function round(x: number, p: number): number { const f = 10 ** p; return Math.round(x * f) / f; }

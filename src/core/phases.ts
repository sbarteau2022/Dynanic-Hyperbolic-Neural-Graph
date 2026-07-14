// ============================================================
// PHASES — on-device phase signatures from the event log itself
// (pure static core)
//
// Until now every real node landed on the torus via the golden fallback
// lattice, because nothing on the device computed a phase signature. But
// the device already holds the one per-node signal it owns outright: the
// node's RECALL ACTIVITY over time, straight out of the append-only event
// log. A memory that keeps being recalled in a daily rhythm and one that
// fires in weekly bursts are different notes, and that difference is
// exactly what the torus factor exists to carry.
//
// Construction (deterministic, no model, no wall clock):
//   1. Bin each node's event timestamps into a fixed-length activity
//      series over the log's observed time range (weights summed).
//   2. At 8 φ-spaced periods T_k = T₀·φᵏ, project the series onto
//      cos/sin — a single-frequency Fourier probe per scale — giving a
//      phase and an amplitude at each scale.
//   3. Report each node's phase RELATIVE to the whole log's activity
//      phase at the same scale. Relative-to-corpus is what makes "same
//      rhythm" comparable across nodes: two memories recalled in the same
//      cadence get similar signatures regardless of when the log started.
//
// A scale with no real energy (amplitude below floor) reports phase 0 —
// the same "no content" sentinel torus.ts already treats as unweighted.
// Nodes with fewer than MIN_EVENTS events get no signature at all and
// keep their golden-lattice seat: an honest "not enough signal yet", not
// a fabricated rhythm.
// ============================================================

import type { MemEvent } from './events';

const PHI = (1 + Math.sqrt(5)) / 2;
const DIM = 8;            // matches TORUS_DIM
const BINS = 128;
const BASE_PERIOD = 4;    // bins; scales T_k = 4·φᵏ ∈ [4, 116] of the 128-bin window
const MIN_EVENTS = 2;
const AMP_FLOOR = 1e-9;

// Bin a set of (ts, weight) points into BINS buckets over [t0, t1].
function binSeries(points: Array<{ ts: number; w: number }>, t0: number, t1: number): number[] {
  const out = new Array<number>(BINS).fill(0);
  const span = Math.max(1, t1 - t0);
  for (const p of points) {
    const i = Math.min(BINS - 1, Math.max(0, Math.floor(((p.ts - t0) / span) * BINS)));
    out[i] += p.w;
  }
  return out;
}

// Single-frequency probe: the series' phase and amplitude at period T bins.
function probe(series: number[], period: number): { phase: number; amp: number } {
  let sinS = 0, cosS = 0;
  const mean = series.reduce((a, b) => a + b, 0) / series.length;
  for (let t = 0; t < series.length; t++) {
    const x = series[t] - mean;               // de-mean so bin 0's mass isn't a fake DC rhythm
    const theta = (2 * Math.PI * t) / period;
    sinS += x * Math.sin(theta);
    cosS += x * Math.cos(theta);
  }
  const amp = Math.hypot(sinS, cosS) / series.length;
  return { phase: Math.atan2(sinS, cosS), amp };
}

export const phaseScales = (): number[] => Array.from({ length: DIM }, (_, k) => BASE_PERIOD * Math.pow(PHI, k));

// Per-node phase signatures for every node with enough events; the rest are
// simply absent (→ golden-lattice fallback downstream). Pure: same event
// log in, same signatures out.
export function nodePhasesFromEvents(eventsIn: MemEvent[]): Record<string, number[]> {
  const events = eventsIn.filter((e) => e && e.src && e.dst && Number.isFinite(e.ts ?? NaN));
  if (events.length < MIN_EVENTS) return {};

  const times = events.map((e) => e.ts!);
  const t0 = Math.min(...times), t1 = Math.max(...times);
  if (t1 <= t0) return {};    // a single instant has no rhythm to read

  const perNode = new Map<string, Array<{ ts: number; w: number }>>();
  const all: Array<{ ts: number; w: number }> = [];
  for (const e of events) {
    const w = Math.max(0, e.weight ?? 1);
    const pt = { ts: e.ts!, w };
    all.push(pt);
    for (const id of [e.src, e.dst]) {
      if (!perNode.has(id)) perNode.set(id, []);
      perNode.get(id)!.push(pt);
    }
  }

  const scales = phaseScales();
  const corpus = binSeries(all, t0, t1);
  const ref = scales.map((T) => probe(corpus, T));

  const out: Record<string, number[]> = {};
  for (const [id, pts] of perNode) {
    if (pts.length < MIN_EVENTS) continue;
    const series = binSeries(pts, t0, t1);
    const phases = scales.map((T, k) => {
      const p = probe(series, T);
      // No energy at this scale (in the node, or in the corpus reference it
      // would be measured against) ⇒ the 0 sentinel, not a noise phase.
      if (p.amp < AMP_FLOOR || ref[k].amp < AMP_FLOOR) return 0;
      return wrapPi(p.phase - ref[k].phase);
    });
    // A node whose every scale read as the sentinel has no signature —
    // leaving it absent keeps the honest golden-lattice fallback.
    if (phases.some((v) => v !== 0)) out[id] = phases.map((v) => round(v, 6));
  }
  return out;
}

// Signed wrap into (−π, π] — the range torus.ts's encoder expects.
function wrapPi(a: number): number {
  let d = a % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  else if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

function round(x: number, p: number): number { const f = 10 ** p; return Math.round(x * f) / f; }

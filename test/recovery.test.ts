import { describe, it, expect } from 'vitest';
import { recoveryRate, recoveryTime, regulate, stopLoss } from '../src/core/recovery';
import { buildAtlas } from '../src/cartographer';
import { atlasDrift } from '../src/core/temporal';
import type { MemEvent } from '../src/core/events';

describe('recoveryRate (λ of the post-peak decay)', () => {
  it('recovers λ from a clean exponential decay', () => {
    // drift_t = 0.2·e^(−0.5t): λ should come back ≈ 0.5
    const series = Array.from({ length: 8 }, (_, t) => 0.2 * Math.exp(-0.5 * t));
    expect(recoveryRate(series)).toBeCloseTo(0.5, 6);
  });

  it('measures from the peak, ignoring the quiet run-up before the perturbation', () => {
    const quiet = [0.0001, 0.0002];
    const decay = Array.from({ length: 6 }, (_, t) => 0.3 * Math.exp(-0.4 * t));
    expect(recoveryRate([...quiet, ...decay])).toBeCloseTo(0.4, 6);
  });

  it('is negative for a growing series (anti-recovery reads as what it is)', () => {
    const series = Array.from({ length: 6 }, (_, t) => 0.01 * Math.exp(0.3 * t));
    expect(recoveryRate(series)!).toBeLessThan(0);
  });

  it('returns null when there is nothing to measure', () => {
    expect(recoveryRate([])).toBeNull();
    expect(recoveryRate([0.1, 0.05])).toBeNull();                 // too short
    expect(recoveryRate([0.00001, 0.00002, 0.00001])).toBeNull(); // all at baseline
  });
});

describe('recoveryTime (builds from peak back under threshold)', () => {
  it('counts builds from the peak to the first re-crossing', () => {
    expect(recoveryTime([0.001, 0.3, 0.1, 0.02, 0.005], 0.01)).toBe(3);
  });
  it('is 0 when the series never left baseline, null when it never recovers', () => {
    expect(recoveryTime([0.001, 0.002, 0.001], 0.01)).toBe(0);
    expect(recoveryTime([0.001, 0.3, 0.2, 0.15], 0.01)).toBeNull();
  });
});

describe('regulate (the recovery-rate regulating function)', () => {
  it('a quiet map gets the cheap incremental build; saturation gets the full gentle anneal', () => {
    const quiet = regulate([0, 0, 0]);
    expect(quiet).toEqual({ relaxEpochs: 20, lr: 0.05 });
    const hot = regulate([0.01, 0.3, 0.4]);
    expect(hot).toEqual({ relaxEpochs: 200, lr: 0.01 });
  });

  it('is monotone: more drift ⇒ more epochs and gentler lr', () => {
    const lo = regulate([0.02]);
    const mid = regulate([0.1]);
    const hi = regulate([0.2]);
    expect(mid.relaxEpochs).toBeGreaterThan(lo.relaxEpochs);
    expect(hi.relaxEpochs).toBeGreaterThan(mid.relaxEpochs);
    expect(mid.lr).toBeLessThan(lo.lr);
    expect(hi.lr).toBeLessThan(mid.lr);
  });

  it('keys on the max of the last three builds — one quiet build after a shove does not drop the anneal', () => {
    const settling = regulate([0.3, 0.0001]);   // shove, then one quiet build
    expect(settling.relaxEpochs).toBe(200);     // still annealing at the shove's scale
    const settled = regulate([0.3, 0.0001, 0.0001, 0.0001]); // shove out of the window
    expect(settled.relaxEpochs).toBe(20);
  });

  it('accepts BuildRecord history and bare numbers alike', () => {
    expect(regulate([{ drift_mean: 0.25 }])).toEqual(regulate([0.25]));
  });
});

describe('stopLoss (the cut)', () => {
  it('a clean build triggers nothing', () => {
    const v = stopLoss({ driftSeries: [0.2, 0.05, 0.01, 0.002], disagreements: { same_rhythm_diff_lineage: [{ a: 'x', b: 'y', ball: 1.2, torus: 0.3 }] } });
    expect(v.triggered).toBe(false);
    expect(v.reasons).toEqual([]);
  });

  it('reroll: current drift past the bound means the map re-rolled, not evolved', () => {
    const v = stopLoss({ driftSeries: [0.01, 0.02, 0.9] });
    expect(v.triggered).toBe(true);
    expect(v.reasons.map((r) => r.kind)).toContain('reroll');
  });

  it('diverging: strictly rising drift across the window compounds, a spike-then-decay does not', () => {
    expect(stopLoss({ driftSeries: [0.01, 0.05, 0.12] }).reasons.map((r) => r.kind)).toContain('diverging');
    expect(stopLoss({ driftSeries: [0.12, 0.05, 0.01] }).triggered).toBe(false);
    // a flat tail is not "rising"
    expect(stopLoss({ driftSeries: [0.05, 0.05, 0.05] }).triggered).toBe(false);
  });

  it('runaway lineage: phase-close at excessive lineage distance trips; either bound alone does not', () => {
    const runaway = stopLoss({ driftSeries: [0.01], disagreements: { same_rhythm_diff_lineage: [{ a: 'p', b: 'q', ball: 3.1, torus: 0.2 }] } });
    expect(runaway.triggered).toBe(true);
    expect(runaway.reasons[0].kind).toBe('runaway_lineage');
    expect(runaway.reasons[0].detail).toMatch(/p↔q/);
    // far in the ball but also far in phase = genuinely different, not runaway
    expect(stopLoss({ driftSeries: [0.01], disagreements: { same_rhythm_diff_lineage: [{ a: 'p', b: 'q', ball: 3.1, torus: 2.0 }] } }).triggered).toBe(false);
    // phase-close but at sane lineage distance = ordinary kinship
    expect(stopLoss({ driftSeries: [0.01], disagreements: { same_rhythm_diff_lineage: [{ a: 'p', b: 'q', ball: 1.0, torus: 0.2 }] } }).triggered).toBe(false);
  });

  it('multiple failures stack into one verdict', () => {
    const v = stopLoss({
      driftSeries: [0.1, 0.3, 0.9],
      disagreements: { same_rhythm_diff_lineage: [{ a: 'p', b: 'q', ball: 3.0, torus: 0.1 }] },
    });
    expect(v.reasons.map((r) => r.kind).sort()).toEqual(['diverging', 'reroll', 'runaway_lineage']);
  });
});

// ── the loop, end to end on the real pipeline ──────────────────────────────
describe('recovery dynamics on the actual cartographer (not synthetic series)', () => {
  const ev = (src: string, dst: string, ts: number): MemEvent => ({ kind: 'assoc', src, dst, weight: 1, ts });
  const BASE = [ev('a', 'b', 1), ev('b', 'c', 2), ev('c', 'd', 3), ev('d', 'a', 4)];

  it('a perturbation (new nodes) spikes drift on the frontier, then decays across warm rebuilds', () => {
    const cold = buildAtlas(BASE, { epochs: 300, seed: 3 });
    // Shove: two new nodes attach to the cycle.
    const shoved = [...BASE, ev('b', 'x', 5), ev('x', 'y', 6)];
    let prior = cold.hyper.points;
    const drifts: number[] = [];
    for (let t = 0; t < 4; t++) {
      const built = buildAtlas(shoved, { prior, relaxEpochs: 40 });
      drifts.push(atlasDrift(prior, built.hyper.points).mean);
      prior = built.hyper.points;
    }
    // First build after the shove moves most; later rebuilds settle.
    expect(drifts[0]).toBeGreaterThan(drifts[drifts.length - 1]);
    // And the settled pipeline passes its own stop-loss.
    const verdict = stopLoss({ driftSeries: drifts });
    expect(verdict.triggered).toBe(false);
  });
});

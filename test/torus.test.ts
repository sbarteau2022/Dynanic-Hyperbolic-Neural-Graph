import { describe, it, expect } from 'vitest';
import {
  wrap, norm2pi, torusDist, phiScaleWeights,
  goldenSequence, windingNumbers, translationAlign,
  axisDiscrepancy, atlasDiscrepancy, nobility,
  phasesToTorus, torusMap, torusNeighbors,
  GOLDEN_ANGLE, TORUS_DIM,
} from '../src/core/torus';

const PHI = (1 + Math.sqrt(5)) / 2;
const TWO_PI = 2 * Math.PI;

describe('angle primitives', () => {
  it('norm2pi lands in [0, 2π)', () => {
    expect(norm2pi(-0.1)).toBeCloseTo(TWO_PI - 0.1, 9);
    expect(norm2pi(TWO_PI + 1)).toBeCloseTo(1, 9);
    expect(norm2pi(0)).toBe(0);
  });
  it('wrap gives a signed difference in (−π, π]', () => {
    expect(wrap(0)).toBe(0);
    expect(wrap(Math.PI)).toBeCloseTo(Math.PI, 9);
    expect(wrap(-Math.PI)).toBeCloseTo(Math.PI, 9);   // −π folds to +π
    expect(wrap(1.5 * Math.PI)).toBeCloseTo(-0.5 * Math.PI, 9);
    expect(wrap(TWO_PI + 0.3)).toBeCloseTo(0.3, 9);
  });
});

describe('torusDist', () => {
  it('is zero at coincidence and symmetric', () => {
    const a = [0.1, 1.0, 3.0], b = [2.0, 0.5, 6.0];
    expect(torusDist(a, a)).toBe(0);
    expect(torusDist(a, b)).toBeCloseTo(torusDist(b, a), 9);
  });
  it('respects wraparound — 0 and 2π−ε are close, not far', () => {
    const near = torusDist([0], [TWO_PI - 0.01]);
    const far = torusDist([0], [Math.PI]);
    expect(near).toBeLessThan(0.02);
    expect(far).toBeCloseTo(Math.PI, 6);
  });
  it('φ-scale weights down-weight finer axes', () => {
    const w = phiScaleWeights(8);
    expect(w[0]).toBeCloseTo(1, 9);
    expect(w[1]).toBeCloseTo(Math.pow(PHI, -0.5), 9);
    for (let i = 1; i < w.length; i++) expect(w[i]).toBeLessThan(w[i - 1]);
  });
});

describe('goldenSequence', () => {
  it('the 1-D sequence is the φ-orbit: N·D* ≈ 1 at Fibonacci N', () => {
    const seq = goldenSequence(610, 1);
    const nd = 610 * axisDiscrepancy(seq.map((p) => p[0]));
    expect(nd).toBeLessThan(1.05);
  });
  it('covers the torus far more uniformly than a clustered sequence', () => {
    const N = 300;
    const golden = goldenSequence(N, 1).map((p) => p[0]);
    const clustered = Array.from({ length: N }, (_, k) => (k / N) * 0.2); // all bunched in a fifth
    expect(axisDiscrepancy(golden)).toBeLessThan(axisDiscrepancy(clustered));
  });
  it('is deterministic and lands inside [0, 2π)', () => {
    const a = goldenSequence(50, 3), b = goldenSequence(50, 3);
    expect(a).toEqual(b);
    for (const p of a) for (const x of p) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(TWO_PI); }
  });
});

describe('windingNumbers', () => {
  it('counts one net turn for a sequence that goes once around an axis', () => {
    const seq = [[0], [Math.PI / 2], [Math.PI], [1.5 * Math.PI], [0.01]]; // ~ +2π
    const { winding, turns } = windingNumbers(seq);
    expect(winding[0]).toBe(1);
    expect(turns[0]).toBeGreaterThan(0.9);
  });
  it('reports zero winding for jitter that returns to start', () => {
    const seq = [[1.0], [1.1], [0.9], [1.05], [1.0]];
    expect(windingNumbers(seq).winding[0]).toBe(0);
  });
  it('handles multi-axis and degenerate input', () => {
    const w = windingNumbers([[0, 0], [Math.PI, 0]]);
    expect(w.winding.length).toBe(2);
    expect(windingNumbers([[1, 2]]).winding).toEqual([0, 0]);
  });
});

describe('translationAlign ("same note at different scales")', () => {
  it('recovers a constant global shift with score ≈ 1', () => {
    const a = [0.2, 1.0, 2.5, 4.0];
    const tau = 0.7;
    const b = a.map((x) => norm2pi(x - tau)); // a is b shifted by +tau
    const { shift, score } = translationAlign(a, b);
    expect(shift).toBeCloseTo(tau, 4);
    expect(score).toBeGreaterThan(0.999);
  });
  it('scores unrelated phase vectors low', () => {
    const a = [0.1, 3.0, 1.2, 5.5], b = [2.9, 0.4, 4.8, 1.1];
    expect(translationAlign(a, b).score).toBeLessThan(0.8);
  });
});

describe('nobility (φ vs rational)', () => {
  it('is maximal (≈ φ⁻²) for φ and lower for other irrationals', () => {
    expect(nobility(PHI - 1)).toBeCloseTo(Math.pow(PHI, -2), 3);
    expect(nobility(PHI - 1)).toBeGreaterThan(nobility(Math.SQRT2 - 1));
  });
  it('collapses toward 0 for rationals', () => {
    expect(nobility(0.5)).toBeLessThan(0.01);
    expect(nobility(1 / 3)).toBeLessThan(0.01);
  });
});

describe('phasesToTorus', () => {
  it('seats raw phases (−π,π] onto [0,2π), length TORUS_DIM', () => {
    const phases = [0.5, -1.0, 3.1, -3.0, 0, 2.2, -0.7, 1.9];
    const p = phasesToTorus(phases);
    expect(p.length).toBe(TORUS_DIM);
    expect(p[1]).toBeCloseTo(TWO_PI - 1.0, 6); // negative wraps up
    for (const x of p) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(TWO_PI); }
  });
  it('pads short / non-finite input with 0', () => {
    const p = phasesToTorus([1.0, NaN]);
    expect(p.length).toBe(TORUS_DIM);
    expect(p[1]).toBe(0);
    expect(p[7]).toBe(0);
  });
});

describe('torusMap', () => {
  it('seats phase-bearing nodes by their phases and bare nodes on the golden lattice', () => {
    const atlas = torusMap([
      { id: 'a', phases: [0.5, 1.0, 2.0, 3.0, 0.1, 0.2, 0.3, 0.4] },
      { id: 'b' },
      { id: 'c' },
    ]);
    expect(atlas.stats.placed).toBe(1);
    expect(atlas.stats.bare).toBe(2);
    expect(atlas.dim).toBe(TORUS_DIM);
    expect(atlas.points['a'][0]).toBeCloseTo(0.5, 6);
    for (const p of Object.values(atlas.points)) for (const x of p) expect(x).toBeLessThan(TWO_PI);
  });
  it('is deterministic and reports discrepancy stats', () => {
    const nodes = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}` }));
    const a1 = torusMap(nodes), a2 = torusMap(nodes);
    expect(a1.points).toEqual(a2.points);
    expect(a1.stats.discrepancy.mean).toBeGreaterThan(0);
    expect(a1.stats.discrepancy.per_axis.length).toBe(TORUS_DIM);
  });
});

describe('torusNeighbors', () => {
  it('ranks by torus distance and excludes the query id', () => {
    const atlas = torusMap([
      { id: 'q', phases: [0, 0, 0, 0, 0.1, 0, 0, 0] },
      { id: 'near', phases: [0.1, 0.1, 0, 0, 0.1, 0, 0, 0] },
      { id: 'far', phases: [3, 3, 3, 3, 3, 3, 3, 3] },
    ]);
    const nn = torusNeighbors(atlas, 'q', 2);
    expect(nn.map((n) => n.id)).not.toContain('q');
    expect(nn[0].id).toBe('near');
    expect(nn[0].dist).toBeLessThan(nn[1].dist);
  });
});

describe('GOLDEN_ANGLE', () => {
  it('is a full turn scaled by 2 − φ (≈137.5°)', () => {
    expect(GOLDEN_ANGLE).toBeCloseTo(TWO_PI * (2 - PHI), 9);
    expect((GOLDEN_ANGLE * 180) / Math.PI).toBeCloseTo(137.5077, 3);
  });
});

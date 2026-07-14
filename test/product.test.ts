import { describe, it, expect } from 'vitest';
import {
  productPairs, productDist, disagreements, resolveMix,
  recognitionInvariant, sameRecurrenceClass, metricReturn,
} from '../src/core/product';

describe('productPairs / productDist', () => {
  it('pairs only the shared node set into (depth, phase)', () => {
    const hyper = { a: [0, 0], b: [0.5, 0], c: [0.1, 0.1] };
    const torus = { a: [0, 0], b: [1, 1] }; // c missing from torus
    const pairs = productPairs(hyper, torus);
    expect(pairs.map((p) => p.id).sort()).toEqual(['a', 'b']);
    expect(pairs.find((p) => p.id === 'a')!.depth).toBe(0); // origin of the ball
    expect(pairs.find((p) => p.id === 'b')!.depth).toBeGreaterThan(0);
  });
  it('productDist combines both curvatures (adds the torus factor)', () => {
    const a = { ball: [0, 0], torus: [0, 0] }, b = { ball: [0.5, 0], torus: [2, 0] };
    const both = productDist(a, b, 1);
    const ballOnly = productDist(a, { ball: [0.5, 0], torus: [0, 0] }, 1);
    expect(both).toBeGreaterThan(ballOnly);
  });
  it('the curvature mix routes weight to the right factor', () => {
    const a = { ball: [0, 0], torus: [0, 0] }, b = { ball: [0.6, 0], torus: [2.5, 1] };
    // hyperbolic-only mix ⇒ pure ball distance; toroidal-only ⇒ pure torus distance
    const ballOnly = productDist(a, b, { hyperbolic: 1, toroidal: 0 });
    const torusOnly = productDist(a, b, { hyperbolic: 0, toroidal: 1 });
    expect(ballOnly).toBeCloseTo(productDist(a, { ball: b.ball, torus: a.torus }, { hyperbolic: 1, toroidal: 0 }), 9);
    expect(torusOnly).toBeCloseTo(productDist({ ball: a.ball, torus: a.torus }, { ball: a.ball, torus: b.torus }, { hyperbolic: 0, toroidal: 1 }), 9);
    expect(ballOnly).toBeGreaterThan(0);
    expect(torusOnly).toBeGreaterThan(0);
  });
});

describe('resolveMix (the mix is read off the graph)', () => {
  it('reads a hierarchy-leaning mix from a tree and a cycle-leaning mix from a dense graph', () => {
    const tree = [
      { src: 'r', dst: 'a' }, { src: 'r', dst: 'b' }, { src: 'a', dst: 'c' },
      { src: 'a', dst: 'd' }, { src: 'b', dst: 'e' }, { src: 'b', dst: 'f' },
    ];
    const cyclic = [
      { src: '0', dst: '1' }, { src: '1', dst: '2' }, { src: '2', dst: '3' },
      { src: '3', dst: '0' }, { src: '0', dst: '2' }, { src: '1', dst: '3' },
    ];
    const mT = resolveMix({ edges: tree }).mix;
    const mC = resolveMix({ edges: cyclic }).mix;
    expect(mT.hyperbolic).toBeGreaterThan(mT.toroidal);
    expect(mC.toroidal).toBeGreaterThan(mT.toroidal);
  });
  it('an explicit signature wins, and no input is equal weighting', () => {
    expect(resolveMix({ signature: { hyperbolic: 0.9, toroidal: 0.1 } }).mix).toEqual({ hyperbolic: 0.9, toroidal: 0.1 });
    expect(resolveMix({}).mix).toEqual({ hyperbolic: 1, toroidal: 1 });
  });
});

describe('disagreements (the reason to hold both charts)', () => {
  it('separates same-rhythm/different-lineage from same-lineage/drifted-phase', () => {
    // p–q: far in the ball, close on the torus  → same rhythm, different lineage
    // p–r: close in the ball, far on the torus  → same lineage, drifted phase
    const hyper = { p: [0, 0], q: [0.9, 0], r: [0.02, 0], s: [0.4, 0.4] };
    const torus = { p: [0, 0], q: [0.05, 0.05], r: [3, 3], s: [1.5, 1.5] };
    const d = disagreements(hyper, torus, { topK: 3 });
    const rhythmTop = d.same_rhythm_diff_lineage[0];
    const lineageTop = d.same_lineage_drift_phase[0];
    expect(new Set([rhythmTop.a, rhythmTop.b])).toEqual(new Set(['p', 'q']));
    expect(new Set([lineageTop.a, lineageTop.b])).toEqual(new Set(['p', 'r']));
  });
});

// ── the exact recognition invariant vs. asymptotic metric return ──────────
// The ball's fundamental group is trivial — it cannot certify "same identity
// across recurrence." The torus's winding number can, exactly, at every
// finite time, even where metric return only converges asymptotically.
describe('exact recognition invariant vs. metric return', () => {
  const drift = [[0], [0.3], [-0.2], [0.1], [0.0]]; // jitters, returns to start
  const loop = [[0], [2.0], [4.0], [6.0], [0.0]];   // goes once around, returns to start

  it('the invariant separates two trajectories that metric return cannot', () => {
    // Both come back to exactly the start — metric return is 0 for each.
    expect(metricReturn(drift)).toBe(0);
    expect(metricReturn(loop)).toBe(0);
    // Yet their identities differ exactly: drift wound 0 times, loop wound once.
    expect(recognitionInvariant(drift)).toEqual([0]);
    expect(recognitionInvariant(loop)).toEqual([1]);
    expect(sameRecurrenceClass(drift, loop)).toBe(false);
  });

  it('the invariant is an exact integer even on an irrational (φ) winding', () => {
    const PHI = (1 + Math.sqrt(5)) / 2;
    const ga = 2 * Math.PI * (2 - PHI); // golden angle
    const golden = Array.from({ length: 40 }, (_, k) => [(k * ga) % (2 * Math.PI)]);
    // Metric return is > 0 at finite N (asymptotic)…
    expect(metricReturn(golden)).toBeGreaterThan(0);
    // …while the winding invariant is a well-defined exact integer the whole time.
    const w = recognitionInvariant(golden);
    expect(w.length).toBe(1);
    expect(Number.isInteger(w[0])).toBe(true);
    expect(w[0]).toBe(15);
  });

  it('same trajectory ⇒ same recurrence class (reflexive, exact)', () => {
    expect(sameRecurrenceClass(loop, loop)).toBe(true);
  });
});

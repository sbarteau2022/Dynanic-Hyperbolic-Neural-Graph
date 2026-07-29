import { describe, it, expect } from 'vitest';
import { resonance, regulator, resonantDist, foldFactor } from '../src/core/resonance';
import { poincareDist } from '../src/core/hyper';
import { queryBridges } from '../src/core/bridge';
import { syntheticCorpus, groundTruthQueries } from '../src/core/bench';
import { hyperMap } from '../src/core/hyper';
import { torusMap } from '../src/core/torus';
import { resolveMix } from '../src/core/product';
import { asEdges } from '../src/core/structure';

describe('resonance (phase agreement)', () => {
  it('+1 phase-locked, −1 antiphase, ~0 unrelated', () => {
    const a = [0, 1, 2, 3];
    expect(resonance(a, a)).toBeCloseTo(1, 6);
    expect(resonance(a, a.map((x) => x + Math.PI))).toBeCloseTo(-1, 6);
    // quarter-turn apart on every axis → cos(π/2) = 0
    expect(resonance(a, a.map((x) => x + Math.PI / 2))).toBeCloseTo(0, 6);
  });

  it('wraps at the seam — 1° and 359° are kin, not opposites', () => {
    const deg = (d: number) => (d * Math.PI) / 180;
    expect(resonance([deg(1)], [deg(359)])).toBeGreaterThan(0.99);
  });

  it('transposed mode catches a rhythm shifted bodily, which direct coherence misses', () => {
    const a = [0, 0.4, 0.9, 1.5];
    const shifted = a.map((x) => x + 1.2);   // same signature, different origin
    expect(resonance(a, shifted)).toBeLessThan(0.5);
    expect(resonance(a, shifted, { transposed: true })).toBeGreaterThan(0.99);
  });
});

describe('regulator (the frequency gate)', () => {
  it('IS ONE-SIDED: neutral and clashing pairs keep their true distance', () => {
    // This is the property that separates a fold from a global rescale — a
    // two-sided gate would shrink every unrelated pair at r = 0.
    expect(regulator(0)).toBe(1);
    expect(regulator(-0.5)).toBe(1);
    expect(regulator(-1)).toBe(1);
  });

  it('collapses toward the floor as resonance approaches lock', () => {
    expect(regulator(1, { gain: 0.95, floor: 0.05 })).toBeCloseTo(0.05, 6);
    expect(regulator(0.9)).toBeLessThan(regulator(0.5));
    expect(regulator(0.5)).toBeLessThan(regulator(0.1));
  });

  it('never goes below the floor, however hard it is pushed', () => {
    for (const r of [0.9, 0.99, 1]) expect(regulator(r, { gain: 1, floor: 0.2 })).toBeGreaterThanOrEqual(0.2);
  });

  it('sharpness keeps the noise floor from opening spurious folds', () => {
    // Weak chance resonance should barely move with high sharpness.
    expect(regulator(0.3, { sharpness: 6 })).toBeGreaterThan(regulator(0.3, { sharpness: 1 }));
  });
});

describe('resonantDist (the routing score)', () => {
  const A = { ball: [0, 0], torus: [0, 0, 0, 0] };
  const far = { ball: [0.9, 0], torus: [0, 0, 0, 0] };          // far, phase-locked
  const farClash = { ball: [0.9, 0], torus: [Math.PI, Math.PI, Math.PI, Math.PI] };

  it('folds a distant but resonant pair, and leaves a clashing pair alone', () => {
    const raw = poincareDist(A.ball, far.ball);
    expect(resonantDist(A, far)).toBeLessThan(raw * 0.2);       // pinched together
    expect(resonantDist(A, farClash)).toBeCloseTo(raw, 4);      // untouched
  });

  it('never pushes a pair FARTHER than its true hyperbolic distance', () => {
    const pts = [[0, 0], [0.3, 0.1], [0.7, -0.2], [0.85, 0.4]];
    for (const p of pts) for (const q of pts) {
      const a = { ball: p, torus: [0.3, 1.1, 2.0, 0.5] };
      const b = { ball: q, torus: [1.9, 0.2, 2.7, 1.4] };
      expect(resonantDist(a, b)).toBeLessThanOrEqual(poincareDist(p, q) + 1e-9);
    }
  });

  it('IS NOT A METRIC — the triangle inequality genuinely fails (documented, not hidden)', () => {
    // a resonates with b, b with c, a clashes with c: the shortcut is not transitive.
    const lock = [0, 0, 0, 0], clash = [Math.PI, Math.PI, Math.PI, Math.PI];
    const a = { ball: [0, 0], torus: lock };
    const b = { ball: [0.6, 0], torus: lock };
    const c = { ball: [0.9, 0], torus: clash };
    const ab = resonantDist(a, b), bc = resonantDist(b, c), ac = resonantDist(a, c);
    expect(ac).toBeGreaterThan(ab + bc);
  });

  it('foldFactor reports how far a pair folded', () => {
    expect(foldFactor([0, 0], [0, 0])).toBeLessThan(0.1);   // locked
    expect(foldFactor([0, 0], [Math.PI, Math.PI])).toBe(1); // clashing
  });
});

describe('THE FIX: resonance survives the topological veto that zeroes the mix', () => {
  // A star corpus is a FOREST, so curvatureSignature gives toroidal = 0 exactly
  // and the product metric cannot see phase at all — the failure this module
  // exists to remove.
  const corpus = syntheticCorpus({ topology: 'star', alignment: 'crosscut', lineages: 6, perLineage: 6, topics: 4, seed: 1 });
  const edges = asEdges(corpus.edges);
  const hyper = hyperMap([], corpus.edges, { dim: 3, epochs: 300, seed: 42 }).points;
  const torus = torusMap(corpus.nodes.map((id) => ({ id, phases: corpus.phases[id] })), { dim: 8 }).points;
  const queries = groundTruthQueries(corpus.topics, { maxQueries: 24 });

  const onTopic = (opts: Parameters<typeof queryBridges>[3]) =>
    queries.reduce((acc, q) => {
      const bs = queryBridges(q.source, hyper, edges, opts);
      return acc + bs.filter((b) => corpus.topics[b.a] === corpus.topics[b.b]).length;
    }, 0);

  it('the graph-derived mix zeroes the torus on a forest', () => {
    expect(resolveMix({ edges }).mix).toEqual({ hyperbolic: 1, toroidal: 0 });
  });

  it('resonance scoring finds topic-mates the topology-mixed metric cannot', () => {
    const mixed = onTopic({ torusPoints: torus, scoring: 'product', mix: resolveMix({ edges }).mix, count: 3, minHops: 3, diversify: true });
    const res = onTopic({ torusPoints: torus, scoring: 'resonance', count: 3, minHops: 3, diversify: true });
    expect(res).toBeGreaterThan(3 * mixed);
    expect(res).toBeGreaterThan(0.9 * 72); // near-perfect precision on 24 queries × 3
  });

  it('and it collapses under the phase-permutation null', () => {
    const nulled = syntheticCorpus({ topology: 'star', alignment: 'crosscut', lineages: 6, perLineage: 6, topics: 4, seed: 1, shufflePhases: true });
    const nTorus = torusMap(nulled.nodes.map((id) => ({ id, phases: nulled.phases[id] })), { dim: 8 }).points;
    const nulledHits = queries.reduce((acc, q) => {
      const bs = queryBridges(q.source, hyper, edges, { torusPoints: nTorus, scoring: 'resonance', count: 3, minHops: 3, diversify: true });
      return acc + bs.filter((b) => nulled.topics[b.a] === nulled.topics[b.b]).length;
    }, 0);
    const signal = onTopic({ torusPoints: torus, scoring: 'resonance', count: 3, minHops: 3, diversify: true });
    expect(signal).toBeGreaterThan(3 * nulledHits);
  });

  it('bridges carry their fold factor under resonance scoring, and not otherwise', () => {
    const res = queryBridges(queries[0].source, hyper, edges, { torusPoints: torus, scoring: 'resonance', count: 2, minHops: 3 });
    expect(res.every((b) => typeof b.fold === 'number' && b.fold! <= 1)).toBe(true);
    const prod = queryBridges(queries[0].source, hyper, edges, { torusPoints: torus, scoring: 'product', count: 2, minHops: 3 });
    expect(prod.every((b) => !('fold' in b))).toBe(true);
  });
});

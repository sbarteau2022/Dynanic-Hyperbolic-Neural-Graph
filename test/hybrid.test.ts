import { describe, it, expect } from 'vitest';
import { syntheticCorpus, groundTruthQueries, runArmsPerQuery, randomQueryBridges } from '../src/core/bench';
import { queryBridges } from '../src/core/bridge';
import { hyperMap } from '../src/core/hyper';
import { torusMap } from '../src/core/torus';
import { asEdges } from '../src/core/structure';

// The exploration/exploitation hypothesis: resonance bridges tunnel (precision,
// depth) while random shortcuts expand (breadth), so a hybrid should beat
// either. Tested here and REFUTED — the recall gap that motivated it is a
// low-budget artifact, and above the crossover pure resonance dominates on
// both axes at once, with every random edge strictly costing.

function harness(topology: 'star' | 'ring') {
  const corpus = syntheticCorpus({ topology, alignment: 'crosscut', lineages: 6, perLineage: 6, topics: 4, seed: 1 });
  const edges = asEdges(corpus.edges);
  const hyper = hyperMap([], corpus.edges, { dim: 3, epochs: 300, seed: 42 }).points;
  const torus = torusMap(corpus.nodes.map((id) => ({ id, phases: corpus.phases[id] })), { dim: 8 }).points;
  const queries = groundTruthQueries(corpus.topics, { maxQueries: 24 });
  const run = (B: number, nRand: number) => {
    const nRes = B - nRand;
    const arms = runArmsPerQuery(edges, queries, {
      hybrid: (s) => {
        const res = nRes > 0
          ? queryBridges(s, hyper, edges, { torusPoints: torus, scoring: 'resonance', count: nRes, minHops: 3, diversify: true, minSep: 3 })
          : [];
        const used = new Set(res.map((b) => b.b));
        const rnd = nRand > 0
          ? randomQueryBridges(s, corpus.nodes, edges, nRand + used.size + 2, 7).filter((b) => !used.has(b.b)).slice(0, nRand)
          : [];
        return [...res.map((b) => ({ a: b.a, b: b.b })), ...rnd];
      },
    }, { budget: 4 });
    return arms[1].metrics;
  };
  return { run };
}

describe('the budget crossover (why the recall gap was not structural)', () => {
  for (const topology of ['star', 'ring'] as const) {
    it(`${topology}: random leads recall at a 3-edge budget, and loses it at 4`, () => {
      const h = harness(topology);
      const res3 = h.run(3, 0), rand3 = h.run(3, 3);
      const res4 = h.run(4, 0), rand4 = h.run(4, 4);
      expect(rand3.coverage).toBeGreaterThan(res3.coverage);   // the old "invariant"
      expect(res4.coverage).toBeGreaterThan(rand4.coverage);   // …inverts one edge later
    });

    it(`${topology}: resonance wins effective hops at EVERY budget, including where it loses recall`, () => {
      const h = harness(topology);
      for (const B of [1, 2, 3, 4, 6]) {
        expect(h.run(B, 0).effective_hops).toBeLessThan(h.run(B, B).effective_hops);
      }
    });

    it(`${topology}: above the crossover the advantage widens rather than saturating`, () => {
      const h = harness(topology);
      const gap = (B: number) => h.run(B, 0).coverage - h.run(B, B).coverage;
      expect(gap(6)).toBeGreaterThan(gap(4));
    });
  }
});

describe('THE HYBRID IS REFUTED at a sufficient budget', () => {
  for (const topology of ['star', 'ring'] as const) {
    it(`${topology}: at B=6 every random edge strictly costs both recall and hops`, () => {
      const h = harness(topology);
      const pure = h.run(6, 0);
      for (const nRand of [1, 2, 3, 6]) {
        const mixed = h.run(6, nRand);
        expect(mixed.coverage).toBeLessThan(pure.coverage);
        expect(mixed.effective_hops).toBeGreaterThan(pure.effective_hops);
      }
    });

    it(`${topology}: the Pareto frontier at B=6 is the single all-resonance point`, () => {
      const h = harness(topology);
      const pts = [0, 1, 2, 3, 4, 5, 6].map((r) => ({ r, m: h.run(6, r) }));
      const pure = pts.find((p) => p.r === 0)!;
      // Nothing else is >= on recall AND <= on hops, so nothing else survives.
      const nonDominated = pts.filter((p) => p.r !== 0 &&
        p.m.coverage >= pure.m.coverage && p.m.effective_hops <= pure.m.effective_hops);
      expect(nonDominated).toEqual([]);
    });
  }
});

describe('the shipped default sits above the crossover', () => {
  it('queryBridges defaults to 6 bridges per query', () => {
    const corpus = syntheticCorpus({ topology: 'ring', alignment: 'crosscut', lineages: 6, perLineage: 6, topics: 4, seed: 1 });
    const edges = asEdges(corpus.edges);
    const hyper = hyperMap([], corpus.edges, { dim: 3, epochs: 300, seed: 42 }).points;
    const torus = torusMap(corpus.nodes.map((id) => ({ id, phases: corpus.phases[id] })), { dim: 8 }).points;
    const source = groundTruthQueries(corpus.topics, { maxQueries: 24 })[0].source;
    // No `count` passed — the default is what is under test.
    const def = queryBridges(source, hyper, edges, { torusPoints: torus, scoring: 'resonance', minHops: 3, diversify: true, minSep: 3 });
    expect(def.length).toBe(6);
  });

  it('and the default beats the same budget spent on random shortcuts, on both axes', () => {
    for (const topology of ['star', 'ring'] as const) {
      const h = harness(topology);
      const res = h.run(6, 0), rnd = h.run(6, 6);
      expect(res.coverage).toBeGreaterThan(rnd.coverage);
      expect(res.effective_hops).toBeLessThan(rnd.effective_hops);
    }
  });
});

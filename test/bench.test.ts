import { describe, it, expect } from 'vitest';
import {
  syntheticCorpus, groundTruthQueries, randomBridges, hubBridges,
  runArms, runArmsPerQuery, randomQueryBridges, hubQueryBridges,
} from '../src/core/bench';
import { queryBridges } from '../src/core/bridge';
import { hyperMap } from '../src/core/hyper';
import { torusMap } from '../src/core/torus';
import { asEdges } from '../src/core/structure';

describe('syntheticCorpus (the planted ground truth)', () => {
  it('crosscut puts topic-mates in different lineages; aligned keeps them in one', () => {
    const cross = syntheticCorpus({ alignment: 'crosscut', lineages: 4, perLineage: 4, topics: 2 });
    // One topic per lineage, so "aligned" really means topic == lineage
    // (with fewer topics than lineages, several lineages must share one).
    const aligned = syntheticCorpus({ alignment: 'aligned', lineages: 4, perLineage: 4, topics: 4 });
    const lineage = (id: string) => id.split('_')[0];
    const mates = (c: typeof cross, n: string) => Object.keys(c.topics).filter((m) => m !== n && c.topics[m] === c.topics[n]);
    // crosscut: a node's topic-mates span several lineages
    expect(new Set(mates(cross, 'n0_0').map(lineage)).size).toBeGreaterThan(1);
    // aligned: they're all in its own lineage
    expect(new Set(mates(aligned, 'n0_0').map(lineage))).toEqual(new Set(['n0']));
  });

  it('topology switches the root wiring: star has a dominant hub, ring does not', () => {
    const star = syntheticCorpus({ topology: 'star', lineages: 5, perLineage: 3 });
    const ring = syntheticCorpus({ topology: 'ring', lineages: 5, perLineage: 3 });
    const degree = (c: typeof star, n: string) =>
      c.edges.filter((e) => e.src === n || e.dst === n).length;
    expect(degree(star, 'n0_0')).toBeGreaterThan(degree(ring, 'n0_0'));
    // Every ring root carries the same degree — no node dominates.
    const ringRootDegs = [0, 1, 2, 3, 4].map((l) => degree(ring, `n${l}_0`));
    expect(new Set(ringRootDegs).size).toBe(1);
  });

  it('phase encodes topic — and the permutation null destroys exactly that', () => {
    const signal = syntheticCorpus({ lineages: 4, perLineage: 4, topics: 2, phaseNoise: 0.1 });
    const nulled = syntheticCorpus({ lineages: 4, perLineage: 4, topics: 2, phaseNoise: 0.1, shufflePhases: true });
    const spread = (c: typeof signal) => {
      // mean |Δphase| on axis 0 between same-topic pairs; small ⇒ phase carries topic
      const ids = Object.keys(c.topics).sort();
      const pairs = ids.flatMap((a) => ids.filter((b) => b > a && c.topics[b] === c.topics[a]).map((b) => [a, b]));
      return pairs.reduce((s, [a, b]) => s + Math.abs(c.phases[a][0] - c.phases[b][0]), 0) / pairs.length;
    };
    expect(spread(signal)).toBeLessThan(spread(nulled));
    // The null keeps the graph and the labels identical — only phase moves.
    expect(nulled.topics).toEqual(signal.topics);
    expect(nulled.edges).toEqual(signal.edges);
  });

  it('is deterministic', () => {
    expect(syntheticCorpus({ seed: 3 })).toEqual(syntheticCorpus({ seed: 3 }));
  });
});

describe('groundTruthQueries', () => {
  it('relevant set is every topic-mate, and never the source itself', () => {
    const c = syntheticCorpus({ alignment: 'crosscut', lineages: 3, perLineage: 4, topics: 2 });
    for (const q of groundTruthQueries(c.topics)) {
      expect(q.targets).not.toContain(q.source);
      expect(q.targets.every((t) => c.topics[t] === c.topics[q.source])).toBe(true);
      const all = Object.keys(c.topics).filter((n) => n !== q.source && c.topics[n] === c.topics[q.source]);
      expect(q.targets.length).toBe(all.length); // full recall set, not a sample
    }
  });
});

describe('the control arms', () => {
  const c = syntheticCorpus({ lineages: 4, perLineage: 4 });
  const edges = asEdges(c.edges);

  it('random and hub controls never duplicate an existing edge', () => {
    const existing = new Set(edges.map((e) => (e.src < e.dst ? `${e.src} ${e.dst}` : `${e.dst} ${e.src}`)));
    const k = (b: { a: string; b: string }) => (b.a < b.b ? `${b.a} ${b.b}` : `${b.b} ${b.a}`);
    for (const b of randomBridges(c.nodes, edges, 6)) expect(existing.has(k(b))).toBe(false);
    for (const b of hubBridges(edges, 6)) expect(existing.has(k(b))).toBe(false);
    for (const b of randomQueryBridges('n1_2', c.nodes, edges, 4)) expect(existing.has(k(b))).toBe(false);
    for (const b of hubQueryBridges('n1_2', edges, 4)) expect(existing.has(k(b))).toBe(false);
  });

  it('per-query controls anchor every edge at the query source', () => {
    for (const b of randomQueryBridges('n1_2', c.nodes, edges, 4)) expect(b.a).toBe('n1_2');
    for (const b of hubQueryBridges('n1_2', edges, 4)) expect(b.a).toBe('n1_2');
  });

  it('controls are deterministic', () => {
    expect(randomBridges(c.nodes, edges, 5, 7)).toEqual(randomBridges(c.nodes, edges, 5, 7));
    expect(randomQueryBridges('n2_1', c.nodes, edges, 3, 7)).toEqual(randomQueryBridges('n2_1', c.nodes, edges, 3, 7));
  });
});

describe('the experiment (arms race on identical queries)', () => {
  const corpus = syntheticCorpus({ topology: 'ring', alignment: 'crosscut', lineages: 6, perLineage: 6, topics: 4, seed: 1 });
  const edges = asEdges(corpus.edges);
  const queries = groundTruthQueries(corpus.topics, { maxQueries: 24 });
  const hyper = hyperMap([], corpus.edges, { dim: 3, epochs: 300, seed: 42 }).points;
  const torus = torusMap(corpus.nodes.map((id) => ({ id, phases: corpus.phases[id] })), { dim: 8 }).points;
  const geo = (s: string) => queryBridges(s, hyper, edges, { torusPoints: torus, count: 3, minHops: 3, diversify: true }).map((b) => ({ a: b.a, b: b.b }));

  it('every arm is scored on the same queries and the same edge budget', () => {
    const arms = runArmsPerQuery(edges, queries, {
      geometry: geo,
      random: (s) => randomQueryBridges(s, corpus.nodes, edges, 3, 7),
    }, { budget: 4 });
    const [, g, r] = arms;
    expect(g.bridges).toBe(r.bridges);              // identical spend
    expect(g.metrics.targets).toBe(r.metrics.targets); // identical task
  });

  it('THE RESULT: geometry bridges reach relevant evidence in fewer effective hops than both controls', () => {
    const arms = runArmsPerQuery(edges, queries, {
      geometry: geo,
      random: (s) => randomQueryBridges(s, corpus.nodes, edges, 3, 7),
      hub: (s) => hubQueryBridges(s, edges, 3),
    }, { budget: 4 });
    const by = Object.fromEntries(arms.map((a) => [a.name, a.metrics]));
    expect(by.geometry.effective_hops).toBeLessThan(by.baseline.effective_hops);
    expect(by.geometry.effective_hops).toBeLessThan(by.random.effective_hops);
    expect(by.geometry.effective_hops).toBeLessThan(by.hub.effective_hops);
  });

  it('THE LIMIT, stated honestly: geometry does NOT beat random scattering on recall breadth', () => {
    const arms = runArmsPerQuery(edges, queries, {
      geometry: geo,
      random: (s) => randomQueryBridges(s, corpus.nodes, edges, 3, 7),
    }, { budget: 4 });
    const by = Object.fromEntries(arms.map((a) => [a.name, a.metrics]));
    expect(by.geometry.coverage).toBeGreaterThan(by.baseline.coverage);
    expect(by.geometry.coverage).toBeLessThan(by.random.coverage); // documented, not hidden
  });

  it('THE NULL: bridge precision collapses when phase no longer carries topic', () => {
    const nulled = syntheticCorpus({ topology: 'ring', alignment: 'crosscut', lineages: 6, perLineage: 6, topics: 4, seed: 1, shufflePhases: true });
    const nTorus = torusMap(nulled.nodes.map((id) => ({ id, phases: nulled.phases[id] })), { dim: 8 }).points;
    const onTopic = (pts: Record<string, number[]>, topics: Record<string, string>) =>
      queries.reduce((acc, q) => {
        const bs = queryBridges(q.source, hyper, edges, { torusPoints: pts, count: 3, minHops: 3, diversify: true });
        return acc + bs.filter((b) => topics[b.a] === topics[b.b]).length;
      }, 0);
    // Same graph, same labels, same embedding — only the phase signal differs.
    expect(onTopic(torus, corpus.topics)).toBeGreaterThan(2 * onTopic(nTorus, nulled.topics));
  });
});

describe('runArms (global scope) still works', () => {
  it('reports a baseline plus one row per supplied arm', () => {
    const c = syntheticCorpus({ lineages: 4, perLineage: 4 });
    const edges = asEdges(c.edges);
    const arms = runArms(edges, groundTruthQueries(c.topics), { hub: hubBridges(edges, 4) }, { budget: 4 });
    expect(arms.map((a) => a.name)).toEqual(['baseline', 'hub']);
    expect(arms[1].bridges).toBe(4);
  });
});

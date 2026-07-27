import { describe, it, expect } from 'vitest';
import {
  evidenceWalk, evidenceQueries, compareTraversal, contradictionExposure, bridgeReport,
} from '../src/core/metrics';
import { bridgeEdges } from '../src/core/bridge';
import { hyperMap } from '../src/core/hyper';
import type { Edge } from '../src/core/structure';
import type { MemEdge } from '../src/core/types';

// The same two-chain wormhole graph as bridge.test.ts.
const chains: Edge[] = [
  { src: 'u0', dst: 'u1' }, { src: 'u1', dst: 'u2' }, { src: 'u2', dst: 'u3' },
  { src: 'u0', dst: 'v0' },
  { src: 'v0', dst: 'v1' }, { src: 'v1', dst: 'v2' }, { src: 'v2', dst: 'v3' },
];
const planted: Record<string, number[]> = {
  u0: [0.0, 0.0], u1: [0.2, 0.0], u2: [0.4, 0.0], u3: [0.6, 0.0],
  v0: [0.0, 0.3], v1: [-0.3, 0.3], v2: [-0.55, 0.3], v3: [0.6, 0.02],
};

describe('evidenceWalk (the shared instrument)', () => {
  it('scores a plain BFS correctly: hops, coverage, and the miss penalty', () => {
    // From u3: v3 is 7 hops, v2 is 6 hops. Budget 4 reaches neither.
    const starved = evidenceWalk(chains, 'u3', ['v3', 'v2'], { budget: 4 });
    expect(starved.coverage).toBe(0);
    expect(starved.reached).toBe(0);
    expect(starved.effective_hops).toBe(5); // both charged budget+1
    // Budget 7 reaches both.
    const fed = evidenceWalk(chains, 'u3', ['v3', 'v2'], { budget: 7 });
    expect(fed.coverage).toBe(1);
    expect(fed.mean_hops).toBe(6.5);
    expect(fed.effective_hops).toBe(6.5);
  });

  it('a bridge collapses the path: same budget, full coverage, fewer expansions', () => {
    const bridged = evidenceWalk(chains, 'u3', ['v3', 'v2'], { budget: 4, bridges: [{ a: 'u3', b: 'v3' }] });
    expect(bridged.coverage).toBe(1);
    expect(bridged.mean_hops).toBe(1.5); // v3 at 1 hop, v2 at 2
    const baseline = evidenceWalk(chains, 'u3', ['v3', 'v2'], { budget: 7 });
    expect(bridged.expanded).toBeLessThan(baseline.expanded);
  });

  it('early-stops once every target is found', () => {
    const m = evidenceWalk(chains, 'u0', ['u1'], { budget: 6 });
    expect(m.coverage).toBe(1);
    expect(m.expanded).toBeLessThan(8); // did not sweep the whole graph
  });
});

describe('evidenceQueries (geometry names the evidence)', () => {
  it('targets are the geodesically nearest nodes, deterministically', () => {
    const qs = evidenceQueries(planted, { k: 1, maxQueries: 64 });
    const u3 = qs.find((q) => q.source === 'u3')!;
    expect(u3.targets).toEqual(['v3']); // the planted neighbor
    expect(evidenceQueries(planted, { k: 1, maxQueries: 64 })).toEqual(qs);
  });
});

describe('compareTraversal (the claim, measured)', () => {
  it('on the wormhole graph, bridging strictly improves coverage and effective hops', () => {
    const bridges = bridgeEdges(planted, chains, { maxBridges: 2 }).bridges;
    const queries = evidenceQueries(planted, { k: 2, maxQueries: 8 });
    const cmp = compareTraversal(chains, queries, bridges, { budget: 3 });
    expect(cmp.delta.coverage).toBeGreaterThan(0);
    expect(cmp.delta.effective_hops).toBeLessThan(0);
    expect(cmp.bridged.coverage).toBeGreaterThan(cmp.baseline.coverage);
  });
});

describe('contradictionExposure', () => {
  const mem: MemEdge[] = [
    ...chains.map((e): MemEdge => ({ ...e, kind: 'assoc', weight: 1 })),
    { src: 'u3', dst: 'v3', kind: 'contradicts', weight: 1 },
  ];
  it('a horizon too small to hold both sides scores low; a bridge raises it', () => {
    const base = contradictionExposure(mem, { budget: 3 });
    const brid = contradictionExposure(mem, { budget: 3, bridges: [{ a: 'u3', b: 'v3' }] });
    expect(base.pairs).toBe(1);
    expect(brid.rate).toBeGreaterThan(base.rate);
  });
  it('no contradiction pairs → rate 0, honestly labeled', () => {
    const none = contradictionExposure(chains.map((e): MemEdge => ({ ...e, kind: 'assoc', weight: 1 })));
    expect(none).toEqual({ rate: 0, pairs: 0, sources: 0 });
  });
});

describe('bridgeReport (end-to-end, on a real embedding)', () => {
  // The contradiction sits at u1–v1 so its own edge (which IS part of the
  // graph, conductance and all) doesn't collapse the u3–v3 wormhole to 1 hop.
  const mem: MemEdge[] = [
    ...chains.map((e): MemEdge => ({ ...e, kind: 'derived', weight: 1 })),
    { src: 'u1', dst: 'v1', kind: 'contradicts', weight: 0.8 },
  ];
  it('runs the whole pipeline off hyperMap output, deterministically', () => {
    const atlas = hyperMap([], mem, { dim: 2, epochs: 120, seed: 7 });
    const r1 = bridgeReport(atlas.points, mem, { budget: 3, k: 2, maxQueries: 8 });
    const r2 = bridgeReport(atlas.points, mem, { budget: 3, k: 2, maxQueries: 8 });
    expect(r1).toEqual(r2);
    expect(r1.traversal.queries).toBeGreaterThan(0);
    expect(r1.traversal.baseline.targets).toBeGreaterThan(0);
    expect(r1.contradictions.baseline.pairs).toBe(1);
    // The deltas are the deliverable — whatever their sign, they must be there.
    expect(typeof r1.traversal.delta.coverage).toBe('number');
    expect(typeof r1.contradictions.delta).toBe('number');
  });
  it('with the planted atlas, the report shows the bridge paying for itself', () => {
    const r = bridgeReport(planted, mem, { budget: 3, k: 2, maxQueries: 8 });
    expect(r.bridges.bridges.length).toBeGreaterThan(0);
    expect(r.traversal.delta.coverage).toBeGreaterThanOrEqual(0);
    expect(r.contradictions.bridged.rate).toBeGreaterThanOrEqual(r.contradictions.baseline.rate);
  });
});

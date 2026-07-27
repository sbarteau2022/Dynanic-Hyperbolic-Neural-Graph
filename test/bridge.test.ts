import { describe, it, expect } from 'vitest';
import { bridgeEdges } from '../src/core/bridge';
import type { Edge } from '../src/core/structure';

// Two chains joined only at the root — u3 and v3 are 7 hops apart on the
// graph, but the atlas (hand-planted here) puts them next to each other.
// That pair is the wormhole the bridge layer exists to find.
const chains: Edge[] = [
  { src: 'u0', dst: 'u1' }, { src: 'u1', dst: 'u2' }, { src: 'u2', dst: 'u3' },
  { src: 'u0', dst: 'v0' },
  { src: 'v0', dst: 'v1' }, { src: 'v1', dst: 'v2' }, { src: 'v2', dst: 'v3' },
];
const planted: Record<string, number[]> = {
  u0: [0.0, 0.0], u1: [0.2, 0.0], u2: [0.4, 0.0], u3: [0.6, 0.0],
  v0: [0.0, 0.3], v1: [-0.3, 0.3], v2: [-0.55, 0.3], v3: [0.6, 0.02], // v3 planted beside u3
};

describe('bridgeEdges (the wormhole finder)', () => {
  it('finds the geo-near / graph-far pair and reports its hop gain', () => {
    const set = bridgeEdges(planted, chains, { maxBridges: 2 });
    const top = set.bridges[0];
    expect(new Set([top.a, top.b])).toEqual(new Set(['u3', 'v3']));
    expect(top.hops).toBe(7);
    expect(top.gain).toBe(6); // 7 hops collapse to 1
    expect(set.considered).toBe(28); // C(8,2)
  });

  it('never bridges pairs that are already topologically close', () => {
    const set = bridgeEdges(planted, chains, { maxBridges: 64, quantile: 1 });
    for (const b of set.bridges) {
      const hops = b.hops === -1 ? Infinity : b.hops;
      expect(hops).toBeGreaterThanOrEqual(3); // default minHops
    }
  });

  it('bridges across disconnected components (hops −1, gain = node count − 1)', () => {
    const split: Edge[] = [
      { src: 'a0', dst: 'a1' },
      { src: 'b0', dst: 'b1' }, // second component, no path to a*
    ];
    const pts = { a0: [0.0, 0.0], a1: [0.3, 0.0], b0: [0.02, 0.02], b1: [-0.3, 0.0] };
    const set = bridgeEdges(pts, split, { quantile: 0.3, maxBridges: 4 });
    const cross = set.bridges.find((b) => new Set([b.a, b.b]).has('a0') && new Set([b.a, b.b]).has('b0'));
    expect(cross).toBeDefined();
    expect(cross!.hops).toBe(-1);
    expect(cross!.gain).toBe(3); // 4 nodes − 1
  });

  it('is deterministic and respects maxBridges', () => {
    const s1 = bridgeEdges(planted, chains, { maxBridges: 3 });
    const s2 = bridgeEdges(planted, chains, { maxBridges: 3 });
    expect(s1).toEqual(s2);
    expect(s1.bridges.length).toBeLessThanOrEqual(3);
  });

  it('ephemeral by construction: the input edge list is untouched', () => {
    const before = JSON.stringify(chains);
    bridgeEdges(planted, chains);
    expect(JSON.stringify(chains)).toBe(before);
  });
});

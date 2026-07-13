import { describe, it, expect } from 'vitest';
import { hyperMap, poincareDist, type MemEdge } from '../src/core/hyper';
import { temporalHyperMap, atlasDrift } from '../src/core/temporal';

const e = (src: string, dst: string, kind: MemEdge['kind'] = 'assoc', weight = 2): MemEdge => ({ src, dst, kind, weight });

// A base graph: a triangle a-b-c plus a chain c-d-e.
const G1: MemEdge[] = [e('a', 'b'), e('b', 'c'), e('c', 'a'), e('c', 'd'), e('d', 'e')];
// G2 adds a new node f hanging off a.
const G2: MemEdge[] = [...G1, e('a', 'f')];

describe('temporalHyperMap — coherence across an evolving graph', () => {
  it('warm-start drifts far less than a cold re-fit when the graph changes', () => {
    const A1 = hyperMap([], G1, { seed: 7 });
    const coldA2 = hyperMap([], G2, { seed: 7 });
    const warmA2 = temporalHyperMap([], G2, { prior: A1.points, dim: A1.dim, seed: 7 });

    const coldDrift = atlasDrift(A1.points, coldA2.points).mean; // cold re-fit moves everything (gauge + reposition)
    const warmDrift = warmA2.drift.mean;                          // frozen interior barely moves

    expect(warmDrift).toBeLessThan(coldDrift);
    expect(warmDrift).toBeLessThan(0.25); // near-zero: the stable interior is frozen
  });

  it('the frozen interior really is frozen (nodes off the change frontier do not move)', () => {
    const A1 = hyperMap([], G1, { seed: 7 });
    const warmA2 = temporalHyperMap([], G2, { prior: A1.points, dim: A1.dim, seed: 7 });
    // e is far from the change (f attached to a); it must be identical to the prior.
    expect(poincareDist(A1.points['e'], warmA2.points['e'])).toBeCloseTo(0, 9);
    expect(warmA2.new_nodes).toEqual(['f']);
  });

  it('a new node is born near its neighbors, not teleported from a hash', () => {
    const A1 = hyperMap([], G1, { seed: 7 });
    const warmA2 = temporalHyperMap([], G2, { prior: A1.points, dim: A1.dim, seed: 7 });
    // f attaches only to a → it should sit closer to a than to a far node like e.
    const dfa = poincareDist(warmA2.points['f'], warmA2.points['a']);
    const dfe = poincareDist(warmA2.points['f'], warmA2.points['e']);
    expect(dfa).toBeLessThan(dfe);
  });

  it('is deterministic — same inputs, same atlas', () => {
    const A1 = hyperMap([], G1, { seed: 7 });
    const w1 = temporalHyperMap([], G2, { prior: A1.points, dim: A1.dim, seed: 7 });
    const w2 = temporalHyperMap([], G2, { prior: A1.points, dim: A1.dim, seed: 7 });
    expect(w1.points).toEqual(w2.points);
  });

  it('with no prior it behaves as a cold build (everything active)', () => {
    const a = temporalHyperMap([], G1, { seed: 7 });
    expect(a.new_nodes.sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(a.active).toBe(5);
    expect(a.drift).toEqual({ mean: 0, max: 0, moved: 0 });
  });

  it('an explicit changedNodes frontier confines motion to it (+ neighbors)', () => {
    const A1 = hyperMap([], G1, { seed: 7 });
    // Nothing structurally new, but declare c changed → only c and its neighbors move.
    const warm = temporalHyperMap([], G1, { prior: A1.points, dim: A1.dim, seed: 7, changedNodes: ['c'] });
    expect(poincareDist(A1.points['e'], warm.points['e'])).toBeCloseTo(0, 9); // e not adjacent to c
    expect(warm.active).toBeLessThan(5);
  });
});

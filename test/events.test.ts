import { describe, it, expect } from 'vitest';
import { edgesFromEvents, type MemEvent } from '../src/core/events';

const ev = (src: string, dst: string, ts: number, kind: MemEvent['kind'] = 'assoc', weight = 1): MemEvent =>
  ({ kind, src, dst, weight, ts });

describe('edgesFromEvents (captured-resonance hygiene)', () => {
  it('folds repeat occurrences of the same pair into one edge', () => {
    const edges = edgesFromEvents([ev('a', 'b', 1), ev('a', 'b', 2), ev('a', 'b', 3)]);
    expect(edges.length).toBe(1);
    expect(edges[0]).toMatchObject({ src: 'a', dst: 'b', kind: 'assoc' });
  });

  it('a single occurrence keeps its raw weight', () => {
    const edges = edgesFromEvents([ev('a', 'b', 1, 'assoc', 0.8)]);
    expect(edges[0].weight).toBeCloseTo(0.8, 6);
  });

  it('repeat occurrences converge to a bounded weight (φ⁻ⁿ decay), not runaway growth', () => {
    const at = (n: number) => edgesFromEvents(Array.from({ length: n }, (_, i) => ev('a', 'b', i)))[0].weight;
    // Growth from 3→20 occurrences is real (the series hasn't converged yet)…
    expect(at(20) - at(3)).toBeGreaterThan(0.1);
    // …but from 20→50 it has: φ⁻²⁰ is negligible, so more repeats stop mattering.
    expect(at(50) - at(20)).toBeLessThan(1e-3);
    expect(at(50)).toBeLessThanOrEqual(5); // MAX_WEIGHT cap
  });

  it('distinct (src,dst,kind) triples stay separate edges', () => {
    const edges = edgesFromEvents([ev('a', 'b', 1, 'assoc'), ev('a', 'b', 2, 'causal')]);
    expect(edges.length).toBe(2);
  });

  it('is order-independent (sorts by ts internally before folding)', () => {
    const forward = edgesFromEvents([ev('a', 'b', 1), ev('a', 'b', 2), ev('a', 'b', 3)]);
    const shuffled = edgesFromEvents([ev('a', 'b', 3), ev('a', 'b', 1), ev('a', 'b', 2)]);
    expect(forward[0].weight).toBeCloseTo(shuffled[0].weight, 9);
  });

  it('drops self-loops and malformed events', () => {
    expect(edgesFromEvents([ev('a', 'a', 1)])).toEqual([]);
    expect(edgesFromEvents([{ kind: 'assoc', src: '', dst: 'b' } as MemEvent])).toEqual([]);
  });
});

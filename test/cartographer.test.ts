import { describe, it, expect } from 'vitest';
import { buildAtlas } from '../src/cartographer';
import { atlasDrift } from '../src/core/temporal';
import type { MemEvent } from '../src/core/events';

const ev = (src: string, dst: string, ts: number, kind: MemEvent['kind'] = 'assoc'): MemEvent => ({ kind, src, dst, weight: 1, ts });

const CYCLE: MemEvent[] = [
  ev('a', 'b', 1), ev('b', 'c', 2), ev('c', 'd', 3), ev('d', 'a', 4), // a 4-cycle
];

describe('buildAtlas (the full device pipeline)', () => {
  it('folds events into edges and runs every geometry core over them', () => {
    const atlas = buildAtlas(CYCLE, { epochs: 100 });
    expect(atlas.nodes.sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(atlas.edges.length).toBe(4);
    expect(atlas.structure.invariants.cycle_rank).toBe(1);   // one independent cycle
    expect(atlas.structure.cycle_edges.length).toBe(4);      // every edge lies on the cycle
    expect(Object.keys(atlas.hyper.points).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(Object.keys(atlas.torus.points).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(atlas.product.mix.hyperbolic + atlas.product.mix.toroidal).toBeCloseTo(1, 6);
    expect(atlas.temporal).toBe(false);
  });

  it('is deterministic — same events, same opts, identical atlas', () => {
    const a1 = buildAtlas(CYCLE, { epochs: 80, seed: 7 });
    const a2 = buildAtlas(CYCLE, { epochs: 80, seed: 7 });
    expect(a1.hyper.points).toEqual(a2.hyper.points);
    expect(a1.torus.points).toEqual(a2.torus.points);
  });

  it('gives 3-D hyper points by default (directly renderable)', () => {
    const atlas = buildAtlas(CYCLE, { epochs: 50 });
    for (const p of Object.values(atlas.hyper.points)) expect(p.length).toBe(3);
  });

  it('warm-starts from a prior build when given one, with near-zero drift on unchanged structure', () => {
    const cold = buildAtlas(CYCLE, { epochs: 300, seed: 3 });
    const warm = buildAtlas(CYCLE, { prior: cold.hyper.points, relaxEpochs: 40 });
    expect(warm.temporal).toBe(true);
    const drift = atlasDrift(cold.hyper.points, warm.hyper.points);
    expect(drift.mean).toBeLessThan(0.05);
  });

  it('a graph with no edges yields an empty, well-formed atlas', () => {
    const atlas = buildAtlas([]);
    expect(atlas.nodes).toEqual([]);
    expect(atlas.edges).toEqual([]);
    expect(atlas.structure.invariants.cycle_rank).toBe(0);
  });
});

import { describe, it, expect } from 'vitest';
import { nodePhasesFromEvents, phaseScales } from '../src/core/phases';
import { buildAtlas } from '../src/cartographer';
import { torusDist, phiScaleWeights, TORUS_DIM } from '../src/core/torus';
import type { MemEvent } from '../src/core/events';

const PHI = (1 + Math.sqrt(5)) / 2;
const ev = (src: string, dst: string, ts: number): MemEvent => ({ kind: 'assoc', src, dst, weight: 1, ts });

// A node recalled at regular interval `step` starting at `offset`, always
// against a throwaway partner (partners are unique so only the node under
// test accumulates rhythm).
function rhythmic(id: string, step: number, offset: number, n: number, tag = ''): MemEvent[] {
  return Array.from({ length: n }, (_, i) => ev(id, `_${id}${tag}${i}`, offset + i * step));
}

describe('phaseScales', () => {
  it('spaces the 8 scales by φ', () => {
    const s = phaseScales();
    expect(s.length).toBe(TORUS_DIM);
    for (let k = 1; k < s.length; k++) expect(s[k] / s[k - 1]).toBeCloseTo(PHI, 9);
  });
});

describe('nodePhasesFromEvents', () => {
  it('is deterministic and lands in (−π, π]', () => {
    const events = [...rhythmic('a', 100, 0, 30), ...rhythmic('b', 170, 35, 20)];
    const p1 = nodePhasesFromEvents(events);
    const p2 = nodePhasesFromEvents(events);
    expect(p1).toEqual(p2);
    for (const phases of Object.values(p1)) {
      expect(phases.length).toBe(TORUS_DIM);
      for (const v of phases) { expect(v).toBeGreaterThan(-Math.PI - 1e-9); expect(v).toBeLessThanOrEqual(Math.PI + 1e-9); }
    }
  });

  it('two nodes recalled in the SAME cadence get closer signatures than a node on a different rhythm', () => {
    // a and b share period and alignment; c fires on a very different cadence.
    const events = [
      ...rhythmic('a', 100, 0, 40, 'x'),
      ...rhythmic('b', 100, 0, 40, 'y'),
      ...rhythmic('c', 317, 50, 13, 'z'),
    ];
    const p = nodePhasesFromEvents(events);
    expect(p.a && p.b && p.c).toBeTruthy();
    const w = phiScaleWeights(TORUS_DIM);
    const same = torusDist(p.a, p.b, w);
    const diff = torusDist(p.a, p.c, w);
    expect(same).toBeLessThan(diff);
  });

  it('gives no signature to nodes without enough signal (they keep the golden-lattice seat)', () => {
    const events = [...rhythmic('a', 100, 0, 30), ev('lone', 'other', 500)];
    const p = nodePhasesFromEvents(events);
    expect(p['lone']).toBeUndefined();   // one event = no rhythm
    expect(p['a']).toBeDefined();
  });

  it('returns nothing for an empty or instantaneous log', () => {
    expect(nodePhasesFromEvents([])).toEqual({});
    expect(nodePhasesFromEvents([ev('a', 'b', 5), ev('a', 'c', 5)])).toEqual({});
  });
});

describe('buildAtlas with event-derived phases', () => {
  it('rhythmic nodes are placed by their own phases; sparse ones fall back to the lattice', () => {
    const events = [
      ...rhythmic('a', 100, 0, 30),
      ...rhythmic('b', 130, 10, 25),
      ev('a', 'b', 3000),                  // connect the rhythm carriers
    ];
    const atlas = buildAtlas(events, { epochs: 50 });
    // The throwaway partners each appear once → bare → golden lattice.
    expect(atlas.torus.stats.placed).toBeGreaterThanOrEqual(2);
    expect(atlas.torus.stats.bare).toBeGreaterThan(0);
  });

  it('explicit nodePhases still override the derived ones', () => {
    const events = [...rhythmic('a', 100, 0, 20), ev('a', 'b', 2100)];
    const forced = { a: [1, 1, 1, 1, 1, 1, 1, 1] };
    const atlas = buildAtlas(events, { epochs: 30, nodePhases: forced });
    expect(atlas.torus.points['a'][0]).toBeCloseTo(1, 6);
  });

  it('stays deterministic end to end with derived phases', () => {
    const events = [...rhythmic('a', 100, 0, 25), ...rhythmic('b', 150, 30, 18), ev('a', 'b', 2900)];
    const a1 = buildAtlas(events, { epochs: 60, seed: 9 });
    const a2 = buildAtlas(events, { epochs: 60, seed: 9 });
    expect(a1.torus.points).toEqual(a2.torus.points);
    expect(a1.hyper.points).toEqual(a2.hyper.points);
  });
});

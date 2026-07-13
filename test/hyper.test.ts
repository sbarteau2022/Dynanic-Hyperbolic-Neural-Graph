import { describe, it, expect } from 'vitest';
import { poincareDist, depth, hyperMap, hyperNeighbors, norm, type MemEdge } from '../src/core/hyper';

const e = (src: string, dst: string, kind: MemEdge['kind'] = 'assoc', weight = 2): MemEdge => ({ src, dst, kind, weight });

describe('hyper core (smoke — full suite lives in elle-worker)', () => {
  it('distance from origin is 2·atanh‖x‖', () => {
    expect(poincareDist([0, 0], [0.5, 0])).toBeCloseTo(2 * Math.atanh(0.5), 9);
    expect(depth([0.5, 0])).toBeCloseTo(2 * Math.atanh(0.5), 9);
  });

  it('embeds a graph inside the ball, deterministically', () => {
    const edges = [e('a', 'b'), e('b', 'c'), e('c', 'a')];
    const a1 = hyperMap([], edges, { seed: 1 });
    const a2 = hyperMap([], edges, { seed: 1 });
    expect(a1.points).toEqual(a2.points);
    for (const p of Object.values(a1.points)) expect(norm(p)).toBeLessThan(1);
  });

  it('provenance chains gain depth (consequent deeper than antecedent)', () => {
    const atlas = hyperMap([], [e('root', 'mid', 'derived'), e('mid', 'leaf', 'derived')], { epochs: 400 });
    expect(depth(atlas.points['mid'])).toBeGreaterThan(depth(atlas.points['root']));
    expect(depth(atlas.points['leaf'])).toBeGreaterThan(depth(atlas.points['mid']));
  });

  it('neighbors rank by geodesic distance', () => {
    const atlas = hyperMap([], [e('a', 'b', 'assoc', 3), e('a', 'c', 'assoc', 0.2)], { epochs: 200 });
    const nn = hyperNeighbors(atlas, 'a', 2);
    expect(nn.map((n) => n.id)).not.toContain('a');
    for (let i = 1; i < nn.length; i++) expect(nn[i].dist).toBeGreaterThanOrEqual(nn[i - 1].dist);
  });
});

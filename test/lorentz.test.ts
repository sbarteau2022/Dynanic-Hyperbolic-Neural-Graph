import { describe, it, expect } from 'vitest';
import { poincareDist } from '../src/core/hyper';
import {
  minkowskiDot, lorentzDist, projectToHyperboloid,
  poincareToLorentz, lorentzToPoincare,
} from '../src/core/lorentz';

describe('lorentz / hyperboloid model', () => {
  it('minkowski inner product has the (−,+,+,…) signature', () => {
    expect(minkowskiDot([1, 0, 0], [1, 0, 0])).toBe(-1);
    expect(minkowskiDot([0, 1, 0], [0, 1, 0])).toBe(1);
  });

  it('poincareToLorentz lands exactly on the sheet ⟨x,x⟩_M = −1', () => {
    for (const p of [[0, 0], [0.3, -0.4], [0.6, 0.1], [-0.2, 0.7]]) {
      const x = poincareToLorentz(p);
      expect(minkowskiDot(x, x)).toBeCloseTo(-1, 9);
      expect(x[0]).toBeGreaterThan(0); // upper sheet
    }
  });

  it('lorentz distance equals Poincaré distance after conversion (same space)', () => {
    const p = [0.2, -0.3], q = [-0.5, 0.1];
    expect(lorentzDist(poincareToLorentz(p), poincareToLorentz(q))).toBeCloseTo(poincareDist(p, q), 6);
  });

  it('poincaré → lorentz → poincaré round-trips', () => {
    const p = [0.55, -0.12, 0.3];
    const back = lorentzToPoincare(poincareToLorentz(p));
    for (let i = 0; i < p.length; i++) expect(back[i]).toBeCloseTo(p[i], 9);
  });

  it('projectToHyperboloid snaps spatial coords onto the sheet', () => {
    const x = projectToHyperboloid([2, -1, 0.5]);
    expect(minkowskiDot(x, x)).toBeCloseTo(-1, 9);
  });
});

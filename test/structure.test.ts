import { describe, it, expect } from 'vitest';
import {
  graphInvariants, cycleBasis, homologyClass, sameRecurrenceClass,
  deltaHyperbolicity, curvatureSignature, nonBridgeEdges, edgeKey, asEdges, type Edge,
} from '../src/core/structure';
import type { MemEdge } from '../src/core/types';

const E = (src: string, dst: string): Edge => ({ src, dst });

describe('graphInvariants (b₁ = E − V + C)', () => {
  it('a tree has cycle rank 0', () => {
    const inv = graphInvariants([E('a', 'b'), E('b', 'c'), E('c', 'd'), E('d', 'e')]);
    expect(inv).toMatchObject({ nodes: 5, edges: 4, components: 1, cycle_rank: 0 });
  });
  it('a 4-cycle has cycle rank 1', () => {
    const inv = graphInvariants([E('0', '1'), E('1', '2'), E('2', '3'), E('3', '0')]);
    expect(inv).toMatchObject({ nodes: 4, edges: 4, components: 1, cycle_rank: 1 });
  });
  it('two disjoint triangles: b₁ = 2, C = 2', () => {
    const inv = graphInvariants([E('a', 'b'), E('b', 'c'), E('c', 'a'), E('x', 'y'), E('y', 'z'), E('z', 'x')]);
    expect(inv).toMatchObject({ components: 2, cycle_rank: 2 });
  });
  it('dedupes undirected duplicates and ignores self-loops', () => {
    const inv = graphInvariants([E('a', 'b'), E('b', 'a'), E('a', 'a')]);
    expect(inv.edges).toBe(1);
    expect(inv.cycle_rank).toBe(0);
  });
});

describe('cycleBasis', () => {
  it('produces exactly b₁ chords', () => {
    const edges = [E('0', '1'), E('1', '2'), E('2', '3'), E('3', '0'), E('0', '2')]; // K4-minus, b1=2
    const cb = cycleBasis(edges);
    expect(cb.chords.length).toBe(graphInvariants(edges).cycle_rank);
    expect(cb.chords.length).toBe(2);
  });
});

// ── the graph-native recognition invariant (the object the torus represents) ──
describe('homologyClass (recognition without embedding)', () => {
  const square: Edge[] = [E('0', '1'), E('1', '2'), E('2', '3'), E('3', '0')]; // one cycle, one chord

  it('a walk that closes the cycle has a nonzero class; a there-and-back walk does not', () => {
    const loop = ['0', '1', '2', '3', '0'];       // once around
    const drift = ['0', '1', '2', '1', '0'];      // out and back, no net cycle
    const cls = homologyClass(loop, square);
    expect(cls.length).toBe(1);
    expect(cls[0]).not.toBe(0);                   // crossed the chord once
    expect(homologyClass(drift, square)).toEqual([0]);
    expect(sameRecurrenceClass(loop, drift, square)).toBe(false);
  });

  it('is exact and integer, and orientation-signed (reverse ⇒ negated)', () => {
    const fwd = homologyClass(['0', '1', '2', '3', '0'], square);
    const rev = homologyClass(['0', '3', '2', '1', '0'], square);
    expect(Number.isInteger(fwd[0])).toBe(true);
    expect(rev[0]).toBe(-fwd[0]);
  });

  it('twice around counts twice (the discrete ledger of recurrence)', () => {
    const once = homologyClass(['0', '1', '2', '3', '0'], square);
    const twice = homologyClass(['0', '1', '2', '3', '0', '1', '2', '3', '0'], square);
    expect(Math.abs(twice[0])).toBe(2 * Math.abs(once[0]));
  });
});

describe('nonBridgeEdges (which edges lie on a cycle)', () => {
  const k = edgeKey;

  it('a triangle: every edge is on the cycle', () => {
    const s = nonBridgeEdges([E('a', 'b'), E('b', 'c'), E('c', 'a')]);
    expect(s.size).toBe(3);
    expect(s.has(k('a', 'b'))).toBe(true);
  });
  it('a path: no edge is on a cycle (all bridges)', () => {
    expect(nonBridgeEdges([E('a', 'b'), E('b', 'c'), E('c', 'd')]).size).toBe(0);
  });
  it('a lollipop: triangle edges on the cycle, the tail is a bridge', () => {
    const s = nonBridgeEdges([E('a', 'b'), E('b', 'c'), E('c', 'a'), E('a', 'tail')]);
    expect(s.size).toBe(3);
    expect(s.has(k('a', 'tail'))).toBe(false);
  });
  it('two triangles joined by an edge: the joining edge is the only bridge', () => {
    const edges = [
      E('a', 'b'), E('b', 'c'), E('c', 'a'),   // triangle 1
      E('x', 'y'), E('y', 'z'), E('z', 'x'),   // triangle 2
      E('a', 'x'),                              // bridge
    ];
    const s = nonBridgeEdges(edges);
    expect(s.size).toBe(6);
    expect(s.has(k('a', 'x'))).toBe(false);
  });
  it('is empty for a graph with no edges', () => {
    expect(nonBridgeEdges([]).size).toBe(0);
  });
});

describe('deltaHyperbolicity', () => {
  it('is 0 for a tree and > 0 for a cycle', () => {
    expect(deltaHyperbolicity([E('a', 'b'), E('b', 'c'), E('c', 'd'), E('d', 'e')])).toBe(0);
    expect(deltaHyperbolicity([E('0', '1'), E('1', '2'), E('2', '3'), E('3', '0')])).toBeGreaterThan(0);
  });
});

describe('curvatureSignature (charts read off the graph, not imposed)', () => {
  it('a tree leans hyperbolic; a dense cyclic graph leans toroidal', () => {
    const tree = [E('r', 'a'), E('r', 'b'), E('a', 'c'), E('a', 'd'), E('b', 'e'), E('b', 'f')];
    const cyclic = [E('0', '1'), E('1', '2'), E('2', '3'), E('3', '0'), E('0', '2'), E('1', '3')];
    const sT = curvatureSignature(tree), sC = curvatureSignature(cyclic);
    expect(sT.delta).toBe(0);
    expect(sT.suggested.hyperbolic).toBeGreaterThan(sT.suggested.toroidal);
    expect(sC.suggested.toroidal).toBeGreaterThan(sT.suggested.toroidal);
  });
  it('disambiguates a clique from a tree — both are δ=0, only the clique is cyclic', () => {
    // K4 is 0-hyperbolic (δ=0) like a tree, but maximally cyclic (b₁=3). The
    // signature must not read it as hierarchical just because δ=0.
    const k4 = [E('0', '1'), E('0', '2'), E('0', '3'), E('1', '2'), E('1', '3'), E('2', '3')];
    const sig = curvatureSignature(k4);
    expect(sig.delta).toBe(0);
    expect(sig.cycle_rank).toBe(3);
    expect(sig.suggested.toroidal).toBeGreaterThan(sig.suggested.hyperbolic);
  });
  it('a forest can never read cyclic (toroidal pull is exactly 0)', () => {
    const forest = [E('a', 'b'), E('b', 'c'), E('x', 'y')];
    expect(curvatureSignature(forest).suggested.toroidal).toBe(0);
  });
});

describe('asEdges', () => {
  it('projects MemEdge[] onto the structural edge list', () => {
    const mem: MemEdge[] = [{ src: 'a', dst: 'b', kind: 'assoc', weight: 2 }];
    expect(asEdges(mem)).toEqual([{ src: 'a', dst: 'b' }]);
  });
});

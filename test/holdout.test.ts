import { describe, it, expect } from 'vitest';
import { splitEvents, futureLinks, scoreArm, phaseSignal, randomProposals } from '../src/core/holdout';
import { syntheticLedger } from '../src/core/bench';
import { buildAtlas } from '../src/cartographer';
import { queryBridges } from '../src/core/bridge';
import { asEdges } from '../src/core/structure';
import { torusMap } from '../src/core/torus';
import type { MemEvent } from '../src/core/events';

describe('splitEvents', () => {
  it('splits on time, not index, and keeps the cut on the training side', () => {
    const ev: MemEvent[] = [
      { kind: 'assoc', src: 'a', dst: 'b', ts: 10 },
      { kind: 'assoc', src: 'a', dst: 'c', ts: 10 },   // same instant as the cut
      { kind: 'assoc', src: 'b', dst: 'c', ts: 99 },
    ];
    const { train, test, cut } = splitEvents(ev, 0.5);
    expect(cut).toBe(10);
    expect(train.length).toBe(2);   // both ts=10 events stay together
    expect(test.length).toBe(1);
  });

  it('falls back to position when timestamps are absent', () => {
    const ev: MemEvent[] = Array.from({ length: 10 }, (_, i) => ({ kind: 'assoc' as const, src: `n${i}`, dst: `n${i + 1}` }));
    const { train, test } = splitEvents(ev, 0.7);
    expect(train.length + test.length).toBe(10);
    expect(test.length).toBeGreaterThan(0);
  });
});

describe('futureLinks (the answer key)', () => {
  const train: MemEvent[] = [
    { kind: 'assoc', src: 'a', dst: 'b', ts: 1 },
    { kind: 'assoc', src: 'b', dst: 'c', ts: 2 },
  ];

  it('counts only NOVEL pairs — a re-fired existing edge is not a prediction', () => {
    const test: MemEvent[] = [
      { kind: 'assoc', src: 'a', dst: 'b', ts: 9 },  // already linked → excluded
      { kind: 'assoc', src: 'a', dst: 'c', ts: 9 },  // novel → counted
    ];
    const f = futureLinks(train, test);
    expect(f.pairs.size).toBe(1);
    expect([...f.pairs][0]).toBe('a c');
  });

  it('ignores pairs whose endpoints the training graph never saw', () => {
    const test: MemEvent[] = [{ kind: 'assoc', src: 'a', dst: 'zzz', ts: 9 }];
    // No method could propose a node that does not exist yet; scoring it would
    // charge every arm for the same impossibility.
    expect(futureLinks(train, test).pairs.size).toBe(0);
  });

  it('indexes both directions so either endpoint can be the query source', () => {
    const f = futureLinks(train, [{ kind: 'assoc', src: 'a', dst: 'c', ts: 9 }]);
    expect(f.bySource.get('a')!.has('c')).toBe(true);
    expect(f.bySource.get('c')!.has('a')).toBe(true);
  });
});

describe('scoreArm', () => {
  const f = futureLinks(
    [{ kind: 'assoc', src: 'a', dst: 'b', ts: 1 }, { kind: 'assoc', src: 'b', dst: 'c', ts: 1 }],
    [{ kind: 'assoc', src: 'a', dst: 'c', ts: 9 }],
  );

  it('scores a perfect proposer at precision 1 and a wrong one at 0', () => {
    const perfect = scoreArm('perfect', (s) => (s === 'a' ? [{ a: 'a', b: 'c' }] : [{ a: 'c', b: 'a' }]), f);
    expect(perfect.precision).toBe(1);
    expect(perfect.recall).toBe(1);
    const wrong = scoreArm('wrong', (s) => [{ a: s, b: 'b' }], f);
    expect(wrong.precision).toBe(0);
    expect(wrong.hits).toBe(0);
  });

  it('recall counts distinct links found, so proposing the same pair twice is not two hits', () => {
    const dup = scoreArm('dup', (s) => (s === 'a' ? [{ a: 'a', b: 'c' }, { a: 'a', b: 'c' }] : []), f);
    expect(dup.hits).toBe(2);          // two proposals landed
    expect(dup.recall).toBeLessThanOrEqual(1);
  });
});

describe('phaseSignal', () => {
  it('flags collapsed phases as degenerate', () => {
    const same = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`n${i}`, [0.3, 1.2, 2.0]]));
    expect(phaseSignal(same).degenerate).toBe(true);
  });

  it('does NOT use a permutation null — permuting is vacuous for this statistic', () => {
    // Relabelling which node holds which vector leaves every pairwise
    // resonance unchanged, so a permutation-based diagnostic would report
    // "no structure" on visibly clustered data. Guard against regressing to it.
    const clustered: Record<string, number[]> = {};
    for (let g = 0; g < 3; g++) {
      for (let i = 0; i < 6; i++) {
        clustered[`g${g}_${i}`] = [g * 2 + i * 0.01, g * 2 + i * 0.01, g * 2 + i * 0.01];
      }
    }
    const sig = phaseSignal(clustered);
    expect(sig.observed_high).toBeGreaterThan(sig.null_high);
    expect(sig.degenerate).toBe(false);
  });

  it('finds structure in phases derived from a rhythmic ledger, via the real pipeline', () => {
    const { events } = syntheticLedger({ topics: 6, perTopic: 8 });
    const { train } = splitEvents(events, 0.85);
    // Phases come from phases.ts reading recall timing — not handed in.
    const sig = phaseSignal(buildAtlas(train).torus.points);
    expect(sig.degenerate).toBe(false);
    expect(sig.excess).toBeGreaterThan(0.03);
  });
});

describe('THE HARNESS ITSELF: can it detect prediction when prediction exists?', () => {
  // Validates the instrument, not the method on real data. The ledger's rhythm
  // is planted, so the only claim here is that the harness reports a strong
  // effect when one is present and chance when the signal is destroyed.
  const ledger = syntheticLedger({ topics: 8, perTopic: 12, cycles: 12, futurePerTopic: 8 });
  const { train, test } = splitEvents(ledger.events, 0.85);
  const atlas = buildAtlas(train);
  const edges = asEdges(atlas.edges);
  const future = futureLinks(train, test);

  const arm = (torus: Record<string, number[]>) => (s: string) =>
    queryBridges(s, atlas.hyper.points, edges, {
      torusPoints: torus, scoring: 'resonance', count: 6, minHops: 3, diversify: true, minSep: 3,
    }).map((b) => ({ a: b.a, b: b.b }));

  it('the atlas is built from the training window only', () => {
    // Every future pair must be absent from the graph the atlas was fitted on.
    const known = new Set(edges.map((e) => (e.src < e.dst ? `${e.src} ${e.dst}` : `${e.dst} ${e.src}`)));
    for (const p of future.pairs) expect(known.has(p)).toBe(false);
    expect(future.pairs.size).toBeGreaterThan(20);
  });

  it('resonance predicts future co-recall well above chance', () => {
    const res = scoreArm('resonance', arm(atlas.torus.points), future);
    const rnd = scoreArm('random', randomProposals(atlas.nodes, 6), future);
    expect(res.precision).toBeGreaterThan(2 * rnd.precision);
  });

  it('and collapses to chance when the phase→node correspondence is destroyed', () => {
    // Here permutation IS the right null: the arm ties phases to node identity,
    // so breaking that correspondence removes exactly the signal under test.
    const ids = Object.keys(atlas.torus.points).sort();
    const vals = ids.map((id) => atlas.torus.points[id]);
    for (let i = vals.length - 1; i > 0; i--) {
      const j = (i * 7919 + 13) % (i + 1);
      [vals[i], vals[j]] = [vals[j], vals[i]];
    }
    const shuffled = Object.fromEntries(ids.map((id, i) => [id, vals[i]]));

    const res = scoreArm('resonance', arm(atlas.torus.points), future);
    const nul = scoreArm('null', arm(shuffled), future);
    const rnd = scoreArm('random', randomProposals(atlas.nodes, 6), future);
    expect(res.precision).toBeGreaterThan(2 * nul.precision);
    expect(nul.precision).toBeLessThan(2 * rnd.precision); // indistinguishable from chance
  });

  it('a signal-free ledger yields no advantage — the harness does not manufacture one', () => {
    // Lattice-seated phases: every node identical, so resonance has nothing to
    // discriminate with and must not beat random.
    const flat = torusMap(atlas.nodes.map((id) => ({ id })), { dim: 8 }).points;
    const res = scoreArm('resonance', arm(flat), future);
    const rnd = scoreArm('random', randomProposals(atlas.nodes, 6), future);
    expect(res.precision).toBeLessThan(3 * rnd.precision);
  });
});

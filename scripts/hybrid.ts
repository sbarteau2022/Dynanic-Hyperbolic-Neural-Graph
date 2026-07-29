#!/usr/bin/env tsx
// ============================================================
// HYBRID CLI — exploration/exploitation sweep over the bridge budget.
//
//   npm run bench:hybrid
//
// Three architectural iterations left one number unmoved: resonance bridges
// win precision and traversal depth, and still trail RANDOM shortcuts on
// recall breadth. The hypothesis under test is that these are complementary
// primitives rather than competitors —
//
//   • random shortcuts do TOPOLOGICAL EXPANSION: they cut the graph diameter
//     (Watts–Strogatz) and drop the searcher in the right general region.
//   • resonance bridges do SEMANTIC TUNNELING: they fold the manifold so the
//     searcher lands on the exact node in minimal hops.
//
// So: hold the per-query edge budget FIXED and sweep the split. Every point
// spends the same number of edges from the same source; only the allocation
// rule changes. r = 0 is pure resonance, r = B is pure random, and the
// question is whether a small random allocation recovers the recall gap
// without spending the hop-count or precision advantage.
//
// Deterministic end to end: same seed → same frontier.
// ============================================================
import {
  syntheticCorpus, groundTruthQueries, runArmsPerQuery, randomQueryBridges, type Corpus,
} from '../src/core/bench';
import { hyperMap } from '../src/core/hyper';
import { torusMap } from '../src/core/torus';
import { queryBridges } from '../src/core/bridge';
import { asEdges, type Edge } from '../src/core/structure';

const BUDGET = 4;                 // hop horizon, same as the main bench
const SPLITS = [3, 6] as const;   // total per-query edge budgets to sweep

interface Fitted { corpus: Corpus; edges: Edge[]; hyper: Record<string, number[]>; torus: Record<string, number[]> }

function fit(topology: 'star' | 'ring', shufflePhases = false): Fitted {
  const corpus = syntheticCorpus({
    topology, alignment: 'crosscut', shufflePhases,
    lineages: 6, perLineage: 6, topics: 4, seed: 1,
  });
  const edges = asEdges(corpus.edges);
  return {
    corpus, edges,
    hyper: hyperMap([], corpus.edges, { dim: 3, epochs: 300, seed: 42 }).points,
    torus: torusMap(corpus.nodes.map((id) => ({ id, phases: corpus.phases[id] })), { dim: 8 }).points,
  };
}

function table(rows: Array<Record<string, string | number>>, cols: string[]): string {
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (cells: string[]) => '| ' + cells.map((s, i) => s.padEnd(w[i])).join(' | ') + ' |';
  return [
    line(cols),
    '|' + w.map((n) => '-'.repeat(n + 2)).join('|') + '|',
    ...rows.map((r) => line(cols.map((c) => String(r[c] ?? '')))),
  ].join('\n');
}

interface Point { topology: string; B: number; rand: number; pct: string; recall: number; hops: number; prec: number; resN: number }

function sweep(topology: 'star' | 'ring', f: Fitted, B: number): Point[] {
  const queries = groundTruthQueries(f.corpus.topics, { maxQueries: 24 });
  const out: Point[] = [];

  for (let r = 0; r <= B; r++) {
    const nRes = B - r;
    let resHit = 0, resTot = 0;

    const arms = runArmsPerQuery(f.edges, queries, {
      hybrid: (s) => {
        // Resonance first — it is the selective instrument.
        const res = nRes > 0
          ? queryBridges(s, f.hyper, f.edges, {
              torusPoints: f.torus, scoring: 'resonance', count: nRes, minHops: 3,
              diversify: true, minSep: 3,
            })
          : [];
        resTot += res.length;
        resHit += res.filter((b) => f.corpus.topics[b.a] === f.corpus.topics[b.b]).length;

        // Random fills the remaining budget, never duplicating a resonance pick,
        // so the two layers genuinely add reach instead of overlapping.
        const used = new Set(res.map((b) => b.b));
        const rnd = r > 0
          ? randomQueryBridges(s, f.corpus.nodes, f.edges, r + used.size + 2, 7)
              .filter((b) => !used.has(b.b))
              .slice(0, r)
          : [];
        return [...res.map((b) => ({ a: b.a, b: b.b })), ...rnd];
      },
    }, { budget: BUDGET });

    const m = arms[1].metrics;
    out.push({
      topology, B, rand: r,
      pct: `${Math.round((100 * r) / B)}%`,
      recall: m.coverage, hops: m.effective_hops,
      prec: resTot ? resHit / resTot : NaN, resN: resTot,
    });
  }
  return out;
}

// A point is on the frontier if nothing else is >= on recall AND <= on hops
// with at least one strict. Plain Pareto dominance, no scalarizing.
function frontier(points: Point[]): Set<number> {
  const keep = new Set<number>();
  points.forEach((p, i) => {
    const dominated = points.some((q, j) =>
      j !== i && q.recall >= p.recall && q.hops <= p.hops && (q.recall > p.recall || q.hops < p.hops));
    if (!dominated) keep.add(i);
  });
  return keep;
}

// The budget sweep that reframes everything: pure resonance vs pure random
// at a range of per-query budgets. The recall gap that survived three
// architectural iterations turns out to be a LOW-BUDGET REGIME EFFECT, not a
// structural property — it inverts at a budget of 4 and never comes back.
function crossover(): Array<Record<string, string | number>> {
  const rows: Array<Record<string, string | number>> = [];
  for (const topology of ['star', 'ring'] as const) {
    const f = fit(topology);
    const queries = groundTruthQueries(f.corpus.topics, { maxQueries: 24 });
    for (const B of [1, 2, 3, 4, 5, 6, 8, 10]) {
      const arms = runArmsPerQuery(f.edges, queries, {
        resonance: (s) => queryBridges(s, f.hyper, f.edges, {
          torusPoints: f.torus, scoring: 'resonance', count: B, minHops: 3, diversify: true, minSep: 3,
        }).map((b) => ({ a: b.a, b: b.b })),
        random: (s) => randomQueryBridges(s, f.corpus.nodes, f.edges, B, 7),
      }, { budget: BUDGET });
      const r = arms[1].metrics, q = arms[2].metrics;
      rows.push({
        topology, budget: B,
        res_recall: r.coverage.toFixed(3), res_hops: r.effective_hops.toFixed(2),
        rand_recall: q.coverage.toFixed(3), rand_hops: q.effective_hops.toFixed(2),
        recall_winner: r.coverage > q.coverage ? 'resonance' : r.coverage < q.coverage ? 'random' : 'tie',
        hops_winner: r.effective_hops < q.effective_hops ? 'resonance' : 'random',
      });
    }
  }
  return rows;
}

function main() {
  const rows: Array<Record<string, string | number>> = [];

  for (const topology of ['star', 'ring'] as const) {
    const f = fit(topology);
    for (const B of SPLITS) {
      const pts = sweep(topology, f, B);
      const front = frontier(pts);
      pts.forEach((p, i) => rows.push({
        topology: p.topology,
        budget: p.B,
        split: `${p.B - p.rand}res + ${p.rand}rand`,
        rand_pct: p.pct,
        recall: p.recall.toFixed(3),
        eff_hops: p.hops.toFixed(2),
        res_precision: Number.isNaN(p.prec) ? '—' : `${(100 * p.prec).toFixed(0)}% (${p.resN})`,
        pareto: front.has(i) ? '★' : '',
      }));
    }
  }

  console.log(`\nHYBRID SWEEP — crosscut corpus, ${BUDGET}-hop budget, fixed per-query edge spend`);
  console.log('Every row spends the SAME number of edges from the same source; only the allocation differs.');
  console.log('res_precision = share of the RESONANCE-selected bridges that joined a true topic-mate (n selected).');
  console.log('★ = on the recall/hops Pareto frontier for that (topology, budget).\n');
  console.log(table(rows, ['topology', 'budget', 'split', 'rand_pct', 'recall', 'eff_hops', 'res_precision', 'pareto']));

  // Does the resonance half still depend on the signal inside a hybrid?
  console.log('\n### Permutation null on the best hybrid split (B=6, 5res+1rand)\n');
  const nullRows: Array<Record<string, string | number>> = [];
  for (const topology of ['star', 'ring'] as const) {
    for (const shuffled of [false, true]) {
      const fx = fit(topology, shuffled);
      const p = sweep(topology, fx, 6).find((q) => q.rand === 1)!;
      nullRows.push({
        topology, phases: shuffled ? 'shuffled (null)' : 'signal',
        recall: p.recall.toFixed(3), eff_hops: p.hops.toFixed(2),
        res_precision: `${(100 * p.prec).toFixed(0)}%`,
      });
    }
  }
  console.log(table(nullRows, ['topology', 'phases', 'recall', 'eff_hops', 'res_precision']));

  console.log('\n### Budget crossover — pure resonance vs pure random, no hybrid\n');
  console.log(table(crossover(), ['topology', 'budget', 'res_recall', 'res_hops', 'rand_recall', 'rand_hops', 'recall_winner', 'hops_winner']));
  console.log();
}

main();

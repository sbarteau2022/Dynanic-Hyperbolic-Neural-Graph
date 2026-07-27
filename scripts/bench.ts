#!/usr/bin/env tsx
// ============================================================
// BENCH CLI — the controlled experiment, printed as tables.
//
//   npm run bench
//
// Builds synthetic corpora with PLANTED TOPICS (bench.ts), embeds them with
// the real geometry stack (hyperMap + torusMap — the embedding is never shown
// a topic label), derives bridges from the manifold, and races them against
// the same edge budget spent two cheaper ways: RANDOM shortcuts and HUB
// shortcuts. Ground truth, not geometry, decides what counts as success.
//
// Factors:
//   topology  star  — every lineage hangs off one shared root, which
//                     manufactures a perfect hub
//             ring  — roots joined in a cycle; no node dominates
//   alignment crosscut — topic-mates are graph-far / phase-close (the case
//                     the bridge claims)
//             aligned  — topic == lineage, already adjacent (NEGATIVE
//                     CONTROL: a real method shows ~no gain here)
//   scope     global    — one bridge set for the whole graph
//             per-query — each query induces its own (the deformation the
//                     architecture actually describes)
//   mix       graph     — curvature mix read off the topology (shipped default)
//             balanced  — equal weight on both charts
//
// Deterministic end to end: same seed → same tables.
// ============================================================
import {
  syntheticCorpus, groundTruthQueries, randomBridges, hubBridges, runArms,
  runArmsPerQuery, randomQueryBridges, hubQueryBridges, type Corpus,
} from '../src/core/bench';
import { hyperMap } from '../src/core/hyper';
import { torusMap } from '../src/core/torus';
import { bridgeEdges, queryBridges } from '../src/core/bridge';
import { resolveMix, type Mix } from '../src/core/product';
import { asEdges, type Edge } from '../src/core/structure';

const BUDGET = 4;     // hop horizon — tight enough that reach is not free
const K = 0;          // (unused) relevant set is every topic-mate — recall@budget
const NGLOBAL = 8;    // global-scope bridge budget
const PER_QUERY = 3;  // per-query bridge budget (identical for every arm)

type Align = 'crosscut' | 'aligned' | 'shuffled';
type Topo = 'star' | 'ring';

function table(rows: Array<Record<string, string | number>>, cols: string[]): string {
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (cells: string[]) => '| ' + cells.map((s, i) => s.padEnd(w[i])).join(' | ') + ' |';
  return [
    line(cols),
    '|' + w.map((n) => '-'.repeat(n + 2)).join('|') + '|',
    ...rows.map((r) => line(cols.map((c) => String(r[c] ?? '')))),
  ].join('\n');
}

interface Fitted { corpus: Corpus; edges: Edge[]; hyper: Record<string, number[]>; torus: Record<string, number[]>; mixes: Record<string, Mix> }

function fit(topology: Topo, alignment: Align): Fitted {
  // `shuffled` is the permutation null: same graph, same planted topics as
  // `crosscut`, but phase carries no topic signal.
  const corpus = syntheticCorpus({
    topology,
    alignment: alignment === 'shuffled' ? 'crosscut' : alignment,
    shufflePhases: alignment === 'shuffled',
    lineages: 6, perLineage: 6, topics: 4, seed: 1,
  });
  const edges = asEdges(corpus.edges);
  // The embedding sees edges and phases. It never sees corpus.topics.
  const hyper = hyperMap([], corpus.edges, { dim: 3, epochs: 300, seed: 42 }).points;
  const torus = torusMap(corpus.nodes.map((id) => ({ id, phases: corpus.phases[id] })), { dim: 8 }).points;
  return {
    corpus, edges, hyper, torus,
    mixes: { graph: resolveMix({ edges }).mix, balanced: { hyperbolic: 1, toroidal: 1 } },
  };
}

function main() {
  const main: Array<Record<string, string | number>> = [];
  const ablation: Array<Record<string, string | number>> = [];

  for (const topology of ['star', 'ring'] as Topo[]) {
    for (const alignment of ['crosscut', 'aligned', 'shuffled'] as Align[]) {
      const f = fit(topology, alignment);
      const queries = groundTruthQueries(f.corpus.topics, { maxQueries: 24 });
      const onTopic = (bs: Array<{ a: string; b: string }>) =>
        bs.filter((b) => f.corpus.topics[b.a] === f.corpus.topics[b.b]).length;

      // ── main table: per-query scope, balanced mix ──────────────────────
      let geoHit = 0, geoTot = 0, divHit = 0, divTot = 0;
      const arms = runArmsPerQuery(f.edges, queries, {
        geometry: (s) => {
          const bs = queryBridges(s, f.hyper, f.edges, {
            torusPoints: f.torus, mix: f.mixes.balanced, count: PER_QUERY, minHops: 3,
          }).map((b) => ({ a: b.a, b: b.b }));
          geoTot += bs.length; geoHit += onTopic(bs);
          return bs;
        },
        'geometry+div': (s) => {
          const bs = queryBridges(s, f.hyper, f.edges, {
            torusPoints: f.torus, mix: f.mixes.balanced, count: PER_QUERY, minHops: 3,
            diversify: true, minSep: 3,
          }).map((b) => ({ a: b.a, b: b.b }));
          divTot += bs.length; divHit += onTopic(bs);
          return bs;
        },
        random: (s) => randomQueryBridges(s, f.corpus.nodes, f.edges, PER_QUERY, 7),
        hub: (s) => hubQueryBridges(s, f.edges, PER_QUERY),
      }, { budget: BUDGET });

      for (const arm of arms) {
        main.push({
          topology, corpus: alignment, arm: arm.name,
          coverage: arm.metrics.coverage.toFixed(3),
          eff_hops: arm.metrics.effective_hops.toFixed(2),
          expanded: arm.metrics.expanded,
          on_topic: arm.name === 'geometry' ? `${geoHit}/${geoTot}`
            : arm.name === 'geometry+div' ? `${divHit}/${divTot}` : '—',
        });
      }

      // ── ablation table: scope × mix, geometry arm only ─────────────────
      if (alignment !== 'crosscut') continue;
      for (const mixName of ['graph', 'balanced']) {
        const mix = f.mixes[mixName];
        const global = bridgeEdges(f.hyper, f.edges, {
          torusPoints: f.torus, mix, maxBridges: NGLOBAL, quantile: 0.2, minHops: 3,
        }).bridges.map((b) => ({ a: b.a, b: b.b }));
        const g = runArms(f.edges, queries, { geometry: global }, { budget: BUDGET });
        ablation.push({
          topology, mix: mixName, scope: 'global', edges_spent: global.length,
          coverage: g[1].metrics.coverage.toFixed(3),
          eff_hops: g[1].metrics.effective_hops.toFixed(2),
          on_topic: `${onTopic(global)}/${global.length}`,
        });

        let hit = 0, tot = 0;
        const pq = runArmsPerQuery(f.edges, queries, {
          geometry: (s) => {
            const bs = queryBridges(s, f.hyper, f.edges, {
              torusPoints: f.torus, mix, count: PER_QUERY, minHops: 3,
            }).map((b) => ({ a: b.a, b: b.b }));
            tot += bs.length; hit += onTopic(bs);
            return bs;
          },
        }, { budget: BUDGET });
        ablation.push({
          topology, mix: mixName, scope: 'per-query', edges_spent: pq[1].bridges,
          coverage: pq[1].metrics.coverage.toFixed(3),
          eff_hops: pq[1].metrics.effective_hops.toFixed(2),
          on_topic: `${hit}/${tot}`,
        });
      }
    }
  }

  console.log(`\nDHNG bridge benchmark — budget ${BUDGET} hops, all planted topic-mates as the relevant set, ${PER_QUERY} bridges/query per arm`);
  console.log('coverage = fraction of planted topic-mates reached (higher better); eff_hops charges misses budget+1 (lower better)');
  console.log('\n### Main: per-query bridging, balanced mix — geometry vs. the cheap alternatives\n');
  console.log(table(main, ['topology', 'corpus', 'arm', 'coverage', 'eff_hops', 'expanded', 'on_topic']));
  console.log('\n### Ablation: does scope and curvature mix matter? (crosscut corpus, geometry arm only)\n');
  console.log(table(ablation, ['topology', 'mix', 'scope', 'edges_spent', 'coverage', 'eff_hops', 'on_topic']));
  console.log();
}

main();

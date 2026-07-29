#!/usr/bin/env tsx
// ============================================================
// HOLDOUT CLI — the real-data experiment.
//
//   npm run holdout [-- --in data/events.json] [--fraction 0.7] [--count 6]
//
// Splits the event ledger chronologically, builds the atlas from the earlier
// half ONLY, and asks each arm to propose wormholes. Ground truth is the pairs
// the ledger actually co-recalled afterwards and had never linked before — so
// the answer key lives strictly in the atlas's future and leakage is
// structurally impossible.
//
// Reads the real ledger if `npm run sync-events` has pulled one; otherwise
// falls back to data/events.example.json and says so loudly, because a result
// on the example file proves the harness runs, not that the method works.
//
// Read `phase signal` FIRST. If it reports degenerate, every arm below is
// measuring nothing and the honest conclusion is that the ledger carries no
// rhythm for resonance to fold on.
// ============================================================
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { buildAtlas } from '../src/cartographer';
import { queryBridges } from '../src/core/bridge';
import { splitEvents, futureLinks, scoreArm, phaseSignal, randomProposals, type ArmResult } from '../src/core/holdout';
import { asEdges } from '../src/core/structure';
import { hubQueryBridges } from '../src/core/bench';
import type { MemEvent } from '../src/core/events';

const ROOT = path.resolve(import.meta.dirname, '..');

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
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

async function main() {
  const explicit = arg('--in');
  const real = explicit || process.env.ATLAS_EVENTS_PATH || path.join(ROOT, 'data', 'events.json');
  const usingReal = existsSync(real);
  const eventsPath = usingReal ? real : path.join(ROOT, 'data', 'events.example.json');
  const events = JSON.parse(await readFile(eventsPath, 'utf8')) as MemEvent[];

  const fraction = Number(arg('--fraction', '0.7'));
  const count = Math.max(1, Math.round(Number(arg('--count', '6'))));

  if (!usingReal) {
    console.log('\n⚠  NO REAL LEDGER FOUND at', real);
    console.log('   Falling back to data/events.example.json. This exercises the harness;');
    console.log('   it proves nothing about the method. Run `npm run sync-events` with');
    console.log('   ATLAS_PULL_URL + ATLAS_SERVICE_KEY to pull the real ledger first.\n');
  }

  const { train, test, cut } = splitEvents(events, fraction);
  console.log(`ledger: ${eventsPath}`);
  console.log(`events: ${events.length}  →  train ${train.length} / test ${test.length}  (cut at ts ${cut})`);

  if (!train.length || !test.length) {
    console.error('\nsplit produced an empty side — need events on both sides of the cut.');
    process.exitCode = 1;
    return;
  }

  // The atlas sees the training window ONLY.
  const atlas = buildAtlas(train);
  const edges = asEdges(atlas.edges);
  const nodes = atlas.nodes;

  const sig = phaseSignal(atlas.torus.points);
  console.log('\n### Phase signal (read this before anything below)\n');
  console.log(table([{
    nodes: sig.nodes,
    distinct_phases: sig.distinct_phases,
    observed_high: sig.observed_high,
    null_high: sig.null_high,
    excess: sig.excess,
    verdict: sig.degenerate ? 'DEGENERATE — no rhythm to fold on' : 'structure present',
  }], ['nodes', 'distinct_phases', 'observed_high', 'null_high', 'excess', 'verdict']));

  const future = futureLinks(train, test);
  console.log(`\nfuture links to predict: ${future.pairs.size} novel pairs across ${future.sources.length} sources`);
  if (!future.pairs.size) {
    console.error('\nno novel pairs after the cut — nothing to predict. A longer ledger, or a');
    console.error('smaller --fraction, is needed for this experiment to say anything.');
    process.exitCode = 1;
    return;
  }

  const bridgeArm = (scoring: 'resonance' | 'product') => (s: string) =>
    queryBridges(s, atlas.hyper.points, edges, {
      torusPoints: atlas.torus.points, scoring, count, minHops: 3, diversify: true, minSep: 3,
    }).map((b) => ({ a: b.a, b: b.b }));

  // The permutation null: same graph, same atlas, phases shuffled across nodes.
  const shuffledTorus: Record<string, number[]> = {};
  {
    const ids = Object.keys(atlas.torus.points).sort();
    const vals = ids.map((id) => atlas.torus.points[id]);
    for (let i = vals.length - 1; i > 0; i--) {
      const j = (i * 7919 + 13) % (i + 1);          // deterministic, no PRNG import needed
      [vals[i], vals[j]] = [vals[j], vals[i]];
    }
    ids.forEach((id, i) => { shuffledTorus[id] = vals[i]; });
  }

  const arms: ArmResult[] = [
    scoreArm('resonance', bridgeArm('resonance'), future),
    scoreArm('product', bridgeArm('product'), future),
    scoreArm('resonance (phase-permuted null)', (s) =>
      queryBridges(s, atlas.hyper.points, edges, {
        torusPoints: shuffledTorus, scoring: 'resonance', count, minHops: 3, diversify: true, minSep: 3,
      }).map((b) => ({ a: b.a, b: b.b })), future),
    scoreArm('random', randomProposals(nodes, count), future),
    scoreArm('hub', (s) => hubQueryBridges(s, edges, count), future),
  ];

  const randomPrecision = arms.find((a) => a.arm === 'random')!.precision;
  console.log(`\n### Predicting future co-recall — ${count} proposals/source\n`);
  console.log(table(arms.map((a) => ({
    arm: a.arm,
    sources: a.sources,
    proposed: a.proposed,
    hits: a.hits,
    precision: a.precision.toFixed(4),
    recall: a.recall.toFixed(4),
    lift_vs_random: randomPrecision > 0 ? (a.precision / randomPrecision).toFixed(2) + '×' : '—',
  })), ['arm', 'sources', 'proposed', 'hits', 'precision', 'recall', 'lift_vs_random']));

  const res = arms[0], nul = arms[2], rnd = arms[3];
  const lift = rnd.precision > 0 ? res.precision / rnd.precision : Infinity;
  const nullLift = nul.precision > 0 ? res.precision / nul.precision : Infinity;
  // Thresholds, not bare inequalities. On a small graph a method proposing k
  // of n nodes scores well by chance, so "beats random by a hair" is not a
  // result — it is the sample size talking.
  const MIN_LIFT = 1.5, MIN_HITS = 20;
  const thin = res.hits < MIN_HITS || future.pairs.size < 20;

  console.log('\n### Verdict\n');
  if (sig.degenerate) {
    console.log('PHASE IS DEGENERATE: the ledger carries no recurrence rhythm, so resonance has');
    console.log('nothing to fold on and every arm difference below is noise. The instrument is');
    console.log('correct and has nothing to measure — enrich phase derivation before wiring');
    console.log('bridges into retrieval.');
  } else if (lift >= MIN_LIFT && nullLift >= MIN_LIFT) {
    console.log(`PREDICTIVE: resonance ${res.precision} vs random ${rnd.precision} (${lift.toFixed(2)}×)`);
    console.log(`and vs its own permutation null ${nul.precision} (${nullLift.toFixed(2)}×).`);
    console.log('The atlas anticipates recall rather than merely recording it.');
    if (thin) {
      console.log(`\n  ⚠ THIN SAMPLE (${res.hits} hits over ${future.pairs.size} future pairs) — directionally`);
      console.log('    right, but too few events to lean on. Re-run on a longer ledger.');
    }
  } else if (res.precision > rnd.precision && res.precision > nul.precision) {
    console.log(`INCONCLUSIVE: resonance leads (${res.precision} vs random ${rnd.precision},`);
    console.log(`null ${nul.precision}) but by less than ${MIN_LIFT}×. On a graph this size a method`);
    console.log('proposing k of n nodes scores well by chance; this margin is sample size, not');
    console.log('evidence. Longer ledger needed before wiring bridges into retrieval.');
  } else {
    console.log(`NOT PREDICTIVE: resonance ${res.precision} does not clear random ${rnd.precision}`);
    console.log(`and null ${nul.precision}. On this ledger the bridge does not anticipate recall.`);
    console.log('Do not wire it into retrieval on the strength of the synthetic results alone.');
  }
  console.log();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

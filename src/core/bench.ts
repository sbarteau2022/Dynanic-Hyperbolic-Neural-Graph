// ============================================================
// BENCH — the controlled experiment behind the bridge claim (pure static core)
//
// metrics.ts answers "did bridging change the search?" but it defines
// relevance with the SAME geometry that builds the bridges. That is circular,
// and a reviewer should reject it on its own. This module removes both
// circularities:
//
//   1. GROUND TRUTH, not geometry, names the evidence. Synthetic corpora are
//      generated with a planted TOPIC per node. The embedding never sees a
//      topic label — only edges and phase vectors. A query's relevant set is
//      its topic-mates. Reaching them is the task; the geometry gets no say
//      in what counts as success.
//
//   2. CONTROL ARMS, not just a baseline. "Adding k shortcut edges shortens
//      paths" is Watts–Strogatz, not a contribution. So the geometry arm is
//      run against the same COUNT of shortcuts chosen two cheaper ways:
//      RANDOM (uniform over non-adjacent pairs) and HUB (highest-degree
//      nodes joined first). If geometry cannot beat those, the manifold is
//      not doing the work and the honest answer is that it isn't earning
//      its keep.
//
// ── the structure the experiment is built on ──
// Topics manifest as shared RECALL PHASE, never as edges. Edges come from a
// lineage process (chains under a common root); topics cross-cut those
// lineages. So a node's topic-mates are deliberately GRAPH-FAR and
// PHASE-CLOSE — exactly the "same rhythm, different lineage" configuration
// product.ts names, and exactly what the ball alone cannot see. The
// `aligned` variant is the negative control: topic == lineage, so the
// topology already agrees and a bridge should add ~nothing. A method that
// "wins" on the negative control too is measuring its own thumb.
//
// Pure and deterministic — mulberry32 only, no wall clock, no I/O.
// ============================================================

import { mulberry32, fnv1a } from './hyper';
import { norm2pi } from './torus';
import type { Edge } from './structure';
import type { MemEdge } from './types';
import type { MemEvent } from './events';
import { evidenceWalk, aggregateWalks, type EvidenceQuery, type WalkMetrics } from './metrics';

// ── synthetic corpora with planted topics ─────────────────────────────────

export interface Corpus {
  edges: MemEdge[];
  phases: Record<string, number[]>;  // what the torus chart is given
  topics: Record<string, string>;    // GROUND TRUTH — never given to any embedding
  nodes: string[];
}

export interface CorpusOpts {
  lineages?: number;      // independent derivation chains (default 6)
  perLineage?: number;    // nodes per chain (default 6)
  topics?: number;        // distinct planted topics (default 4)
  alignment?: 'crosscut' | 'aligned'; // topic vs. lineage relationship (default crosscut)
  // How the lineage roots are joined. `star` hangs them all off one shared
  // root — which manufactures a perfect hub, and any "route via the hub"
  // heuristic is near-optimal there by construction. `ring` joins each root
  // to the next, so no node dominates and the diameter is real. Both are
  // reported: a method that only wins on one has a topology dependence its
  // users need to know about.
  topology?: 'star' | 'ring';         // default star
  // THE PERMUTATION NULL. Keep the graph and the planted topics exactly as
  // they are, but permute the phase vectors across nodes so phase carries no
  // topic information at all. The geometry arm should then collapse to the
  // random control — if it still "wins" here, its gain never came from the
  // signal and the whole result is an artifact of adding edges.
  shufflePhases?: boolean;            // default false
  phaseNoise?: number;    // radians of jitter on a topic's phase signature (default 0.25)
  phaseDim?: number;      // default 8
  seed?: number;          // default 1
}

// Each topic gets a fixed phase signature; each node gets that signature plus
// deterministic jitter. Topic identity is therefore recoverable from phase
// alone — and from nothing else the embedding is shown.
function topicPhase(topic: string, dim: number): number[] {
  const rand = mulberry32(fnv1a(`topic:${topic}`));
  return Array.from({ length: dim }, () => norm2pi(rand() * 2 * Math.PI));
}

export function syntheticCorpus(opts: CorpusOpts = {}): Corpus {
  const L = Math.max(2, Math.round(opts.lineages ?? 6));
  const P = Math.max(2, Math.round(opts.perLineage ?? 6));
  const T = Math.max(2, Math.round(opts.topics ?? 4));
  const alignment = opts.alignment ?? 'crosscut';
  const noise = Math.max(0, opts.phaseNoise ?? 0.25);
  const dim = Math.max(1, Math.round(opts.phaseDim ?? 8));
  const rand = mulberry32((opts.seed ?? 1) >>> 0);

  const edges: MemEdge[] = [];
  const topics: Record<string, string> = {};
  const phases: Record<string, number[]> = {};
  const nodes: string[] = [];
  const base = new Map<string, number[]>();
  const id = (l: number, p: number) => `n${l}_${p}`;

  for (let l = 0; l < L; l++) {
    for (let p = 0; p < P; p++) {
      const node = id(l, p);
      nodes.push(node);
      // crosscut: depth position picks the topic, so topic-mates sit at the
      // same depth in DIFFERENT lineages — far apart on the graph.
      // aligned:  the lineage picks the topic, so topic-mates are chain
      //           neighbours — already adjacent, nothing for a bridge to do.
      const topic = `t${(alignment === 'crosscut' ? p : l) % T}`;
      topics[node] = topic;
      if (!base.has(topic)) base.set(topic, topicPhase(topic, dim));
      phases[node] = base.get(topic)!.map((a) => norm2pi(a + (rand() - 0.5) * 2 * noise));

      if (p > 0) edges.push({ src: id(l, p - 1), dst: node, kind: 'derived', weight: 1 });
    }
  }
  // Join the lineage roots into one component — the baseline walk can always
  // reach its targets, it just has to travel.
  const topology = opts.topology ?? 'star';
  for (let l = 1; l < L; l++) {
    if (topology === 'star') edges.push({ src: id(0, 0), dst: id(l, 0), kind: 'assoc', weight: 1 });
  }
  if (topology === 'ring') {
    for (let l = 0; l < L; l++) edges.push({ src: id(l, 0), dst: id((l + 1) % L, 0), kind: 'assoc', weight: 1 });
  }

  if (opts.shufflePhases) {
    // Fisher–Yates over the sorted node list with the same deterministic PRNG.
    const order = [...nodes].sort();
    const shuffled = order.map((n) => phases[n]);
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    order.forEach((n, i) => { phases[n] = shuffled[i]; });
  }

  return { edges, phases, topics, nodes };
}

// ── ground-truth queries: topic-mates are the evidence ────────────────────

// The relevant set is EVERY topic-mate, not an arbitrary sample of them:
// scoring against a fixed subset would charge a miss whenever a method
// retrieved a genuine topic-mate that happened not to be in the sample.
// This is plain recall@budget over the planted class.
export function groundTruthQueries(
  topics: Record<string, string>,
  opts: { cap?: number; maxQueries?: number } = {},
): EvidenceQuery[] {
  const cap = Math.max(1, Math.round(opts.cap ?? 64));  // guard only; not a sample
  const maxQ = Math.max(1, Math.round(opts.maxQueries ?? 24));
  const ids = Object.keys(topics).sort();
  const byTopic = new Map<string, string[]>();
  for (const n of ids) {
    if (!byTopic.has(topics[n])) byTopic.set(topics[n], []);
    byTopic.get(topics[n])!.push(n);
  }
  const stride = Math.max(1, Math.floor(ids.length / maxQ));
  const out: EvidenceQuery[] = [];
  for (let i = 0; i < ids.length && out.length < maxQ; i += stride) {
    const source = ids[i];
    const mates = (byTopic.get(topics[source]) || []).filter((m) => m !== source);
    if (mates.length) out.push({ source, targets: mates.slice(0, cap) });
  }
  return out;
}

// ── the control arms ──────────────────────────────────────────────────────

const ukey = (a: string, b: string) => (a < b ? `${a} ${b}` : `${b} ${a}`);

function adjacentPairs(edges: Edge[]): Set<string> {
  const s = new Set<string>();
  for (const e of edges) if (e.src !== e.dst) s.add(ukey(e.src, e.dst));
  return s;
}

// CONTROL 1 — uniform random shortcuts. The Watts–Strogatz null: if random
// rewiring matches the geometry arm, the geometry is decorative.
export function randomBridges(
  nodes: string[],
  edges: Edge[],
  count: number,
  seed = 7,
): Array<{ a: string; b: string }> {
  const ids = [...nodes].sort();
  const taken = adjacentPairs(edges);
  const rand = mulberry32(seed >>> 0);
  const out: Array<{ a: string; b: string }> = [];
  for (let tries = 0; tries < 20000 && out.length < count && ids.length > 1; tries++) {
    const a = ids[Math.floor(rand() * ids.length)];
    const b = ids[Math.floor(rand() * ids.length)];
    if (a === b) continue;
    const k = ukey(a, b);
    if (taken.has(k)) continue;
    taken.add(k);
    out.push({ a, b });
  }
  return out;
}

// CONTROL 2 — hub shortcuts. The obvious cheap heuristic: join the
// best-connected nodes and hope traffic funnels through them.
export function hubBridges(
  edges: Edge[],
  count: number,
): Array<{ a: string; b: string }> {
  const deg = new Map<string, number>();
  for (const e of edges) {
    if (e.src === e.dst) continue;
    deg.set(e.src, (deg.get(e.src) ?? 0) + 1);
    deg.set(e.dst, (deg.get(e.dst) ?? 0) + 1);
  }
  const ranked = [...deg.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).map((e) => e[0]);
  const taken = adjacentPairs(edges);
  const out: Array<{ a: string; b: string }> = [];
  for (let i = 0; i < ranked.length && out.length < count; i++) {
    for (let j = i + 1; j < ranked.length && out.length < count; j++) {
      const k = ukey(ranked[i], ranked[j]);
      if (taken.has(k)) continue;
      taken.add(k);
      out.push({ a: ranked[i], b: ranked[j] });
    }
  }
  return out;
}

// ── the arms, run over identical queries on an identical graph ────────────

export interface Arm { name: string; bridges: number; metrics: WalkMetrics }

export function runArms(
  edges: Edge[],
  queries: EvidenceQuery[],
  arms: Record<string, Array<{ a: string; b: string }>>,
  opts: { budget?: number } = {},
): Arm[] {
  const budget = opts.budget ?? 4;
  const out: Arm[] = [
    { name: 'baseline', bridges: 0, metrics: aggregateWalks(queries.map((q) => evidenceWalk(edges, q.source, q.targets, { budget }))) },
  ];
  for (const name of Object.keys(arms)) {
    const bridges = arms[name];
    out.push({
      name,
      bridges: bridges.length,
      metrics: aggregateWalks(queries.map((q) => evidenceWalk(edges, q.source, q.targets, { budget, bridges }))),
    });
  }
  return out;
}

// ── the per-query form ────────────────────────────────────────────────────
// Each query induces its OWN bridges, so every arm spends the same edge
// budget from the same source node and the comparison stays honest: this
// measures which RULE for choosing a query's shortcuts is better, not who
// got handed more edges.

export type BridgeMaker = (source: string) => Array<{ a: string; b: string }>;

export function runArmsPerQuery(
  edges: Edge[],
  queries: EvidenceQuery[],
  makers: Record<string, BridgeMaker>,
  opts: { budget?: number } = {},
): Arm[] {
  const budget = opts.budget ?? 4;
  const out: Arm[] = [
    { name: 'baseline', bridges: 0, metrics: aggregateWalks(queries.map((q) => evidenceWalk(edges, q.source, q.targets, { budget }))) },
  ];
  for (const name of Object.keys(makers)) {
    let total = 0;
    const runs = queries.map((q) => {
      const bridges = makers[name](q.source);
      total += bridges.length;
      return evidenceWalk(edges, q.source, q.targets, { budget, bridges });
    });
    out.push({ name, bridges: total, metrics: aggregateWalks(runs) });
  }
  return out;
}

// Per-query control: `count` random non-adjacent partners for THIS source.
export function randomQueryBridges(
  source: string,
  nodes: string[],
  edges: Edge[],
  count: number,
  seed = 7,
): Array<{ a: string; b: string }> {
  const taken = adjacentPairs(edges);
  const ids = [...nodes].sort().filter((n) => n !== source && !taken.has(ukey(source, n)));
  // Seed off the source so each query draws its own deterministic sample.
  const rand = mulberry32((seed + fnv1a(source)) >>> 0);
  const pool = [...ids];
  const out: Array<{ a: string; b: string }> = [];
  while (out.length < count && pool.length) {
    out.push({ a: source, b: pool.splice(Math.floor(rand() * pool.length), 1)[0] });
  }
  return out;
}

// Per-query control: connect THIS source to the `count` highest-degree nodes.
export function hubQueryBridges(
  source: string,
  edges: Edge[],
  count: number,
): Array<{ a: string; b: string }> {
  const deg = new Map<string, number>();
  for (const e of edges) {
    if (e.src === e.dst) continue;
    deg.set(e.src, (deg.get(e.src) ?? 0) + 1);
    deg.set(e.dst, (deg.get(e.dst) ?? 0) + 1);
  }
  const taken = adjacentPairs(edges);
  return [...deg.entries()]
    .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
    .map((e) => e[0])
    .filter((n) => n !== source && !taken.has(ukey(source, n)))
    .slice(0, count)
    .map((n) => ({ a: source, b: n }));
}

// ── a synthetic LEDGER (events over time), for the holdout experiment ─────
// The corpora above hand phase vectors straight to the torus. A holdout has
// to go through the real derivation path instead: phases.ts reads a node's
// RECALL RHYTHM out of event timestamps, so the signal must be planted as
// timing, not as a vector.
//
// Construction: every node belongs to a topic, and a topic is a CADENCE —
// all its nodes fire together once per cycle at that topic's offset, so
// topic-mates share a rhythm and different topics sit at different phases of
// the same cycle. Graph structure is built by chains that deliberately CROSS
// topics, so topic-mates are never adjacent in the training graph. After the
// cut, topic-mates co-recall — the novel links a wormhole claims to foresee.
export interface LedgerOpts {
  topics?: number;       // distinct cadences (default 4)
  perTopic?: number;     // nodes sharing each cadence (default 6)
  cycles?: number;       // training cycles (default 12 — ~10.7 bins/cycle, near a φ-scale)
  cycleLen?: number;     // ts units per cycle (default 100)
  futurePerTopic?: number; // novel topic-mate pairs after the cut (default 4)
}

export interface Ledger { events: MemEvent[]; topics: Record<string, string>; cut: number }

export function syntheticLedger(opts: LedgerOpts = {}): Ledger {
  const T = Math.max(2, Math.round(opts.topics ?? 4));
  const P = Math.max(2, Math.round(opts.perTopic ?? 6));
  const cycles = Math.max(4, Math.round(opts.cycles ?? 12));
  const cycleLen = Math.max(10, Math.round(opts.cycleLen ?? 100));
  const futurePer = Math.max(1, Math.round(opts.futurePerTopic ?? 4));

  const id = (k: number, i: number) => `t${k}_${i}`;
  const topics: Record<string, string> = {};
  for (let k = 0; k < T; k++) for (let i = 0; i < P; i++) topics[id(k, i)] = `c${k}`;

  const events: MemEvent[] = [];
  // Chains run ACROSS topics: chain i links t0_i → t1_i → … so a node's graph
  // neighbours never share its cadence.
  for (let cyc = 0; cyc < cycles; cyc++) {
    for (let k = 0; k < T; k++) {
      const at = cyc * cycleLen + Math.round((k * cycleLen) / T);   // this topic's offset
      for (let i = 0; i < P; i++) {
        const next = id((k + 1) % T, i);
        if (k + 1 < T) events.push({ kind: 'derived', src: id(k, i), dst: next, weight: 1, ts: at + i });
        // Chain heads ringed together so the graph is one component.
        if (k === 0 && i > 0) events.push({ kind: 'assoc', src: id(0, i - 1), dst: id(0, i), weight: 1, ts: at + i });
      }
    }
  }

  const cut = cycles * cycleLen;
  // After the cut: topic-mates (same cadence, never adjacent) start co-recalling.
  for (let k = 0; k < T; k++) {
    for (let n = 0; n < futurePer; n++) {
      const a = id(k, n % P), b = id(k, (n + 2) % P);
      if (a === b) continue;
      events.push({ kind: 'assoc', src: a, dst: b, weight: 1, ts: cut + 10 + n });
    }
  }
  return { events, topics, cut };
}

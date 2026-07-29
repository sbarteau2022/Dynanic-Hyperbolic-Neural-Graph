// ============================================================
// HOLDOUT — does the atlas ANTICIPATE recall, or only record it?
//
// Everything measured so far runs on synthetic corpora where the phase signal
// was planted by the same code that later found it. That establishes the
// mechanism works; it cannot establish that a real recall ledger has this
// structure at all. This module removes the synthetic corpus entirely and
// takes ground truth from the ledger's own future:
//
//   1. Split the event log chronologically at a cut time T.
//   2. Build the atlas from the BEFORE half only. It never sees the after.
//   3. Ground truth = pairs co-recalled AFTER T that were NOT already adjacent
//      before T. These are genuine new links — the thing a wormhole claims to
//      see coming.
//   4. Ask each arm for k bridges per source and count how many land on those
//      future links.
//
// No labels, no planted signal, no synthetic topology. The ledger supplies
// both the input and the answer key, and the answer key is strictly in the
// model's future — which also makes leakage structurally impossible rather
// than merely avoided.
//
// This is the experiment that decides whether the bridge is worth wiring into
// retrieval. If real phases carry no rhythm, every arm collapses to the same
// precision and the honest conclusion is that the instrument is correct and
// has nothing to measure.
//
// Pure and deterministic.
// ============================================================

import type { MemEvent } from './events';
import { mulberry32, fnv1a } from './hyper';
import { resonance } from './resonance';

const ukey = (a: string, b: string) => (a < b ? `${a} ${b}` : `${b} ${a}`);

// ── the chronological split ───────────────────────────────────────────────

export interface HoldoutSplit { train: MemEvent[]; test: MemEvent[]; cut: number }

// Split at a time quantile, NOT at an index: a ledger with bursty activity
// would otherwise put wall-clock-adjacent events on opposite sides of an
// index cut. Events without a ts fall back to their position.
export function splitEvents(events: MemEvent[], fraction = 0.7): HoldoutSplit {
  const f = Math.min(0.95, Math.max(0.05, fraction));
  const stamped = events.map((e, i) => ({ e, ts: e.ts ?? i }));
  const times = stamped.map((s) => s.ts).sort((a, b) => a - b);
  if (!times.length) return { train: [], test: [], cut: 0 };
  const cut = times[Math.min(times.length - 1, Math.floor(f * (times.length - 1)))];
  return {
    train: stamped.filter((s) => s.ts <= cut).map((s) => s.e),
    test: stamped.filter((s) => s.ts > cut).map((s) => s.e),
    cut,
  };
}

// ── ground truth: links the future actually made ──────────────────────────

export interface FutureLinks {
  pairs: Set<string>;                    // undirected keys, novel only
  bySource: Map<string, Set<string>>;    // source → its future partners
  sources: string[];                     // sources with at least one future link, sorted
}

// A future link counts only if the pair was NOT already connected in the
// training window. Re-firing an existing edge is not a prediction — it is the
// graph repeating itself, and scoring it would flatter every arm equally.
export function futureLinks(train: MemEvent[], test: MemEvent[]): FutureLinks {
  const known = new Set<string>();
  const trainNodes = new Set<string>();
  for (const e of train) {
    if (!e?.src || !e?.dst || e.src === e.dst) continue;
    known.add(ukey(e.src, e.dst));
    trainNodes.add(e.src); trainNodes.add(e.dst);
  }

  const pairs = new Set<string>();
  const bySource = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    if (!bySource.has(a)) bySource.set(a, new Set());
    bySource.get(a)!.add(b);
  };
  for (const e of test) {
    if (!e?.src || !e?.dst || e.src === e.dst) continue;
    const k = ukey(e.src, e.dst);
    if (known.has(k)) continue;                        // already linked — not news
    // Both endpoints must exist in the training graph, or no method could
    // have proposed the pair and scoring it would be meaningless.
    if (!trainNodes.has(e.src) || !trainNodes.has(e.dst)) continue;
    pairs.add(k);
    add(e.src, e.dst); add(e.dst, e.src);
  }
  return { pairs, bySource, sources: [...bySource.keys()].sort() };
}

// ── scoring an arm ────────────────────────────────────────────────────────

export interface ArmResult {
  arm: string;
  sources: number;     // sources that had at least one future link to find
  proposed: number;    // bridges offered across those sources
  hits: number;        // proposals that landed on a real future link
  precision: number;   // hits / proposed
  recall: number;      // future links found / future links available
  available: number;
}

export function scoreArm(
  arm: string,
  proposeFor: (source: string) => Array<{ a: string; b: string }>,
  future: FutureLinks,
  opts: { maxSources?: number } = {},
): ArmResult {
  const maxSources = Math.max(1, Math.round(opts.maxSources ?? 64));
  const stride = Math.max(1, Math.floor(future.sources.length / maxSources));
  const chosen: string[] = [];
  for (let i = 0; i < future.sources.length && chosen.length < maxSources; i += stride) {
    chosen.push(future.sources[i]);
  }

  let proposed = 0, hits = 0;
  const found = new Set<string>();
  // Both counted as DISTINCT undirected pairs. Summing `want.size` per source
  // would double-count every pair whose two endpoints are both queried, which
  // silently caps recall at 0.5.
  const availableSet = new Set<string>();
  for (const s of chosen) {
    const want = future.bySource.get(s)!;
    for (const t of want) availableSet.add(ukey(s, t));
    for (const b of proposeFor(s)) {
      const other = b.a === s ? b.b : b.a;
      proposed++;
      if (want.has(other)) { hits++; found.add(ukey(s, other)); }
    }
  }
  return {
    arm,
    sources: chosen.length,
    proposed,
    hits,
    precision: proposed ? round(hits / proposed, 4) : 0,
    recall: availableSet.size ? round(found.size / availableSet.size, 4) : 0,
    available: availableSet.size,
  };
}

// ── is there any phase signal to work with? ───────────────────────────────
// Runs before any arm, because it decides how to read every arm. If real
// phases carry no rhythm — every node seated on the golden lattice because it
// never recurred — then resonance has nothing to fold on and MUST tie the
// controls. Comparing the observed spread of pairwise resonance against the
// same points with phases permuted separates "no signal" from "signal the
// method failed to use", which are very different failures.

export interface PhaseSignal {
  nodes: number;
  distinct_phases: number;   // identical vectors collapse — lattice seats look like this
  observed_high: number;     // fraction of pairs at resonance ≥ HIGH
  null_high: number;         // same, for uniformly random phases on the same torus
  excess: number;            // observed_high − null_high
  degenerate: boolean;       // true ⇒ read every arm below as "nothing to find"
}

const HIGH = 0.5;

// NOTE ON THE NULL. The obvious null — permute which node holds which phase
// vector — is VACUOUS here: relabelling nodes leaves the multiset of pairwise
// resonances exactly unchanged, so it reports "no structure" on data that is
// visibly clustered. (It is the right null when labels are involved, which is
// why the benchmark uses it and this does not.) Structure in an unlabelled
// phase cloud means CLUSTERING — a bump of strongly-resonant pairs that
// uniformly scattered phases would not produce — so the null has to be
// freshly sampled phases, not a rearrangement of these ones.
export function phaseSignal(
  torusPoints: Record<string, number[]>,
  opts: { seed?: number; maxNodes?: number } = {},
): PhaseSignal {
  const ids = Object.keys(torusPoints).sort().slice(0, Math.max(2, opts.maxNodes ?? 200));
  const pts = ids.map((id) => torusPoints[id]);
  if (pts.length < 3) {
    return { nodes: pts.length, distinct_phases: pts.length, observed_high: 0, null_high: 0, excess: 0, degenerate: true };
  }
  const dim = Math.max(1, pts[0].length);

  const highFraction = (cloud: number[][]) => {
    let hi = 0, n = 0;
    for (let i = 0; i < cloud.length; i++) {
      for (let j = i + 1; j < cloud.length; j++) { if (resonance(cloud[i], cloud[j]) >= HIGH) hi++; n++; }
    }
    return n ? hi / n : 0;
  };

  const rand = mulberry32((opts.seed ?? 11) >>> 0);
  const nullCloud = pts.map(() => Array.from({ length: dim }, () => rand() * 2 * Math.PI));

  const observed = highFraction(pts);
  const nul = highFraction(nullCloud);
  const distinct = new Set(pts.map((p) => p.map((v) => v.toFixed(4)).join(','))).size;
  const excess = observed - nul;
  return {
    nodes: pts.length,
    distinct_phases: distinct,
    observed_high: round(observed, 4),
    null_high: round(nul, 4),
    excess: round(excess, 4),
    // Degenerate when the phases collapse onto a handful of vectors, or when
    // strongly-resonant pairs are no commoner than random scatter produces.
    degenerate: distinct < Math.max(3, pts.length * 0.5) || excess < 0.05,
  };
}

// A deterministic random-pair proposer, for the control arm: the same shape as
// a bridge maker, so scoreArm cannot tell the arms apart by their interface.
export function randomProposals(
  nodes: string[],
  count: number,
  seed = 5,
): (source: string) => Array<{ a: string; b: string }> {
  const ids = [...nodes].sort();
  return (source: string) => {
    const rand = mulberry32((seed + fnv1a(source)) >>> 0);
    const pool = ids.filter((n) => n !== source);
    const out: Array<{ a: string; b: string }> = [];
    while (out.length < count && pool.length) {
      out.push({ a: source, b: pool.splice(Math.floor(rand() * pool.length), 1)[0] });
    }
    return out;
  };
}

function round(x: number, p: number): number { const f = 10 ** p; return Math.round(x * f) / f; }

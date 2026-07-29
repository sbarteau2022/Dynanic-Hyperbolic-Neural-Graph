# Dynanic-Hyperbolic-Neural-Graph

Phase-state representation of an LLM's relational memory as a dynamic
hyperbolic neural graph, in 3 dimensions, with replay. The engine builds a
graph over recalled memory, embeds it in two complementary geometries, tests
a "wormhole edge" bridging idea against controls, and runs a recovery-rate /
stop-loss loop across successive builds.

**Computed outside the LLM. Static functions, on-device, read-only to the
model.** The graph and every geometry over it — hyperbolic (Poincaré ball),
Lorentz/hyperboloid, and the temporal-coherent evolution across builds — are
produced by pure, deterministic functions. There is no LLM anywhere in the
computation path, and no code path in this repo through which a model could
write an edge, edit a weight, or embed anything into the graph. Full spec:
[`docs/ATLAS_ENGINE_SPEC.md`](docs/ATLAS_ENGINE_SPEC.md). How this repo fits
into the wider (three-repository) system — `elle-worker` as the cloud
boundary and `Elle` as the read-only 3D viewer — is documented in
[`docs/SYSTEM_ENGINEERING.md`](docs/SYSTEM_ENGINEERING.md); this repository
is the device engine and is runnable and testable entirely on its own.

## Contents

- [What problem this solves](#what-problem-this-solves)
- [Core concepts](#core-concepts)
- [What's built](#whats-built)
- [Tech stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Usage](#usage)
- [Project structure](#project-structure)
- [The bridge, made measurable](#the-bridge-made-measurable)
- [What the benchmark actually found](#what-the-benchmark-actually-found-npm-run-bench)
- [Superposition: removing the topological veto](#superposition-removing-the-topological-veto)
- [The recall gap was a budget artifact, not a trade-off](#the-recall-gap-was-a-budget-artifact-not-a-trade-off-npm-run-benchhybrid)
- [Design decisions of record](#design-decisions-of-record)
- [CI](#ci)
- [Roadmap](#roadmap)
- [References](#references)
- [License](#license)

## What problem this solves

An LLM-adjacent memory system accumulates recall events ("these memories were
retrieved together") over time. Two questions this repo answers about that
accumulating graph, without ever letting the model touch it:

1. **What shape is the memory in, and is it changing in a way that means
   anything?** A single geometry can't answer this on its own — depth
   (how derived a memory is from its sources) and phase/recurrence (whether
   the graph keeps coming back around a regime, or keeps drifting into novel
   territory) are different axes, and a recovery/stop-loss rule that only
   watches one of them misses failure modes the other would catch.
2. **Can structurally-relevant-but-far-apart regions of the graph be found
   without a longer traversal?** Rather than assert this, the repo measures
   it directly: it embeds the graph, proposes candidate "wormhole" shortcuts,
   and runs a breadth-first evidence walk with and without them, compared
   against cheap alternatives (random and hub shortcuts) and a null control
   (the same shortcuts with the phase signal permuted away).

## Core concepts

- **Dynamic hyperbolic neural graph** — the memory graph (nodes = memory
  ids, edges = typed relations folded from recall events) embedded into a
  Poincaré ball (`src/core/hyper.ts`) via Riemannian SGD. "Dynamic" refers to
  `src/core/temporal.ts`: instead of re-fitting from scratch on every build,
  each new build warm-starts from the prior build's coordinates, seats newly
  born nodes near their already-placed neighbors, and relaxes only the
  change frontier — so node motion between builds (`atlasDrift`) is a real
  signal, not re-fit noise.
- **The Lorentz/hyperboloid chart** (`src/core/lorentz.ts`) — an
  exact-conversion alternate model of the same hyperbolic space, used as the
  numerically stable seam for repeated updates (avoids Poincaré
  boundary blow-up).
- **The torus chart** (`src/core/torus.ts`) — a flat 𝕋⁸ embedding of
  *recurrence*: each node's phase signature is read off its own
  recall-activity rhythm in the event log. This captures something the
  simply-connected Poincaré ball structurally cannot: whether a node's
  behavior is cyclical.
- **The product space** ℍⁿ×𝕋ᵈ (`src/core/product.ts`, after Gu, Sala, Gunel
  & Ré, ICLR 2019) — combines both charts and, more importantly, surfaces
  their *disagreements*: pairs close in phase but far in depth (same rhythm,
  different lineage) vs. close in depth but far in phase (same lineage,
  drifted phase).
- **Bridge / wormhole edges** (`src/core/bridge.ts`) — pairs that the
  product manifold places close together but the raw graph puts several hops
  apart (or in different components). These are *never written into the
  graph*; they are returned to the caller for one query and discarded — the
  graph "folds" momentarily rather than being permanently rewired.
- **Resonance** (`src/core/resonance.ts`) — a superposition alternative to
  the product space's convex mix: the ball stays the structural baseline
  (amplitude) and the torus modulates it (frequency), so phase agreement
  folds hyperbolic distance instead of competing with it for a mix weight.
  This is a query-time *routing score*, not a metric — it powers the default
  scoring path for `queryBridges` (see below), while `productDist` remains
  the metric of record.
- **The recovery loop** (`src/core/recovery.ts`) — after a perturbation,
  drift is expected to decay back toward baseline. `recoveryRate` /
  `recoveryTime` measure that decay, `regulate` uses recent drift history to
  choose the next build's anneal (epochs/learning rate), and `stopLoss`
  detects three concrete failure modes (re-roll, divergence, runaway
  lineage) and, when triggered, keeps the bad snapshot local instead of
  publishing it.

## What's built

171 tests, deterministic, zero runtime dependencies (`npm install && npm
test`).

| module | what |
|---|---|
| `src/core/types.ts` | edge kinds + conductance + provenance set |
| `src/core/hyper.ts` | Poincaré-ball geometry, deterministic encoder, Riemannian-SGD embedding (`hyperMap`) — derivation depth |
| `src/core/lorentz.ts` | the Lorentz/hyperboloid model — exact Poincaré↔Lorentz conversions, Minkowski distance, exp map |
| `src/core/temporal.ts` | temporal-coherent embedding — warm-start + birth-near-neighbors + local relaxation, so the graph evolves across replay steps instead of re-rolling each time |
| `src/core/structure.ts` | the graph's own shape — Betti number b₁, cycle basis, homology class, non-bridge/cycle edges (iterative Tarjan), δ-hyperbolicity, curvature signature |
| `src/core/torus.ts` | flat-torus 𝕋⁸ phase mapping — winding numbers, φ-scale weighting, golden low-discrepancy placement, translation alignment, nobility (φ-vs-rational winding) |
| `src/core/product.ts` | mixed-curvature ℍⁿ×𝕋ᵈ product space — combined distance, curvature-mix resolution, disagreements, exact winding-number recognition invariant vs. asymptotic metric return |
| `src/core/bridge.ts` | ephemeral wormhole edges — pairs proximal in the product manifold but many hops apart on the raw graph, ranked by hops-saved per geodesic unit |
| `src/core/metrics.ts` | the bridge benchmark — evidence walk (BFS with hop budget + early stop), baseline-vs-bridged comparison (coverage, effective hops, nodes expanded), contradiction-exposure rate, one-call `bridgeReport` |
| `src/core/holdout.ts` | the **temporal-holdout** evaluation — split the ledger in time, build the atlas from the past only, and score each arm against the pairs the ledger actually co-recalled afterwards. Ground truth from the log's own future, no planted signal, leakage structurally impossible |
| `src/core/bench.ts` | the controlled experiment — synthetic corpora with planted topics the embedding never sees, ground-truth recall queries, and control arms (random shortcuts, hub shortcuts, a phase-permutation null) |
| `src/core/resonance.ts` | **superposition instead of mixture** — phase agreement modulates hyperbolic distance (`d_ℍ · f(r)`) rather than being averaged against it, so a hierarchical graph can keep its depth embedding *and* still route semantically. A routing score, explicitly not a metric |
| `src/core/events.ts` | folds an append-only event log into edges (φ⁻ⁿ-weighted repeat-occurrence hygiene, capped, order-independent) |
| `src/core/phases.ts` | reads each node's torus phase signature off its own recall-activity timestamps |
| `src/core/recovery.ts` | `recoveryRate`, `recoveryTime`, `regulate`, `stopLoss` |
| `src/cartographer.ts` | `buildAtlas` — the single pure call: events → edges → every geometry core → one bundled atlas |
| `src/publish.ts` | `serializeAtlas` — canonical (key-sorted) JSON + content hash for a snapshot |

## Tech stack

- **Language/runtime:** TypeScript, ESM (`"type": "module"`), executed
  directly via [`tsx`](https://github.com/privatenumber/tsx) — no build step.
- **Test runner:** [Vitest](https://vitest.dev/).
- **Type checking:** `tsc --noEmit`, run against two configs
  (`tsconfig.json` for `src/`+`test/`, `tsconfig.scripts.json` for
  `scripts/`, which also needs Node types).
- **Runtime dependencies:** none. `devDependencies` only —
  `typescript`, `vitest`, `tsx`, `@types/node`.
- **CI:** GitHub Actions (`.github/workflows/ci.yml`) — Node 20, `npm
  install`, `npm run typecheck`, `npm test`, on every push to `main` and
  every pull request.

## Prerequisites

- Node.js (CI runs Node 20; any reasonably current Node with native ESM
  support works for local development).
- npm (ships with Node).

## Installation

```sh
git clone https://github.com/sbarteau2022/Dynanic-Hyperbolic-Neural-Graph.git
cd Dynanic-Hyperbolic-Neural-Graph
npm install
```

## Usage

```sh
npm test           # vitest run — 157 tests
npm run typecheck  # tsc --noEmit against both tsconfig files
npm run bench      # the controlled bridge-vs-controls experiment (see below)
npm run bench:hybrid # the exploration/exploitation budget sweep (see below)
```

### The full device loop

The two remaining scripts talk to a companion `elle-worker` deployment over
HTTP and are not required to develop or test this repo in isolation — `npm
test`, `npm run typecheck`, `npm run bench`, and `npm run bench:hybrid` need
no network access or environment variables at all.

```sh
export ATLAS_PULL_URL=https://<your-elle-worker-deployment>   # or ATLAS_PUSH_URL for both directions
export ATLAS_PUSH_URL=$ATLAS_PULL_URL
export ATLAS_SERVICE_KEY=<the worker's service key>

npm run sync-events     # pull the worker's append-only co-recall ledger → data/events.json
npm run publish-atlas   # events → regulated build → stop-loss gate → push snapshot to elle-worker
```

- `sync-events` (`scripts/sync-events.ts`) pages `GET
  /api/atlas/events?since=<cursor>&limit=500`, appends new events to
  `data/events.json`, and stores a monotone cursor in `data/cursor.json` so
  re-running is idempotent.
- `publish-atlas` (`scripts/publish.ts`) reads `data/events.json` (or the
  path given by `--in <path>` / `ATLAS_EVENTS_PATH`), warm-starts from
  `atlas/latest.json` if present, runs `regulate()` on the build history to
  choose the anneal, builds the atlas, runs `stopLoss`, and — only if a
  build passes and `ATLAS_PUSH_URL`/`ATLAS_SERVICE_KEY` are set — POSTs the
  snapshot to `$ATLAS_PUSH_URL/api/atlas/ingest`. It always writes
  `atlas/<hash>.json`, `atlas/latest.json`, `atlas/history.json`, and
  `atlas/metrics.json` (the bridge report for that build's real graph)
  locally regardless of whether the push happens. Exit codes: `0` published
  (or written locally with push env unset) · `1` no events, or a push/pull
  failure · `2` stop-loss triggered — snapshot quarantined locally, not
  pushed.
- `data/events.json`, `data/cursor.json`, and `atlas/` are gitignored — they
  are a given machine's local state, not source. `data/events.example.json`
  shows the event shape (`{kind, src, dst, weight, ts}`) if you want to try
  `publish-atlas` without a live worker: `npm run publish-atlas -- --in
  data/events.example.json` builds and writes a snapshot locally (the push
  step is skipped without `ATLAS_PUSH_URL`/`ATLAS_SERVICE_KEY`).

## Project structure

```
.
├── docs/
│   ├── ATLAS_ENGINE_SPEC.md      # design spec: the read-only invariant, data model, migration plan
│   └── SYSTEM_ENGINEERING.md     # the full three-repo system as implemented (device + worker + viewer)
├── data/
│   └── events.example.json       # sample MemEvent[] for local publish-atlas runs
├── scripts/
│   ├── bench.ts                  # CLI: prints the controlled-experiment tables (npm run bench)
│   ├── hybrid.ts                 # CLI: resonance/random budget sweep (npm run bench:hybrid)
│   ├── publish.ts                # CLI: events → atlas → stop-loss gate → push (npm run publish-atlas)
│   └── sync-events.ts            # CLI: pull elle-worker's event ledger (npm run sync-events)
├── src/
│   ├── cartographer.ts           # buildAtlas: events → edges → all geometry cores → one atlas
│   ├── publish.ts                # serializeAtlas: canonical JSON + content hash
│   └── core/
│       ├── types.ts              # edge kinds, conductance, provenance
│       ├── hyper.ts              # Poincaré-ball embedding
│       ├── lorentz.ts            # Lorentz/hyperboloid model
│       ├── temporal.ts           # warm-started, drift-tracked embedding
│       ├── structure.ts          # graph invariants, cycle basis, curvature signature
│       ├── torus.ts              # flat-torus phase embedding
│       ├── product.ts            # mixed-curvature product space + disagreements
│       ├── bridge.ts             # wormhole/bridge edge candidates
│       ├── metrics.ts            # bridgeReport — the baseline-vs-bridged benchmark
│       ├── bench.ts              # synthetic corpora + control arms for scripts/bench.ts
│       ├── resonance.ts          # superposition routing score — phase modulates hyperbolic distance
│       ├── events.ts             # event log → edges
│       ├── phases.ts             # event log → per-node torus phase signature
│       └── recovery.ts           # recoveryRate, recoveryTime, regulate, stopLoss
├── test/                         # one *.test.ts per src/core module + cartographer/publish
├── tsconfig.json                 # src/ + test/
├── tsconfig.scripts.json         # extends tsconfig.json, adds Node types, includes scripts/
└── package.json
```

## The bridge, made measurable

`bridgeEdges` (`bridge.ts`) reads candidate wormholes off the atlas: pairs
the ℍⁿ×𝕋ᵈ manifold puts close together that the raw topology puts ≥ 3 hops
apart (or in different components), ranked by hops-saved per geodesic unit.
They are returned to the caller, never written into the graph.

Whether folding buys anything is not asserted — it is measured.
`bridgeReport` (`metrics.ts`) runs the same breadth-first evidence walk
twice over the same graph, baseline vs. bridged, and reports the deltas on:

- **evidence coverage** — fraction of the query's evidence set (its k
  geodesically-nearest nodes) reached inside the hop budget
- **effective traversal length** — mean hops, with unreached targets charged
  budget + 1 so a miss is a cost, not a silent drop
- **compute** — nodes expanded before the walk could stop
- **contradiction exposure** — how often both sides of a `contradicts` pair
  land inside one query's horizon, reached through independent evidence
  paths

```ts
const atlas = hyperMap([], edges);
const report = bridgeReport(atlas.points, edges, { budget: 6, k: 4 });
report.traversal.delta;      // { coverage, effective_hops, expanded } — bridged − baseline
report.contradictions.delta; // exposure-rate gain
```

If the deltas are ~0 on a given graph, the honest reading is that the
graph's topology already agrees with its geometry and the bridge has
nothing to add there.

## What the benchmark actually found (`npm run bench`)

`bridgeReport` only shows the bridge beating *nothing*. The claim that
matters is whether it beats cheap alternatives, so `src/core/bench.ts` runs
a controlled experiment: synthetic corpora where every node carries a
planted TOPIC the embedding is never shown, topics manifest only as shared
recall PHASE, and lineage edges deliberately cross-cut them. Ground truth
(not geometry) decides what counts as relevant, and the geometry arm spends
the same edge budget as three controls: RANDOM shortcuts, HUB shortcuts,
and a phase-PERMUTATION null.

Ring topology (no dominant hub), cross-cutting topics, 3 bridges/query,
4-hop budget (reproduced by `npm run bench`, deterministic):

| arm | recall | effective hops | bridges on-topic |
|---|---|---|---|
| baseline (no bridges) | 0.241 | 4.61 | — |
| **geometry (diversified)** | 0.588 | **3.14** | **63/72** |
| random shortcuts | 0.639 | 3.47 | — |
| hub shortcuts | 0.560 | 3.67 | — |
| geometry, phase-permuted (null) | 0.569 | 3.67 | 18/72 |

Three findings, including one that is not flattering:

1. **The manifold identifies the right pairs.** 63 of 72 query-induced
   bridges join genuine topic-mates; under the permutation null that
   collapses to 18/72. The precision comes from the phase signal, not from
   the act of adding edges.
2. **It reaches relevant evidence in fewer hops than either control**, and
   that advantage also vanishes under the null (3.14 → 3.67, which is
   exactly the hub arm's number).
3. **It does not beat random scattering on recall breadth** (0.588 vs.
   0.639). Three bridges aimed at the nearest topic-mates buy precision;
   three random shortcuts land in three different regions and sweep up
   more of the class incidentally. Diversifying bridge selection
   (`diversify: true`) recovers part of the gap but does not close it.

`npm run bench` runs a fuller sweep than the single row above (star vs.
ring topology, crosscut/aligned/shuffled corpora, and a scope/mix ablation
table) and prints it directly rather than reproducing it here.

Caveat: these are synthetic corpora with a planted signal, chosen so
ground truth exists at all. They establish that the mechanism works and
beats simpler alternatives on one axis; they do not establish that real
recall ledgers have this structure. Running the same harness against a
real event log is the next measurement, not a settled result.

## Superposition: removing the topological veto

The second finding above — that the topology-derived mix suppresses the phase
chart — turned out to be worse than "suppresses" on measurement. A star
corpus is a **forest**, so `curvatureSignature` computes toroidal pull
b₁/(b₁+C) = 0 **exactly**. The mix comes out `{hyperbolic: 1, toroidal: 0}`
and the torus contributes **0.0%** of the distance. The 2/8 on-topic result
was not a weak signal; it was chance, because the chart carrying cross-lineage
kinship had been switched off precisely where hierarchy makes it the only
thing worth knowing.

The cause is that a convex mix is zero-sum: the two charts compete for one
scalar, so a structural prior can veto a semantic one. `src/core/resonance.ts`
removes the competition by making the charts a **superposition** rather than a
mixture — the ball is amplitude, the torus is frequency, and phase agreement
*modulates* hyperbolic distance instead of being averaged against it:

```
D(a,b) = d_ℍ(a,b) · f(r(a,b))        r = φ-weighted mean cos(Δθ) ∈ [−1,1]
f(r)   = max(floor, 1 − gain · max(0,r)^sharpness)
```

Resonant pairs pinch together wherever they sit on the tree; clashing pairs
keep their true topological distance. There is no weight to infer, so the veto
is structurally impossible. Three deliberate properties, each pinned by a test:

- **One-sided.** Only agreement pulls. Unrelated pairs sit at r ≈ 0 by
  construction, so f(0) must be exactly 1 — a two-sided gate (e.g.
  `exp(−κ(1+r)/2)`) shrinks *every* pair at r = 0, which is a global rescale
  wearing a fold's clothing.
- **Sharpened.** Random phase vectors carry non-zero |r| by chance; the
  exponent means only strong agreement earns a fold.
- **Floored.** Without a floor a spuriously resonant pair lands at distance
  ≈ 0 regardless of true separation, and the deformation is unbounded.

Same benchmark, resonance added as an arm (per-query, diversified):

| topology | arm | recall | eff. hops | on-topic |
|---|---|---|---|---|
| star | geometry (balanced mix) | 0.657 | 3.10 | 58/72 |
| star | **resonance** | 0.648 | **2.94** | **71/72** |
| star | random / hub | 0.667 / 0.611 | 3.42 / 3.60 | — |
| ring | geometry (balanced mix) | 0.588 | 3.14 | 63/72 |
| ring | **resonance** | 0.611 | **3.01** | **72/72** |
| ring | random / hub | 0.639 / 0.560 | 3.47 / 3.67 | — |
| star | resonance, phase-permuted (null) | 0.699 | 3.34 | 18/72 |
| ring | resonance, phase-permuted (null) | 0.643 | 3.37 | 23/72 |

Bridge precision goes to **71/72 and 72/72** — essentially every wormhole it
opens joins a genuine topic-mate — collapsing to 18–23/72 under the
permutation null. Effective hops become the best of any arm on both
topologies, and on the topology-aligned corpus resonance reaches full recall
while expanding roughly *half* the nodes of any other arm (154–174 vs
297–405). Crucially it does this with **no mix inference at all**, so star and
ring are treated identically.

At this 3-edge budget resonance still trails random scattering on raw recall
(0.648 vs 0.667; 0.611 vs 0.639) — which looked, across three iterations, like
a structural precision/breadth trade-off. **It is not.** See the next section.

**`resonantDist` is not a metric, and must not be described as one.**
Multiplying a distance by a pairwise gate breaks the triangle inequality — if
a resonates with b and b with c while a clashes with c, D(a,c) can exceed
D(a,b) + D(b,c). There is a test that asserts exactly this failure. That is
acceptable, arguably the point, for a query-time routing score that decides
which wormholes to open, and disqualifying for a geometry. `productDist`
remains the metric (Gu et al.); resonance sits beside it as a second
instrument, and `scoring: 'product'` is still the default everywhere.

## The recall gap was a budget artifact, not a trade-off (`npm run bench:hybrid`)

The recall deficit survived global bridges, query-induced bridges, and
superposition scoring, which made it look like a structural invariant — a
genuine exploration/exploitation split, with resonance doing *semantic
tunneling* and random shortcuts doing *topological expansion*. The obvious
architecture would then be a hybrid: spend most of the budget on resonance and
a little on random shortcuts to recover breadth.

That hypothesis was tested by holding the per-query edge budget fixed and
sweeping the allocation. **It is refuted.** Every random edge added at a
6-edge budget costs *both* recall and hops, monotonically, on both topologies:

| split (B=6, ring) | recall | eff. hops | resonance precision |
|---|---|---|---|
| 6 res + 0 rand | **0.889** | **1.73** | 94% |
| 5 res + 1 rand | 0.843 | 1.92 | 100% |
| 3 res + 3 rand | 0.824 | 2.36 | 100% |
| 0 res + 6 rand | 0.796 | 2.85 | — |

The Pareto frontier is a single point at 0% random. The reason shows up in a
budget sweep of pure resonance against pure random:

| bridges/query | resonance recall / hops | random recall / hops | recall winner |
|---|---|---|---|
| 2 | 0.486 / 3.55 | 0.556 / 3.78 | random |
| 3 | 0.611 / 3.01 | 0.639 / 3.47 | random |
| **4** | **0.736 / 2.46** | 0.713 / 3.27 | **resonance** |
| 6 | 0.889 / 1.73 | 0.796 / 2.85 | resonance |
| 10 | 0.991 / 1.19 | 0.912 / 2.23 | resonance |

(ring; star crosses at the same budget and is within 0.02 throughout)

The crossover is at **4 bridges per query, identical on both topologies**, and
past it the advantage *widens* rather than saturating. Below the crossover,
three bridges can only reach three of a topic's ~11 members directly, so
scattering picks up more by luck; above it, diversified resonance covers the
class directly and luck stops competing. Resonance wins effective hops at
*every* budget, including the ones where it loses recall — the two axes were
never actually coupled.

**The architectural conclusion is the opposite of a hybrid: don't spend the
budget on exploration, spend a large enough budget.** Mixing in random
shortcuts is strictly dominated at any budget where the method is worth using
at all.

`queryBridges` therefore **defaults to 6 bridges per query** — set from this
crossover, not from taste: clear of the inversion at 4, with headroom, and at
the point where the allocation sweep's Pareto frontier collapses to a single
all-resonance point. The benchmark tables above deliberately stay at 3, one
edge *below* the crossover, because that is the setting most favourable to the
controls: the shipped configuration should not be the one the comparison is
run at.

One honest note on the null: inside a hybrid, recall is unchanged when phases
are shuffled (0.866 signal vs 0.866 null on star) while hops degrade
(1.91 → 2.65) and precision collapses (99% → 26%). Recall breadth is bought by
adding edges, whatever they are; depth and precision are what the signal buys.

Caveat worth stating plainly: these are synthetic corpora with a planted
signal, chosen so ground truth exists at all. They establish that the
mechanism works and that it beats simpler alternatives on one axis; they do
not establish that real recall ledgers have this structure. Running the same
harness against a real event log is the next measurement, not a settled
result.

## Design decisions of record

- **Bridges must be query-induced, not global.** A single global bridge set
  for the whole graph lost badly to random rewiring, because a handful of
  shortcuts only help queries sitting on their endpoints, while random
  rewiring shortens the diameter for everyone. `queryBridges` folds the
  manifold per query instead.
- **The curvature mix read from topology can suppress the signal.** On a
  tree-like corpus, `curvatureSignature` weights the ball heavily, and the
  ball alone cannot see cross-lineage kinship. A mix inferred from topology
  alone is the wrong prior when the phase chart is carrying the
  information — see the `balanced` mix arm in `scripts/bench.ts`.
- **Events, not edges, cross into the device.** Recall events are folded
  into edges on-device (`core/events.ts`) with φ⁻ⁿ repeat-occurrence
  hygiene, so the graph is always re-derivable from an immutable, append-only
  event log rather than depending on externally-computed edge weights.
- **Temporal coherence via warm-start / birth-near-neighbors / frozen
  interior** (the static analogue of HTGN's principle) was chosen over a
  trained network, to keep the engine deterministic and model-free.

## CI

`.github/workflows/ci.yml` runs on every push to `main` and every pull
request: Node 20, `npm install --no-audit --no-fund`, `npm run typecheck`,
`npm test`.

## Roadmap

- **3D viewer with replay.** The companion `Elle` workbench renders the
  latest snapshot (read-only) today; replaying across snapshot history —
  watching a memory drift, split, or be absorbed over time — is the
  remaining piece, and lives outside this repo.
- **Feature/phase enrichment.** Nodes currently carry no
  `nodeFeatures`/`nodePhases` through the sync path, so torus placement
  falls back to golden-lattice placement for all real nodes until the
  device computes phases locally from richer signal than event timestamps
  alone.

## References

- Nickel & Kiela, *Poincaré Embeddings for Learning Hierarchical
  Representations*, NeurIPS 2017; *Learning Continuous Hierarchies in the
  Lorentz Model*, ICML 2018.
- Yang et al., *Hyperbolic Temporal Graph Network (HTGN)*, KDD 2021 —
  [arXiv:2107.03767](https://arxiv.org/abs/2107.03767).
- Bai et al., *HGWaveNet*, WWW 2023 —
  [arXiv:2304.07302](https://arxiv.org/abs/2304.07302).
- Rossi et al., *Temporal Graph Networks*, 2020 —
  [arXiv:2006.10637](https://arxiv.org/abs/2006.10637).
- Gu, Sala, Gunel & Ré, *Learning Mixed-Curvature Representations in
  Product Spaces*, ICLR 2019.

## License

MIT.

## Does the atlas anticipate recall, or only record it? (`npm run holdout`)

Every result above comes from corpora where the phase signal was planted by
the same code that later found it. That establishes the mechanism works. It
cannot establish that a real recall ledger has this structure — and if it
doesn't, resonance degrades to its permutation null and the whole apparatus is
a correct instrument with nothing to measure.

`src/core/holdout.ts` removes the synthetic corpus and takes ground truth from
the ledger's own future:

1. Split the event log **chronologically** at a cut time T (by time quantile,
   not index — bursty logs would otherwise put wall-clock-adjacent events on
   opposite sides).
2. Build the atlas from the **before** half only.
3. Ground truth = pairs co-recalled **after** T that were **not already
   adjacent** before T. Re-firing an existing edge is the graph repeating
   itself, not a prediction, so it does not count.
4. Ask each arm for k bridges per source; count how many land on those future
   links.

The answer key lives strictly in the atlas's future, so leakage is
*structurally* impossible rather than merely avoided. No labels are needed —
the ledger supplies both the input and the answer.

**Read `phase signal` first.** It reports whether the derived phases carry any
rhythm at all. If it says `DEGENERATE`, every arm below is measuring nothing.
Note the null here is **freshly sampled random phases, not a permutation**:
relabelling which node holds which phase vector leaves the multiset of
pairwise resonances *exactly* unchanged, so a permutation-based diagnostic
reports "no structure" even on visibly clustered data. (Permutation remains
the right null for the *arms*, which tie phase to node identity — that
correspondence is exactly what it destroys.)

Instrument validation, on a ledger whose rhythm is planted (96 nodes, 1204
events, phases derived through the real `phases.ts` path from event timing —
never handed in):

| arm | precision | recall | lift vs random |
|---|---|---|---|
| **resonance** | **0.1354** | 0.538 | **6.51×** |
| product | 0.0729 | 0.346 | 3.50× |
| resonance, phase-permuted null | 0.0182 | 0.077 | 0.88× |
| random | 0.0208 | 0.154 | 1.00× |
| hub | 0.0313 | 0.135 | 1.50× |

The harness detects a strong effect when one exists, and the null collapses to
chance. It also refuses to manufacture one: on the 6-event example ledger it
reports `DEGENERATE`, and on a 24-node run where resonance led random by only
1.10× it reports `INCONCLUSIVE` rather than claiming a win — a method
proposing k of n nodes scores well by chance on a small graph, and that margin
is sample size, not evidence.

**This validates the instrument, not the method on real data.** The rhythm
above was planted. Running

```sh
npm run sync-events     # pull the real ledger (needs ATLAS_PULL_URL + ATLAS_SERVICE_KEY)
npm run holdout         # the same experiment, on real recall history
```

is the measurement that decides whether bridges are worth wiring into
retrieval. Until it has been run, the synthetic results are a reason to try,
not a reason to ship.

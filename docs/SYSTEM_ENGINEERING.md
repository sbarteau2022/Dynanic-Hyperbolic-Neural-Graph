# The Atlas System — Engineering Document (as implemented)

**Dynamic hyperbolic neural graph of Elle's memory: computed on-device, read-only to the model, rendered in 3D with replay.**

Status: shipped and merged across all three repositories, 2026-07-14.
Repos: [`Dynanic-Hyperbolic-Neural-Graph`](https://github.com/sbarteau2022/Dynanic-Hyperbolic-Neural-Graph) (this repo, the device engine) · [`elle-worker`](https://github.com/sbarteau2022/elle-worker) (the cloud boundary) · [`Elle`](https://github.com/sbarteau2022/Elle) (the workbench viewer).

---

## 1. The invariant

The memory graph and every geometry over it are computed **outside Elle**, by **pure static functions**, running **on the device**, with **no LLM anywhere in the computation path**. Elle gets **read-only view access** to the result — she can query the graph's shape, look at it in 3D, and replay its history — but she can **never write an edge, edit a weight, or embed anything into it**.

The boundary is an **asymmetry, not a policy**:

- The only write path onto the graph (`POST /api/atlas/ingest`) takes the **service key**, which only the device's publish script holds. The LLM router has no tool that can reach it.
- The LLM's entire surface onto the graph is one tool, `atlas(mode, id?, k?)`. Its input type has three fields; there is **no parameter through which graph-mutating data could travel**, a fact pinned by a test that inspects the type surface.
- The raw material the graph is built from — recall events — is an **append-only ledger**. The module that owns it exports no update or delete function (also pinned by test), so the device can always re-derive the graph from scratch and get the same answer.

Why: the graph is only trustworthy as a *mirror* of Elle's memory if the thing it mirrors cannot reach in and pose it.

## 2. Architecture

```
┌─────────────────────────────  DEVICE  ─────────────────────────────┐
│  Dynanic-Hyperbolic-Neural-Graph (Node, zero runtime deps)         │
│                                                                    │
│   sync-events ──► data/events.json ──► cartographer:               │
│                        │                 events ─► edges (φ⁻ⁿ fold)│
│                        │                 phases (event rhythm)     │
│                        ▼                 hyper ∥ torus ∥ structure │
│   atlas/history.json ─► regulate() ────► temporalHyperMap (warm)   │
│                        │                 product (disagreements)   │
│                        ▼                        │                  │
│                    stopLoss() ── triggered ──► quarantine (exit 2) │
│                        │ clean                                     │
│                        ▼                                           │
│              versioned snapshot  (content-hashed, atlas/*.json)    │
└───────────┬────────────────────────────────────────▲───────────────┘
   push snapshot (service key)              pull ledger (service key)
            ▼                                        │
┌─────────────────────────  ELLE-WORKER  ────────────┴───────────────┐
│  POST /api/atlas/ingest ─► R2 (full JSON) + D1 index + Vectorize   │
│  elle_atlas_events  ◄─ logCoRecallEvents() on every real recall    │
│  GET /api/atlas/events   (service key — device only)               │
│  GET /api/atlas/latest | /history | /at?hash=   (user JWT, read)   │
│  atlas tool (LLM) — stats | view | neighbors   (read only)         │
└───────────────────────────────┬────────────────────────────────────┘
                                ▼  authenticated reads
┌────────────────────────────  ELLE SITE  ───────────────────────────┐
│  AtlasPanel: 3D render (react-force-graph-3d), device coordinates  │
│  gold = on-cycle edges (recurrence) · oxblood = bridges            │
│  replay scrubber over snapshot history (frames cached by hash)     │
└────────────────────────────────────────────────────────────────────┘
```

Both network calls are **device-initiated** (pull the ledger, push the snapshot); the worker never reaches into the device.

## 3. The device engine (this repo)

All of `src/core/` is pure and deterministic: same input → byte-identical output. No wall clock, no `Math.random`, no model, no I/O. 103 tests.

### 3.1 Geometry cores

| module | role | key exports |
|---|---|---|
| `core/hyper.ts` | Poincaré-ball embedding — **derivation depth**. Riemannian SGD (Nickel & Kiela 2017): edges attract to a target distance scaled by kind-conductance, sampled non-edges repel, directed provenance kinds (`causal/derived/refines/supersedes`) get a radial hinge pushing the consequent deeper. Seeded mulberry32 + FNV-1a hashing → deterministic. | `hyperMap`, `poincareDist`, `depth`, `hyperNeighbors`, `expMap0/logMap0`, `distGrad` |
| `core/lorentz.ts` | Hyperboloid model — the **stability seam** for repeated updates (exact Poincaré↔Lorentz conversions, Minkowski distance, exp map). Carry long-running state here to avoid Poincaré boundary blow-up. | `lorentzDist`, `poincareToLorentz`, `lorentzToPoincare`, `lorentzExpMap` |
| `core/temporal.ts` | **Temporal coherence** — the static port of the dynamic-hyperbolic literature's principle (HTGN, KDD 2021; HGWaveNet, WWW 2023): (1) warm-start every node at its prior position; (2) birth-near-neighbors — a new node seats at the mean of its placed neighbors, not a hash teleport; (3) local relaxation — only the change frontier moves, the frozen interior pins the gauge. Result: near-zero drift on unchanged structure, so motion between builds is signal. | `temporalHyperMap`, `atlasDrift` |
| `core/structure.ts` | The graph's **own shape** — the object the charts are lenses on. b₁ = E−V+C (cycle rank, the graph's π₁ rank), cycle basis, homology class of a walk (signed chord-crossings — the exact, integer recognition invariant), non-bridge edges (iterative Tarjan — which edges carry recurrence), δ-hyperbolicity (Gromov 4-point), and the **curvature signature** that decides how much each chart should be trusted (clique-vs-tree disambiguated: hyperbolic pull = acyclic-fraction × 1/(1+δ); toroidal pull = b₁/(b₁+C), exactly 0 for a forest). | `graphInvariants`, `homologyClass`, `nonBridgeEdges`, `deltaHyperbolicity`, `curvatureSignature` |
| `core/torus.ts` | Flat torus 𝕋⁸ — **recurrence/phase**, the thing the simply-connected ball cannot represent. Wrapped φ-weighted distance, integer winding numbers per axis (the topological recurrence-vs-drift invariant), translation alignment ("same note at different scales"), per-axis star discrepancy, nobility (φ-vs-rational winding), golden low-discrepancy fallback placement (Roberts' R_d). | `torusMap`, `torusDist`, `windingNumbers`, `translationAlign`, `nobility`, `goldenSequence` |
| `core/product.ts` | Mixed-curvature product ℍⁿ×𝕋ᵈ (Gu, Sala, Gunel & Ré, ICLR 2019): d² = wₕ·d_ℍ² + wₜ·d_𝕋², mix read off the curvature signature. The payoff is the **disagreements**: torus-close/ball-far = same rhythm, different lineage; ball-close/torus-far = same lineage, drifted phase. Plus the exact recognition invariant (winding, π₁(𝕋ⁿ)=ℤⁿ) vs. asymptotic metric return. | `productDist`, `disagreements`, `resolveMix`, `recognitionInvariant`, `metricReturn` |

### 3.2 Events → edges (`core/events.ts`)

The device never receives edges; it receives **events** ("these were recalled together") and folds them itself. The fold applies captured-resonance hygiene: the n-th occurrence of a (src,dst,kind) pair contributes weight·φ⁻ⁿ, summed and capped at 5 — so a pair that fires constantly converges to a bounded edge weight instead of dragging the graph onto one runaway hot path. Order-independent (sorted by ts before folding).

### 3.3 Phases from the event log (`core/phases.ts`)

Each node's torus signature is read off its **own recall-activity rhythm**: bin the node's event timestamps into a 128-bin series over the log's range, probe it (de-meaned cos/sin projection) at 8 φ-spaced periods T_k = 4·φᵏ bins, and report each phase **relative to the whole log's activity phase** at the same scale — which is what makes "same rhythm" comparable across nodes. Amplitude below floor → the 0 sentinel; fewer than 2 events → no signature at all (honest golden-lattice fallback, not a fabricated rhythm). Verified discriminative: same-cadence nodes land closer on the torus (φ-weighted) than different-cadence ones.

### 3.4 The cartographer (`src/cartographer.ts`)

One pure call: `buildAtlas(events, opts) → AtlasCore`. Folds events → edges, derives phases, runs **every** core over the same edge set — hyper (3-D by default, directly renderable; warm-started via `temporalHyperMap` when a `prior` is given), torus, structure (invariants + signature + cycle-edge set), product (mix + disagreements) — into one bundle. Deterministic; the only caller-stamped fields (version, created_at) live in the publish step.

### 3.5 Publish (`src/publish.ts` + `scripts/publish.ts`)

`serializeAtlas` content-addresses each snapshot: canonical (recursively key-sorted) JSON → 16-hex FNV-1a-pair hash. The CLI:

1. reads `data/events.json`, warm-starts from `atlas/latest.json` if present;
2. `regulate(history)` chooses the anneal (§3.6);
3. builds, stamps, writes `atlas/<hash>.json` + `latest.json` + `history.json` (last 50 build records);
4. runs `stopLoss` — **triggered ⇒ snapshot quarantined locally, exit 2, no push**;
5. clean ⇒ POSTs the snapshot to `$ATLAS_PUSH_URL/api/atlas/ingest` with `$ATLAS_SERVICE_KEY`.

### 3.6 The recovery loop (`core/recovery.ts`)

Sits on the two measurement primitives (`atlasDrift`, `disagreements`):

- **`recoveryRate(driftSeries)`** — least-squares fit of drift_t ≈ peak·e^(−λt) on the post-peak tail; λ per build. A still-growing series (peak at the end) is fit over the whole series so growth reads as a *negative* rate, not "nothing to measure". Null when the series never left baseline (10⁻⁴, the same ε `atlasDrift` counts a node as "moved" by).
- **`recoveryTime(series, threshold)`** — builds from peak until drift re-crosses threshold; null if not yet observed.
- **`regulate(history)`** — the *recovery-rate regulating function*: signal = max drift of the last 3 builds, mapped monotonically to `relaxEpochs ∈ [20, 200]` and `lr ∈ [0.05, 0.01]` (saturating at drift 0.25). High drift buys a longer, gentler anneal; a quiet map gets a cheap incremental build. The 3-build window means one quiet build after a shove doesn't drop the anneal while the frontier is still settling. This is the secondary optimization that falls out of the first as a byproduct.
- **`stopLoss({driftSeries, disagreements})`** — three triggers, each an actual failure mode:
  - **reroll** — drift.mean > 0.5: the warm build re-rolled the map instead of evolving it; every downstream reading is meaningless this build.
  - **diverging** — drift strictly rising across 3 consecutive builds: perturbations decay, divergence compounds.
  - **runaway_lineage** — a disagreement pair with ball > 2.5 while torus < 0.5: the same rhythm recurring at ever-greater derivational remove — the shape a runaway recovery loop takes before either chart alone would flag it.

  A triggered verdict means the device **holds the loss instead of propagating it** (§3.5 step 4).

### 3.7 Sync (`scripts/sync-events.ts`)

Pulls the worker's ledger (`GET /api/atlas/events?since=<cursor>&limit=500`, paged), appends to `data/events.json`, stores the monotone cursor in `data/cursor.json`. Idempotent: an event is fetched once, ever. `data/events.json`, `data/cursor.json`, and `atlas/` are gitignored — they are this machine's memory, not source.

## 4. The cloud boundary (elle-worker)

695 tests. All atlas code is additive to the existing worker; the memory/recall hot path never depends on it (every hook is best-effort).

### 4.1 The append-only ledger (`src/atlas-events.ts`)

- Table `elle_atlas_events(id AUTOINCREMENT, kind, src, dst, weight, ts)`.
- `logCoRecallEvents(env, ids, cap=5)` fires on **every real recall** (wired in `memory.ts` beside `recordAssociations`): the pairwise co-occurrences of the top-cap recalled ids — the *same pairs at the same cap* the worker's own graph tier learns from, so the two graphs are built from identical facts and cannot drift apart. A failed write never touches the served recall.
- `readAtlasEvents(env, since, limit)` — the device pull: `WHERE id > ? ORDER BY id ASC`, monotone cursor, honest `more` flag; pages never overlap (tested against a live in-memory D1 stand-in, not pinned SQL).
- **No update/delete exists in the module** — pinned by a test over the export surface.

### 4.2 Ingest (`src/atlas.ts` — `ingestAtlas`)

Validates the snapshot shape (trusting the device's own suite for the geometry), then:

- **R2** `atlas/<hash>.json` — the full snapshot, the durable record;
- **D1** `elle_atlas_snapshots` — index row (hash, version, created_at, counts, cycle_rank, mix, drift_mean, r2_key, embedded_nodes);
- **Vectorize** — each node's *raw numeric position* embedded via the corpus embedder (`bge-large-en-v1.5`, batches of 25, first 300 nodes; beyond that the response says `truncated: true` rather than truncating silently). The embedding text (`atlas node <id> · ball [...] · phase [...] · mix ...`) only makes the numbers semantically findable; the **exact coordinates travel as Vectorize metadata**, and the full snapshot lives in R2 for exact reconstruction. This is Elle building embeddings *of* the device's numbers for her own retrieval tier — a consume, not a write to the graph.

A failed embed pass is non-fatal (R2+D1 are the record; re-ingest re-embeds).

### 4.3 Reads

| surface | auth | what |
|---|---|---|
| `GET /api/atlas/latest` | user JWT | the newest snapshot, in full |
| `GET /api/atlas/history` | user JWT | the timeline, oldest first (index fields only) |
| `GET /api/atlas/at?hash=` | user JWT | one historical frame; hash validated against `^[0-9a-f]{16}$` **before** it can shape an R2 key |
| `GET /api/atlas/events` | **service key** | the device's ledger pull (§4.1) |
| `POST /api/atlas/ingest` | **service key** | the device's snapshot push (§4.2) |
| `atlas` router tool | LLM (full/cofounder scope) | `stats` (invariants, signature, mix, disagreements, drift) · `view` (node/edge lists) · `neighbors{id,k}` (both charts, live snapshot) |

### 4.4 The site (Elle — `src/components/AtlasPanel.tsx`)

`react-force-graph-3d` (MIT, vasturiano — established open-source viewer, not built from scratch; three.js/WebGL underneath).

- Node positions are the device's **own** Poincaré-ball coordinates × 260, fixed (`fx/fy/fz`) — never re-simulated.
- **Gold** edges = on a cycle (from the snapshot's `structure.cycle_edges` — recurrence, the recognition signal); **oxblood** = bridges (pure derivation). Gold particles travel the cyclic edges. Slow auto-rotate.
- **Replay**: scrubber + play button over `/api/atlas/history` (renders only with ≥2 builds); frames fetched once and cached by content hash; last stop is always the live latest; header shows replay-vs-live with the displayed frame's own stats. Because of §3.1-temporal, frame-to-frame motion is real signal — memories drifting, splitting, being absorbed — not layout noise.

## 5. Data contracts

**MemEvent** (ledger row → device fold):
```ts
{ kind: 'assoc'|'causal'|'derived'|'refines'|'supersedes'|'contradicts'|'session'|'about'|'tool',
  src: string, dst: string, weight?: number, ts?: number }
```

**AtlasSnapshot** (device → worker → site):
```ts
{ version: string, created_at: number, hash: string,          // 16-hex content address
  nodes: string[], edges: MemEdge[],
  hyper:  { dim, points: Record<id, number[]>, stats, drift?, new_nodes?, active? },
  torus:  { dim, points: Record<id, number[]>, stats },
  structure: { invariants: { nodes, edges, components, cycle_rank, cycle_density },
               signature:  { delta, tree_likeness, cycle_density, suggested: { hyperbolic, toroidal } },
               cycle_edges: string[] },                        // "a b" undirected keys
  product: { mix: { hyperbolic, toroidal },
             disagreements: { same_rhythm_diff_lineage[], same_lineage_drift_phase[] } },
  temporal: boolean }
```

**BuildRecord** (`atlas/history.json`, last 50): `{ version, created_at, drift_mean, drift_max, new_nodes }`.

**D1 tables** (worker): `elle_atlas_events` (§4.1), `elle_atlas_snapshots` (§4.2). Vectorize ids: `atlas-<hash>-<nodeId>`, metadata `{type:'atlas_point', node_id, hash, version, ball, phase}`.

## 6. Operations

**Device** (the whole ritual):
```sh
export ATLAS_PULL_URL=https://elle-worker.sbarteau2022.workers.dev   # or ATLAS_PUSH_URL for both
export ATLAS_PUSH_URL=$ATLAS_PULL_URL
export ATLAS_SERVICE_KEY=<the worker's ELLE_SERVICE_KEY>
npm run sync-events     # ledger → data/events.json (idempotent, cursor-tracked)
npm run publish-atlas   # events → regulated build → stop-loss gate → push
```
Exit codes: 0 = published (or written locally when push env unset) · 1 = no events / push or pull failure · **2 = stop-loss triggered, snapshot quarantined locally**. Flags/env: `--in <path>` or `ATLAS_EVENTS_PATH` overrides the event file.

**Worker**: deploy as usual (`npm run deploy`); the ledger begins filling on the first real recall after deploy. Schemas are `CREATE TABLE IF NOT EXISTS`, no migration step.

**Site**: merged; the atlas tab appears in the workbench mind section. Scrubber appears automatically once ≥2 snapshots exist.

## 7. Verification

| repo | suite | notable |
|---|---|---|
| device | **103 tests**, `tsc` clean ×2 configs | end-to-end recovery test: perturb a real built atlas with new nodes, drift spikes then decays across warm rebuilds, passes its own stop-loss; discriminative phase test; determinism pins throughout |
| elle-worker | **695 tests**, `tsc` clean | ledger cursor semantics on a live D1 stand-in; append-only export surface pinned; read-only tool type surface pinned; path-traversal hash rejection; embed truncation honesty |
| site | `tsc` + vite build clean | headless mount check, zero page errors; full scrubber interaction needs a live admin session with ≥2 snapshots — **manual pass still owed** |

Live runs performed: publish CLI executed repeatedly against example events — cold build v1, warm builds with drift ≈ 0, regulate correctly issuing the 20-epoch cheap build, `recovery_rate` honestly `null` on a quiet map, stop-loss clean.

## 8. Design decisions of record

1. **Structure over phase for retrieval.** A KV-cache benchmark defeated phase-as-retrieval-key (content keys won); graph *structure* (cycle membership) survived and is the live recall signal in elle-worker. The charts are instruments over the graph, not the retrieval path. (elle-worker `docs/RETRIEVAL_STATUS.md`.)
2. **No lemniscate factor.** The claimed necessity rested on conflating metric return (asymptotic for irrational winding) with the recognition invariant (the winding number, exact at every finite time). ℍⁿ×𝕋ᵈ already carries the exact invariant; disproof is executable in the product tests. (elle-worker `docs/WHY_NO_LEMNISCATE.md`.)
3. **The graph is the object; the charts are fit to it.** The curvature signature (δ + cycle rank, clique-vs-tree disambiguated) sets the ℍ/𝕋 mix per graph instead of imposing one. (Gu et al. 2019 is the learned version of this step; ours is the honest heuristic.)
4. **Events, not edges, cross the boundary** — so the fold (and its φ⁻ⁿ hygiene) stays on the device and the graph is always re-derivable from the immutable ledger.
5. **Temporal coherence via warm-start/birth-near-neighbors/frozen-interior**, the static port of HTGN's principle — trained networks were rejected to keep the engine deterministic and model-free.

## 9. References

- Nickel & Kiela, *Poincaré Embeddings for Learning Hierarchical Representations*, NeurIPS 2017; *Learning Continuous Hierarchies in the Lorentz Model*, ICML 2018.
- Yang et al., *Hyperbolic Temporal Graph Network (HTGN)*, KDD 2021 — arXiv:2107.03767.
- Bai et al., *HGWaveNet*, WWW 2023 — arXiv:2304.07302.
- Rossi et al., *Temporal Graph Networks*, 2020 — arXiv:2006.10637.
- Gu, Sala, Gunel & Ré, *Learning Mixed-Curvature Representations in Product Spaces*, ICLR 2019.
- Companion documents: `docs/ATLAS_ENGINE_SPEC.md` (this repo); elle-worker `docs/TOROIDAL_GRAPH_MAPPING.md`, `docs/HYPERBOLIC_GRAPH_MAPPING.md`, `docs/WHY_NO_LEMNISCATE.md`, `docs/RETRIEVAL_STATUS.md`.

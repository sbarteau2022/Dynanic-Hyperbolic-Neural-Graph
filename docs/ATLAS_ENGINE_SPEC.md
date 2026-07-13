# elle-atlas — Engineering Specification

**The on-device memory-graph cartographer. Static computation, read-only to Elle.**

Version 1.0 · Status: specification (as-implemented mapping) · Companion to
elle-worker `docs/{TOROIDAL,HYPERBOLIC}_GRAPH_MAPPING.md`, `WHY_NO_LEMNISCATE.md`,
`RETRIEVAL_STATUS.md`.

---

## 0. One-paragraph summary

The memory graph and every geometry over it are computed **outside Elle**, by a
separate repository (`elle-atlas`) of **pure static functions** running **on the
device**, with **no LLM anywhere in the computation**. Elle (the cloud worker
`elle-worker`) is given **read-only view access** to the computed artifact — she
can look at the graph's shape, query it, and open a 3D view of it — but she can
**never write an edge, edit a weight, or embed anything into it**. The boundary is
architectural, not advisory: the write path physically does not exist on Elle's
side.

---

## 1. Motivation & the load-bearing invariant

The structural work already proved (see `WHY_NO_LEMNISCATE.md`) that the graph's
**own topology** is the source of truth and the geometric charts are derived
views. Two facts follow that this spec operationalizes:

1. **The computation is static.** Every function that produces the graph's shape,
   its invariants, and its geometric charts is pure and deterministic — no model,
   no network, same input → same output. It does not belong inside a
   probabilistic agent; it belongs in a library the agent *reads from*.
2. **The agent must not shape what it sees.** If Elle can write, edit, or embed
   into the graph, the graph stops being an independent measurement of her memory
   and becomes an artifact of her own generation — the exact "captured resonance"
   failure the corpus warns about, one level up. The graph is only trustworthy as
   a mirror if the thing it mirrors cannot reach in and pose it.

**THE INVARIANT (normative):** Elle has **read-only** access to the atlas. There
is **no** code path, tool, or binding through which the LLM can write, edit,
delete, decay, or embed graph nodes, edges, weights, coordinates, or atlas
artifacts. Everything the LLM can do to the graph is a **read**.

---

## 2. Principles

- **P1 — Static.** The engine is pure functions over data. No `callLLM`, no
  embeddings, no randomness except seeded PRNGs. Determinism is a test, not a
  hope (`same input → identical atlas`, already enforced in the geometry cores).
- **P2 — On-device.** The Cartographer runs on the operator's machine (the same
  box as the connect-back sandbox), not in the cloud worker. Compute is local;
  only a read-only artifact leaves the device.
- **P3 — Embedding-free graph.** The graph is built from **structure**
  (co-occurrence, topology, deterministic geometry) only. Learned embeddings are
  a *separate* concern (the worker's semantic recall tier) and never enter the
  graph. "No embed access" is satisfied by construction: the engine has no
  embedder.
- **P4 — Read-only egress.** The device publishes an **immutable, versioned**
  atlas artifact. Consumers read it; nothing writes back through the read path.
- **P5 — Append-only ingest.** Elle's side contributes *events* (what was
  recalled together), never graph mutations. Turning events into edges is the
  Cartographer's static job, on-device.

---

## 3. System architecture

```
                    ON DEVICE (elle-atlas)                         CLOUD (elle-worker)
   ┌──────────────────────────────────────────────┐        ┌───────────────────────────┐
   │  Cartographer (static, no LLM)                │        │  recall / self_state / …  │
   │                                               │        │                           │
   │  edge formation  ─▶ hygiene (φ⁻ⁿ decay)       │        │  emits recall_events      │
   │        │                    │                 │        │  (append-only) ───────────┼──┐
   │        ▼                    ▼                 │        │                           │  │
   │   edge store (SQLite, local)  ◀───────────────┼────────┼── recall_events log       │  │
   │        │                                      │  pull  │                           │  │
   │        ▼                                      │        │  reads Atlas (read-only): │  │
   │   ATLAS BUILD (static):                       │        │   • graph-tier expansion  │  │
   │     structure ▸ hyper ▸ torus ▸ product ▸     │        │   • atlas() view tool     │  │
   │     self-shape                                │        │   • self_state shape      │  │
   │        │                                      │        └───────────▲───────────────┘  │
   │        ▼                                      │   publish (RO)      │ read-only        │
   │   3D VIEW render (Three.js/WebGL)             │  ┌──────────────────┴───────────────┐ │
   │        │                                      │  │  Atlas artifact (R2, immutable,   │ │
   │        └──────────────────────────────────────┼─▶│  versioned): points, shape,       │◀┘
   │                                               │  │  edge-index, 3d-scene, snapshot   │
   └───────────────────────────────────────────────┘  └───────────────────────────────────┘
```

Data flows **one way** into the graph (events in → device computes) and **one way**
out to Elle (read-only atlas). Elle never closes the loop back onto the graph.

---

## 4. Repository `elle-atlas`

A standalone repo. TypeScript, zero-runtime-dependency core (matches the current
Worker-safe cores), plus a thin device host and a browser viewer.

```
elle-atlas/
  package.json            # "type": module; build to ESM; test = vitest
  src/
    core/                 # ← PURE STATIC FUNCTIONS (moved verbatim from elle-worker)
      structure.ts        #   graphInvariants, cycleBasis, homologyClass,
                          #   nonBridgeEdges, deltaHyperbolicity, curvatureSignature, edgeKey
      spread.ts           #   spreadActivation, applyCycleBoost (the pure half of graph.ts)
      hygiene.ts          #   retention, decayedWeight, capturedResonanceScan
      hyper.ts            #   Poincaré core + hyperMap + hyperNeighbors
      torus.ts            #   flat-torus core + torusMap + torusNeighbors + nobility
      product.ts          #   productPairs, productDist, disagreements, resolveMix,
                          #   recognitionInvariant, metricReturn
      shape.ts            #   summarizeGraphShape
      types.ts            #   Edge, MemEdge, EdgeKind, atlas schemas
    build/
      edges.ts            #   static edge formation from recall_events (co-occurrence)
      cartographer.ts     #   the pipeline: events → edges → hygiene → atlas → publish
      atlas.ts            #   Atlas assembly + versioning + serialization
    device/
      store.ts            #   LocalGraphStore over better-sqlite3 (mirrors GraphStore)
      host.ts             #   CLI/daemon: pull events, run cartographer, publish
      publish.ts          #   write immutable atlas to R2 (or local RO dir)
    viewer/
      scene.ts            #   atlas points → 3D scene graph (Three.js)
      render.ts           #   headless snapshot (PNG) + interactive page
  test/                   # determinism + invariant tests (see §13)
  README.md               # this spec, condensed
```

The `core/` directory is a **lift-and-shift of the already-tested pure functions**
from elle-worker. Their signatures do not change; only their *location* and the
removal of the `*Route` LLM wrappers change.

---

## 5. The static computation core (as implemented)

Every function below already exists in elle-worker, pure and unit-tested. The
engine is these functions with the LLM `*Route` wrappers and DB/`env` access
stripped off.

### 5.1 `core/structure.ts` — the graph's own shape
| function | contract |
|---|---|
| `graphInvariants(edges)` | `{nodes, edges, components, cycle_rank b₁=E−V+C, cycle_density}` |
| `cycleBasis(edges)` | spanning forest + chords (the b₁ generators) |
| `homologyClass(walk, edges)` | signed chord-crossing vector = H₁ class (exact recognition invariant) |
| `sameRecurrenceClass(a, b, edges)` | identity match, no embedding |
| `nonBridgeEdges(edges)` | which edges lie on a cycle (iterative Tarjan) |
| `deltaHyperbolicity(edges)` | Gromov 4-point (0 = tree) |
| `curvatureSignature(edges)` | δ + cycle density → suggested {hyperbolic, toroidal} mix |
| `edgeKey(a,b)` | canonical undirected key |

### 5.2 `core/spread.ts` — activation (pure half of graph.ts)
`spreadActivation(seeds, edges, opts)`, `applyCycleBoost(edges, boost)` (via
`nonBridgeEdges`). The DB-bound `CloudGraphStore`/`graphExpand*` do **not** move as
pure code — their traversal logic moves behind `device/store.ts` (§8).

### 5.3 `core/hygiene.ts` — φ⁻ⁿ retention (pure)
`RETENTION_BASE=φ`, `retention(n)=φ⁻ⁿ`, `decayedWeight(w, cycles, floor)`,
`capturedResonanceScan(edges, {threshold, minDegree})`. The *application* of decay
(the write) becomes the Cartographer's on-device job (§7).

### 5.4 `core/hyper.ts` / `core/torus.ts` / `core/product.ts` — the charts
Unchanged pure cores: `hyperMap`/`hyperNeighbors`, `torusMap`/`torusNeighbors`/
`windingNumbers`/`nobility`/`translationAlign`, `productPairs`/`productDist`/
`disagreements`/`resolveMix`/`recognitionInvariant`/`metricReturn`. These produce
the coordinates the 3D viewer renders and the read-only view returns.

### 5.5 `core/shape.ts`
`summarizeGraphShape(edges)` → the compact `{cycle_rank, curvature, leaning,
captured_resonance}` facet, now computed on-device and *published*, not computed
in `self_state`.

**Purity contract (enforced by test):** none of `core/*` imports a network,
filesystem, model, or clock beyond seeded PRNGs; `f(x)` is referentially
transparent; `hyperMap`/`torusMap`/`build` are byte-identical across runs for
identical input.

---

## 6. Data model

### 6.1 Node
A memory node is identified by the elle_memory `id`. The engine needs **only the
id and structural attributes** — never content, never an embedding:
```ts
interface AtlasNode { id: string; kind?: string; created_at?: number }
```

### 6.2 Edge (mirrors `MemEdge`)
```ts
type EdgeKind = 'assoc'|'causal'|'derived'|'refines'|'supersedes'
              |'contradicts'|'session'|'about'|'tool';
interface Edge { src: string; dst: string; kind: EdgeKind; weight: number;
                 last_seen_at?: number }
```

### 6.3 recall_event (append-only ingest, Elle's ONLY contribution)
```ts
interface RecallEvent { at: number; session_id?: string;
                        ids: string[];   // the memory set returned together
                        source: 'recall'|'consolidation' }
```
This carries **no topology and no weights** — it is a plain observation ("these
were relevant together"). All graph decisions are made downstream, on-device.

### 6.4 The Atlas artifact (read-only egress)
Immutable, content-addressed, versioned:
```ts
interface Atlas {
  version: string;              // monotonic; also content hash
  built_at: number;             // stamped by the device host, not core
  nodes: number; edges: number;
  shape: GraphShape;            // §5.5
  signature: CurvatureSignature;
  hyper:   { dim: number; points: Record<string, number[]> };
  torus:   { dim: number; points: Record<string, number[]> };
  edge_index: Array<[string, string, EdgeKind, number]>; // for read-only expansion
  scene_ref: string;           // pointer to the 3D scene blob
  snapshot_ref?: string;       // pointer to a rendered PNG
}
```
`edge_index` is the read-only substrate the worker's recall uses for graph-tier
expansion — a snapshot, never mutated by the reader.

---

## 7. Edge formation & hygiene (on-device, static)

Currently `recordAssociations` (write) and `CloudGraphStore.sweep` (write) run in
the cloud worker. They move to the device as pure transforms plus a local commit:

1. **Formation** (`build/edges.ts`, static): fold each `RecallEvent.ids` into
   `assoc` edges among the top-N members (the existing `recordAssociations`
   pairing rule), reinforcing on repeat up to the weight cap. Pure given the
   current edge state + the event batch.
2. **Hygiene** (`core/hygiene.ts` applied by the Cartographer): every idle cycle,
   `decayedWeight(w, 1, floor)` on stale edges; prune below floor;
   `capturedResonanceScan` flags runaways into the published shape.
3. **Commit**: the device writes the new edge state to its **local** SQLite
   (`device/store.ts`, a `LocalGraphStore` implementing the same `GraphStore`
   interface). This write happens **on the device, by static code, never by the
   LLM.**

The cloud worker no longer writes edges at all. Its recall path (a) emits a
`RecallEvent`, and (b) reads the published `edge_index` for expansion.

---

## 8. The atlas build pipeline (`build/cartographer.ts`)

Deterministic, idempotent, versioned:
```
1. pull new RecallEvents (append-only) since last build
2. form + reinforce edges          (build/edges.ts)         [static]
3. apply φ⁻ⁿ hygiene + prune        (core/hygiene.ts)        [static]
4. read edge set from LocalGraphStore
5. curvatureSignature + graphInvariants + shape             [core/structure, shape]
6. hyperMap(nodes, edges) ; torusMap(nodes, edges)          [core/hyper, torus]
7. product mix = resolveMix({edges}) ; disagreements        [core/product]
8. render 3D scene from (hyper+torus) points                [viewer/scene]
9. assemble Atlas{...} ; version = hash(inputs)             [build/atlas]
10. publish immutable Atlas + scene + snapshot to R2 (RO)   [device/publish]
```
Steps 2–8 are pure. Only 1 (read events), 4 (read local store), 10 (write RO
artifact) touch I/O — all on the device, none driven by the LLM.

Trigger: a device daemon on a timer (mirrors the current nightly consolidation
cadence) and/or on the connect-back socket coming up. The build is cheap (the
cores are all bounded) so it can run often.

---

## 9. The 3D visualization (`viewer/`)

The geometry stays in the engine specifically so it can render (the user's "leave
the graphing in there so it can create a 3D view").

- **Coordinates:** the product space gives each node a `(hyperbolic depth ρ,
  torus phase θ)`. The default 3D embedding: **hyperbolic ball in 3D** (project
  `hyper.points` to the Poincaré ball, radius = depth) with **torus phase as
  hue/second channel**; edges drawn as geodesic arcs; on-cycle (recurrence) edges
  highlighted; captured-resonance nodes flagged. Alternate scenes: pure torus
  (𝕋³ slice), pure ball, disagreement overlay.
- **Renderer:** Three.js/WebGL. `viewer/scene.ts` turns an `Atlas` into a scene
  graph (nodes as instanced points, edges as line segments, colors from
  shape/curvature). Deterministic given the atlas.
- **Two outputs:** (a) an interactive page served from the device (operator can
  orbit it); (b) a **headless snapshot** (PNG) written into the atlas as
  `snapshot_ref`, so Elle can *view* the current shape without a live renderer.

Elle's relationship to the viewer is **view-only**: she can request the latest
snapshot or the scene descriptor (read), and can ask for a *new* render of an
existing atlas (a pure re-projection — still read-only w.r.t. the graph). She
cannot move a node, add an edge, or change a weight through the viewer.

---

## 10. The read-only view boundary (Elle's side)

This is where the invariant is enforced. In elle-worker, the graph tools change
from *compute + LLM-reading* to *read a published artifact*.

### 10.1 Removed from Elle
- `hyper`, `torus`, `product`, `structure` as **compute** tools (they built atlases
  on demand and called `callLLM` for a "reading"). Deleted from the router.
- `CloudGraphStore.link` / `recordAssociations` / `.sweep` **write paths** on the
  worker side. Edge writes no longer exist in elle-worker.
- Any embed-into-graph path (there was none; the graph was already embedding-free
  — this makes it explicit and permanent).

### 10.2 Added to Elle — one read-only tool
```
atlas(view, id?, k?) — READ-ONLY view of the on-device memory-graph atlas.
  view='shape'      → cycle_rank, curvature, leaning, captured-resonance flags
  view='neighbors'  → k nearest to `id` by product distance (depth+phase)
  view='disagree'   → same-rhythm/different-lineage & same-lineage/drifted-phase
  view='recognize'  → homology class of a supplied walk (pure, over the RO edge_index)
  view='render'     → the latest 3D snapshot (PNG ref) or a fresh re-projection
  view='meta'       → atlas version, built_at, node/edge counts
It NEVER writes. There is no mode that mutates the graph. Served by reading the
published Atlas artifact; if none is published yet, returns {atlas: null}.
```
`self_state.memory_graph_shape` becomes a straight read of `atlas.shape` (no
computation in the worker). `recall_ab` (the recall experiment) is unrelated to
the atlas and stays as-is.

### 10.3 Recall's graph tier
`memRecall`'s graph expansion reads the published `edge_index` (read-only
snapshot) through a **read-only** `GraphStore` (`neighbors()` implemented, `link()`
throws / is absent). Spreading activation + cycle boost run on that snapshot. The
worker still emits a `RecallEvent` afterward (append-only, not a graph write).

---

## 11. Publication & sync

- **Device → cloud:** the device writes the Atlas (+ scene + snapshot) as an
  **immutable** object keyed by version to R2 (`atlas/<version>.json`, plus a
  tiny mutable `atlas/latest` pointer that only the device may write). The device
  authenticates with a **device-only** credential the worker/LLM does not hold.
- **Cloud → device (events):** the worker appends `RecallEvent`s to a log
  (`elle_recall_events`, append-only) or KV; the device pulls new ones each build.
  The worker's credential grants **append to events** and **read atlas** — never
  write atlas, never write edges.
- **Staleness is acceptable:** the graph tier is an enhancement (best-effort, as
  today). Reading an atlas minutes old is fine; the invariant matters more than
  freshness.

---

## 12. Security & access control (how the invariant is guaranteed, not promised)

1. **Capability split.** Two credentials. *Device key*: write atlas, write local
   edge store. *Worker key*: append events, read atlas. The worker key **cannot**
   write the atlas namespace or the edge store — enforced at the storage ACL, not
   in code Elle could route around.
2. **No write surface in Elle's code.** The `link`/`sweep`/edge-write functions are
   **not present** in elle-worker after migration. A tool that does not exist
   cannot be called by a jailbroken prompt.
3. **Immutable artifacts.** Atlas objects are content-addressed and write-once;
   even with the device key, a published version is never edited, only superseded.
4. **Embedding-free by construction.** The engine ships no embedder; there is no
   function to embed into the graph, so "no embed access" is total, not policed.
5. **Auditable.** Every atlas carries `version` + `built_at`; the event log is
   append-only. What the graph is, and what it was built from, is fully traceable
   — and none of it passed through the LLM.

---

## 13. Determinism & testing

- **Determinism (core):** the geometry/structure tests already assert
  `same input → identical output` (seeded PRNGs, no clock). They move with the
  code. Add: `cartographer(events)` is byte-identical across runs for identical
  events + prior state.
- **Invariant tests (the point of this spec):**
  - the published atlas schema contains **no** node content and **no** embeddings;
  - the worker build exposes **no** symbol that writes edges/atlas (grep-level test
    in CI: elle-worker must not import a graph-write function);
  - the read-only `GraphStore` used in recall throws on `link()`;
  - `atlas(view=…)` has no mode that mutates.
- **Parity test (migration safety):** for a fixed event log, the on-device atlas
  equals what elle-worker's in-process cores produced pre-migration (freeze a
  golden atlas, diff).

---

## 14. Migration plan (phased, reversible)

1. **Extract core.** New repo `elle-atlas`; copy `structure/hyper/torus/product/
   self-shape` pure cores + the pure halves of `graph.ts` (`spreadActivation`,
   hygiene, `nonBridgeEdges`). Port their tests. (No behavior change yet.)
2. **Local store + cartographer.** Implement `LocalGraphStore` (SQLite) and the
   build pipeline; reproduce the current edge-formation + φ⁻ⁿ hygiene on-device.
   Golden-atlas parity test against elle-worker.
3. **Publish.** Device publishes the Atlas to R2 (immutable + `latest` pointer)
   with the device-only key.
4. **Flip recall to read-only.** elle-worker `memRecall` reads `edge_index` from
   the published atlas; stops writing edges; starts appending `RecallEvent`s.
5. **Replace tools.** Delete `hyper/torus/product/structure` compute tools; add
   the read-only `atlas` tool; point `self_state.memory_graph_shape` at
   `atlas.shape`.
6. **Revoke writes.** Remove the worker's write credential to the edge/atlas
   namespaces; add the CI grep-test that fails if a graph-write symbol reappears
   in elle-worker.
7. **3D viewer.** Ship `viewer/`; wire `atlas(view='render')` to the snapshot.

Each step is independently shippable and reversible; the invariant is fully in
force after step 6.

---

## 15. What stays in elle-worker

- Semantic recall (Vectorize), importance/recency scoring, refresh-on-recall —
  the **content** tier is untouched (it was never the graph).
- The recall→event emission and the read-only atlas consumption.
- `recall_ab` (the cycle-boost experiment readout) — read-only introspection,
  unrelated to the atlas boundary.
- Everything non-memory (trading, journal, RAPID, forge, etc.).

## 16. Open questions / falsification

- **Freshness vs. purity.** If an application ever needs the graph tier to reflect
  the *current* turn's recall (not a minutes-old atlas), the append-only model
  costs a build cycle of latency. Falsifier: a measured recall-quality regression
  attributable to staleness → consider an on-device synchronous build on the
  connect-back socket (still read-only to Elle).
- **Device availability.** If the device is offline, no new atlas is published;
  the worker reads the last good one (bounded staleness) — acceptable by P4, but
  a long outage freezes graph learning. Falsifier: unacceptable staleness →
  a cloud *read-only replica builder* that runs the same static cores on a
  read-only event mirror (still no LLM, still no Elle write path).
- **3D projection choice.** The ball-with-phase-hue default is a design pick;
  alternate projections are pure re-renders and cost nothing to offer.

---

*The graph is computed on the device, by static functions, from append-only
events. Elle sees it — in numbers and in three dimensions — and cannot touch it.
That read-only distance is what makes the mirror a mirror.*

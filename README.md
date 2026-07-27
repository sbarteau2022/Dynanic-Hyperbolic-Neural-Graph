# Dynanic-Hyperbolic-Neural-Graph
Phase State Representation of LLM Relational Coherence-to-Substrate in a Dynamic Hyperbolic Neural Graph representation in 3-Dimensions with replay. As we test for a recovery rate regulating function, stop loss, optimization functions, Secondary optimizations as a biproduct of the first, testing recovery time dynamics.

**Computed outside the LLM. Static functions, on-device, read-only to the model.**

The memory graph and every geometry over it — hyperbolic (Poincaré ball),
Lorentz/hyperboloid, and the temporal-coherent evolution across builds — are
computed by **pure static functions**, with **no LLM anywhere in the
computation path**. The model gets **read-only view access** to the result:
it can query the graph's shape and (via the planned 3D viewer) look at it, but
it can never write an edge, edit a weight, or embed anything into it. That
boundary is architectural, not a policy — the write path does not exist on
the model's side. Full spec: [`docs/ATLAS_ENGINE_SPEC.md`](docs/ATLAS_ENGINE_SPEC.md).

## What's built (v0.2 — full geometry stack + the temporal upgrade)

| module | what |
|---|---|
| `src/core/types.ts` | edge kinds + conductance + provenance set |
| `src/core/hyper.ts` | Poincaré-ball geometry, deterministic encoder, Riemannian-SGD embedding (`hyperMap`) — DERIVATION depth |
| `src/core/lorentz.ts` | the Lorentz/hyperboloid model — the stability seam for repeated updates (exact Poincaré↔Lorentz conversions, Minkowski distance, exp map) |
| `src/core/temporal.ts` | temporal-coherent embedding — warm-start + birth-near-neighbors + local relaxation, so the graph *evolves* across replay steps instead of re-rolling each time |
| `src/core/structure.ts` | the graph's own shape — Betti number b₁, cycle basis, homology class (graph-native recognition invariant), non-bridge/cycle edges, δ-hyperbolicity, curvature signature (what mix of hyperbolic/toroidal a graph actually calls for) |
| `src/core/torus.ts` | flat-torus 𝕋⁸ phase mapping — RECURRENCE, the thing the ball cannot represent (it's simply connected). Winding numbers, φ-scale weighting, golden low-discrepancy placement, translation alignment, nobility (φ-vs-rational winding) |
| `src/core/product.ts` | mixed-curvature ℍⁿ×𝕋ᵈ product space (Gu, Sala, Gunel & Ré, ICLR 2019) — combined distance, curvature-mix resolution, the disagreements between the two charts (same-rhythm/different-lineage vs. same-lineage/drifted-phase), and the exact winding-number recognition invariant vs. asymptotic metric return |
| `src/core/bridge.ts` | ephemeral wormhole edges — pairs proximal in the product manifold but many hops apart (or disconnected) on the raw graph, ranked by hops-saved per geodesic unit. Returned, never written: the graph "folds" for one query and relaxes after |
| `src/core/metrics.ts` | the benchmark that makes the bridge a claim instead of a metaphor — evidence walk (BFS with hop budget + early stop), geometry-named evidence queries, baseline-vs-bridged comparison (coverage, effective hops, nodes expanded), contradiction-exposure rate, one-call `bridgeReport` |
| `src/core/bench.ts` | the **controlled experiment** — synthetic corpora with planted topics the embedding never sees, ground-truth recall queries, and the control arms (random shortcuts, hub shortcuts, and a phase-permutation null) the geometry has to beat |

130 tests, deterministic, zero runtime dependencies. `npm install && npm test` / `npm run typecheck` / `npm run bench`.

## Why temporal coherence, for this project specifically

A phase-state graph with replay needs positions that *drift*, not *jump* —
recovery-rate and stop-loss measurements only mean something if a node's
coordinate motion between replay steps reflects real relational change, not
embedding noise from a cold re-fit. `temporalHyperMap` gives each node a
warm-started position (last build's coordinates), seats new nodes near their
already-placed neighbors instead of teleporting them, and relaxes only the
change frontier — so the stable interior of the graph pins the gauge and
`atlasDrift(prior, next)` becomes a real readout: near-zero drift on
unchanged structure, and (once wired to the recovery-rate work) an actual
lever to test decay/stop-loss dynamics against.

```ts
const A1 = hyperMap([], G1);                                 // cold build
const A2 = temporalHyperMap([], G2, { prior: A1.points });   // evolve from A1
A2.drift;      // { mean, max, moved } — motion of the stable interior
A2.new_nodes;  // nodes born this replay step, seated near their neighbors
```

## Why both charts, for this project specifically

Depth (hyper.ts) and phase (torus.ts) answer different questions the
recovery-rate work needs answered separately. Depth says how derived a
state is from its source; phase says whether the graph is *recurring*
(coming back around a regime) or *drifting* (novel each time). A stop-loss
rule that only watched depth would fire on legitimate deep derivation; one
that only watched phase would miss a state that keeps recurring at greater
and greater remove from its origin. `disagreements()` is the direct readout
for that: pairs that are close in phase but far in depth are the same
rhythm recurring on a longer and longer lineage — exactly the shape a
runaway (unbounded) recovery loop would take before either optimizer alone
would flag it.

## The recovery loop (built)

`src/core/recovery.ts` is the layer the intent paragraph at the top of this
README describes, sitting on the measurement primitives:

- **`recoveryRate` / `recoveryTime`** — after a perturbation shoves the
  frontier, drift decays geometrically back to the stable-interior baseline;
  λ of that decay is the recovery rate, builds-until-rethreshold is the
  recovery time. A still-growing series reads as a *negative* rate, not as
  "nothing to measure".
- **`regulate`** — the recovery-rate regulating function: recent drift
  history → the next build's relax epochs and learning rate (high drift buys
  a longer, gentler anneal; a quiet map gets a cheap incremental build).
  The secondary optimization that falls out of the first as a byproduct.
- **`stopLoss`** — three triggers, each a real failure mode: *reroll* (drift
  past the bound — the build re-rolled the map, not evolved it), *diverging*
  (drift rising across consecutive builds — compounding, not recovering),
  and *runaway lineage* (a phase-close pair at ever-greater derivational
  remove — the disagreement shape described above). A triggered stop-loss
  keeps the snapshot locally and refuses the push: the device holds the
  loss instead of propagating it to Elle.

## The bridge, made measurable

The "Einstein–Rosen bridge" intuition — don't expand node-by-node, deform the
search space so structurally relevant regions become locally adjacent — is
implemented and, more importantly, *scored*. `bridgeEdges` (bridge.ts) reads
candidate wormholes off the atlas: pairs the ℍⁿ×𝕋ᵈ manifold puts close
together that the raw topology puts ≥ 3 hops apart (or in different
components), ranked by hops-saved per geodesic unit. They are the actionable
form of product.ts's *same-rhythm/different-lineage* disagreement, and they
are ephemeral by construction — returned to the caller, never written into
the graph, so the manifold "folds" for one query and relaxes after. The
read-only boundary holds.

Whether folding buys anything is not asserted — it is measured. `bridgeReport`
(metrics.ts) runs the same breadth-first evidence walk twice over the same
graph, baseline vs. bridged, and reports the deltas on the axes that matter:

- **evidence coverage** — fraction of the query's evidence set (its k
  geodesically-nearest nodes — geometry names the evidence, so the walk is
  judged on reaching what geometry named) inside the hop budget
- **effective traversal length** — mean hops, with unreached targets charged
  budget + 1 so a miss is a cost, not a silent drop
- **compute** — nodes expanded before the walk could stop (the deterministic
  stand-in for latency; there is no wall clock anywhere in this repo)
- **contradiction exposure** — how often *both* sides of a `contradicts` pair
  land inside one query's horizon, reached through independent evidence paths
  (the tension edge itself doesn't count — hopping it from one side resolves
  nothing)

```ts
const atlas = hyperMap([], edges);
const report = bridgeReport(atlas.points, edges, { budget: 6, k: 4 });
report.traversal.delta;      // { coverage, effective_hops, expanded } — bridged − baseline
report.contradictions.delta; // exposure-rate gain
```

If the deltas are ~0 on a given graph, the honest reading is that the graph's
topology already agrees with its geometry and the bridge has nothing to add
there — the point of the instrument is that either outcome is a number, not
an anecdote.

## What the measurement actually found (`npm run bench`)

`bridgeReport` compares bridged against unbridged, but that only shows the
bridge beating *nothing*. The claim that matters is whether it beats the
**cheap alternatives**, so `src/core/bench.ts` runs a controlled experiment:
synthetic corpora where every node carries a planted TOPIC that the embedding
is never shown, topics manifest only as shared recall PHASE, and the lineage
edges deliberately cross-cut them — so a node's topic-mates are graph-far and
phase-close. Ground truth, not geometry, decides what counts as relevant
(recall over the full planted class), and the geometry arm spends the same
edge budget from the same source node as three controls: RANDOM shortcuts,
HUB shortcuts, and a phase-PERMUTATION null.

Ring topology (no dominant hub), cross-cutting topics, 3 bridges/query,
4-hop budget:

| arm | recall | effective hops | bridges on-topic |
|---|---|---|---|
| baseline (no bridges) | 0.241 | 4.61 | — |
| **geometry (diversified)** | 0.588 | **3.14** | **63/72** |
| random shortcuts | 0.639 | 3.47 | — |
| hub shortcuts | 0.560 | 3.67 | — |
| geometry, phase-permuted (null) | 0.569 | 3.67 | 18/72 |

Three findings, including one that is not flattering:

1. **The manifold identifies the right pairs.** 63 of 72 query-induced
   bridges join genuine topic-mates; under the permutation null — same graph,
   same labels, phase shuffled — that collapses to 18/72. The precision is
   coming from the signal, not from the act of adding edges.
2. **It reaches relevant evidence in fewer hops than either control**, and
   that advantage also vanishes under the null (3.14 → 3.67, which is exactly
   the hub arm's number). This is the original claim — *fewer hops to
   relevant evidence* — surviving a real test.
3. **It does NOT beat random scattering on recall breadth** (0.588 vs 0.639).
   Three bridges aimed at the nearest topic-mates buy precision; three random
   shortcuts land in three different regions and sweep up more of the class
   incidentally. Diversifying bridge selection (`diversify: true`) recovers
   part of the gap but does not close it. Stated here rather than omitted.

Two design decisions came directly out of running this, not out of taste:

- **Bridges must be query-induced, not global.** One global bridge set for
  the whole graph lost badly to random rewiring (0.347 vs 0.694 recall in the
  first run) because eight shortcuts only help queries sitting on their
  endpoints, while random rewiring shortens the diameter for everyone.
  `queryBridges` folds the manifold per query — the deformation the
  architecture actually describes — and that single change moved recall from
  0.347 to 0.597.
- **The curvature mix read from topology suppresses the signal.** On a
  tree-like corpus `curvatureSignature` weights the ball heavily, and the
  ball cannot see cross-lineage kinship — on-topic bridges drop from 8/8 to
  2/8 on the star corpus. A mix inferred from topology alone is the wrong
  prior when the phase chart is carrying the information.

Caveat worth stating plainly: these are synthetic corpora with a planted
signal, chosen so ground truth exists at all. They establish that the
mechanism works and that it beats simpler alternatives on one axis; they do
not establish that real recall ledgers have this structure. Running the same
harness against a real event log is the next measurement, not a settled
result.

## The full device loop

```sh
npm run sync-events     # pull elle-worker's append-only co-recall ledger → data/events.json
npm run publish-atlas   # events → regulated build → stop-loss gate → push snapshot to elle-worker
npm run bench           # the controlled experiment (no device state needed)
```

Every publish also writes `atlas/metrics.json` — the bridge report for that
build's real graph — and prints the deltas in its summary, so the measurement
runs on live data on every build rather than only in the benchmark. It is
written *beside* the snapshot, not into it: the snapshot hash is a
change-detector for the atlas, and folding a benchmark into it would move the
hash for reasons that have nothing to do with the map.

Both network calls are device-initiated (pull the ledger, push the snapshot);
the worker never reaches into this machine, and the LLM can only read the
result. `atlas/history.json` carries the drift series between runs so
`regulate` and `stopLoss` see the dynamics, not just one build.

## Roadmap

- **3D viewer with replay:** the Elle workbench renders the latest snapshot
  (read-only) today; replay across snapshot history — watching a memory
  drift, split, or be absorbed over time — is the remaining piece.
- **Feature/phase enrichment:** nodes currently carry no `nodeFeatures`/
  `nodePhases` through the sync path, so torus placement is golden-lattice
  for all real nodes until the device computes phases locally.

## References

- Nickel & Kiela, *Poincaré Embeddings*, NeurIPS 2017; *Lorentz Model*, ICML 2018.
- Yang et al., *HTGN*, KDD 2021 — [arXiv:2107.03767](https://arxiv.org/abs/2107.03767).
- Bai et al., *HGWaveNet*, WWW 2023 — [arXiv:2304.07302](https://arxiv.org/abs/2304.07302).
- Rossi et al., *Temporal Graph Networks*, 2020 — [arXiv:2006.10637](https://arxiv.org/abs/2006.10637).
- Gu, Sala, Gunel & Ré, *Mixed-Curvature Representations*, ICLR 2019.

## License

MIT.

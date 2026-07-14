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

63 tests, deterministic, zero runtime dependencies. `npm install && npm test` / `npm run typecheck`.

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

## Roadmap

- **Recovery-rate regulating function, stop-loss, and the derived secondary
  optimizations** described above — not yet built. `atlasDrift` (temporal.ts)
  and `disagreements`/`recognitionInvariant` (product.ts) are the measurement
  primitives they sit on top of: drift for decay rate, winding number for
  exact recurrence detection, ball/torus disagreement for runaway-lineage
  detection.
- **Device host:** local graph store, the cartographer pipeline (replay
  events → edges → hygiene → atlas → publish), immutable versioned atlas.
- **3D viewer with replay:** WebGL render of the hyperbolic-ball coordinates
  over time, read-only.

## References

- Nickel & Kiela, *Poincaré Embeddings*, NeurIPS 2017; *Lorentz Model*, ICML 2018.
- Yang et al., *HTGN*, KDD 2021 — [arXiv:2107.03767](https://arxiv.org/abs/2107.03767).
- Bai et al., *HGWaveNet*, WWW 2023 — [arXiv:2304.07302](https://arxiv.org/abs/2304.07302).
- Rossi et al., *Temporal Graph Networks*, 2020 — [arXiv:2006.10637](https://arxiv.org/abs/2006.10637).
- Gu, Sala, Gunel & Ré, *Mixed-Curvature Representations*, ICLR 2019.

## License

MIT.

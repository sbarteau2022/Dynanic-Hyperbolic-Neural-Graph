// ============================================================
// CARTOGRAPHER — events → edges → the full atlas, in one pure call
//
// The device-side pipeline the roadmap named: recall events accumulate,
// get folded into hygienic edges (events.ts), and every geometry core built
// so far — hyper (derivation depth), torus (phase/recurrence), structure
// (the graph's own shape, which sets the hyper/torus mix), product (the
// ball/torus disagreements) — runs over the SAME edge set into one bundled
// atlas. Pass `prior` (a previous build's hyper points) to warm-start
// instead of re-rolling (temporal.ts); omit it for a cold first build.
//
// Pure and deterministic except for the two fields the caller stamps
// (version, created_at) in publish.ts — buildAtlas itself takes no wall-clock
// reads, so the SAME event log + opts always produces the SAME atlas.
// ============================================================

import type { MemEdge } from './core/types';
import { edgesFromEvents, type MemEvent } from './core/events';
import { hyperMap, type HyperNode, type HyperAtlas } from './core/hyper';
import { temporalHyperMap, type TemporalAtlas } from './core/temporal';
import { torusMap, type TorusNode, type TorusAtlas } from './core/torus';
import { graphInvariants, curvatureSignature, nonBridgeEdges, asEdges, type GraphInvariants, type CurvatureSignature } from './core/structure';
import { disagreements, type Mix, type Disagreements } from './core/product';

export interface CartographerOpts {
  hyperDim?: number;      // default 3 — 3 gives directly-renderable 3D ball coordinates
  torusDim?: number;      // default 8
  epochs?: number;        // cold hyperMap fit epochs
  relaxEpochs?: number;   // temporalHyperMap relax epochs (only used with `prior`)
  lr?: number;            // temporalHyperMap learning rate (only used with `prior`) — set by recovery.ts's regulate()
  seed?: number;
  prior?: Record<string, number[]>;        // previous build's hyper points — warm-starts if given
  changedNodes?: string[];                 // nodes whose incident edges changed since `prior`
  nodeFeatures?: Record<string, number[]>; // optional raw feature vectors for cold node placement
  nodePhases?: Record<string, number[]>;   // optional phase vectors for torus placement
}

export interface AtlasCore {
  nodes: string[];
  edges: MemEdge[];
  hyper: HyperAtlas | TemporalAtlas;
  torus: TorusAtlas;
  structure: { invariants: GraphInvariants; signature: CurvatureSignature; cycle_edges: string[] };
  product: { mix: Mix; disagreements: Disagreements };
  temporal: boolean;   // true iff `hyper` is a TemporalAtlas (a `prior` was given)
}

export function buildAtlas(events: MemEvent[], opts: CartographerOpts = {}): AtlasCore {
  const edges = edgesFromEvents(events);

  const nodeIds = [...new Set(edges.flatMap((e) => [e.src, e.dst]))].sort();
  const hyperNodes: HyperNode[] = nodeIds.map((id) => ({ id, features: opts.nodeFeatures?.[id] }));
  const torusNodes: TorusNode[] = nodeIds.map((id) => ({ id, phases: opts.nodePhases?.[id] }));

  const hyperDim = opts.hyperDim ?? 3;
  const hyper = opts.prior
    ? temporalHyperMap(hyperNodes, edges, {
        dim: hyperDim, relaxEpochs: opts.relaxEpochs, lr: opts.lr, seed: opts.seed,
        prior: opts.prior, changedNodes: opts.changedNodes,
      })
    : hyperMap(hyperNodes, edges, { dim: hyperDim, epochs: opts.epochs, seed: opts.seed });

  const torus = torusMap(torusNodes, { dim: opts.torusDim });

  const structEdges = asEdges(edges);
  const invariants = graphInvariants(structEdges);
  const signature = curvatureSignature(structEdges);
  const cycleEdges = [...nonBridgeEdges(structEdges)];
  const mix: Mix = { hyperbolic: signature.suggested.hyperbolic, toroidal: signature.suggested.toroidal };
  const disagree = disagreements(hyper.points, torus.points, { mix });

  return {
    nodes: nodeIds,
    edges,
    hyper,
    torus,
    structure: { invariants, signature, cycle_edges: cycleEdges },
    product: { mix, disagreements: disagree },
    temporal: !!opts.prior,
  };
}

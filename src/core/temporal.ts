// ============================================================
// TEMPORAL — coherent hyperbolic embedding across evolving graphs
//
// The gap this closes: hyperMap re-embeds each snapshot from scratch, so a node's
// coordinates jump between builds even when its neighborhood barely changed —
// the view flickers and you cannot watch a memory drift, split, or be absorbed.
// (Hyperbolic embeddings also have gauge freedom: an isometry of the ball leaves
// the loss invariant, so a cold re-fit can globally rotate the whole atlas.)
//
// The dynamic-hyperbolic literature solves this by carrying embedding state
// across time steps (HTGN's HGRU, KDD 2021; HGWaveNet, WWW 2023). Those are
// TRAINED networks; this engine is static/deterministic. So we port the
// PRINCIPLE, not the network:
//   1. warm-start — each node keeps its previous position;
//   2. birth-near-neighbors — a new node is seated at the mean of its already-
//      placed neighbors, not teleported in from a random hash;
//   3. local relaxation — only nodes touched by change (new nodes, changed
//      edges, and their neighbors) move; the stable interior is frozen and pins
//      the gauge, so the atlas evolves instead of re-rolling.
//
// The result: temporal COHERENCE (low drift on unchanged structure) with the
// same deterministic, model-free discipline as the rest of the core. For deep /
// long-running graphs, carry the state in the Lorentz model (lorentz.ts) to
// avoid Poincaré boundary blow-up.
// ============================================================

import {
  dot, norm, project, poincareDist, distGrad, hashDirection, placeFeatures,
  edgeStrength, targetDist, buildStats, roundTo, HIERARCHY, mulberry32, constants,
  type HyperNode, type HyperAtlas, type MemEdge,
} from './hyper';

export interface TemporalOpts {
  dim?: number;
  relaxEpochs?: number;      // warm-started, so far fewer than a cold fit (default 60)
  lr?: number;               // gentle, so stable structure barely moves (default 0.03)
  seed?: number;
  negatives?: number;
  prior?: Record<string, number[]>;   // previous atlas points — the state we carry
  freezeStable?: boolean;    // move only the active set; default true when prior given
  changedNodes?: string[];   // nodes whose incident edges changed since the prior build
}

export interface TemporalAtlas extends HyperAtlas {
  drift: { mean: number; max: number; moved: number };  // motion of shared nodes vs prior
  new_nodes: string[];
  active: number;             // how many nodes were allowed to move
}

const EPS = 1e-9;

// Mean geodesic motion of the nodes present in both atlases. The temporal-
// coherence readout: near 0 means the map evolved rather than re-rolled.
export function atlasDrift(prior: Record<string, number[]>, next: Record<string, number[]>): { mean: number; max: number; moved: number } {
  let sum = 0, max = 0, moved = 0, n = 0;
  for (const id of Object.keys(next)) {
    const a = prior[id]; const b = next[id];
    if (!a || !b || a.length !== b.length) continue;
    const d = poincareDist(a, b);
    sum += d; max = Math.max(max, d); if (d > 1e-4) moved++; n++;
  }
  return { mean: roundTo(n ? sum / n : 0, 6), max: roundTo(max, 6), moved };
}

export function temporalHyperMap(nodesIn: HyperNode[], edgesIn: MemEdge[], opts: TemporalOpts = {}): TemporalAtlas {
  const prior = opts.prior;
  // Warm start requires the same dimensionality as the prior atlas.
  const priorDim = prior ? (Object.values(prior)[0]?.length ?? 0) : 0;
  const dim = Math.max(2, Math.min(16, Math.round(opts.dim ?? priorDim ?? 2)));
  const relaxEpochs = Math.max(1, Math.min(1000, Math.round(opts.relaxEpochs ?? 60)));
  const lr = Math.max(1e-4, Math.min(0.5, opts.lr ?? 0.03));
  const seed = (opts.seed ?? 42) >>> 0;
  const negPerEdge = Math.max(0, Math.min(8, Math.round(opts.negatives ?? 2)));
  const freezeStable = opts.freezeStable ?? !!prior;

  // Node/edge assembly — identical bounds to hyperMap.
  const byId = new Map<string, HyperNode>();
  for (const n of nodesIn) if (n && n.id && !byId.has(n.id) && byId.size < constants.MAX_NODES) byId.set(n.id, n);
  const edges = edgesIn.filter((e) => e && e.src && e.dst && e.src !== e.dst).slice(0, constants.MAX_EDGES);
  for (const e of edges) for (const id of [e.src, e.dst]) if (!byId.has(id) && byId.size < constants.MAX_NODES) byId.set(id, { id });
  const ids = [...byId.keys()];
  const usable = edges.filter((e) => byId.has(e.src) && byId.has(e.dst));

  // Adjacency (for new-node seating + the active frontier).
  const nbrs = new Map<string, string[]>();
  const pushNbr = (a: string, b: string) => { (nbrs.get(a) ?? nbrs.set(a, []).get(a)!).push(b); };
  for (const e of usable) { pushNbr(e.src, e.dst); pushNbr(e.dst, e.src); }
  const adj = new Set<string>();
  for (const e of usable) { adj.add(`${e.src} ${e.dst}`); adj.add(`${e.dst} ${e.src}`); }

  const validPrior = (id: string) => !!prior && Array.isArray(prior[id]) && prior[id].length === dim && dot(prior[id], prior[id]) < 1;
  const newNodes = ids.filter((id) => !validPrior(id));

  // Init: warm-start from prior; new nodes are born at the mean of their already-
  // placed neighbors (birth-near-neighbors), else fall back to features/id-hash.
  const X = new Map<string, number[]>();
  for (const id of ids) {
    const jitter = hashDirection(`jitter:${id}`, dim).map((v) => v * 0.01);
    if (validPrior(id)) { X.set(id, project(prior![id].slice())); continue; }
    const placed = (nbrs.get(id) ?? []).filter((n) => validPrior(n));
    if (placed.length) {
      const mean = new Array(dim).fill(0);
      for (const n of placed) for (let i = 0; i < dim; i++) mean[i] += prior![n][i] / placed.length;
      X.set(id, project(mean.map((v, i) => v * 0.9 + jitter[i])));  // seat just inside the neighbor centroid
    } else {
      const node = byId.get(id)!;
      const base = node.features && node.features.some((v) => Number.isFinite(v) && v !== 0)
        ? placeFeatures(node.features.filter(Number.isFinite), dim)
        : hashDirection(`init:${id}`, dim).map((v) => v * constants.INIT_RADIUS);
      X.set(id, project(base.map((v, i) => v + jitter[i])));
    }
  }

  // Active frontier: what is allowed to move. New nodes, explicitly-changed nodes,
  // and their immediate neighbors; everything else is frozen and pins the gauge.
  let active: Set<string>;
  if (!freezeStable) {
    active = new Set(ids);
  } else {
    active = new Set<string>(opts.changedNodes?.length ? opts.changedNodes : newNodes);
    for (const id of [...active]) for (const n of nbrs.get(id) ?? []) active.add(n);
  }

  const rand = mulberry32(seed);
  // Frozen nodes never move; they are fixed anchors for the active set.
  const step = (id: string, gradE: number[], eta: number) => {
    if (!active.has(id)) return;
    const x = X.get(id)!;
    const scale = ((1 - dot(x, x)) ** 2) / 4;
    X.set(id, project(x.map((v, i) => v - eta * scale * gradE[i])));
  };

  let loss = 0;
  for (let epoch = 0; epoch < relaxEpochs; epoch++) {
    loss = 0;
    const eta = lr * (1 - (0.9 * epoch) / relaxEpochs);
    for (const e of usable) {
      const u = X.get(e.src)!, v = X.get(e.dst)!;
      const w = edgeStrength(e);
      const diff = poincareDist(u, v) - targetDist(w);
      loss += Math.max(w, 0.1) * diff * diff;
      const coef = 2 * Math.max(w, 0.1) * diff;
      step(e.src, distGrad(u, v).map((g) => coef * g), eta);
      step(e.dst, distGrad(v, u).map((g) => coef * g), eta);

      if (HIERARCHY.has(e.kind)) {
        const xu = X.get(e.src)!, xv = X.get(e.dst)!;
        const ru = norm(xu), rv = norm(xv);
        const viol = constants.HIER_MARGIN + ru - rv;
        if (viol > 0) {
          loss += constants.HIER_WEIGHT * viol * viol;
          const c = 2 * constants.HIER_WEIGHT * viol;
          if (ru > EPS) step(e.src, xu.map((x) => (c * x) / ru), eta);
          if (rv > EPS) step(e.dst, xv.map((x) => (-c * x) / rv), eta);
        }
      }

      for (let k = 0; k < negPerEdge && ids.length > 2; k++) {
        const other = ids[Math.floor(rand() * ids.length)];
        if (other === e.src || other === e.dst || adj.has(`${e.src} ${other}`)) continue;
        const a = X.get(e.src)!, b = X.get(other)!;
        const gap = constants.NEG_MARGIN - poincareDist(a, b);
        if (gap <= 0) continue;
        loss += gap * gap;
        const coef2 = -2 * gap;
        step(e.src, distGrad(a, b).map((g) => coef2 * g), eta);
        step(other, distGrad(b, a).map((g) => coef2 * g), eta);
      }
    }
  }

  const points: Record<string, number[]> = {};
  for (const id of ids) points[id] = X.get(id)!.map((v) => roundTo(v, 6));
  const drift = prior ? atlasDrift(prior, points) : { mean: 0, max: 0, moved: 0 };
  return { dim, points, stats: buildStats(ids, usable, X, relaxEpochs, loss), drift, new_nodes: newNodes, active: active.size };
}

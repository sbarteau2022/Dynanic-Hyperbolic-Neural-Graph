// ============================================================
// Graph edge types + conductance — lifted from elle-worker/src/graph.ts.
// These are the shared vocabulary of the memory graph the atlas embeds. Kept in
// one place so the geometry cores stay decoupled from the worker.
// ============================================================

export type EdgeKind =
  | 'assoc'        // co-recall association (symmetric, self-bootstrapping)
  | 'causal'       // A led to B (directed)
  | 'derived'      // B distilled from A
  | 'refines'      // B refines A
  | 'supersedes'   // B replaces A
  | 'contradicts'  // A and B are in tension
  | 'session'      // co-occurred in one run/session
  | 'about'        // A is about entity/topic B
  | 'tool';        // tool call → its result node

export interface MemEdge { src: string; dst: string; kind: EdgeKind; weight: number }

// How readily activation / attraction flows across each edge kind — the SAME
// constants the worker's spreading activation uses, so the geometry and the
// traversal cannot drift apart.
export const CONDUCTANCE: Record<EdgeKind, number> = {
  assoc: 0.6, causal: 0.7, derived: 0.8, refines: 0.7,
  supersedes: 0.9, contradicts: 0.3, session: 0.5, about: 0.6, tool: 0.5,
};

// Directed provenance kinds — the consequent sits deeper (more derived) than its
// antecedent. Used by the depth hinge in the mapping.
export const HIERARCHY: ReadonlySet<EdgeKind> = new Set<EdgeKind>(['causal', 'derived', 'refines', 'supersedes']);

// ============================================================
// LORENTZ — the hyperboloid model (stability seam)
//
// The Poincaré ball (hyper.ts) is numerically fragile near the boundary: points
// pile toward ‖x‖→1 and every distance/​gradient divides by (1−‖x‖²). Under the
// REPEATED updates a temporal/evolving embedding requires (rebuild after rebuild
// as the graph changes), that fragility compounds. The Lorentz / hyperboloid
// model is the standard fix (Nickel & Kiela 2018; used by the dynamic-hyperbolic
// line — HTGN, HGWaveNet): it represents the same hyperbolic space as the upper
// sheet of a two-sheeted hyperboloid in Minkowski space, where coordinates stay
// finite and the metric has no boundary blow-up.
//
// This module is the seam: exact conversions to/from the Poincaré ball and the
// Minkowski geometry, so temporal.ts (or a future optimizer) can carry state in
// Lorentz coordinates while the rest of the stack keeps talking Poincaré. Pure.
// ============================================================

const EPS = 1e-12;

// Minkowski inner product ⟨u,v⟩_M = −u₀v₀ + Σ_{i≥1} uᵢvᵢ. Lorentz points live on
// the sheet ⟨x,x⟩_M = −1 with x₀ > 0.
export function minkowskiDot(u: number[], v: number[]): number {
  let s = -u[0] * v[0];
  for (let i = 1; i < u.length; i++) s += u[i] * v[i];
  return s;
}

// Geodesic distance on the hyperboloid: arcosh(−⟨u,v⟩_M).
export function lorentzDist(u: number[], v: number[]): number {
  return Math.acosh(Math.max(1, -minkowskiDot(u, v)));
}

// Snap spatial coords onto the sheet by solving x₀ = √(1 + Σ xᵢ²) — the only
// door back onto the manifold after a Euclidean nudge.
export function projectToHyperboloid(spatial: number[]): number[] {
  let s = 0;
  for (const v of spatial) s += v * v;
  return [Math.sqrt(1 + s), ...spatial];
}

// Poincaré ball (dim n) → hyperboloid (dim n+1).
//   x₀ = (1+‖p‖²)/(1−‖p‖²),  xᵢ = 2pᵢ/(1−‖p‖²)
export function poincareToLorentz(p: number[]): number[] {
  let s = 0;
  for (const v of p) s += v * v;
  const denom = Math.max(EPS, 1 - s);
  const x0 = (1 + s) / denom;
  const out = new Array(p.length + 1);
  out[0] = x0;
  for (let i = 0; i < p.length; i++) out[i + 1] = (2 * p[i]) / denom;
  return out;
}

// Hyperboloid (dim n+1) → Poincaré ball (dim n).  pᵢ = xᵢ/(x₀+1)
export function lorentzToPoincare(x: number[]): number[] {
  const d = x[0] + 1;
  const out = new Array(x.length - 1);
  for (let i = 1; i < x.length; i++) out[i - 1] = x[i] / d;
  return out;
}

// Exponential map at a base point x on the hyperboloid, along tangent v
// (⟨x,v⟩_M = 0):  exp_x(v) = cosh‖v‖ · x + sinh‖v‖ · v/‖v‖,  ‖v‖ = √⟨v,v⟩_M.
export function lorentzExpMap(x: number[], v: number[]): number[] {
  const vn = Math.sqrt(Math.max(0, minkowskiDot(v, v)));
  if (vn < EPS) return x.slice();
  const ch = Math.cosh(vn), sh = Math.sinh(vn);
  return x.map((xi, i) => ch * xi + (sh / vn) * v[i]);
}

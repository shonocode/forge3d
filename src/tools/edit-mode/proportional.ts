/**
 * Proportional-editing falloff weights (F-M8) — Blender's "soft select":
 * a component transform also pulls nearby unselected vertices, with
 * influence fading out over a radius.
 *
 * Pure and headless — the gizmo integration lives in component-gizmo.ts.
 * Distance model is euclidean distance to the nearest selected vertex
 * (Blender's default mode; topological "Connected" can come later).
 */

export type ProportionalFalloff =
  | "smooth"
  | "linear"
  | "sharp"
  | "root"
  | "sphere"
  | "inverseSquare"
  | "constant";

/**
 * Blender's falloff curves, as a function of `t` — 1 at the centre, 0 at the
 * rim.
 *
 * All seven were measured off the running binary (Blender 5.1.1) through the
 * Warp modifier, which exposes the same table under `falloff_type`:
 * `tools/modeling/parity/probe-warp.py`. Proportional editing, Warp,
 * vertex-weight proximity and the sculpt brushes all draw on it, so it lives
 * in one place rather than once per caller.
 *
 * The first three were already here, written from the same family and now
 * confirmed rather than assumed. `sphere` is the one a guess gets wrong — it
 * is a quarter circle, `sqrt(2t − t²)`, not `sqrt(t)` (that is `root`).
 *
 * | curve | w(t) | w(0.25) measured |
 * |---|---|---|
 * | `constant` | 1 | 1.000000 |
 * | `linear` | t | 0.250000 |
 * | `sharp` | t² | 0.062500 |
 * | `smooth` | t²(3 − 2t) | 0.156250 |
 * | `root` | √t | 0.500000 |
 * | `inverseSquare` | t(2 − t) | 0.437500 |
 * | `sphere` | √(2t − t²) | 0.661438 |
 */
export function falloffWeight(t: number, falloff: ProportionalFalloff = "smooth"): number {
  switch (falloff) {
    case "constant":
      return 1;
    case "linear":
      return t;
    case "sharp":
      return t * t;
    case "root":
      return Math.sqrt(t);
    case "sphere":
      return Math.sqrt(2 * t - t * t);
    case "inverseSquare":
      return t * (2 - t);
    default:
      return t * t * (3 - 2 * t); // smoothstep
  }
}

/**
 * Compute per-vertex influence weights around a selection.
 *
 * Every seed vertex gets weight 1. Every other vertex within `radius` of the
 * nearest seed gets a weight in (0, 1) shaped by `falloff`:
 *
 * shaped by `falloff` — see `falloffWeight` for the seven curves and the
 * numbers they were measured against. `smooth` is Blender's default.
 *
 * Vertices at or beyond `radius` are omitted entirely, so the result's key
 * set doubles as the "affected vertices" list for snapshots and undo.
 *
 * O(V × S) brute force — forge3d meshes are small (hundreds to a few
 * thousand verts) and this runs once per drag start, not per tick.
 */
export function computeFalloffWeights(
  positions: Float32Array,
  seeds: ReadonlySet<number> | readonly number[],
  radius: number,
  falloff: ProportionalFalloff = "smooth"
): Map<number, number> {
  const weights = new Map<number, number>();
  const seedArr = [...seeds];
  for (const s of seedArr) weights.set(s, 1);
  if (radius <= 0 || seedArr.length === 0) return weights;

  const numVerts = positions.length / 3;
  const r2 = radius * radius;

  for (let v = 0; v < numVerts; v++) {
    if (weights.has(v)) continue;
    const x = positions[v * 3]!;
    const y = positions[v * 3 + 1]!;
    const z = positions[v * 3 + 2]!;

    let best = Infinity;
    for (const s of seedArr) {
      const dx = positions[s * 3]! - x;
      const dy = positions[s * 3 + 1]! - y;
      const dz = positions[s * 3 + 2]! - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < best) best = d2;
    }
    if (best >= r2) continue;

    const t = 1 - Math.sqrt(best) / radius; // 1 at the seed, 0 at the rim
    const w = falloffWeight(t, falloff);
    if (w > 1e-6) weights.set(v, w);
  }
  return weights;
}

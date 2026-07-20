/**
 * Proportional-editing falloff weights (F-M8) — Blender's "soft select":
 * a component transform also pulls nearby unselected vertices, with
 * influence fading out over a radius.
 *
 * Pure and headless — the gizmo integration lives in component-gizmo.ts.
 * Distance model is euclidean distance to the nearest selected vertex
 * (Blender's default mode; topological "Connected" can come later).
 */

export type ProportionalFalloff = "smooth" | "linear" | "sharp";

/**
 * Compute per-vertex influence weights around a selection.
 *
 * Every seed vertex gets weight 1. Every other vertex within `radius` of the
 * nearest seed gets a weight in (0, 1) shaped by `falloff`:
 *
 * - `smooth`: smoothstep — Blender's default, eases in AND out
 * - `linear`: straight ramp
 * - `sharp`:  quadratic — influence hugs the selection
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
    let w: number;
    switch (falloff) {
      case "linear": w = t; break;
      case "sharp": w = t * t; break;
      default: w = t * t * (3 - 2 * t); // smoothstep
    }
    if (w > 1e-6) weights.set(v, w);
  }
  return weights;
}

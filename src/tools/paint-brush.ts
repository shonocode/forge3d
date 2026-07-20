/**
 * Texture paint brush math (F-M11) — pure, headless, Vitest-pinned.
 *
 * The V1 painter dropped one hard-edged dab per pointer event, which reads
 * as a dotted line the moment the cursor moves fast. This module provides
 * the pieces of a proper stroke engine:
 *
 *  - `strokeDabs`   — evenly spaced dab centers along the segment from the
 *                     previous event position to the current one
 *  - `isSeamJump`   — detects UV-island discontinuities (the same drag can
 *                     hop across the atlas when the surface crosses a seam;
 *                     interpolating through the hop would smear paint over
 *                     unrelated islands)
 *  - `brushAlpha`   — hardness-controlled radial falloff (1 = crisp edge,
 *                     0 = fully soft airbrush), used to build the canvas
 *                     radial-gradient stops in the DOM layer
 *
 * All coordinates are texel-space (canvas px).
 */

/**
 * Evenly spaced dab centers from (x0, y0) → (x1, y1), *excluding* the start
 * point (it was stamped by the previous event) and always including the end
 * point. A zero-length segment yields just the end point.
 */
export function strokeDabs(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  spacing: number,
): Array<[number, number]> {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  const step = Math.max(spacing, 0.5);
  if (dist < 1e-9) return [[x1, y1]];
  const out: Array<[number, number]> = [];
  const n = Math.floor(dist / step);
  for (let i = 1; i <= n; i++) {
    const t = (i * step) / dist;
    out.push([x0 + dx * t, y0 + dy * t]);
  }
  // Ensure the stroke reaches the pointer even when dist isn't a multiple
  // of the spacing (skip a duplicate when it landed exactly on the end).
  const last = out[out.length - 1];
  if (!last || Math.hypot(last[0] - x1, last[1] - y1) > 1e-6) out.push([x1, y1]);
  return out;
}

/**
 * True when the segment between two dab positions is too long to be a
 * continuous surface stroke — i.e. the pick crossed a UV seam onto another
 * island. `texSize` scales the threshold (25% of the atlas).
 */
export function isSeamJump(x0: number, y0: number, x1: number, y1: number, texSize: number): boolean {
  return Math.hypot(x1 - x0, y1 - y0) > texSize * 0.25;
}

/**
 * Radial brush alpha at normalized distance `t` ∈ [0, 1] from the dab
 * center, for a given hardness ∈ [0, 1]:
 *  - inside `t ≤ hardness` the brush is fully opaque
 *  - beyond it alpha falls off smoothly (smoothstep) to 0 at the rim
 * hardness 1 → hard circle, hardness 0 → airbrush from the center out.
 */
export function brushAlpha(t: number, hardness: number): number {
  if (t <= 0) return 1;
  if (t >= 1) return 0;
  const h = Math.max(0, Math.min(1, hardness));
  if (t <= h) return 1;
  const k = (t - h) / (1 - h || 1e-9);
  // smoothstep 1 → 0
  const s = 1 - k;
  return s * s * (3 - 2 * s);
}

/**
 * Sculpt masking — pure per-vertex mask helpers. A mask value in [0, 1] marks
 * how protected a vertex is: 0 = fully sculptable, 1 = frozen. Deform brushes
 * scale their per-vertex strength by `(1 - mask)`. The mask survives dyntopo via
 * {@link remapAttribute} (see dyntopo.ts), so freshly subdivided vertices inherit
 * the interpolated protection of their parents.
 */

/** Allocate a zeroed (fully sculptable) mask for `vertexCount` vertices. */
export function createMask(vertexCount: number): Float32Array {
  return new Float32Array(vertexCount);
}

/**
 * Paint a mask dab. Within `radius` of any center, mask values move toward 1
 * (or toward 0 when `invert`) by `strength` weighted by a `(1 - d/R)^falloff`
 * profile. Values are clamped to [0, 1]. Mutates `mask` in place.
 *
 * @returns true if any vertex changed.
 */
export function paintMask(
  mask: Float32Array,
  positions: ArrayLike<number>,
  centers: ReadonlyArray<readonly [number, number, number]>,
  radius: number,
  strength: number,
  falloff: number,
  invert: boolean,
): boolean {
  const r2 = radius * radius;
  const target = invert ? 0 : 1;
  let changed = false;
  for (let vi = 0; vi < mask.length; vi++) {
    const x = positions[vi * 3]!;
    const y = positions[vi * 3 + 1]!;
    const z = positions[vi * 3 + 2]!;
    // Use the strongest influence among symmetric centers.
    let best = 0;
    for (const c of centers) {
      const dx = x - c[0];
      const dy = y - c[1];
      const dz = z - c[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= r2) continue;
      const fall = Math.pow(1 - Math.sqrt(d2) / radius, falloff);
      if (fall > best) best = fall;
    }
    if (best <= 0) continue;
    const prev = mask[vi]!;
    const next = prev + (target - prev) * Math.min(best * strength, 1);
    const clamped = next < 0 ? 0 : next > 1 ? 1 : next;
    if (clamped !== prev) {
      mask[vi] = clamped;
      changed = true;
    }
  }
  return changed;
}

/**
 * Sculpt symmetry — pure helpers for mirroring a brush across object-local
 * axis planes. Each enabled axis reflects every existing center through the
 * plane whose normal is that axis (passing through the local origin), so X+Y
 * yields 4 centers, X+Y+Z yields 8. Centers that coincide (a dab on a mirror
 * plane) are de-duplicated.
 */

export type SymAxis = "x" | "y" | "z";

export interface SymmetryAxes {
  x: boolean;
  y: boolean;
  z: boolean;
}

/** Reflect a local-space point across the object-local plane normal to `axis`. */
export function mirrorPoint(
  x: number,
  y: number,
  z: number,
  axis: SymAxis,
): [number, number, number] {
  if (axis === "x") return [-x, y, z];
  if (axis === "y") return [x, -y, z];
  return [x, y, -z];
}

/**
 * Expand a brush center into all symmetric centers for the enabled axes,
 * including the original. Deduped so a dab on a symmetry plane is applied once.
 */
export function symmetricCenters(
  x: number,
  y: number,
  z: number,
  axes: SymmetryAxes,
): Array<[number, number, number]> {
  let centers: Array<[number, number, number]> = [[x, y, z]];
  const order: SymAxis[] = ["x", "y", "z"];
  for (const ax of order) {
    if (!axes[ax]) continue;
    const reflected = centers.map((c) => mirrorPoint(c[0], c[1], c[2], ax));
    centers = centers.concat(reflected);
  }
  const seen = new Set<string>();
  const result: Array<[number, number, number]> = [];
  for (const c of centers) {
    const key = `${c[0].toFixed(6)},${c[1].toFixed(6)},${c[2].toFixed(6)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(c);
  }
  return result;
}

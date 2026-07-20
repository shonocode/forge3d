/**
 * Angle-based normal control (F-M8) — Blender's Shade Smooth / Shade Flat /
 * Auto Smooth, implemented as one pure rebuild.
 *
 * Vertex buffers store ONE normal per vertex, so a hard edge needs the
 * vertex split. This module computes per-face-corner normals ("smoothing by
 * angle": a corner averages only the incident faces whose normals deviate
 * less than the threshold from its own face), then deduplicates corners that
 * ended up with the same normal — so vertices are split exactly where a hard
 * edge demands it and nowhere else.
 *
 * - `angle = π`   → every incident face averages → classic smooth shading,
 *                   vertex count unchanged.
 * - `angle ≈ 0`   → only (near-)coplanar faces average → flat shading, but
 *                   coplanar neighbors still share verts (a flat plane stays
 *                   un-split).
 * - in between    → Blender's Auto Smooth: soft where curvature is gentle,
 *                   hard past the angle.
 *
 * Pure and headless — Vitest-pinned. The Babylon mesh integration
 * (attribute carry-over, undo) lives in mesh-utils.applyShading.
 */

export interface ShadedMeshResult {
  positions: Float32Array;
  indices: number[];
  normals: Float32Array;
  /** For each output vertex, the input vertex it was copied from —
   *  callers use this to carry UVs / skin weights across the split. */
  sourceVerts: number[];
}

export function shadeAutoSmooth(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  angleRad: number
): ShadedMeshResult {
  const numFaces = indices.length / 3;

  // Area-weighted (unnormalized cross) and unit face normals.
  const faceN = new Float32Array(numFaces * 3);
  const faceUnitN = new Float32Array(numFaces * 3);
  for (let f = 0; f < numFaces; f++) {
    const a = indices[f * 3]!, b = indices[f * 3 + 1]!, c = indices[f * 3 + 2]!;
    const ax = positions[a * 3]!, ay = positions[a * 3 + 1]!, az = positions[a * 3 + 2]!;
    const ux = positions[b * 3]! - ax, uy = positions[b * 3 + 1]! - ay, uz = positions[b * 3 + 2]! - az;
    const wx = positions[c * 3]! - ax, wy = positions[c * 3 + 1]! - ay, wz = positions[c * 3 + 2]! - az;
    const nx = uy * wz - uz * wy;
    const ny = uz * wx - ux * wz;
    const nz = ux * wy - uy * wx;
    faceN[f * 3] = nx; faceN[f * 3 + 1] = ny; faceN[f * 3 + 2] = nz;
    const len = Math.hypot(nx, ny, nz) || 1;
    faceUnitN[f * 3] = nx / len; faceUnitN[f * 3 + 1] = ny / len; faceUnitN[f * 3 + 2] = nz / len;
  }

  // Incident faces per vertex.
  const incident = new Map<number, number[]>();
  for (let f = 0; f < numFaces; f++) {
    for (let k = 0; k < 3; k++) {
      const v = indices[f * 3 + k]!;
      let l = incident.get(v);
      if (!l) { l = []; incident.set(v, l); }
      l.push(f);
    }
  }

  // Small epsilon so exactly-at-threshold (and coplanar at angle 0) faces
  // still count as smooth — float noise must not split a flat plane.
  const cosThreshold = Math.cos(angleRad) - 1e-6;

  const outPositions: number[] = [];
  const outNormals: number[] = [];
  const outIndices: number[] = new Array(indices.length);
  const sourceVerts: number[] = [];
  // Dedup: input vertex + quantized corner normal → output vertex.
  const dedup = new Map<string, number>();

  for (let f = 0; f < numFaces; f++) {
    const fx = faceUnitN[f * 3]!, fy = faceUnitN[f * 3 + 1]!, fz = faceUnitN[f * 3 + 2]!;
    for (let k = 0; k < 3; k++) {
      const v = indices[f * 3 + k]!;

      // Corner normal: sum of area-weighted normals of the incident faces
      // within the smoothing angle of THIS face.
      let sx = 0, sy = 0, sz = 0;
      for (const g of incident.get(v)!) {
        const gx = faceUnitN[g * 3]!, gy = faceUnitN[g * 3 + 1]!, gz = faceUnitN[g * 3 + 2]!;
        if (fx * gx + fy * gy + fz * gz >= cosThreshold) {
          sx += faceN[g * 3]!; sy += faceN[g * 3 + 1]!; sz += faceN[g * 3 + 2]!;
        }
      }
      let len = Math.hypot(sx, sy, sz);
      if (len < 1e-12) { sx = fx; sy = fy; sz = fz; len = 1; }
      sx /= len; sy /= len; sz /= len;

      const key = v + "|" + sx.toFixed(4) + "," + sy.toFixed(4) + "," + sz.toFixed(4);
      let nv = dedup.get(key);
      if (nv === undefined) {
        nv = outPositions.length / 3;
        dedup.set(key, nv);
        outPositions.push(positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!);
        outNormals.push(sx, sy, sz);
        sourceVerts.push(v);
      }
      outIndices[f * 3 + k] = nv;
    }
  }

  return {
    positions: new Float32Array(outPositions),
    indices: outIndices,
    normals: new Float32Array(outNormals),
    sourceVerts,
  };
}

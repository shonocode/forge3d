/**
 * Attribute transfer — carry per-vertex attributes (UVs, skin weights) through
 * topology-changing edit operators.
 *
 * Pure and headless-testable. Operators append new vertices after the original
 * range (the vertex buffer is never compacted in V1), so:
 *  - vertices below `oldVertCount` keep their attribute values verbatim;
 *  - each NEW vertex samples the OLD triangle surface at its own position —
 *    closest point on the old mesh, barycentric interpolation of the corners.
 *
 * At commit time new vertices always lie on (or at) the old surface: extrude
 * duplicates cap verts in place, bevel/loop-cut create verts on existing edges.
 * So the closest-point lookup is exact, not approximate, for the operators we
 * ship. It degrades gracefully (nearest surface point) for anything else.
 */

/** Closest point on triangle (a,b,c) to p, returned as barycentric weights. */
export function closestPointOnTriangleBary(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): { u: number; v: number; w: number; dist2: number } {
  // Ericson, Real-Time Collision Detection §5.1.5.
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;

  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return bary(1, 0, 0);

  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bary(0, 1, 0);

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const t = d1 / (d1 - d3);
    return bary(1 - t, t, 0);
  }

  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return bary(0, 0, 1);

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const t = d2 / (d2 - d6);
    return bary(1 - t, 0, t);
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const t = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return bary(0, 1 - t, t);
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return bary(1 - v - w, v, w);

  function bary(u: number, v: number, w: number) {
    const qx = ax * u + bx * v + cx * w;
    const qy = ay * u + by * v + cy * w;
    const qz = az * u + bz * v + cz * w;
    const dx = px - qx, dy = py - qy, dz = pz - qz;
    return { u, v, w, dist2: dx * dx + dy * dy + dz * dz };
  }
}

interface SurfaceSample {
  /** Corner vertex indices of the closest old triangle. */
  ia: number; ib: number; ic: number;
  /** Barycentric weights of the closest point. */
  u: number; v: number; w: number;
}

/** Find the closest point on the old triangle mesh for one query position. */
function sampleOldSurface(
  oldPos: ArrayLike<number>,
  oldIdx: ArrayLike<number>,
  px: number, py: number, pz: number,
): SurfaceSample | null {
  let best: SurfaceSample | null = null;
  let bestD2 = Infinity;
  for (let t = 0; t < oldIdx.length; t += 3) {
    const ia = oldIdx[t]!, ib = oldIdx[t + 1]!, ic = oldIdx[t + 2]!;
    const r = closestPointOnTriangleBary(
      px, py, pz,
      oldPos[ia * 3]!, oldPos[ia * 3 + 1]!, oldPos[ia * 3 + 2]!,
      oldPos[ib * 3]!, oldPos[ib * 3 + 1]!, oldPos[ib * 3 + 2]!,
      oldPos[ic * 3]!, oldPos[ic * 3 + 1]!, oldPos[ic * 3 + 2]!,
    );
    if (r.dist2 < bestD2) {
      bestD2 = r.dist2;
      best = { ia, ib, ic, u: r.u, v: r.v, w: r.w };
      if (bestD2 === 0) break;
    }
  }
  return best;
}

/**
 * Transfer a `comps`-component per-vertex attribute (e.g. UV, comps=2) onto a
 * grown vertex buffer. Original vertices copy through; new vertices sample the
 * old surface with barycentric interpolation.
 */
export function transferAttribute(
  oldPos: ArrayLike<number>,
  oldIdx: ArrayLike<number>,
  oldAttr: ArrayLike<number>,
  newPos: ArrayLike<number>,
  comps: number,
): Float32Array {
  const oldVertCount = oldPos.length / 3;
  const newVertCount = newPos.length / 3;
  const out = new Float32Array(newVertCount * comps);
  const copyCount = Math.min(oldVertCount, newVertCount) * comps;
  for (let i = 0; i < copyCount; i++) out[i] = oldAttr[i]!;

  for (let vi = oldVertCount; vi < newVertCount; vi++) {
    const s = sampleOldSurface(oldPos, oldIdx, newPos[vi * 3]!, newPos[vi * 3 + 1]!, newPos[vi * 3 + 2]!);
    if (!s) continue;
    for (let k = 0; k < comps; k++) {
      out[vi * comps + k] =
        oldAttr[s.ia * comps + k]! * s.u +
        oldAttr[s.ib * comps + k]! * s.v +
        oldAttr[s.ic * comps + k]! * s.w;
    }
  }
  return out;
}

/**
 * Transfer 4-influence skin weights (Babylon MatricesIndices/MatricesWeights)
 * onto a grown vertex buffer. New vertices blend the three corner verts'
 * influences barycentrically: accumulate weight per bone across up to 12
 * (bone, weight) pairs, keep the strongest 4, renormalize to sum 1.
 */
export function transferSkinWeights(
  oldPos: ArrayLike<number>,
  oldIdx: ArrayLike<number>,
  oldMatricesIndices: ArrayLike<number>,
  oldMatricesWeights: ArrayLike<number>,
  newPos: ArrayLike<number>,
): { matricesIndices: Float32Array; matricesWeights: Float32Array } {
  const oldVertCount = oldPos.length / 3;
  const newVertCount = newPos.length / 3;
  const mi = new Float32Array(newVertCount * 4);
  const mw = new Float32Array(newVertCount * 4);
  const copyCount = Math.min(oldVertCount, newVertCount) * 4;
  for (let i = 0; i < copyCount; i++) {
    mi[i] = oldMatricesIndices[i]!;
    mw[i] = oldMatricesWeights[i]!;
  }

  for (let vi = oldVertCount; vi < newVertCount; vi++) {
    const s = sampleOldSurface(oldPos, oldIdx, newPos[vi * 3]!, newPos[vi * 3 + 1]!, newPos[vi * 3 + 2]!);
    if (!s) continue;
    const acc = new Map<number, number>();
    const corners: Array<[number, number]> = [[s.ia, s.u], [s.ib, s.v], [s.ic, s.w]];
    for (const [cv, bw] of corners) {
      if (bw <= 0) continue;
      for (let k = 0; k < 4; k++) {
        const wgt = oldMatricesWeights[cv * 4 + k]!;
        if (wgt <= 0) continue;
        const bone = oldMatricesIndices[cv * 4 + k]!;
        acc.set(bone, (acc.get(bone) ?? 0) + wgt * bw);
      }
    }
    // Strongest 4 influences, renormalized.
    const top = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    let sum = 0;
    for (const [, wgt] of top) sum += wgt;
    if (sum <= 0) continue;
    for (let k = 0; k < top.length; k++) {
      mi[vi * 4 + k] = top[k]![0];
      mw[vi * 4 + k] = top[k]![1] / sum;
    }
  }
  return { matricesIndices: mi, matricesWeights: mw };
}

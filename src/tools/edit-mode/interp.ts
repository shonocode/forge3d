/**
 * Mean value weights of a point inside a polygon — Blender's
 * `interp_weights_poly_v2` (`blenlib/intern/math_geom.cc`, 5.1.1), as
 * `BM_loop_interp_from_face` calls it: the face is taken into its own plane
 * first, then the weights are worked out in 2D.
 *
 * This is how Blender gives a new vertex inside a face its corner data
 * (UV, colour): `poke`'s centre, and the inner rings of inset and bevel.
 *
 * Pure and headless.
 */

/**
 * Weights `w[i]` for the corners `poly[i]` (vertex indices into `P`) such
 * that `Σ w[i] · corner[i]` interpolates at `co`. `normal` is the face's.
 *
 * Near a corner (closer than 16 float epsilons of the face's extent) the
 * corner gets all the weight; near an edge, the edge's two ends share it
 * linearly — Blender's own fallbacks, because the mean value formula
 * divides by those distances.
 */
export function interpWeightsPoly(
  P: ArrayLike<number>,
  poly: readonly number[],
  normal: readonly [number, number, number],
  co: readonly [number, number, number],
): number[] {

  // An orthonormal frame on the face's plane. The weights depend only on
  // lengths and angles in the plane, so any frame gives Blender's answer.
  const [nx, ny, nz] = normal;
  const ax = Math.abs(nx) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let ux = ny * ax[2]! - nz * ax[1]!;
  let uy = nz * ax[0]! - nx * ax[2]!;
  let uz = nx * ax[1]! - ny * ax[0]!;
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const vx = ny * uz - nz * uy;
  const vy = nz * ux - nx * uz;
  const vz = nx * uy - ny * ux;
  const to2 = (x: number, y: number, z: number): [number, number] => [
    x * ux + y * uy + z * uz,
    x * vx + y * vy + z * vz,
  ];
  const v: Array<[number, number]> = poly.map((i) => to2(P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!));
  const c = to2(co[0], co[1], co[2]);
  return interpWeightsPoly2(v, c);
}

/** `interp_weights_poly_v2` itself, on 2D points. */
export function interpWeightsPoly2(v: ReadonlyArray<readonly [number, number]>, co: readonly [number, number]): number[] {
  const n = v.length;
  const w = new Array<number>(n).fill(0);
  let maxValue = 0;
  for (const p of v) maxValue = Math.max(maxValue, Math.abs(p[0] - co[0]), Math.abs(p[1] - co[1]));
  const eps = 16 * 1.1920929e-7 * maxValue;
  const epsSq = eps * eps;

  const dir = (p: readonly [number, number]): { d: [number, number]; len: number } => {
    const d: [number, number] = [p[0] - co[0], p[1] - co[1]];
    return { d, len: Math.hypot(d[0], d[1]) };
  };
  const halfTan = (a: { d: [number, number]; len: number }, b: { d: [number, number]; len: number }): number => {
    const area = a.d[0] * b.d[1] - a.d[1] * b.d[0];
    if (area !== 0) {
      const dot = a.d[0] * b.d[0] + a.d[1] * b.d[1];
      const r = (a.len * b.len - dot) / area;
      if (Number.isFinite(r)) return r;
    }
    return 0;
  };
  const distSqToSegment = (p: readonly [number, number], a: readonly [number, number], b: readonly [number, number]): number => {
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const l2 = ex * ex + ey * ey;
    let t = l2 > 0 ? ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const dx = a[0] + ex * t - p[0];
    const dy = a[1] + ey * t - p[1];
    return dx * dx + dy * dy;
  };

  let iCurr = n - 1;
  let iNext = 0;
  let dCurr = dir(v[n - 2]!);
  let dNext = dir(v[n - 1]!);
  let htPrev = halfTan(dCurr, dNext);
  let total = 0;
  let flag: "point" | "segment" | null = null;
  while (iNext < n) {
    if (dNext.len < eps) {
      flag = "point";
      break;
    }
    if (distSqToSegment(co, v[iCurr]!, v[iNext]!) < epsSq) {
      flag = "segment";
      break;
    }
    dCurr = dNext;
    dNext = dir(v[iNext]!);
    const ht = halfTan(dCurr, dNext);
    w[iCurr] = dCurr.len === 0 ? 0 : Math.fround((htPrev + ht) / dCurr.len);
    total += w[iCurr]!;
    iCurr = iNext++;
    htPrev = ht;
  }

  if (flag) {
    w.fill(0);
    if (flag === "point") w[iCurr] = 1;
    else {
      const a = v[iCurr]!;
      const b = v[iNext]!;
      const ex = b[0] - a[0];
      const ey = b[1] - a[1];
      const l2 = ex * ex + ey * ey;
      let fac = l2 > 0 ? ((co[0] - a[0]) * ex + (co[1] - a[1]) * ey) / l2 : 0;
      fac = Math.max(0, Math.min(1, fac));
      w[iCurr] = 1 - fac;
      w[iNext] = fac;
    }
  } else if (total !== 0) {
    for (let i = 0; i < n; i++) w[i] = w[i]! / total;
  }
  return w;
}

/**
 * Exact triangle–triangle intersection — `intersect_tri_tri` from Blender's
 * `blenlib/intern/mesh_intersect.cc`, ported for ADR-012.
 *
 * Guigue and Devillers' test ("Faster Triangle-Triangle Intersection Tests"):
 * sign each triangle's vertices against the other's plane, rotate both into a
 * canonical order, then walk a small classification tree to find how the two
 * triangles' intervals along the planes' common line overlap. The answer is
 * nothing, a point, a segment, or "coplanar" (which the caller handles by
 * clustering, not here).
 *
 * **Every sign is exact.** Blender first tries each side-of-plane test in
 * doubles with an absolute error bound (Burnikel, Funke and Seel's supremum
 * and index — `filter_plane_side`), and only when the double is too close to
 * zero to trust does it redo the test in rationals. Intersection points are
 * always rationals, because they are new points that later stages must place
 * exactly. Both halves are ported as they are, constants included.
 */
import {
  div,
  mul,
  q3Cross,
  q3Dot,
  q3Eq,
  q3FromDoubles,
  q3Sub,
  sign,
  sub,
  toDouble,
  type Q,
  type Q3,
} from "./exact";

/** A vertex known both approximately and exactly. */
export interface EVert {
  /** The double coordinates — the input's own, or the rounding of `exact`. */
  readonly co: readonly [number, number, number];
  readonly exact: Q3;
}

/** A triangle and its plane, exact and approximate. */
export interface ETri {
  readonly v: readonly [EVert, EVert, EVert];
  /** `(v0 − v2) × (v1 − v2)` — Blender's orientation for a triangle's normal. */
  readonly nExact: Q3;
  readonly n: readonly [number, number, number];
}

export function evertFromDoubles(x: number, y: number, z: number): EVert {
  return { co: [x, y, z], exact: q3FromDoubles(x, y, z) };
}

export function evertFromExact(exact: Q3): EVert {
  return { co: [toDouble(exact[0]), toDouble(exact[1]), toDouble(exact[2])], exact };
}

/** A triangle with its plane populated exactly, as `Face::populate_plane(true)` does. */
export function makeTri(a: EVert, b: EVert, c: EVert): ETri {
  const nExact = q3Cross(q3Sub(a.exact, c.exact), q3Sub(b.exact, c.exact));
  return {
    v: [a, b, c],
    nExact,
    n: [toDouble(nExact[0]), toDouble(nExact[1]), toDouble(nExact[2])],
  };
}

export type TriTri =
  | { kind: "none" }
  | { kind: "point"; p: Q3 }
  | { kind: "segment"; p1: Q3; p2: Q3 }
  | { kind: "coplanar" };

const DBL_EPSILON = 2.220446049250313e-16;
/** `index_plane_side = 3 + 2 · index_dot_plane_coords`, with the latter 15. */
const INDEX_PLANE_SIDE = 3 + 2 * 15;

type D3 = readonly [number, number, number];

/**
 * Blender's `filter_plane_side`: the side of `p` against the plane through
 * `planeP` with normal `planeNo`, **if doubles can say so for certain**, else
 * 0. The error bound is `supremum · index · ε` from Burnikel et al.
 */
function filterPlaneSide(p: D3, planeP: D3, planeNo: D3): -1 | 0 | 1 {
  const d =
    (p[0] - planeP[0]) * planeNo[0] + (p[1] - planeP[1]) * planeNo[1] + (p[2] - planeP[2]) * planeNo[2];
  if (d === 0) return 0;
  const supremum =
    (Math.abs(p[0]) + Math.abs(planeP[0])) * Math.abs(planeNo[0]) +
    (Math.abs(p[1]) + Math.abs(planeP[1])) * Math.abs(planeNo[1]) +
    (Math.abs(p[2]) + Math.abs(planeP[2])) * Math.abs(planeNo[2]);
  const bound = supremum * INDEX_PLANE_SIDE * DBL_EPSILON;
  if (Math.abs(d) > bound) return d > 0 ? 1 : -1;
  return 0;
}

const sideExact = (p: Q3, planeP: Q3, n: Q3): -1 | 0 | 1 => sign(q3Dot(q3Sub(p, planeP), n));

/**
 * `tti_interp`: the point on `ab` where the plane through `c` with normal `n`
 * crosses it. Assumes `ab` is not parallel to that plane.
 */
function interp(a: Q3, b: Q3, c: Q3, n: Q3): Q3 {
  const ab = q3Sub(a, b);
  const ac = q3Sub(a, c);
  const den = q3Dot(ab, n);
  const alpha: Q = div(q3Dot(ac, n), den);
  return [sub(a[0], mul(alpha, ab[0])), sub(a[1], mul(alpha, ab[1])), sub(a[2], mul(alpha, ab[2]))];
}

/** `tti_above`: is `a + ad` above the plane through `a, b, c` (CCW)? */
function above(a: Q3, b: Q3, c: Q3, ad: Q3): -1 | 0 | 1 {
  return sign(q3Dot(ad, q3Cross(q3Sub(b, a), q3Sub(c, a))));
}

/** `itt_canon2`: both triangles canonical; read the overlap off the tree. */
function canon2(p1: Q3, q1: Q3, r1: Q3, p2: Q3, q2: Q3, r2: Q3, n1: Q3, n2: Q3): TriTri {
  const p1p2 = q3Sub(p2, p1);
  let i1: Q3;
  let i2: Q3;
  if (above(p1, q1, r2, p1p2) > 0) {
    if (above(p1, r1, r2, p1p2) <= 0) {
      if (above(p1, r1, q2, p1p2) > 0) {
        // [k [i l] j]: i on p1r1, l on p2r2.
        i1 = interp(p1, r1, p2, n2);
        i2 = interp(p2, r2, p1, n1);
      } else {
        // [i [k l] j]: k on p2q2, l on p2r2.
        i1 = interp(p2, q2, p1, n1);
        i2 = interp(p2, r2, p1, n1);
      }
    } else return { kind: "none" }; // [k l] [i j]
  } else {
    if (above(p1, q1, q2, p1p2) < 0) return { kind: "none" }; // [i j] [k l]
    if (above(p1, r1, q2, p1p2) >= 0) {
      // [k [i j] l]: i on p1r1, j on p1q1.
      i1 = interp(p1, r1, p2, n2);
      i2 = interp(p1, q1, p2, n2);
    } else {
      // [i [k j] l]: k on p2q2, j on p1q1.
      i1 = interp(p2, q2, p1, n1);
      i2 = interp(p1, q1, p2, n2);
    }
  }
  if (q3Eq(i1, i2)) return { kind: "point", p: i1 };
  return { kind: "segment", p1: i1, p2: i2 };
}

/** `itt_canon1`: triangle 1 canonical; canonicalise triangle 2 and descend. */
function canon1(
  p1: Q3, q1: Q3, r1: Q3, p2: Q3, q2: Q3, r2: Q3, n1: Q3, n2: Q3,
  sp2: number, sq2: number, sr2: number,
): TriTri {
  if (sp2 > 0) {
    if (sq2 > 0) return canon2(p1, r1, q1, r2, p2, q2, n1, n2);
    if (sr2 > 0) return canon2(p1, r1, q1, q2, r2, p2, n1, n2);
    return canon2(p1, q1, r1, p2, q2, r2, n1, n2);
  }
  if (sp2 < 0) {
    if (sq2 < 0) return canon2(p1, q1, r1, r2, p2, q2, n1, n2);
    if (sr2 < 0) return canon2(p1, q1, r1, q2, r2, p2, n1, n2);
    return canon2(p1, r1, q1, p2, q2, r2, n1, n2);
  }
  if (sq2 < 0) {
    if (sr2 >= 0) return canon2(p1, r1, q1, q2, r2, p2, n1, n2);
    return canon2(p1, q1, r1, p2, q2, r2, n1, n2);
  }
  if (sq2 > 0) {
    if (sr2 > 0) return canon2(p1, r1, q1, p2, q2, r2, n1, n2);
    return canon2(p1, q1, r1, q2, r2, p2, n1, n2);
  }
  if (sr2 > 0) return canon2(p1, q1, r1, r2, p2, q2, n1, n2);
  if (sr2 < 0) return canon2(p1, r1, q1, r2, p2, q2, n1, n2);
  return { kind: "coplanar" };
}

/**
 * Where two triangles meet, exactly — Blender's `intersect_tri_tri`.
 *
 * The side tests go through the double filter first and fall back to
 * rationals only when a sign is uncertain, exactly as Blender orders them:
 * t1's vertices against t2's plane, early out; then t2's against t1's.
 */
export function intersectTriTri(t1: ETri, t2: ETri): TriTri {
  const [vp1, vq1, vr1] = t1.v;
  const [vp2, vq2, vr2] = t2.v;

  let sp1: number = filterPlaneSide(vp1.co, vr2.co, t2.n);
  let sq1: number = filterPlaneSide(vq1.co, vr2.co, t2.n);
  let sr1: number = filterPlaneSide(vr1.co, vr2.co, t2.n);
  if ((sp1 > 0 && sq1 > 0 && sr1 > 0) || (sp1 < 0 && sq1 < 0 && sr1 < 0)) return { kind: "none" };

  let sp2: number = filterPlaneSide(vp2.co, vr1.co, t1.n);
  let sq2: number = filterPlaneSide(vq2.co, vr1.co, t1.n);
  let sr2: number = filterPlaneSide(vr2.co, vr1.co, t1.n);
  if ((sp2 > 0 && sq2 > 0 && sr2 > 0) || (sp2 < 0 && sq2 < 0 && sr2 < 0)) return { kind: "none" };

  const p1 = vp1.exact, q1 = vq1.exact, r1 = vr1.exact;
  const p2 = vp2.exact, q2 = vq2.exact, r2 = vr2.exact;
  const n1 = t1.nExact, n2 = t2.nExact;

  if (sp1 === 0) sp1 = sideExact(p1, r2, n2);
  if (sq1 === 0) sq1 = sideExact(q1, r2, n2);
  if (sr1 === 0) sr1 = sideExact(r1, r2, n2);
  if (sp1 * sq1 > 0 && sp1 * sr1 > 0) return { kind: "none" };

  if (sp2 === 0) sp2 = sideExact(p2, r1, n1);
  if (sq2 === 0) sq2 = sideExact(q2, r1, n1);
  if (sr2 === 0) sr2 = sideExact(r2, r1, n1);
  if (sp2 * sq2 > 0 && sp2 * sr2 > 0) return { kind: "none" };

  // Canonical order for triangle 1: p1 alone on its side, or p1 on the plane
  // with q1 and r1 off it on the same side.
  if (sp1 > 0) {
    if (sq1 > 0) return canon1(r1, p1, q1, p2, r2, q2, n1, n2, sp2, sr2, sq2);
    if (sr1 > 0) return canon1(q1, r1, p1, p2, r2, q2, n1, n2, sp2, sr2, sq2);
    return canon1(p1, q1, r1, p2, q2, r2, n1, n2, sp2, sq2, sr2);
  }
  if (sp1 < 0) {
    if (sq1 < 0) return canon1(r1, p1, q1, p2, q2, r2, n1, n2, sp2, sq2, sr2);
    if (sr1 < 0) return canon1(q1, r1, p1, p2, q2, r2, n1, n2, sp2, sq2, sr2);
    return canon1(p1, q1, r1, p2, r2, q2, n1, n2, sp2, sr2, sq2);
  }
  if (sq1 < 0) {
    if (sr1 >= 0) return canon1(q1, r1, p1, p2, r2, q2, n1, n2, sp2, sr2, sq2);
    return canon1(p1, q1, r1, p2, q2, r2, n1, n2, sp2, sq2, sr2);
  }
  if (sq1 > 0) {
    if (sr1 > 0) return canon1(p1, q1, r1, p2, r2, q2, n1, n2, sp2, sr2, sq2);
    return canon1(q1, r1, p1, p2, q2, r2, n1, n2, sp2, sq2, sr2);
  }
  if (sr1 > 0) return canon1(r1, p1, q1, p2, q2, r2, n1, n2, sp2, sq2, sr2);
  if (sr1 < 0) return canon1(r1, p1, q1, p2, r2, q2, n1, n2, sp2, sr2, sq2);
  return { kind: "coplanar" };
}

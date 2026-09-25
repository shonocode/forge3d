/**
 * The vector helpers `bmesh_bevel.cc` calls, written as Blender 5.1.1 writes
 * them (`blenlib/intern/math_geom.cc`, `math_vector.cc`).
 *
 * In double, not float. Bevel's answers are positions, compared against
 * Blender's to 1e-5 on unit-sized inputs, and nothing downstream of these
 * functions turns a rounding difference into a topology difference the way a
 * lattice or a tie does (`.claude/docs/environment.md`, "参照が組合せを決める所は
 * 参照の精度で計算する"). The thresholds that do decide branches — the 2° of
 * `nearly_parallel`, the 1e-6 of `isect_line_line_v3` — are kept exactly, so
 * a branch goes the same way unless an input sits within a float of its edge.
 *
 * Every function is the C one's shape: where Blender normalises a copy, so do
 * these; where it returns the length, so do these.
 */

export type V3 = [number, number, number];
/** A Blender 4×4: `m[i]` is **column** i, as `float[4][4]` is laid out. */
export type M4 = [number[], number[], number[], number[]];

export const v3 = (x = 0, y = 0, z = 0): V3 => [x, y, z];
export const copy = (a: readonly number[]): V3 => [a[0]!, a[1]!, a[2]!];
export const add = (a: readonly number[], b: readonly number[]): V3 => [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
export const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
export const scale = (a: readonly number[], s: number): V3 => [a[0]! * s, a[1]! * s, a[2]! * s];
/** `madd_v3_v3v3fl`: a + b·s. */
export const madd = (a: readonly number[], b: readonly number[], s: number): V3 => [
  a[0]! + b[0]! * s,
  a[1]! + b[1]! * s,
  a[2]! + b[2]! * s,
];
export const negate = (a: readonly number[]): V3 => [-a[0]!, -a[1]!, -a[2]!];
export const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
export const cross = (a: readonly number[], b: readonly number[]): V3 => [
  a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!,
];
export const lenSq = (a: readonly number[]): number => dot(a, a);
export const len = (a: readonly number[]): number => Math.sqrt(dot(a, a));
export const dist = (a: readonly number[], b: readonly number[]): number => len(sub(a, b));
export const distSq = (a: readonly number[], b: readonly number[]): number => lenSq(sub(a, b));
export const mid = (a: readonly number[], b: readonly number[]): V3 => [
  (a[0]! + b[0]!) * 0.5,
  (a[1]! + b[1]!) * 0.5,
  (a[2]! + b[2]!) * 0.5,
];
/** `interp_v3_v3v3`: a + (b − a)·t. */
export const lerp = (a: readonly number[], b: readonly number[], t: number): V3 => {
  const s = 1 - t;
  return [s * a[0]! + t * b[0]!, s * a[1]! + t * b[1]!, s * a[2]! + t * b[2]!];
};
export const isZero = (a: readonly number[]): boolean => a[0] === 0 && a[1] === 0 && a[2] === 0;

/** `normalize_v3`: in place, returning the old length; tiny vectors become zero. */
export function normalize(a: number[]): number {
  let d = dot(a, a);
  if (d > 1.0e-35) {
    d = Math.sqrt(d);
    const s = 1 / d;
    a[0] = a[0]! * s;
    a[1] = a[1]! * s;
    a[2] = a[2]! * s;
    return d;
  }
  a[0] = a[1] = a[2] = 0;
  return 0;
}
export const normalized = (a: readonly number[]): V3 => {
  const r = copy(a);
  normalize(r);
  return r;
};

const safeAsin = (x: number): number => (x <= -1 ? -Math.PI / 2 : x >= 1 ? Math.PI / 2 : Math.asin(x));

/** `angle_normalized_v3v3`: the asin form, more accurate than acos near 0 and π. */
export function angleNormalized(v1: readonly number[], v2: readonly number[]): number {
  if (dot(v1, v2) >= 0) return 2 * safeAsin(dist(v1, v2) / 2);
  return Math.PI - 2 * safeAsin(dist(v1, negate(v2)) / 2);
}
/** `angle_v3v3`: normalises copies first. */
export const angle = (a: readonly number[], b: readonly number[]): number => angleNormalized(normalized(a), normalized(b));
/** `angle_v3v3v3`: the angle at `b`. */
export const angle3 = (a: readonly number[], b: readonly number[], c: readonly number[]): number =>
  angleNormalized(normalized(sub(b, a)), normalized(sub(b, c)));

/** `compare_ff`. */
export const compareFF = (a: number, b: number, maxDiff: number): boolean => Math.abs(a - b) <= maxDiff;

/** `project_v3_v3v3`. */
export function project(p: readonly number[], vProj: readonly number[]): V3 {
  if (isZero(vProj)) return [0, 0, 0];
  return scale(vProj, dot(p, vProj) / dot(vProj, vProj));
}

/**
 * `isect_line_line_epsilon_v3` with its 1e-6: 0 when a line has no length,
 * 1 when coplanar (one point, returned twice), 2 when skew (the closest point
 * on each).
 */
export function isectLineLine(
  v1: readonly number[],
  v2: readonly number[],
  v3_: readonly number[],
  v4: readonly number[],
): { kind: 0 | 1 | 2; i1: V3; i2: V3 } {
  const epsilon = 0.000001;
  let c = sub(v3_, v1);
  let a = sub(v2, v1);
  let b = sub(v4, v3_);
  let ab = cross(a, b);
  const d = dot(c, ab);
  const div = dot(ab, ab);
  if (div === 0) return { kind: 0, i1: [0, 0, 0], i2: [0, 0, 0] };
  if (Math.abs(d) <= epsilon) {
    const cb = cross(c, b);
    a = scale(a, dot(cb, ab) / div);
    const i1 = add(v1, a);
    return { kind: 1, i1, i2: copy(i1) };
  }
  let t = sub(v1, v3_);
  const n = cross(a, b);
  t = project(t, n);
  const v3t = add(v3_, t);
  const v4t = add(v4, t);
  c = sub(v3t, v1);
  a = sub(v2, v1);
  b = sub(v4t, v3t);
  ab = cross(a, b);
  const cb = cross(c, b);
  a = scale(a, dot(cb, ab) / dot(ab, ab));
  const i1 = add(v1, a);
  return { kind: 2, i1, i2: sub(i1, t) };
}

const FLT_EPSILON = 1.1920928955078125e-7;

/** `isect_line_plane_v3`: null when the line is parallel to the plane. */
export function isectLinePlane(
  l1: readonly number[],
  l2: readonly number[],
  planeCo: readonly number[],
  planeNo: readonly number[],
): V3 | null {
  const u = sub(l2, l1);
  const h = sub(l1, planeCo);
  const d = dot(planeNo, u);
  if (Math.abs(d) > FLT_EPSILON) return madd(l1, u, -dot(planeNo, h) / d);
  return null;
}

/** `closest_to_line_segment_v3`. */
export function closestToSegment(p: readonly number[], l1: readonly number[], l2: readonly number[]): V3 {
  const u = sub(l2, l1);
  let lambda = 0;
  let cp: V3 = copy(l1);
  if (!isZero(u)) {
    lambda = dot(u, sub(p, l1)) / dot(u, u);
    cp = madd(l1, u, lambda);
  }
  if (lambda <= 0) return copy(l1);
  if (lambda >= 1) return copy(l2);
  return cp;
}
/** `dist_squared_to_line_segment_v3`. */
export const distSqToSegment = (p: readonly number[], l1: readonly number[], l2: readonly number[]): number =>
  distSq(p, closestToSegment(p, l1, l2));

/** `plane_from_point_normal_v3`: (n, −n·p). */
export const planeFromPointNormal = (p: readonly number[], n: readonly number[]): number[] => [n[0]!, n[1]!, n[2]!, -dot(n, p)];
/** `closest_to_plane_normalized_v3`. */
export function closestToPlaneNormalized(plane: readonly number[], pt: readonly number[]): V3 {
  const side = dot(plane, pt) + plane[3]!;
  return madd(pt, plane, -side);
}
/** `closest_to_plane_v3`: the plane's normal need not be unit. */
export function closestToPlane(plane: readonly number[], pt: readonly number[]): V3 {
  const lenSqN = dot(plane, plane);
  const side = dot(plane, pt) + plane[3]!;
  return madd(pt, plane, -side / lenSqN);
}
/** `dist_squared_to_plane_v3`. */
export function distSqToPlane(pt: readonly number[], plane: readonly number[]): number {
  const lenSqN = dot(plane, plane);
  const side = dot(plane, pt) + plane[3]!;
  const fac = side / lenSqN;
  return fac * fac * lenSqN;
}

/** `interp_bilinear_quad_v3`: corners in the order (0,0) (1,0) (1,1) (0,1) of (u, v). */
export function bilinearQuad(q: readonly (readonly number[])[], u: number, v: number): V3 {
  let r = scale(q[0]!, (1 - u) * (1 - v));
  r = add(r, scale(q[1]!, u * (1 - v)));
  r = add(r, scale(q[2]!, u * v));
  r = add(r, scale(q[3]!, (1 - u) * v));
  return r;
}

/** `mul_v3_m4v3`: the point transform. */
export function mulM4V3(m: M4, v: readonly number[]): V3 {
  const x = v[0]!;
  const y = v[1]!;
  const z = v[2]!;
  return [
    m[0][0]! * x + m[1][0]! * y + m[2][0]! * z + m[3][0]!,
    m[0][1]! * x + m[1][1]! * y + m[2][1]! * z + m[3][1]!,
    m[0][2]! * x + m[1][2]! * y + m[2][2]! * z + m[3][2]!,
  ];
}

/** `invert_m4_m4`: Gauss–Jordan with partial pivoting; null when singular. */
export function invertM4(m: M4): M4 | null {
  // Row-major working copy of the mathematical matrix (Blender's is column-major).
  const a: number[][] = [0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((c) => m[c]![r]!));
  const inv: number[][] = [0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((c) => (r === c ? 1 : 0)));
  for (let i = 0; i < 4; i++) {
    let max = Math.abs(a[i]![i]!);
    let maxj = i;
    for (let j = i + 1; j < 4; j++)
      if (Math.abs(a[j]![i]!) > max) {
        max = Math.abs(a[j]![i]!);
        maxj = j;
      }
    if (maxj !== i) {
      [a[i], a[maxj]] = [a[maxj]!, a[i]!];
      [inv[i], inv[maxj]] = [inv[maxj]!, inv[i]!];
    }
    const temp = a[i]![i]!;
    if (temp === 0) return null;
    for (let k = 0; k < 4; k++) {
      a[i]![k] = a[i]![k]! / temp;
      inv[i]![k] = inv[i]![k]! / temp;
    }
    for (let j = 0; j < 4; j++) {
      if (j === i) continue;
      const t = a[j]![i]!;
      for (let k = 0; k < 4; k++) {
        a[j]![k] = a[j]![k]! - a[i]![k]! * t;
        inv[j]![k] = inv[j]![k]! - inv[i]![k]! * t;
      }
    }
  }
  return [0, 1, 2, 3].map((c) => [0, 1, 2, 3].map((r) => inv[r]![c]!)) as M4;
}

/**
 * Least squares by the normal equations: minimise |A x − b|² for a small dense
 * A (rows × cols). What `EIG_linear_least_squares_solver` returns when A has
 * full column rank, which the bevel width-matching system always does — its
 * spec rows put a weighted identity under every parameter.
 */
export function leastSquares(A: number[][], b: number[], cols: number): number[] {
  const n = cols;
  const M = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const r = new Array<number>(n).fill(0);
  for (let row = 0; row < A.length; row++) {
    const a = A[row]!;
    for (let i = 0; i < n; i++) {
      if (a[i] === 0) continue;
      r[i] = r[i]! + a[i]! * b[row]!;
      for (let j = 0; j < n; j++) M[i]![j] = M[i]![j]! + a[i]! * a[j]!;
    }
  }
  // Gaussian elimination with partial pivoting.
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let j = i + 1; j < n; j++) if (Math.abs(M[j]![i]!) > Math.abs(M[p]![i]!)) p = j;
    [M[i], M[p]] = [M[p]!, M[i]!];
    [r[i], r[p]] = [r[p]!, r[i]!];
    const d = M[i]![i]!;
    if (d === 0) continue;
    for (let j = i + 1; j < n; j++) {
      const t = M[j]![i]! / d;
      if (t === 0) continue;
      for (let k = i; k < n; k++) M[j]![k] = M[j]![k]! - t * M[i]![k]!;
      r[j] = r[j]! - t * r[i]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = r[i]!;
    for (let k = i + 1; k < n; k++) s -= M[i]![k]! * x[k]!;
    x[i] = M[i]![i]! === 0 ? 0 : s / M[i]![i]!;
  }
  return x;
}

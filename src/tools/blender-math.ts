/**
 * Float32 arithmetic in C's evaluation order, and `BLI_heap` — shared by the
 * ports that have to reproduce Blender's answers to the last bit
 * (`decimateCollapse`, `triangulate`).
 *
 * Every helper rounds after each operation with `Math.fround`, so a result
 * is the float Blender's C would have produced (no FMA — MSVC's default).
 * `BLI_heap` is ported with its tie behaviour: `heap_up` moves a node past a
 * parent of equal value, which decides the order of equal costs.
 */

export const f = Math.fround;
export const FLT_EPSILON = 1.1920928955078125e-7;
export const FLT_MAX = 3.4028234663852886e38;

// ── BLI_heap ───────────────────────────────────────────────────────────────

export interface HeapNode<T> {
  value: number;
  index: number;
  ptr: T;
}
export interface Heap<T> {
  tree: HeapNode<T>[];
}

export function heapSwap<T>(h: Heap<T>, i: number, j: number): void {
  const pi = h.tree[i]!;
  const pj = h.tree[j]!;
  pi.index = j;
  h.tree[j] = pi;
  pj.index = i;
  h.tree[i] = pj;
}
export function heapDown<T>(h: Heap<T>, i: number): void {
  const size = h.tree.length;
  for (;;) {
    const l = 2 * i + 1;
    const r = 2 * i + 2;
    let smallest = i;
    if (l < size && h.tree[l]!.value < h.tree[smallest]!.value) smallest = l;
    if (r < size && h.tree[r]!.value < h.tree[smallest]!.value) smallest = r;
    if (smallest === i) break;
    heapSwap(h, i, smallest);
    i = smallest;
  }
}
export function heapUp<T>(h: Heap<T>, i: number): void {
  // Ties move up: the loop only stops when the parent is strictly smaller.
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (h.tree[p]!.value < h.tree[i]!.value) break;
    heapSwap(h, p, i);
    i = p;
  }
}
export function heapInsert<T>(h: Heap<T>, value: number, ptr: T): HeapNode<T> {
  const node = { value: f(value), index: h.tree.length, ptr };
  h.tree.push(node);
  heapUp(h, node.index);
  return node;
}
export function heapPopMin<T>(h: Heap<T>): T {
  const ptr = h.tree[0]!.ptr;
  const size = h.tree.length - 1;
  if (size) heapSwap(h, 0, size);
  h.tree.pop();
  if (size) heapDown(h, 0);
  return ptr;
}
export function heapRemove<T>(h: Heap<T>, node: HeapNode<T>): void {
  let i = node.index;
  while (i > 0) {
    const p = (i - 1) >> 1;
    heapSwap(h, p, i);
    i = p;
  }
  heapPopMin(h);
}
export function heapUpdate<T>(h: Heap<T>, node: HeapNode<T>, value: number, ptr: T): void {
  node.ptr = ptr;
  value = f(value);
  if (value < node.value) {
    node.value = value;
    heapUp(h, node.index);
  } else if (value > node.value) {
    node.value = value;
    heapDown(h, node.index);
  }
}

// ── float vector helpers, C evaluation order ───────────────────────────────

export type V3 = number[];
export const sub = (a: V3, b: V3): V3 => [f(a[0]! - b[0]!), f(a[1]! - b[1]!), f(a[2]! - b[2]!)];
export const dot = (a: V3, b: V3): number => f(f(f(a[0]! * b[0]!) + f(a[1]! * b[1]!)) + f(a[2]! * b[2]!));
export const cross = (a: V3, b: V3): V3 => [
  f(f(a[1]! * b[2]!) - f(a[2]! * b[1]!)),
  f(f(a[2]! * b[0]!) - f(a[0]! * b[2]!)),
  f(f(a[0]! * b[1]!) - f(a[1]! * b[0]!)),
];
export const lenSq = (a: V3): number => dot(a, a);
/** `normalize_v3`: multiplies by the reciprocal. */
export function normalizeInPlace(n: V3): number {
  let d = lenSq(n);
  if (d > 1e-35) {
    d = f(Math.sqrt(d));
    const s = f(1 / d);
    for (let k = 0; k < 3; k++) n[k] = f(n[k]! * s);
    return d;
  }
  n[0] = n[1] = n[2] = 0;
  return 0;
}
/** `math::normalize`: divides by the length. */
export function mathNormalize(a: V3): V3 {
  const l2 = lenSq(a);
  if (l2 > 1e-35) {
    const l = f(Math.sqrt(l2));
    return [f(a[0]! / l), f(a[1]! / l), f(a[2]! / l)];
  }
  return [0, 0, 0];
}
export function normalTri(a: V3, b: V3, c: V3): V3 {
  const n1 = sub(a, b);
  const n2 = sub(b, c);
  const n = cross(n1, n2);
  normalizeInPlace(n);
  return n;
}
export function normalQuad(a: V3, b: V3, c: V3, d: V3): V3 {
  const n = cross(sub(a, c), sub(b, d));
  normalizeInPlace(n);
  return n;
}
/** `add_newell_cross_v3_v3v3` over a ring, starting from (last, first). */
export function newell(ring: V3[]): V3 {
  const n = [0, 0, 0];
  let prev = ring[ring.length - 1]!;
  for (const curr of ring) {
    n[0] = f(n[0]! + f(f(prev[1]! - curr[1]!) * f(prev[2]! + curr[2]!)));
    n[1] = f(n[1]! + f(f(prev[2]! - curr[2]!) * f(prev[0]! + curr[0]!)));
    n[2] = f(n[2]! + f(f(prev[0]! - curr[0]!) * f(prev[1]! + curr[1]!)));
    prev = curr;
  }
  return n;
}
/**
 * `face_normal_calc` (`mesh_normals.cc`): a quad by its two diagonals, a
 * triangle by its cross product, anything larger by Newell — straight up when
 * degenerate. A non-planar quad's diagonal normal is not its Newell normal.
 */
export function faceNormalCalc(P: readonly V3[], poly: readonly number[]): V3 {
  if (poly.length === 4) return normalQuad(P[poly[0]!]!, P[poly[1]!]!, P[poly[2]!]!, P[poly[3]!]!);
  if (poly.length === 3) return normalTri(P[poly[0]!]!, P[poly[1]!]!, P[poly[2]!]!);
  const n = newell(poly.map((v) => P[v]!));
  if (normalizeInPlace(n) === 0) n[2] = 1;
  return n;
}

/**
 * A face normal as the **Mesh** has it — `normals_calc_faces` / `normal_calc_ngon` (`mesh_normals.cc`): Newell for every
 * face, quads and triangles included, straight up when degenerate. `Mesh::face_normals_true()`, which the Mesh-side
 * modifiers read (Solidify, both modes). The BMesh computes its own with {@link faceNormalCalc} (a quad by its
 * diagonals). For a quad the two are the same vector in exact arithmetic (½ d1 × d2); they part only where a face is
 * nearly flat to nothing and the float rounding is all there is (compat-backlog C104: a bevelled arm's crushed quad).
 */
export function meshFaceNormal(P: readonly V3[], poly: readonly number[]): V3 {
  const n = newell(poly.map((v) => P[v]!));
  if (normalizeInPlace(n) === 0) n[2] = 1;
  return n;
}

/** `safe_asinf`: the argument clamped to [-1, 1]. */
function safeAsinf(x: number): number {
  return f(Math.asin(Math.max(-1, Math.min(1, x))));
}

/** `angle_normalized_v3v3`: the angle between two unit vectors by the asin form (more accurate than acos near 0 and π). */
export function angleNormalizedV3v3(a: V3, b: V3): number {
  if (dot(a, b) >= 0) return f(2 * safeAsinf(f(f(Math.sqrt(lenSq(sub(a, b)))) / 2)));
  const nb: V3 = [-b[0]!, -b[1]!, -b[2]!];
  return f(f(Math.PI) - f(2 * safeAsinf(f(f(Math.sqrt(lenSq(sub(a, nb)))) / 2))));
}

/**
 * `face_angles_calc` (`mesh_evaluate.cc`): per corner, the angle between `prev − this` and `this − next` — the turn,
 * π minus the interior angle — on float-normalised edges. The Weighted Normal's angle modes read `π − this`.
 */
export function meshFaceAngles(P: readonly V3[], poly: readonly number[]): number[] {
  const n = poly.length;
  const out = new Array<number>(n);
  let iThis = n - 1;
  const prev = sub(P[poly[iThis - 1]!]!, P[poly[iThis]!]!);
  normalizeInPlace(prev);
  for (let iNext = 0; iNext < n; iNext++) {
    const next = sub(P[poly[iThis]!]!, P[poly[iNext]!]!);
    normalizeInPlace(next);
    out[iThis] = angleNormalizedV3v3(prev, next);
    prev[0] = next[0]!;
    prev[1] = next[1]!;
    prev[2] = next[2]!;
    iThis = iNext;
  }
  return out;
}

/**
 * `face_area_calc` (`mesh_evaluate.cc`): a triangle by `area_tri_v3`, anything larger by `area_poly_v3` — half the
 * length of the Newell vector, in float. The cross products cancel where the polygon turns back, so a twisted or
 * folded quad (a rim face Solidify makes between two vertices nearly on top of each other) has far less than its
 * triangles' areas summed (compat-backlog C104).
 */
export function meshFaceArea(P: readonly V3[], poly: readonly number[]): number {
  const n = poly.length === 3 ? cross(sub(P[poly[0]!]!, P[poly[1]!]!), sub(P[poly[1]!]!, P[poly[2]!]!)) : newell(poly.map((v) => P[v]!));
  return f(f(Math.sqrt(lenSq(n))) * 0.5);
}

/**
 * `Mesh::vert_normals()` / `normals_calc_verts`: each face's normal weighted by
 * the corner's angle (`safe_acos_approx`), summed and normalised. A vertex on
 * no face takes its own position, normalised — Blender's.
 *
 * The face normals are the Mesh's, {@link meshFaceNormal} (Newell) — also what a BMesh made from the Mesh starts with
 * (`BM_mesh_bm_from_me` copies `vert_normals()`). `faceNormal` is for a BMesh that recomputes them after an edit
 * (`BM_mesh_normals_update`, {@link faceNormalCalc}).
 */
export function meshVertNormals(
  P: readonly V3[],
  polys: readonly (readonly number[])[],
  faceNormal: (P: readonly V3[], poly: readonly number[]) => V3 = meshFaceNormal,
): V3[] {
  const faceNo = polys.map((p) => faceNormal(P, p));
  const acc: V3[] = P.map(() => [0, 0, 0]);
  const has = new Uint8Array(P.length);
  polys.forEach((p, fi) => {
    for (let c = 0; c < p.length; c++) {
      const v = p[c]!;
      if (p.indexOf(v) !== c) continue; // face_find_adjacent_verts takes the first corner
      has[v] = 1;
      const prev = p[(c - 1 + p.length) % p.length]!;
      const next = p[(c + 1) % p.length]!;
      const dp = mathNormalize(sub(P[prev]!, P[v]!));
      const dn = mathNormalize(sub(P[next]!, P[v]!));
      const w = safeAcosApprox(dot(dp, dn));
      const a = acc[v]!;
      const fn = faceNo[fi]!;
      for (let k = 0; k < 3; k++) a[k] = f(a[k]! + f(fn[k]! * w));
    }
  });
  return acc.map((a, v) => (has[v] ? mathNormalize(a) : mathNormalize(P[v]!)));
}

export function safeAcosApprox(x: number): number {
  const fa = Math.abs(x);
  const m = fa < 1 ? f(1 - f(1 - fa)) : 1;
  const a = f(
    f(Math.sqrt(f(1 - m))) *
      f(
        f(1.5707963267) +
          f(m * f(f(-0.213300989) + f(m * f(f(0.077980478) + f(m * f(-0.02164095)))))),
      ),
  );
  return x < 0 ? f(f(Math.PI) - a) : a;
}

/** Invert a 4 × 4 row-major matrix (cofactors). */
export function invert4(a: readonly number[]): number[] {
  const inv = new Array<number>(16);
  inv[0] = a[5]! * a[10]! * a[15]! - a[5]! * a[11]! * a[14]! - a[9]! * a[6]! * a[15]! + a[9]! * a[7]! * a[14]! + a[13]! * a[6]! * a[11]! - a[13]! * a[7]! * a[10]!;
  inv[4] = -a[4]! * a[10]! * a[15]! + a[4]! * a[11]! * a[14]! + a[8]! * a[6]! * a[15]! - a[8]! * a[7]! * a[14]! - a[12]! * a[6]! * a[11]! + a[12]! * a[7]! * a[10]!;
  inv[8] = a[4]! * a[9]! * a[15]! - a[4]! * a[11]! * a[13]! - a[8]! * a[5]! * a[15]! + a[8]! * a[7]! * a[13]! + a[12]! * a[5]! * a[11]! - a[12]! * a[7]! * a[9]!;
  inv[12] = -a[4]! * a[9]! * a[14]! + a[4]! * a[10]! * a[13]! + a[8]! * a[5]! * a[14]! - a[8]! * a[6]! * a[13]! - a[12]! * a[5]! * a[10]! + a[12]! * a[6]! * a[9]!;
  inv[1] = -a[1]! * a[10]! * a[15]! + a[1]! * a[11]! * a[14]! + a[9]! * a[2]! * a[15]! - a[9]! * a[3]! * a[14]! - a[13]! * a[2]! * a[11]! + a[13]! * a[3]! * a[10]!;
  inv[5] = a[0]! * a[10]! * a[15]! - a[0]! * a[11]! * a[14]! - a[8]! * a[2]! * a[15]! + a[8]! * a[3]! * a[14]! + a[12]! * a[2]! * a[11]! - a[12]! * a[3]! * a[10]!;
  inv[9] = -a[0]! * a[9]! * a[15]! + a[0]! * a[11]! * a[13]! + a[8]! * a[1]! * a[15]! - a[8]! * a[3]! * a[13]! - a[12]! * a[1]! * a[11]! + a[12]! * a[3]! * a[9]!;
  inv[13] = a[0]! * a[9]! * a[14]! - a[0]! * a[10]! * a[13]! - a[8]! * a[1]! * a[14]! + a[8]! * a[2]! * a[13]! + a[12]! * a[1]! * a[10]! - a[12]! * a[2]! * a[9]!;
  inv[2] = a[1]! * a[6]! * a[15]! - a[1]! * a[7]! * a[14]! - a[5]! * a[2]! * a[15]! + a[5]! * a[3]! * a[14]! + a[13]! * a[2]! * a[7]! - a[13]! * a[3]! * a[6]!;
  inv[6] = -a[0]! * a[6]! * a[15]! + a[0]! * a[7]! * a[14]! + a[4]! * a[2]! * a[15]! - a[4]! * a[3]! * a[14]! - a[12]! * a[2]! * a[7]! + a[12]! * a[3]! * a[6]!;
  inv[10] = a[0]! * a[5]! * a[15]! - a[0]! * a[7]! * a[13]! - a[4]! * a[1]! * a[15]! + a[4]! * a[3]! * a[13]! + a[12]! * a[1]! * a[7]! - a[12]! * a[3]! * a[5]!;
  inv[14] = -a[0]! * a[5]! * a[14]! + a[0]! * a[6]! * a[13]! + a[4]! * a[1]! * a[14]! - a[4]! * a[2]! * a[13]! - a[12]! * a[1]! * a[6]! + a[12]! * a[2]! * a[5]!;
  inv[3] = -a[1]! * a[6]! * a[11]! + a[1]! * a[7]! * a[10]! + a[5]! * a[2]! * a[11]! - a[5]! * a[3]! * a[10]! - a[9]! * a[2]! * a[7]! + a[9]! * a[3]! * a[6]!;
  inv[7] = a[0]! * a[6]! * a[11]! - a[0]! * a[7]! * a[10]! - a[4]! * a[2]! * a[11]! + a[4]! * a[3]! * a[10]! + a[8]! * a[2]! * a[7]! - a[8]! * a[3]! * a[6]!;
  inv[11] = -a[0]! * a[5]! * a[11]! + a[0]! * a[7]! * a[9]! + a[4]! * a[1]! * a[11]! - a[4]! * a[3]! * a[9]! - a[8]! * a[1]! * a[7]! + a[8]! * a[3]! * a[5]!;
  inv[15] = a[0]! * a[5]! * a[10]! - a[0]! * a[6]! * a[9]! - a[4]! * a[1]! * a[10]! + a[4]! * a[2]! * a[9]! + a[8]! * a[1]! * a[6]! - a[8]! * a[2]! * a[5]!;
  const det = a[0]! * inv[0]! + a[1]! * inv[4]! + a[2]! * inv[8]! + a[3]! * inv[12]!;
  if (det === 0) throw new Error("invert4: the matrix is singular");
  return inv.map((x) => x / det);
}

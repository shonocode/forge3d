/**
 * Blender's polygon tessellation for faces of five or more vertices —
 * `BLI_polyfill_calc` (`blenlib/intern/polyfill_2d.cc`) fed the way
 * `bmesh_mesh_tessellate.cc` feeds it: the face projected along its negated
 * Newell normal, clockwise, `coords_sign = 1`.
 *
 * Ported for `intersect`, which takes the edit mesh's own tessellation
 * (`em->looptris`) as its triangulation. Which diagonals a bent n-gon gets
 * decides both where cuts run across it and which pieces survive, so this
 * is not a triangulation "like" Blender's: it is the same ear clipping, in
 * the same order, **in float32** (every operation rounded with
 * `Math.fround`), because the ear tests compare against zero in float.
 *
 * What is left out does not change the answer: the kd-tree only speeds up
 * the "is any concave vertex inside this ear" search, and its index cache
 * only remembers a previous hit.
 */

const f = Math.fround;

const CONCAVE = -1;
const TANGENTIAL = 0;
const CONVEX = 1;
type ESign = -1 | 0 | 1;

type V2 = readonly [number, number];

const signum = (a: number): ESign => (a > 0 ? CONVEX : a === 0 ? TANGENTIAL : CONCAVE);

/** `area_tri_signed_v2_alt_2x`, in float. */
function area2x(v1: V2, v2: V2, v3: V2): number {
  const d2x = f(v2[0] - v1[0]);
  const d2y = f(v2[1] - v1[1]);
  const d3x = f(v3[0] - v1[0]);
  const d3y = f(v3[1] - v1[1]);
  return f(f(d2x * d3y) - f(d3x * d2y));
}

const spanSign = (v1: V2, v2: V2, v3: V2): ESign => signum(area2x(v3, v2, v1));

/**
 * Triangulate a simple polygon given as 2D float coordinates wound
 * clockwise (Blender's `coords_sign = 1`). Returns index triples into
 * `coords`, in Blender's order.
 */
export function polyfill(coords: readonly V2[]): [number, number, number][] {
  const n = coords.length;
  const next = new Int32Array(n);
  const prev = new Int32Array(n);
  const sign = new Int8Array(n);
  /** In the kd-tree: not convex when last computed, not yet clipped. */
  const inTree = new Uint8Array(n);
  let head = 0;
  let count = n;
  for (let i = 0; i < n; i++) {
    next[i] = (i + 1) % n;
    prev[i] = (i - 1 + n) % n;
  }
  const calcSign = (i: number): void => {
    sign[i] = spanSign(coords[prev[i]!]!, coords[i]!, coords[next[i]!]!);
  };
  let concave = 0;
  for (let i = 0; i < n; i++) {
    calcSign(i);
    if (sign[i] !== CONVEX) {
      concave++;
      inTree[i] = 1;
    }
  }
  const tris: [number, number, number][] = [];

  /** `tri_isect_precomputed_test`, for the triangle (tip, next, prev). */
  const blocked = (tip: number): boolean => {
    const ind = [tip, next[tip]!, prev[tip]!];
    const vs = ind.map((i) => coords[i]!);
    const e = [0, 1, 2].map((k) => [f(vs[(k + 1) % 3]![0] - vs[k]![0]), f(vs[(k + 1) % 3]![1] - vs[k]![1])]);
    const c = [0, 1, 2].map((k) => f(f(e[k]![0]! * vs[k]![1]) - f(vs[k]![0] * e[k]![1]!)));
    const side = (k: number, p: V2): boolean => f(f(f(e[k]![1]! * p[0]) - f(e[k]![0]! * p[1])) + c[k]!) >= 0;
    for (let i = 0; i < n; i++) {
      if (!inTree[i] || ind.includes(i)) continue;
      const p = coords[i]!;
      if (side(1, p) && side(2, p) && side(0, p)) return true;
    }
    return false;
  };

  const earTipCheck = (tip: number, accept: ESign): boolean => {
    if (concave === 0) return true; // "fast-path for circles"
    if (sign[tip] !== accept) return false;
    return !blocked(tip);
  };

  const earTipFind = (init: number, reverse: boolean): number => {
    for (let accept: ESign = CONVEX; accept >= TANGENTIAL; accept = (accept - 1) as ESign) {
      let ear = init;
      for (let i = count; i-- > 0; ) {
        if (earTipCheck(ear, accept)) return ear;
        ear = reverse ? prev[ear]! : next[ear]!;
      }
    }
    // Desperate mode: a convex or tangential vertex, else the last one.
    let ear = init;
    for (let i = count; i-- > 0; ) {
      if (sign[ear] !== CONCAVE) return ear;
      ear = next[ear]!;
    }
    return ear;
  };

  const remove = (i: number): void => {
    inTree[i] = 0;
    next[prev[i]!] = next[i]!;
    prev[next[i]!] = prev[i]!;
    if (head === i) head = next[i]!;
    count--;
  };

  let earInit = head;
  let reverse = false;
  while (count > 3) {
    const ear = earTipFind(earInit, reverse);
    if (sign[ear] !== CONVEX) concave--;
    const p = prev[ear]!;
    const nx = next[ear]!;
    tris.push([p, ear, nx]);
    remove(ear);
    for (const side of [p, nx]) {
      if (sign[side] !== CONVEX) {
        calcSign(side);
        if (sign[side] === CONVEX) {
          concave--;
          inTree[side] = 0;
        }
      }
    }
    earInit = reverse ? prev[p]! : next[nx]!;
    if (sign[earInit] !== CONVEX) {
      earInit = reverse ? prev[earInit]! : next[earInit]!;
      reverse = !reverse;
    }
  }
  if (count === 3) tris.push([head, next[head]!, next[next[head]!]!]);
  return tris;
}

/**
 * The tessellation of polygon `poly` (indices into `positions`) as Blender's
 * edit mesh has it: Newell normal in float, projected along its negation,
 * then `polyfill`. Returns triples of **positions in `poly`**.
 */
export function tessellateNgon(poly: readonly number[], positions: ArrayLike<number>): [number, number, number][] {
  const co = poly.map((v) => [positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!].map(f));
  // Newell's method, `add_newell_cross_v3_v3v3`, starting from (last, first).
  const nrm = [0, 0, 0];
  for (let i = 0; i < co.length; i++) {
    const a = co[(i - 1 + co.length) % co.length]!;
    const b = co[i]!;
    nrm[0] = f(nrm[0]! + f(f(a[1]! - b[1]!) * f(a[2]! + b[2]!)));
    nrm[1] = f(nrm[1]! + f(f(a[2]! - b[2]!) * f(a[0]! + b[0]!)));
    nrm[2] = f(nrm[2]! + f(f(a[0]! - b[0]!) * f(a[1]! + b[1]!)));
  }
  let d = f(f(f(nrm[0]! * nrm[0]!) + f(nrm[1]! * nrm[1]!)) + f(nrm[2]! * nrm[2]!));
  if (d > 1e-35) {
    d = f(Math.sqrt(d));
    const s = f(1 / d);
    for (let k = 0; k < 3; k++) nrm[k] = f(nrm[k]! * s);
  } else nrm.fill(0);
  // `axis_dominant_v3_to_m3_negate` → rows r0, r1 of the basis about −normal.
  const m = nrm.map((c) => -c);
  let r0: number[];
  let r1: number[];
  const len2 = f(f(m[0]! * m[0]!) + f(m[1]! * m[1]!));
  if (len2 > 1.1920928955078125e-7) {
    const dd = f(1 / f(Math.sqrt(len2)));
    r0 = [f(m[1]! * dd), f(-m[0]! * dd), 0];
    r1 = [f(-m[2]! * r0[1]!), f(m[2]! * r0[0]!), f(f(m[0]! * r0[1]!) - f(m[1]! * r0[0]!))];
  } else {
    r0 = [m[2]! < 0 ? -1 : 1, 0, 0];
    r1 = [0, 1, 0];
  }
  const dot = (r: number[], a: number[]): number => f(f(f(r[0]! * a[0]!) + f(r[1]! * a[1]!)) + f(r[2]! * a[2]!));
  return polyfill(co.map((a) => [dot(r0, a), dot(r1, a)] as const));
}

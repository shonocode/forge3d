/**
 * Triangulation as Blender does it — `BM_face_triangulate`
 * (`bmesh/intern/bmesh_polygon.cc`), which is behind `bmesh.ops.triangulate`,
 * the Triangulate modifier and the first step of Decimate ▸ Collapse.
 *
 * - **Quads** by `quad_method`: `fixed` (0–2), `alternate` (1–3),
 *   `shortEdge` / `longEdge` (by diagonal length), or `beauty` — Blender's
 *   default — which first refuses a diagonal that would fold the quad
 *   (`is_quad_flip_v3`), then compares the two splits' area-over-perimeter in
 *   the plane of the pair (`BLI_polyfill_edge_calc_rotate_beauty__area`).
 * - **N-gons** by `ngon_method`: `earClip` is `BLI_polyfill_calc` on the face
 *   projected along its negated Newell normal; `beauty` then rotates internal
 *   edges while that improves the same measure (`BLI_polyfill_beautify`).
 *
 * All in float32, in C's evaluation order — the choice between two diagonals
 * is a comparison, and a comparison is where double arithmetic answers
 * differently.
 *
 * Pure and headless.
 */
import type { MeshData } from "../lib/mesh";
import { polyfill } from "./boolean/polyfill";
import {
  f, FLT_EPSILON, FLT_MAX, sub, dot, cross, lenSq, normalizeInPlace, newell,
  heapInsert, heapPopMin, heapRemove, heapUpdate, type V3, type Heap, type HeapNode,
} from "./blender-math";

// ── beauty (quads) and polyfill beautify (n-gons) ──────────────────────────

export const crossTri2 = (a: number[], b: number[], c: number[]): number =>
  f(f(f(a[0]! - b[0]!) * f(b[1]! - c[1]!)) + f(f(a[1]! - b[1]!) * f(c[0]! - b[0]!)));
export const len2 = (a: number[], b: number[]): number => {
  const dx = f(a[0]! - b[0]!);
  const dy = f(a[1]! - b[1]!);
  return f(Math.sqrt(f(f(dx * dx) + f(dy * dy))));
};

/** `BLI_polyfill_beautify_quad_rotate_calc_ex`: negative when 1–3 beats 2–4. */
export function quadRotateCalc(v1: number[], v2: number[], v3: number[], v4: number[], lockDegenerate: boolean, rArea?: { value: number }): number {
  const eps = f(1e-12);
  const a234 = crossTri2(v2, v3, v4);
  const a241 = crossTri2(v2, v4, v1);
  const a123 = crossTri2(v1, v2, v3);
  const a134 = crossTri2(v1, v3, v4);
  if (rArea) rArea.value = f(f(f(f(Math.abs(a234)) + f(Math.abs(a241))) + f(Math.abs(a123))) + f(Math.abs(a134))) / 8;
  if (rArea) rArea.value = f(rArea.value);
  if (a123 >= 0 !== a134 >= 0) return FLT_MAX;
  if (Math.abs(a123) <= eps || Math.abs(a134) <= eps) return FLT_MAX;
  if (a234 >= 0 !== a241 >= 0) {
    if (lockDegenerate) return FLT_MAX;
    return -FLT_MAX;
  }
  if (Math.abs(a234) <= eps || Math.abs(a241) <= eps) return -FLT_MAX;
  const l12 = len2(v1, v2), l23 = len2(v2, v3), l34 = len2(v3, v4), l41 = len2(v4, v1);
  const l13 = len2(v1, v3), l24 = len2(v2, v4);
  let areaA = f(Math.abs(a234)), areaB = f(Math.abs(a241));
  let primA = f(f(l23 + l34) + l24), primB = f(f(l41 + l12) + l24);
  const fac24 = f(f(areaA / primA) + f(areaB / primB));
  areaA = f(Math.abs(a123));
  areaB = f(Math.abs(a134));
  primA = f(f(l12 + l23) + l13);
  primB = f(f(l34 + l41) + l13);
  const fac13 = f(f(areaA / primA) + f(areaB / primB));
  return f(fac24 - fac13);
}

/** `axis_dominant_v3_to_m3` (negate = the `_negate` variant): the two rows. */
export function axisRows(no: V3, negate: boolean): [V3, V3] {
  const n = negate ? no.map((c) => -c) : no;
  const l2 = f(f(n[0]! * n[0]!) + f(n[1]! * n[1]!));
  if (l2 > FLT_EPSILON) {
    const d = f(1 / f(Math.sqrt(l2)));
    const r0 = [f(n[1]! * d), f(-n[0]! * d), 0];
    const r1 = [f(-n[2]! * r0[1]!), f(n[2]! * r0[0]!), f(f(n[0]! * r0[1]!) - f(n[1]! * r0[0]!))];
    return [r0, r1];
  }
  return [[n[2]! < 0 ? -1 : 1, 0, 0], [0, 1, 0]];
}
export const project = (rows: [V3, V3], a: V3): number[] => [dot(rows[0], a), dot(rows[1], a)];

/** `BM_verts_calc_rotate_beauty(v1..v4, 0, 0)`: > 0 means split 2–4. */
export function rotateBeauty(v1: V3, v2: V3, v3: V3, v4: V3): number {
  if (v1 === v3) return FLT_MAX;
  const noA = crossTriV3(v2, v3, v4);
  const noB = crossTriV3(v2, v4, v1);
  const no = [f(noA[0]! + noB[0]!), f(noA[1]! + noB[1]!), f(noA[2]! + noB[2]!)];
  const scale = normalizeInPlace(no);
  if (scale === 0) return FLT_MAX;
  const rows = axisRows(no, false);
  const p1 = project(rows, v1), p2 = project(rows, v2), p3 = project(rows, v3), p4 = project(rows, v4);
  const signum = (a: number): number => (a > 1e-5 ? 1 : a < -1e-5 ? -1 : 0);
  if (!(signum(f(crossTri2(p2, p3, p4) / scale)) + signum(f(crossTri2(p2, p4, p1) / scale)))) return FLT_MAX;
  return quadRotateCalc(p1, p2, p3, p4, false);
}
/** `cross_tri_v3`. */
export function crossTriV3(a: V3, b: V3, c: V3): V3 {
  return cross(sub(a, b), sub(b, c));
}

/** `is_quad_flip_v3`. */
export function isQuadFlip(v1: V3, v2: V3, v3: V3, v4: V3): number {
  const d12 = sub(v1, v2), d23 = sub(v2, v3), d34 = sub(v3, v4), d41 = sub(v4, v1);
  let ret = 0;
  if (dot(cross(d12, d23), cross(d34, d41)) < 0) ret |= 1;
  if (dot(cross(d23, d34), cross(d41, d12)) < 0) ret |= 2;
  return ret;
}
/** `is_quad_convex_v3`. */
export function isQuadConvex(v1: V3, v2: V3, v3: V3, v4: V3): boolean {
  const plane = cross(sub(v1, v3), sub(v2, v4));
  if (lenSq(plane) < f(f(1e-8) * f(1e-8))) return false;
  const pp = dot(plane, plane);
  const proj = [v1, v2, v3, v4].map((p) => {
    const mul = f(dot(p, plane) / pp);
    return [f(p[0]! + f(plane[0]! * -mul)), f(p[1]! + f(plane[1]! * -mul)), f(p[2]! + f(plane[2]! * -mul))];
  });
  const dirs: V3[] = [];
  for (let i = 0, j = 3; i < 4; j = i++) dirs[i] = sub(proj[i]!, proj[j]!);
  const sign = (a: V3, b: V3): boolean => dot(plane, cross(a, b)) > 0;
  return sign(dirs[0]!, dirs[1]!) && sign(dirs[1]!, dirs[2]!) && sign(dirs[2]!, dirs[3]!) && sign(dirs[3]!, dirs[0]!);
}

/** `BLI_polyfill_beautify`: rotate internal edges of a polyfill until none improves. */
export function polyfillBeautify(coords: number[][], tris: number[][]): number[][] {
  const n = coords.length;
  const coordLast = n - 1;
  const trisLen = n - 2;
  const NONE = -1;
  const he: { v: number; next: number; radial: number; base: number }[] = [];
  const order: { a: number; b: number; half: number }[] = [];
  for (let i = 0; i < trisLen; i++)
    for (let jCurr = 0, jPrev = 2; jCurr < 3; jPrev = jCurr++) {
      const ePrev = i * 3 + jPrev;
      const eCurr = i * 3 + jCurr;
      he[ePrev] = { v: tris[i]![jPrev]!, next: eCurr, radial: NONE, base: NONE };
      let a = tris[i]![jPrev]!;
      let b = tris[i]![jCurr]!;
      if (a > b) [a, b] = [b, a];
      const boundary = a + 1 === b || (a === 0 && b === coordLast);
      if (!boundary) order.push({ a, b, half: ePrev });
    }
  order.sort((x, y) => x.a - y.a || x.b - y.b || x.half - y.half);
  for (let i = 0, base = 0; i < order.length; base++) {
    const x = order[i++]!;
    const y = order[i++]!;
    he[x.half]!.radial = y.half;
    he[y.half]!.radial = x.half;
    he[x.half]!.base = base;
    he[y.half]!.base = base;
  }
  const calc = (ei: number, rArea?: { value: number }): number => {
    const e = he[ei]!;
    const eb = he[e.radial]!;
    const aOther = he[he[e.next]!.next]!;
    const bOther = he[he[eb.next]!.next]!;
    return quadRotateCalc(coords[aOther.v]!, coords[e.v]!, coords[bOther.v]!, coords[eb.v]!, false, rArea);
  };
  const heap: Heap<number> = { tree: [] };
  const table: (HeapNode<number> | null)[] = [];
  for (let i = 0; i < he.length; i++) {
    const e = he[i]!;
    if (e.radial !== NONE && e.radial < i) {
      const cost = calc(i);
      table[e.base] = cost < 0 ? heapInsert(heap, cost, i) : null;
    }
  }
  const updateSingle = (ei: number): void => {
    const e = he[ei]!;
    const area = { value: 0 };
    const cost = calc(ei, area);
    if (cost < f(f(-1e-6) * Math.max(area.value, 1))) {
      const node = table[e.base];
      if (node) heapUpdate(heap, node, cost, ei);
      else table[e.base] = heapInsert(heap, cost, ei);
    } else if (table[e.base]) {
      heapRemove(heap, table[e.base]!);
      table[e.base] = null;
    }
  };
  while (heap.tree.length) {
    const ei = heapPopMin(heap);
    table[he[ei]!.base] = null;
    // polyedge_rotate
    const ed: number[] = [];
    ed[0] = ei;
    ed[1] = he[ed[0]]!.next;
    ed[2] = he[ed[1]]!.next;
    ed[3] = he[ei]!.radial;
    ed[4] = he[ed[3]]!.next;
    ed[5] = he[ed[4]]!.next;
    he[ed[0]]!.next = ed[2]!;
    he[ed[1]!]!.next = ed[3]!;
    he[ed[2]!]!.next = ed[4]!;
    he[ed[3]!]!.next = ed[5]!;
    he[ed[4]!]!.next = ed[0]!;
    he[ed[5]!]!.next = ed[1]!;
    he[ed[0]]!.v = he[ed[5]!]!.v;
    he[ed[3]!]!.v = he[ed[2]!]!.v;
    // polyedge_beauty_cost_update
    const arr: number[] = [];
    arr[0] = he[ei]!.next;
    arr[1] = he[arr[0]]!.next;
    const r = he[ei]!.radial;
    arr[2] = he[r]!.next;
    arr[3] = he[arr[2]]!.next;
    for (const x of arr) if (he[x]!.base !== NONE) updateSingle(x);
  }
  const out: number[][] = [];
  const used = new Uint8Array(he.length);
  for (let i = 0; i < he.length; i++) {
    if (used[i]) continue;
    const a = i, b = he[a]!.next, c = he[b]!.next;
    used[a] = used[b] = used[c] = 1;
    out.push([he[a]!.v, he[b]!.v, he[c]!.v]);
  }
  return out;
}


export type QuadMethod = "beauty" | "fixed" | "alternate" | "shortEdge" | "longEdge";
export type NgonMethod = "beauty" | "earClip";

export interface TriangulateOptions {
  /** How a quad is split. Default `"beauty"`, Blender's default. */
  quadMethod?: QuadMethod;
  /** How a face of five or more corners is split. Default `"beauty"`. */
  ngonMethod?: NgonMethod;
}

/**
 * Which corners of a quad `(c0, c1, c2, c3)` each triangle takes, as
 * `BM_face_triangulate` lays them out: the two triangles share the diagonal
 * starting at the first index returned.
 */
export function quadTriangles(co: readonly V3[], method: QuadMethod): [number, number, number][] {
  // `l_first` is corner 0. The names follow bmesh_polygon.cc.
  let v1 = 1;
  let v2 = 2;
  switch (method) {
    case "fixed":
      v1 = 0;
      v2 = 2;
      break;
    case "alternate":
      v1 = 1;
      v2 = 3;
      break;
    default: {
      const v3 = 3;
      const v4 = 0;
      let split24: boolean;
      if (method === "shortEdge" || method === "longEdge") {
        const d1 = lenSq(sub(co[v4]!, co[v2]!));
        const d2 = lenSq(sub(co[v1]!, co[v3]!));
        split24 = method === "shortEdge" ? f(d2 - d1) > 0 : f(d2 - d1) < 0;
      } else {
        const flip = isQuadFlip(co[v1]!, co[v2]!, co[v3]!, co[v4]!);
        split24 = flip & 1 ? true : flip & 2 ? false : rotateBeauty(co[v1]!, co[v2]!, co[v3]!, co[v4]!) > 0;
      }
      if (split24) v1 = v4;
      else v2 = v3;
    }
  }
  const loops = [v1, (v1 + 1) % 4, v2, (v2 + 1) % 4];
  return [
    [loops[0]!, loops[1]!, loops[2]!],
    [loops[0]!, loops[2]!, loops[3]!],
  ];
}

/**
 * The triangles of an n-gon (five or more corners), as index triples into
 * `co`. `normal` is the face's normal as BMesh stores it (Newell, normalized).
 */
export function ngonTriangles(co: readonly V3[], normal: V3, method: NgonMethod): number[][] {
  const rows = axisRows(normal, true);
  const proj = co.map((c) => project(rows, c));
  const tris = polyfill(proj.map((c) => [c[0]!, c[1]!] as const));
  return method === "beauty" ? polyfillBeautify(proj, tris) : tris;
}

/**
 * Split every face of three or more sides into triangles, the way Blender's
 * `bmesh.ops.triangulate` does. Faces keep their winding; vertices are not
 * touched.
 *
 * ```ts
 * const tris = triangulate(mesh);                          // Blender's defaults
 * const fixed = triangulate(mesh, { quadMethod: "fixed" }); // what a fan does
 * ```
 */
export function triangulate(data: MeshData, opts: TriangulateOptions = {}): MeshData {
  const quadMethod = opts.quadMethod ?? "beauty";
  const ngonMethod = opts.ngonMethod ?? "beauty";
  const P = data.positions;
  const at = (v: number): V3 => [f(P[v * 3]!), f(P[v * 3 + 1]!), f(P[v * 3 + 2]!)];
  const polys: number[][] = [];
  for (const p of data.polys) {
    if (p.length <= 3) {
      polys.push([...p]);
      continue;
    }
    const co = p.map(at);
    let tris: number[][];
    if (p.length === 4) tris = quadTriangles(co, quadMethod);
    else {
      const n = newell(co);
      normalizeInPlace(n);
      tris = ngonTriangles(co, n, ngonMethod);
    }
    for (const t of tris) polys.push(t.map((k) => p[k]!));
  }
  return { positions: Float32Array.from(P), polys };
}

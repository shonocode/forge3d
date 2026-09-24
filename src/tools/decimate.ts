/**
 * Decimate ▸ Collapse — Blender's `BM_mesh_decimate_collapse`
 * (`bmesh/tools/bmesh_decimate_collapse.cc`), ported as it is written.
 *
 * Quadric edge collapse (Garland & Heckbert), but the answer is not decided
 * by the metric alone, and this file is long because of that. Blender:
 *
 * 1. **triangulates** first — quads by the "beauty" rule
 *    (`BM_verts_calc_rotate_beauty`), n-gons by polyfill then
 *    `BLI_polyfill_beautify` — and remembers which triangles came from which
 *    face, so it can put them back together at the end;
 * 2. builds a quadric per vertex from each face's **stored** normal. The last
 *    triangle out of each quad keeps **the quad's** normal (its data is
 *    swapped into the quad's slot and `BM_elem_attrs_copy` carried the normal
 *    over; only the other triangles get theirs recomputed) — so a bent quad's
 *    two halves feed different planes, and that is part of the answer;
 * 3. keeps the edges in a binary heap (`BLI_heap`) whose ties are decided by
 *    the order edges were inserted and updated — the order of the mesh's
 *    edges (`mesh_calc_edges`), of the edges around each vertex (the BMesh
 *    disk cycle) and of the loops around it. All of those are rebuilt here,
 *    the same way, from the same operations (`BM_vert_splice`,
 *    `BM_edge_splice`, `BM_edge_kill`);
 * 4. costs flat regions by **topology** instead (`USE_TOPOLOGY_FALLBACK`,
 *    below 1e-12), which reads the vertex normals the Mesh had — angle
 *    weighted with `safe_acos_approx`;
 * 5. joins triangles back into quads where both came from the same face and
 *    the quad is still convex.
 *
 * Coordinates, normals and costs are float32 as Blender's are; the quadrics
 * are double. The arithmetic follows the C expressions' order.
 *
 * Pure and headless.
 *
 * ## What is not ported
 *
 * - **Symmetry** (`use_symmetry`) — a kd-tree pairing of mirrored edges.
 * - **Vertex group weights** — they scale costs per vertex.
 * - Loop custom data (UVs, colours) is not carried: `MeshData` UVs are
 *   dropped by this operator.
 */
import type { MeshData } from "../lib/mesh";
import { polyfill } from "./boolean/polyfill";

const f = Math.fround;
const FLT_EPSILON = 1.1920928955078125e-7;
const FLT_MAX = 3.4028234663852886e38;
const COST_INVALID = FLT_MAX;
const TOPOLOGY_FALLBACK_EPS = f(1e-12);
const BOUNDARY_PRESERVE_WEIGHT = 100;
const OPTIMIZE_EPS = 1e-8;

export interface DecimateOptions {
  /**
   * How much of the **triangle** count to keep, 0..1 — Blender's `ratio`.
   * The target is `trunc(triangles × ratio)` in float, as Blender computes it.
   */
  ratio: number;
  /**
   * Leave the result as triangles — Blender's `use_collapse_triangulate`.
   * Default false: triangles that came from the same face are joined back
   * into it where they survived and the quad is convex.
   */
  triangulate?: boolean;
  /**
   * How many hash tables Blender split the mesh's edges into when it built
   * them (`mesh_calc_edges`): 1 below 1000 faces, otherwise
   * `min(8, threads)` rounded down to a power of two — **8** on any machine
   * with 8 or more threads, which is the default. The order of the edges
   * only decides ties, so this matters for meshes with exact symmetries.
   */
  edgeTables?: number;
}

// ── BLI_heap ───────────────────────────────────────────────────────────────

interface HeapNode<T> {
  value: number;
  index: number;
  ptr: T;
}
interface Heap<T> {
  tree: HeapNode<T>[];
}

function heapSwap<T>(h: Heap<T>, i: number, j: number): void {
  const pi = h.tree[i]!;
  const pj = h.tree[j]!;
  pi.index = j;
  h.tree[j] = pi;
  pj.index = i;
  h.tree[i] = pj;
}
function heapDown<T>(h: Heap<T>, i: number): void {
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
function heapUp<T>(h: Heap<T>, i: number): void {
  // Ties move up: the loop only stops when the parent is strictly smaller.
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (h.tree[p]!.value < h.tree[i]!.value) break;
    heapSwap(h, p, i);
    i = p;
  }
}
function heapInsert<T>(h: Heap<T>, value: number, ptr: T): HeapNode<T> {
  const node = { value: f(value), index: h.tree.length, ptr };
  h.tree.push(node);
  heapUp(h, node.index);
  return node;
}
function heapPopMin<T>(h: Heap<T>): T {
  const ptr = h.tree[0]!.ptr;
  const size = h.tree.length - 1;
  if (size) heapSwap(h, 0, size);
  h.tree.pop();
  if (size) heapDown(h, 0);
  return ptr;
}
function heapRemove<T>(h: Heap<T>, node: HeapNode<T>): void {
  let i = node.index;
  while (i > 0) {
    const p = (i - 1) >> 1;
    heapSwap(h, p, i);
    i = p;
  }
  heapPopMin(h);
}
function heapUpdate<T>(h: Heap<T>, node: HeapNode<T>, value: number, ptr: T): void {
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

type V3 = number[];
const sub = (a: V3, b: V3): V3 => [f(a[0]! - b[0]!), f(a[1]! - b[1]!), f(a[2]! - b[2]!)];
const dot = (a: V3, b: V3): number => f(f(f(a[0]! * b[0]!) + f(a[1]! * b[1]!)) + f(a[2]! * b[2]!));
const cross = (a: V3, b: V3): V3 => [
  f(f(a[1]! * b[2]!) - f(a[2]! * b[1]!)),
  f(f(a[2]! * b[0]!) - f(a[0]! * b[2]!)),
  f(f(a[0]! * b[1]!) - f(a[1]! * b[0]!)),
];
const lenSq = (a: V3): number => dot(a, a);
/** `normalize_v3`: multiplies by the reciprocal. */
function normalizeInPlace(n: V3): number {
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
function mathNormalize(a: V3): V3 {
  const l2 = lenSq(a);
  if (l2 > 1e-35) {
    const l = f(Math.sqrt(l2));
    return [f(a[0]! / l), f(a[1]! / l), f(a[2]! / l)];
  }
  return [0, 0, 0];
}
function normalTri(a: V3, b: V3, c: V3): V3 {
  const n1 = sub(a, b);
  const n2 = sub(b, c);
  const n = cross(n1, n2);
  normalizeInPlace(n);
  return n;
}
function normalQuad(a: V3, b: V3, c: V3, d: V3): V3 {
  const n = cross(sub(a, c), sub(b, d));
  normalizeInPlace(n);
  return n;
}
/** `add_newell_cross_v3_v3v3` over a ring, starting from (last, first). */
function newell(ring: V3[]): V3 {
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
function safeAcosApprox(x: number): number {
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

// ── a small BMesh ──────────────────────────────────────────────────────────

interface DiskLink {
  next: BE | null;
  prev: BE | null;
}
interface BV {
  co: V3;
  no: V3;
  e: BE | null;
  index: number;
  tag: boolean;
}
interface BE {
  v1: BV;
  v2: BV;
  l: BL | null;
  d1: DiskLink;
  d2: DiskLink;
  index: number;
  slot: number;
}
interface BL {
  v: BV;
  e: BE | null;
  f: BF;
  next: BL;
  prev: BL;
  rn: BL | null;
  rp: BL | null;
  index: number;
}
interface BF {
  first: BL | null;
  len: number;
  no: V3;
  index: number;
  tag: boolean;
  slot: number;
}

/** A `BLI_mempool`: freed slots are reused last-freed first. */
interface Pool<T> {
  items: (T | null)[];
  free: number[];
}
function poolAlloc<T extends { slot: number }>(p: Pool<T>, item: T): T {
  const slot = p.free.length ? p.free.pop()! : p.items.length;
  item.slot = slot;
  p.items[slot] = item;
  return item;
}
function poolFree<T extends { slot: number }>(p: Pool<T>, item: T): void {
  p.items[item.slot] = null;
  p.free.push(item.slot);
}

interface BM {
  verts: (BV | null)[];
  edges: Pool<BE>;
  faces: Pool<BF>;
  totface: number;
}

const link = (e: BE, v: BV): DiskLink => (v === e.v2 ? e.d2 : e.d1);
const diskNext = (e: BE, v: BV): BE => link(e, v).next!;
const vertInEdge = (e: BE, v: BV): boolean => e.v1 === v || e.v2 === v;
const otherVert = (e: BE, v: BV): BV => (e.v1 === v ? e.v2 : e.v1);

function diskAppend(e: BE, v: BV): void {
  if (!v.e) {
    const dl1 = link(e, v);
    v.e = e;
    dl1.next = dl1.prev = e;
  } else {
    const dl1 = link(e, v);
    const dl2 = link(v.e, v);
    const dl3 = dl2.prev ? link(dl2.prev, v) : null;
    dl1.next = v.e;
    dl1.prev = dl2.prev;
    dl2.prev = e;
    if (dl3) dl3.next = e;
  }
}
function diskRemove(e: BE, v: BV): void {
  const dl1 = link(e, v);
  if (dl1.prev) link(dl1.prev, v).next = dl1.next;
  if (dl1.next) link(dl1.next, v).prev = dl1.prev;
  if (v.e === e) v.e = e !== dl1.next ? dl1.next : null;
  dl1.next = dl1.prev = null;
}
function radialAppend(e: BE, l: BL): void {
  if (!e.l) {
    e.l = l;
    l.rn = l.rp = l;
  } else {
    l.rp = e.l;
    l.rn = e.l.rn;
    e.l.rn!.rp = l;
    e.l.rn = l;
    e.l = l;
  }
  l.e = e;
}
function radialRemove(e: BE, l: BL): void {
  if (l.rn !== l) {
    if (l === e.l) e.l = l.rn;
    l.rn!.rp = l.rp;
    l.rp!.rn = l.rn;
  } else if (l === e.l) {
    e.l = null;
  }
  l.rn = l.rp = null;
  l.e = null;
}

function edgeExists(a: BV, b: BV): BE | null {
  if (!a.e) return null;
  let e = a.e;
  do {
    if (otherVert(e, a) === b) return e;
  } while ((e = diskNext(e, a)) !== a.e);
  return null;
}
function edgeCreate(bm: BM, v1: BV, v2: BV): BE {
  const e: BE = { v1, v2, l: null, d1: { next: null, prev: null }, d2: { next: null, prev: null }, index: -1, slot: -1 };
  poolAlloc(bm.edges, e);
  diskAppend(e, v1);
  diskAppend(e, v2);
  return e;
}
function faceCreate(bm: BM, verts: BV[], edges: BE[], no: V3): BF {
  const face: BF = { first: null, len: verts.length, no: [...no], index: -1, tag: false, slot: -1 };
  poolAlloc(bm.faces, face);
  bm.totface++;
  const loops: BL[] = verts.map((v) => ({ v, e: null, f: face, next: null!, prev: null!, rn: null, rp: null, index: -1 }));
  loops.forEach((l, i) => {
    radialAppend(edges[i]!, l);
    l.next = loops[(i + 1) % loops.length]!;
    l.prev = loops[(i - 1 + loops.length) % loops.length]!;
  });
  face.first = loops[0]!;
  return face;
}
/** `BM_face_create_verts` with `create_edges`: edges from (last, first) on. */
function faceCreateVerts(bm: BM, verts: BV[], no: V3): BF {
  const n = verts.length;
  const edges: BE[] = new Array(n);
  for (let i = 0, iPrev = n - 1; i < n; iPrev = i++)
    edges[iPrev] = edgeExists(verts[iPrev]!, verts[i]!) ?? edgeCreate(bm, verts[iPrev]!, verts[i]!);
  return faceCreate(bm, verts, edges, no);
}
function faceLoops(face: BF): BL[] {
  const out: BL[] = [];
  let l = face.first!;
  do out.push(l);
  while ((l = l.next) !== face.first);
  return out;
}
function faceKill(bm: BM, face: BF): void {
  for (const l of faceLoops(face)) radialRemove(l.e!, l);
  face.first = null;
  bm.totface--;
  poolFree(bm.faces, face);
}
function edgeKill(bm: BM, e: BE): void {
  while (e.l) faceKill(bm, e.l.f);
  diskRemove(e, e.v1);
  diskRemove(e, e.v2);
  poolFree(bm.edges, e);
}
function vertKill(bm: BM, v: BV): void {
  while (v.e) edgeKill(bm, v.e);
  bm.verts[v.index] = null;
}
/** `bmesh_face_swap_data`: everything but the index moves. */
function faceSwapData(a: BF, b: BF): void {
  for (const l of faceLoops(a)) l.f = b;
  for (const l of faceLoops(b)) l.f = a;
  [a.first, b.first] = [b.first, a.first];
  [a.len, b.len] = [b.len, a.len];
  [a.no, b.no] = [b.no, a.no];
  [a.tag, b.tag] = [b.tag, a.tag];
}
function edgeVertSwap(e: BE, dst: BV, src: BV): void {
  if (e.l) {
    let l = e.l;
    do {
      if (l.v === src) l.v = dst;
      else if (l.next.v === src) l.next.v = dst;
    } while ((l = l.rn!) !== e.l);
  }
  diskRemove(e, src);
  if (e.v1 === src) {
    e.v1 = dst;
    e.d1.next = e.d1.prev = null;
  } else if (e.v2 === src) {
    e.v2 = dst;
    e.d2.next = e.d2.prev = null;
  }
  diskAppend(e, dst);
}
function vertSplice(bm: BM, dst: BV, src: BV): void {
  while (src.e) edgeVertSwap(src.e, dst, src);
  vertKill(bm, src);
}
function edgeSplice(bm: BM, dst: BE, src: BE): void {
  while (src.l) {
    const l = src.l;
    radialRemove(src, l);
    radialAppend(dst, l);
  }
  edgeKill(bm, src);
}

const isBoundary = (e: BE): boolean => !!e.l && e.l.rn === e.l;
const isManifold = (e: BE): boolean => !!e.l && e.l.rn !== e.l && e.l.rn!.rn === e.l;
function loopPair(e: BE): [BL, BL] | null {
  const la = e.l;
  if (!la) return null;
  const lb = la.rn!;
  if (la !== lb && lb.rn === la) return [la, lb];
  return null;
}

/** `BM_LOOPS_OF_VERT`, in its iterator's order. */
function loopsOfVert(v: BV): BL[] {
  if (!v.e) return [];
  let count = 0;
  let e = v.e;
  do {
    if (e.l) {
      let l = e.l;
      do if (l.v === v) count++;
      while ((l = l.rn!) !== e.l);
    }
  } while ((e = diskNext(e, v)) !== v.e);
  if (!count) return [];

  const faceloopFirstOfDisk = (): BL | null => {
    let ei = v.e!;
    do {
      if (ei.l) return ei.l.v === v ? ei.l : ei.l.next;
    } while ((ei = diskNext(ei, v)) !== v.e);
    return null;
  };
  const radialFindNext = (l: BL): BL => {
    let li = l.rn!;
    do if (li.v === v) return li;
    while ((li = li.rn!) !== l);
    return l;
  };
  const radialFindFirst = (l: BL): BL | null => {
    let li = l;
    do if (li.v === v) return li;
    while ((li = li.rn!) !== l);
    return null;
  };
  const radialFacevertCheck = (l: BL): boolean => {
    let li = l;
    do if (li.v === v) return true;
    while ((li = li.rn!) !== l);
    return false;
  };
  const diskFaceedgeFindNext = (e0: BE): BE => {
    let ef = diskNext(e0, v);
    do if (ef.l && radialFacevertCheck(ef.l)) return ef;
    while ((ef = diskNext(ef, v)) !== e0);
    return e0;
  };

  const out: BL[] = [];
  let lFirst = faceloopFirstOfDisk()!;
  let eNext = lFirst.e!;
  let lNext: BL | null = lFirst;
  while (lNext) {
    const cur: BL = lNext;
    if (count) {
      count--;
      lNext = radialFindNext(lNext);
      if (lNext === lFirst) {
        eNext = diskFaceedgeFindNext(eNext);
        lFirst = radialFindFirst(eNext.l!)!;
        lNext = lFirst;
      }
    }
    if (!count) lNext = null;
    out.push(cur);
  }
  return out;
}

// ── quadrics (BLI_quadric, double) ─────────────────────────────────────────

/** a2, ab, ac, ad, b2, bc, bd, c2, cd, d2 — `Quadric`'s field order. */
type Quadric = Float64Array;
function quadricFromPlane(v: number[]): Quadric {
  return Float64Array.of(
    v[0]! * v[0]!, v[0]! * v[1]!, v[0]! * v[2]!, v[0]! * v[3]!,
    v[1]! * v[1]!, v[1]! * v[2]!, v[1]! * v[3]!,
    v[2]! * v[2]!, v[2]! * v[3]!,
    v[3]! * v[3]!,
  );
}
function quadricAdd(a: Quadric, b: Quadric): void {
  for (let i = 0; i < 10; i++) a[i] = a[i]! + b[i]!;
}
function quadricEvaluate(q: Quadric, v: number[]): number {
  const [a2, ab, ac, ad, b2, bc, bd, c2, cd, d2] = q as unknown as number[];
  const v00 = v[0]! * v[0]!, v01 = v[0]! * v[1]!, v02 = v[0]! * v[2]!;
  const v11 = v[1]! * v[1]!, v12 = v[1]! * v[2]!;
  const v22 = v[2]! * v[2]!;
  return (
    a2! * v00 + ab! * 2 * v01 + ac! * 2 * v02 + ad! * 2 * v[0]! +
    b2! * v11 + bc! * 2 * v12 + bd! * 2 * v[1]! +
    c2! * v22 + cd! * 2 * v[2]! +
    d2!
  );
}
function quadricOptimize(q: Quadric, eps: number): number[] | null {
  const [a2, ab, ac, ad, b2, bc, bd, c2, cd] = q as unknown as number[];
  const det = a2! * (b2! * c2! - bc! * bc!) - ab! * (ab! * c2! - ac! * bc!) + ac! * (ab! * bc! - ac! * b2!);
  if (!(Math.abs(det) > eps)) return null;
  const inv = 1 / det;
  const m00 = (b2! * c2! - bc! * bc!) * inv;
  const m10 = (bc! * ac! - ab! * c2!) * inv;
  const m20 = (ab! * bc! - b2! * ac!) * inv;
  const m01 = (ac! * bc! - ab! * c2!) * inv;
  const m11 = (a2! * c2! - ac! * ac!) * inv;
  const m21 = (ab! * ac! - a2! * bc!) * inv;
  const m02 = (ab! * bc! - ac! * b2!) * inv;
  const m12 = (ac! * ab! - a2! * bc!) * inv;
  const m22 = (a2! * b2! - ab! * ab!) * inv;
  const v0 = ad!, v1 = bd!, v2 = cd!;
  return [
    -(m00 * v0 + m10 * v1 + m20 * v2),
    -(m01 * v0 + m11 * v1 + m21 * v2),
    -(m02 * v0 + m12 * v1 + m22 * v2),
  ];
}

// ── beauty (quads) and polyfill beautify (n-gons) ──────────────────────────

const crossTri2 = (a: number[], b: number[], c: number[]): number =>
  f(f(f(a[0]! - b[0]!) * f(b[1]! - c[1]!)) + f(f(a[1]! - b[1]!) * f(c[0]! - b[0]!)));
const len2 = (a: number[], b: number[]): number => {
  const dx = f(a[0]! - b[0]!);
  const dy = f(a[1]! - b[1]!);
  return f(Math.sqrt(f(f(dx * dx) + f(dy * dy))));
};

/** `BLI_polyfill_beautify_quad_rotate_calc_ex`: negative when 1–3 beats 2–4. */
function quadRotateCalc(v1: number[], v2: number[], v3: number[], v4: number[], lockDegenerate: boolean, rArea?: { value: number }): number {
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
function axisRows(no: V3, negate: boolean): [V3, V3] {
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
const project = (rows: [V3, V3], a: V3): number[] => [dot(rows[0], a), dot(rows[1], a)];

/** `BM_verts_calc_rotate_beauty(v1..v4, 0, 0)`: > 0 means split 2–4. */
function rotateBeauty(v1: V3, v2: V3, v3: V3, v4: V3): number {
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
function crossTriV3(a: V3, b: V3, c: V3): V3 {
  return cross(sub(a, b), sub(b, c));
}

/** `is_quad_flip_v3`. */
function isQuadFlip(v1: V3, v2: V3, v3: V3, v4: V3): number {
  const d12 = sub(v1, v2), d23 = sub(v2, v3), d34 = sub(v3, v4), d41 = sub(v4, v1);
  let ret = 0;
  if (dot(cross(d12, d23), cross(d34, d41)) < 0) ret |= 1;
  if (dot(cross(d23, d34), cross(d41, d12)) < 0) ret |= 2;
  return ret;
}
/** `is_quad_convex_v3`. */
function isQuadConvex(v1: V3, v2: V3, v3: V3, v4: V3): boolean {
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
function polyfillBeautify(coords: number[][], tris: number[][]): number[][] {
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

// ── Mesh-side inputs the modifier reads ────────────────────────────────────

/** `mesh_calc_edges`: (low, high) per face edge from (last, first), hashed by `low & mask`. */
function calcEdges(polys: readonly (readonly number[])[], tables: number): [number, number][] {
  const maps: Map<number, [number, number]>[] = Array.from({ length: tables }, () => new Map());
  const stride = 2 ** 26;
  for (const p of polys)
    for (let i = 0; i < p.length; i++) {
      const a = p[(i - 1 + p.length) % p.length]!;
      const b = p[i]!;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const m = maps[lo & (tables - 1)]!;
      const key = lo * stride + hi;
      if (!m.has(key)) m.set(key, [lo, hi]);
    }
  return maps.flatMap((m) => [...m.values()]);
}

/** `Mesh::vert_normals()`: angle-weighted Newell face normals. */
function meshVertNormals(P: V3[], polys: readonly (readonly number[])[]): V3[] {
  const faceNo = polys.map((p) => {
    const n = newell(p.map((v) => P[v]!));
    if (normalizeInPlace(n) === 0) n[2] = 1;
    return n;
  });
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

// ── the operator ───────────────────────────────────────────────────────────

/**
 * Collapse edges until `ratio` of the triangles are left, as Blender's
 * Decimate modifier does in Collapse mode.
 *
 * ```ts
 * const lod = decimateCollapse(meshToData(em), { ratio: 0.3 });
 * ```
 */
export function decimateCollapse(data: MeshData, opts: DecimateOptions): MeshData {
  const ratio = f(opts.ratio);
  const copy = (): MeshData => ({ positions: Float32Array.from(data.positions), polys: data.polys.map((p) => [...p]) });
  if (ratio === 1 || data.polys.length <= 3) return copy();

  const nv = data.positions.length / 3;
  const P: V3[] = [];
  for (let i = 0; i < nv; i++) P.push([f(data.positions[i * 3]!), f(data.positions[i * 3 + 1]!), f(data.positions[i * 3 + 2]!)]);
  const polys = data.polys.filter((p) => p.length >= 3);
  const vno = meshVertNormals(P, polys);

  // ── BM_mesh_bm_from_me ────────────────────────────────────────────────
  const bm: BM = { verts: [], edges: { items: [], free: [] }, faces: { items: [], free: [] }, totface: 0 };
  for (let i = 0; i < nv; i++) bm.verts.push({ co: P[i]!, no: vno[i]!, e: null, index: i, tag: false });
  const tables = polys.length < 1000 ? 1 : (opts.edgeTables ?? 8);
  const edgeOf = new Map<number, BE>();
  const stride = 2 ** 26;
  for (const [a, b] of calcEdges(polys, tables)) {
    const e = edgeCreate(bm, bm.verts[a]!, bm.verts[b]!);
    edgeOf.set(a * stride + b, e);
  }
  const findEdge = (a: number, b: number): BE => edgeOf.get(Math.min(a, b) * stride + Math.max(a, b))!;
  polys.forEach((p, i) => {
    const verts = p.map((v) => bm.verts[v]!);
    const edges = p.map((v, k) => findEdge(v, p[(k + 1) % p.length]!));
    const face = faceCreate(bm, verts, edges, [0, 0, 0]);
    face.index = i;
    // BM_face_normal_update
    const co = verts.map((v) => v.co);
    face.no = p.length === 4 ? normalQuad(co[0]!, co[1]!, co[2]!, co[3]!) : p.length === 3 ? normalTri(co[0]!, co[1]!, co[2]!) : (() => {
      const n = newell(co);
      normalizeInPlace(n);
      return n;
    })();
  });

  // ── bm_decim_triangulate_begin ──────────────────────────────────────────
  let hasCut = false;
  const facesDouble: BF[] = [];
  const faceSlots = bm.faces.items.length;
  for (let s = 0; s < faceSlots; s++) {
    const face = bm.faces.items[s];
    if (!face || face.len <= 3) continue;
    const fIndex = face.index;
    const loops = faceLoops(face);
    let tris: number[][];
    let order: BL[];
    if (face.len === 4) {
      const lFirst = face.first!;
      let lV1 = lFirst.next;
      let lV2 = lFirst.next.next;
      const lV3 = lFirst.prev;
      const lV4 = lFirst;
      const flip = isQuadFlip(lV1.v.co, lV2.v.co, lV3.v.co, lV4.v.co);
      const split24 = flip & 1 ? true : flip & 2 ? false : rotateBeauty(lV1.v.co, lV2.v.co, lV3.v.co, lV4.v.co) > 0;
      if (split24) lV1 = lV4;
      else lV2 = lV3;
      order = [lV1, lV1.next, lV2, lV2.next];
      tris = [[0, 1, 2], [0, 2, 3]];
    } else {
      const rows = axisRows(face.no, true);
      const proj = loops.map((l) => project(rows, l.v.co));
      tris = polyfillBeautify(proj, polyfill(proj.map((c) => [c[0]!, c[1]!] as const)));
      order = loops;
    }
    const last = tris.length - 1;
    const facesNew: BF[] = [];
    const edgesNew: BE[] = [];
    let fNew: BF | null = null;
    tris.forEach((t, i) => {
      const lt = t.map((k) => order[k]!);
      fNew = faceCreateVerts(bm, lt.map((l) => l.v), face.no);
      const lNew = fNew.first!;
      if (lNew.rn !== lNew) {
        let li = lNew.rn!;
        do {
          if (li.f.len === 3 && lNew.prev.v === li.prev.v) {
            facesDouble.unshift(i !== last ? fNew : face);
            break;
          }
        } while ((li = li.rn!) !== lNew);
      }
      if (i !== last) facesNew.push(fNew);
      for (const l of faceLoops(fNew)) if (l === l.rn) edgesNew.push(l.e!);
    });
    faceSwapData(face, fNew!);
    faceKill(bm, fNew!);
    for (const e of edgesNew) {
      let l = e.l!;
      do {
        l.index = fIndex;
        hasCut = true;
      } while ((l = l.rn!) !== e.l);
    }
    for (const nf of facesNew) {
      const co = faceLoops(nf).map((l) => l.v.co);
      nf.no = normalTri(co[0]!, co[1]!, co[2]!);
    }
  }
  for (const fd of facesDouble) faceKill(bm, fd);
  const liveEdges = (): BE[] => bm.edges.items.filter((e): e is BE => !!e);
  const liveFaces = (): BF[] => bm.faces.items.filter((x): x is BF => !!x);
  liveEdges().forEach((e, i) => (e.index = i));
  liveFaces().forEach((x, i) => (x.index = i));

  // ── quadrics ──────────────────────────────────────────────────────────
  const vq: Quadric[] = bm.verts.map(() => new Float64Array(10));
  for (const face of liveFaces()) {
    const ls = faceLoops(face);
    const c = [0, 0, 0];
    for (const l of ls) for (let k = 0; k < 3; k++) c[k] = f(c[k]! + l.v.co[k]!);
    const inv = f(1 / f(face.len));
    for (let k = 0; k < 3; k++) c[k] = f(c[k]! * inv);
    const plane = [face.no[0]!, face.no[1]!, face.no[2]!, 0];
    plane[3] = -(plane[0]! * c[0]! + plane[1]! * c[1]! + plane[2]! * c[2]!);
    const q = quadricFromPlane(plane);
    for (const l of ls) quadricAdd(vq[l.v.index]!, q);
  }
  for (const e of liveEdges()) {
    if (!isBoundary(e)) continue;
    const ev = sub(e.v2.co, e.v1.co);
    const ep = cross(ev, e.l!.f.no);
    const pd = [ep[0]!, ep[1]!, ep[2]!, 0];
    let d = pd[0]! * pd[0]! + pd[1]! * pd[1]! + pd[2]! * pd[2]!;
    if (d > 1e-35) {
      d = Math.sqrt(d);
      const s = 1 / d;
      for (let k = 0; k < 3; k++) pd[k] = pd[k]! * s;
    } else {
      pd[0] = pd[1] = pd[2] = 0;
      d = 0;
    }
    if (d > FLT_EPSILON) {
      const c = [0, 1, 2].map((k) => f(0.5 * f(e.v1.co[k]! + e.v2.co[k]!)));
      pd[3] = -(pd[0]! * c[0]! + pd[1]! * c[1]! + pd[2]! * c[2]!);
      const q = quadricFromPlane(pd);
      for (let i = 0; i < 10; i++) q[i] = q[i]! * BOUNDARY_PRESERVE_WEIGHT;
      quadricAdd(vq[e.v1.index]!, q);
      quadricAdd(vq[e.v2.index]!, q);
    }
  }

  // ── edge costs ────────────────────────────────────────────────────────
  const heap: Heap<BE> = { tree: [] };
  const table: (HeapNode<BE> | null)[] = [];
  const targetCo = (e: BE): number[] => {
    const q = Float64Array.from(vq[e.v1.index]!);
    quadricAdd(q, vq[e.v2.index]!);
    return quadricOptimize(q, OPTIMIZE_EPS) ?? [0, 1, 2].map((k) => 0.5 * (e.v1.co[k]! + e.v2.co[k]!));
  };
  const costSingle = (e: BE): void => {
    let ok = false;
    if (isBoundary(e)) ok = e.l!.f.len === 3;
    else if (isManifold(e)) ok = e.l!.f.len === 3 && e.l!.rn!.f.len === 3;
    if (!ok) {
      if (table[e.index]) heapRemove(heap, table[e.index]!);
      table[e.index] = null;
      return;
    }
    const co = targetCo(e);
    let cost = f(quadricEvaluate(vq[e.v1.index]!, co) + quadricEvaluate(vq[e.v2.index]!, co));
    cost = Math.abs(cost);
    if (cost < TOPOLOGY_FALLBACK_EPS) {
      const topo = f(f(Math.abs(dot(e.v1.no, e.v2.no))) / Math.min(-lenSq(sub(e.v1.co, e.v2.co)), -FLT_EPSILON));
      cost = f(topo - cost);
    }
    const node = table[e.index];
    if (node) heapUpdate(heap, node, cost, e);
    else table[e.index] = heapInsert(heap, cost, e);
  };
  for (const e of liveEdges()) {
    table[e.index] = null;
    costSingle(e);
  }
  const invalidate = (e: BE): void => {
    table[e.index] = heapInsert(heap, COST_INVALID, e);
  };

  const target = Math.trunc(f(f(bm.totface) * ratio));

  // ── bm_edge_collapse_is_degenerate_topology ───────────────────────────
  const tagEnable = (e: BE, on: boolean): void => {
    e.v1.tag = on;
    e.v2.tag = on;
    if (e.l) {
      e.l.f.tag = on;
      if (e.l !== e.l.rn) e.l.rn!.f.tag = on;
    }
  };
  const tagTest = (e: BE): boolean =>
    e.v1.tag || e.v2.tag || (!!e.l && (e.l.f.tag || (e.l !== e.l.rn && e.l.rn!.f.tag)));
  const manifoldOrBoundary = (l: BL | null): boolean => !!l && l.rn!.rn === l;
  const degenerateTopology = (eFirst: BE): boolean => {
    for (const v of [eFirst.v1, eFirst.v2]) {
      let e = eFirst;
      do {
        if (!manifoldOrBoundary(e.l)) return true;
        tagEnable(e, false);
      } while ((e = diskNext(e, v)) !== eFirst);
    }
    let e = eFirst;
    do tagEnable(e, true);
    while ((e = diskNext(e, eFirst.v1)) !== eFirst);
    const lr = eFirst.l!;
    lr.f.tag = false;
    lr.v.tag = false;
    lr.next.v.tag = false;
    lr.next.next.v.tag = false;
    const lf = lr.rn!;
    if (lr !== lf) {
      lf.f.tag = false;
      lf.v.tag = false;
      lf.next.v.tag = false;
      lf.next.next.v.tag = false;
    }
    e = eFirst;
    do if (tagTest(e)) return true;
    while ((e = diskNext(e, eFirst.v2)) !== eFirst);
    return false;
  };

  const degenerateFlip = (e: BE, co: V3): boolean => {
    for (const v of [e.v1, e.v2])
      for (const l of loopsOfVert(v)) {
        if (l.e === e || l.prev.e === e) continue;
        const cp = l.prev.v.co;
        const cn = l.next.v.co;
        const vo = sub(cp, cn);
        const ce = cross(vo, sub(cp, v.co));
        const cOpt = cross(vo, sub(cp, co));
        if (dot(ce, cOpt) <= f(f(lenSq(ce) + lenSq(cOpt)) * f(0.01))) return true;
      }
    return false;
  };

  /** `bm_edge_collapse`: kills `vClear` into the other end. */
  const edgeCollapse = (eClear: BE, vClear: BV, rOther: number[]): boolean => {
    const vOther = otherVert(eClear, vClear);
    const sides = (l: BL): [BE, BE] => (vertInEdge(l.prev.e!, vClear) ? [l.prev.e!, l.next.e!] : [l.next.e!, l.prev.e!]);
    if (isManifold(eClear)) {
      const [la, lb] = loopPair(eClear)!;
      const a = sides(la);
      const b = sides(lb);
      if (a[0] === b[0] || a[0] === b[1] || a[1] === b[0] || a[1] === b[1]) return false;
      rOther[0] = a[0].index;
      rOther[1] = b[0].index;
      edgeKill(bm, eClear);
      vertSplice(bm, vOther, vClear);
      edgeSplice(bm, a[1], a[0]);
      edgeSplice(bm, b[1], b[0]);
      return true;
    }
    if (isBoundary(eClear)) {
      const a = sides(eClear.l!);
      rOther[0] = a[0].index;
      rOther[1] = -1;
      edgeKill(bm, eClear);
      vertSplice(bm, vOther, vClear);
      edgeSplice(bm, a[1], a[0]);
      return true;
    }
    return false;
  };

  const decimEdgeCollapse = (e: BE): boolean => {
    const vOther = e.v1;
    const vOtherIndex = e.v1.index;
    const vClearIndex = e.v2.index;
    const vClearNo = [...e.v2.no];
    if (degenerateTopology(e)) {
      invalidate(e);
      return false;
    }
    const co = targetCo(e).map(f);
    if (degenerateFlip(e, co)) {
      invalidate(e);
      return false;
    }
    let fac: number;
    const near = [0, 1, 2].every((k) => Math.abs(f(e.v1.co[k]! - e.v2.co[k]!)) <= FLT_EPSILON);
    if (!near) {
      const u = sub(e.v2.co, e.v1.co);
      const h = sub(co, e.v1.co);
      const d = lenSq(u);
      fac = d > 0 ? f(dot(u, h) / d) : 0;
    } else fac = 0.5;
    const rOther = [-1, -1];
    if (edgeCollapse(e, e.v2, rOther)) {
      vOther.co = co;
      for (const i of rOther)
        if (i !== -1 && table[i]) {
          heapRemove(heap, table[i]!);
          table[i] = null;
        }
      quadricAdd(vq[vOtherIndex]!, vq[vClearIndex]!);
      const s = f(1 - fac);
      vOther.no = [0, 1, 2].map((k) => f(f(s * vOther.no[k]!) + f(fac * vClearNo[k]!)));
      normalizeInPlace(vOther.no);
      if (vOther.e) {
        let ei = vOther.e;
        const first = ei;
        do costSingle(ei);
        while ((ei = diskNext(ei, vOther)) !== first);
      }
      for (const l of loopsOfVert(vOther)) {
        if (l.f.len !== 3) continue;
        const eOuter = vertInEdge(l.prev.e!, l.v) ? l.next.e! : l.prev.e!;
        costSingle(eOuter);
      }
      return true;
    }
    invalidate(e);
    return false;
  };

  while (bm.totface > target && heap.tree.length && heap.tree[0]!.value !== f(COST_INVALID)) {
    const e = heapPopMin(heap);
    table[e.index] = null;
    decimEdgeCollapse(e);
  }

  // ── bm_decim_triangulate_end ──────────────────────────────────────────
  if (!opts.triangulate && hasCut) {
    const edgesTri: BE[] = [];
    for (const e of liveEdges()) {
      const pair = loopPair(e);
      if (!pair) continue;
      const [la, lb] = pair;
      const ia = la.index;
      if (ia === -1 || lb.index !== ia || la.v === lb.v) continue;
      const canMerge = (l: BL): boolean =>
        l !== l.rn && l === l.rn!.rn && l.v !== l.rn!.v && ia === l.index && ia === l.rn!.index;
      if (la.f.len === 3 && lb.f.len === 3 && !canMerge(la.next) && !canMerge(la.prev) && !canMerge(lb.next) && !canMerge(lb.prev)) {
        const quad = [
          e.v1,
          vertInEdge(e, la.next.v) ? la.prev.v : la.next.v,
          e.v2,
          vertInEdge(e, lb.next.v) ? lb.prev.v : lb.next.v,
        ];
        if (!isQuadConvex(quad[0]!.co, quad[1]!.co, quad[2]!.co, quad[3]!.co)) continue;
      }
      edgesTri.push(e);
    }
    for (const e of edgesTri) {
      const pair = loopPair(e);
      if (!pair) continue;
      facesJoin(bm, pair[0].f, pair[1].f);
      if (!e.l) edgeKill(bm, e);
    }
  }

  // ── back to MeshData ──────────────────────────────────────────────────
  const remap = new Int32Array(nv).fill(-1);
  const positions: number[] = [];
  bm.verts.forEach((v, i) => {
    if (!v) return;
    remap[i] = positions.length / 3;
    positions.push(v.co[0]!, v.co[1]!, v.co[2]!);
  });
  return {
    positions: Float32Array.from(positions),
    polys: liveFaces().map((x) => faceLoops(x).map((l) => remap[l.v.index]!)),
  };
}

/** `BM_faces_join` of two faces across the edges they share. */
function facesJoin(bm: BM, a: BF, b: BF): void {
  const loops = [...faceLoops(a), ...faceLoops(b)];
  const shared = (l: BL): boolean => {
    let li = l.rn!;
    while (li !== l) {
      if (li.f === (l.f === a ? b : a)) return true;
      li = li.rn!;
    }
    return false;
  };
  const boundary = loops.filter((l) => !shared(l));
  const from = new Map<BV, BL>();
  for (const l of boundary) from.set(l.v, l);
  const ring: BL[] = [];
  let l = boundary[0]!;
  do {
    ring.push(l);
    l = from.get(l.next.v)!;
  } while (l && l !== boundary[0] && ring.length <= boundary.length);
  const verts = ring.map((x) => x.v);
  const edges = ring.map((x) => x.e!);
  const no = [...a.no];
  faceKill(bm, a);
  faceKill(bm, b);
  faceCreate(bm, verts, edges, no);
}

/**
 * Rotate the edges between triangles to make them better shaped — Blender's
 * `bmesh.ops.beautify_fill` (`bmo_beautify.cc` over `BM_mesh_beautify_fill`
 * in `bmesh_beautify.cc`).
 *
 * Every rotatable edge between two chosen triangles goes into a heap keyed by
 * how much rotating it would improve the pair; the best is rotated, its four
 * neighbours are re-costed, and it repeats until nothing improves. Each edge
 * remembers the states it has been in so it cannot swing back.
 *
 * | `method` | Blender | cost of the pair |
 * |---|---|---|
 * | `"area"` (default) | `AREA` | area over perimeter of the two triangles, in the pair's own plane (`BLI_polyfill_edge_calc_rotate_beauty__area`), with degenerate outcomes locked out |
 * | `"angle"` | `ANGLE` | the angle between the two triangles' normals |
 *
 * `bridgeLoops` uses the same loop with the angle cost and the "only across
 * the two loops" restriction — which is where this lived, private, until it
 * was made an operator of its own on 2026-09-25.
 *
 * Pure and headless.
 */
import type { MeshData } from "../lib/mesh";
import { f, FLT_MAX, sub, dot, cross, lenSq, normalizeInPlace, heapInsert, heapPopMin, heapRemove, type V3, type Heap, type HeapNode } from "./blender-math";
import { bmFromMesh, bmToMesh, liveEdges, liveFaces, edgeRotate, edgeRotateCheck, type BM, type BE } from "./bmesh-lite";
import { rotateBeauty } from "./triangulate";

export interface BmBeautifyOptions {
  /** `method`: 0 = area (default), 1 = angle. */
  method: "area" | "angle";
  /** `VERT_RESTRICT_TAG`: only rotate an edge whose two far corners differ in `tag`. */
  restrictTag?: boolean;
  /** `EDGE_RESTRICT_DEGENERATE`: an area rotation may not make a flipped pair. */
  restrictDegenerate?: boolean;
}

const lenV = (a: V3, b: V3): number => f(Math.sqrt(lenSq(sub(a, b))));
function normalTriLen(a: V3, b: V3, c: V3): { n: V3; len: number } {
  const n = cross(sub(a, b), sub(b, c));
  const len = normalizeInPlace(n);
  return { n, len };
}
function safeAsin(a: number): number {
  if (a <= -1) return f(-Math.PI / 2);
  if (a >= 1) return f(Math.PI / 2);
  return f(Math.asin(a));
}
function angleNormalized(a: V3, b: V3): number {
  if (dot(a, b) >= 0) return f(2 * safeAsin(f(lenV(a, b) / 2)));
  const bn = b.map((c) => -c);
  return f(f(Math.PI) - f(2 * safeAsin(f(lenV(a, bn) / 2))));
}
/** `bm_edge_calc_rotate_beauty__angle` */
function rotateBeautyAngle(v1: V3, v2: V3, v3: V3, v4: V3): number {
  const a24 = angleNormalized(normalTriLen(v2, v3, v4).n, normalTriLen(v2, v4, v1).n);
  const na = normalTriLen(v1, v2, v3);
  const nb = normalTriLen(v1, v3, v4);
  if (na.len === 0 || nb.len === 0) return FLT_MAX;
  return f(angleNormalized(na.n, nb.n) - a24);
}

/** `BM_mesh_beautify_fill` on a BMesh, over `edgeArray` (each manifold, between two triangles). */
export function bmBeautifyFill(bm: BM, edgeArray: BE[], opts: BmBeautifyOptions): void {
  const n = edgeArray.length;
  const cost = (e: BE): number => {
    const v1 = e.l!.prev.v;
    const v2 = e.l!.v;
    const v3 = e.l!.rn!.prev.v;
    const v4 = e.l!.next.v;
    if (opts.restrictTag && v1.tag === v3.tag) return FLT_MAX;
    if (v1 === v3) return FLT_MAX;
    return opts.method === "angle"
      ? rotateBeautyAngle(v1.co, v2.co, v3.co, v4.co)
      : rotateBeauty(v1.co, v2.co, v3.co, v4.co, opts.restrictDegenerate ?? false);
  };
  const pairKey = (a: number, b: number): string => (a < b ? `${a},${b}` : `${b},${a}`);
  const edgePair = (e: BE): string => pairKey(e.v1.index, e.v2.index);
  const facePair = (e: BE): string => pairKey(e.l!.prev.v.index, e.l!.rn!.prev.v.index);
  const states: Set<string>[] = Array.from({ length: n }, () => new Set());
  const heap: Heap<BE> = { tree: [] };
  const table: (HeapNode<BE> | null)[] = new Array(n).fill(null);
  edgeArray.forEach((e, i) => {
    const c = cost(e);
    table[i] = c < 0 ? heapInsert(heap, c, e) : null;
    e.index = i;
  });
  const inArray = (e: BE): boolean => e.index >= 0 && e.index < n && edgeArray[e.index] === e;
  const updateSingle = (e: BE): void => {
    if (!inArray(e)) return;
    const i = e.index;
    if (table[i]) {
      heapRemove(heap, table[i]!);
      table[i] = null;
    }
    // `erot_state_alternate`: never swing back into a state already visited.
    if (states[i]!.has(`${facePair(e)}|${edgePair(e)}`)) return;
    const c = cost(e);
    table[i] = c < 0 ? heapInsert(heap, c, e) : null;
  };
  while (heap.tree.length) {
    let e: BE | null = heapPopMin(heap);
    const i = e.index;
    table[i] = null;
    e = edgeRotate(bm, e);
    if (!e) continue;
    states[i]!.add(`${edgePair(e)}|${facePair(e)}`);
    edgeArray[i] = e;
    e.index = i;
    for (const x of [e.l!.next.e!, e.l!.prev.e!, e.l!.rn!.next.e!, e.l!.rn!.prev.e!]) updateSingle(x);
  }
}

export interface BeautifyFillOptions {
  /** The triangles that may change. Default every triangle. Faces that are not triangles are left alone. */
  faces?: ReadonlySet<number>;
  /** Default `"area"`, Blender's. */
  method?: "area" | "angle";
}

/**
 * Rotate the edges between triangles until the pairs are as well shaped as
 * they get — `bmesh.ops.beautify_fill` with every edge offered.
 *
 * ```ts
 * const nicer = beautifyFill(triangulated);                    // area over perimeter
 * const flat  = beautifyFill(triangulated, { method: "angle" }); // flattest pairs
 * ```
 *
 * Only an edge with a chosen triangle on both sides can turn, and never into
 * a pair that would face the other way (`EDGE_RESTRICT_DEGENERATE`).
 */
export function beautifyFill(data: MeshData, options: BeautifyFillOptions = {}): MeshData {
  const bm = bmFromMesh(data);
  const chosen = options.faces;
  const marked = new Set(liveFaces(bm).filter((x) => x.len === 3 && (!chosen || chosen.has(x.index))));
  for (const e of liveEdges(bm)) e.tag = false;
  const edgeArray = liveEdges(bm).filter(
    (e) => edgeRotateCheck(e) && marked.has(e.l!.f) && marked.has(e.l!.rn!.f),
  );
  bmBeautifyFill(bm, edgeArray, { method: options.method ?? "area", restrictDegenerate: true });
  return bmToMesh(bm);
}

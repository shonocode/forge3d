/**
 * Blender's Select ▸ Select Shortest Path (`mesh.shortest_path_select`, compat-backlog C83): the shortest path between the
 * two selected vertices, edges or faces, ported from `editors/mesh/editmesh_path.cc` and `bmesh/tools/bmesh_path.cc`.
 *
 * The search is Dijkstra's over float32 costs with Blender's `HeapSimple` (`BLI_heap_simple.cc`) — on a grid many paths
 * are equally short, and which one comes out is decided by the heap's order and the disk / loop order the neighbours
 * are pushed in, so both are reproduced. `use_fill` (every path between the two, `bmesh_path_region.cc`) and the
 * `edge_mode` taggings (seam, sharp, crease, bevel — they write edge data, not a selection) are not ported.
 */
import type { MeshData } from "../../lib/mesh";
import { diskEdges, faceLoops, liveEdges, liveFaces, loopsOfVert, type BE, type BF, type BL, type BV } from "../bmesh-lite";
import { radialFaces } from "./select-sets";
import { Selection, type MeshSelection, type SelectMode, type SelectionSeed } from "./select-topology";

const f = Math.fround;
type V = [number, number, number];
const sub = (a: readonly number[], b: readonly number[]): V => [f(a[0]! - b[0]!), f(a[1]! - b[1]!), f(a[2]! - b[2]!)];
const add = (a: readonly number[], b: readonly number[]): V => [f(a[0]! + b[0]!), f(a[1]! + b[1]!), f(a[2]! + b[2]!)];
const scale = (a: readonly number[], s: number): V => [f(a[0]! * s), f(a[1]! * s), f(a[2]! * s)];
const dot = (a: readonly number[], b: readonly number[]): number => f(f(f(a[0]! * b[0]!) + f(a[1]! * b[1]!)) + f(a[2]! * b[2]!));
const cross = (a: readonly number[], b: readonly number[]): V => [
  f(f(a[1]! * b[2]!) - f(a[2]! * b[1]!)),
  f(f(a[2]! * b[0]!) - f(a[0]! * b[2]!)),
  f(f(a[0]! * b[1]!) - f(a[1]! * b[0]!)),
];
const len = (a: readonly number[]): number => f(Math.sqrt(dot(a, a)));
const distance = (a: readonly number[], b: readonly number[]): number => len(sub(a, b));
/** `normalize_v3`: the vector made unit, and its length (0 when the squared length is 1e-35 or less). */
const normalize = (a: V): [V, number] => {
  const d2 = dot(a, a);
  if (d2 <= 1e-35) return [[0, 0, 0], 0];
  const d = f(Math.sqrt(d2));
  return [scale(a, f(1 / d)), d];
};

/** `BLI_heap_simple.cc`: a binary min-heap; its sift order decides between equal costs. */
class HeapSimple<T> {
  private value: number[] = [];
  private ptr: T[] = [];
  get empty(): boolean {
    return this.value.length === 0;
  }
  insert(value: number, ptr: T): void {
    let i = this.value.length;
    this.value.push(value);
    this.ptr.push(ptr);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (value >= this.value[p]!) break;
      this.value[i] = this.value[p]!;
      this.ptr[i] = this.ptr[p]!;
      i = p;
    }
    this.value[i] = value;
    this.ptr[i] = ptr;
  }
  popMin(): T {
    const top = this.ptr[0]!;
    const lastValue = this.value.pop()!;
    const lastPtr = this.ptr.pop()!;
    const size = this.value.length;
    if (size) {
      // `heapsimple_down` from the root with the last node.
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        let smallestValue = lastValue;
        if (l < size && this.value[l]! < lastValue) {
          smallest = l;
          smallestValue = this.value[l]!;
        }
        if (r < size && this.value[r]! < smallestValue) smallest = r;
        if (smallest === i) break;
        this.value[i] = this.value[smallest]!;
        this.ptr[i] = this.ptr[smallest]!;
        i = smallest;
      }
      this.value[i] = lastValue;
      this.ptr[i] = lastPtr;
    }
    return top;
  }
}

/** `step_cost_3_v3_ex`: the two legs' lengths (either skipped), more for a sharper turn. */
function stepCost(v1: readonly number[], v2: readonly number[], v3: readonly number[], skip12 = false, skip23 = false): number {
  const [d1, c12] = normalize(sub(v2, v1));
  const [d2, c23] = normalize(sub(v3, v2));
  const cost = f((skip12 ? 0 : c12) + (skip23 ? 0 : c23));
  return f(cost * f(1 + f(0.5 * f(2 - f(Math.sqrt(Math.abs(dot(d1, d2))))))));
}

/** `BM_face_calc_center_median_weighted`: each vertex weighted by the lengths of its two edges. */
function faceCentreWeighted(face: BF): V {
  const loops = faceLoops(face);
  let cent: V = [0, 0, 0];
  let tot = 0;
  let wPrev = distance(loops[loops.length - 1]!.v.co, loops[0]!.v.co);
  for (let i = 0; i < loops.length; i++) {
    const wCurr = distance(loops[i]!.v.co, loops[(i + 1) % loops.length]!.v.co);
    const w = f(wCurr + wPrev);
    cent = add(cent, scale(loops[i]!.v.co, w));
    tot = f(tot + w);
    wPrev = wCurr;
  }
  return tot !== 0 ? scale(cent, f(1 / tot)) : cent;
}

/** `isect_line_line_v3` (epsilon 1e-6): the point on the first line nearest the second, or null for parallel lines. */
function isectLineLine(v1: readonly number[], v2: readonly number[], v3: readonly number[], v4: readonly number[]): V | null {
  let c = sub(v3, v1);
  let a = sub(v2, v1);
  let b = sub(v4, v3);
  let ab = cross(a, b);
  const d = dot(c, ab);
  const div = dot(ab, ab);
  if (div === 0) return null;
  if (Math.abs(d) <= 0.000001) {
    const cb = cross(c, b);
    return add(v1, scale(a, f(dot(cb, ab) / div)));
  }
  const n = cross(a, b);
  let t = sub(v1, v3);
  t = scale(n, f(dot(t, n) / dot(n, n)));
  const v3t = add(v3, t);
  const v4t = add(v4, t);
  c = sub(v3t, v1);
  a = sub(v2, v1);
  b = sub(v4t, v3t);
  ab = cross(a, b);
  const cb = cross(c, b);
  return add(v1, scale(a, f(dot(cb, ab) / dot(ab, ab))));
}

/** `line_point_factor_v3`. */
function linePointFactor(p: readonly number[], l1: readonly number[], l2: readonly number[]): number {
  const u = sub(l2, l1);
  const h = sub(p, l1);
  const d = dot(u, u);
  return d > 0 ? f(dot(u, h) / d) : 0;
}

/** Options of {@link selectShortestPath} — the operator's. */
export interface ShortestPathOptions {
  /** `use_topology_distance`: count steps, not lengths. Default false. */
  topologyDistance?: boolean;
  /** `use_face_step`: step across faces too (diagonals, edge rings). Default false. */
  faceStep?: boolean;
  /** The checker interval along the path (`skip` default 0 — every element). */
  skip?: number;
  nth?: number;
  offset?: number;
}

/**
 * Select the shortest path between the first two selected vertices / edges / faces (by the mode, in the mesh's order — the
 * editor's choice when the select history holds no pair), from the first to the second. If every element on it is already
 * selected it is deselected instead; with `skip` only the elements the checker interval keeps are touched. Then the
 * mode's flush.
 */
export function selectShortestPath(
  mesh: MeshData,
  mode: SelectMode,
  seed: SelectionSeed,
  options: ShortestPathOptions = {},
): MeshSelection {
  const sel = new Selection(mesh, seed, mode);
  const topo = !!options.topologyDistance;
  const faceStep = !!options.faceStep;
  const nth = Math.max(1, Math.trunc(options.nth ?? 1));
  const skip = Math.max(0, Math.trunc(options.skip ?? 0));
  const period = nth + skip;
  const offset = (((options.offset ?? 0) % period) + period) % period;
  // `WM_operator_properties_checker_interval_test`, with C's remainder for the path's first element at depth −1.
  const keep = (depth: number): boolean => skip === 0 || (offset + depth) % period >= skip;
  const apply = <T>(path: T[] | null, isSet: (x: T) => boolean, set: (x: T, on: boolean) => void, dst: T): void => {
    if (!path) {
      set(dst, !isSet(dst));
      return;
    }
    const allSet = path.every(isSet);
    path.forEach((x, i) => {
      if (keep(i - 1)) set(x, !allSet);
    });
  };

  if (mode === "vertex") {
    const picked = sel.bm.verts.filter((v): v is BV => !!v && sel.sv.has(v));
    if (picked.length < 2) return sel.result();
    const [src, dst] = picked as [BV, BV];
    const path = pathVert(sel.bm.verts.filter((v): v is BV => !!v), src, dst, topo, faceStep);
    apply(
      path,
      (v) => sel.sv.has(v),
      (v, on) => {
        if (on) sel.sv.add(v);
        else {
          // The vertex mode's flush below drops the edges and faces that lose it.
          sel.sv.delete(v);
          for (const e of diskEdges(v)) {
            sel.se.delete(e);
            for (const x of radialFaces(e)) sel.sf.delete(x);
          }
        }
      },
      dst,
    );
    sel.flush("vertex");
  } else if (mode === "edge") {
    const picked = liveEdges(sel.bm).filter((e) => sel.se.has(e));
    if (picked.length < 2) return sel.result();
    const [src, dst] = picked as [BE, BE];
    const path = pathEdge(liveEdges(sel.bm), src, dst, topo, faceStep);
    apply(
      path,
      (e) => sel.se.has(e),
      (e, on) => {
        if (on) sel.edge(e);
        else {
          sel.se.delete(e);
          for (const v of [e.v1, e.v2]) if (!diskEdges(v).some((x) => sel.se.has(x))) sel.sv.delete(v);
        }
      },
      dst,
    );
    sel.flush("edge");
  } else {
    const faces = liveFaces(sel.bm);
    const picked = faces.filter((x) => sel.sf.has(x));
    if (picked.length < 2) return sel.result();
    const [src, dst] = picked as [BF, BF];
    const path = pathFace(faces, src, dst, topo, faceStep);
    apply(
      path,
      (x) => sel.sf.has(x),
      (x, on) => {
        if (on) sel.face(x);
        else {
          // `BM_face_select_set(false)`: its edges no other selected face keeps, then its vertices no other selected edge keeps.
          sel.sf.delete(x);
          for (const l of faceLoops(x)) if (!radialFaces(l.e!).some((g) => sel.sf.has(g))) sel.se.delete(l.e!);
          for (const l of faceLoops(x)) if (!diskEdges(l.v).some((e) => e !== l.e && sel.se.has(e))) sel.sv.delete(l.v);
        }
      },
      dst,
    );
  }
  return sel.result();
}

/** `BM_mesh_calc_path_vert`. */
function pathVert(verts: BV[], src: BV, dst: BV, topo: boolean, faceStep: boolean): BV[] | null {
  const cost = new Map<BV, number>(verts.map((v) => [v, Number.MAX_VALUE]));
  const prev = new Map<BV, BV>();
  const visited = new Set<BV>();
  const heap = new HeapSimple<BV>();
  heap.insert(0, src);
  cost.set(src, 0);
  const relax = (a: BV, b: BV): void => {
    if (visited.has(b)) return;
    const cut = topo ? 1 : distance(a.co, b.co);
    const next = f(cost.get(a)! + cut);
    if (cost.get(b)! > next) {
      cost.set(b, next);
      prev.set(b, a);
      heap.insert(next, b);
    }
  };
  let v: BV | null = null;
  while (!heap.empty) {
    v = heap.popMin();
    if (v === dst) break;
    if (visited.has(v)) continue;
    visited.add(v);
    for (const e of diskEdges(v)) relax(v, e.v1 === v ? e.v2 : e.v1);
    if (faceStep)
      for (const l of loopsOfVert(v)) {
        if (l.f.len <= 3) continue;
        // Skip the loops on the two edges at v.
        for (let it = l.next.next; it !== l.prev; it = it.next) relax(v, it.v);
      }
  }
  return v === dst ? walkBack(dst, prev) : null;
}

/** `BM_mesh_calc_path_edge`. */
function pathEdge(edges: BE[], src: BE, dst: BE, topo: boolean, faceStep: boolean): BE[] | null {
  const cost = new Map<BE, number>(edges.map((e) => [e, Number.MAX_VALUE]));
  const prev = new Map<BE, BE>();
  const visited = new Set<BE>();
  const vertTag = new Set<BV>();
  const heap = new HeapSimple<BE>();
  heap.insert(0, src);
  cost.set(src, 0);
  const other = (e: BE, v: BV): BV => (e.v1 === v ? e.v2 : e.v1);
  const relax = (a: BE, b: BE, cut: () => number): void => {
    const next = f(cost.get(a)! + (topo ? 1 : cut()));
    if (cost.get(b)! > next) {
      cost.set(b, next);
      prev.set(b, a);
      heap.insert(next, b);
    }
  };
  let e: BE | null = null;
  while (!heap.empty) {
    e = heap.popMin();
    if (e === dst) break;
    if (visited.has(e)) continue;
    visited.add(e);
    vertTag.add(e.v1);
    vertTag.add(e.v2);
    const a = e;
    if (!faceStep || !a.l) {
      for (const v of [a.v1, a.v2]) {
        const p = prev.get(a);
        if (p && (p.v1 === v || p.v2 === v)) continue;
        for (const b of diskEdges(v)) {
          if (visited.has(b) || vertTag.has(other(b, v))) continue;
          relax(a, b, () => stepCost(other(a, v).co, v.co, other(b, v).co));
        }
      }
    } else {
      const l0 = a.l;
      let l: BL = l0;
      do {
        const face = l.f;
        for (let it = l.next; it !== l; it = it.next) {
          const b = it.e!;
          if (visited.has(b)) continue;
          // `edgetag_cut_cost_face` takes each edge's centre as `mid_v3_v3v3(v1, v1)` — its first vertex.
          relax(a, b, () => stepCost(a.v1.co, b.v1.co, faceCentreWeighted(face)));
        }
        l = l.rn!;
      } while (l !== l0);
    }
  }
  return e === dst ? walkBack(dst, prev) : null;
}

/** `BM_mesh_calc_path_face`. */
function pathFace(faces: BF[], src: BF, dst: BF, topo: boolean, faceStep: boolean): BF[] | null {
  const cost = new Map<BF, number>(faces.map((x) => [x, Number.MAX_VALUE]));
  const prev = new Map<BF, BF>();
  const visited = new Set<BF>();
  const heap = new HeapSimple<BF>();
  heap.insert(0, src);
  cost.set(src, 0);
  const relax = (a: BF, b: BF, cut: () => number): void => {
    if (visited.has(b)) return;
    const next = f(cost.get(a)! + (topo ? 1 : cut()));
    if (cost.get(b)! > next) {
      cost.set(b, next);
      prev.set(b, a);
      heap.insert(next, b);
    }
  };
  let x: BF | null = null;
  while (!heap.empty) {
    x = heap.popMin();
    if (x === dst) break;
    if (visited.has(x)) continue;
    visited.add(x);
    const a = x;
    for (const la of faceLoops(a)) {
      let l: BL = la;
      do {
        const b = l.f;
        const edge = l.e!;
        relax(a, b, () => {
          const ca = faceCentreWeighted(a);
          const cb = faceCentreWeighted(b);
          const ix = isectLineLine(edge.v1.co, edge.v2.co, ca, cb);
          // A parallel pair (or a zero-length edge) leaves Blender's point uninitialised — its result there is undefined;
          // the edge's first vertex stands in.
          const t = ix ? linePointFactor(ix, edge.v1.co, edge.v2.co) : 0;
          const centre = t < 0 || !ix ? [...edge.v1.co] : t > 1 ? [...edge.v2.co] : ix;
          return stepCost(ca, centre, cb, a === src, b === dst);
        });
        l = l.rn!;
      } while (l !== la);
    }
    if (faceStep)
      for (const la of faceLoops(a))
        for (const lb of loopsOfVert(la.v)) {
          // `BM_loop_share_edge_check`: lb's edges at the vertex are not la's.
          if (lb === la || lb.e === la.e || lb.e === la.prev.e || lb.prev.e === la.e) continue;
          relax(a, lb.f, () => stepCost(faceCentreWeighted(a), la.v.co, faceCentreWeighted(lb.f), a === src, lb.f === dst));
        }
  }
  return x === dst ? walkBack(dst, prev) : null;
}

function walkBack<T>(dst: T, prev: Map<T, T>): T[] {
  const path: T[] = [];
  for (let x: T | undefined = dst; x !== undefined; x = prev.get(x)) path.unshift(x);
  return path;
}

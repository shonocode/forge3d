/**
 * Just enough of BMesh to run the Skin modifier's branch hulls the way
 * `MOD_skin.cc` does — with the orders that decide ties kept:
 *
 * - **Element slots are reused last-freed-first** (`BLI_mempool`'s free
 *   list), and iterating the mesh walks slots in order. Which edge the
 *   triangle-merging heap sees first depends on it.
 * - **The radial cycle** (faces around an edge) keeps `e->l` pointing at the
 *   most recently added loop (`bmesh_radial_loop_append`); which triangle
 *   `BM_edge_face_pair` calls the first decides how a merged quad is wound.
 * - **Deleting tagged faces, then tagged edges**, each in slot order
 *   (`BM_mesh_delete_hflag_tagged`).
 *
 * Positions are float32, as a `BMVert`'s are.
 */
import { bulletConvexHull } from "../hull/bullet-hull";

export type Vec3 = [number, number, number];

const f = Math.fround;

export interface BVert {
  co: Vec3;
  slot: number;
  /** Edges using this vertex (membership only; the disk order is not needed). */
  edges: BEdge[];
  tag: boolean;
}

export interface BEdge {
  v1: BVert;
  v2: BVert;
  l: BLoop | null;
  slot: number;
  tag: boolean;
}

export interface BLoop {
  v: BVert;
  e: BEdge;
  f: BFace;
  next: BLoop;
  prev: BLoop;
  radialNext: BLoop;
  radialPrev: BLoop;
}

export interface BFace {
  lFirst: BLoop;
  len: number;
  no: Vec3;
  slot: number;
  tag: boolean;
}

/** `BLI_mempool` slots: the last freed is the next used. */
class Pool<T extends { slot: number }> {
  readonly slots: (T | null)[] = [];
  private readonly free: number[] = [];

  add(x: T): T {
    const s = this.free.length > 0 ? this.free.pop()! : this.slots.length;
    x.slot = s;
    this.slots[s] = x;
    return x;
  }

  remove(x: T): void {
    this.slots[x.slot] = null;
    this.free.push(x.slot);
  }

  /** Slot order; the next element is read before the body runs (`_MUTABLE`). */
  *[Symbol.iterator](): Generator<T> {
    for (let i = 0; i < this.slots.length; i++) {
      const x = this.slots[i];
      if (x) yield x;
    }
  }
}

export class MiniBMesh {
  readonly verts = new Pool<BVert>();
  readonly edges = new Pool<BEdge>();
  readonly faces = new Pool<BFace>();

  vertCreate(co: readonly number[]): BVert {
    return this.verts.add({ co: [f(co[0]!), f(co[1]!), f(co[2]!)], slot: -1, edges: [], tag: false });
  }

  edgeExists(a: BVert, b: BVert): BEdge | null {
    for (const e of a.edges) if ((e.v1 === a && e.v2 === b) || (e.v1 === b && e.v2 === a)) return e;
    return null;
  }

  /** `BM_edge_create(…, BM_CREATE_NO_DOUBLE)`. */
  edgeCreate(a: BVert, b: BVert): BEdge {
    const found = this.edgeExists(a, b);
    if (found) return found;
    const e = this.edges.add({ v1: a, v2: b, l: null, slot: -1, tag: false });
    a.edges.push(e);
    b.edges.push(e);
    return e;
  }

  /** `BM_face_exists`: a face with exactly these vertices, either winding. */
  faceExists(vs: readonly BVert[]): BFace | null {
    for (const e of vs[0]!.edges) {
      if (!e.l) continue;
      let l = e.l;
      do {
        const face = l.f;
        if (face.len === vs.length) {
          const loopVerts: BVert[] = [];
          let it = face.lFirst;
          do {
            loopVerts.push(it.v);
            it = it.next;
          } while (it !== face.lFirst);
          const n = vs.length;
          const s = loopVerts.indexOf(vs[0]!);
          if (s >= 0) {
            let fwd = true;
            let bwd = true;
            for (let i = 0; i < n; i++) {
              if (loopVerts[(s + i) % n] !== vs[i]) fwd = false;
              if (loopVerts[(s - i + n) % n] !== vs[i]) bwd = false;
            }
            if (fwd || bwd) return face;
          }
        }
        l = l.radialNext;
      } while (l !== e.l);
    }
    return null;
  }

  private radialAppend(e: BEdge, l: BLoop): void {
    if (e.l === null) {
      e.l = l;
      l.radialNext = l.radialPrev = l;
    } else {
      l.radialPrev = e.l;
      l.radialNext = e.l.radialNext;
      e.l.radialNext.radialPrev = l;
      e.l.radialNext = l;
      e.l = l;
    }
  }

  private radialRemove(e: BEdge, l: BLoop): void {
    if (l.radialNext !== l) {
      if (l === e.l) e.l = l.radialNext;
      l.radialNext.radialPrev = l.radialPrev;
      l.radialPrev.radialNext = l.radialNext;
    } else if (l === e.l) e.l = null;
  }

  /**
   * `BM_face_create_verts(…, BM_CREATE_NO_DOUBLE, create_edges = true)`: the
   * edges are made first (in order), then an existing face is returned if
   * there is one.
   */
  faceCreateVerts(vs: readonly BVert[]): BFace {
    const es = vs.map((v, i) => this.edgeCreate(v, vs[(i + 1) % vs.length]!));
    const existing = this.faceExists(vs);
    if (existing) return existing;
    const face = { len: vs.length, no: [0, 0, 0], slot: -1, tag: false } as unknown as BFace;
    const loops: BLoop[] = vs.map((v, i) => ({ v, e: es[i]!, f: face }) as unknown as BLoop);
    loops.forEach((l, i) => {
      l.next = loops[(i + 1) % loops.length]!;
      l.prev = loops[(i - 1 + loops.length) % loops.length]!;
      this.radialAppend(l.e, l);
    });
    face.lFirst = loops[0]!;
    this.faces.add(face);
    this.faceNormalUpdate(face);
    return face;
  }

  faceKill(face: BFace): void {
    let l = face.lFirst;
    do {
      const n = l.next;
      this.radialRemove(l.e, l);
      l = n;
    } while (l !== face.lFirst);
    this.faces.remove(face);
  }

  edgeKill(e: BEdge): void {
    while (e.l) this.faceKill(e.l.f);
    e.v1.edges.splice(e.v1.edges.indexOf(e), 1);
    e.v2.edges.splice(e.v2.edges.indexOf(e), 1);
    this.edges.remove(e);
  }

  vertKill(v: BVert): void {
    while (v.edges.length > 0) this.edgeKill(v.edges[0]!);
    this.verts.remove(v);
  }

  /** Loops of a face, from the first. */
  faceLoops(face: BFace): BLoop[] {
    const out: BLoop[] = [];
    let l = face.lFirst;
    do {
      out.push(l);
      l = l.next;
    } while (l !== face.lFirst);
    return out;
  }

  /** Give a face a new ring of corners in place (the face keeps its slot). */
  private relink(face: BFace, vs: readonly BVert[]): void {
    for (const l of this.faceLoops(face)) this.radialRemove(l.e, l);
    const es = vs.map((v, i) => this.edgeCreate(v, vs[(i + 1) % vs.length]!));
    const loops: BLoop[] = vs.map((v, i) => ({ v, e: es[i]!, f: face }) as unknown as BLoop);
    loops.forEach((l, i) => {
      l.next = loops[(i + 1) % loops.length]!;
      l.prev = loops[(i - 1 + loops.length) % loops.length]!;
      this.radialAppend(l.e, l);
    });
    face.lFirst = loops[0]!;
    face.len = vs.length;
    this.faceNormalUpdate(face);
  }

  /**
   * `extrude_discrete_faces` on one face: a copy with its own corners, a side
   * quad `(o[i+1], n[i+1], n[i], o[i])` per edge, and the original deleted.
   * Returns the copy.
   */
  extrudeDiscreteFace(face: BFace): BFace {
    const org = this.faceVerts(face);
    const copyVerts = org.map((v) => this.vertCreate(v.co));
    // `BM_face_copy`: each new edge copies its original's flags — the tag too.
    const orgEdges = this.faceEdges(face);
    copyVerts.forEach((v, i) => (this.edgeCreate(v, copyVerts[(i + 1) % copyVerts.length]!).tag = orgEdges[i]!.tag));
    const copy = this.faceCreateVerts(copyVerts);
    const n = org.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      this.faceCreateVerts([org[j]!, copyVerts[j]!, copyVerts[i]!, org[i]!]);
    }
    this.faceKill(face);
    return copy;
  }

  /**
   * `BM_edge_split` at `co`: the edge keeps `v1`…new, a new edge takes
   * new…`v2`, and every face around it gains the corner.
   */
  edgeSplit(e: BEdge, co: readonly number[]): BVert {
    const v1 = e.v1;
    const v2 = e.v2;
    const loops: BLoop[] = [];
    if (e.l) {
      let l = e.l;
      do {
        loops.push(l);
        l = l.radialNext;
      } while (l !== e.l);
    }
    const m = this.vertCreate(co);
    v2.edges.splice(v2.edges.indexOf(e), 1);
    e.v2 = m;
    m.edges.push(e);
    const e2 = this.edges.add({ v1: m, v2, l: null, slot: -1, tag: e.tag }); // the new half copies the edge's flags
    m.edges.push(e2);
    v2.edges.push(e2);
    e.l = null;
    for (const l of loops) {
      const lm = { v: m, f: l.f } as unknown as BLoop;
      lm.prev = l;
      lm.next = l.next;
      l.next.prev = lm;
      l.next = lm;
      if (l.v === v1) {
        lm.e = e2;
        l.e = e;
      } else {
        lm.e = e;
        l.e = e2;
      }
      l.f.len++;
    }
    for (const l of loops) {
      this.radialAppend(l.e, l);
      this.radialAppend(l.next.e, l.next);
    }
    return m;
  }

  /** `BM_face_split`: an edge from `a` to `b`; the new face runs `a`→`b`. */
  faceSplit(face: BFace, a: BLoop, b: BLoop): BFace {
    const vs = this.faceVerts(face);
    const ia = vs.indexOf(a.v);
    const ib = vs.indexOf(b.v);
    const run = (from: number, to: number): BVert[] => {
      const out: BVert[] = [];
      for (let i = from; ; i = (i + 1) % vs.length) {
        out.push(vs[i]!);
        if (i === to) break;
      }
      return out;
    };
    const keep = run(ib, ia);
    const fresh = run(ia, ib);
    this.relink(face, keep);
    return this.faceCreateVerts(fresh);
  }

  /**
   * `weld_verts`: every vertex in `map` merges into its target. Faces that
   * would hold a vertex and its target apart are split first; edges and faces
   * are rebuilt on the targets — consecutive repeats collapse, a face that
   * would visit a corner twice is not made (its edges are, which is how the
   * result can carry a loose edge) — and the old ones deleted.
   */
  weldVerts(map: Map<BVert, BVert>): void {
    // `remdoubles_splitface`
    const splitFace = (face: BFace): void => {
      for (const l of this.faceLoops(face)) {
        const tar = map.get(l.v);
        if (!tar) continue;
        const lt = this.faceLoops(face).find((x) => x.v === tar);
        if (lt && lt !== l && lt.next !== l && lt.prev !== l) {
          const fresh = this.faceSplit(face, l, lt);
          splitFace(face);
          splitFace(fresh);
          return;
        }
      }
    };
    for (const face of this.faces) splitFace(face);

    const delEdges = new Set<BEdge>();
    const collapsed = new Set<BEdge>();
    for (const e of this.edges) {
      const a = map.get(e.v1);
      const b = map.get(e.v2);
      if (!a && !b) continue;
      const v1 = a ?? e.v1;
      const v2 = b ?? e.v2;
      if (v1 === v2) collapsed.add(e);
      // Made with the old edge as example, then `BM_elem_flag_merge_ex`: flags OR together.
      else {
        const made = this.edgeCreate(v1, v2);
        made.tag = made.tag || e.tag;
        e.tag = made.tag;
      }
      delEdges.add(e);
    }

    const delFaces = new Set<BFace>();
    for (const face of this.faces) {
      const loops = this.faceLoops(face);
      if (!loops.some((l) => map.has(l.v))) continue;
      delFaces.add(face);
      const nCollapse = loops.filter((l) => collapsed.has(l.e)).length;
      if (face.len - nCollapse < 3) continue;
      // `remdoubles_createface`
      const out: BVert[] = [];
      let ok = true;
      for (const l of loops) {
        const v = map.get(l.v) ?? l.v;
        const w = map.get(l.next.v) ?? l.next.v;
        if (v === w) continue;
        if (out.includes(v)) {
          ok = false;
          break;
        }
        out.push(v);
      }
      if (!ok || out.length < 3) continue;
      if (this.faceExists(out)) continue;
      // A new face is made and swapped into the old one's slot, then killed.
      const dummy = this.faces.add({ slot: -1 } as BFace);
      this.faces.remove(dummy);
      this.relink(face, out);
      delFaces.delete(face);
    }
    for (const face of this.faces) if (delFaces.has(face)) this.faceKill(face);
    for (const e of this.edges) if (delEdges.has(e)) this.edgeKill(e);
    for (const v of this.verts) if (map.has(v)) this.vertKill(v);
  }

  /** `BM_mesh_delete_hflag_tagged(bm, TAG, BM_EDGE | BM_FACE)`. */
  deleteTaggedEdgesFaces(): void {
    for (const face of this.faces) if (face.tag) this.faceKill(face);
    for (const e of this.edges) if (e.tag) this.edgeKill(e);
  }

  clearTags(): void {
    for (const v of this.verts) v.tag = false;
    for (const e of this.edges) e.tag = false;
    for (const face of this.faces) face.tag = false;
  }

  faceVerts(face: BFace): BVert[] {
    const out: BVert[] = [];
    let l = face.lFirst;
    do {
      out.push(l.v);
      l = l.next;
    } while (l !== face.lFirst);
    return out;
  }

  faceEdges(face: BFace): BEdge[] {
    const out: BEdge[] = [];
    let l = face.lFirst;
    do {
      out.push(l.e);
      l = l.next;
    } while (l !== face.lFirst);
    return out;
  }

  /** Faces around an edge, radial order from `e.l`. */
  edgeFaces(e: BEdge): BFace[] {
    const out: BFace[] = [];
    if (!e.l) return out;
    let l = e.l;
    do {
      out.push(l.f);
      l = l.radialNext;
    } while (l !== e.l);
    return out;
  }

  /** `BM_edge_face_pair`: exactly two faces, `e.l`'s first. */
  edgeFacePair(e: BEdge): [BFace, BFace] | null {
    const la = e.l;
    if (!la) return null;
    const lb = la.radialNext;
    if (la !== lb && lb.radialNext === la) return [la.f, lb.f];
    return null;
  }

  /** `BM_face_share_face_check`: is there a third face sharing an edge with both? */
  faceShareFaceCheck(a: BFace, b: BFace): boolean {
    const bEdges = new Set(this.faceEdges(b));
    for (const e of this.faceEdges(a))
      for (const face of this.edgeFaces(e))
        if (face !== a && face !== b && this.faceEdges(face).some((x) => bEdges.has(x))) return true;
    return false;
  }

  /** `BM_face_calc_area`: Newell's cross sum from the first loop, in float. */
  faceArea(face: BFace): number {
    const n: Vec3 = [0, 0, 0];
    let l = face.lFirst;
    do {
      const a = l.v.co;
      const b = l.next.v.co;
      n[0] = f(n[0] + f(f(a[1] - b[1]) * f(a[2] + b[2])));
      n[1] = f(n[1] + f(f(a[2] - b[2]) * f(a[0] + b[0])));
      n[2] = f(n[2] + f(f(a[0] - b[0]) * f(a[1] + b[1])));
      l = l.next;
    } while (l !== face.lFirst);
    return f(f(Math.sqrt(dotF(n, n))) * 0.5);
  }

  /** `BM_face_normal_update`: tri / quad / Newell, in float. */
  faceNormalUpdate(face: BFace): void {
    const co = this.faceVerts(face).map((v) => v.co);
    face.no = co.length === 3 ? normalTri(co[0]!, co[1]!, co[2]!) : co.length === 4 ? normalQuad(co[0]!, co[1]!, co[2]!, co[3]!) : newell(co);
  }

  /**
   * `bmesh.ops.convex_hull(input=verts)` with `use_existing_faces` off: hull
   * triangles as faces (Bullet's faces fanned), and which input vertices
   * ended up inside. Returns null when there are fewer than three inputs.
   */
  convexHull(input: readonly BVert[]): { geomEdges: BEdge[]; geomFaces: BFace[]; interior: BVert[] } | null {
    if (input.length < 3) return null;
    const hull = bulletConvexHull(input.map((v) => v.co));
    const used = new Set<BVert>();
    const outEdges = new Set<BEdge>();
    const outFaces = new Set<BFace>();
    for (const fv of hull.faces) {
      if (fv.length <= 2) continue;
      const hv = fv.map((i) => input[hull.originalIndex[i]!]!);
      for (let j = 2; j < hv.length; j++) {
        const t = [hv[0]!, hv[j - 1]!, hv[j]!];
        for (const v of t) used.add(v);
        const es = [this.edgeCreate(t[0]!, t[1]!), this.edgeCreate(t[1]!, t[2]!), this.edgeCreate(t[2]!, t[0]!)];
        const face = this.faceExists(t) ?? this.faceCreateVerts(t);
        outFaces.add(face);
        for (const e of es) outEdges.add(e);
      }
    }
    // `geom.out` and `geom_interior.out` come out in slot order.
    return {
      geomEdges: [...this.edges].filter((e) => outEdges.has(e)),
      geomFaces: [...this.faces].filter((x) => outFaces.has(x)),
      interior: [...this.verts].filter((v) => input.includes(v) && !used.has(v)),
    };
  }

  /** Vertices, faces, and the edges no face uses — each in slot order. */
  toMeshData(): { positions: Float32Array; polys: number[][]; edges?: number[][] } {
    const index = new Map<BVert, number>();
    const positions: number[] = [];
    for (const v of this.verts) {
      index.set(v, index.size);
      positions.push(...v.co);
    }
    const polys: number[][] = [];
    for (const face of this.faces) polys.push(this.faceVerts(face).map((v) => index.get(v)!));
    const edges: number[][] = [];
    for (const e of this.edges) if (!e.l) edges.push([index.get(e.v1)!, index.get(e.v2)!]);
    return { positions: Float32Array.from(positions), polys, ...(edges.length > 0 ? { edges } : {}) };
  }
}

// ── float geometry (math_geom.cc) ───────────────────────────────────────────

const sub = (a: Vec3, b: Vec3): Vec3 => [f(a[0] - b[0]), f(a[1] - b[1]), f(a[2] - b[2])];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  f(f(a[1] * b[2]) - f(a[2] * b[1])),
  f(f(a[2] * b[0]) - f(a[0] * b[2])),
  f(f(a[0] * b[1]) - f(a[1] * b[0])),
];
export const dotF = (a: Vec3, b: Vec3): number => f(f(f(a[0] * b[0]) + f(a[1] * b[1])) + f(a[2] * b[2]));

function normalizeF(v: Vec3): Vec3 {
  const d = dotF(v, v);
  if (d > 1e-35) {
    const s = f(1 / f(Math.sqrt(d)));
    return [f(v[0] * s), f(v[1] * s), f(v[2] * s)];
  }
  return [0, 0, 0];
}

export function normalTri(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const n1 = sub(a, b);
  const n2 = sub(b, c);
  return normalizeF(cross(n1, n2));
}

export function normalQuad(a: Vec3, b: Vec3, c: Vec3, d: Vec3): Vec3 {
  const n1 = sub(a, c);
  const n2 = sub(b, d);
  return normalizeF(cross(n1, n2));
}

function newell(co: Vec3[]): Vec3 {
  const n: Vec3 = [0, 0, 0];
  for (let i = 0; i < co.length; i++) {
    const a = co[(i - 1 + co.length) % co.length]!;
    const b = co[i]!;
    n[0] = f(n[0] + f(f(a[1] - b[1]) * f(a[2] + b[2])));
    n[1] = f(n[1] + f(f(a[2] - b[2]) * f(a[0] + b[0])));
    n[2] = f(n[2] + f(f(a[0] - b[0]) * f(a[1] + b[1])));
  }
  return normalizeF(n);
}

/** `area_tri_v3`. */
export function areaTri(a: Vec3, b: Vec3, c: Vec3): number {
  const n = cross(sub(a, b), sub(b, c));
  return f(f(Math.sqrt(dotF(n, n))) / 2);
}

/** `is_quad_convex_v3`. */
export function isQuadConvex(v1: Vec3, v2: Vec3, v3: Vec3, v4: Vec3): boolean {
  const plane = cross(sub(v1, v3), sub(v2, v4));
  if (dotF(plane, plane) < f(1e-8 * 1e-8)) return false;
  const lenSq = dotF(plane, plane);
  // `project_plane_v3_v3v3(r, p, n)`: p − n (p·n / n·n)
  const proj = [v1, v2, v3, v4].map((p) => {
    const mul = f(dotF(p, plane) / lenSq);
    return [f(p[0] - f(plane[0] * mul)), f(p[1] - f(plane[1] * mul)), f(p[2] - f(plane[2] * mul))] as Vec3;
  });
  const dirs: Vec3[] = [];
  for (let i = 0, j = 3; i < 4; j = i++) dirs[i] = sub(proj[i]!, proj[j]!);
  const ok = (a: Vec3, b: Vec3): boolean => dotF(plane, cross(a, b)) > 0;
  return ok(dirs[0]!, dirs[1]!) && ok(dirs[1]!, dirs[2]!) && ok(dirs[2]!, dirs[3]!) && ok(dirs[3]!, dirs[0]!);
}

// ── BLI_heapsimple ──────────────────────────────────────────────────────────

/** `HeapSimple`: a binary min-heap with Blender's exact sift order. */
export class HeapSimple<T> {
  private readonly tree: { value: number; ptr: T }[] = [];

  insert(value: number, ptr: T): void {
    let i = this.tree.length;
    this.tree.push({ value, ptr });
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (value >= this.tree[p]!.value) break;
      this.tree[i] = this.tree[p]!;
      i = p;
    }
    this.tree[i] = { value, ptr };
  }

  isEmpty(): boolean {
    return this.tree.length === 0;
  }

  popMin(): T {
    const ptr = this.tree[0]!.ptr;
    const last = this.tree.pop()!;
    if (this.tree.length > 0) {
      const size = this.tree.length;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        let smallestVal = last.value;
        if (l < size && this.tree[l]!.value < last.value) {
          smallest = l;
          smallestVal = this.tree[l]!.value;
        }
        if (r < size && this.tree[r]!.value < smallestVal) smallest = r;
        if (smallest === i) break;
        this.tree[i] = this.tree[smallest]!;
        i = smallest;
      }
      this.tree[i] = last;
    }
    return ptr;
  }
}

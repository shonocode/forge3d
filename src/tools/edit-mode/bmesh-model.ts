/**
 * A BMesh with its three cycles kept the way Blender keeps them — for ports of operators whose result depends on
 * the order things are walked in (`bmo_offset_edgeloops.cc`).
 *
 * - **The disk cycle** (the edges round a vertex): an edge is appended at the end when it is created or moved
 *   onto the vertex (`bmesh_disk_edge_append`), and the head moves on only if the head is removed. Iterating a
 *   vertex's edges starts at the head, and the next edge is read *before* the body runs.
 * - **The radial cycle** (the loops round an edge): `e->l` is the most recently added loop
 *   (`bmesh_radial_loop_append`).
 * - **The loop cycle** of a face and its `l_first`, which `BM_face_split` keeps in a particular way.
 *
 * It holds just what the ports need: the kernel operations `BM_edge_split` (`bmesh_kernel_split_edge_make_vert`),
 * `BM_face_split` (`bmesh_kernel_split_face_make_edge`), `BM_face_split_n` and `bmesh_kernel_join_edge_kill_vert`,
 * and the queries that go with them. Per-corner data is carried as references to the corners of the input
 * (`CornerRef`), so a copy is the same reference and an interpolation a weighted list — the form the editor's
 * `rebuildPolygons` takes.
 *
 * Not modelled: the memory pools (slot reuse), multires, and flags other than `tag`.
 */

export type Vec3 = [number, number, number];

/** A weighted reference to a corner of the input: `[face, corner, weight]`. */
export type CornerRef = readonly [face: number, corner: number, weight: number];

/** Where a vertex's data comes from: input vertices with weights. */
export interface VertOrigin {
  from: readonly number[];
  w: readonly number[];
  interp?: boolean;
}

export class BMVert {
  /** The edges round this vertex, the head (`v->e`) first. */
  disk: BMEdge[] = [];
  /** The input vertex it is (>= 0), or -1 for one made since (`BM_elem_index_get`). */
  idx = -1;
  tag = false;
  /** Data source for a made vertex; null for an input vertex (its own data). */
  origin: VertOrigin | null = null;
  co: Vec3;
  constructor(co: Vec3) {
    this.co = co;
  }
}

export class BMEdge {
  l: BMLoop | null = null;
  tag = false;
  v1: BMVert;
  v2: BMVert;
  constructor(v1: BMVert, v2: BMVert) {
    this.v1 = v1;
    this.v2 = v2;
  }
}

export class BMLoop {
  v!: BMVert;
  e!: BMEdge | null;
  f!: BMFace;
  next!: BMLoop;
  prev!: BMLoop;
  radialNext!: BMLoop | null;
  radialPrev!: BMLoop | null;
  src: CornerRef[] = [];
}

export class BMFace {
  lFirst!: BMLoop;
  len = 0;
  tag = false;
  /** The input face whose material slot it has (-1: slot 0). */
  material = -1;
}

const sameCo = (a: Vec3, b: Vec3): boolean => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

export class BMesh {
  readonly verts = new Set<BMVert>();
  readonly edges = new Set<BMEdge>();
  readonly faces = new Set<BMFace>();

  // ── disk cycle ──

  diskAppend(e: BMEdge, v: BMVert): void {
    v.disk.push(e);
  }

  diskRemove(e: BMEdge, v: BMVert): void {
    const i = v.disk.indexOf(e);
    if (i >= 0) v.disk.splice(i, 1);
  }

  diskNext(e: BMEdge, v: BMVert): BMEdge {
    const i = v.disk.indexOf(e);
    return v.disk[(i + 1) % v.disk.length]!;
  }

  /** `bmesh_disk_vert_replace`: `e` takes `dst` where it had `src`. */
  diskVertReplace(e: BMEdge, dst: BMVert, src: BMVert): void {
    this.diskRemove(e, src);
    if (e.v1 === src) e.v1 = dst;
    else e.v2 = dst;
    this.diskAppend(e, dst);
  }

  /** The edges round `v`, the way `BM_ITER_ELEM(…, BM_EDGES_OF_VERT)` walks them. */
  *edgesOfVert(v: BMVert): Generator<BMEdge> {
    const first = v.disk[0] ?? null;
    let next = first;
    while (next) {
      const cur: BMEdge = next;
      next = this.diskNext(cur, v);
      if (next === first) next = null;
      yield cur;
    }
  }

  /** The corners at `v` (`BM_LOOPS_OF_VERT`): by edge in disk order, by loop in radial order from `e->l`. */
  loopsOfVert(v: BMVert): BMLoop[] {
    const out: BMLoop[] = [];
    for (const e of v.disk) {
      if (!e.l) continue;
      let l = e.l;
      do {
        if (l.v === v) out.push(l);
        l = l.radialNext!;
      } while (l !== e.l);
    }
    return out;
  }

  /** The loops of an edge, from `e->l`. */
  loopsOfEdge(e: BMEdge): BMLoop[] {
    const out: BMLoop[] = [];
    if (!e.l) return out;
    let l = e.l;
    do {
      out.push(l);
      l = l.radialNext!;
    } while (l !== e.l);
    return out;
  }

  // ── radial cycle ──

  radialAppend(e: BMEdge, l: BMLoop): void {
    if (e.l === null) {
      e.l = l;
      l.radialNext = l.radialPrev = l;
    } else {
      l.radialPrev = e.l;
      l.radialNext = e.l.radialNext;
      e.l.radialNext!.radialPrev = l;
      e.l.radialNext = l;
      e.l = l;
    }
    l.e = e;
  }

  radialRemove(e: BMEdge, l: BMLoop): void {
    if (l.radialNext !== l) {
      if (l === e.l) e.l = l.radialNext;
      l.radialNext!.radialPrev = l.radialPrev;
      l.radialPrev!.radialNext = l.radialNext;
    } else if (l === e.l) e.l = null;
    l.radialNext = l.radialPrev = null;
    l.e = null;
  }

  /** `bmesh_radial_loop_unlink`: out of the cycle, `e->l` left alone. */
  radialUnlink(l: BMLoop): void {
    if (l.radialNext !== l) {
      l.radialNext!.radialPrev = l.radialPrev;
      l.radialPrev!.radialNext = l.radialNext;
    }
    l.radialNext = l.radialPrev = null;
    l.e = null;
  }

  // ── creation ──

  /** `BM_vert_create` with an example: the new vertex has the example's data. */
  vertCreate(co: readonly number[], example: BMVert | null = null): BMVert {
    const v = new BMVert([co[0]!, co[1]!, co[2]!]);
    if (example) v.origin = example.origin;
    this.verts.add(v);
    return v;
  }

  edgeExists(a: BMVert, b: BMVert): BMEdge | null {
    for (const e of a.disk) if ((e.v1 === a && e.v2 === b) || (e.v1 === b && e.v2 === a)) return e;
    return null;
  }

  /** `BM_edge_create`; an example's flags are copied, `noDouble` returns an edge that is already there. */
  edgeCreate(v1: BMVert, v2: BMVert, example: BMEdge | null, noDouble: boolean): BMEdge {
    if (noDouble) {
      const e = this.edgeExists(v1, v2);
      if (e) return e;
    }
    const e = new BMEdge(v1, v2);
    this.diskAppend(e, v1);
    this.diskAppend(e, v2);
    if (example) e.tag = example.tag;
    this.edges.add(e);
    return e;
  }

  private loopCreate(v: BMVert | null, e: BMEdge | null, f: BMFace, example: BMLoop | null): BMLoop {
    const l = new BMLoop();
    l.v = v as BMVert;
    l.e = e;
    l.f = f;
    l.radialNext = l.radialPrev = null;
    if (example) l.src = example.src.map((s) => [...s] as unknown as CornerRef);
    return l;
  }

  /**
   * A face from its vertices and the sources of its corners, the edges taken from the mesh or made closing edge
   * first (`BM_face_create_verts`).
   */
  faceCreate(vs: readonly BMVert[], srcs: readonly CornerRef[][], material: number, existingEdgesOnly = false): BMFace {
    const n = vs.length;
    const es: BMEdge[] = new Array<BMEdge>(n);
    let prev = n - 1;
    for (let i = 0; i < n; i++) {
      es[prev] = existingEdgesOnly ? this.edgeExists(vs[prev]!, vs[i]!)! : this.edgeCreate(vs[prev]!, vs[i]!, null, true);
      prev = i;
    }
    const f = new BMFace();
    f.material = material;
    f.len = n;
    const loops = vs.map((v, i) => {
      const l = this.loopCreate(v, es[i]!, f, null);
      l.src = srcs[i]!.map((s) => [...s] as unknown as CornerRef);
      return l;
    });
    loops.forEach((l, i) => {
      l.next = loops[(i + 1) % n]!;
      l.prev = loops[(i + n - 1) % n]!;
      this.radialAppend(es[i]!, l);
    });
    f.lFirst = loops[0]!;
    this.faces.add(f);
    return f;
  }

  // ── removal ──

  faceKill(f: BMFace): void {
    let l = f.lFirst;
    do {
      const n = l.next;
      this.radialRemove(l.e!, l);
      l = n;
    } while (l !== f.lFirst);
    this.faces.delete(f);
  }

  edgeKill(e: BMEdge): void {
    while (e.l) this.faceKill(e.l.f);
    this.diskRemove(e, e.v1);
    this.diskRemove(e, e.v2);
    this.edges.delete(e);
  }

  // ── queries ──

  faceLoops(f: BMFace): BMLoop[] {
    const out: BMLoop[] = [];
    let l = f.lFirst;
    do {
      out.push(l);
      l = l.next;
    } while (l !== f.lFirst);
    return out;
  }

  /** `BM_vert_is_edge_pair`: exactly two edges. */
  vertIsEdgePair(v: BMVert): boolean {
    return v.disk.length === 2;
  }

  /** `BM_loop_is_adjacent`. */
  loopIsAdjacent(a: BMLoop, b: BMLoop): boolean {
    return a.next === b || a.prev === b;
  }

  /** `BM_edge_other_vert`. */
  otherVert(e: BMEdge, v: BMVert): BMVert {
    return e.v1 === v ? e.v2 : e.v1;
  }

  /** `BM_face_find_double`: another face on the first loop's edge with the same edges in the same cycle. */
  faceFindDouble(f: BMFace): BMFace | null {
    const lFirst = f.lFirst;
    for (let li = lFirst.radialNext!; li !== lFirst; li = li.radialNext!) {
      if (li.f.len !== lFirst.f.len) continue;
      let a = lFirst;
      let b = li;
      let ok = true;
      if (li.v === lFirst.v) {
        do {
          if (a.e !== b.e) {
            ok = false;
            break;
          }
          a = a.next;
          b = b.next;
        } while (b !== li);
      } else {
        do {
          if (a.e !== b.e) {
            ok = false;
            break;
          }
          a = a.prev;
          b = b.next;
        } while (b !== li);
      }
      if (ok) return li.f;
    }
    return null;
  }

  // ── kernel operations ──

  /**
   * `bmesh_kernel_split_edge_make_vert(tv, e)`: a vertex at `tv`'s place on `e`. `e` now runs from its other end to
   * the new vertex, and the new edge from the new vertex to `tv`; every face round `e` gets a corner.
   */
  splitEdgeMakeVert(tv: BMVert, e: BMEdge): { vNew: BMVert; eNew: BMEdge } {
    const vNew = this.vertCreate(tv.co, tv);
    const eNew = this.edgeCreate(tv, vNew, e, false);
    this.diskRemove(eNew, tv);
    this.diskRemove(eNew, vNew);
    this.diskVertReplace(e, vNew, tv);
    this.diskAppend(eNew, vNew);
    this.diskAppend(eNew, tv);

    let lNext: BMLoop | null = e.l;
    e.l = null;
    let isFirst = true;
    while (lNext) {
      const l: BMLoop = lNext;
      l.f.len++;
      lNext = l.radialNext !== l ? l.radialNext : null;
      this.radialUnlink(l);
      const lNew = this.loopCreate(null, null, l.f, l);
      lNew.prev = l;
      lNew.next = l.next;
      lNew.prev.next = lNew;
      lNew.next.prev = lNew;
      lNew.v = vNew;
      const verts = (a: BMVert, b: BMVert, edge: BMEdge): boolean =>
        (edge.v1 === a && edge.v2 === b) || (edge.v1 === b && edge.v2 === a);
      if (verts(lNew.v, lNew.next.v, e)) {
        lNew.e = e;
        l.e = eNew;
      } else {
        lNew.e = eNew;
        l.e = e;
      }
      if (isFirst) {
        isFirst = false;
        l.radialNext = l.radialPrev = null;
      }
      this.radialAppend(lNew.e!, lNew);
      this.radialAppend(l.e!, l);
    }
    return { vNew, eNew };
  }

  /**
   * `BM_edge_split(e, v, …, fac)`: a vertex `fac` of the way from `v` to the other end. Its corners in the faces
   * round the edge, and its vertex data, are the same mix of the two ends.
   */
  edgeSplit(e: BMEdge, v: BMVert, fac: number): { vNew: BMVert; eNew: BMEdge } {
    const vOther = this.otherVert(e, v);
    const { vNew, eNew } = this.splitEdgeMakeVert(v, e);
    vNew.co = [
      v.co[0] + (vOther.co[0] - v.co[0]) * fac,
      v.co[1] + (vOther.co[1] - v.co[1]) * fac,
      v.co[2] + (vOther.co[2] - v.co[2]) * fac,
    ];
    eNew.tag = e.tag;
    // `BM_data_interp_face_vert_edge(v_other, v, v_new, e, fac)`: the new corner mixes the corner at `vOther`
    // (weight `fac`) and the one at `v` (weight `1 - fac`) of the same face. With a fac of 1 (the only one used
    // here) it is a copy of the corner at `vOther`.
    for (const edge of [e, eNew]) {
      for (const l of this.loopsOfEdge(edge)) {
        if (l.v !== vNew && l.next.v !== vNew) continue;
        const lv = l.v === vNew ? l : l.next;
        const a = lv.prev; // one neighbour of the new corner
        const b = lv.next;
        const atOther = a.v === vOther ? a : b.v === vOther ? b : null;
        const atV = a.v === v ? a : b.v === v ? b : null;
        if (!atOther || !atV) continue;
        lv.src = mixSrc(atOther.src, fac, atV.src, 1 - fac);
      }
    }
    // `BM_data_interp_from_verts(v, v_other, v_new, fac)`: the vertex data likewise.
    const ov = originOf(vOther);
    const om = originOf(v);
    vNew.origin = fac === 1 ? ov : mixOrigin(ov, fac, om, 1 - fac);
    return { vNew, eNew };
  }

  /**
   * `bmesh_kernel_split_face_make_edge`: an edge from `a`'s vertex to `b`'s; returns the new face (the one that
   * takes the loops from `a` round to `b`'s predecessor) and the new loop in it, going from a's vertex to b's.
   */
  splitFaceMakeEdge(f: BMFace, lV1: BMLoop, lV2: BMLoop, noDouble: boolean): { fNew: BMFace; lNew: BMLoop } {
    const v1 = lV1.v;
    const v2 = lV2.v;
    const e = this.edgeCreate(v1, v2, null, noDouble);
    const f2 = new BMFace();
    f2.tag = f.tag;
    f2.material = f.material;
    const lF1 = this.loopCreate(v2, e, f, lV2);
    const lF2 = this.loopCreate(v1, e, f2, lV1);

    lF1.prev = lV2.prev;
    lF2.prev = lV1.prev;
    lV2.prev.next = lF1;
    lV1.prev.next = lF2;

    lF1.next = lV1;
    lF2.next = lV2;
    lV1.prev = lF1;
    lV2.prev = lF2;

    // Which face the original first loop is in.
    let firstLoopF1 = false;
    for (let l = lF1; ; ) {
      if (l === f.lFirst) firstLoopF1 = true;
      l = l.next;
      if (l === lF1) break;
    }
    if (firstLoopF1) {
      if (f.lFirst.prev === lF1) f2.lFirst = lF2.prev;
      else if (f.lFirst.next === lF1) f2.lFirst = lF2.next;
      else f2.lFirst = lF2;
    } else {
      f2.lFirst = f.lFirst;
      if (f.lFirst.prev === lF2) f.lFirst = lF1.prev;
      else if (f.lFirst.next === lF2) f.lFirst = lF1.next;
      else f.lFirst = lF1;
    }

    let n2 = 0;
    for (let l = f2.lFirst; ; ) {
      l.f = f2;
      n2++;
      l = l.next;
      if (l === f2.lFirst) break;
    }
    this.radialAppend(e, lF1);
    this.radialAppend(e, lF2);
    f2.len = n2;
    let n1 = 0;
    for (let l = f.lFirst; ; ) {
      n1++;
      l = l.next;
      if (l === f.lFirst) break;
    }
    f.len = n1;
    this.faces.add(f2);
    return { fNew: f2, lNew: lF2 };
  }

  /** `BM_face_split`: null when the loops are adjacent. */
  faceSplit(f: BMFace, lA: BMLoop, lB: BMLoop, noDouble: boolean): { fNew: BMFace; lNew: BMLoop } | null {
    if (this.loopIsAdjacent(lA, lB) || lA.f !== f || lB.f !== f) return null;
    return this.splitFaceMakeEdge(f, lA, lB, noDouble);
  }

  /**
   * `BM_face_split_n`: split from `lA` to `lB` with `n` vertices on the new edge, at `cos` — the first nearest
   * `lA`. Their data is read from the face as it was (`BM_loop_interp_from_face`): the corner of that face that
   * lies at the same place, the first in loop order (the mean-value weights of a point on a vertex).
   */
  faceSplitN(f: BMFace, lA: BMLoop, lB: BMLoop, cos: readonly Vec3[]): { fNew: BMFace; lNew: BMLoop } | null {
    const n = cos.length;
    if ((n === 0 && this.loopIsAdjacent(lA, lB)) || lA.f !== lB.f) return null;
    const before = this.faceLoops(f).map((l) => ({ co: l.v.co, src: l.src, origin: l.v.origin, v: l.v }));
    const vB = lB.v;
    const r = this.splitFaceMakeEdge(f, lA, lB, false);
    let e = r.lNew.e!;
    for (let i = 0; i < n; i++) {
      const { vNew, eNew } = this.splitEdgeMakeVert(vB, e);
      vNew.co = [cos[i]![0], cos[i]![1], cos[i]![2]];
      const at = before.find((b) => sameCo(b.co, vNew.co));
      for (const edge of [e, eNew]) {
        for (const l of this.loopsOfEdge(edge)) {
          if (l.v !== vNew) continue;
          if (at) l.src = at.src.map((s) => [...s] as unknown as CornerRef);
        }
      }
      if (at) vNew.origin = { ...(at.origin ?? { from: [this.idxOf(at.v)], w: [1] }), interp: true };
      e = eNew;
    }
    return r;
  }

  private idxOf(v: BMVert): number {
    return v.idx;
  }

  /**
   * `bmesh_kernel_join_edge_kill_vert(e_kill, v_kill, do_del, check_edge_exists = false, kill_degenerate_faces =
   * false, kill_duplicate_faces)`: `v_kill` has two edges; the other one is moved onto `e_kill`'s other end and
   * `e_kill` and `v_kill` removed.
   */
  joinEdgeKillVert(eKill: BMEdge, vKill: BMVert, killDuplicateFaces: boolean): BMEdge | null {
    if (vKill.disk.length !== 2) return null;
    const eOld = this.diskNext(eKill, vKill);
    const vTarget = this.otherVert(eKill, vKill);
    if ((eOld.v1 === vKill && eOld.v2 === vTarget) || (eOld.v2 === vKill && eOld.v1 === vTarget)) return null;

    this.diskVertReplace(eOld, vTarget, vKill);
    this.diskRemove(eKill, vTarget);
    const candidates: BMFace[] = [];
    if (eKill.l) {
      let lKill: BMLoop = eKill.l;
      const first = lKill;
      do {
        if (lKill.next.v === vKill) lKill.next.v = vTarget;
        lKill.next.prev = lKill.prev;
        lKill.prev.next = lKill.next;
        if (lKill.f.lFirst === lKill) lKill.f.lFirst = lKill.next;
        lKill.f.len--;
        if (killDuplicateFaces) candidates.push(lKill.f);
        const lNext = lKill.radialNext!;
        lKill = lNext;
      } while (lKill !== first);
    }
    this.edges.delete(eKill);
    vKill.disk = [];
    this.verts.delete(vKill);
    if (killDuplicateFaces)
      for (const f of candidates) {
        if (this.faces.has(f) && this.faceFindDouble(f)) this.faceKill(f);
      }
    return eOld;
  }
}

function originOf(v: BMVert): VertOrigin {
  return v.origin ?? { from: [v.idx], w: [1] };
}

function mixOrigin(a: VertOrigin, wa: number, b: VertOrigin, wb: number): VertOrigin {
  return { from: [...a.from, ...b.from], w: [...a.w.map((w) => w * wa), ...b.w.map((w) => w * wb)] };
}

function mixSrc(a: readonly CornerRef[], wa: number, b: readonly CornerRef[], wb: number): CornerRef[] {
  if (wb === 0) return a.map((s) => [...s] as unknown as CornerRef);
  if (wa === 0) return b.map((s) => [...s] as unknown as CornerRef);
  return [...a.map((s) => [s[0], s[1], s[2] * wa] as const), ...b.map((s) => [s[0], s[1], s[2] * wb] as const)];
}

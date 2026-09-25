/**
 * A small BMesh — the parts of Blender's `bmesh/intern` whose **order** decides
 * answers, ported so that operators built on it reproduce Blender's ties.
 *
 * Blender's BMesh is a set of cycles: the edges around a vertex (the disk
 * cycle, `v->e` plus each edge's two disk links), the loops around an edge
 * (the radial cycle, `e->l`), and the loops around a face. Every Euler
 * operator splices those cycles in a fixed way, and elements live in
 * `BLI_mempool`s that hand out the most recently freed slot first. Iteration
 * order — which an operator's heap sees as insertion order — follows from all
 * of it. This file reproduces:
 *
 * - `BM_edge_create` / `BM_face_create` / `BM_face_create_verts` /
 *   `BM_face_create_ngon`, and the kills (`BM_face_kill`, `BM_edge_kill`,
 *   `BM_vert_kill`) with the disk and radial bookkeeping they do;
 * - `BM_vert_splice`, `BM_edge_splice`, `bmesh_face_swap_data`;
 * - `BM_faces_join`, `bmesh_kernel_split_face_make_edge` (`BM_face_split`),
 *   `BM_edge_rotate`;
 * - `BM_face_triangulate`, and the `BM_LOOPS_OF_VERT` iterator;
 * - `BM_mesh_bm_from_me` from a `MeshData`, with the Mesh's edges in
 *   `mesh_calc_edges` order.
 *
 * Nothing here is public API; it is the substrate for `decimateCollapse` and
 * `bridgeLoops`.
 */
import type { MeshData } from "../lib/mesh";
import { f, sub, cross, normalizeInPlace, normalTri, normalQuad, newell, type V3 } from "./blender-math";
import { quadTriangles, ngonTriangles, type QuadMethod, type NgonMethod } from "./triangulate";

export interface DiskLink {
  next: BE | null;
  prev: BE | null;
}
export interface BV {
  co: V3;
  no: V3;
  e: BE | null;
  index: number;
  tag: boolean;
}
export interface BE {
  v1: BV;
  v2: BV;
  l: BL | null;
  d1: DiskLink;
  d2: DiskLink;
  index: number;
  slot: number;
  tag: boolean;
}
export interface BL {
  v: BV;
  e: BE | null;
  f: BF;
  next: BL;
  prev: BL;
  rn: BL | null;
  rp: BL | null;
  index: number;
  /**
   * Which input corner this loop's data is (`bmFromMesh` numbers them face
   * by face), or -1 for none — the stand-in for loop customdata, carried the
   * way BMesh copies it.
   */
  src: number;
}
export interface BF {
  first: BL | null;
  len: number;
  no: V3;
  index: number;
  tag: boolean;
  slot: number;
  /** Which input face this face's data (its material) is, or -1. */
  src: number;
}

/** A `BLI_mempool`: freed slots are reused last-freed first. */
export interface Pool<T> {
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

export interface BM {
  verts: (BV | null)[];
  edges: Pool<BE>;
  faces: Pool<BF>;
  totface: number;
}

export const liveEdges = (bm: BM): BE[] => bm.edges.items.filter((e): e is BE => !!e);
export const liveFaces = (bm: BM): BF[] => bm.faces.items.filter((x): x is BF => !!x);

export const link = (e: BE, v: BV): DiskLink => (v === e.v2 ? e.d2 : e.d1);
export const diskNext = (e: BE, v: BV): BE => link(e, v).next!;
export const vertInEdge = (e: BE, v: BV): boolean => e.v1 === v || e.v2 === v;
export const otherVert = (e: BE, v: BV): BV => (e.v1 === v ? e.v2 : e.v1);

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
export function radialAppend(e: BE, l: BL): void {
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
export function radialRemove(e: BE, l: BL): void {
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

/** The edges around `v`, starting at `v.e`. */
export function diskEdges(v: BV): BE[] {
  const out: BE[] = [];
  if (!v.e) return out;
  let e = v.e;
  do out.push(e);
  while ((e = diskNext(e, v)) !== v.e);
  return out;
}
/** The loops around `e`, starting at `e.l`. */
export function radialLoops(e: BE): BL[] {
  const out: BL[] = [];
  if (!e.l) return out;
  let l = e.l;
  do out.push(l);
  while ((l = l.rn!) !== e.l);
  return out;
}

/**
 * `BM_vert_create`: appended, so a new vertex comes after every one that was
 * there. The vertex array is not a mempool here — `vertKill` leaves a hole
 * that `bmToMesh` compacts — which is Blender's order as long as vertices are
 * created before any are killed, as every operator using this does.
 */
export function vertCreate(bm: BM, co: V3): BV {
  const v: BV = { co: [f(co[0]!), f(co[1]!), f(co[2]!)], no: [0, 0, 0], e: null, index: bm.verts.length, tag: false };
  bm.verts.push(v);
  return v;
}

export function edgeExists(a: BV, b: BV): BE | null {
  if (!a.e) return null;
  let e = a.e;
  do {
    if (otherVert(e, a) === b) return e;
  } while ((e = diskNext(e, a)) !== a.e);
  return null;
}
export function edgeCreate(bm: BM, v1: BV, v2: BV): BE {
  const e: BE = { v1, v2, l: null, d1: { next: null, prev: null }, d2: { next: null, prev: null }, index: -1, slot: -1, tag: false };
  poolAlloc(bm.edges, e);
  diskAppend(e, v1);
  diskAppend(e, v2);
  return e;
}
function newLoop(v: BV, face: BF, src = -1): BL {
  return { v, e: null, f: face, next: null!, prev: null!, rn: null, rp: null, index: -1, src };
}
function newFace(bm: BM, len: number, no: V3, tag: boolean): BF {
  const face: BF = { first: null, len, no: [...no], index: -1, tag, slot: -1, src: -1 };
  poolAlloc(bm.faces, face);
  bm.totface++;
  return face;
}
/** `BM_face_create`; `example` gives the normal, the tag and the data (`BM_elem_attrs_copy`). */
export function faceCreate(
  bm: BM,
  verts: BV[],
  edges: BE[],
  example: { no: V3; tag: boolean; src?: number } | null,
): BF {
  const face = newFace(bm, verts.length, example ? example.no : [0, 0, 0], example ? example.tag : false);
  face.src = example?.src ?? -1;
  const loops = verts.map((v) => newLoop(v, face));
  loops.forEach((l, i) => {
    radialAppend(edges[i]!, l);
    l.next = loops[(i + 1) % loops.length]!;
    l.prev = loops[(i - 1 + loops.length) % loops.length]!;
  });
  face.first = loops[0]!;
  return face;
}
/** `BM_face_create_verts` with `create_edges`: edges from (last, first) on. */
export function faceCreateVerts(bm: BM, verts: BV[], example: { no: V3; tag: boolean; src?: number } | null): BF {
  const n = verts.length;
  const edges: BE[] = new Array(n);
  for (let i = 0, iPrev = n - 1; i < n; iPrev = i++)
    edges[iPrev] = edgeExists(verts[iPrev]!, verts[i]!) ?? edgeCreate(bm, verts[iPrev]!, verts[i]!);
  return faceCreate(bm, verts, edges, example);
}
export function faceLoops(face: BF): BL[] {
  const out: BL[] = [];
  let l = face.first!;
  do out.push(l);
  while ((l = l.next) !== face.first);
  return out;
}
export function faceKill(bm: BM, face: BF): void {
  for (const l of faceLoops(face)) radialRemove(l.e!, l);
  face.first = null;
  bm.totface--;
  poolFree(bm.faces, face);
}
export function edgeKill(bm: BM, e: BE): void {
  while (e.l) faceKill(bm, e.l.f);
  diskRemove(e, e.v1);
  diskRemove(e, e.v2);
  poolFree(bm.edges, e);
}
export function vertKill(bm: BM, v: BV): void {
  while (v.e) edgeKill(bm, v.e);
  bm.verts[v.index] = null;
}
/** `bmesh_face_swap_data`: everything but the index moves. */
export function faceSwapData(a: BF, b: BF): void {
  for (const l of faceLoops(a)) l.f = b;
  for (const l of faceLoops(b)) l.f = a;
  [a.first, b.first] = [b.first, a.first];
  [a.len, b.len] = [b.len, a.len];
  [a.no, b.no] = [b.no, a.no];
  [a.tag, b.tag] = [b.tag, a.tag];
  [a.src, b.src] = [b.src, a.src];
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
export function vertSplice(bm: BM, dst: BV, src: BV): void {
  while (src.e) edgeVertSwap(src.e, dst, src);
  vertKill(bm, src);
}
export function edgeSplice(bm: BM, dst: BE, src: BE): void {
  while (src.l) {
    const l = src.l;
    radialRemove(src, l);
    radialAppend(dst, l);
  }
  edgeKill(bm, src);
}

export const isBoundary = (e: BE): boolean => !!e.l && e.l.rn === e.l;
export const isManifold = (e: BE): boolean => !!e.l && e.l.rn !== e.l && e.l.rn!.rn === e.l;
export function loopPair(e: BE): [BL, BL] | null {
  const la = e.l;
  if (!la) return null;
  const lb = la.rn!;
  if (la !== lb && lb.rn === la) return [la, lb];
  return null;
}

/** `BM_LOOPS_OF_VERT`, in its iterator's order. */
export function loopsOfVert(v: BV): BL[] {
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

/** `BM_face_calc_normal`: quads and triangles by their own formulas, n-gons by Newell. */
export function faceCalcNormal(face: BF): V3 {
  const co = faceLoops(face).map((l) => l.v.co);
  if (co.length === 4) return normalQuad(co[0]!, co[1]!, co[2]!, co[3]!);
  if (co.length === 3) return normalTri(co[0]!, co[1]!, co[2]!);
  const n = newell(co);
  normalizeInPlace(n);
  return n;
}

// ── queries used by the Euler operators ────────────────────────────────────

export function faceVertShareLoop(face: BF, v: BV): BL | null {
  for (const l of faceLoops(face)) if (l.v === v) return l;
  return null;
}
export function faceEdgeShareLoop(face: BF, e: BE): BL | null {
  for (const l of radialLoops(e)) if (l.f === face) return l;
  return null;
}
/** `BM_face_other_vert_loop`: the loop past `v` on the side away from `vPrev`. */
export function faceOtherVertLoop(face: BF, vPrev: BV, v: BV): BL | null {
  const l = faceVertShareLoop(face, v);
  if (!l) return null;
  if (l.prev.v === vPrev) return l.next;
  if (l.next.v === vPrev) return l.prev;
  return null;
}
export function edgeFacePair(e: BE): [BF, BF] | null {
  const p = loopPair(e);
  return p ? [p[0].f, p[1].f] : null;
}
/** `BM_face_exists`: a face over exactly these verts, in either winding. */
export function faceExists(varr: BV[]): BF | null {
  const v0 = varr[0]!;
  const len = varr.length;
  for (const e of diskEdges(v0))
    for (const l of radialLoops(e)) {
      if (l.v !== v0 || l.f.len !== len) continue;
      let i = 2;
      if (l.next.v === varr[1]) {
        let w = l.next.next;
        for (; i < len; i++, w = w.next) if (w.v !== varr[i]) break;
      } else if (l.prev.v === varr[1]) {
        let w = l.prev.prev;
        for (; i < len; i++, w = w.prev) if (w.v !== varr[i]) break;
      } else continue;
      if (i === len) return l.f;
    }
  return null;
}

/** `bm_edges_sort_winding` + `BM_face_create`: the n-gon bounded by `edges`, walked from v1 to v2. */
function faceCreateNgon(bm: BM, v1: BV, v2: BV, edges: BE[], example: BF): BF | null {
  const mf = new Set(edges);
  const mv = new Set<BV>();
  for (const e of edges) {
    mv.add(e.v1);
    mv.add(e.v2);
  }
  let vIter = v1;
  let eIter = v1.e!;
  let eFirst = eIter;
  let found = false;
  do {
    if (mf.has(eIter) && otherVert(eIter, vIter) === v2) {
      found = true;
      break;
    }
  } while ((eIter = diskNext(eIter, vIter)) !== eFirst);
  if (!found) return null;
  const edgesSort: BE[] = [];
  const vertsSort: BV[] = [];
  do {
    if (mf.has(eIter)) {
      if (!mv.has(vIter)) return null;
      mf.delete(eIter);
      edgesSort.push(eIter);
      mv.delete(vIter);
      vertsSort.push(vIter);
      vIter = otherVert(eIter, vIter);
      if (edgesSort.length === edges.length) {
        if (vIter !== vertsSort[0]) return null;
        break;
      }
      eFirst = eIter;
    }
  } while ((eIter = diskNext(eIter, vIter)) !== eFirst);
  if (edgesSort.length !== edges.length) return null;
  return faceCreate(bm, vertsSort, edgesSort, example);
}

/** `BM_faces_join`. */
export function facesJoin(bm: BM, faces: BF[], doDel: boolean): BF | null {
  if (faces.length === 1) return faces[0]!;
  const jf = new Set(faces);
  const eFlag = new Set<BE>();
  const vFlag = new Set<BV>();
  const edges: BE[] = [];
  const delEdges: BE[] = [];
  const delVerts: BV[] = [];
  let v1: BV | null = null;
  let v2: BV | null = null;
  const manifoldFlagged = (v: BV): boolean => {
    if (!v.e) return false;
    for (const e of diskEdges(v)) {
      if (!e.l || isBoundary(e)) return false;
      for (const l of radialLoops(e)) if (!jf.has(l.f)) return false;
    }
    return true;
  };
  for (const face of faces)
    for (const l of faceLoops(face)) {
      const rlen = radialLoops(l.e!).filter((x) => jf.has(x.f)).length;
      if (rlen > 2) return null;
      if (rlen === 1) {
        edges.push(l.e!);
        if (!v1) {
          v1 = l.v;
          v2 = otherVert(l.e!, l.v);
        }
      } else if (rlen === 2) {
        const e = l.e!;
        const d1 = manifoldFlagged(e.v1);
        const d2 = manifoldFlagged(e.v2);
        if (!d1 && !d2 && !eFlag.has(e)) {
          if (radialLoops(e).length <= 2) {
            if (doDel) delEdges.push(e);
            eFlag.add(e);
          }
        } else {
          if (d1 && !vFlag.has(e.v1)) {
            if (doDel) delVerts.push(e.v1);
            vFlag.add(e.v1);
          }
          if (d2 && !vFlag.has(e.v2)) {
            if (doDel) delVerts.push(e.v2);
            vFlag.add(e.v2);
          }
        }
      }
    }
  const fNew = edges.length ? faceCreateNgon(bm, v1!, v2!, edges, faces[0]!) : null;
  if (!fNew) return null;
  // Each new loop takes the data of the joined face's loop on its edge, at
  // its vertex (`BM_faces_join`, "copy over loop data").
  for (const l of faceLoops(fNew)) {
    let l2 = l.rn!;
    while (l2 !== l && !jf.has(l2.f)) l2 = l2.rn!;
    if (l2 !== l) l.src = (l2.v !== l.v ? l2.next : l2).src;
  }
  if (doDel) {
    for (const e of delEdges) edgeKill(bm, e);
    for (const v of delVerts) vertKill(bm, v);
  } else {
    for (const face of faces) faceKill(bm, face);
  }
  return fNew;
}

/** `bmesh_kernel_split_face_make_edge` (`BM_face_split`). Returns the new face. */
export function faceSplit(bm: BM, face: BF, lV1: BL, lV2: BL, noDouble: boolean): BF | null {
  if (lV1.next === lV2 || lV2.next === lV1 || lV1.f !== face || lV2.f !== face) return null;
  const v1 = lV1.v;
  const v2 = lV2.v;
  const e = (noDouble ? edgeExists(v1, v2) : null) ?? edgeCreate(bm, v1, v2);
  const f2 = newFace(bm, 0, face.no, face.tag);
  f2.src = face.src;
  const lF1 = newLoop(v2, face, lV2.src);
  const lF2 = newLoop(v1, f2, lV1.src);
  lF1.prev = lV2.prev;
  lF2.prev = lV1.prev;
  lV2.prev.next = lF1;
  lV1.prev.next = lF2;
  lF1.next = lV1;
  lF2.next = lV2;
  lV1.prev = lF1;
  lV2.prev = lF2;

  let firstInF1 = false;
  let l = lF1;
  do if (l === face.first) firstInF1 = true;
  while ((l = l.next) !== lF1);
  if (firstInF1) {
    if (face.first!.prev === lF1) f2.first = lF2.prev;
    else if (face.first!.next === lF1) f2.first = lF2.next;
    else f2.first = lF2;
  } else {
    f2.first = face.first;
    if (face.first!.prev === lF2) face.first = lF1.prev;
    else if (face.first!.next === lF2) face.first = lF1.next;
    else face.first = lF1;
  }
  let n2 = 0;
  l = f2.first!;
  do {
    l.f = f2;
    n2++;
  } while ((l = l.next) !== f2.first);
  radialAppend(e, lF1);
  radialAppend(e, lF2);
  f2.len = n2;
  let n1 = 0;
  l = face.first!;
  do n1++;
  while ((l = l.next) !== face.first);
  face.len = n1;
  return f2;
}

/** `BM_edge_rotate_check`. */
export function edgeRotateCheck(e: BE): boolean {
  const pair = edgeFacePair(e);
  if (!pair) return false;
  const [fa, fb] = pair;
  let la = faceOtherVertLoop(fa, e.v2, e.v1);
  let lb = faceOtherVertLoop(fb, e.v2, e.v1);
  if (!la || !lb || la.v === lb.v) return false;
  la = faceOtherVertLoop(fa, e.v1, e.v2);
  lb = faceOtherVertLoop(fb, e.v1, e.v2);
  if (!la || !lb || la.v === lb.v) return false;
  return true;
}

/** `BM_edge_rotate(bm, e, ccw = false, BM_EDGEROT_CHECK_EXISTS)`. */
export function edgeRotate(bm: BM, e: BE): BE | null {
  if (!edgeRotateCheck(e)) return null;
  // BM_edge_calc_rotate with ccw = false: the faces swap.
  let [fa, fb] = edgeFacePair(e)!;
  const ov1 = e.l!.v;
  const ov2 = e.l!.next.v;
  [fa, fb] = [fb, fa];
  const l1 = faceOtherVertLoop(fb, ov2, ov1)!;
  const l2 = faceOtherVertLoop(fa, ov1, ov2)!;
  const v1 = l1.v;
  const v2 = l2.v;
  if (edgeExists(v1, v2)) return null;
  const eNew = edgeCreate(bm, v1, v2);
  eNew.tag = e.tag;
  const tag1 = l1.f.tag;
  const tag2 = l2.f.tag;
  const la = faceEdgeShareLoop(l1.f, e)!;
  const lb = faceEdgeShareLoop(l2.f, e)!;
  const joined = facesJoin(bm, [la.f, lb.f], true);
  if (!joined) return null;
  const s1 = faceVertShareLoop(joined, v1);
  const s2 = faceVertShareLoop(joined, v2);
  if (!s1 || !s2 || !faceSplit(bm, joined, s1, s2, true)) return null;
  const pair = edgeFacePair(eNew);
  if (pair) {
    pair[0].tag = tag1;
    pair[1].tag = tag2;
  }
  return eNew;
}

/**
 * `BM_face_triangulate`. Returns the faces made (all but the last, which takes
 * over `face`'s slot) and the edges made. With `useTag`, those are tagged.
 */
export function faceTriangulate(
  bm: BM,
  face: BF,
  quadMethod: QuadMethod,
  ngonMethod: NgonMethod,
  useTag: boolean,
): { faces: BF[]; edges: BE[]; doubles: BF[] } {
  const loops = faceLoops(face);
  const co = loops.map((l) => l.v.co);
  const tris = face.len === 4 ? quadTriangles(co, quadMethod) : ngonTriangles(co, face.no, ngonMethod);
  const last = tris.length - 1;
  const faces: BF[] = [];
  const edges: BE[] = [];
  const doubles: BF[] = [];
  let fNew: BF | null = null;
  tris.forEach((t, i) => {
    fNew = faceCreateVerts(bm, t.map((k) => loops[k]!.v), face);
    {
      let li = fNew.first!;
      for (const k of t) {
        li.src = loops[k]!.src;
        li = li.next;
      }
    }
    const lNew = fNew.first!;
    if (lNew.rn !== lNew) {
      let li = lNew.rn!;
      do {
        if (li.f.len === 3 && lNew.prev.v === li.prev.v) {
          doubles.unshift(i !== last ? fNew : face);
          break;
        }
      } while ((li = li.rn!) !== lNew);
    }
    if (i !== last) {
      if (useTag) fNew.tag = true;
      faces.push(fNew);
    }
    for (const l of faceLoops(fNew))
      if (l === l.rn) {
        if (useTag) l.e!.tag = true;
        edges.push(l.e!);
      }
  });
  faceSwapData(face, fNew!);
  faceKill(bm, fNew!);
  return { faces, edges, doubles };
}

// ── Mesh ⇄ BMesh ───────────────────────────────────────────────────────────

/** `mesh_calc_edges`: (low, high) per face edge from (last, first), hashed by `low & mask`. */
export function calcEdges(polys: readonly (readonly number[])[], tables: number): [number, number][] {
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

/**
 * `BM_mesh_bm_from_me` on the Mesh `wm.obj_import` would have made of `data`:
 * vertices in order, edges in `mesh_calc_edges` order (`edgeTables` hash
 * tables above 1000 faces), faces with their normals computed.
 */
export function bmFromMesh(data: MeshData, opts: { edgeTables?: number; vertNormals?: V3[] } = {}): BM {
  const nv = data.positions.length / 3;
  const bm: BM = { verts: [], edges: { items: [], free: [] }, faces: { items: [], free: [] }, totface: 0 };
  for (let i = 0; i < nv; i++)
    bm.verts.push({
      co: [f(data.positions[i * 3]!), f(data.positions[i * 3 + 1]!), f(data.positions[i * 3 + 2]!)],
      no: opts.vertNormals?.[i] ?? [0, 0, 0],
      e: null,
      index: i,
      tag: false,
    });
  const polys = data.polys.filter((p) => p.length >= 3);
  const tables = polys.length < 1000 ? 1 : (opts.edgeTables ?? 8);
  const stride = 2 ** 26;
  const edgeOf = new Map<number, BE>();
  const pairs = calcEdges(polys, tables);
  const wires = (data.edges ?? []).map((e) => [Math.min(e[0]!, e[1]!), Math.max(e[0]!, e[1]!)] as [number, number]);
  for (const [a, b] of [...pairs, ...wires]) {
    if (edgeOf.has(a * stride + b) || a === b) continue;
    const e = edgeCreate(bm, bm.verts[a]!, bm.verts[b]!);
    e.index = edgeOf.size;
    edgeOf.set(a * stride + b, e);
  }
  const find = (a: number, b: number): BE => edgeOf.get(Math.min(a, b) * stride + Math.max(a, b))!;
  // Corners are numbered through the input's faces, the degenerate ones
  // (skipped here) included, so a number names an input face and corner.
  const cornerStart: number[] = [];
  let corners = 0;
  for (const p of data.polys) {
    cornerStart.push(corners);
    corners += p.length;
  }
  let i = 0;
  data.polys.forEach((p, src) => {
    if (p.length < 3) return;
    const face = faceCreate(
      bm,
      p.map((v) => bm.verts[v]!),
      p.map((v, k) => find(v, p[(k + 1) % p.length]!)),
      null,
    );
    face.index = i++;
    face.src = src;
    faceLoops(face).forEach((l, k) => (l.src = cornerStart[src]! + k));
    face.no = faceCalcNormal(face);
  });
  return bm;
}

/**
 * Where each face and corner of `bmToMesh(bm)` came from: an input face and
 * an input corner number (`bmFromMesh`'s), or -1 — and the per-corner and
 * per-face layers of `data` read through them. A corner with no source holds
 * the layer's default: 0, and white for a colour (`layerDefault_mloopcol`).
 */
export function bmLayers(
  bm: BM,
  data: MeshData,
): Pick<MeshData, "uvs" | "colors" | "normals" | "materials"> {
  const flat: [number, number][] = [];
  data.polys.forEach((p, f) => p.forEach((_, k) => flat.push([f, k])));
  const faces = liveFaces(bm);
  const out: Pick<MeshData, "uvs" | "colors" | "normals" | "materials"> = {};
  const layer = (src: number[][][] | undefined, blank: number): number[][][] | undefined => {
    if (!src || src.length !== data.polys.length) return undefined;
    const width = src.find((x) => x.length > 0)?.[0]?.length ?? 2;
    return faces.map((x) =>
      faceLoops(x).map((l) => {
        const at = l.src >= 0 ? flat[l.src] : undefined;
        return at ? [...src[at[0]]![at[1]]!] : new Array<number>(width).fill(blank);
      }),
    );
  };
  const uvs = layer(data.uvs, 0);
  if (uvs) out.uvs = uvs;
  const colors = layer(data.colors, 1);
  if (colors) out.colors = colors;
  const normals = layer(data.normals, 0);
  if (normals) out.normals = normals;
  if (data.materials && data.materials.length === data.polys.length)
    out.materials = faces.map((x) => (x.src >= 0 ? data.materials![x.src]! : 0));
  return out;
}

/** `BM_mesh_bm_to_me`: live vertices and faces in pool order, compacted. */
export function bmToMesh(bm: BM): MeshData {
  const remap = new Map<BV, number>();
  const positions: number[] = [];
  for (const v of bm.verts) {
    if (!v) continue;
    remap.set(v, positions.length / 3);
    positions.push(v.co[0]!, v.co[1]!, v.co[2]!);
  }
  const polys = liveFaces(bm).map((x) => faceLoops(x).map((l) => remap.get(l.v)!));
  const inFace = new Set<BE>();
  for (const x of liveFaces(bm)) for (const l of faceLoops(x)) inFace.add(l.e!);
  const wires = liveEdges(bm).filter((e) => !inFace.has(e));
  return {
    positions: Float32Array.from(positions),
    polys,
    ...(wires.length ? { edges: wires.map((e) => [remap.get(e.v1)!, remap.get(e.v2)!]) } : {}),
  };
}

/** `cross_tri_v3` — re-exported for callers that build on this module. */
export const crossTri = (a: V3, b: V3, c: V3): V3 => cross(sub(a, b), sub(b, c));

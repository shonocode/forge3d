/**
 * Blender's **Select Similar Region** (`mesh.select_similar_region`, compat-backlog C100): each region of selected faces
 * (faces linked by a vertex, `BM_mesh_calc_face_groups` with `BM_VERT`) is looked for elsewhere in the mesh by its topology,
 * and every region that matches is selected too.
 *
 * The matching is a port of `bmesh/tools/bmesh_region_match.cc` (Blender 5.1.1, GPL-2.0-or-later): pick a pivot edge deep
 * inside the region (`bm_face_region_pivot_edge_find`), then for every other edge of the mesh walk outwards from both edges in
 * lock-step, giving vertices and faces ids hashed from their already-walked neighbours (`UIDWalk`), and accept when the walk
 * from the other edge reaches as many faces as the region has. The hashes are XOR / multiply on 64-bit unsigned integers that
 * wrap — `BigInt` here, `asUintN(64)` after every product — and order independent, so the walk does not depend on the order
 * the mesh lists its elements; the edges are tried in `bm.edges` order (`bmFromMesh` has `mesh_calc_edges`'s), a matched
 * region claiming its edges before a later one can.
 *
 * Kept as Blender has it: `bm_vert_fasthash_create` copies the first pass's ids into every later pass, so its depth counts
 * once whatever it is.
 *
 * Not followed: a vertex of a face of five or more corners that no walked vertex neighbours gets a hash from memory
 * `BLI_ghash_ensure_p` leaves uninitialised (a pool entry's previous value); here it gets 0. Regions of triangles and quads
 * never reach it.
 */
import type { MeshData } from "../../lib/mesh";
import { diskEdges, faceLoops, liveEdges, liveFaces, loopsOfVert, otherVert, type BE, type BF, type BM, type BV } from "../bmesh-lite";
import { Selection, type MeshSelection, type SelectMode, type SelectionSeed } from "./select-topology";

const U = (x: bigint): bigint => BigInt.asUintN(64, x);
const S = (x: bigint): bigint => BigInt.asIntN(64, x);

/** The faces of `v`, each once (`BM_FACES_OF_VERT`). */
function facesOfVert(v: BV): BF[] {
  const out: BF[] = [];
  for (const l of loopsOfVert(v)) if (!out.includes(l.f)) out.push(l.f);
  return out;
}
const isWire = (e: BE): boolean => !e.l;

// ── UIDWalk ────────────────────────────────────────────────────────────────

interface FaceStepItem {
  uid: bigint;
  list: BF[];
}
interface FaceStep {
  faces: BF[];
  items: FaceStepItem[];
}
class UIDWalk {
  /** Head first, as `BLI_addhead` keeps them. */
  facesStep: FaceStep[] = [];
  vertsUid = new Map<BV, bigint>();
  facesUid = new Map<BF, bigint>();
  useFaceIsolate = false;
  pass = 1n;

  faceTest(f: BF): boolean {
    return this.useFaceIsolate ? f.tag : true;
  }

  vertUid(v: BV): bigint {
    let uid = U(this.pass * 1031n);
    let tot = 0n;
    for (const e of diskEdges(v)) {
      const other = this.vertsUid.get(otherVert(e, v));
      if (other !== undefined) {
        uid ^= U(other * 7n);
        tot += 1n;
      }
    }
    uid ^= U(tot * 43n);
    tot = 0n;
    for (const f of facesOfVert(v)) {
      const other = this.facesUid.get(f);
      if (other !== undefined) {
        uid ^= U(other * 13n);
        tot += 1n;
      }
    }
    uid ^= U(tot * 53n);
    return uid;
  }

  faceUid(f: BF): bigint {
    let uid = U(this.pass * BigInt(f.len) * 1013n);
    const loops = faceLoops(f);
    for (const l of loops) {
      const other = this.vertsUid.get(l.v);
      if (other !== undefined) uid ^= U(other * 11n);
    }
    for (const l of loops)
      for (let r = l.rn; r && r !== l; r = r.rn) {
        const other = this.facesUid.get(r.f);
        if (other !== undefined) uid ^= U(other * 17n);
      }
    return uid;
  }

  /** Every id recomputed from the old ones, written after (`bm_uidwalk_rehash`). */
  rehash(): void {
    const v = [...this.vertsUid.keys()].map((x) => [x, this.vertUid(x)] as const);
    for (const [x, u] of v) this.vertsUid.set(x, u);
    const fs = [...this.facesUid.keys()].map((x) => [x, this.faceUid(x)] as const);
    for (const [x, u] of fs) this.facesUid.set(x, u);
  }

  private rehashFaces(faces: readonly BF[]): void {
    const uids = faces.map((f) => this.faceUid(f));
    faces.forEach((f, i) => this.facesUid.set(f, uids[i]!));
  }

  private vertIsUidConnect(v: BV): boolean {
    return diskEdges(v).some((e) => this.vertsUid.has(otherVert(e, v)));
  }

  /** `bm_uidwalk_pass_add`. */
  passAdd(facesPass: readonly BF[]): void {
    this.rehashFaces(facesPass);
    const vertsPass = new Map<BV, bigint>();
    const stepNext = new Set<BF>();
    const fstep: FaceStep = { faces: [], items: [] };
    this.facesStep.unshift(fstep);
    for (const f of facesPass)
      for (const l of faceLoops(f)) {
        if (!this.vertsUid.has(l.v) && !vertsPass.has(l.v)) {
          // An unconnected vertex keeps the key with an unset value in Blender; 0 here (see the module note).
          vertsPass.set(l.v, this.vertIsUidConnect(l.v) ? this.vertUid(l.v) : 0n);
        }
        for (let r = l.rn; r && r !== l; r = r.rn)
          if (!this.facesUid.has(r.f) && !stepNext.has(r.f) && this.faceTest(r.f)) {
            stepNext.add(r.f);
            fstep.faces.unshift(r.f);
          }
      }
    for (const [v, u] of vertsPass) this.vertsUid.set(v, u);
    this.rehashFaces(facesPass);
    this.pass += 1n;
  }

  /** `bm_uidwalk_init_from_edge`: both ends the same id, then a pass per face size on the edge, smallest first. */
  initFromEdge(e: BE): number {
    const faces: BF[] = [];
    if (e.l) {
      let l = e.l;
      do {
        if (this.faceTest(l.f)) faces.push(l.f);
        l = l.rn!;
      } while (l !== e.l);
    }
    faces.sort((a, b) => a.len - b.len);
    this.vertsUid.set(e.v1, 100003n);
    this.vertsUid.set(e.v2, 100003n);
    let steps = 0;
    for (let i = 0; i < faces.length; ) {
      const len = faces[i]!.len;
      const pass: BF[] = [];
      do pass.unshift(faces[i++]!);
      while (i < faces.length && faces[i]!.len === len);
      this.passAdd(pass);
      steps += 1;
    }
    return steps;
  }

  /** `bm_uidwalk_facestep_begin`: the step's faces not yet walked, grouped by id, ascending. */
  facestepBegin(fstep: FaceStep): boolean {
    let ok = false;
    const byUid = new Map<bigint, FaceStepItem>();
    fstep.faces = fstep.faces.filter((f) => !this.facesUid.has(f));
    for (const f of fstep.faces) {
      ok = true;
      const uid = this.faceUid(f);
      let item = byUid.get(uid);
      if (!item) {
        item = { uid, list: [] };
        byUid.set(uid, item);
        fstep.items.unshift(item);
      }
      item.list.unshift(f);
    }
    fstep.items.sort((a, b) => (a.uid > b.uid ? 1 : a.uid < b.uid ? -1 : 0));
    return ok;
  }
}

/** `bm_mesh_region_match_pair`: the region found from `eDst`, or null. */
function matchPair(eSrc: BE, eDst: BE, facesLen: number): BF[] | null {
  const src = new UIDWalk();
  const dst = new UIDWalk();
  src.useFaceIsolate = true;
  if (src.initFromEdge(eSrc) !== dst.initFromEdge(eDst)) return null;

  let found = false;
  for (;;) {
    let ok = false;
    let i = 0;
    while (i < src.facesStep.length) {
      const fsSrc = src.facesStep[i]!;
      const fsDst = dst.facesStep[i]!;
      if (fsSrc.faces.length === 0) {
        src.facesStep.splice(i, 1);
        dst.facesStep.splice(i, 1);
        continue;
      }
      if (src.facestepBegin(fsSrc) && dst.facestepBegin(fsDst)) {
        let d = 0;
        for (let s = 0; s < fsSrc.items.length && d < fsDst.items.length; s++, d++) {
          const itSrc = fsSrc.items[s]!;
          while (d < fsDst.items.length && fsDst.items[d]!.uid < itSrc.uid) d++;
          const itDst = fsDst.items[d];
          if (!itDst || itSrc.uid !== itDst.uid || itSrc.list.length > itDst.list.length) {
            ok = false;
            break;
          }
          if (itSrc.list.length === itDst.list.length) {
            // New steps go to the head: count how many, so this walk goes on from where it was.
            const before = src.facesStep.length;
            src.passAdd(itSrc.list);
            dst.passAdd(itDst.list);
            i += src.facesStep.length - before;
            itSrc.list = [];
            itDst.list = [];
            ok = true;
          }
        }
      }
      fsSrc.items = [];
      fsDst.items = [];
      i++;
    }
    if (!ok) break;
    found = dst.facesUid.size === facesLen;
    if (found) break;
    src.rehash();
    dst.rehash();
  }
  return found ? [...dst.facesUid.keys()] : null;
}

/** `bm_face_array_visit`: tag the faces' edges and vertices (and the faces), counting the vertices newly tagged. */
function visit(faces: readonly BF[], visitFaces: boolean): number {
  let verts = 0;
  for (const f of faces) {
    for (const l of faceLoops(f)) {
      if (!l.v.tag) verts += 1;
      l.e!.tag = true;
      l.v.tag = true;
    }
    if (visitFaces) f.tag = true;
  }
  return verts;
}

// ── The pivot edge ─────────────────────────────────────────────────────────

function isRegionBoundary(e: BE): boolean {
  if (e.l && e.l.rn !== e.l) {
    let l = e.l;
    do {
      if (!l.f.tag) return true;
      l = l.rn!;
    } while (l !== e.l);
    return false;
  }
  return true;
}

function boundaryId(v: BV): bigint {
  let id = 103n;
  let tot = 0n;
  for (const l of loopsOfVert(v)) {
    const boundary = isRegionBoundary(l.e!) || isRegionBoundary(l.prev.e!);
    id = S(id ^ S(BigInt(l.f.len) * (boundary ? 7n : 13n)));
    tot += 1n;
  }
  id = S(id ^ S(tot * 131n));
  return id === 0n ? 1n : id < 0n ? -id : id;
}

const ID_MIN = -(2n ** 63n) + 1n;

function passId(gh: Map<BV, bigint>, v: BV): bigint {
  let tot = 0n;
  let sumLen = 0n;
  let sumId = 0n;
  for (const e of diskEdges(v)) {
    if (!e.tag) continue;
    const other = otherVert(e, v);
    if (!other.tag) continue;
    const otherId = gh.get(other) ?? 0n;
    if (otherId > 0n) {
      sumId = S(sumId + otherId);
      tot += 1n;
      let l = e.l!;
      do {
        if (l.f.tag) sumLen += BigInt(l.f.len);
        l = l.rn!;
      } while (l !== e.l);
    }
  }
  let id = S(tot * 23n);
  id = S(id ^ S(sumLen * 31n));
  id = S(id ^ sumId);
  id = id === 0n ? 1n : id < ID_MIN ? ID_MIN : id;
  return id < 0n ? -id : id;
}

function useBest(gh: Map<BV, bigint>, e: BE, best: { e: BE | null; id: [bigint, bigint] }): void {
  let a = gh.get(e.v1) ?? 0n;
  let b = gh.get(e.v2) ?? 0n;
  if (a > b) [a, b] = [b, a];
  if (!best.e || (best.id[0] !== a ? best.id[0] < a : best.id[1] < b)) {
    best.id = [a, b];
    best.e = e;
  }
}

/**
 * `bm_face_region_pivot_edge_find`: ids from the region's boundary inwards, one ring a pass, and the edge between the last
 * ring's vertices with the largest pair of ids (or from the last ring to the one before). The vertex lists are link-stacks:
 * pushed at the head, read from the head.
 */
function pivotEdgeFind(faces: readonly BF[], vertsLen: number): { e: BE | null; depth: number } {
  const gh = new Map<BV, bigint>();
  let prev: BV[] = []; // head first
  let next: BV[] = [];
  let fallback: BE | null = null;
  let pass = 0;
  let used = 0;

  for (const f of faces)
    for (const l of faceLoops(f)) {
      const e = l.e!;
      if (isRegionBoundary(e)) {
        for (const v of [e.v1, e.v2])
          if (!gh.has(v)) {
            gh.set(v, boundaryId(v));
            prev.unshift(v);
            used += 1;
          }
      } else fallback = e;
    }

  while (prev.length) {
    while (prev.length) {
      const v = prev.shift()!;
      for (const e of diskEdges(v)) {
        if (!e.tag) continue;
        const other = otherVert(e, v);
        if (other.tag && !gh.has(other)) {
          // Negative, so this pass does not read it.
          gh.set(other, -passId(gh, other));
          next.unshift(other);
          used += 1;
        }
      }
    }
    for (const v of next) gh.set(v, -gh.get(v)!);
    [prev, next] = [next, prev];
    pass += 1;
    if (used === vertsLen) break;
  }

  let pivot: BE | null = null;
  if (prev.length >= 2) {
    const best = { e: null as BE | null, id: [0n, 0n] as [bigint, bigint] };
    for (const v of prev) v.tag = false;
    for (const v of prev) {
      v.tag = true;
      for (const e of diskEdges(v)) if (e.tag && !otherVert(e, v).tag) useBest(gh, e, best);
    }
    pivot = best.e;
  }
  if (!pivot && prev.length) {
    const best = { e: null as BE | null, id: [0n, 0n] as [bigint, bigint] };
    pass -= 1;
    for (const v of prev) for (const e of diskEdges(v)) if (e.tag && otherVert(e, v).tag) useBest(gh, e, best);
    pivot = best.e;
  }
  if (!pivot) {
    pivot = fallback;
    pass = 0;
  }
  return { e: pivot, depth: pass };
}

// ── Fast match ─────────────────────────────────────────────────────────────

function fasthash(bm: BM, depth: number): bigint[] {
  const verts = bm.verts;
  const prev = verts.map((v) => {
    if (!v) return 0n;
    let eNum = 0n;
    let fNum = 0n;
    let lNum = 0n;
    for (const e of diskEdges(v)) {
      if (isWire(e)) continue;
      eNum += 1n;
      let l = e.l!;
      do {
        fNum += 1n;
        lNum += BigInt(l.f.len);
        l = l.rn!;
      } while (l !== e.l);
    }
    return U(U(eNum * 7n) ^ U(U(fNum * 31n) * U(lNum * 61n)));
  });
  let curr = prev.slice();
  for (let pass = 0; pass < depth; pass++) {
    // Blender copies `id_prev` (never updated) each pass: the depth counts once.
    curr = prev.slice();
    for (const e of liveEdges(bm)) {
      if (isWire(e)) continue;
      curr[e.v1.index] = U(curr[e.v1.index]! + prev[e.v2.index]!);
      curr[e.v2.index] = U(curr[e.v2.index]! + prev[e.v1.index]!);
    }
  }
  return curr;
}

function fasthashEdgeMatch(fm: bigint[], a: BE, b: BE): boolean {
  let a0 = fm[a.v1.index]!;
  let a1 = fm[a.v2.index]!;
  if (a0 > a1) [a0, a1] = [a1, a0];
  let b0 = fm[b.v1.index]!;
  let b1 = fm[b.v2.index]!;
  if (b0 > b1) [b0, b1] = [b1, b0];
  return a0 === b0 && a1 === b1;
}

/** `BM_mesh_region_match`: the regions elsewhere in `bm` with the topology of `region` (the region itself not among them). */
export function regionMatch(bm: BM, region: readonly BF[]): BF[][] {
  for (const v of bm.verts) if (v) v.tag = false;
  for (const e of bm.edges.items) if (e) e.tag = false;
  for (const f of bm.faces.items) if (f) f.tag = false;
  const vertsLen = visit(region, true);
  const { e: eSrc, depth } = pivotEdgeFind(region, vertsLen);
  if (!eSrc) return [];
  const fm = depth > 0 ? fasthash(bm, depth) : null;
  const out: BF[][] = [];
  for (const eDst of liveEdges(bm)) {
    if (eDst.tag || isWire(eDst)) continue;
    if (fm && !fasthashEdgeMatch(fm, eSrc, eDst)) continue;
    const found = matchPair(eSrc, eDst, region.length);
    if (found) {
      visit(found, false);
      out.push(found);
    }
  }
  return out;
}

/**
 * `mesh.select_similar_region` — select the regions with the topology of each selected region of faces. Needs two or more
 * selected faces (Blender: "No face regions selected"); a region with no match adds nothing. The selection is not flushed:
 * the faces it adds bring their edges and vertices.
 */
export function selectSimilarRegion(mesh: MeshData, mode: SelectMode, seed: SelectionSeed): MeshSelection {
  const sel = new Selection(mesh, seed, mode);
  if (sel.sf.size < 2) throw new Error("selectSimilarRegion: no face regions selected (two or more faces are needed)");
  // `BM_mesh_calc_face_groups(BM_ELEM_SELECT, BM_VERT)`: the selected faces linked through a shared vertex.
  const selected = liveFaces(sel.bm).filter((f) => sel.sf.has(f));
  const seen = new Set<BF>();
  const groups: BF[][] = [];
  for (const start of selected) {
    if (seen.has(start)) continue;
    const group: BF[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const f = stack.pop()!;
      group.push(f);
      for (const l of faceLoops(f))
        for (const g of facesOfVert(l.v))
          if (sel.sf.has(g) && !seen.has(g)) {
            seen.add(g);
            stack.push(g);
          }
    }
    groups.push(group);
  }
  for (const group of groups) for (const region of regionMatch(sel.bm, group)) for (const f of region) sel.face(f);
  return sel.result();
}

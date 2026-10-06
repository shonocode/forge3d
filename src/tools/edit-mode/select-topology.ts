/**
 * Selections Blender's editor makes from the mesh's topology (`editmesh_select.cc`, compat-backlog C82): Select Non-Manifold, Select
 * Loose, Select Boundary Loop (region to loop), Select Loop Inner-Region (loop to region), Select Interior Faces and Select Linked.
 *
 * Each takes a mesh (`MeshData`: wire edges count), the select mode the editor is in, the selection it starts from, and returns the
 * selection that is left — vertices, edges (as vertex pairs) and faces (as indices into `polys`). The mode matters: Blender keeps
 * element flags for all three kinds and a *flush* after each operator derives some of them from the others (in vertex mode a face is
 * selected when all its vertices are, in edge mode when all its edges are), so "which faces are selected" depends on it.
 *
 * Built on `bmesh-lite`, because the answers are read off BMesh's cycles (`BM_vert_is_manifold` walks a vertex's face fan).
 */
import type { MeshData } from "../../lib/mesh";
import { f as f32, sub, dot, heapInsert, heapPopMin, heapRemove, heapUpdate, FLT_MAX, type Heap, type HeapNode } from "../blender-math";
import { angleNormalized } from "./join-order";
import { crtQsort } from "./triangle-fill";
import {
  bmFromMesh,
  diskNext,
  edgeExists,
  faceLoops,
  isBoundary,
  isManifold,
  loopsOfVert,
  diskEdges,
  liveEdges,
  liveFaces,
  radialLoops,
  type BE,
  type BF,
  type BL,
  type BM,
  type BV,
} from "../bmesh-lite";

export type SelectMode = "vertex" | "edge" | "face";

/** A selection: vertex indices, edges as vertex pairs, faces as indices into the mesh's `polys`. All sorted. */
export interface MeshSelection {
  verts: number[];
  edges: [number, number][];
  faces: number[];
}

/** The selection an operator starts from; any kind may be left out. */
export type SelectionSeed = Partial<MeshSelection>;

/** The element flags of an edit mesh, and Blender's `BM_*_select_set` / flush on them. */
class Selection {
  readonly bm: BM;
  sv = new Set<BV>();
  se = new Set<BE>();
  sf = new Set<BF>();
  readonly faceId = new Map<BF, number>();

  /** The seed is selected the way the editor would have it — in `mode`, a face whose vertices are all selected is selected too. */
  constructor(data: MeshData, seed: SelectionSeed, mode: SelectMode) {
    this.bm = bmFromMesh(data);
    for (const f of liveFaces(this.bm)) this.faceId.set(f, f.src);
    for (const v of seed.verts ?? []) this.sv.add(this.bm.verts[v]!);
    for (const [a, b] of seed.edges ?? []) {
      const e = edgeExists(this.bm.verts[a]!, this.bm.verts[b]!);
      if (e) this.edge(e);
    }
    const bySrc = new Map(liveFaces(this.bm).map((f) => [f.src, f] as const));
    for (const f of seed.faces ?? []) {
      const face = bySrc.get(f);
      if (face) this.face(face);
    }
    this.flush(mode);
  }

  /** `BM_vert_select_set(v, true)`. */
  vert(v: BV): void {
    this.sv.add(v);
  }
  /** `BM_edge_select_set(e, true)`: the edge and both its vertices. */
  edge(e: BE): void {
    this.se.add(e);
    this.sv.add(e.v1);
    this.sv.add(e.v2);
  }
  /** `BM_face_select_set(f, true)`: the face, its edges and its vertices. */
  face(f: BF): void {
    this.sf.add(f);
    for (const l of faceLoops(f)) {
      this.sv.add(l.v);
      this.se.add(l.e!);
    }
  }
  /** `EDBM_flag_disable_all(em, BM_ELEM_SELECT)`. */
  clear(): void {
    this.sv.clear();
    this.se.clear();
    this.sf.clear();
  }

  /** `BM_mesh_select_mode_flush`: what the mode derives from the elements it is made of. */
  flush(mode: SelectMode): void {
    if (mode === "vertex") {
      this.se = new Set(liveEdges(this.bm).filter((e) => this.sv.has(e.v1) && this.sv.has(e.v2)));
      this.sf = new Set(liveFaces(this.bm).filter((f) => faceLoops(f).every((l) => this.sv.has(l.v))));
    } else if (mode === "edge") {
      this.sf = new Set(liveFaces(this.bm).filter((f) => faceLoops(f).every((l) => this.se.has(l.e!))));
    }
  }

  /** `EDBM_selectmode_set` going to edge mode: the vertices follow the selected edges, then the faces follow the edges. */
  toEdgeMode(): void {
    this.sv = new Set();
    for (const e of this.se) {
      this.sv.add(e.v1);
      this.sv.add(e.v2);
    }
    this.flush("edge");
  }

  result(): MeshSelection {
    return {
      verts: [...this.sv].map((v) => v.index).sort((a, b) => a - b),
      edges: [...this.se]
        .map((e) => (e.v1.index < e.v2.index ? [e.v1.index, e.v2.index] : [e.v2.index, e.v1.index]) as [number, number])
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]),
      faces: [...this.sf].map((f) => this.faceId.get(f)!).sort((a, b) => a - b),
    };
  }
}

/** `BM_edge_other_loop`. */
function edgeOtherLoop(e: BE, l: BL): BL {
  let other = (l.e === e ? l : l.prev).rn!;
  if (other.v === l.v) return other;
  if (other.next.v === l.v) other = other.next;
  return other;
}

/** `BM_vert_step_fan_loop`: the next loop round the vertex (and `step.e` moves on), or null when the walk reaches a boundary. */
function stepFanLoop(l: BL, step: { e: BE }): BL | null {
  const ePrev = step.e;
  let eNext: BE;
  if (l.e === ePrev) eNext = l.prev.e!;
  else if (l.prev.e === ePrev) eNext = l.e!;
  else return null;
  if (isManifold(eNext)) {
    step.e = eNext;
    return edgeOtherLoop(eNext, l);
  }
  return null;
}

/** `BM_vert_is_manifold`: a vertex whose edges have one or two faces and whose faces form one fan. */
export function vertIsManifold(v: BV): boolean {
  if (!v.e) return false; // loose
  const eFirst = v.e;
  let eIter = eFirst;
  let lFirst: BL | null = eIter.l;
  let loopNum = 0;
  let boundaryNum = 0;
  do {
    // A loose edge, or one with more than two faces.
    if (!eIter.l || eIter.l !== eIter.l.rn!.rn) return false;
    if (eIter.l.v === v) loopNum++;
    if (!isBoundary(eIter)) {
      if (eIter.l.rn!.v === v) loopNum++;
    } else {
      lFirst = eIter.l;
      boundaryNum++;
      if (boundaryNum === 3) return false;
    }
    eIter = diskNext(eIter, v);
  } while (eIter !== eFirst);

  const step = { e: lFirst!.e! };
  const start = lFirst!.v === v ? lFirst! : lFirst!.next;
  let region = 0;
  let l: BL | null = start;
  do region++;
  while ((l = stepFanLoop(l, step)) !== start && l !== null);
  return loopNum === region;
}

export interface SelectNonManifoldOptions {
  /** Keep what is selected (default true, Blender's). Off clears the selection first. */
  extend?: boolean;
  /** Wire edges (default true). */
  useWire?: boolean;
  /** Boundary edges, one face (default true). */
  useBoundary?: boolean;
  /** Edges with more than two faces (default true). */
  useMultiFace?: boolean;
  /** Edges between two faces that run it the same way (default true). */
  useNonContiguous?: boolean;
  /** Vertices that are not manifold (default true). */
  useVerts?: boolean;
}

/**
 * Blender's Select ▸ Select All by Trait ▸ Non Manifold (`mesh.select_non_manifold`; vertex or edge mode only).
 *
 * The edges picked are the wire edges, the boundary edges, the ones with three or more faces and the ones whose two faces run them the same way;
 * the vertices are those `BM_vert_is_manifold` refuses (isolated, or where fans meet). Each picked element is selected the way the editor
 * does — an edge with its two vertices — and the mode's flush follows.
 */
export function selectNonManifold(
  mesh: MeshData,
  mode: "vertex" | "edge",
  seed: SelectionSeed = {},
  options: SelectNonManifoldOptions = {},
): MeshSelection {
  const sel = new Selection(mesh, seed, mode);
  if (!(options.extend ?? true)) sel.clear();
  const useWire = options.useWire ?? true;
  const useBoundary = options.useBoundary ?? true;
  const useMulti = options.useMultiFace ?? true;
  const useNonContiguous = options.useNonContiguous ?? true;
  if (options.useVerts ?? true) for (const v of sel.bm.verts) if (v && !vertIsManifold(v)) sel.vert(v);
  if (useWire || useBoundary || useMulti || useNonContiguous) {
    for (const e of liveEdges(sel.bm)) {
      const faces = radialLoops(e).length;
      const wire = faces === 0;
      const boundary = faces === 1;
      // `BM_edge_is_manifold && !BM_edge_is_contiguous`: two faces that both run the edge from the same end.
      const nonContiguous = faces === 2 && e.l!.v === e.l!.rn!.v;
      if ((useWire && wire) || (useBoundary && boundary) || (useNonContiguous && nonContiguous) || (useMulti && faces > 2)) sel.edge(e);
    }
  }
  sel.flush(mode);
  return sel.result();
}

/**
 * Blender's Select ▸ Select All by Trait ▸ Loose Geometry (`mesh.select_loose`): what is picked depends on the mode — vertices with no edge,
 * wire edges, or faces all of whose edges are boundaries (a face with no neighbour).
 */
export function selectLoose(mesh: MeshData, mode: SelectMode, seed: SelectionSeed = {}, options: { extend?: boolean } = {}): MeshSelection {
  const sel = new Selection(mesh, seed, mode);
  if (!(options.extend ?? false)) sel.clear();
  if (mode === "vertex") for (const v of sel.bm.verts) if (v && !v.e) sel.vert(v);
  if (mode === "edge") for (const e of liveEdges(sel.bm)) if (!e.l) sel.edge(e);
  if (mode === "face")
    for (const f of liveFaces(sel.bm)) if (faceLoops(f).every((l) => isBoundary(l.e!))) sel.face(f);
  sel.flush(mode);
  return sel.result();
}

/**
 * Blender's Select ▸ Select Loops ▸ Select Boundary Loop (`mesh.region_to_loop`): the edges round the selected faces — an edge with some of
 * its faces selected and some not, or its one face selected. Nothing happens with no face selected. The faces are deselected and the edges
 * selected; in face mode the editor then moves to edge mode, which re-derives the vertices and faces from the edges.
 * Returns the selection and the mode it ends in.
 */
export function regionToLoop(mesh: MeshData, mode: SelectMode, seed: SelectionSeed): MeshSelection & { mode: SelectMode } {
  const sel = new Selection(mesh, seed, mode);
  if (sel.sf.size === 0) return { ...sel.result(), mode };
  const tagged = new Set<BE>();
  for (const f of liveFaces(sel.bm))
    for (const l of faceLoops(f)) {
      const around = radialLoops(l.e!);
      const total = around.length;
      const selected = around.filter((x) => sel.sf.has(x.f)).length;
      if ((total !== selected && selected > 0) || (selected === 1 && total === 1)) tagged.add(l.e!);
    }
  sel.clear();
  for (const e of liveEdges(sel.bm)) if (tagged.has(e)) sel.edge(e);
  let out = mode;
  if (tagged.size > 0 && mode === "face") {
    sel.toEdgeMode();
    out = "edge";
  }
  return { ...sel.result(), mode: out };
}

// Placeholders until the next commits fill them in.
export function loopToRegion(
  mesh: MeshData,
  mode: SelectMode,
  seed: SelectionSeed,
  options: { selectBigger?: boolean } = {},
): MeshSelection {
  const selectBigger = options.selectBigger ?? false;
  const sel = new Selection(mesh, seed, mode);
  if (sel.se.size === 0) return sel.result();
  const bm = sel.bm;
  const faces = liveFaces(bm);
  let tagged = new Set<BF>();

  /** `loop_find_region`: the faces reachable from `l.f` without crossing a selected edge, not stepping onto a tagged face. */
  const findRegion = (l: BL, visit: Set<BF>): BF[] => {
    const stack = [l.f];
    visit.add(l.f);
    const region: BF[] = [];
    while (stack.length > 0) {
      const face = stack.pop()!;
      region.push(face);
      for (const l1 of faceLoops(face)) {
        if (sel.se.has(l1.e!)) continue;
        for (const l2 of radialLoops(l1.e!)) {
          if (tagged.has(l2.f)) continue;
          if (!visit.has(l2.f)) {
            visit.add(l2.f);
            stack.push(l2.f);
          }
        }
      }
    }
    return region;
  };

  /** `loop_find_regions`: the selected edges, most faces on them first, each tagging the best region (smaller, or bigger) beside it. */
  const findRegions = (bigger: boolean): number => {
    const edges = liveEdges(bm).filter((e) => sel.se.has(e));
    const edgeTag = new Set<BE>(edges);
    // `verg_radial` through the C runtime's `qsort`, which is not stable.
    crtQsort(edges, (x, y) => {
      const a = radialLoops(x).length;
      const b = radialLoops(y).length;
      return a > b ? -1 : a < b ? 1 : 0;
    });
    const visit = new Set<BF>();
    let count = 0;
    for (const e of edges) {
      if (!edgeTag.has(e)) continue;
      let best: BF[] | null = null;
      let tot = 0;
      for (const l of radialLoops(e)) {
        if (visit.has(l.f)) continue;
        const region = findRegion(l, visit);
        const c = region.length;
        if (!best || (bigger ? c >= tot : c < tot)) {
          tot = c;
          best = region;
        }
      }
      if (best) {
        for (const face of best) {
          tagged.add(face);
          for (const l of faceLoops(face)) edgeTag.delete(l.e!);
        }
        count += tot;
      }
    }
    return count;
  };

  const a = findRegions(selectBigger);
  const b = findRegions(!selectBigger);
  tagged = new Set();
  findRegions(a <= b !== selectBigger ? selectBigger : !selectBigger);

  // Unlike most operators this always deselects everything first.
  sel.clear();
  for (const face of faces) if (tagged.has(face)) sel.face(face);
  sel.flush(mode);
  return sel.result();
}

/**
 * Blender's Select ▸ Select All by Trait ▸ Interior Faces (`mesh.select_interior_faces`): the faces inside a mesh made of several shells that
 * share edges — the wall between two boxes. Face groups are cut apart at the edges with more than two faces; each group is priced by how far its
 * folds are from flat per area, and the cheapest is taken first, after which groups no longer separated by such an edge merge and are priced
 * again. Selects (a face with its edges and vertices) and adds to what was selected; nothing happens when no edge has three faces.
 * Float32 and the heap's order, as the C.
 */
export function selectInteriorFaces(mesh: MeshData, mode: SelectMode, seed: SelectionSeed = {}): MeshSelection {
  void mode;
  const sel = new Selection(mesh, seed, mode);
  const bm = sel.bm;
  const edges = liveEdges(bm);
  /** `BM_ELEM_TAG` on edges: the ones with more than two faces. */
  const tag = new Set<BE>();
  const edgeLength = new Map<BE, number>();
  for (const e of edges) {
    if (radialLoops(e).length > 2) {
      tag.add(e);
      const d = sub(e.v1.co, e.v2.co);
      edgeLength.set(e, f32(Math.sqrt(dot(d, d))));
    }
  }
  if (tag.size === 0) return sel.result();

  // `BM_mesh_calc_face_groups`: faces joined across edges that are not tagged, a group at a time, each walked from its lowest face with a stack.
  const faces = liveFaces(bm);
  const visited = new Set<BF>();
  const groups: BF[][] = [];
  for (const seedFace of faces) {
    if (visited.has(seedFace)) continue;
    visited.add(seedFace);
    const stack = [seedFace];
    const group: BF[] = [];
    for (let fc = stack.pop(); fc; fc = stack.pop()) {
      group.push(fc);
      for (const l of faceLoops(fc)) {
        if (l.rn === l || tag.has(l.e!)) continue;
        let o = l.rn!;
        do {
          if (!visited.has(o.f)) {
            visited.add(o.f);
            stack.push(o.f);
          }
        } while ((o = o.rn!) !== l);
      }
    }
    groups.push(group);
  }

  const groupOf = new Map<BF, number>();
  const list: Array<Array<{ face: BF; area: number }>> = groups.map((g, i) =>
    g.map((face) => {
      groupOf.set(face, i);
      return { face, area: faceArea(face) };
    }),
  );
  const idxOf = (face: BF): number => groupOf.get(face) ?? -1;
  const DEG90 = f32(90 * f32(Math.PI / 180));
  const DEG180 = f32(180 * f32(Math.PI / 180));

  /** `bm_interior_face_group_calc_cost`: how thin the group's tagged edges are folded, per area; FLT_MAX when it has none. */
  const cost = (i: number): number => {
    let area = 0;
    let total = 0;
    let found = false;
    for (const link of list[i]!) {
      area = f32(area + link.area);
      const fi = idxOf(link.face);
      for (const l of faceLoops(link.face)) {
        if (!tag.has(l.e!)) continue;
        let test = 0;
        let count = 0;
        let o = l;
        do {
          const other = idxOf(o.f);
          if (other !== -1 && other !== fi) {
            let angle = angleNormalized(link.face.no, o.f.no);
            if (angle > DEG90) angle = f32(DEG180 - angle);
            test = f32(test + f32(edgeLength.get(l.e!)! * angle));
            count++;
          }
        } while ((o = o.rn!) !== l);
        if (count >= 2) {
          total = f32(total + test);
          found = true;
        }
      }
    }
    return found ? f32(total / area) : FLT_MAX;
  };

  const heap: Heap<number> = { tree: [] };
  const table: Array<HeapNode<number> | null> = groups.map((_, i) => {
    const c = cost(i);
    return c !== FLT_MAX ? heapInsert(heap, -c, i) : null;
  });
  const dirty = groups.map(() => false);
  const recalc: number[] = [];

  /** `bm_interior_edge_is_manifold_except_face_index`: the edge has exactly two faces outside group `i`; returns them. */
  const pairExcept = (e: BE, i: number): [BL, BL] | null => {
    const pair: BL[] = [];
    for (const l of radialLoops(e)) {
      const k = idxOf(l.f);
      if (k !== -1 && k !== i) {
        if (pair.length === 2) return null;
        pair.push(l);
      }
    }
    return pair.length === 2 ? [pair[0]!, pair[1]!] : null;
  };

  for (;;) {
    // A group whose cost went stale is re-priced when it reaches the top (`USE_DELAY_FACE_GROUP_COST_CALC`).
    while (heap.tree.length > 0) {
      const top = heap.tree[0]!;
      const i = top.ptr;
      if (!dirty[i]) break;
      const c = cost(i);
      if (c !== FLT_MAX) heapUpdate(heap, top, -c, i);
      else {
        heapRemove(heap, table[i]!);
        table[i] = null;
      }
      dirty[i] = false;
    }
    if (heap.tree.length === 0) break;
    const iMin = heapPopMin(heap);
    table[iMin] = null;
    for (let link = list[iMin]!.shift(); link; link = list[iMin]!.shift()) {
      const face = link.face;
      sel.face(face);
      groupOf.delete(face);
      for (const l of faceLoops(face)) {
        const pair = pairExcept(l.e!, iMin);
        if (pair) {
          tag.delete(l.e!);
          let ia = idxOf(pair[0].f);
          let ib = idxOf(pair[1].f);
          if (ia !== ib) {
            if (ia > ib) [ia, ib] = [ib, ia];
            for (const n of list[ib]!) groupOf.set(n.face, ia);
            list[ia]!.push(...list[ib]!);
            list[ib] = [];
            if (table[ib]) heapRemove(heap, table[ib]!);
            table[ib] = null;
            if (!dirty[ia]) {
              recalc.push(ia);
              dirty[ia] = true;
            }
          }
        }
        // Every group touching this edge is stale now.
        if (l.rn !== l) {
          let o = l.rn!;
          do {
            const other = idxOf(o.f);
            if (other !== -1 && other !== iMin && table[other] && !dirty[other]) dirty[other] = true;
          } while ((o = o.rn!) !== l);
        }
      }
    }
    for (const i of recalc) {
      if (table[i] && dirty[i]) {
        const c = cost(i);
        if (c !== FLT_MAX) heapUpdate(heap, table[i]!, -c, i);
        else {
          heapRemove(heap, table[i]!);
          table[i] = null;
        }
      }
      dirty[i] = false;
    }
    recalc.length = 0;
  }
  return sel.result();
}

/** `BM_face_calc_area`: Newell's sum, half its length, in float32. */
function faceArea(face: BF): number {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (const l of faceLoops(face)) {
    const a = l.v.co;
    const b = l.next.v.co;
    nx = f32(nx + f32(f32(a[1]! - b[1]!) * f32(a[2]! + b[2]!)));
    ny = f32(ny + f32(f32(a[2]! - b[2]!) * f32(a[0]! + b[0]!)));
    nz = f32(nz + f32(f32(a[0]! - b[0]!) * f32(a[1]! + b[1]!)));
  }
  return f32(f32(Math.sqrt(f32(f32(f32(nx * nx) + f32(ny * ny)) + f32(nz * nz)))) * f32(0.5));
}

export type LinkedDelimit = "seam" | "sharp" | "normal" | "material";

/**
 * Blender's Select ▸ Select Linked ▸ Linked (`mesh.select_linked`, the L key without a mouse): everything connected to the selection.
 *
 * What counts as connected is the mode's: in vertex or edge mode the selection grows over **edges** (a vertex shell), or with `delimit` over
 * the **corners** of faces joined across edges the delimiters allow, plus the wire edges at them; in face mode over faces joined across edges.
 * `delimit` names what stops it — a seam (`mesh.seams`), a sharp edge (`mesh.sharp`), an edge whose two faces run it the same way
 * (`normal`), a material change (`mesh.materials`). UV is not offered: with no UV layer Blender drops it. Vertex and edge mode flush after.
 * With a delimiter, a selected vertex on an edge that delimits a selected face is not a starting point (the selection stops at it).
 */
export function selectLinked(
  mesh: MeshData,
  mode: SelectMode,
  seed: SelectionSeed,
  options: { delimit?: readonly LinkedDelimit[] } = {},
): MeshSelection {
  const delimit = new Set(options.delimit ?? []);
  const sel = new Selection(mesh, seed, mode);
  const bm = sel.bm;
  const key = (e: BE): string => (e.v1.index < e.v2.index ? `${e.v1.index}_${e.v2.index}` : `${e.v2.index}_${e.v1.index}`);
  const materialOf = new Map<BF, number>();
  for (const face of liveFaces(bm)) materialOf.set(face, mesh.materials?.[face.src] ?? 0);

  /** `select_linked_delimit_test` negated: the walk may step over this edge. */
  const ok = (e: BE): boolean => {
    if (delimit.size === 0) return true;
    if (delimit.has("seam") && mesh.seams?.has(key(e))) return false;
    // `BM_ELEM_SMOOTH == 0`: a face edge flagged sharp.
    if (delimit.has("sharp") && mesh.sharp?.has(key(e))) return false;
    // `!BM_edge_is_contiguous`: two faces, the first running the edge the way its radial neighbour does.
    if (delimit.has("normal") && e.l && e.l.rn !== e.l && e.l.rn!.v === e.l.v) return false;
    if (delimit.has("material") && e.l && e.l.rn !== e.l) {
      const mat = materialOf.get(e.l.f)!;
      for (let l = e.l.rn!; l !== e.l; l = l.rn!) if (materialOf.get(l.f) !== mat) return false;
    }
    return true;
  };
  const anyFaceSelected = (e: BE): boolean => radialLoops(e).some((l) => sel.sf.has(l.f));
  const isWire = (e: BE): boolean => !e.l;

  /** `BMW_VERT_SHELL`: the edges reachable from the start edges through shared vertices. */
  const vertShell = (start: BE[], visited: Set<BE>): BE[] => {
    const stack = start.filter((e) => !visited.has(e));
    for (const e of stack) visited.add(e);
    const out: BE[] = [];
    while (stack.length > 0) {
      const e = stack.pop()!;
      out.push(e);
      for (const v of [e.v1, e.v2])
        for (const e2 of diskEdges(v))
          if (!visited.has(e2)) {
            visited.add(e2);
            stack.push(e2);
          }
    }
    return out;
  };

  /** `BMW_LOOP_SHELL_WIRE`: the loops (and the wire edges between them) reachable across the edges `ok` allows. */
  class LoopShellWire {
    readonly loops = new Set<BL>();
    readonly alt = new Set<BV | BE>();
    readonly queue: Array<BL | BE> = [];
    visitLoop(l: BL): void {
      if (this.loops.has(l)) return;
      this.loops.add(l);
      this.queue.push(l);
    }
    visitEdgeWire(e: BE): void {
      if (this.alt.has(e) || !ok(e)) return;
      this.alt.add(e);
      this.queue.push(e);
    }
    visitVert(v: BV, from: BE | null): void {
      if (this.alt.has(v)) return;
      for (const e of diskEdges(v)) {
        if (isWire(e) && e !== from) {
          this.visitEdgeWire(e);
          for (const l of loopsOfVert(e.v1 === v ? e.v2 : e.v1)) this.visitLoop(l);
        }
      }
      this.alt.add(v);
    }
    stepLoop(l: BL): void {
      this.visitLoop(l.next);
      this.visitLoop(l.prev);
      for (const e of [l.e!, l.prev.e!])
        if (ok(e))
          for (const lr of radialLoops(e)) {
            const lRadial = lr.v === l.v ? lr : lr.next;
            if (l !== lRadial) this.visitLoop(lRadial);
          }
    }
    /** Runs the walk from what was queued; returns what it yielded. */
    run(): Array<BL | BE> {
      const yielded: Array<BL | BE> = [];
      while (this.queue.length > 0) {
        const el = this.queue.pop()!;
        if ("f" in el) {
          this.stepLoop(el);
          this.visitVert(el.v, null);
        } else {
          this.visitVert(el.v1, el);
          this.visitVert(el.v2, el);
        }
        yielded.push(el);
      }
      return yielded;
    }
  }

  if (mode === "vertex") {
    const tagged = new Set(sel.sv);
    if (delimit.size > 0)
      for (const e of liveEdges(bm))
        if (!ok(e) && anyFaceSelected(e)) {
          tagged.delete(e.v1);
          tagged.delete(e.v2);
        }
    if (delimit.size === 0) {
      const visited = new Set<BE>();
      for (const v of bm.verts) if (v && tagged.has(v)) for (const e of vertShell(diskEdges(v), visited)) sel.edge(e);
    } else {
      const walker = new LoopShellWire();
      for (const v of bm.verts) {
        if (!v || !tagged.has(v)) continue;
        for (const l of loopsOfVert(v)) walker.visitLoop(l);
        if (v.e) walker.visitVert(v, null);
        for (const el of walker.run()) {
          if ("f" in el) {
            sel.vert(el.v);
            tagged.delete(el.v);
          } else {
            sel.edge(el);
            tagged.delete(el.v1);
            tagged.delete(el.v2);
          }
        }
      }
    }
    sel.flush("vertex");
  } else if (mode === "edge") {
    const tagged = new Set([...sel.se].filter((e) => delimit.size === 0 || ok(e) || !anyFaceSelected(e)));
    if (delimit.size === 0) {
      const visited = new Set<BE>();
      for (const e of liveEdges(bm)) if (tagged.has(e)) for (const x of vertShell([e], visited)) sel.edge(x);
    } else {
      const walker = new LoopShellWire();
      for (const e of liveEdges(bm)) {
        if (!tagged.has(e)) continue;
        for (const l of radialLoops(e)) walker.visitLoop(l);
        if (ok(e)) {
          walker.visitVert(e.v1, null);
          walker.visitVert(e.v2, null);
        } else
          for (const l of radialLoops(e)) {
            walker.visitLoop(l);
            walker.visitLoop(l.next);
          }
        for (const el of walker.run()) {
          if ("f" in el) {
            sel.edge(el.e!);
            sel.edge(el.prev.e!);
            tagged.delete(el.e!);
          } else {
            sel.edge(el);
            tagged.delete(el);
          }
        }
      }
    }
    sel.flush("edge");
  } else {
    const tagged = new Set(sel.sf);
    const visited = new Set<BF>();
    for (const face of liveFaces(bm)) {
      if (!tagged.has(face) || visited.has(face)) continue;
      visited.add(face);
      const stack = [face];
      while (stack.length > 0) {
        const cur = stack.pop()!;
        sel.face(cur);
        tagged.delete(cur);
        for (const l of faceLoops(cur))
          if (ok(l.e!))
            for (const lr of radialLoops(l.e!))
              if (!visited.has(lr.f)) {
                visited.add(lr.f);
                stack.push(lr.f);
              }
      }
    }
  }
  return sel.result();
}

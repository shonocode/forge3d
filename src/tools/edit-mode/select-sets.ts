/**
 * Selections Blender's editor makes by a rule on the vertices (`editmesh_select.cc`, compat-backlog C81): Select Axis, Select Random, Select by
 * Pole Count and Select Mirror. Like {@link selectNonManifold} they take a mesh, the mode the editor is in and the selection it starts from, and
 * return the selection that is left — with the mode's flush applied, so in vertex mode a face whose vertices are all picked is selected.
 */
import type { MeshData } from "../../lib/mesh";
import { f as f32 } from "../blender-math";
import { blenderShuffle } from "../build";
import { edgeExists, faceExists, faceLoops, liveEdges, liveFaces, isManifold, diskEdges, loopsOfVert, type BE, type BF, type BV } from "../bmesh-lite";
import {
  Selection,
  vertIsManifold,
  type MeshSelection,
  type SelectMode,
  type SelectionSeed,
} from "./select-topology";

export interface SelectAxisOptions {
  /** The axis, in the mesh's own space. Default "x". */
  axis?: "x" | "y" | "z";
  /** `pos`: the vertices beyond the active one; `neg`: before it; `align`: level with it. */
  sign: "pos" | "neg" | "align";
  /** Default 0.0001, Blender's. */
  threshold?: number;
}

/**
 * Blender's **Select Axis** (`mesh.select_axis`): from the active vertex — the last one selected, `active` — every unselected vertex on its
 * positive side, its negative side, or level with it, along one axis. `threshold` widens the active vertex's side by that much (it makes the vertices *level* with it count as beyond it).
 * Nothing happens when every vertex is already selected. The mesh is taken as the object's local space.
 */
export function selectAxis(
  mesh: MeshData,
  mode: SelectMode,
  seed: SelectionSeed & { active: number },
  options: SelectAxisOptions,
): MeshSelection {
  const sel = new Selection(mesh, seed, mode);
  const verts = sel.bm.verts.filter((v): v is BV => !!v);
  if (verts.length === sel.sv.size) return sel.result();
  const k = { x: 0, y: 1, z: 2 }[options.axis ?? "x"];
  const limit = f32(options.threshold ?? 0.0001);
  let value = sel.bm.verts[seed.active]!.co[k]!;
  if (options.sign === "neg") value = f32(value + limit);
  else if (options.sign === "pos") value = f32(value - limit);
  let changed = false;
  for (const v of verts) {
    if (sel.sv.has(v)) continue;
    const here = v.co[k]!;
    const hit =
      options.sign === "align" ? Math.abs(f32(here - value)) < limit : options.sign === "neg" ? here < value : here > value;
    if (hit) {
      sel.vert(v);
      changed = true;
    }
  }
  if (changed) sel.flush(mode);
  return sel.result();
}

/**
 * Blender's Select ▸ Select Random (`mesh.select_random`, action Select): `ratio` of the vertices, edges or faces (by mode), picked by shuffling
 * them with `BLI_array_randomize(seed)` and taking the first `int(count · ratio)`. They are added to the selection.
 */
export function selectRandom(
  mesh: MeshData,
  mode: SelectMode,
  seed: SelectionSeed,
  options: { ratio?: number; seed?: number } = {},
): MeshSelection {
  const sel = new Selection(mesh, seed, mode);
  const ratio = f32(options.ratio ?? 0.5);
  const elements: Array<BV | BE | BF> =
    mode === "vertex" ? sel.bm.verts.filter((v): v is BV => !!v) : mode === "edge" ? liveEdges(sel.bm) : liveFaces(sel.bm);
  const order = blenderShuffle(elements.length, options.seed ?? 0);
  const count = Math.trunc(f32(elements.length * ratio));
  for (let i = 0; i < count; i++) {
    const el = elements[order[i]!]!;
    if (mode === "vertex") sel.vert(el as BV);
    else if (mode === "edge") sel.edge(el as BE);
    else sel.face(el as BF);
  }
  sel.flush(mode);
  return sel.result();
}

export interface PoleCountOptions {
  /** How many edges meet there. Default 4, Blender's. */
  poleCount?: number;
  /** How the vertex's edge count compares with it. Default "notequal", Blender's. */
  type?: "less" | "equal" | "greater" | "notequal";
  /** Keep the selection (default false). */
  extend?: boolean;
  /** Skip vertices that are not manifold, or touch an edge that is not (default true, Blender's — which also skips every boundary vertex). */
  excludeNonManifold?: boolean;
}

/**
 * Blender's Select ▸ Select All by Trait ▸ Poles (`mesh.select_by_pole_count`): vertices by how many edges meet at them — the count is cut off one above
 * `poleCount`, so "greater" works. In vertex mode the vertex is selected; in edge mode all its edges; in face mode all its faces.
 */
export function selectByPoleCount(mesh: MeshData, mode: SelectMode, seed: SelectionSeed, options: PoleCountOptions = {}): MeshSelection {
  const sel = new Selection(mesh, seed, mode);
  const pole = options.poleCount ?? 4;
  const type = options.type ?? "notequal";
  if (!(options.extend ?? false)) sel.clear();
  for (const v of sel.bm.verts) {
    if (!v) continue;
    const count = Math.min(diskEdges(v).length, pole + 1);
    const match = type === "less" ? count < pole : type === "equal" ? count === pole : type === "greater" ? count > pole : count !== pole;
    if (!match) continue;
    if (options.excludeNonManifold ?? true) {
      if (!vertIsManifold(v)) continue;
      if (!diskEdges(v).every((e) => isManifold(e))) continue;
    }
    if (mode === "vertex") sel.vert(v);
    else if (mode === "edge") for (const e of diskEdges(v)) sel.edge(e);
    else for (const l of loopsOfVert(v)) sel.face(l.f);
  }
  sel.flush(mode);
  return sel.result();
}

/**
 * Blender's Select ▸ Select Mirror (`mesh.select_mirror`): what is at the mirrored position of what is selected, across the named axes. A vertex's
 * mirror is the nearest vertex to its reflection within 0.00002; an edge's is the edge between its ends' mirrors, a face's the face over its
 * vertices' mirrors. With `extend` off only the mirrored elements are left selected.
 */
export function selectMirror(
  mesh: MeshData,
  mode: SelectMode,
  seed: SelectionSeed,
  options: { axes?: readonly ("x" | "y" | "z")[]; extend?: boolean } = {},
): MeshSelection {
  const sel = new Selection(mesh, seed, mode);
  if (sel.sv.size === 0) return sel.result();
  const maxDistSq = f32(f32(0.00002) * f32(0.00002));
  const all = sel.bm.verts.filter((v): v is BV => !!v);
  let mirrored = 0;
  for (const axisName of options.axes ?? ["x"]) {
    const k = { x: 0, y: 1, z: 2 }[axisName];
    const tag = {
      v: new Set(sel.sv),
      e: new Set(sel.se),
      f: new Set(sel.sf),
    };
    // `EDBM_verts_mirror_cache_begin`: each selected vertex finds its reflection, and the vertex it finds points back.
    const mirror = new Map<BV, BV>();
    for (const v of all) {
      if (!sel.sv.has(v)) continue;
      const co = [v.co[0]!, v.co[1]!, v.co[2]!];
      co[k] = f32(co[k]! * -1);
      let best: BV | null = null;
      let bestD = Infinity;
      for (const w of all) {
        const dx = f32(co[0]! - w.co[0]!);
        const dy = f32(co[1]! - w.co[1]!);
        const dz = f32(co[2]! - w.co[2]!);
        const d = f32(f32(f32(dx * dx) + f32(dy * dy)) + f32(dz * dz));
        if (d < bestD) {
          bestD = d;
          best = w;
        }
      }
      if (best && bestD < maxDistSq) {
        mirror.set(v, best);
        mirror.set(best, v);
      } else mirror.delete(v);
    }
    if (!(options.extend ?? false)) sel.clear();
    if (mode === "vertex") {
      for (const v of all) if (tag.v.has(v) && mirror.has(v)) (sel.vert(mirror.get(v)!), mirrored++);
    } else if (mode === "edge") {
      for (const e of liveEdges(sel.bm)) {
        if (!tag.e.has(e)) continue;
        const a = mirror.get(e.v1);
        const b = mirror.get(e.v2);
        const m = a && b && a !== b ? edgeExists(a, b) : null;
        if (m) (sel.edge(m), mirrored++);
      }
    } else {
      for (const face of liveFaces(sel.bm)) {
        if (!tag.f.has(face)) continue;
        const vs = faceLoops(face).map((l) => mirror.get(l.v));
        const m = vs.every((v) => v) ? faceExists(vs as BV[]) : null;
        if (m) (sel.face(m), mirrored++);
      }
    }
  }
  if (mirrored > 0) sel.flush(mode);
  return sel.result();
}

/**
 * Blender's Select ▸ Select All by Trait ▸ Faces by Sides (`mesh.select_face_by_sides`): faces whose number of corners compares as asked with
 * `number` (default 4, `equal`). `extend` (default **true**, unlike most) keeps what was selected.
 */
export function selectFaceBySides(
  mesh: MeshData,
  mode: SelectMode,
  seed: SelectionSeed,
  options: { number?: number; type?: "less" | "equal" | "greater" | "notequal"; extend?: boolean } = {},
): MeshSelection {
  const sel = new Selection(mesh, seed, mode);
  const number = options.number ?? 4;
  const type = options.type ?? "equal";
  if (!(options.extend ?? true)) sel.clear();
  for (const face of liveFaces(sel.bm)) {
    const n = face.len;
    const match = type === "less" ? n < number : type === "equal" ? n === number : type === "greater" ? n > number : n !== number;
    if (match) sel.face(face);
  }
  sel.flush(mode);
  return sel.result();
}

/**
 * Blender's Select ▸ Select All by Trait ▸ Sharp Edges (`mesh.edges_select_sharp`): the edges with exactly two faces whose normals differ by more
 * than `sharpness` radians (default 30°). In vertex or edge mode the mode's flush follows; in face mode the faces touching a picked edge are
 * selected. Adds to the selection.
 */
export function selectSharpEdges(mesh: MeshData, mode: SelectMode, seed: SelectionSeed, options: { sharpness?: number } = {}): MeshSelection {
  const sel = new Selection(mesh, seed, mode);
  const limit = f32(Math.cos(f32(options.sharpness ?? f32(30 * f32(Math.PI / 180)))));
  for (const e of liveEdges(sel.bm)) {
    // `BM_edge_loop_pair`: exactly two faces.
    const la = e.l;
    if (!la || la.rn === la || la.rn!.rn !== la) continue;
    const a = la.f.no;
    const b = la.rn!.f.no;
    const c = f32(f32(f32(a[0]! * b[0]!) + f32(a[1]! * b[1]!)) + f32(a[2]! * b[2]!));
    if (c < limit) sel.edge(e);
  }
  if (mode === "face") {
    // `EDBM_selectmode_convert(edge -> face)`: every face with a selected edge.
    const picked = new Set(sel.se);
    for (const face of liveFaces(sel.bm)) if (faceLoops(face).some((l) => picked.has(l.e!))) sel.face(face);
  } else sel.flush(mode);
  return sel.result();
}

/** Options of {@link selectNth} — the operator's checker interval. */
export interface SelectNthOptions {
  /** `skip`: how many in a row are deselected. Default 1. */
  skip?: number;
  /** `nth`: how many in a row stay selected. Default 1. */
  nth?: number;
  /** `offset`: where the pattern starts. Default 0. */
  offset?: number;
  /**
   * The active element the pattern counts from — the select history's last (`BM_mesh_active_elem_get`): a vertex in vertex
   * mode, an edge (vertex pair) in edge mode, a face in face mode. Left out, or not selected: the first selected vertex /
   * edge in the mesh's order, or the first selected face.
   */
  active?: number | [number, number];
}

/**
 * Blender's Select ▸ Checker Deselect (`mesh.select_nth`, compat-backlog C83): from the active element, the selected elements
 * of the mode are counted out and every `skip` after `nth` deselected. The count is the breadth-first depth from the active
 * element over the selection — vertices through edges (`BMW_CONNECTED_VERTEX`), edges through vertices (`BMW_VERT_SHELL`) or,
 * for an edge with no selected edge beside it, through faces (`BMW_FACE_SHELL`), faces through edges (`BMW_ISLAND`) — except
 * where the selection is one closed chain, which is walked round in one direction (the disk / loop order) so the count runs
 * on (`walker_deselect_nth_*_chain`). Deselecting a vertex deselects its edges and faces; an edge, its vertices no other
 * selected edge uses; a face, its edges and vertices no other selected face uses — then the mode's flush.
 */
export function selectNth(mesh: MeshData, mode: SelectMode, seed: SelectionSeed, options: SelectNthOptions = {}): MeshSelection {
  const sel = new Selection(mesh, seed, mode);
  const nth = Math.max(1, Math.trunc(options.nth ?? 1));
  const skip = Math.max(1, Math.trunc(options.skip ?? 1));
  const period = nth + skip;
  const offset = (((options.offset ?? 0) % period) + period) % period;
  const keep = (depth: number): boolean => (offset + depth) % period >= skip;
  const other = (e: BE, v: BV): BV => (e.v1 === v ? e.v2 : e.v1);

  const unselectVert = (v: BV): void => {
    sel.sv.delete(v);
    for (const e of diskEdges(v)) {
      sel.se.delete(e);
      for (const l of radialFaces(e)) sel.sf.delete(l);
    }
  };
  const unselectEdge = (e: BE): void => {
    sel.se.delete(e);
    for (const v of [e.v1, e.v2]) if (!diskEdges(v).some((x) => x !== e && sel.se.has(x))) sel.sv.delete(v);
  };
  const unselectFace = (f: BF): void => {
    sel.sf.delete(f);
    for (const l of faceLoops(f)) {
      if (!radialFaces(l.e!).some((g) => g !== f && sel.sf.has(g))) sel.se.delete(l.e!);
      if (!facesOfVert(l.v).some((g) => g !== f && sel.sf.has(g))) sel.sv.delete(l.v);
    }
  };

  if (mode === "vertex") {
    const want = typeof options.active === "number" ? sel.bm.verts[options.active] : undefined;
    const start = want && sel.sv.has(want) ? want : sel.bm.verts.find((v): v is BV => !!v && sel.sv.has(v));
    if (!start) return sel.result();
    // `bm_step_to_next_selected_vert_in_chain`: the selected neighbours in disk order, one expected after the first step, two at it.
    const step = (cur: BV, prev: BV | null): BV | null => {
      let next: BV | null = null;
      let count = 0;
      const expected = prev ? 1 : 2;
      for (const e of diskEdges(cur)) {
        const w = other(e, cur);
        if (w === prev || !sel.sv.has(w)) continue;
        if (++count > expected) return null;
        next = w;
      }
      return count === expected ? next : null;
    };
    const cyclic = ((): boolean => {
      let prev: BV | null = null;
      let cur = start;
      do {
        if (diskEdges(cur).filter((e) => sel.sv.has(other(e, cur))).length !== 2) return false;
        const next = step(cur, prev);
        if (!next) return false;
        prev = cur;
        cur = next;
      } while (cur !== start);
      return true;
    })();
    const drop: BV[] = [];
    if (cyclic) {
      let prev: BV | null = null;
      let cur: BV | null = start;
      const seen = new Set<BV>();
      for (let index = 0; cur && !seen.has(cur); index++) {
        seen.add(cur);
        if (!keep(index)) drop.push(cur);
        const next: BV | null = step(cur, prev);
        if (!next || next === start) break;
        prev = cur;
        cur = next;
      }
    } else
      bfs(start, (v) => diskEdges(v).map((e) => other(e, v)).filter((w) => sel.sv.has(w)), (v, depth) => {
        if (!keep(depth)) drop.push(v);
      });
    for (const v of drop) unselectVert(v);
    sel.flush("vertex");
  } else if (mode === "edge") {
    const want = Array.isArray(options.active) ? edgeExists(sel.bm.verts[options.active[0]]!, sel.bm.verts[options.active[1]]!) : null;
    const start = want && sel.se.has(want) ? want : liveEdges(sel.bm).find((e) => sel.se.has(e));
    if (!start) return sel.result();
    // `bm_step_over_vert_to_next_selected_edge_in_chain`.
    const stepOver = (cur: BE, v: BV): BE | null => {
      let next: BE | null = null;
      let count = 0;
      for (const e of diskEdges(v)) {
        if (e === cur || !sel.se.has(e)) continue;
        if (++count > 1) return null;
        next = e;
      }
      return count === 1 ? next : null;
    };
    const cyclic = ((): boolean => {
      let cur = start;
      let through = start.v1;
      do {
        const next = stepOver(cur, through);
        if (!next) return false;
        through = other(next, through);
        cur = next;
      } while (cur !== start);
      return true;
    })();
    const drop: BE[] = [];
    if (cyclic) {
      let cur: BE | null = start;
      let through = start.v1;
      const seen = new Set<BE>();
      for (let index = 0; cur && !seen.has(cur); index++) {
        seen.add(cur);
        if (!keep(index)) drop.push(cur);
        const next: BE | null = stepOver(cur, through);
        if (!next || next === start) break;
        through = other(next, through);
        cur = next;
      }
    } else {
      // `bm_edge_is_select_isolated`: no selected edge at either end — then the walk steps across faces (edge rings).
      const isolated = [start.v1, start.v2].every((v) => diskEdges(v).every((e) => e === start || !sel.se.has(e)));
      const near = isolated
        ? (e: BE): BE[] => radialFaces(e).flatMap((f) => faceLoops(f).map((l) => l.e!)).filter((x) => sel.se.has(x))
        : (e: BE): BE[] => [e.v1, e.v2].flatMap((v) => diskEdges(v)).filter((x) => sel.se.has(x));
      bfs(start, near, (e, depth) => {
        if (!keep(depth)) drop.push(e);
      });
    }
    for (const e of drop) unselectEdge(e);
    sel.flush("edge");
  } else {
    const bySrc = new Map(liveFaces(sel.bm).map((f) => [f.src, f] as const));
    const want = typeof options.active === "number" ? bySrc.get(options.active) : undefined;
    const start = want && sel.sf.has(want) ? want : liveFaces(sel.bm).find((f) => sel.sf.has(f));
    if (!start) return sel.result();
    // `bm_step_over_shared_edge_to_next_selected_face_in_chain`.
    const step = (cur: BF, prev: BF | null): BF | null => {
      let next: BF | null = null;
      let count = 0;
      const expected = prev ? 1 : 2;
      for (const l of faceLoops(cur))
        for (const g of radialFaces(l.e!)) {
          if (g === cur || g === prev || !sel.sf.has(g)) continue;
          if (++count > expected) return null;
          next = g;
        }
      return count === expected ? next : null;
    };
    const cyclic = ((): boolean => {
      let prev: BF | null = null;
      let cur = start;
      do {
        let n = 0;
        for (const l of faceLoops(cur)) for (const g of radialFaces(l.e!)) if (g !== cur && sel.sf.has(g)) n++;
        if (n !== 2) return false;
        const next = step(cur, prev);
        if (!next) return false;
        prev = cur;
        cur = next;
      } while (cur !== start);
      return true;
    })();
    const drop: BF[] = [];
    if (cyclic) {
      let prev: BF | null = null;
      let cur: BF | null = start;
      const seen = new Set<BF>();
      for (let index = 0; cur && !seen.has(cur); index++) {
        seen.add(cur);
        const next: BF | null = step(cur, prev);
        if (!keep(index)) drop.push(cur);
        if (!next || next === start) break;
        prev = cur;
        cur = next;
      }
    } else
      bfs(start, (f) => faceLoops(f).flatMap((l) => radialFaces(l.e!)).filter((g) => g !== f && sel.sf.has(g)), (f, depth) => {
        if (!keep(depth)) drop.push(f);
      });
    for (const f of drop) unselectFace(f);
  }
  return sel.result();
}

/** Breadth first from `start` over `next`, each element once at its depth (the BMesh walkers' breadth-first order). */
function bfs<T>(start: T, next: (x: T) => T[], visit: (x: T, depth: number) => void): void {
  const depth = new Map<T, number>([[start, 0]]);
  const queue: T[] = [start];
  for (let i = 0; i < queue.length; i++) {
    const x = queue[i]!;
    visit(x, depth.get(x)!);
    for (const y of next(x)) {
      if (depth.has(y)) continue;
      depth.set(y, depth.get(x)! + 1);
      queue.push(y);
    }
  }
}

/** The faces on an edge, in its radial order. */
function radialFaces(e: BE): BF[] {
  const out: BF[] = [];
  const l0 = e.l;
  if (!l0) return out;
  let l = l0;
  do {
    out.push(l.f);
    l = l.rn!;
  } while (l !== l0);
  return out;
}

/** The faces round a vertex. */
function facesOfVert(v: BV): BF[] {
  return loopsOfVert(v).map((l) => l.f);
}

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

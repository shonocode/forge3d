/**
 * Two of Blender's selection operators that were missing (compat-backlog C100), ported from `editors/mesh/editmesh_select.cc`:
 *
 * - `mesh.faces_select_linked_flat` — {@link selectLinkedFlat};
 * - `mesh.select_ungrouped` — {@link selectUngrouped}.
 *
 * Both take and return the same {@link MeshSelection} as the rest of the selection operators. The object is taken at the identity
 * transform and nothing is hidden.
 */
import type { MeshData } from "../../lib/mesh";
import { f, newell, normalQuad, normalTri, type V3 } from "../blender-math";
import { faceLoops, liveFaces, type BF } from "../bmesh-lite";
import { Selection, type MeshSelection, type SelectMode, type SelectionSeed } from "./select-topology";

/** `normalize_v3`: multiplies by the reciprocal. */
const normalize = (a: readonly number[]): V3 => {
  const d = f(f(f(a[0]! * a[0]!) + f(a[1]! * a[1]!)) + f(a[2]! * a[2]!));
  if (d <= 1e-35) return [0, 0, 0];
  const s = f(1 / f(Math.sqrt(d)));
  return [f(a[0]! * s), f(a[1]! * s), f(a[2]! * s)];
};
const dot = (a: readonly number[], b: readonly number[]): number => f(f(f(a[0]! * b[0]!) + f(a[1]! * b[1]!)) + f(a[2]! * b[2]!));

/** `BM_face_calc_normal`: a quad by its diagonals, a triangle by its cross product, an n-gon by Newell — zero when degenerate. */
function faceNormal(x: BF): V3 {
  const co = faceLoops(x).map((l) => l.v.co as V3);
  if (co.length === 4) return normalQuad(co[0]!, co[1]!, co[2]!, co[3]!);
  if (co.length === 3) return normalTri(co[0]!, co[1]!, co[2]!);
  return normalize(newell(co));
}

export interface SelectLinkedFlatOptions {
  /** `sharpness`, in radians. Default 1° (`DEG2RADF(1.0f)`). Faces whose normals are within it of each other are taken as one flat piece. */
  sharpness?: number;
}

/**
 * `mesh.faces_select_linked_flat` — grow the selected faces over the faces linked to them by an edge whose normal is within `sharpness`.
 *
 * The test is `dot(current face normal, neighbour's normal) > cos(sharpness)`, strictly, and it is made against the face the growth has
 * reached, **not against the face it started from** — so a gentle curve is followed all the way round, one small step at a time. The
 * result is the selected faces together with every face reachable that way. Nothing is deselected, and the selection is not flushed
 * afterwards: the faces it adds bring their edges and vertices, and no more.
 */
export function selectLinkedFlat(mesh: MeshData, mode: SelectMode, seed: SelectionSeed, options: SelectLinkedFlatOptions = {}): MeshSelection {
  const sel = new Selection(mesh, seed, mode);
  if (sel.sf.size === 0) return sel.result();
  const limit = f(Math.cos(f(options.sharpness ?? f((1 * Math.PI) / 180))));
  const normals = new Map<BF, V3>();
  const normalOf = (x: BF): V3 => {
    let n = normals.get(x);
    if (!n) normals.set(x, (n = faceNormal(x)));
    return n;
  };

  const tagged = new Set<BF>();
  for (const start of liveFaces(sel.bm)) {
    if (tagged.has(start) || !sel.sf.has(start)) continue;
    const stack: BF[] = [];
    let cur: BF | undefined = start;
    do {
      sel.face(cur);
      tagged.add(cur);
      for (const l of faceLoops(cur))
        for (let other = l.rn; other && other !== l; other = other.rn) {
          if (tagged.has(other.f)) continue;
          if (dot(normalOf(cur), normalOf(other.f)) > limit) stack.push(other.f);
        }
      cur = stack.pop();
    } while (cur);
  }
  return sel.result();
}

export interface SelectUngroupedOptions {
  /** `extend`: keep the selection and add to it. Default off — the selection is cleared first. */
  extend?: boolean;
}

/**
 * `mesh.select_ungrouped` — select the vertices that are in no vertex group.
 *
 * "In a group" is having a weight **entry**, whatever its value: a vertex held at weight 0 is grouped and is not selected. Like the
 * operator's poll, it needs vertex select mode and a mesh that has vertex groups, and throws where Blender refuses to run.
 */
export function selectUngrouped(mesh: MeshData, mode: SelectMode, seed: SelectionSeed, options: SelectUngroupedOptions = {}): MeshSelection {
  if (mode !== "vertex") throw new Error("selectUngrouped: must be in vertex selection mode");
  if (!mesh.groups || mesh.groups.size === 0) throw new Error("selectUngrouped: no weights/vertex groups on the mesh");
  const sel = new Selection(mesh, seed, mode);
  if (!options.extend) sel.clear();
  const grouped = new Set<number>();
  for (const members of mesh.groups.values()) for (const v of members.keys()) grouped.add(v);
  for (const v of sel.bm.verts) if (v && !grouped.has(v.index)) sel.vert(v);
  sel.flush(mode);
  return sel.result();
}

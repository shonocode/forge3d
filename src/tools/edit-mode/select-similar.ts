/**
 * Blender's Select ▸ Select Similar (`mesh.select_similar`, compat-backlog C83), ported from
 * `editors/mesh/editmesh_select_similar.cc` and `editors/util/select_utils.cc`.
 *
 * The selected elements' values go into a KD-tree and every unselected element is compared against its nearest entry.
 * For a number compared with `EQUAL` that is "any within the threshold"; `GREATER` compares against the smallest value
 * and `LESS` against the median one (Blender's KD-tree search for the largest overflows — see `nearest1d`). The
 * one-dimensional tree is Blender's, searched as Blender searches it, since its float ties decide; the 3D and 4D trees
 * (normals, directions, planes) are searched in full — a tie there is between entries equally near, which gives the same
 * angle and distance.
 *
 * Normals are the edit mesh's: BMesh recomputes them on entering edit mode (`BKE_editmesh_looptris_and_normals_calc`) — a
 * degenerate n-gon's normal stays zero, and a vertex whose corner normals cancel takes its own position, normalised.
 *
 * Layers forge3d's mesh does not carry — vertex groups, vertex creases, bevel weights, Freestyle marks, the faces' smooth
 * flag — take Blender's branch for a mesh without the layer: `VERT_GROUPS` changes nothing, the others find every element
 * equal and select them all. `FACE_MATERIAL` takes each material slot (`materials`) as its own material — Blender compares
 * the materials, so two slots holding one material count as one — and without `materials` (no slots) changes nothing.
 * The object is taken at the identity transform.
 */
import type { MeshData } from "../../lib/mesh";
import { f, FLT_EPSILON, FLT_MAX, newell, normalQuad, normalTri, safeAcosApprox, type V3 } from "../blender-math";
import { diskEdges, faceLoops, liveEdges, liveFaces, loopsOfVert, type BE, type BF, type BV } from "../bmesh-lite";
import { seamKey } from "./half-edge";
import { radialFaces } from "./select-sets";
import { Selection, type MeshSelection, type SelectMode, type SelectionSeed } from "./select-topology";

/** The `type` of `mesh.select_similar`, by Blender's identifiers. */
export type SimilarType =
  | "VERT_NORMAL"
  | "VERT_FACES"
  | "VERT_GROUPS"
  | "VERT_EDGES"
  | "VERT_CREASE"
  | "EDGE_LENGTH"
  | "EDGE_DIR"
  | "EDGE_FACES"
  | "EDGE_FACE_ANGLE"
  | "EDGE_CREASE"
  | "EDGE_BEVEL"
  | "EDGE_SEAM"
  | "EDGE_SHARP"
  | "EDGE_FREESTYLE"
  | "FACE_MATERIAL"
  | "FACE_AREA"
  | "FACE_SIDES"
  | "FACE_PERIMETER"
  | "FACE_NORMAL"
  | "FACE_COPLANAR"
  | "FACE_SMOOTH"
  | "FACE_FREESTYLE";

/** Options of {@link selectSimilar} — the operator's. */
export interface SelectSimilarOptions {
  /** Default `VERT_NORMAL` in vertex mode, `EDGE_LENGTH` in edge mode, `FACE_MATERIAL` in face mode (each mode's first). */
  type?: SimilarType;
  /** `compare`: EQUAL (default), GREATER or LESS. `EDGE_FACE_ANGLE` always compares EQUAL, as Blender does. */
  compare?: "EQUAL" | "GREATER" | "LESS";
  /**
   * `threshold`. Default 0.01 — the scene's `select_thresh`, which the operator reads when it is not given. The normal and
   * direction types take it as a fraction of π; `EDGE_FACE_ANGLE` compares radians against it as it is. `EDGE_LENGTH`
   * compares **squared** lengths against it, as Blender does.
   */
  threshold?: number;
}

const sub = (a: readonly number[], b: readonly number[]): V3 => [f(a[0]! - b[0]!), f(a[1]! - b[1]!), f(a[2]! - b[2]!)];
const dot = (a: readonly number[], b: readonly number[]): number => f(f(f(a[0]! * b[0]!) + f(a[1]! * b[1]!)) + f(a[2]! * b[2]!));
const lenSq = (a: readonly number[]): number => dot(a, a);
const len = (a: readonly number[]): number => f(Math.sqrt(lenSq(a)));
/** `normalize_v3`: multiplies by the reciprocal. */
const normalize = (a: readonly number[]): V3 => {
  const d = lenSq(a);
  if (d <= 1e-35) return [0, 0, 0];
  const s = f(1 / f(Math.sqrt(d)));
  return [f(a[0]! * s), f(a[1]! * s), f(a[2]! * s)];
};
const safeAsin = (x: number): number => (x <= -1 ? f(-Math.PI / 2) : x >= 1 ? f(Math.PI / 2) : f(Math.asin(x)));
/** `angle_normalized_v3v3`. */
function angleNormalized(a: readonly number[], b: readonly number[]): number {
  if (dot(a, b) >= 0) return f(2 * safeAsin(f(len(sub(a, b)) / 2)));
  const bn = [f(-b[0]!), f(-b[1]!), f(-b[2]!)];
  return f(f(Math.PI) - f(2 * safeAsin(f(len(sub(a, bn)) / 2))));
}
/** `ED_select_similar_compare_float`. */
function compareFloat(delta: number, thresh: number, compare: string): boolean {
  if (compare === "GREATER") return f(delta + thresh) >= 0;
  if (compare === "LESS") return f(delta - thresh) <= 0;
  return Math.abs(delta) <= thresh;
}
/**
 * `kdtree_1d_find_nearest` on the tree of `values` after `kdtree_deduplicate` (sorted, exact repeats dropped) and
 * `kdtree_balance` (on a sorted array the quick-select leaves it sorted, so each subtree's root is its middle element),
 * with Blender's float squared distances and visiting order. Nearest `FLT_MAX` is meant to be the largest, but every
 * squared distance to it overflows to infinity, nothing beats the root, and the median comes back.
 */
function nearest1d(values: number[], co: number): number {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const sq = (a: number, b: number): number => {
    const d = f(a - b);
    return f(d * d);
  };
  // A node is the middle of its range [lo, lo + n); its subtrees are the halves either side.
  type Node = { at: number; lo: number; n: number };
  const node = (lo: number, n: number): Node | null => (n > 0 ? { at: lo + (n >> 1), lo, n } : null);
  const left = (x: Node): Node | null => node(x.lo, x.n >> 1);
  const right = (x: Node): Node | null => node(x.at + 1, x.n - (x.n >> 1) - 1);
  const root = node(0, sorted.length)!;
  let best = root;
  let min = sq(sorted[root.at]!, co);
  const stack: Node[] = [];
  const push = (x: Node | null): void => {
    if (x) stack.push(x);
  };
  if (co < sorted[root.at]!) {
    push(right(root));
    push(left(root));
  } else {
    push(left(root));
    push(right(root));
  }
  while (stack.length) {
    const x = stack.pop()!;
    let cur = f(sorted[x.at]! - co);
    if (cur < 0) {
      cur = f(-cur * cur);
      if (-cur < min) {
        const d = sq(sorted[x.at]!, co);
        if (d < min) {
          min = d;
          best = x;
        }
        push(left(x));
      }
      push(right(x));
    } else {
      cur = f(cur * cur);
      if (cur < min) {
        const d = sq(sorted[x.at]!, co);
        if (d < min) {
          min = d;
          best = x;
        }
        push(right(x));
      }
      push(left(x));
    }
  }
  return sorted[best.at]!;
}

/** `ED_select_similar_compare_float_tree`: against the value nearest `value` (EQUAL), −1 (GREATER) or `FLT_MAX` (LESS). */
function compareFloatTree(tree: number[], value: number, thresh: number, compare: string): boolean {
  if (!tree.length) return false;
  const target = compare === "GREATER" ? -1 : compare === "LESS" ? FLT_MAX : value;
  return compareFloat(f(value - nearest1d(tree, target)), thresh, compare);
}

/** `BM_face_calc_normal`: a quad by its diagonals, a triangle by its cross product, an n-gon by Newell — zero when degenerate. */
function bmFaceNormal(x: BF): V3 {
  const co = faceLoops(x).map((l) => l.v.co as V3);
  if (co.length === 4) return normalQuad(co[0]!, co[1]!, co[2]!, co[3]!);
  if (co.length === 3) return normalTri(co[0]!, co[1]!, co[2]!);
  return normalize(newell(co));
}

/** `bm_vert_calc_normals_impl`: corner angles times face normals, round the disk and each edge's radial cycle. */
function bmVertNormal(v: BV, faceNormal: (x: BF) => V3): V3 {
  let no: V3 = [0, 0, 0];
  for (const e of diskEdges(v)) {
    if (!e.l) continue;
    const e2 = normalize(sub(e.v1.co, e.v2.co));
    let l = e.l;
    do {
      if (l.v === v) {
        const ePrev = l.prev.e!;
        const e1 = normalize(sub(ePrev.v1.co, ePrev.v2.co));
        let d = dot(e1, e2);
        if ((ePrev.v1 === l.prev.v) !== (l.e!.v1 === l.v)) d = -d;
        const fac = safeAcosApprox(-d);
        const fn = faceNormal(l.f);
        no = [f(no[0]! + f(fn[0]! * fac)), f(no[1]! + f(fn[1]! * fac)), f(no[2]! + f(fn[2]! * fac))];
      }
      l = l.rn!;
    } while (l !== e.l);
  }
  const n = normalize(no);
  return n[0] || n[1] || n[2] ? n : normalize(v.co);
}
/** `mesh_select_similar_compare_int` over a set: any member passes. */
function compareIntSet(set: Set<number>, value: number, compare: string): boolean {
  for (const x of set) {
    const d = value - x;
    if (compare === "GREATER" ? d > 0 : compare === "LESS" ? d < 0 : d === 0) return true;
  }
  return false;
}
/** The nearest point of a 3D / 4D tree, by float32 squared distance; first on a tie. */
function nearestOf(tree: number[][], co: readonly number[]): { co: number[]; dist: number } | null {
  let best: number[] | null = null;
  let bestD = Infinity;
  for (const p of tree) {
    let d = 0;
    for (let k = 0; k < co.length; k++) {
      const t = f(p[k]! - co[k]!);
      d = f(d + f(t * t));
    }
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best ? { co: best, dist: f(Math.sqrt(bestD)) } : null;
}

/**
 * Select every unselected vertex / edge / face that is similar to a selected one by `type` (the mode follows from it), then
 * the mode's flush. The comparisons are Blender's, listed per type on {@link SimilarType} — see the module note for the
 * layers forge3d's mesh does not carry.
 */
export function selectSimilar(mesh: MeshData, mode: SelectMode, seed: SelectionSeed, options: SelectSimilarOptions = {}): MeshSelection {
  const type = options.type ?? (mode === "vertex" ? "VERT_NORMAL" : mode === "edge" ? "EDGE_LENGTH" : "FACE_MATERIAL");
  const compare = options.compare ?? "EQUAL";
  const thresh = f(options.threshold ?? 0.01);
  const sel = new Selection(mesh, seed, mode);
  const faceNo = new Map<BF, V3>();
  const faceNormal = (x: BF): V3 => {
    let n = faceNo.get(x);
    if (!n) faceNo.set(x, (n = bmFaceNormal(x)));
    return n;
  };

  if (type.startsWith("VERT_")) {
    const verts = sel.bm.verts.filter((v): v is BV => !!v);
    const picked = verts.filter((v) => sel.sv.has(v));
    if (!picked.length || type === "VERT_GROUPS") return sel.result();
    const thetaMax = f(f(thresh * f(Math.PI)) + FLT_EPSILON);
    const count = (v: BV): number => (type === "VERT_EDGES" ? diskEdges(v).length : loopsOfVert(v).length);
    let test: (v: BV) => boolean;
    if (type === "VERT_NORMAL") {
      const no = new Map(verts.map((v) => [v, bmVertNormal(v, faceNormal)] as const));
      const tree = picked.map((v) => normalize(no.get(v)!));
      test = (v) => {
        const n = normalize(no.get(v)!);
        const near = nearestOf(tree, n);
        return !!near && angleNormalized(n, near.co) <= thetaMax;
      };
    } else if (type === "VERT_CREASE") test = () => true;
    else {
      const set = new Set(picked.map(count));
      test = (v) => compareIntSet(set, count(v), compare);
    }
    for (const v of verts.filter((x) => !sel.sv.has(x) && test(x))) sel.vert(v);
    sel.flush(mode);
    return sel.result();
  }

  if (type.startsWith("EDGE_")) {
    const edges = liveEdges(sel.bm);
    const picked = edges.filter((e) => sel.se.has(e));
    if (!picked.length) return sel.result();
    const thetaMax = f(f(thresh * f(Math.PI)) + FLT_EPSILON);
    const key = (e: BE): string => seamKey(e.v1.index, e.v2.index);
    const lengthSq = (e: BE): number => lenSq(sub(e.v1.co, e.v2.co));
    const direction = (e: BE): V3 => normalize(sub(e.v1.co, e.v2.co));
    const faceCount = (e: BE): number => radialFaces(e).length;
    // `BM_edge_calc_face_angle_with_imat3`: 90° for an edge with more than two faces.
    const faceAngle = (e: BE): number => {
      const fs = radialFaces(e);
      if (fs.length !== 2) return f((90 * Math.PI) / 180);
      return angleNormalized(normalize(faceNormal(fs[0]!)), normalize(faceNormal(fs[1]!)));
    };
    let test: (e: BE) => boolean;
    switch (type) {
      case "EDGE_FACES": {
        const set = new Set(picked.map(faceCount));
        test = (e) => compareIntSet(set, faceCount(e), compare);
        break;
      }
      case "EDGE_DIR": {
        const tree = picked.flatMap((e) => {
          const d = direction(e);
          return [d, [f(-d[0]!), f(-d[1]!), f(-d[2]!)]];
        });
        test = (e) => {
          const d = direction(e);
          const near = nearestOf(tree, d);
          return !!near && angleNormalized(d, near.co) <= thetaMax;
        };
        break;
      }
      case "EDGE_LENGTH": {
        const tree = picked.map(lengthSq);
        test = (e) => compareFloatTree(tree, lengthSq(e), thresh, compare);
        break;
      }
      case "EDGE_FACE_ANGLE": {
        const tree = picked.filter((e) => faceCount(e) >= 2).map(faceAngle);
        test = (e) => faceCount(e) >= 2 && compareFloatTree(tree, faceAngle(e), thresh, "EQUAL");
        break;
      }
      case "EDGE_CREASE": {
        const crease = (e: BE): number => f(mesh.creases?.get(key(e)) ?? 0);
        const tree = picked.map(crease);
        test = (e) => compareFloatTree(tree, crease(e), thresh, compare);
        break;
      }
      case "EDGE_SEAM":
      case "EDGE_SHARP": {
        const marks = type === "EDGE_SEAM" ? mesh.seams : mesh.sharp;
        const flag = (e: BE): boolean => !!marks?.has(key(e));
        const values = new Set(picked.map(flag));
        test = values.size === 2 ? () => true : (e) => flag(e) === values.has(true);
        break;
      }
      default:
        // EDGE_BEVEL, EDGE_FREESTYLE: no layer — every edge reads 0 / unmarked, like the selected ones.
        test = () => true;
    }
    for (const e of edges.filter((x) => !sel.se.has(x) && test(x))) sel.edge(e);
    sel.flush(mode);
    return sel.result();
  }

  const faces = liveFaces(sel.bm);
  const picked = faces.filter((x) => sel.sf.has(x));
  if (!picked.length || (type === "FACE_MATERIAL" && !mesh.materials)) return sel.result();
  const thetaMax = f(thresh * f(Math.PI));
  // `BM_face_calc_area_with_mat3` / `_perimeter_with_mat3`: from the first corner round.
  const area = (x: BF): number => {
    const n = [0, 0, 0];
    for (const l of faceLoops(x)) {
      const a = l.v.co;
      const b = l.next.v.co;
      n[0] = f(n[0]! + f(f(a[1]! - b[1]!) * f(a[2]! + b[2]!)));
      n[1] = f(n[1]! + f(f(a[2]! - b[2]!) * f(a[0]! + b[0]!)));
      n[2] = f(n[2]! + f(f(a[0]! - b[0]!) * f(a[1]! + b[1]!)));
    }
    return f(len(n) * 0.5);
  };
  const perimeter = (x: BF): number => {
    let p = 0;
    for (const l of faceLoops(x)) p = f(p + len(sub(l.v.co, l.next.v.co)));
    return p;
  };
  // `face_to_plane`: the unit normal and −(normal · first corner).
  const plane = (x: BF): number[] => {
    const n = normalize(faceNormal(x));
    return [...n, f(-dot(n, x.first!.v.co))];
  };
  let test: (x: BF) => boolean;
  switch (type) {
    case "FACE_MATERIAL": {
      const slot = (x: BF): number => mesh.materials![x.src] ?? 0;
      const set = new Set(picked.map(slot));
      test = (x) => set.has(slot(x));
      break;
    }
    case "FACE_SIDES": {
      const set = new Set(picked.map((x) => x.len));
      test = (x) => compareIntSet(set, x.len, compare);
      break;
    }
    case "FACE_AREA":
    case "FACE_PERIMETER": {
      const value = type === "FACE_AREA" ? area : perimeter;
      const tree = picked.map(value);
      test = (x) => compareFloatTree(tree, value(x), thresh, compare);
      break;
    }
    case "FACE_NORMAL": {
      const tree = picked.map((x) => normalize(faceNormal(x)));
      test = (x) => {
        const n = normalize(faceNormal(x));
        const near = nearestOf(tree, n);
        return !!near && angleNormalized(n, near.co) <= thetaMax;
      };
      break;
    }
    case "FACE_COPLANAR": {
      const tree = picked.map(plane);
      test = (x) => {
        const p = plane(x);
        const near = nearestOf(tree, p);
        if (!near || near.dist > thresh) return false;
        // `angle_v3v3` normalises both.
        return Math.abs(f(p[3]! - near.co[3]!)) <= thresh && angleNormalized(normalize(p), normalize(near.co)) <= thetaMax;
      };
      break;
    }
    default:
      // FACE_SMOOTH, FACE_FREESTYLE: no layer — every face reads flat / unmarked, like the selected ones.
      test = () => true;
  }
  for (const x of faces.filter((y) => !sel.sf.has(y) && test(y))) sel.face(x);
  sel.flush(mode);
  return sel.result();
}

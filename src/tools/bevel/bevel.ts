/**
 * Blender's bevel, ported from `source/blender/bmesh/tools/bmesh_bevel.cc` at
 * the `v5.1.1` tag — the function the Bevel modifier and `bmesh.ops.bevel`
 * both call.
 *
 * ## Why a port and not the operator that was already here
 *
 * `bevelEdges` in `edit-mode/operators.ts` was built by measurement, one shape
 * at a time, and matches Blender to 0.0000 mm on everything it accepts. What it
 * accepts is at most two beveled edges at a vertex. Three is a box's corner,
 * which is the first thing a hard-surface model asks for — "bevel every edge of
 * this block" — and it refused, correctly, because that is Blender's *vertex
 * mesh*: the patch that closes the corner, built by cubic subdivision from a
 * two-segment seed, with special cases for the cube corner, pipes, and square
 * profiles. That is not a rule anyone reads off a result. It was found on
 * 2026-09-25 by trying to model an M1911 with forge3d's operators rather than
 * `loft`, and is the reason this file exists.
 *
 * ## What is here, and what is refused
 *
 * Edge bevels, which is what the modifier does by default:
 *
 * - all five offset types (`OFFSET` `WIDTH` `DEPTH` `PERCENT` `ABSOLUTE`)
 * - any `segments`, any superellipse `profile`, including the square (1) and
 *   square-inward (0) special cases
 * - `clampOverlap` (`bevel_limit_offset`) and `loopSlide`, with the width
 *   adjustment least-squares pass (`adjust_offsets`) they imply
 * - every vertex-mesh kind the default Grid Fill method can build: POLY,
 *   TRI_FAN, ADJ (with the cube-corner, tri-corner, pipe, square-out and
 *   square-in special cases), and the two-edge weld
 * - wire edges reattached, and a material slot per face carried through
 *
 * Refused with a named error rather than approximated: the Arc and Patch
 * miters and the Cutoff vertex mesh. Not offered at all (no option to pass):
 * custom profiles and vertex-only bevels (compat-backlog C17 / C1).
 *
 * UVs, colours, vertex groups and materials are carried as Blender carries
 * them (compat-backlog A8): each new corner is `BM_loop_interp_from_face` in
 * a representative input face, snapped onto an edge first where the face is
 * across a seam, each new vertex takes its groups from the same mix (the last
 * face made at it decides), and the corners that meet at one UV vertex take
 * their mean at the end (`bevel_merge_uvs`). A "seam" here is where the UV
 * or colour breaks across an edge, read from the data. Custom normals and the
 * edge layers (creases, seams, sharp) are dropped (compat-backlog C17).
 *
 * ## Precision
 *
 * Blender computes in float. This computes in double (`./bevel-math.ts`) and
 * rounds only where Blender stores a vertex. The branches that thresholds
 * decide are kept to Blender's thresholds.
 */
import type { MeshData } from "../../lib/mesh";
import {
  type BM,
  type BV,
  type BE,
  type BF,
  type BL,
  bmFromMesh,
  bmToMesh,
  vertCreate,
  edgeCreate,
  edgeExists,
  faceCreateVerts,
  faceKill,
  vertKill,
  faceLoops,
  faceSplit,
  faceVertShareLoop,
  faceEdgeShareLoop,
  diskEdges,
  radialLoops,
  loopsOfVert,
  liveEdges,
  isManifold,
  otherVert,
  loopPair,
} from "../bmesh-lite";
import { meshVertNormals } from "../blender-math";
import { vertexGroupWeights } from "../mesh-layers";
import { axisRows, project as projectRows } from "../triangulate";
import { interpWeightsPoly2 } from "../edit-mode/interp";
import {
  type V3,
  type M4,
  copy,
  add,
  sub,
  scale,
  madd,
  negate,
  dot,
  cross,
  lenSq,
  dist,
  distSq,
  mid,
  lerp,
  isZero,
  normalize,
  normalized,
  angle,
  angle3,
  angleNormalized,
  compareFF,
  isectLineLine,
  isectLinePlane,
  closestToSegment,
  distSqToSegment,
  planeFromPointNormal,
  closestToPlaneNormalized,
  closestToPlane,
  bilinearQuad,
  mulM4V3,
  invertM4,
  leastSquares,
} from "./bevel-math";

// ── options ────────────────────────────────────────────────────────────────

/**
 * How `offset` is measured. Blender's `offset_type`:
 *
 * - `OFFSET` — the distance from the old edge to each new edge, along the face
 * - `WIDTH` — the width of the chamfer face itself
 * - `DEPTH` — how far the chamfer sits in from the old edge, perpendicular to it
 * - `PERCENT` — a percentage of each adjacent edge's length
 * - `ABSOLUTE` — a distance along each adjacent edge
 */
export type BevelOffsetType = "OFFSET" | "WIDTH" | "DEPTH" | "PERCENT" | "ABSOLUTE";

export interface BevelMeshOptions {
  /** Blender's `width` (modifier) / `offset` (operator), in the units `offsetType` names. */
  offset: number;
  /** Default `OFFSET`, the modifier's default. */
  offsetType?: BevelOffsetType;
  /** Faces across each chamfer. Default 1. */
  segments?: number;
  /**
   * Cross-section shape, 0..1. Default 0.5, a circular fillet; 0.25 is a flat
   * chamfer, 1 a square corner, 0 a square notch. `bevelEdges` documents the
   * superellipse this selects.
   */
  profile?: number;
  /**
   * Which edges. Default `{ angle: 30° }` — the modifier's default
   * `limit_method = 'ANGLE'`: every manifold edge whose faces meet more sharply
   * than this. `"all"` is `limit_method = 'NONE'`. A list of vertex-index pairs
   * is `bmesh.ops.bevel`'s `geom`: those edges, if manifold.
   *
   * `{ weights }` is `limit_method = 'WEIGHT'`: every manifold edge with a
   * non-zero **bevel weight**, beveled at `offset × weight`. Keyed
   * `"minVertex_maxVertex"` like `MeshData.creases`. This is how one pass gives
   * different edges different widths — a grip strap at 1.0 and the thin tang
   * it runs into at 0.45 — without ending a selection mid-curve, which is what
   * collapses the clamp (the clamp is global: the tightest edge limits all).
   *
   * `{ vertexGroup }` is `limit_method = 'VGROUP'`: every manifold edge whose
   * two ends weigh at least 0.5 in that vertex group (`invert` for
   * `invert_vertex_group`). The weights choose edges only; the offset is not
   * scaled (compat-backlog B5).
   */
  /**
   * `affect`: `"EDGES"` (default) bevels edges; `"VERTICES"` cuts each chosen
   * vertex off instead — every edge at it gets a boundary point `offset`
   * along it, and the corner is closed by a polygon (one segment) or a patch
   * (compat-backlog C1). Which vertices: every vertex with `edges: "all"`
   * (or the default angle limit, which vertices ignore, as in Blender), those
   * weighing 0.5 or more with `{ vertexGroup }` — and then the offset is
   * also scaled by the vertex's weight — or `vertices`.
   */
  affect?: "EDGES" | "VERTICES";
  /** With `affect: "VERTICES"`: exactly these vertices (`bmesh.ops.bevel`'s `geom`). */
  vertices?: Iterable<number>;
  edges?:
    | "all"
    | { angle: number }
    | { weights: ReadonlyMap<string, number> }
    | { vertexGroup: string; invert?: boolean }
    | Iterable<readonly [number, number]>;
  /**
   * Stop the offset where the new geometry would collide. Default **true**,
   * the modifier's default (`use_clamp_overlap`); `bmesh.ops.bevel` defaults
   * to false.
   */
  clampOverlap?: boolean;
  /**
   * Prefer sliding along an unbeveled edge to keeping the width exact.
   * Default **true**, the modifier's (`loop_slide`); the operator's is false.
   */
  loopSlide?: boolean;
  /** `miter_outer`. Only `"SHARP"` (the default) is implemented. */
  miterOuter?: "SHARP" | "PATCH" | "ARC";
  /** `miter_inner`. Only `"SHARP"` (the default) is implemented. */
  miterInner?: "SHARP" | "ARC";
  /** `vmesh_method`. Only `"ADJ"` (Grid Fill, the default) is implemented. */
  vmeshMethod?: "ADJ" | "CUTOFF";
}

/** What each output face is, in `bevel`'s own words. */
export type BevelFaceKind = "orig" | "vert" | "edge" | "recon";

export interface BevelResult {
  mesh: MeshData;
  /**
   * Per output face, aligned with `mesh.polys`: an untouched original face, a
   * corner patch (`vert`), a chamfer strip (`edge`), or an original face
   * rebuilt around new vertices (`recon`). What a caller wants for choosing a
   * smoothing or a material by role — the chamfer strips are the faces a
   * Weighted Normal modifier is meant to leave alone.
   */
  faceKind: BevelFaceKind[];
  /** The offset actually used, after `clampOverlap` — smaller than asked when it clamped. */
  offset: number;
  /**
   * Per output vertex, the input vertex it is (untouched by the bevel), or -1
   * for a vertex the bevel made. The beveled vertices themselves are gone.
   */
  origVert: number[];
}

// ── constants (bmesh_bevel.cc) ─────────────────────────────────────────────

const BEVEL_EPSILON_D = 1e-6;
const BEVEL_EPSILON = 1e-6;
const BEVEL_EPSILON_SQ = 1e-12;
const BEVEL_EPSILON_BIG = 1e-4;
const DEG = Math.PI / 180;
const BEVEL_EPSILON_ANG = 2 * DEG;
const BEVEL_SMALL_ANG = 10 * DEG;
const BEVEL_EPSILON_ANG_DOT = 1 - Math.cos(BEVEL_EPSILON_ANG);
const BEVEL_MATCH_SPEC_WEIGHT = 0.2;
const BEVEL_GOOD_ANGLE = 0.1;
const PRO_SQUARE_R = 1e4;
const PRO_CIRCLE_R = 2.0;
const PRO_LINE_R = 1.0;
const PRO_SQUARE_IN_R = 0.0;

// Plain objects, not enums: forge3d is read by Node's type stripping, which
// cannot erase an enum (`erasableSyntaxOnly` in its tsconfig).
const MeshKind = { NONE: 0, POLY: 1, ADJ: 2, TRI_FAN: 3 } as const;
type MeshKind = (typeof MeshKind)[keyof typeof MeshKind];
const FKind = { ORIG: 0, VERT: 1, EDGE: 2, RECON: 3 } as const;
type FKind = (typeof FKind)[keyof typeof FKind];
const AngleKind = { SMALLER: -1, STRAIGHT: 0, LARGER: 1 } as const;
type AngleKind = (typeof AngleKind)[keyof typeof AngleKind];

// ── structures ─────────────────────────────────────────────────────────────

interface NewVert {
  v: BV | null;
  co: V3;
}

interface EdgeHalf {
  next: EdgeHalf;
  prev: EdgeHalf;
  e: BE;
  fprev: BF | null;
  fnext: BF | null;
  leftv: BoundVert | null;
  rightv: BoundVert | null;
  profileIndex: number;
  seg: number;
  offsetL: number;
  offsetR: number;
  offsetLSpec: number;
  offsetRSpec: number;
  isBev: boolean;
  isRev: boolean;
  isSeam: boolean;
}

interface Profile {
  superR: number;
  start: V3;
  middle: V3;
  end: V3;
  planeNo: V3;
  planeCo: V3;
  projDir: V3;
  profCo: V3[] | null;
  profCo2: V3[] | null;
  specialParams: boolean;
}

interface BoundVert {
  next: BoundVert;
  prev: BoundVert;
  nv: NewVert;
  efirst: EdgeHalf | null;
  elast: EdgeHalf | null;
  eon: EdgeHalf | null;
  ebev: EdgeHalf | null;
  index: number;
  sinratio: number;
  adjchain: BoundVert | null;
  profile: Profile;
  visited: boolean;
  isArcStart: boolean;
  isPatchStart: boolean;
}

interface VMesh {
  mesh: NewVert[];
  boundstart: BoundVert | null;
  count: number;
  seg: number;
  kind: MeshKind;
}

interface BevVert {
  v: BV;
  /** `bv->offset`: the bevel's offset, scaled by the vertex's weight on a vertex bevel. */
  offset: number;
  edgecount: number;
  selcount: number;
  wirecount: number;
  anySeam: boolean;
  edges: EdgeHalf[];
  wireEdges: BE[];
  vmesh: VMesh;
}

interface ProfileSpacing {
  xvals: number[] | null;
  yvals: number[] | null;
  xvals2: number[] | null;
  yvals2: number[] | null;
  seg2: number;
  fullness: number;
}

interface Params {
  bm: BM;
  vertHash: Map<BV, BevVert>;
  faceKind: Map<BF, FKind>;
  faceMat: Map<BF, number>;
  selected: Set<BE>;
  tagged: Set<BV>;
  proSpacing: ProfileSpacing;
  offset: number;
  offsetType: BevelOffsetType;
  seg: number;
  profile: number;
  proSuperR: number;
  loopSlide: boolean;
  limitOffset: boolean;
  offsetAdjust: boolean;
  /** `use_weights` with `bweight_offset_edge`: the per-edge factor, or null when not weighting. */
  weightOf: ((e: BE) => number) | null;
  /** The corner layers and vertex groups, as `BM_mesh_bevel` carries them. */
  layers: LayerState;
  /** `affect_type == BEVEL_AFFECT_VERTICES`. */
  affectVertices: boolean;
  /** `affect_vertices_odd`: vertices, with an odd segment count. */
  affectVerticesOdd: boolean;
  /** With a vertex group on a vertex bevel: its raw weight scales each vertex's offset. */
  vertexOffsetWeight: ((v: BV) => number) | null;
}

/** One corner's values: its UV and its colour (0..1, held to bytes), where the mesh has them. */
interface CornerVal {
  uv?: number[];
  col?: number[];
}

/**
 * The layers bevel carries (compat-backlog A8). A corner's values live in
 * `corners[l.src]` — the input's corners first, then one entry per corner
 * `BM_loop_interp_from_face` fills — so `faceSplit` (the TRI_FAN corners),
 * which copies `src`, copies the values the way `BM_face_split` copies loop
 * data.
 */
interface LayerState {
  hasUv: boolean;
  hasColor: boolean;
  corners: CornerVal[];
  /** Vertex groups per vertex, or null when the mesh has none. */
  groups: Map<BV, Map<string, number>> | null;
  /** `math_layer_info.face_component`: UV-connected components, for `choose_rep_face`. */
  faceComponent: Map<BF, number> | null;
  /** `uv_face_hash`: each made face's representative input face. */
  uvFaces: Map<BF, BF | null>;
  /** `uv_vert_maps[0]`: per vertex, the buckets of corners that share a UV. Null without UVs. */
  uvVertMap: Map<BV, Set<BL>[]> | null;
}

// ── small queries ──────────────────────────────────────────────────────────

const edgeLength = (e: BE): number => dist(e.v1.co, e.v2.co);
const edgeFaceCount = (e: BE): number => radialLoops(e).length;
const isWire = (e: BE): boolean => !e.l;

/** `nearly_parallel`. */
function nearlyParallel(d1: V3, d2: V3): boolean {
  const ang = angle(d1, d2);
  return Math.abs(ang) < BEVEL_EPSILON_ANG || Math.abs(ang - Math.PI) < BEVEL_EPSILON_ANG;
}
/** `nearly_parallel_normalized`. */
const nearlyParallelNormalized = (d1: V3, d2: V3): boolean =>
  compareFF(Math.abs(dot(d1, d2)), 1, BEVEL_EPSILON_ANG_DOT);

function emptyProfile(): Profile {
  return {
    superR: PRO_LINE_R,
    start: [0, 0, 0],
    middle: [0, 0, 0],
    end: [0, 0, 0],
    planeNo: [0, 0, 0],
    planeCo: [0, 0, 0],
    projDir: [0, 0, 0],
    profCo: null,
    profCo2: null,
    specialParams: false,
  };
}

/** `add_new_bound_vert`: appended at the tail of the cycle. */
function addNewBoundVert(vm: VMesh, co: V3): BoundVert {
  const ans = {
    nv: { v: null, co: copy(co) },
    efirst: null,
    elast: null,
    eon: null,
    ebev: null,
    index: 0,
    sinratio: 1,
    adjchain: null,
    profile: emptyProfile(),
    visited: false,
    isArcStart: false,
    isPatchStart: false,
  } as unknown as BoundVert;
  if (!vm.boundstart) {
    ans.index = 0;
    vm.boundstart = ans;
    ans.next = ans.prev = ans;
  } else {
    const tail = vm.boundstart.prev;
    ans.index = tail.index + 1;
    ans.prev = tail;
    ans.next = vm.boundstart;
    tail.next = ans;
    vm.boundstart.prev = ans;
  }
  vm.count++;
  return ans;
}

/** `mesh_vert`: (boundvert i, ring j, segment k). */
function meshVert(vm: VMesh, i: number, j: number, k: number): NewVert {
  const nj = Math.floor(vm.seg / 2) + 1;
  const nk = vm.seg + 1;
  return vm.mesh[i * nk * nj + j * nk + k]!;
}

function allocMesh(count: number, seg: number): NewVert[] {
  const n = count * (1 + Math.floor(seg / 2)) * (1 + seg);
  return Array.from({ length: n }, () => ({ v: null, co: [0, 0, 0] as V3 }));
}

/** `create_mesh_bmvert`: the new vertex copies `eg`'s data (`BM_vert_create` with an example). */
function createMeshBMVert(p: Params, vm: VMesh, i: number, j: number, k: number, eg: BV): void {
  const nv = meshVert(vm, i, j, k);
  nv.v = vertCreate(p.bm, nv.co);
  const g = p.layers.groups;
  if (g) g.set(nv.v, new Map(g.get(eg)));
}

function copyMeshVert(vm: VMesh, ito: number, jto: number, kto: number, ifrom: number, jfrom: number, kfrom: number): void {
  const to = meshVert(vm, ito, jto, kto);
  const from = meshVert(vm, ifrom, jfrom, kfrom);
  to.v = from.v;
  to.co = copy(from.co);
}

const findEdgeHalf = (bv: BevVert, bme: BE): EdgeHalf | null => bv.edges.find((e) => e.e === bme) ?? null;

/** `find_other_end_edge_half`. */
function findOtherEndEdgeHalf(p: Params, e: EdgeHalf): { eh: EdgeHalf | null; bv: BevVert | null } {
  const bvo = p.vertHash.get(e.isRev ? e.e.v1 : e.e.v2);
  if (bvo) return { eh: findEdgeHalf(bvo, e.e), bv: bvo };
  return { eh: null, bv: null };
}

/** `next_bev`. */
function nextBev(bv: BevVert, fromE: EdgeHalf | null): EdgeHalf | null {
  const from = fromE ?? bv.edges[bv.edgecount - 1]!;
  let e = from;
  do {
    if (e.isBev) return e;
  } while ((e = e.next) !== from);
  return null;
}

/** `count_ccw_edges_between`. */
function countCcwEdgesBetween(e1: EdgeHalf, e2: EdgeHalf): number {
  let count = 0;
  let e = e1;
  do {
    if (e === e2) break;
    e = e.next;
    count++;
  } while (e !== e1);
  return count;
}

/** `edges_face_connected_at_vert`. */
function edgesFaceConnectedAtVert(bme1: BE, bme2: BE): boolean {
  for (const l of radialLoops(bme1)) if (l.prev.e === bme2 || l.next.e === bme2) return true;
  return false;
}

// ── representative faces (for the material slot only) ─────────────────────

/** `BM_face_calc_center_bounds`. */
function faceCenterBounds(f: BF): V3 {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const l of faceLoops(f))
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a]!, l.v.co[a]!);
      hi[a] = Math.max(hi[a]!, l.v.co[a]!);
    }
  return mid(lo, hi);
}

/**
 * `choose_rep_face`. The selection tie-breaker is a constant: nothing here
 * is selected, and the modifier's mesh has no selection either.
 */
function chooseRepFace(p: Params, faces: (BF | null)[]): BF | null {
  const vals: number[][] = [];
  const viable = faces.map((f) => f !== null);
  let numViable = viable.filter(Boolean).length;
  faces.forEach((f, i) => {
    if (!f) return;
    const c = faceCenterBounds(f);
    vals[i] = [p.layers.faceComponent?.get(f) ?? 0, 1, p.faceMat.get(f) ?? 0, c[2], c[0], c[1]];
  });
  let best = -1;
  for (let vi = 0; numViable > 1 && vi < 6; vi++) {
    for (let f = 0; f < faces.length; f++) {
      if (!viable[f] || f === best) continue;
      if (best === -1) {
        best = f;
        continue;
      }
      if (vals[f]![vi]! < vals[best]![vi]!) {
        best = f;
        for (let i = f - 1; i >= 0; i--)
          if (viable[i]) {
            viable[i] = false;
            numViable--;
          }
      } else if (vals[f]![vi]! > vals[best]![vi]!) {
        viable[f] = false;
        numViable--;
      }
    }
  }
  if (best === -1) best = 0;
  return faces[best] ?? null;
}

/** `boundvert_rep_face`. */
function boundvertRepFace(v: BoundVert): BF | null {
  if (v.ebev) return v.ebev.fprev;
  if (v.efirst) {
    if (v.efirst.fprev) return v.efirst.fprev;
    if (v.efirst.fnext) return v.efirst.fnext;
    if (v.elast!.fprev) return v.elast!.fprev;
    return null;
  }
  if (v.prev.elast) {
    const frep = v.prev.elast.fnext;
    if (frep) return frep;
    if (v.next.efirst) return v.next.efirst.fprev;
    return null;
  }
  return null;
}

/**
 * `frep_for_center_poly`. With a UV layer, a face that would give the centre
 * polygon a zero-area UV polygon is not a candidate (`is_bad_uv_poly`).
 */
function frepForCenterPoly(p: Params, bv: BevVert): BF | null {
  const considerAll = bv.selcount === 1 || p.affectVerticesOdd;
  const choices: BF[] = [];
  let any: BF | null = null;
  for (const e of bv.edges) {
    if (!e.isBev && !considerAll) continue;
    const bmf = chooseRepFace(p, [e.fprev, e.fnext]);
    if (!bmf) continue;
    any ??= bmf;
    if (!choices.includes(bmf)) {
      if (p.layers.hasUv && projectedBoundaryArea(bv, bmf) < BEVEL_EPSILON_BIG) continue;
      choices.push(bmf);
    }
  }
  if (choices.length === 0) return any;
  return chooseRepFace(p, choices);
}

/** `get_incident_edges`: the (first two) edges of `f` at `v`. */
function incidentEdges(f: BF, v: BV): [BE | null, BE | null] {
  let e1: BE | null = null;
  let e2: BE | null = null;
  for (const l of faceLoops(f)) {
    const e = l.e!;
    if (e.v1 === v || e.v2 === v) {
      if (!e1) e1 = e;
      else if (!e2) e2 = e;
    }
  }
  return [e1, e2];
}

/** `find_closer_edge`. */
const closerEdge = (co: readonly number[], e1: BE, e2: BE): BE =>
  distSqToSegment(co, e1.v1.co, e1.v2.co) < distSqToSegment(co, e2.v1.co, e2.v2.co) ? e1 : e2;

/** `isect_point_poly_v2`: crossing-number point-in-polygon. */
/** `isect_point_poly_v2`, in float as Blender runs it. */
function isectPointPoly2(pt: readonly number[], verts: readonly (readonly number[])[]): boolean {
  const ff = Math.fround;
  let isect = false;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    const vi = verts[i]!;
    const vj = verts[j]!;
    if (
      vi[1]! > pt[1]! !== vj[1]! > pt[1]! &&
      pt[0]! < ff(ff(ff(ff(vj[0]! - vi[0]!) * ff(pt[1]! - vi[1]!)) / ff(vj[1]! - vi[1]!)) + vi[0]!)
    )
      isect = !isect;
  }
  return isect;
}

/**
 * `BM_face_point_inside_test`, in float: the projection (`mul_v2_m3v3`) and
 * the crossing test. A vertex bevel's boundary points lie **on** the face's
 * edges, so whether one counts as inside is decided by the rounding — in
 * double it went the other way on `gridUV`'s rim and moved the centre
 * polygon's UVs by up to 1e-3 (compat-backlog C1).
 */
function facePointInside(f: BF, co: readonly number[]): boolean {
  const ff = Math.fround;
  const rows = axisRows(copy(f.no), false);
  const proj = (a: readonly number[]): number[] =>
    rows.map((m) => ff(ff(ff(m[0]! * ff(a[0]!)) + ff(m[1]! * ff(a[1]!))) + ff(m[2]! * ff(a[2]!))));
  return isectPointPoly2(proj(co), faceLoops(f).map((l) => proj(l.v.co)));
}

/** `find_face_internal_boundverts`: up to three BoundVerts inside `f`'s projection. */
function faceInternalBoundverts(bv: BevVert, f: BF | null): BoundVert[] {
  const out: BoundVert[] = [];
  if (!f) return out;
  let v = bv.vmesh.boundstart!;
  do {
    if (facePointInside(f, v.nv.co)) {
      out.push(v);
      if (out.length === 3) break;
    }
  } while ((v = v.next) !== bv.vmesh.boundstart);
  return out;
}

/** `projected_boundary_area`: the boundary, snapped into `f`, projected, measured. */
function projectedBoundaryArea(bv: BevVert, f: BF): number {
  const rows = axisRows(copy(f.no), false);
  const [e1, e2] = incidentEdges(f, bv.v);
  if (!e1 || !e2) return 0;
  const unsnapped = faceInternalBoundverts(bv, f);
  const proj: number[][] = [];
  let v = bv.vmesh.boundstart!;
  do {
    const co = v.nv.v!.co;
    if (unsnapped.includes(v)) proj.push(projectRows(rows, copy(co)));
    else {
      const s1 = closestToSegment(co, e1.v1.co, e1.v2.co);
      const s2 = closestToSegment(co, e2.v1.co, e2.v2.co);
      proj.push(projectRows(rows, distSq(s1, co) <= distSq(s2, co) ? s1 : s2));
    }
  } while ((v = v.next) !== bv.vmesh.boundstart);
  let cross = 0;
  for (let i = 0, j = proj.length - 1; i < proj.length; j = i++)
    cross += (proj[j]![0]! - proj[i]![0]!) * (proj[j]![1]! + proj[i]![1]!);
  return Math.abs(0.5 * cross);
}

/** A byte colour channel mixed as `layerInterp_mloopcol` does: summed, rounded, clamped. */
const toByte = (x: number): number => (x <= 0 ? 0 : x > 254.5 ? 255 : Math.floor(x + 0.5));

/**
 * `BM_loop_interp_from_face(bm, l, fSrc, true, true)`: `l`'s corner values are
 * the mean-value mix of `fSrc`'s at `l.v` projected into `fSrc`'s plane, and
 * `l.v`'s vertex groups become the same mix of `fSrc`'s vertices' — every
 * time, so the last face made at a vertex decides its groups. `at` is where
 * to measure from, when the caller snaps the vertex to an edge first.
 */
function loopInterpFromFace(p: Params, l: BL, fSrc: BF, at: readonly number[]): void {
  const L = p.layers;
  const rows = axisRows(copy(fSrc.no), false);
  const src = faceLoops(fSrc);
  const w = interpWeightsPoly2(
    src.map((s) => projectRows(rows, s.v.co) as [number, number]),
    projectRows(rows, copy(at)) as [number, number],
  );
  const val: CornerVal = {};
  if (L.hasUv) {
    let u = 0;
    let v = 0;
    src.forEach((s, i) => {
      const x = L.corners[s.src]?.uv ?? [0, 0];
      u += w[i]! * x[0]!;
      v += w[i]! * x[1]!;
    });
    val.uv = [u, v];
  }
  if (L.hasColor) {
    const col: number[] = [0, 0, 0, 0];
    src.forEach((s, i) => {
      const x = L.corners[s.src]?.col ?? [1, 1, 1, 1];
      for (let c = 0; c < 4; c++) col[c] = col[c]! + w[i]! * Math.round(x[c]! * 255);
    });
    val.col = col.map((c) => toByte(c) / 255);
  }
  l.src = L.corners.length;
  L.corners.push(val);
  if (L.groups) {
    // `layerInterp_mdeformvert`: a source adds a group only where its weight
    // times the factor is not zero; the sum is capped at 1. Sources are read
    // before the vertex is written, since it can be one of them.
    const out = new Map<string, number>();
    src.forEach((s, i) => {
      for (const [name, x] of L.groups!.get(s.v) ?? []) {
        const v = x * w[i]!;
        if (v === 0) continue;
        out.set(name, (out.get(name) ?? 0) + v);
      }
    });
    for (const [name, v] of out) out.set(name, Math.min(v, 1));
    L.groups.set(l.v, out);
  }
}

/**
 * `bev_create_ngon`: every face bevel makes goes through here. The first of
 * `faceArr` or `facerep` lends its material, as `BM_elem_attrs_copy` does,
 * and each corner is interpolated in its `faceArr` entry (else `facerep`),
 * measured from its vertex snapped onto `snapEdges[i]` where there is one.
 * `bv` / `nvBvMap` name the input vertex each new one stands for, for the
 * UV buckets (`update_uv_vert_map`).
 */
function bevCreateNgon(
  p: Params,
  verts: BV[],
  faceArr: (BF | null)[] | null,
  facerep: BF | null,
  kind: FKind,
  snapEdges: (BE | null)[] | null = null,
  bv: BV | null = null,
  nvBvMap: Map<BV, BV> | null = null,
): BF | null {
  if (verts.length < 3) return null;
  const rep = facerep ?? (faceArr ? faceArr[0] ?? null : null);
  const f = faceCreateVerts(p.bm, verts, null);
  if (rep) {
    p.faceMat.set(f, p.faceMat.get(rep) ?? 0);
    faceLoops(f).forEach((l, i) => {
      const interpF = faceArr ? faceArr[i] ?? null : facerep;
      if (!interpF) return;
      const bme = snapEdges?.[i] ?? null;
      loopInterpFromFace(p, l, interpF, bme ? closestToSegment(l.v.co, bme.v1.co, bme.v2.co) : l.v.co);
    });
  }
  f.tag = true;
  if (kind !== FKind.ORIG) p.faceKind.set(f, kind);
  // `register_uv_face` + `update_uv_vert_map`.
  const attached = faceArr && faceArr[0] ? faceArr[0] : facerep;
  p.layers.uvFaces.set(f, attached);
  updateUvVertMap(p, f, attached, bv, nvBvMap);
  return f;
}

/** `update_uv_vert_map`: file each corner of `f` in a bucket of corners that will share a UV. */
function updateUvVertMap(p: Params, f: BF, attached: BF | null, bv: BV | null, nvBvMap: Map<BV, BV> | null): void {
  const map = p.layers.uvVertMap;
  if (!map || !attached) return;
  for (const l of faceLoops(f)) {
    const buckets = map.get(l.v);
    if (!buckets) {
      map.set(l.v, [new Set([l])]);
      continue;
    }
    const origV = nvBvMap ? nvBvMap.get(l.v) ?? null : bv;
    const origL = origV ? faceVertShareLoop(attached, origV) : null;
    let found = false;
    for (const l2 of loopsOfVert(l.v)) {
      if (l2 === l) continue;
      const attached2 = p.layers.uvFaces.get(l2.f);
      if (!attached2) continue;
      const origL2 = origV ? faceVertShareLoop(attached2, origV) : null;
      const origBuckets = origV ? map.get(origV) ?? [] : [];
      const connected = origBuckets.some((b) => b.has(origL!) && b.has(origL2!));
      if (attached === attached2 || connected) {
        for (const b of buckets)
          if (b.has(l2)) {
            b.add(l);
            found = true;
            break;
          }
      }
      if (found) break;
    }
    if (!found) buckets.push(new Set([l]));
  }
}

/** `determine_uv_vert_connectivity`: bucket an input vertex's corners by UV (0.0001 apart per axis). */
function determineUvVertConnectivity(p: Params, v: BV): void {
  const map = p.layers.uvVertMap;
  if (!map) return;
  const uvOf = (l: BL): number[] => p.layers.corners[l.src]?.uv ?? [0, 0];
  const buckets: Set<BL>[] = [];
  for (const l of loopsOfVert(v)) {
    const a = uvOf(l);
    let found = false;
    for (const b of buckets) {
      for (const l2 of b) {
        const c = uvOf(l2);
        if (Math.abs(a[0]! - c[0]!) <= 0.0001 && Math.abs(a[1]! - c[1]!) <= 0.0001) {
          b.add(l);
          found = true;
          break;
        }
      }
      if (found) break;
    }
    if (!found) buckets.push(new Set([l]));
  }
  map.set(v, buckets);
}

/** `bevel_merge_uvs`: the corners in one bucket take their mean UV. */
function bevelMergeUvs(p: Params): void {
  const map = p.layers.uvVertMap;
  if (!map) return;
  const C = p.layers.corners;
  for (const buckets of map.values())
    for (const b of buckets) {
      if (b.size <= 1) continue;
      let u = 0;
      let v = 0;
      for (const l of b) {
        const x = C[l.src]?.uv ?? [0, 0];
        u += x[0]!;
        v += x[1]!;
      }
      const uv = [u / b.size, v / b.size];
      for (const l of b) {
        const old = C[l.src] ?? {};
        l.src = C.length;
        C.push({ ...old, uv: [...uv] });
      }
    }
}

/**
 * `math_layer_info_init`'s face components: faces joined across edges where
 * the UV and colour run on, numbered by their first face, then renumbered so
 * the topmost face's component is 0 and the bottom-most's 1.
 */
function uvFaceComponents(p: Params, faces: BF[]): Map<BF, number> {
  const comp = new Map<BF, number>();
  let current = -1;
  for (const seed of faces) {
    if (comp.has(seed)) continue;
    current++;
    const stack = [seed];
    const inStack = new Set([seed]);
    while (stack.length) {
      const f = stack.pop()!;
      inStack.delete(f);
      if (comp.has(f)) continue;
      comp.set(f, current);
      for (const l of faceLoops(f))
        for (const l2 of radialLoops(l.e!)) {
          const other = l2.f;
          if (other === f || comp.has(other) || inStack.has(other)) continue;
          if (contigAcrossEdge(p, l.e!, f, other)) {
            stack.push(other);
            inStack.add(other);
          }
        }
    }
  }
  if (current <= 0) return comp;
  let topZ = -1e30;
  let botZ = 1e30;
  let topC = -1;
  let botC = -1;
  for (const f of faces) {
    const z = faceCenterBounds(f)[2];
    if (z > topZ) {
      topZ = z;
      topC = comp.get(f)!;
    }
    if (z < botZ) {
      botZ = z;
      botC = comp.get(f)!;
    }
  }
  const swap = (c1: number, c2: number): void => {
    if (c1 === c2) return;
    for (const [f, c] of comp) comp.set(f, c === c1 ? c2 : c === c2 ? c1 : c);
  };
  swap(comp.get(faces[0]!)!, topC);
  if (botC !== topC) {
    if (botC === 0) botC = topC;
    swap(comp.get(faces[1]!)!, botC);
  }
  return comp;
}

/** `contig_ldata_across_edge`: are the UV and colour continuous from `f1` to `f2` over `e`? */
function contigAcrossEdge(p: Params, e: BE, f1: BF, f2: BF): boolean {
  const L = p.layers;
  if (!L.hasUv && !L.hasColor) return true;
  const pair = loopPair(e);
  if (!pair) return false;
  let [lef1, lef2] = pair;
  if (lef1.f === f2) [lef1, lef2] = [lef2, lef1];
  if (lef1.f !== f1 || lef2.f !== f2) return false;
  if (lef1.v === lef2.v) return false;
  const same = (a: BL, b: BL): boolean => {
    const x = L.corners[a.src];
    const y = L.corners[b.src];
    if (L.hasUv) {
      const u = x?.uv ?? [0, 0];
      const w = y?.uv ?? [0, 0];
      // `layerEqual_propfloat2`.
      if ((u[0]! - w[0]!) ** 2 + (u[1]! - w[1]!) ** 2 >= 0.00001) return false;
    }
    if (L.hasColor) {
      const u = x?.col ?? [1, 1, 1, 1];
      const w = y?.col ?? [1, 1, 1, 1];
      // `layerEqual_mloopcol`, on bytes.
      let d = 0;
      for (let c = 0; c < 4; c++) d += (Math.round(u[c]! * 255) - Math.round(w[c]! * 255)) ** 2;
      if (d >= 0.001) return false;
    }
    return true;
  };
  return same(lef1, lef2.next) && same(lef1.next, lef2);
}

// ── offsets ────────────────────────────────────────────────────────────────

/** `slide_dist`: the point `d` from `v` along `e` (short of its far end). */
function slideDist(e: EdgeHalf | { e: BE }, v: BV, d: number): V3 {
  const dir = sub(v.co, otherVert(e.e, v).co);
  const l = normalize(dir);
  if (d > l) d = l - 50 * BEVEL_EPSILON_D;
  return madd(v.co, dir, -d);
}

/** `is_outside_edge`. */
function isOutsideEdge(e: EdgeHalf, co: V3): BV | null {
  const l1 = e.e.v1.co;
  const u = sub(e.e.v2.co, l1);
  const h = sub(co, l1);
  const lenu = normalize(u);
  const lambda = dot(u, h);
  if (lambda <= -BEVEL_EPSILON_BIG * lenu) return e.e.v1;
  if (lambda >= (1 + BEVEL_EPSILON_BIG) * lenu) return e.e.v2;
  return null;
}

/** `edges_angle_kind`. */
function edgesAngleKind(e1: EdgeHalf, e2: EdgeHalf, v: BV): AngleKind {
  const dir1 = normalized(sub(v.co, otherVert(e1.e, v).co));
  const dir2 = normalized(sub(v.co, otherVert(e2.e, v).co));
  if (nearlyParallelNormalized(dir1, dir2)) return AngleKind.STRAIGHT;
  const c = normalized(cross(dir1, dir2));
  const no = e1.fnext ? e1.fnext.no : e2.fprev ? e2.fprev.no : v.no;
  if (dot(c, no) < 0) return AngleKind.LARGER;
  return AngleKind.SMALLER;
}

/** `point_between_edges`. */
function pointBetweenEdges(co: V3, v: BV, f: BF, e1: EdgeHalf, e2: EdgeHalf): boolean {
  const dir1 = normalized(sub(v.co, otherVert(e1.e, v).co));
  const dir2 = normalized(sub(v.co, otherVert(e2.e, v).co));
  const dirco = normalized(sub(v.co, co));
  let ang11 = angleNormalized(dir1, dir2);
  let ang1co = angleNormalized(dir1, dirco);
  if (dot(cross(dir1, dir2), f.no) < 0) ang11 = Math.PI * 2 - ang11;
  if (dot(cross(dir1, dirco), f.no) < 0) ang1co = Math.PI * 2 - ang1co;
  return ang11 - ang1co > -BEVEL_EPSILON_ANG;
}

/** `edge_edge_angle_less_than_180`. */
function edgeEdgeAngleLessThan180(e1: BE, e2: BE, f: BF): boolean {
  let v: BV, v1: BV, v2: BV;
  if (e1.v1 === e2.v1) [v, v1, v2] = [e1.v1, e1.v2, e2.v2];
  else if (e1.v1 === e2.v2) [v, v1, v2] = [e1.v1, e1.v2, e2.v1];
  else if (e1.v2 === e2.v1) [v, v1, v2] = [e1.v2, e1.v1, e2.v2];
  else if (e1.v2 === e2.v2) [v, v1, v2] = [e1.v2, e1.v1, e2.v1];
  else return false;
  return dot(cross(sub(v1.co, v.co), sub(v2.co, v.co)), f.no) > 0;
}

/** `offset_meet_lines_percent_or_absolute`. */
function offsetMeetLinesPercentOrAbsolute(p: Params, e1: EdgeHalf, e2: EdgeHalf, v: BV): [V3, V3, V3, V3] {
  const v1 = otherVert(e1.e, v);
  const v2 = otherVert(e2.e, v);
  const f1 = e1.fnext;
  const f2 = e2.fprev;
  let noOffsets = f1 === null || f2 === null;
  if (!noOffsets) {
    const e0 = faceVertShareLoop(f1!, v1)!.e!;
    const e3 = faceVertShareLoop(f2!, v2)!.prev.e!;
    const e4 = faceVertShareLoop(f1!, v)!.prev.e!;
    const e5 = faceVertShareLoop(f2!, v)!.e!;
    noOffsets =
      !edgeEdgeAngleLessThan180(e0, e1.e, f1!) ||
      !edgeEdgeAngleLessThan180(e1.e, e4, f1!) ||
      !edgeEdgeAngleLessThan180(e2.e, e3, f2!) ||
      !edgeEdgeAngleLessThan180(e5, e2.e, f1!);
    if (!noOffsets) {
      let d0: number, d3: number, d4: number, d5: number;
      if (p.offsetType === "ABSOLUTE") d0 = d3 = d4 = d5 = p.offset;
      else {
        d0 = (p.offset * edgeLength(e0)) / 100;
        d3 = (p.offset * edgeLength(e3)) / 100;
        d4 = (p.offset * edgeLength(e4)) / 100;
        d5 = (p.offset * edgeLength(e5)) / 100;
      }
      const e1wt = p.weightOf ? p.weightOf(e1.e) : 1;
      const e2wt = p.weightOf ? p.weightOf(e2.e) : 1;
      return [
        slideDist({ e: e4 }, v, d4 * e1wt),
        slideDist({ e: e0 }, v1, d0 * e1wt),
        slideDist({ e: e5 }, v, d5 * e2wt),
        slideDist({ e: e3 }, v2, d3 * e2wt),
      ];
    }
  }
  return [copy(v.co), copy(v1.co), copy(v.co), copy(v2.co)];
}

/**
 * `offset_meet`: where the offset lines of `e1` (entering `v`) and `e2`
 * (leaving it) cross — on the bisector when the offsets are equal.
 */
function offsetMeet(
  p: Params,
  e1: EdgeHalf,
  e2: EdgeHalf,
  v: BV,
  f: BF | null,
  edgesBetween: boolean,
  eInPlane: EdgeHalf | null,
): V3 {
  let dir1 = sub(v.co, otherVert(e1.e, v).co);
  const dir2 = sub(otherVert(e2.e, v).co, v.co);
  let dir1n: V3 = [0, 0, 0];
  let dir2p: V3 = [0, 0, 0];
  if (edgesBetween) {
    dir1n = sub(otherVert(e1.next.e, v).co, v.co);
    dir2p = sub(v.co, otherVert(e2.prev.e, v).co);
  }
  let ang = angle(dir1, dir2);
  let meetco: V3;
  if (ang < BEVEL_EPSILON_ANG) {
    let normV: V3;
    if (f) normV = copy(f.no);
    else {
      let fcount = 0;
      normV = [0, 0, 0];
      for (let eloop = e1; eloop !== e2; eloop = eloop.next)
        if (eloop.fnext) {
          normV = add(normV, eloop.fnext.no);
          fcount++;
        }
      normV = fcount === 0 ? copy(v.no) : scale(normV, 1 / fcount);
    }
    dir1 = add(dir1, dir2);
    const normPerp1 = normalized(cross(dir1, normV));
    let d = Math.max(e1.offsetR, e2.offsetL);
    d = d / Math.cos(ang / 2);
    meetco = madd(v.co, normPerp1, d);
  } else if (Math.abs(ang - Math.PI) < BEVEL_EPSILON_ANG) {
    const d = Math.max(e1.offsetR, e2.offsetL);
    meetco = slideDist(e2, v, d);
  } else {
    let normV1: V3, normV2: V3;
    if (f && ang < BEVEL_SMALL_ANG) {
      normV1 = copy(f.no);
      normV2 = copy(f.no);
    } else if (!edgesBetween) {
      normV1 = normalized(cross(dir2, dir1));
      if (dot(normV1, f ? f.no : v.no) < 0) normV1 = negate(normV1);
      normV2 = copy(normV1);
    } else {
      normV1 = normalized(cross(dir1n, dir1));
      let ff = e1.fnext;
      if (dot(normV1, ff ? ff.no : v.no) < 0) normV1 = negate(normV1);
      normV2 = normalized(cross(dir2, dir2p));
      ff = e2.fprev;
      if (dot(normV2, ff ? ff.no : v.no) < 0) normV2 = negate(normV2);
    }
    const normPerp1 = normalized(cross(dir1, normV1));
    const normPerp2 = normalized(cross(dir2, normV2));
    let off1a: V3, off1b: V3, off2a: V3, off2b: V3;
    if (p.offsetType === "PERCENT" || p.offsetType === "ABSOLUTE") {
      [off1a, off1b, off2a, off2b] = offsetMeetLinesPercentOrAbsolute(p, e1, e2, v);
    } else {
      off1a = madd(v.co, normPerp1, e1.offsetR);
      off1b = add(off1a, dir1);
      off2a = madd(v.co, normPerp2, e2.offsetL);
      off2b = add(off2a, dir2);
    }
    const isect = isectLineLine(off1a, off1b, off2a, off2b);
    if (isect.kind === 0) {
      meetco = copy(off1a);
    } else {
      meetco = isect.i1;
      if (e1.offsetR === 0) {
        const closer = isOutsideEdge(e1, meetco);
        if (closer) meetco = copy(closer.co);
      }
      if (e2.offsetL === 0) {
        const closer = isOutsideEdge(e2, meetco);
        if (closer) meetco = copy(closer.co);
      }
      if (edgesBetween && e1.offsetR > 0 && e2.offsetL > 0) {
        if (isect.kind === 2) meetco = mid(meetco, isect.i2);
        for (let e = e1; e !== e2; e = e.next) {
          const fnext = e.fnext;
          if (!fnext) continue;
          const plane = planeFromPointNormal(v.co, fnext.no);
          const dropco = closestToPlaneNormalized(plane, meetco);
          if (eInPlane) {
            ang = angle(fnext.no, eInPlane.fnext!.no);
            if (Math.abs(ang) < BEVEL_SMALL_ANG || Math.abs(ang - Math.PI) < BEVEL_SMALL_ANG) continue;
          }
          if (pointBetweenEdges(dropco, v, fnext, e, e.next)) {
            meetco = dropco;
            break;
          }
        }
      }
    }
  }
  return meetco;
}

/** `offset_meet_edge`: where the one offset line of `e1`/`e2` meets the other edge. */
function offsetMeetEdge(e1: EdgeHalf, e2: EdgeHalf, v: BV): { ok: boolean; meetco: V3; angle: number } {
  const dir1 = normalized(sub(otherVert(e1.e, v).co, v.co));
  const dir2 = normalized(sub(otherVert(e2.e, v).co, v.co));
  let ang = angleNormalized(dir1, dir2);
  if (Math.abs(ang) < BEVEL_GOOD_ANGLE) return { ok: false, meetco: [0, 0, 0], angle: 0 };
  const fno = cross(dir1, dir2);
  if (dot(fno, v.no) < 0) {
    ang = 2 * Math.PI - ang;
    return { ok: false, meetco: [0, 0, 0], angle: ang };
  }
  if (Math.abs(ang - Math.PI) < BEVEL_GOOD_ANGLE) return { ok: false, meetco: [0, 0, 0], angle: ang };
  const sinang = Math.sin(ang);
  const meetco = e1.offsetR === 0 ? madd(v.co, dir1, e2.offsetL / sinang) : madd(v.co, dir2, e1.offsetR / sinang);
  return { ok: true, meetco, angle: ang };
}

/** `good_offset_on_edge_between`. */
const goodOffsetOnEdgeBetween = (e1: EdgeHalf, e2: EdgeHalf, emid: EdgeHalf, v: BV): boolean =>
  offsetMeetEdge(e1, emid, v).ok && offsetMeetEdge(emid, e2, v).ok;

/** `offset_on_edge_between`: the meet point placed on `emid`, and the ratio of sines. */
function offsetOnEdgeBetween(
  p: Params,
  e1: EdgeHalf,
  e2: EdgeHalf,
  emid: EdgeHalf,
  v: BV,
): { placed: boolean; meetco: V3; sinratio: number } {
  const m1 = offsetMeetEdge(e1, emid, v);
  const m2 = offsetMeetEdge(emid, e2, v);
  const ratio = m1.angle === 0 ? 1 : Math.sin(m2.angle) / Math.sin(m1.angle);
  if (p.offsetType === "PERCENT" || p.offsetType === "ABSOLUTE") {
    const v2 = otherVert(emid.e, v);
    let meetco: V3;
    const wt = p.weightOf ? 0.5 * (p.weightOf(e1.e) + p.weightOf(e2.e)) : 1;
    if (p.offsetType === "PERCENT") meetco = lerp(v.co, v2.co, (wt * p.offset) / 100);
    else meetco = madd(v.co, normalized(sub(v2.co, v.co)), p.offset);
    return { placed: true, meetco, sinratio: ratio };
  }
  if (m1.ok && m2.ok) return { placed: true, meetco: mid(m1.meetco, m2.meetco), sinratio: ratio };
  if (m1.ok) return { placed: false, meetco: m1.meetco, sinratio: 1 };
  if (m2.ok) return { placed: false, meetco: m2.meetco, sinratio: 1 };
  return { placed: false, meetco: slideDist(emid, v, e1.offsetR), sinratio: 1 };
}

/** `offset_in_plane`. */
function offsetInPlane(e: EdgeHalf, planeNo: V3 | null, left: boolean): V3 {
  const v = e.isRev ? e.e.v2 : e.e.v1;
  const dir = normalized(sub(otherVert(e.e, v).co, v.co));
  let no: V3;
  if (planeNo) no = copy(planeNo);
  else {
    no = [0, 0, 0];
    if (Math.abs(dir[0]) < Math.abs(dir[1])) no[0] = 1;
    else no[1] = 1;
  }
  const fdir = normalized(left ? cross(dir, no) : cross(no, dir));
  return madd(v.co, fdir, left ? e.offsetL : e.offsetR);
}

/** `project_to_edge`. */
function projectToEdge(e: BE, coA: V3, coB: V3): V3 {
  const r = isectLineLine(e.v1.co, e.v2.co, coA, coB);
  if (r.kind === 0) return copy(e.v1.co);
  return r.i1;
}

// ── profiles ───────────────────────────────────────────────────────────────

/** `set_profile_params`. */
function setProfileParams(p: Params, bv: BevVert, bndv: BoundVert): void {
  let doLinearInterp = true;
  const e = bndv.ebev;
  const pro = bndv.profile;
  const start = copy(bndv.nv.co);
  const end = copy(bndv.next.nv.co);
  if (e) {
    doLinearInterp = false;
    pro.superR = p.proSuperR;
    pro.projDir = sub(e.e.v1.co, e.e.v2.co);
    if (e.isRev) pro.projDir = negate(pro.projDir);
    normalize(pro.projDir);
    pro.middle = projectToEdge(e.e, start, end);
    pro.start = copy(start);
    pro.end = copy(end);
    let d1 = normalized(sub(pro.middle, start));
    let d2 = normalized(sub(pro.middle, end));
    pro.planeNo = normalized(cross(d1, d2));
    if (nearlyParallel(d1, d2)) {
      pro.middle = copy(bv.v.co);
      if (e.prev.isBev && e.next.isBev && bv.selcount >= 3) {
        const d3 = normalized(sub(e.prev.e.v1.co, e.prev.e.v2.co));
        const d4 = normalized(sub(e.next.e.v1.co, e.next.e.v2.co));
        if (nearlyParallel(d3, d4)) {
          pro.middle = mid(start, end);
          doLinearInterp = true;
        } else {
          const co3 = add(start, d3);
          const co4 = add(end, d4);
          const r = isectLineLine(start, co3, end, co4);
          if (r.kind !== 0) pro.middle = r.i1;
          else {
            pro.middle = mid(start, end);
            doLinearInterp = true;
          }
        }
      }
      pro.end = copy(end);
      d1 = normalized(sub(pro.middle, start));
      d2 = normalized(sub(pro.middle, end));
      pro.planeNo = normalized(cross(d1, d2));
      if (nearlyParallel(d1, d2)) doLinearInterp = true;
      else {
        pro.planeCo = copy(bv.v.co);
        pro.projDir = copy(pro.planeNo);
      }
    }
    pro.planeCo = copy(start);
  } else if (bndv.isArcStart) {
    pro.start = copy(start);
    pro.end = copy(end);
    pro.superR = PRO_CIRCLE_R;
    pro.planeCo = [0, 0, 0];
    pro.planeNo = [0, 0, 0];
    pro.projDir = [0, 0, 0];
    doLinearInterp = false;
  } else if (p.affectVertices) {
    // A vertex bevel's profile bulges toward the vertex it cuts off.
    pro.start = copy(start);
    pro.middle = copy(bv.v.co);
    pro.end = copy(end);
    pro.superR = p.proSuperR;
    pro.planeCo = [0, 0, 0];
    pro.planeNo = [0, 0, 0];
    pro.projDir = [0, 0, 0];
    doLinearInterp = false;
  }
  if (doLinearInterp) {
    pro.superR = PRO_LINE_R;
    pro.start = copy(start);
    pro.end = copy(end);
    pro.middle = mid(start, end);
    pro.planeCo = [0, 0, 0];
    pro.planeNo = [0, 0, 0];
    pro.projDir = [0, 0, 0];
  }
}

/** `move_profile_plane`. */
function moveProfilePlane(bndv: BoundVert, bmvert: BV): void {
  const pro = bndv.profile;
  if (isZero(pro.projDir)) return;
  const d1 = normalized(sub(bmvert.co, pro.start));
  const d2 = normalized(sub(bmvert.co, pro.end));
  const no = cross(d1, d2);
  const no2 = cross(d1, pro.projDir);
  const no3 = cross(d2, pro.projDir);
  if (normalize(no) > BEVEL_EPSILON_BIG && normalize(no2) > BEVEL_EPSILON_BIG && normalize(no3) > BEVEL_EPSILON_BIG) {
    const dot2 = dot(no, no2);
    const dot3 = dot(no, no3);
    if (Math.abs(dot2) < 1 - BEVEL_EPSILON_BIG && Math.abs(dot3) < 1 - BEVEL_EPSILON_BIG) bndv.profile.planeNo = copy(no);
  }
  pro.specialParams = true;
}

/** `move_weld_profile_planes`. */
function moveWeldProfilePlanes(bv: BevVert, bndv1: BoundVert, bndv2: BoundVert): void {
  if (isZero(bndv1.profile.projDir) || isZero(bndv2.profile.projDir)) return;
  const d1 = sub(bv.v.co, bndv1.nv.co);
  const d2 = sub(bv.v.co, bndv2.nv.co);
  const no = cross(d1, d2);
  const l1 = normalize(no);
  const no2 = cross(d1, bndv1.profile.projDir);
  const l2 = normalize(no2);
  const no3 = cross(d2, bndv2.profile.projDir);
  const l3 = normalize(no3);
  if (l1 !== 0 && (l2 !== 0 || l3 !== 0)) {
    const dot1 = Math.abs(dot(no, no2));
    const dot2 = Math.abs(dot(no, no3));
    if (Math.abs(dot1 - 1) > BEVEL_EPSILON) bndv1.profile.planeNo = copy(no);
    if (Math.abs(dot2 - 1) > BEVEL_EPSILON) bndv2.profile.planeNo = copy(no);
  }
  bndv1.profile.specialParams = true;
  bndv2.profile.specialParams = true;
}

/** `bev_ccw_test`. */
function bevCcwTest(a: BE, b: BE, f: BF | null): number {
  if (!f) return 0;
  const la = faceEdgeShareLoop(f, a);
  const lb = faceEdgeShareLoop(f, b);
  if (!la || !lb) return 0;
  return lb.next === la ? 1 : -1;
}

/** `make_unit_square_map`: the unit square's quarter onto the parallelogram (va, vmid, vb). */
function makeUnitSquareMap(va: V3, vmid: V3, vb: V3): M4 | null {
  const vaVmid = sub(vmid, va);
  const vbVmid = sub(vmid, vb);
  if (isZero(vaVmid) || isZero(vbVmid)) return null;
  if (Math.abs(angle(vaVmid, vbVmid) - Math.PI) <= BEVEL_EPSILON_ANG) return null;
  const vo = sub(va, vbVmid);
  const vddir = normalized(cross(vbVmid, vaVmid));
  const vd = add(vo, vddir);
  const c0 = sub(vmid, va);
  const c1 = sub(vmid, vb);
  const c2 = sub(sub(add(vmid, vd), va), vb);
  const c3 = sub(add(va, vb), vmid);
  return [
    [c0[0], c0[1], c0[2], 0],
    [c1[0], c1[1], c1[2], 0],
    [c2[0], c2[1], c2[2], 0],
    [c3[0], c3[1], c3[2], 1],
  ];
}

/** `make_unit_cube_map`: the (1,1,1) corner of the unit cube onto (va, vb, vc; vd). */
function makeUnitCubeMap(va: V3, vb: V3, vc: V3, vd: V3): M4 {
  const c0 = scale(add(sub(sub(va, vb), vc), vd), 0.5);
  const c1 = scale(add(sub(sub(vb, va), vc), vd), 0.5);
  const c2 = scale(add(sub(sub(vc, va), vb), vd), 0.5);
  const c3 = scale(sub(add(add(va, vb), vc), vd), 0.5);
  return [
    [c0[0], c0[1], c0[2], 0],
    [c1[0], c1[1], c1[2], 0],
    [c2[0], c2[1], c2[2], 0],
    [c3[0], c3[1], c3[2], 1],
  ];
}

/** `superellipse_co`. */
function superellipseCo(x: number, r: number, rbig: boolean): number {
  if (rbig) return Math.pow(1 - Math.pow(x, r), 1 / r);
  return 1 - Math.pow(1 - Math.pow(1 - x, r), 1 / r);
}

/** `get_profile_point`. */
function getProfilePoint(p: Params, pro: Profile, i: number, nseg: number): V3 {
  if (p.seg === 1) return copy(i === 0 ? pro.start : pro.end);
  if (nseg === p.seg) return copy(pro.profCo![i]!);
  const spacing = p.proSpacing.seg2 / nseg;
  return copy(pro.profCo2![i * spacing]!);
}

/** `calculate_profile_segments`. */
function calculateProfileSegments(
  pro: Profile,
  map: M4 | null,
  reversed: boolean,
  ns: number,
  xvals: number[],
  yvals: number[],
): V3[] {
  const out: V3[] = [];
  for (let k = 0; k <= ns; k++) {
    let co: V3;
    if (k === 0) co = copy(pro.start);
    else if (k === ns) co = copy(pro.end);
    else if (map) {
      const pt = [reversed ? yvals[ns - k]! : xvals[k]!, reversed ? xvals[ns - k]! : yvals[k]!, 0];
      co = mulM4V3(map, pt);
    } else co = lerp(pro.start, pro.end, k / ns);
    if (!isZero(pro.projDir)) {
      const co2 = add(co, pro.projDir);
      out.push(isectLinePlane(co, co2, pro.planeCo, pro.planeNo) ?? co);
    } else out.push(co);
  }
  return out;
}

/** `calculate_profile`. */
function calculateProfile(p: Params, bndv: BoundVert, reversed: boolean): void {
  const pro = bndv.profile;
  const sp = p.proSpacing;
  if (p.seg === 1) return;
  const need2 = p.seg !== sp.seg2;
  const map = pro.superR === PRO_LINE_R ? null : makeUnitSquareMap(pro.start, pro.middle, pro.end);
  pro.profCo = calculateProfileSegments(pro, map, reversed, p.seg, sp.xvals!, sp.yvals!);
  pro.profCo2 = need2 ? calculateProfileSegments(pro, map, reversed, sp.seg2, sp.xvals2!, sp.yvals2!) : pro.profCo;
}

/** `snap_to_superellipsoid`. */
function snapToSuperellipsoid(co: V3, superR: number, midline: boolean): void {
  const r = superR;
  if (r === PRO_CIRCLE_R) {
    normalize(co);
    return;
  }
  const a = Math.max(0, co[0]);
  const b = Math.max(0, co[1]);
  const c = Math.max(0, co[2]);
  let x = a;
  let y = b;
  let z = c;
  if (r === PRO_SQUARE_R || r === PRO_SQUARE_IN_R) {
    z = 0;
    x = Math.min(1, x);
    y = Math.min(1, y);
    if (r === PRO_SQUARE_R) {
      const dx = 1 - x;
      const dy = 1 - y;
      if (dx < dy) {
        x = 1;
        y = midline ? 1 : y;
      } else {
        y = 1;
        x = midline ? 1 : x;
      }
    } else if (x < y) {
      x = 0;
      y = midline ? 0 : y;
    } else {
      y = 0;
      x = midline ? 0 : x;
    }
  } else {
    const rinv = 1 / r;
    if (a === 0) {
      if (b === 0) {
        x = 0;
        y = 0;
        z = Math.pow(c, rinv);
      } else {
        x = 0;
        y = Math.pow(1 / (1 + Math.pow(c / b, r)), rinv);
        z = (c * y) / b;
      }
    } else {
      x = Math.pow(1 / (1 + Math.pow(b / a, r) + Math.pow(c / a, r)), rinv);
      y = (b * x) / a;
      z = (c * x) / a;
    }
  }
  co[0] = x;
  co[1] = y;
  co[2] = z;
}

/** `eh_on_plane`. */
function ehOnPlane(e: EdgeHalf): boolean {
  if (e.fprev && e.fnext) {
    const d = dot(e.fprev.no, e.fnext.no);
    if (Math.abs(d + 1) <= BEVEL_EPSILON_BIG || Math.abs(d - 1) <= BEVEL_EPSILON_BIG) return true;
  }
  return false;
}

/** `calculate_vm_profiles`. */
function calculateVmProfiles(p: Params, bv: BevVert, vm: VMesh): void {
  let bndv = vm.boundstart!;
  do {
    if (!bndv.profile.specialParams) setProfileParams(p, bv, bndv);
    calculateProfile(p, bndv, false);
  } while ((bndv = bndv.next) !== vm.boundstart);
}

// ── the boundary ───────────────────────────────────────────────────────────

/** `set_bound_vert_seams`, for `any_seam` alone — nothing here marks seams. */
function setBoundVertSeams(bv: BevVert): void {
  bv.anySeam = false;
  let v = bv.vmesh.boundstart!;
  do {
    let any = false;
    for (let e: EdgeHalf | null = v.efirst; e; e = e.next) {
      any ||= e.isSeam;
      if (e === v.elast) break;
    }
    bv.anySeam ||= any;
  } while ((v = v.next) !== bv.vmesh.boundstart);
}

/** `build_boundary_vertex_only`: one boundary point on each edge, `offset_l` along it. */
function buildBoundaryVertexOnly(p: Params, bv: BevVert, construct: boolean): void {
  const vm = bv.vmesh;
  const efirst = bv.edges[0]!;
  let e = efirst;
  do {
    const co = slideDist(e, bv.v, e.offsetL);
    if (construct) {
      const v = addNewBoundVert(vm, co);
      v.efirst = v.elast = e;
      e.leftv = e.rightv = v;
    } else e.leftv!.nv.co = copy(co);
  } while ((e = e.next) !== efirst);
  if (construct) {
    setBoundVertSeams(bv);
    // Odd segments: a seam at the vertex itself counts too.
    if (p.affectVerticesOdd && !bv.anySeam && !contigAroundVert(p, bv.v)) bv.anySeam = true;
    if (vm.count === 2) vm.kind = MeshKind.NONE;
    else if (p.seg === 1) vm.kind = MeshKind.POLY;
    else vm.kind = MeshKind.ADJ;
  }
}

/** `contig_ldata_around_vert`: do all the corners at `v` hold the same UV and colour? */
function contigAroundVert(p: Params, v: BV): boolean {
  const L = p.layers;
  if (!L.hasUv && !L.hasColor) return true;
  const loops = loopsOfVert(v);
  const first = loops[0];
  if (!first) return true;
  const a = L.corners[first.src];
  for (const l of loops.slice(1)) {
    const b = L.corners[l.src];
    if (L.hasUv) {
      const u = a?.uv ?? [0, 0];
      const w = b?.uv ?? [0, 0];
      if ((u[0]! - w[0]!) ** 2 + (u[1]! - w[1]!) ** 2 >= 0.00001) return false;
    }
    if (L.hasColor) {
      const u = a?.col ?? [1, 1, 1, 1];
      const w = b?.col ?? [1, 1, 1, 1];
      let d = 0;
      for (let k = 0; k < 4; k++) d += (Math.round(u[k]! * 255) - Math.round(w[k]! * 255)) ** 2;
      if (d >= 0.001) return false;
    }
  }
  return true;
}

/** `build_boundary_terminal_edge`: one beveled edge at the vertex. */
function buildBoundaryTerminalEdge(p: Params, bv: BevVert, efirst: EdgeHalf, construct: boolean): void {
  const vm = bv.vmesh;
  let e = efirst;
  if (bv.edgecount === 2) {
    let no = e.fprev ? e.fprev.no : e.fnext ? e.fnext.no : null;
    let co = offsetInPlane(e, no ? copy(no) : null, true);
    if (construct) {
      const bndv = addNewBoundVert(vm, co);
      bndv.efirst = bndv.elast = bndv.ebev = e;
      e.leftv = bndv;
    } else e.leftv!.nv.co = copy(co);
    no = e.fnext ? e.fnext.no : e.fprev ? e.fprev.no : null;
    co = offsetInPlane(e, no ? copy(no) : null, false);
    if (construct) {
      const bndv = addNewBoundVert(vm, co);
      bndv.efirst = bndv.elast = e;
      e.rightv = bndv;
    } else e.rightv!.nv.co = copy(co);
    co = slideDist(e.next, bv.v, e.offsetL);
    if (construct) {
      const bndv = addNewBoundVert(vm, co);
      bndv.efirst = bndv.elast = e.next;
      e.next.leftv = e.next.rightv = bndv;
      setBoundVertSeams(bv);
    } else e.next.leftv!.nv.co = copy(co);
  } else {
    const legSlide = p.offsetType === "PERCENT" || p.offsetType === "ABSOLUTE";
    let co = legSlide ? slideDist(e.prev, bv.v, e.offsetL) : offsetMeet(p, e.prev, e, bv.v, e.fprev, false, null);
    if (construct) {
      const bndv = addNewBoundVert(vm, co);
      bndv.efirst = e.prev;
      bndv.elast = bndv.ebev = e;
      e.leftv = bndv;
      e.prev.leftv = e.prev.rightv = bndv;
    } else e.leftv!.nv.co = copy(co);
    e = e.next;
    co = legSlide ? slideDist(e, bv.v, e.prev.offsetR) : offsetMeet(p, e.prev, e, bv.v, e.fprev, false, null);
    if (construct) {
      const bndv = addNewBoundVert(vm, co);
      bndv.efirst = e.prev;
      bndv.elast = e;
      e.leftv = e.rightv = bndv;
      e.prev.rightv = bndv;
    } else e.leftv!.nv.co = copy(co);
    let d = efirst.offsetLSpec;
    if (p.profile < 0.25) d *= Math.SQRT2;
    for (e = e.next; e.next !== efirst; e = e.next) {
      co = slideDist(e, bv.v, d);
      if (construct) {
        const bndv = addNewBoundVert(vm, co);
        bndv.efirst = bndv.elast = e;
        e.leftv = e.rightv = bndv;
      } else e.leftv!.nv.co = copy(co);
    }
  }
  if (bv.edgecount >= 3) {
    const bndv = vm.boundstart!;
    setProfileParams(p, bv, bndv);
    moveProfilePlane(bndv, bv.v);
  }
  if (construct) {
    setBoundVertSeams(bv);
    if (vm.count === 2 && bv.edgecount === 3) vm.kind = MeshKind.NONE;
    else if (vm.count === 3) vm.kind = MeshKind.TRI_FAN;
    else vm.kind = MeshKind.POLY;
  }
}

/**
 * `build_boundary`: the cycle of BoundVerts round `bv`, one per gap between
 * beveled edges. With `construct` false, only moves them (the width pass).
 */
function buildBoundary(p: Params, bv: BevVert, construct: boolean): void {
  if (bv.edgecount <= 1) return;
  if (p.affectVertices) {
    buildBoundaryVertexOnly(p, bv, construct);
    return;
  }
  const vm = bv.vmesh;
  const efirst = nextBev(bv, null)!;
  if (bv.selcount === 1) {
    buildBoundaryTerminalEdge(p, bv, efirst, construct);
    return;
  }
  let e = efirst;
  do {
    let eon: EdgeHalf | null = null;
    let inPlane = 0;
    let notInPlane = 0;
    let enip: EdgeHalf | null = null;
    let eip: EdgeHalf | null = null;
    let e2: EdgeHalf;
    for (e2 = e.next; !e2.isBev; e2 = e2.next) {
      if (ehOnPlane(e2)) {
        inPlane++;
        eip = e2;
      } else {
        notInPlane++;
        enip = e2;
      }
    }
    let co: V3;
    let r = 1;
    if (inPlane === 0 && notInPlane === 0) {
      co = offsetMeet(p, e, e2, bv.v, e.fnext, false, null);
    } else if (notInPlane > 0) {
      if (p.loopSlide && notInPlane === 1 && goodOffsetOnEdgeBetween(e, e2, enip!, bv.v)) {
        const res = offsetOnEdgeBetween(p, e, e2, enip!, bv.v);
        co = res.meetco;
        r = res.sinratio;
        if (res.placed) eon = enip;
      } else co = offsetMeet(p, e, e2, bv.v, null, true, eip);
    } else if (p.loopSlide && inPlane === 1 && goodOffsetOnEdgeBetween(e, e2, eip!, bv.v)) {
      const res = offsetOnEdgeBetween(p, e, e2, eip!, bv.v);
      co = res.meetco;
      r = res.sinratio;
      if (res.placed) eon = eip;
    } else co = offsetMeet(p, e, e2, bv.v, e.fnext, false, null);

    if (construct) {
      const v = addNewBoundVert(vm, co);
      v.efirst = e;
      v.elast = e2;
      v.ebev = e2;
      v.eon = eon;
      if (eon) v.sinratio = r;
      e.rightv = v;
      e2.leftv = v;
      for (let e3 = e.next; e3 !== e2; e3 = e3.next) e3.leftv = e3.rightv = v;
    } else e.rightv!.nv.co = copy(co);
    e = e2;
  } while (e !== efirst);

  if (construct) {
    setBoundVertSeams(bv);
    if (vm.count === 2) vm.kind = MeshKind.NONE;
    else if (efirst.seg === 1) vm.kind = MeshKind.POLY;
    else vm.kind = MeshKind.ADJ;
  }
}

// ── the width pass ─────────────────────────────────────────────────────────

/** `adjust_the_cycle_or_chain`: least squares over one chain or cycle of dependent offsets. */
function adjustTheCycleOrChain(vstart: BoundVert, iscycle: boolean): void {
  let np = 0;
  let v: BoundVert | null = vstart;
  do {
    np++;
    v = v!.adjchain;
  } while (v && v !== vstart);
  const nrows = iscycle ? 3 * np : 3 * np - 3;
  const A = Array.from({ length: nrows }, () => new Array<number>(np).fill(0));
  const b = new Array<number>(nrows).fill(0);
  const weight = BEVEL_MATCH_SPEC_WEIGHT;
  v = vstart;
  let i = 0;
  do {
    if (iscycle || i < np - 1) {
      const eright = v!.efirst!;
      const enextleft = v!.adjchain!.elast!;
      const put = (r: number, c: number, x: number): void => {
        A[r]![c] = A[r]![c]! + x;
      };
      put(i, i, 1);
      if (iscycle) put(i > 0 ? i - 1 : np - 1, i, -v!.sinratio);
      else if (i > 0) put(i - 1, i, -v!.sinratio);
      let row = iscycle ? np + 2 * i : np - 1 + 2 * i;
      put(row, i, weight);
      b[row] = b[row]! + weight * eright.offsetR;
      row = row + 1;
      put(row, i === np - 1 ? 0 : i + 1, weight * v!.adjchain!.sinratio);
      b[row] = b[row]! + weight * enextleft.offsetL;
    } else {
      A[i - 1]![i] = A[i - 1]![i]! - 1;
    }
    i++;
    v = v!.adjchain;
  } while (v && v !== vstart);
  const x = leastSquares(A, b, np);
  v = vstart;
  i = 0;
  do {
    const val = x[i]!;
    if (iscycle || i < np - 1) {
      v!.efirst!.offsetR = val;
      if (iscycle || v !== vstart) v!.elast!.offsetL = v!.sinratio * val;
    } else v!.elast!.offsetL = val;
    i++;
    v = v!.adjchain;
  } while (v && v !== vstart);
}

/** `adjust_offsets`. */
function adjustOffsets(p: Params, verts: BV[]): void {
  for (const bmv of verts) {
    if (!p.tagged.has(bmv)) continue;
    const bv = p.vertHash.get(bmv);
    if (!bv) continue;
    let vanchor = bv.vmesh.boundstart!;
    do {
      if (vanchor.visited || !vanchor.eon) continue;
      let v = vanchor;
      let vchainstart = vanchor;
      let vchainend = vanchor;
      let iscycle = false;
      let chainlen = 1;
      while (v.eon && !v.visited && !iscycle) {
        v.visited = true;
        if (!v.efirst) break;
        const { eh: enext } = findOtherEndEdgeHalf(p, v.efirst);
        if (!enext) break;
        const vnext = enext.leftv!;
        v.adjchain = vnext;
        vchainend = vnext;
        chainlen++;
        if (vnext.visited) {
          if (vnext !== vchainstart) break;
          adjustTheCycleOrChain(vchainstart, true);
          iscycle = true;
        }
        v = vnext;
      }
      if (!iscycle) {
        v.adjchain = null;
        v = vchainstart;
        do {
          v.visited = true;
          if (!v.elast) break;
          const { eh: enext } = findOtherEndEdgeHalf(p, v.elast);
          if (!enext) break;
          const vnext = enext.rightv!;
          vnext.adjchain = v;
          chainlen++;
          vchainstart = vnext;
          v = vnext;
        } while (!v.visited && v.eon);
        if (chainlen >= 3 && !vchainstart.eon && !vchainend.eon) adjustTheCycleOrChain(vchainstart, false);
      }
    } while ((vanchor = vanchor.next) !== bv.vmesh.boundstart);
  }
  for (const bmv of verts) {
    if (!p.tagged.has(bmv)) continue;
    const bv = p.vertHash.get(bmv);
    if (bv) buildBoundary(p, bv, false);
  }
}

// ── vertex meshes ──────────────────────────────────────────────────────────

/** `pipe_test`. */
function pipeTest(bv: BevVert): BoundVert | null {
  const vm = bv.vmesh;
  if (vm.count < 3 || vm.count > 4 || bv.selcount < 3 || bv.selcount > 4) return null;
  let v1 = vm.boundstart!;
  let epipe: EdgeHalf | null = null;
  let dir1: V3 = [0, 0, 0];
  do {
    const v2 = v1.next;
    const v3 = v2.next;
    if (v1.ebev && v2.ebev && v3.ebev) {
      dir1 = normalized(sub(bv.v.co, otherVert(v1.ebev.e, bv.v).co));
      const dir3 = normalized(sub(otherVert(v3.ebev.e, bv.v).co, bv.v.co));
      if (angleNormalized(dir1, dir3) < BEVEL_EPSILON_ANG) {
        epipe = v1.ebev;
        break;
      }
    }
  } while ((v1 = v1.next) !== vm.boundstart);
  if (!epipe) return null;
  for (const e of bv.edges) if (e.fnext && Math.abs(dot(dir1, e.fnext.no)) > BEVEL_EPSILON_BIG) return null;
  return v1;
}

function newAdjVmesh(count: number, seg: number, bounds: BoundVert | null): VMesh {
  return { mesh: allocMesh(count, seg), boundstart: bounds, count, seg, kind: MeshKind.ADJ };
}

/** `mesh_vert_canon`. */
function meshVertCanon(vm: VMesh, i: number, j: number, k: number): NewVert {
  const n = vm.count;
  const ns = vm.seg;
  const ns2 = Math.floor(ns / 2);
  const odd = ns % 2;
  if (!odd && j === ns2 && k === ns2) return meshVert(vm, 0, j, k);
  if (j <= ns2 - 1 + odd && k <= ns2) return meshVert(vm, i, j, k);
  if (k <= ns2) return meshVert(vm, (i + n - 1) % n, k, ns - j);
  return meshVert(vm, (i + 1) % n, ns - k, j);
}

/** `is_canon`. */
function isCanon(vm: VMesh, i: number, j: number, k: number): boolean {
  const ns2 = Math.floor(vm.seg / 2);
  if (vm.seg % 2 === 1) return j <= ns2 && k <= ns2;
  return (j < ns2 && k <= ns2) || (j === ns2 && k === ns2 && i === 0);
}

/** `vmesh_copy_equiv_verts`. */
function vmeshCopyEquivVerts(vm: VMesh): void {
  const n = vm.count;
  const ns = vm.seg;
  const ns2 = Math.floor(ns / 2);
  for (let i = 0; i < n; i++)
    for (let j = 0; j <= ns2; j++)
      for (let k = 0; k <= ns; k++) {
        if (isCanon(vm, i, j, k)) continue;
        const v1 = meshVert(vm, i, j, k);
        const v0 = meshVertCanon(vm, i, j, k);
        v1.co = copy(v0.co);
        v1.v = v0.v;
      }
}

/** `vmesh_center`. */
function vmeshCenter(vm: VMesh): V3 {
  const n = vm.count;
  const ns2 = Math.floor(vm.seg / 2);
  if (vm.seg % 2) {
    let c: V3 = [0, 0, 0];
    for (let i = 0; i < n; i++) c = add(c, meshVert(vm, i, ns2, ns2).co);
    return scale(c, 1 / n);
  }
  return copy(meshVert(vm, 0, ns2, ns2).co);
}

const avg4 = (a: NewVert, b: NewVert, c: NewVert, d: NewVert): V3 => scale(add(add(add(a.co, b.co), c.co), d.co), 0.25);

/** `sabin_gamma`. */
function sabinGamma(n: number): number {
  if (n < 3) return 0;
  if (n === 3) return 0.065247584;
  if (n === 4) return 0.25;
  if (n === 5) return 0.401983447;
  if (n === 6) return 0.523423277;
  const k = Math.cos(Math.PI / n);
  const k2 = k * k;
  const k4 = k2 * k2;
  const k6 = k4 * k2;
  const y = Math.pow(Math.sqrt(3) * Math.sqrt(64 * k6 - 144 * k4 + 135 * k2 - 27) + 9 * k, 1 / 3);
  const x = 0.480749856769136 * y - (0.231120424783545 * (12 * k2 - 9)) / y;
  return (k * x + 2 * k2 - 1) / (x * x * (k * x + 1));
}

/** `fill_vmesh_fracs`. */
function fillVmeshFracs(vm: VMesh, i: number): number[] {
  const ns = vm.seg;
  const frac = new Array<number>(ns + 1).fill(0);
  let total = 0;
  for (let k = 0; k < ns; k++) {
    total += dist(meshVert(vm, i, 0, k).co, meshVert(vm, i, 0, k + 1).co);
    frac[k + 1] = total;
  }
  if (total > 0) for (let k = 1; k <= ns; k++) frac[k] = frac[k]! / total;
  else frac[ns] = 1;
  return frac;
}

/** `fill_profile_fracs`. */
function fillProfileFracs(p: Params, bndv: BoundVert, ns: number): number[] {
  const frac = new Array<number>(ns + 1).fill(0);
  let total = 0;
  let co = copy(bndv.nv.co);
  for (let k = 0; k < ns; k++) {
    const nextco = getProfilePoint(p, bndv.profile, k + 1, ns);
    total += dist(co, nextco);
    frac[k + 1] = total;
    co = nextco;
  }
  if (total > 0) for (let k = 1; k <= ns; k++) frac[k] = frac[k]! / total;
  else frac[ns] = 1;
  return frac;
}

/** `interp_range`. */
function interpRange(frac: number[], n: number, f: number): { i: number; rest: number } {
  for (let i = 0; i < n; i++) {
    if (f <= frac[i + 1]!) {
      const rest = f - frac[i]!;
      let r = rest === 0 ? 0 : rest / (frac[i + 1]! - frac[i]!);
      let ii = i;
      if (i === n - 1 && r === 1) {
        ii = n;
        r = 0;
      }
      return { i: ii, rest: r };
    }
  }
  return { i: n, rest: 0 };
}

/** `interp_vmesh`: resample a vertex mesh to `nseg` segments. */
function interpVmesh(p: Params, vmIn: VMesh, nseg: number): VMesh {
  const nBndv = vmIn.count;
  const nsIn = vmIn.seg;
  const nseg2 = Math.floor(nseg / 2);
  const odd = nseg % 2;
  const vmOut = newAdjVmesh(nBndv, nseg, vmIn.boundstart);
  let prevFrac = fillVmeshFracs(vmIn, nBndv - 1);
  let bndv = vmIn.boundstart!;
  let prevNewFrac = fillProfileFracs(p, bndv.prev, nseg);
  for (let i = 0; i < nBndv; i++) {
    const frac = fillVmeshFracs(vmIn, i);
    const newFrac = fillProfileFracs(p, bndv, nseg);
    for (let j = 0; j <= nseg2 - 1 + odd; j++)
      for (let k = 0; k <= nseg2; k++) {
        const rk = interpRange(frac, nsIn, newFrac[k]!);
        const kIn = rk.i;
        const restk = rk.rest;
        const rkp = interpRange(prevFrac, nsIn, prevNewFrac[nseg - j]!);
        let jIn = nsIn - rkp.i;
        let restj = -rkp.rest;
        if (restj > -BEVEL_EPSILON) restj = 0;
        else {
          jIn = jIn - 1;
          restj = 1 + restj;
        }
        let co: V3;
        if (restj < BEVEL_EPSILON && restk < BEVEL_EPSILON) co = copy(meshVertCanon(vmIn, i, jIn, kIn).co);
        else {
          const j0inc = restj < BEVEL_EPSILON || jIn === nsIn ? 0 : 1;
          const k0inc = restk < BEVEL_EPSILON || kIn === nsIn ? 0 : 1;
          const quad = [
            meshVertCanon(vmIn, i, jIn, kIn).co,
            meshVertCanon(vmIn, i, jIn, kIn + k0inc).co,
            meshVertCanon(vmIn, i, jIn + j0inc, kIn + k0inc).co,
            meshVertCanon(vmIn, i, jIn + j0inc, kIn).co,
          ];
          co = bilinearQuad(quad, restk, restj);
        }
        meshVert(vmOut, i, j, k).co = co;
      }
    bndv = bndv.next;
    prevFrac = frac;
    prevNewFrac = newFrac;
  }
  if (!odd) meshVert(vmOut, 0, nseg2, nseg2).co = vmeshCenter(vmIn);
  vmeshCopyEquivVerts(vmOut);
  return vmOut;
}

/** `cubic_subdiv`: one Catmull-Clark step with Levin's boundary rules. */
function cubicSubdiv(p: Params, vmIn: VMesh): VMesh {
  const nBoundary = vmIn.count;
  const nsIn = vmIn.seg;
  const nsIn2 = Math.floor(nsIn / 2);
  const nsOut = 2 * nsIn;
  const vmOut = newAdjVmesh(nBoundary, nsOut, vmIn.boundstart);

  for (let i = 0; i < nBoundary; i++) {
    meshVert(vmOut, i, 0, 0).co = copy(meshVert(vmIn, i, 0, 0).co);
    for (let k = 1; k < nsIn; k++) {
      let co = copy(meshVert(vmIn, i, 0, k).co);
      const co1 = meshVert(vmIn, i, 0, k - 1).co;
      const co2 = meshVert(vmIn, i, 0, k + 1).co;
      const acc = madd(add(co1, co2), co, -2);
      co = madd(co, acc, -1 / 6);
      meshVertCanon(vmOut, i, 0, 2 * k).co = co;
    }
  }
  let bndv = vmOut.boundstart!;
  for (let i = 0; i < nBoundary; i++) {
    for (let k = 1; k < nsOut; k += 2) {
      let co = getProfilePoint(p, bndv.profile, k, nsOut);
      const co1 = meshVertCanon(vmOut, i, 0, k - 1).co;
      const co2 = meshVertCanon(vmOut, i, 0, k + 1).co;
      const acc = madd(add(co1, co2), co, -2);
      co = madd(co, acc, -1 / 6);
      meshVertCanon(vmOut, i, 0, k).co = co;
    }
    bndv = bndv.next;
  }
  vmeshCopyEquivVerts(vmOut);
  for (let i = 0; i < nBoundary; i++)
    for (let k = 0; k < nsIn; k++) meshVert(vmIn, i, 0, k).co = copy(meshVert(vmOut, i, 0, 2 * k).co);
  vmeshCopyEquivVerts(vmIn);

  for (let i = 0; i < nBoundary; i++)
    for (let j = 0; j < nsIn2; j++)
      for (let k = 0; k < nsIn2; k++)
        meshVert(vmOut, i, 2 * j + 1, 2 * k + 1).co = avg4(
          meshVert(vmIn, i, j, k),
          meshVert(vmIn, i, j, k + 1),
          meshVert(vmIn, i, j + 1, k),
          meshVert(vmIn, i, j + 1, k + 1),
        );
  for (let i = 0; i < nBoundary; i++)
    for (let j = 0; j < nsIn2; j++)
      for (let k = 1; k <= nsIn2; k++)
        meshVert(vmOut, i, 2 * j + 1, 2 * k).co = avg4(
          meshVert(vmIn, i, j, k),
          meshVert(vmIn, i, j + 1, k),
          meshVertCanon(vmOut, i, 2 * j + 1, 2 * k - 1),
          meshVertCanon(vmOut, i, 2 * j + 1, 2 * k + 1),
        );
  for (let i = 0; i < nBoundary; i++)
    for (let j = 1; j < nsIn2; j++)
      for (let k = 0; k < nsIn2; k++)
        meshVert(vmOut, i, 2 * j, 2 * k + 1).co = avg4(
          meshVert(vmIn, i, j, k),
          meshVert(vmIn, i, j, k + 1),
          meshVertCanon(vmOut, i, 2 * j - 1, 2 * k + 1),
          meshVertCanon(vmOut, i, 2 * j + 1, 2 * k + 1),
        );
  let gamma = 0.25;
  let beta = -gamma;
  for (let i = 0; i < nBoundary; i++)
    for (let j = 1; j < nsIn2; j++)
      for (let k = 1; k <= nsIn2; k++) {
        const co1 = avg4(
          meshVertCanon(vmOut, i, 2 * j, 2 * k - 1),
          meshVertCanon(vmOut, i, 2 * j, 2 * k + 1),
          meshVertCanon(vmOut, i, 2 * j - 1, 2 * k),
          meshVertCanon(vmOut, i, 2 * j + 1, 2 * k),
        );
        const co2 = avg4(
          meshVertCanon(vmOut, i, 2 * j - 1, 2 * k - 1),
          meshVertCanon(vmOut, i, 2 * j + 1, 2 * k - 1),
          meshVertCanon(vmOut, i, 2 * j - 1, 2 * k + 1),
          meshVertCanon(vmOut, i, 2 * j + 1, 2 * k + 1),
        );
        let co = copy(co1);
        co = madd(co, co2, beta);
        co = madd(co, meshVert(vmIn, i, j, k).co, gamma);
        meshVert(vmOut, i, 2 * j, 2 * k).co = co;
      }
  vmeshCopyEquivVerts(vmOut);

  gamma = sabinGamma(nBoundary);
  beta = -gamma;
  let co1: V3 = [0, 0, 0];
  let co2: V3 = [0, 0, 0];
  for (let i = 0; i < nBoundary; i++) {
    co1 = add(co1, meshVert(vmOut, i, nsIn, nsIn - 1).co);
    co2 = add(co2, meshVert(vmOut, i, nsIn - 1, nsIn - 1).co);
    co2 = add(co2, meshVert(vmOut, i, nsIn - 1, nsIn + 1).co);
  }
  let co = scale(co1, 1 / nBoundary);
  co = madd(co, co2, beta / (2 * nBoundary));
  co = madd(co, meshVert(vmIn, 0, nsIn2, nsIn2).co, gamma);
  for (let i = 0; i < nBoundary; i++) meshVert(vmOut, i, nsIn, nsIn).co = copy(co);

  bndv = vmOut.boundstart!;
  for (let i = 0; i < nBoundary; i++) {
    const inext = (i + 1) % nBoundary;
    for (let k = 0; k <= nsOut; k++) {
      const c = getProfilePoint(p, bndv.profile, k, nsOut);
      meshVert(vmOut, i, 0, k).co = copy(c);
      if (k >= nsIn && k < nsOut) meshVert(vmOut, inext, nsOut - k, 0).co = copy(c);
    }
    bndv = bndv.next;
  }
  return vmOut;
}

/** `make_cube_corner_square`. */
function makeCubeCornerSquare(nseg: number): VMesh {
  const ns2 = Math.floor(nseg / 2);
  const vm = newAdjVmesh(3, nseg, null);
  vm.count = 0;
  for (let i = 0; i < 3; i++) {
    const co: V3 = [0, 0, 0];
    co[i] = 1;
    addNewBoundVert(vm, co);
  }
  for (let i = 0; i < 3; i++)
    for (let j = 0; j <= ns2; j++)
      for (let k = 0; k <= ns2; k++) {
        if (!isCanon(vm, i, j, k)) continue;
        const co: V3 = [0, 0, 0];
        co[i] = 1;
        co[(i + 1) % 3] = (k * 2) / nseg;
        co[(i + 2) % 3] = (j * 2) / nseg;
        meshVert(vm, i, j, k).co = co;
      }
  vmeshCopyEquivVerts(vm);
  return vm;
}

/** `make_cube_corner_square_in`. */
function makeCubeCornerSquareIn(nseg: number): VMesh {
  const ns2 = Math.floor(nseg / 2);
  const odd = nseg % 2;
  const vm = newAdjVmesh(3, nseg, null);
  vm.count = 0;
  for (let i = 0; i < 3; i++) {
    const co: V3 = [0, 0, 0];
    co[i] = 1;
    addNewBoundVert(vm, co);
  }
  const b = odd ? 2 / (2 * ns2 + Math.SQRT2) : 2 / nseg;
  for (let i = 0; i < 3; i++)
    for (let k = 0; k <= ns2; k++) {
      const co: V3 = [0, 0, 0];
      co[i] = 1 - k * b;
      meshVert(vm, i, 0, k).co = copy(co);
      const co2: V3 = [0, 0, 0];
      co2[(i + 1) % 3] = 1 - k * b;
      meshVert(vm, i, 0, nseg - k).co = co2;
    }
  return vm;
}

/** `make_cube_corner_adj_vmesh`: the octant of the unit sphere, or the square special cases. */
function makeCubeCornerAdjVmesh(p: Params): VMesh {
  const nseg = p.seg;
  const r = p.proSuperR;
  if (r === PRO_SQUARE_R) return makeCubeCornerSquare(nseg);
  if (r === PRO_SQUARE_IN_R) return makeCubeCornerSquareIn(nseg);
  const vm0 = newAdjVmesh(3, 2, null);
  vm0.count = 0;
  for (let i = 0; i < 3; i++) {
    const co: V3 = [0, 0, 0];
    co[i] = 1;
    addNewBoundVert(vm0, co);
  }
  let bndv = vm0.boundstart!;
  for (let i = 0; i < 3; i++) {
    const coc: V3 = [0, 0, 0];
    coc[i] = 1;
    coc[(i + 1) % 3] = 1;
    bndv.profile.superR = r;
    bndv.profile.start = copy(bndv.nv.co);
    bndv.profile.end = copy(bndv.next.nv.co);
    bndv.profile.middle = coc;
    meshVert(vm0, i, 0, 0).co = copy(bndv.profile.start);
    bndv.profile.planeCo = copy(bndv.profile.start);
    bndv.profile.planeNo = cross(bndv.profile.start, bndv.profile.end);
    bndv.profile.projDir = copy(bndv.profile.planeNo);
    calculateProfile(p, bndv, false);
    meshVert(vm0, i, 0, 1).co = getProfilePoint(p, bndv.profile, 1, 2);
    bndv = bndv.next;
  }
  const s3 = 1 / Math.sqrt(3); // M_SQRT1_3
  let co: V3 = [s3, s3, s3];
  if (nseg > 2) {
    if (r > 1.5) co = scale(co, 1.4);
    else if (r < 0.75) co = scale(co, 0.6);
  }
  meshVert(vm0, 0, 1, 1).co = co;
  vmeshCopyEquivVerts(vm0);
  let vm1 = vm0;
  while (vm1.seg < nseg) vm1 = cubicSubdiv(p, vm1);
  if (vm1.seg !== nseg) vm1 = interpVmesh(p, vm1, nseg);
  const ns2 = Math.floor(nseg / 2);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j <= ns2; j++)
      for (let k = 0; k <= nseg; k++) snapToSuperellipsoid(meshVert(vm1, i, j, k).co, r, false);
  return vm1;
}

/** `BM_edge_is_convex`. */
function edgeIsConvex(e: BE): boolean {
  if (isManifold(e)) {
    const l1 = e.l!;
    const l2 = l1.rn!;
    const n1 = l1.f.no;
    const n2 = l2.f.no;
    if (!(n1[0] === n2[0] && n1[1] === n2[1] && n1[2] === n2[2])) {
      const c = cross(n1, n2);
      const lDir = sub(l1.next.v.co, l1.v.co);
      return dot(lDir, c) > 0;
    }
  }
  return true;
}

/** `BM_edge_calc_face_angle_signed_ex`. */
function edgeFaceAngleSigned(e: BE, fallback: number): number {
  if (isManifold(e)) {
    const l1 = e.l!;
    const l2 = l1.rn!;
    const a = angleNormalized(l1.f.no, l2.f.no);
    return edgeIsConvex(e) ? a : -a;
  }
  return fallback;
}

/** `tri_corner_test`: −1 no, 0 maybe, 1 yes. */
function triCornerTest(p: Params, bv: BevVert): number {
  if (p.affectVertices) return -1;
  if (bv.vmesh.count !== 3) return 0;
  const offset = bv.edges[0]!.offsetL;
  let totang = 0;
  let inPlaneE = 0;
  for (const e of bv.edges) {
    const ang = edgeFaceAngleSigned(e.e, 0);
    const absang = Math.abs(ang);
    if (absang <= Math.PI / 4) inPlaneE++;
    else if (absang >= (3 * Math.PI) / 4) return -1;
    if (e.isBev && !compareFF(e.offsetL, offset, BEVEL_EPSILON)) return -1;
    totang += ang;
  }
  if (inPlaneE !== bv.edgecount - 3) return -1;
  const angdiff = Math.abs(Math.abs(totang) - (3 * Math.PI) / 2);
  if ((p.proSuperR === PRO_SQUARE_R && angdiff > Math.PI / 16) || angdiff > Math.PI / 4) return -1;
  if (bv.edgecount !== 3 || bv.selcount !== 3) return 0;
  return 1;
}

/** `tri_corner_adj_vmesh`. */
function triCornerAdjVmesh(p: Params, bv: BevVert): VMesh {
  let bndv = bv.vmesh.boundstart!;
  const co0 = copy(bndv.nv.co);
  bndv = bndv.next;
  const co1 = copy(bndv.nv.co);
  bndv = bndv.next;
  const co2 = copy(bndv.nv.co);
  const mat = makeUnitCubeMap(co0, co1, co2, copy(bv.v.co));
  const ns = p.seg;
  const ns2 = Math.floor(ns / 2);
  const vm = makeCubeCornerAdjVmesh(p);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j <= ns2; j++)
      for (let k = 0; k <= ns; k++) {
        const nv = meshVert(vm, i, j, k);
        nv.co = mulM4V3(mat, nv.co);
      }
  return vm;
}

/** `adj_vmesh`: the general corner patch, subdivided from a two-segment seed. */
function adjVmesh(p: Params, bv: BevVert): VMesh {
  const nBndv = bv.vmesh.count;
  if (nBndv === 3 && triCornerTest(p, bv) !== -1 && p.proSuperR !== PRO_SQUARE_IN_R) return triCornerAdjVmesh(p, bv);
  const nseg = bv.vmesh.seg;
  const vm0 = newAdjVmesh(nBndv, 2, bv.vmesh.boundstart);
  let bndv = vm0.boundstart!;
  let center: V3 = [0, 0, 0];
  for (let i = 0; i < nBndv; i++) {
    meshVert(vm0, i, 0, 0).co = copy(bndv.nv.co);
    meshVert(vm0, i, 0, 1).co = getProfilePoint(p, bndv.profile, 1, 2);
    center = add(center, bndv.nv.co);
    bndv = bndv.next;
  }
  center = scale(center, 1 / nBndv);
  const original = copy(bv.v.co);
  const fullness = p.proSpacing.fullness;
  const dir = sub(original, center);
  if (lenSq(dir) > BEVEL_EPSILON_SQ) meshVert(vm0, 0, 1, 1).co = madd(center, dir, fullness);
  else meshVert(vm0, 0, 1, 1).co = copy(center);
  vmeshCopyEquivVerts(vm0);
  let vm1 = vm0;
  do vm1 = cubicSubdiv(p, vm1);
  while (vm1.seg < nseg);
  if (vm1.seg !== nseg) vm1 = interpVmesh(p, vm1, nseg);
  return vm1;
}

/** `snap_to_pipe_profile`. */
function snapToPipeProfile(vpipe: BoundVert, midline: boolean, co: V3): V3 {
  const pro = vpipe.profile;
  const e = vpipe.ebev!;
  if (compareV3(pro.start, pro.end, BEVEL_EPSILON_D)) return copy(pro.start);
  const edir = sub(e.e.v1.co, e.e.v2.co);
  const plane = planeFromPointNormal(co, edir);
  const startPlane = closestToPlane(plane, pro.start);
  const endPlane = closestToPlane(plane, pro.end);
  const middlePlane = closestToPlane(plane, pro.middle);
  const m = makeUnitSquareMap(startPlane, middlePlane, endPlane);
  const minv = m ? invertM4(m) : null;
  if (m && minv) {
    const pt = mulM4V3(minv, co);
    snapToSuperellipsoid(pt, pro.superR, midline);
    return mulM4V3(m, pt);
  }
  return closestToSegment(co, startPlane, endPlane);
}

const compareV3 = (a: V3, b: V3, limit: number): boolean =>
  Math.abs(a[0] - b[0]) <= limit && Math.abs(a[1] - b[1]) <= limit && Math.abs(a[2] - b[2]) <= limit;

/** `pipe_adj_vmesh`. */
function pipeAdjVmesh(p: Params, bv: BevVert, vpipe: BoundVert): VMesh {
  const vm = adjVmesh(p, bv);
  const nBndv = bv.vmesh.count;
  const ns = bv.vmesh.seg;
  const halfNs = Math.floor(ns / 2);
  const ipipe1 = vpipe.index;
  const ipipe2 = vpipe.next.next.index;
  for (let i = 0; i < nBndv; i++)
    for (let j = 1; j <= halfNs; j++)
      for (let k = 0; k <= halfNs; k++) {
        if (!isCanon(vm, i, j, k)) continue;
        const even = ns % 2 === 0;
        const midline = even && k === halfNs && ((i === 0 && j === halfNs) || i === ipipe1 || i === ipipe2);
        const nv = meshVert(vm, i, j, k);
        nv.co = snapToPipeProfile(vpipe, midline, nv.co);
      }
  return vm;
}

/**
 * `square_out_adj_vmesh`: profile 1 with three or more beveled edges.
 *
 * Only ever called with an even segment count (`bevel_build_rings` checks), so
 * Blender's odd-count branch — which reads an uninitialised vector on its
 * first pass — is left out rather than ported.
 */
function squareOutAdjVmesh(p: Params, bv: BevVert): VMesh {
  const nBndv = bv.vmesh.count;
  const ns = bv.vmesh.seg;
  const ns2 = Math.floor(ns / 2);
  const odd = 0;
  const ns2inv = 1 / ns2;
  void p;
  const vm = newAdjVmesh(nBndv, ns, bv.vmesh.boundstart);
  const centerline: V3[][] = Array.from({ length: nBndv }, () => Array.from({ length: ns2 + 1 }, () => [0, 0, 0] as V3));
  const cset = new Array<boolean>(nBndv).fill(false);
  let bndv = vm.boundstart!;
  for (let i = 0; i < nBndv; i++) {
    const bndco = copy(bndv.nv.co);
    const e1 = bndv.efirst;
    const e2 = bndv.elast;
    let angKind: AngleKind = AngleKind.STRAIGHT;
    if (e1 && e2) angKind = edgesAngleKind(e1, e2, bv.v);
    if (angKind === AngleKind.SMALLER) {
      const dir1 = sub(e1!.e.v1.co, e1!.e.v2.co);
      const dir2 = sub(e2!.e.v1.co, e2!.e.v2.co);
      const co1 = add(bndco, dir1);
      const co2 = add(bndco, dir2);
      let r = isectLineLine(e1!.e.v1.co, e1!.e.v2.co, bndco, co2);
      const v1set = r.kind !== 0;
      const v1co = r.i1;
      r = isectLineLine(e2!.e.v1.co, e2!.e.v2.co, bndco, co1);
      const v2set = r.kind !== 0;
      const v2co = r.i1;
      const iprev = i === 0 ? nBndv - 1 : i - 1;
      if (v2set) {
        if (cset[i]) centerline[i]![0] = closer(centerline[i]![0]!, v2co, bv.v.co);
        else {
          centerline[i]![0] = copy(v2co);
          cset[i] = true;
        }
      }
      if (v1set) {
        if (cset[iprev]) centerline[iprev]![0] = closer(centerline[iprev]![0]!, v1co, bv.v.co);
        else {
          centerline[iprev]![0] = copy(v1co);
          cset[iprev] = true;
        }
      }
    }
    bndv = bndv.next;
  }
  bndv = vm.boundstart!;
  for (let i = 0; i < nBndv; i++) {
    if (!cset[i]) {
      const e1 = bndv.next.efirst;
      const co1 = copy(bndv.nv.co);
      const co2 = copy(bndv.next.nv.co);
      if (e1) {
        if (bndv.prev.isArcStart && bndv.next.isArcStart) {
          const r = isectLineLine(e1.e.v1.co, e1.e.v2.co, co1, co2);
          if (r.kind !== 0) {
            centerline[i]![0] = r.i1;
            cset[i] = true;
          }
        } else {
          centerline[i]![0] = closestToSegment(bndv.prev.isArcStart ? co1 : co2, e1.e.v1.co, e1.e.v2.co);
          cset[i] = true;
        }
      }
      if (!cset[i]) {
        centerline[i]![0] = mid(co1, co2);
        cset[i] = true;
      }
    }
    bndv = bndv.next;
  }
  const co2c = copy(bv.v.co);
  bndv = vm.boundstart!;
  for (let i = 0; i < nBndv; i++) {
    const co1 = copy(centerline[i]![0]!);
    for (let j = 1; j <= ns2; j++) centerline[i]![j] = lerp(co1, co2c, j * ns2inv);
    bndv = bndv.next;
  }
  bndv = vm.boundstart!;
  for (let i = 0; i < nBndv; i++) {
    const co1 = copy(bndv.nv.co);
    let co2 = copy(centerline[i === 0 ? nBndv - 1 : i - 1]![0]!);
    for (let j = 0; j < ns2 + odd; j++) meshVert(vm, i, j, 0).co = lerp(co1, co2, j * ns2inv);
    co2 = copy(centerline[i]![0]!);
    for (let k = 1; k <= ns2; k++) meshVert(vm, i, 0, k).co = lerp(co1, co2, k * ns2inv);
    bndv = bndv.next;
  }
  if (!odd) meshVert(vm, 0, ns2, ns2).co = copy(bv.v.co);
  vmeshCopyEquivVerts(vm);
  bndv = vm.boundstart!;
  for (let i = 0; i < nBndv; i++) {
    const im1 = i === 0 ? nBndv - 1 : i - 1;
    for (let j = 1; j < ns2 + odd; j++)
      for (let k = 1; k <= ns2; k++) {
        const r = isectLineLine(meshVert(vm, i, 0, k).co, centerline[im1]![k]!, meshVert(vm, i, j, 0).co, centerline[i]![j]!);
        const nv = meshVert(vm, i, j, k);
        if (r.kind === 0) nv.co = lerp(meshVert(vm, i, 0, k).co, centerline[im1]![k]!, j * ns2inv);
        else if (r.kind === 1) nv.co = r.i1;
        else nv.co = mid(r.i1, r.i2);
      }
    bndv = bndv.next;
  }
  vmeshCopyEquivVerts(vm);
  return vm;
}

const closer = (a: V3, b: V3, v: readonly number[]): V3 => (distSq(a, v) <= distSq(b, v) ? copy(a) : copy(b));

/** `build_square_in_vmesh`: profile 0 at a tri-corner — the edges weld, no patch. */
function buildSquareInVmesh(p: Params, bv: BevVert, vm1: VMesh): void {
  const vm = bv.vmesh;
  const n = vm.count;
  const ns = vm.seg;
  const ns2 = Math.floor(ns / 2);
  const odd = ns % 2;
  for (let i = 0; i < n; i++)
    for (let k = 1; k < ns; k++) {
      meshVert(vm, i, 0, k).co = copy(meshVert(vm1, i, 0, k).co);
      if (i > 0 && k <= ns2) meshVert(vm, i, 0, k).v = meshVert(vm, i - 1, 0, ns - k).v;
      else if (i === n - 1 && k > ns2) meshVert(vm, i, 0, k).v = meshVert(vm, 0, 0, ns - k).v;
      else createMeshBMVert(p, vm, i, 0, k, bv.v);
    }
  if (odd) {
    for (let i = 0; i < n; i++) meshVert(vm, i, ns2, ns2).v = meshVert(vm, i, 0, ns2).v;
    buildCenterNgon(p, bv);
  }
}

/** `build_center_ngon`. */
function buildCenterNgon(p: Params, bv: BevVert): void {
  const vm = bv.vmesh;
  const ns2 = Math.floor(vm.seg / 2);
  const frep = bv.anySeam ? frepForCenterPoly(p, bv) : null;
  const [fe1, fe2] = frep ? incidentEdges(frep, bv.v) : [null, null];
  const unsnapped = frep ? faceInternalBoundverts(bv, frep) : [];
  const verts: BV[] = [];
  const faces: (BF | null)[] = [];
  const snaps: (BE | null)[] = [];
  let v = vm.boundstart!;
  do {
    const bmv = meshVert(vm, v.index, ns2, ns2).v!;
    verts.push(bmv);
    if (frep) {
      faces.push(frep);
      snaps.push(unsnapped.includes(v) || !fe1 || !fe2 ? null : closerEdge(bmv.co, fe1, fe2));
    } else {
      faces.push(boundvertRepFace(v));
      snaps.push(null);
    }
  } while ((v = v.next) !== vm.boundstart);
  bevCreateNgon(p, verts, faces, frep, FKind.VERT, snaps, bv.v);
}

/** `bevel_build_rings`: the ADJ patch's vertices and quads. */
function bevelBuildRings(p: Params, bv: BevVert, vpipe: BoundVert | null): void {
  const nBndv = bv.vmesh.count;
  const ns = bv.vmesh.seg;
  const ns2 = Math.floor(ns / 2);
  const odd = ns % 2;
  let vm1: VMesh;
  if (p.proSuperR === PRO_SQUARE_R && bv.selcount >= 3 && !odd) vm1 = squareOutAdjVmesh(p, bv);
  else if (vpipe) vm1 = pipeAdjVmesh(p, bv, vpipe);
  else if (triCornerTest(p, bv) === 1) {
    vm1 = triCornerAdjVmesh(p, bv);
    if (p.proSuperR === PRO_SQUARE_IN_R) {
      buildSquareInVmesh(p, bv, vm1);
      return;
    }
  } else vm1 = adjVmesh(p, bv);

  const vm = bv.vmesh;
  for (let i = 0; i < nBndv; i++)
    for (let j = 0; j <= ns2; j++)
      for (let k = 0; k <= ns; k++) {
        if (j === 0 && (k === 0 || k === ns)) continue;
        if (!isCanon(vm, i, j, k)) continue;
        meshVert(vm, i, j, k).co = copy(meshVert(vm1, i, j, k).co);
        createMeshBMVert(p, vm, i, j, k, bv.v);
      }
  vmeshCopyEquivVerts(vm);

  const repFaces: (BF | null)[] = new Array(nBndv).fill(null);
  let bndv = vm.boundstart!;
  do repFaces[bndv.index] = boundvertRepFace(bndv);
  while ((bndv = bndv.next) !== vm.boundstart);

  let centerFrep: BF | null = null;
  const frepBeatsNext: boolean[] = [];
  const centerVerts: BV[] = new Array(nBndv);
  const centerFaces: (BF | null)[] = new Array(nBndv).fill(null);
  const oddEdges = odd && !p.affectVertices;
  if (oddEdges) {
    centerFrep = frepForCenterPoly(p, bv);
    for (let i = 0; i < nBndv; i++) {
      const inext = (i + 1) % nBndv;
      const fwinner = chooseRepFace(p, [repFaces[i]!, repFaces[inext]!]);
      frepBeatsNext[i] = fwinner === repFaces[i];
    }
  }
  const centerSnaps: (BE | null)[] = new Array(nBndv).fill(null);
  bndv = vm.boundstart!;
  do {
    const i = bndv.index;
    const inext = bndv.next.index;
    const f = repFaces[i]!;
    const f2 = repFaces[inext]!;
    const fc = oddEdges ? (frepBeatsNext[i] ? f : f2) : null;
    const e = p.affectVertices ? bndv.efirst : bndv.ebev;
    const eprev = p.affectVertices ? bndv.prev.efirst : bndv.prev.ebev;
    const enext = p.affectVertices ? bndv.next.efirst : bndv.next.ebev;
    const bme = e ? e.e : null;
    const bmeprev = eprev ? eprev.e : null;
    const bmenext = enext ? enext.e : null;
    for (let j = 0; j < ns2; j++)
      for (let k = 0; k < ns2 + odd; k++) {
        const bmvs = [
          meshVert(vm, i, j, k).v!,
          meshVert(vm, i, j, k + 1).v!,
          meshVert(vm, i, j + 1, k + 1).v!,
          meshVert(vm, i, j + 1, k).v!,
        ];
        // Each corner interpolates in `fr` and may snap to `se` first.
        let fr: (BF | null)[] = [f, f, f, f];
        let se: (BE | null)[] = [null, null, null, null];
        if (p.affectVertices) {
          fr = [f2, f2, f2, f2];
          if (j < k) {
            if (k === ns2 && j === ns2 - 1) {
              se[2] = bndv.next.efirst!.e;
              se[3] = bme;
            }
          } else if (j === k) {
            // Only one edge at the vertex's boundary point.
            se[0] = se[2] = bme;
            if (!e!.isSeam) fr[3] = f;
          }
        } else if (odd) {
          se = snapEdgesForVmeshVert(
            i, j, k, ns, ns2, nBndv,
            eprev?.isSeam ? bmeprev : null,
            e?.isSeam ? bme : null,
            enext?.isSeam ? bmenext : null,
            repFaces, centerFrep, frepBeatsNext,
          );
          if (k === ns2) {
            if (!e || e.isSeam) fr = [fc, fc, fc, fc];
            else fr = [f, f2, f2, f];
            if (j === ns2 - 1) {
              centerVerts[i] = bmvs[3]!;
              centerSnaps[i] = se[3]!;
              centerFaces[i] = bv.anySeam ? centerFrep : f;
            }
          }
        } else {
          if (k === ns2 - 1) se[1] = bme;
          if (j === ns2 - 1 && bndv.prev.ebev) se[3] = bmeprev;
          se[2] = se[1] ?? se[3]!;
        }
        bevCreateNgon(p, bmvs, fr, null, FKind.VERT, se, bv.v);
      }
  } while ((bndv = bndv.next) !== vm.boundstart);

  if (oddEdges) {
    const frep = bv.anySeam ? frepForCenterPoly(p, bv) : null;
    bevCreateNgon(p, centerVerts, centerFaces, frep, FKind.VERT, centerSnaps, bv.v);
  } else if (odd) buildCenterNgon(p, bv);
}

/** `snap_edge_for_center_vmesh_vert`. */
function snapEdgeForCenterVmeshVert(
  i: number,
  nBndv: number,
  eprev: BE | null,
  enext: BE | null,
  repFaces: (BF | null)[],
  centerFrep: BF | null,
  frepBeatsNext: boolean[],
): BE | null {
  const previ = (i + nBndv - 1) % nBndv;
  const nexti = (i + 1) % nBndv;
  if (frepBeatsNext[previ] && repFaces[previ] === centerFrep) return eprev;
  if (!frepBeatsNext[i] && repFaces[nexti] === centerFrep) return enext;
  return null;
}

/** `snap_edges_for_vmesh_vert`: which edge each corner of patch quad (i, j, k) snaps to (odd `ns`). */
function snapEdgesForVmeshVert(
  i: number,
  j: number,
  k: number,
  ns: number,
  ns2: number,
  nBndv: number,
  eprev: BE | null,
  enext: BE | null,
  enextnext: BE | null,
  repFaces: (BF | null)[],
  centerFrep: BF | null,
  frepBeatsNext: boolean[],
): (BE | null)[] {
  const out: (BE | null)[] = [null, null, null, null];
  if (ns % 2 === 0) return out;
  const previ = (i + nBndv - 1) % nBndv;
  for (let corner = 0; corner < 4; corner++) {
    const jj = corner < 2 ? j : j + 1;
    const kk = corner === 0 || corner === 3 ? k : k + 1;
    if (jj < ns2 && kk < ns2) continue;
    if (jj < ns2 && kk === ns2) {
      if (!frepBeatsNext[i]) out[corner] = enext;
    } else if (jj < ns2 && kk === ns2 + 1) {
      if (frepBeatsNext[i]) out[corner] = enext;
    } else if (jj === ns2 && kk < ns2) {
      if (frepBeatsNext[previ]) out[corner] = eprev;
    } else if (jj === ns2 && kk === ns2) {
      out[corner] = snapEdgeForCenterVmeshVert(i, nBndv, eprev, enext, repFaces, centerFrep, frepBeatsNext);
    } else if (jj === ns2 && kk === ns2 + 1) {
      const nexti = (i + 1) % nBndv;
      out[corner] = snapEdgeForCenterVmeshVert(nexti, nBndv, enext, enextnext, repFaces, centerFrep, frepBeatsNext);
    }
  }
  return out;
}

/** `bevel_build_poly`: the corner closed by one polygon (a single segment). */
function bevelBuildPoly(p: Params, bv: BevVert): BF | null {
  const vm = bv.vmesh;
  const repface = bv.anySeam ? frepForCenterPoly(p, bv) : null;
  const [re1, re2] = repface ? incidentEdges(repface, bv.v) : [null, null];
  const unsnapped = repface ? faceInternalBoundverts(bv, repface) : [];
  const snapTo = (co: readonly number[]): BE | null => (re1 && re2 ? closerEdge(co, re1, re2) : null);
  const verts: BV[] = [];
  const faces: (BF | null)[] = [];
  const snaps: (BE | null)[] = [];
  let bndv = vm.boundstart!;
  do {
    verts.push(bndv.nv.v!);
    if (repface) {
      faces.push(repface);
      snaps.push(unsnapped.includes(bndv) ? null : snapTo(bndv.nv.v!.co));
    } else {
      faces.push(boundvertRepFace(bndv));
      snaps.push(null);
    }
    if (bndv.ebev && bndv.ebev.seg > 1)
      for (let k = 1; k < bndv.ebev.seg; k++) {
        const bmv = meshVert(vm, bndv.index, 0, k).v!;
        verts.push(bmv);
        if (repface) {
          faces.push(repface);
          snaps.push(k < Math.floor(bndv.ebev.seg / 2) ? null : snapTo(bmv.co));
        } else {
          faces.push(boundvertRepFace(bndv));
          snaps.push(null);
        }
      }
  } while ((bndv = bndv.next) !== vm.boundstart);
  if (verts.length > 2) return bevCreateNgon(p, verts, faces, repface, FKind.VERT, snaps, bv.v);
  return null;
}

/** `bevel_build_trifan`: the same polygon, fanned from the vertex before the first. */
function bevelBuildTrifan(p: Params, bv: BevVert): void {
  let f = bevelBuildPoly(p, bv);
  if (!f) return;
  let lFan = f.first!.prev;
  const vFan = lFan.v;
  while (f.len > 3) {
    const lV2 = lFan.next.next;
    const fNew = faceSplit(p.bm, f, lFan, lV2, false);
    if (!fNew) break;
    p.faceKind.set(fNew, FKind.VERT);
    p.faceMat.set(fNew, p.faceMat.get(f) ?? 0);
    // `BM_face_split`'s `r_l`: the new face's loop at the first split vertex,
    // which the kernel links straight into the second one.
    const lNew = faceLoops(fNew).find((l) => l.next === lV2)!;
    if (fNew.len > f.len) {
      f = fNew;
      if (lNew.v === vFan) lFan = lNew;
      else if (lNew.next.v === vFan) lFan = lNew.next;
      else if (lNew.prev.v === vFan) lFan = lNew.prev;
    } else if (lFan.v === vFan) {
      /* unchanged */
    } else if (lFan.next.v === vFan) lFan = lFan.next;
    else if (lFan.prev.v === vFan) lFan = lFan.prev;
  }
}

/**
 * `bevel_vert_two_edges`: a vertex bevel at a vertex with two edges — the
 * profile's points between the two boundary points, and the edges between
 * them where no face will be rebuilt to make them.
 */
function bevelVertTwoEdges(p: Params, bv: BevVert): void {
  const vm = bv.vmesh;
  let v1 = meshVert(vm, 0, 0, 0).v!;
  let v2 = meshVert(vm, 1, 0, 0).v!;
  const ns = vm.seg;
  if (ns > 1) {
    const pro = vm.boundstart!.profile;
    pro.superR = p.proSuperR;
    pro.start = copy(v1.co);
    pro.end = copy(v2.co);
    pro.middle = copy(bv.v.co);
    pro.planeCo = [0, 0, 0];
    pro.planeNo = [0, 0, 0];
    pro.projDir = [0, 0, 0];
    for (let k = 1; k < ns; k++) {
      meshVert(vm, 0, 0, k).co = getProfilePoint(p, pro, k, ns);
      createMeshBMVert(p, vm, 0, 0, k, bv.v);
    }
    meshVert(vm, 0, 0, ns).co = copy(v2.co);
    for (let k = 1; k < ns; k++) copyMeshVert(vm, 1, 0, ns - k, 0, 0, k);
  }
  if (loopsOfVert(bv.v).length === 0) {
    for (let k = 0; k < ns; k++) {
      v1 = meshVert(vm, 0, 0, k).v!;
      v2 = meshVert(vm, 0, 0, k + 1).v!;
      if (!edgeExists(v1, v2)) edgeCreate(p.bm, v1, v2);
    }
  }
}

/** `build_vmesh`: the BMVerts of the boundary and the patch inside it. */
function buildVmesh(p: Params, bv: BevVert): void {
  const vm = bv.vmesh;
  const n = vm.count;
  const ns = vm.seg;
  vm.mesh = allocMesh(n, ns);
  const weld = bv.selcount === 2 && vm.count === 2;
  let weld1: BoundVert | null = null;
  let weld2: BoundVert | null = null;

  let bndv = vm.boundstart!;
  do {
    const i = bndv.index;
    meshVert(vm, i, 0, 0).co = copy(bndv.nv.co);
    createMeshBMVert(p, vm, i, 0, 0, bv.v);
    bndv.nv.v = meshVert(vm, i, 0, 0).v;
    if (weld && bndv.ebev) {
      if (!weld1) weld1 = bndv;
      else {
        weld2 = bndv;
        setProfileParams(p, bv, weld1);
        setProfileParams(p, bv, weld2);
        moveWeldProfilePlanes(bv, weld1, weld2);
      }
    }
  } while ((bndv = bndv.next) !== vm.boundstart);

  calculateVmProfiles(p, bv, vm);

  bndv = vm.boundstart!;
  do {
    const i = bndv.index;
    copyMeshVert(vm, i, 0, ns, bndv.next.index, 0, 0);
    if (vm.kind !== MeshKind.ADJ)
      for (let k = 1; k < ns; k++) {
        if (bndv.ebev) {
          meshVert(vm, i, 0, k).co = getProfilePoint(p, bndv.profile, k, ns);
          if (!weld) createMeshBMVert(p, vm, i, 0, k, bv.v);
        } else if (n === 2 && !bndv.ebev) copyMeshVert(vm, i, 0, k, 1 - i, 0, ns - k);
      }
  } while ((bndv = bndv.next) !== vm.boundstart);

  if (weld) {
    vm.kind = MeshKind.NONE;
    for (let k = 1; k < ns; k++) {
      const vw1 = meshVert(vm, weld1!.index, 0, k).co;
      const vw2 = meshVert(vm, weld2!.index, 0, ns - k).co;
      let co: V3;
      if (weld1!.profile.superR === PRO_LINE_R && weld2!.profile.superR !== PRO_LINE_R) co = copy(vw2);
      else if (weld2!.profile.superR === PRO_LINE_R && weld1!.profile.superR !== PRO_LINE_R) co = copy(vw1);
      else co = mid(vw1, vw2);
      meshVert(vm, weld1!.index, 0, k).co = co;
      createMeshBMVert(p, vm, weld1!.index, 0, k, bv.v);
    }
    for (let k = 1; k < ns; k++) copyMeshVert(vm, weld2!.index, 0, ns - k, weld1!.index, 0, k);
  }

  let vpipe: BoundVert | null = null;
  if ((vm.count === 3 || vm.count === 4) && p.seg > 1) {
    vpipe = pipeTest(bv);
    if (vpipe) vm.kind = MeshKind.ADJ;
  }

  switch (vm.kind) {
    case MeshKind.NONE:
      if (n === 2 && p.affectVertices) bevelVertTwoEdges(p, bv);
      break;
    case MeshKind.POLY:
      bevelBuildPoly(p, bv);
      break;
    case MeshKind.ADJ:
      bevelBuildRings(p, bv, vpipe);
      break;
    case MeshKind.TRI_FAN:
      bevelBuildTrifan(p, bv);
      break;
  }
}

// ── edge order around a vertex ─────────────────────────────────────────────

/** `bevel_edge_order_extend`: the exhaustive fallback for non-manifold fans. */
function bevelEdgeOrderExtend(bv: BevVert, order: (BE | null)[], tagged: Set<BE>, i: number): number {
  const sucs: BE[] = [];
  const bme = order[i]!;
  for (const l of radialLoops(bme)) {
    const bme2 = l.v === bv.v ? l.prev.e! : l.next.e!;
    if (!tagged.has(bme2)) sucs.push(bme2);
  }
  let bestj = i;
  const j = i;
  let savePath: BE[] = [];
  for (const nextbme of sucs) {
    order[j + 1] = nextbme;
    tagged.add(nextbme);
    const tryj = bevelEdgeOrderExtend(bv, order, tagged, j + 1);
    if (tryj > bestj || (tryj === bestj && edgesFaceConnectedAtVert(order[tryj]!, order[0]!))) {
      bestj = tryj;
      savePath = [];
      for (let k = j + 1; k <= bestj; k++) savePath.push(order[k]!);
    }
    for (let k = j + 1; k <= tryj; k++) {
      tagged.delete(order[k]!);
      order[k] = null;
    }
  }
  if (bestj > j)
    for (let k = j + 1; k <= bestj; k++) {
      order[k] = savePath[k - (j + 1)]!;
      tagged.add(order[k]!);
    }
  return bestj;
}

/** `fast_bevel_edge_order` (the legacy version Blender still uses). */
function fastBevelEdgeOrder(bv: BevVert, order: (BE | null)[], tagged: Set<BE>): boolean {
  const ntot = bv.edgecount;
  let bme = order[0]!;
  if (!bme.l) return false;
  for (let i = 1; i < ntot; i++) {
    let numShared = 0;
    let firstSuc: BE | null = null;
    for (const bme2 of diskEdges(bv.v)) {
      if (tagged.has(bme2)) continue;
      for (const l of radialLoops(bme2)) {
        if (faceEdgeShareLoop(l.f, bme)) {
          numShared++;
          firstSuc ??= bme2;
        }
      }
      if (numShared >= 3) break;
    }
    if (numShared === 1 || (i === 1 && numShared === 2)) {
      order[i] = bme = firstSuc!;
      tagged.add(bme);
    } else {
      for (let k = 1; k < i; k++) {
        tagged.delete(order[k]!);
        order[k] = null;
      }
      return false;
    }
  }
  return true;
}

/** `find_bevel_edge_order`: the edges round `bv` so that neighbours share a face, and those faces. */
function findBevelEdgeOrder(bv: BevVert, firstBme: BE, tagged: Set<BE>): void {
  const ntot = bv.edgecount;
  const order: (BE | null)[] = new Array(ntot).fill(null);
  let first: BE | null = firstBme;
  for (let i = 0; ; ) {
    order[i] = first!;
    tagged.add(first!);
    if (i === 0 && fastBevelEdgeOrder(bv, order, tagged)) break;
    i = bevelEdgeOrderExtend(bv, order, tagged, i);
    i++;
    if (i >= ntot) break;
    first = null;
    for (const bme of diskEdges(bv.v)) {
      if (tagged.has(bme)) continue;
      first ??= bme;
      if (edgeFaceCount(bme) === 1) {
        first = bme;
        break;
      }
    }
  }
  bv.edges = order.map((e) => ({ e: e! }) as EdgeHalf);
  for (let i = 0; i < ntot; i++) {
    const e = bv.edges[i]!;
    e.fprev ??= null;
    e.fnext ??= null;
  }
  for (let i = 0; i < ntot; i++) {
    const e = bv.edges[i]!;
    const e2 = i === ntot - 1 ? bv.edges[0]! : bv.edges[i + 1]!;
    const bme = e.e;
    const bme2 = e2.e;
    if (e.fnext !== null || e2.fprev !== null) continue;
    let bestf: BF | null = null;
    for (const l of radialLoops(bme)) {
      if (l.prev.e === bme2 || l.next.e === bme2) if (!bestf || l.v === bv.v) bestf = l.f;
      if (bestf) {
        e.fnext = bestf;
        e2.fprev = bestf;
      }
    }
  }
}

/** `edge_face_angle`: the dihedral's supplement, 0 without two faces. */
function edgeFaceAngle(e: EdgeHalf): number {
  if (e.fprev && e.fnext) return Math.PI - angleNormalized(e.fprev.no, e.fnext.no);
  return 0;
}

/** `bevel_vert_construct`: the BevVert, its ordered edge halves, and their offset specs. */
function bevelVertConstruct(p: Params, v: BV): BevVert | null {
  let nsel = 0;
  let totEdges = 0;
  let totWire = 0;
  let firstBme: BE | null = null;
  const tagged = new Set<BE>();
  const vo = p.affectVertices;
  for (const bme of diskEdges(v)) {
    const faceCount = edgeFaceCount(bme);
    if (p.selected.has(bme) && !vo) {
      nsel++;
      firstBme ??= bme;
    }
    if (faceCount === 1) firstBme = bme;
    if (faceCount > 0 || vo) totEdges++;
    if (isWire(bme)) {
      totWire++;
      // Edge bevels leave wire edges out of the fan; vertex bevels keep them.
      if (!vo) tagged.add(bme);
    }
  }
  firstBme ??= v.e;
  if ((nsel === 0 && !vo) || (totEdges < 2 && vo)) {
    p.tagged.delete(v);
    return null;
  }
  const bv: BevVert = {
    v,
    offset: p.offset,
    edgecount: totEdges,
    selcount: nsel,
    wirecount: totWire,
    anySeam: false,
    edges: [],
    wireEdges: [],
    vmesh: { mesh: [], boundstart: null, count: 0, seg: p.seg, kind: MeshKind.NONE },
  };
  p.vertHash.set(v, bv);
  findBevelEdgeOrder(bv, firstBme!, tagged);

  for (const e of bv.edges) {
    if (p.selected.has(e.e) && !vo) {
      e.isBev = true;
      e.seg = p.seg;
    } else {
      e.isBev = false;
      e.seg = 0;
    }
    e.isRev = e.e.v2 === v;
    e.leftv = e.rightv = null;
    e.profileIndex = 0;
  }

  if (totEdges > 1) {
    let ccwTestSum = 0;
    for (let i = 0; i < totEdges; i++)
      ccwTestSum += bevCcwTest(bv.edges[i]!.e, bv.edges[(i + 1) % totEdges]!.e, bv.edges[i]!.fnext);
    if (ccwTestSum < 0) {
      bv.edges.reverse();
      for (const e of bv.edges) [e.fprev, e.fnext] = [e.fnext, e.fprev];
    }
  }

  // A vertex bevel: the vertex's weight scales its offset; WIDTH and DEPTH
  // measure against the mean of the edge directions.
  let vertAxis: V3 = [0, 0, 0];
  if (vo) {
    if (p.vertexOffsetWeight) bv.offset *= p.vertexOffsetWeight(v);
    if (p.offsetType === "WIDTH" || p.offsetType === "DEPTH")
      for (const e of bv.edges) {
        const d = sub(v.co, otherVert(e.e, v).co);
        normalize(d);
        vertAxis = add(vertAxis, d);
      }
  }
  for (let i = 0; i < totEdges; i++) {
    const e = bv.edges[i]!;
    e.next = bv.edges[(i + 1) % totEdges]!;
    e.prev = bv.edges[(i + totEdges - 1) % totEdges]!;
  }
  for (const e of bv.edges) {
    if (vo && !e.isBev) {
      const d = sub(v.co, otherVert(e.e, v).co);
      switch (p.offsetType) {
        case "OFFSET":
        case "ABSOLUTE":
          e.offsetLSpec = bv.offset;
          break;
        case "WIDTH": {
          const z = Math.abs(2 * Math.sin(angle(vertAxis, d)));
          e.offsetLSpec = z < BEVEL_EPSILON ? 0.01 * p.offset : p.offset / z;
          break;
        }
        case "DEPTH": {
          const z = Math.abs(Math.cos(angle(vertAxis, d)));
          e.offsetLSpec = z < BEVEL_EPSILON ? 0.01 * p.offset : p.offset / z;
          break;
        }
        case "PERCENT":
          e.offsetLSpec = (edgeLength(e.e) * bv.offset) / 100;
          break;
      }
      e.offsetRSpec = e.offsetLSpec;
    } else if (e.isBev) {
      switch (p.offsetType) {
        case "OFFSET":
          e.offsetLSpec = p.offset;
          break;
        case "WIDTH": {
          const z = Math.abs(2 * Math.sin(edgeFaceAngle(e) / 2));
          e.offsetLSpec = z < BEVEL_EPSILON ? 0.01 * p.offset : p.offset / z;
          break;
        }
        case "DEPTH": {
          const z = Math.abs(Math.cos(edgeFaceAngle(e) / 2));
          e.offsetLSpec = z < BEVEL_EPSILON ? 0.01 * p.offset : p.offset / z;
          break;
        }
        case "PERCENT":
          e.offsetLSpec = (edgeLength(e.prev.e) * p.offset) / 100;
          e.offsetRSpec = (edgeLength(e.next.e) * p.offset) / 100;
          break;
        case "ABSOLUTE":
          e.offsetLSpec = p.offset;
          e.offsetRSpec = p.offset;
          break;
      }
      if (p.offsetType !== "PERCENT" && p.offsetType !== "ABSOLUTE") e.offsetRSpec = e.offsetLSpec;
      if (p.weightOf) {
        const weight = p.weightOf(e.e);
        e.offsetLSpec *= weight;
        e.offsetRSpec *= weight;
      }
    } else {
      e.offsetLSpec = e.offsetRSpec = 0;
    }
    e.offsetL = e.offsetLSpec;
    e.offsetR = e.offsetRSpec;
    // A "seam" to bevel is where the corner data (UV, colour) breaks across
    // the edge — read from the data, not the seam flag — or a face is missing.
    e.isSeam = e.fprev && e.fnext ? !contigAcrossEdge(p, e.e, e.fprev, e.fnext) : true;
  }
  if (totWire) bv.wireEdges = diskEdges(v).filter(isWire);
  return bv;
}

// ── rebuilding what the bevel touched ──────────────────────────────────────

/** `bev_rebuild_polygon`: `f` with each beveled vertex replaced by its boundary run. */
function bevRebuildPolygon(p: Params, f: BF): boolean {
  let doRebuild = false;
  const vv: BV[] = [];
  const nvBvMap = new Map<BV, BV>();
  const addMap = (a: BV, b: BV): void => void (nvBvMap.has(a) || nvBvMap.set(a, b));
  for (const l of faceLoops(f)) {
    if (p.tagged.has(l.v)) {
      const lprev = l.prev;
      const bv = p.vertHash.get(l.v)!;
      const vm = bv.vmesh;
      const e = findEdgeHalf(bv, l.e!)!;
      const eprev = findEdgeHalf(bv, lprev.e!)!;
      let goCcw: boolean;
      if (e.prev === eprev) {
        if (eprev.prev === e) goCcw = e.fnext !== f;
        else goCcw = true;
      } else if (eprev.prev === e) goCcw = false;
      else goCcw = countCcwEdgesBetween(eprev, e) < countCcwEdgesBetween(e, eprev);
      let onProfileStart = false;
      let vstart: BoundVert;
      let vend: BoundVert;
      if (goCcw) {
        vstart = eprev.rightv!;
        vend = e.leftv!;
        if (e.profileIndex > 0) {
          vstart = vstart.prev;
          onProfileStart = true;
        }
      } else {
        vstart = eprev.leftv!;
        vend = e.rightv!;
        if (eprev.profileIndex > 0) {
          vstart = vstart.next;
          onProfileStart = true;
        }
      }
      let v = vstart;
      if (!onProfileStart) {
        vv.push(v.nv.v!);
        addMap(v.nv.v!, l.v);
      }
      while (v !== vend) {
        if (goCcw) {
          const i = v.index;
          let kstart: number;
          if (onProfileStart) {
            kstart = e.profileIndex;
            onProfileStart = false;
          } else kstart = 1;
          const kend = eprev.rightv === v && eprev.profileIndex > 0 ? eprev.profileIndex : vm.seg;
          for (let k = kstart; k <= kend; k++) {
            const bmv = meshVert(vm, i, 0, k).v;
            if (bmv) {
              vv.push(bmv);
              addMap(bmv, l.v);
            }
          }
          v = v.next;
        } else {
          const i = v.prev.index;
          let kstart: number;
          if (onProfileStart) {
            kstart = eprev.profileIndex;
            onProfileStart = false;
          } else kstart = vm.seg - 1;
          const kend = e.rightv === v.prev && e.profileIndex > 0 ? e.profileIndex : 0;
          for (let k = kstart; k >= kend; k--) {
            const bmv = meshVert(vm, i, 0, k).v;
            if (bmv) {
              vv.push(bmv);
              addMap(bmv, l.v);
            }
          }
          v = v.prev;
        }
      }
      doRebuild = true;
    } else {
      vv.push(l.v);
      addMap(l.v, l.v);
    }
  }
  if (doRebuild) {
    const fNew = bevCreateNgon(p, vv, null, f, FKind.RECON, null, null, nvBvMap);
    if (fNew) fNew.tag = false;
  }
  return doRebuild;
}

/** `bevel_reattach_wires`. */
function bevelReattachWires(p: Params, v: BV): void {
  const bv = p.vertHash.get(v);
  if (!bv || bv.wirecount === 0 || !bv.vmesh.boundstart) return;
  for (const e of bv.wireEdges) {
    let vclosest: BV | null = null;
    let dclosest = Infinity;
    let votherclosest: BV | null = null;
    const vother = otherVert(e, v);
    let bvother: BevVert | null = null;
    if (p.tagged.has(vother)) {
      bvother = p.vertHash.get(vother) ?? null;
      if (!bvother || !bvother.vmesh.boundstart) return;
    }
    let bndv: BoundVert = bv.vmesh.boundstart;
    do {
      if (bvother) {
        let bo = bvother.vmesh.boundstart!;
        do {
          const d = distSq(bo.nv.co, bndv.nv.co);
          if (d < dclosest) {
            vclosest = bndv.nv.v;
            votherclosest = bo.nv.v;
            dclosest = d;
          }
        } while ((bo = bo.next) !== bvother.vmesh.boundstart);
      } else {
        const d = distSq(vother.co, bndv.nv.co);
        if (d < dclosest) {
          vclosest = bndv.nv.v;
          votherclosest = vother;
          dclosest = d;
        }
      }
    } while ((bndv = bndv.next) !== bv.vmesh.boundstart);
    if (vclosest && votherclosest && !edgeExists(vclosest, votherclosest)) edgeCreate(p.bm, vclosest, votherclosest);
  }
}

/** `bevel_build_edge_polygons`: the chamfer strip along one beveled edge. */
function bevelBuildEdgePolygons(p: Params, bme: BE): void {
  if (!isManifold(bme)) return;
  const bv1 = p.vertHash.get(bme.v1)!;
  const bv2 = p.vertHash.get(bme.v2)!;
  const e1 = findEdgeHalf(bv1, bme)!;
  const e2 = findEdgeHalf(bv2, bme)!;
  const nseg = e1.seg;
  const bmv1 = e1.leftv!.nv.v!;
  const bmv2 = e2.rightv!.nv.v!;
  const f1 = e1.fprev;
  const f2 = e1.fnext;
  const i1 = e1.leftv!.index;
  const i2 = e2.leftv!.index;
  const vm1 = bv1.vmesh;
  const vm2 = bv2.vmesh;
  const verts: BV[] = [bmv1, bmv2, bmv1, bmv1];
  // New vertex → the input vertex it stands for (`Map::add`: the first wins).
  const nvBvMap = new Map<BV, BV>();
  const addMap = (a: BV, b: BV): void => void (nvBvMap.has(a) || nvBvMap.set(a, b));
  addMap(verts[0]!, bv1.v);
  addMap(verts[1]!, bv2.v);
  const odd = nseg % 2 === 1;
  const mid = Math.floor(nseg / 2);
  let fChoice: BF | null = null;
  let centerAdjK = -1;
  if (odd && e1.isSeam) {
    fChoice = chooseRepFace(p, [f1, f2]);
    if (nseg > 1) centerAdjK = fChoice === f1 ? mid + 2 : mid;
  }
  for (let k = 1; k <= nseg; k++) {
    verts[3] = meshVert(vm1, i1, 0, k).v!;
    verts[2] = meshVert(vm2, i2, 0, nseg - k).v!;
    addMap(verts[3]!, bv1.v);
    addMap(verts[2]!, bv2.v);
    const vs = [...verts];
    if (odd && k === mid + 1) {
      if (e1.isSeam) {
        // Straddles a seam: interpolate in one face, snapping the other
        // face's corners onto the edge.
        const edges = fChoice === f1 ? [null, null, bme, bme] : [bme, bme, null, null];
        bevCreateNgon(p, vs, null, fChoice, FKind.EDGE, edges, null, nvBvMap);
      } else {
        // Straddles, no seam: the left half in f1, the right half in f2.
        bevCreateNgon(p, vs, [f1, f1, f2, f2], fChoice, FKind.EDGE, null, null, nvBvMap);
      }
    } else if (odd && k === centerAdjK && e1.isSeam) {
      // The strip beside the centre one, in the other island: snap the
      // side near the seam onto the edge, as the rings do.
      const edges = k === mid ? [null, null, bme, bme] : [bme, bme, null, null];
      bevCreateNgon(p, vs, null, k === mid ? f1 : f2, FKind.EDGE, edges, null, nvBvMap);
    } else if (!odd && k === mid) {
      bevCreateNgon(p, vs, null, f1, FKind.EDGE, [null, null, bme, bme], null, nvBvMap);
    } else if (!odd && k === mid + 1) {
      bevCreateNgon(p, vs, null, f2, FKind.EDGE, [bme, bme, null, null], null, nvBvMap);
    } else {
      bevCreateNgon(p, vs, null, k <= mid ? f1 : f2, FKind.EDGE, null, null, nvBvMap);
    }
    verts[0] = verts[3]!;
    verts[1] = verts[2]!;
  }
}

// ── the profile's sample points ────────────────────────────────────────────

/** `find_superellipse_chord_endpoint`: Illinois false position. */
function findSuperellipseChordEndpoint(x0: number, dtarget: number, r: number, rbig: boolean): number {
  const y0 = superellipseCo(x0, r, rbig);
  const tol = 1e-13;
  const maxiter = 10;
  let xmin = Math.min(x0 + (Math.SQRT2 / 2) * dtarget, 1);
  let xmax = Math.min(x0 + dtarget, 1);
  let ymin = superellipseCo(xmin, r, rbig);
  let ymax = superellipseCo(xmax, r, rbig);
  let dmaxerr = Math.sqrt((xmax - x0) ** 2 + (ymax - y0) ** 2) - dtarget;
  let dminerr = Math.sqrt((xmin - x0) ** 2 + (ymin - y0) ** 2) - dtarget;
  let xnew = xmax - (dmaxerr * (xmax - xmin)) / (dmaxerr - dminerr);
  let lastupdatedUpper = true;
  for (let iter = 0; iter < maxiter; iter++) {
    const ynew = superellipseCo(xnew, r, rbig);
    const dnewerr = Math.sqrt((xnew - x0) ** 2 + (ynew - y0) ** 2) - dtarget;
    if (Math.abs(dnewerr) < tol) break;
    if (dnewerr < 0) {
      xmin = xnew;
      ymin = ynew;
      dminerr = dnewerr;
      if (!lastupdatedUpper) xnew = ((dmaxerr / 2) * xmin - dminerr * xmax) / (dmaxerr / 2 - dminerr);
      else xnew = xmax - (dmaxerr * (xmax - xmin)) / (dmaxerr - dminerr);
      lastupdatedUpper = false;
    } else {
      xmax = xnew;
      ymax = ynew;
      dmaxerr = dnewerr;
      if (lastupdatedUpper) xnew = (dmaxerr * xmin - (dminerr / 2) * xmax) / (dmaxerr - dminerr / 2);
      else xnew = xmax - (dmaxerr * (xmax - xmin)) / (dmaxerr - dminerr);
      lastupdatedUpper = true;
    }
  }
  void ymin;
  void ymax;
  return xnew;
}

/** `find_even_superellipse_chords_general`. */
function findEvenSuperellipseChordsGeneral(seg: number, r: number, xvals: number[], yvals: number[]): void {
  const smoothitermax = 10;
  const errorTol = 1e-7;
  const imax = Math.floor((seg + 1) / 2) - 1;
  const segOdd = seg % 2 === 1;
  let rbig: boolean;
  let mx: number;
  if (r > 1) {
    rbig = true;
    mx = Math.pow(0.5, 1 / r);
  } else {
    rbig = false;
    mx = 1 - Math.pow(0.5, 1 / r);
  }
  for (let i = 0; i <= imax; i++) {
    xvals[i] = ((i * mx) / seg) * 2;
    yvals[i] = superellipseCo(xvals[i]!, r, rbig);
  }
  yvals[0] = 1;
  for (let iter = 0; iter < smoothitermax; iter++) {
    let sum = 0;
    let dmin = 2;
    let dmax = 0;
    for (let i = 0; i < imax; i++) {
      const d = Math.sqrt((xvals[i + 1]! - xvals[i]!) ** 2 + (yvals[i + 1]! - yvals[i]!) ** 2);
      sum += d;
      dmax = Math.max(d, dmax);
      dmin = Math.min(d, dmin);
    }
    let davg: number;
    if (segOdd) {
      sum += (Math.SQRT2 / 2) * (yvals[imax]! - xvals[imax]!);
      davg = sum / (imax + 0.5);
    } else {
      sum += Math.sqrt((xvals[imax]! - mx) ** 2 + (yvals[imax]! - mx) ** 2);
      davg = sum / (imax + 1);
    }
    let precisionReached = true;
    if (dmax - davg > errorTol) precisionReached = false;
    if (dmin - davg < errorTol) precisionReached = false;
    if (precisionReached) break;
    for (let i = 1; i <= imax; i++) {
      xvals[i] = findSuperellipseChordEndpoint(xvals[i - 1]!, davg, r, rbig);
      yvals[i] = superellipseCo(xvals[i]!, r, rbig);
    }
  }
  if (!segOdd) {
    xvals[imax + 1] = mx;
    yvals[imax + 1] = mx;
  }
  for (let i = imax + 1; i <= seg; i++) {
    yvals[i] = xvals[seg - i]!;
    xvals[i] = yvals[seg - i]!;
  }
  if (!rbig)
    for (let i = 0; i <= seg; i++) {
      const temp = xvals[i]!;
      xvals[i] = 1 - yvals[i]!;
      yvals[i] = 1 - temp;
    }
}

/** `find_even_superellipse_chords`. */
function findEvenSuperellipseChords(n: number, r: number): { x: number[]; y: number[] } {
  const x = new Array<number>(n + 1).fill(0);
  const y = new Array<number>(n + 1).fill(0);
  const segOdd = n % 2 === 1;
  const n2 = Math.floor(n / 2);
  if (r === PRO_LINE_R) {
    for (let i = 0; i <= n; i++) {
      x[i] = i / n;
      y[i] = 1 - i / n;
    }
  } else if (r === PRO_CIRCLE_R) {
    const temp = Math.PI / 2 / n;
    for (let i = 0; i <= n; i++) {
      x[i] = Math.sin(i * temp);
      y[i] = Math.cos(i * temp);
    }
  } else if (r === PRO_SQUARE_IN_R) {
    const temp = segOdd ? 1 / (n2 + Math.SQRT2 / 2) : 1 / n2;
    for (let i = 0; i <= n2; i++) {
      x[i] = 0;
      y[i] = 1 - i * temp;
      x[n - i] = y[i]!;
      y[n - i] = x[i]!;
    }
  } else if (r === PRO_SQUARE_R) {
    for (let i = 0; i <= n2; i++) {
      x[i] = segOdd ? i * (1 / (n2 + Math.SQRT2 / 2)) : i / n2;
      y[i] = 1;
      x[n - i] = y[i]!;
      y[n - i] = x[i]!;
    }
  } else findEvenSuperellipseChordsGeneral(n, r, x, y);
  return { x, y };
}

/** `find_profile_fullness`. */
function findProfileFullness(p: Params): number {
  const nseg = p.seg;
  const circleFullness = [0.0, 0.559, 0.642, 0.551, 0.646, 0.624, 0.646, 0.619, 0.647, 0.639, 0.647];
  if (p.proSuperR === PRO_LINE_R) return 0;
  if (p.proSuperR === PRO_CIRCLE_R && nseg > 0 && nseg <= 11) return circleFullness[nseg - 1]!;
  if (nseg % 2 === 0) return 2.4506 * p.profile - 0.000003 * nseg - 0.6266;
  return 2.3635 * p.profile + 0.000152 * nseg - 0.606;
}

/** `set_profile_spacing`. */
function setProfileSpacing(p: Params): void {
  const seg = p.seg;
  const sp = p.proSpacing;
  if (seg <= 1) return;
  let seg2 = 1;
  while (seg2 < seg) seg2 *= 2;
  seg2 = Math.max(seg2, 4);
  sp.seg2 = seg2;
  if (seg2 !== seg) {
    const c2 = findEvenSuperellipseChords(seg2, p.proSuperR);
    sp.xvals2 = c2.x;
    sp.yvals2 = c2.y;
  }
  const c = findEvenSuperellipseChords(seg, p.proSuperR);
  sp.xvals = c.x;
  sp.yvals = c.y;
}

// ── clamp overlap ──────────────────────────────────────────────────────────

/** `geometry_collide_offset`: the offset at which edge `eb`'s clone collapses. */
function geometryCollideOffset(p: Params, eb: EdgeHalf): number {
  const noCollide = p.offset + 1e6;
  let limit = noCollide;
  if (p.offset === 0) return noCollide;
  let kb = eb.offsetLSpec;
  const ea = eb.next;
  const ka = ea.offsetRSpec;
  let vb: BV, vc: BV;
  if (eb.isRev) {
    vc = eb.e.v1;
    vb = eb.e.v2;
  } else {
    vb = eb.e.v1;
    vc = eb.e.v2;
  }
  const va = ea.isRev ? ea.e.v1 : ea.e.v2;
  const { eh: ebother, bv: bvc } = findOtherEndEdgeHalf(p, eb);
  let ec: EdgeHalf | null;
  let vd: BV;
  let kc: number;
  if (p.offsetType === "PERCENT" || p.offsetType === "ABSOLUTE") {
    if (ea.isBev && ebother && ebother.prev.isBev) {
      if (p.offsetType === "PERCENT") return 50;
      const blen = edgeLength(eb.e);
      return p.offset > blen / 2 ? blen / 2 : blen;
    }
    return noCollide;
  }
  if (ebother) {
    ec = ebother.prev;
    vc = bvc!.v;
    kc = ec.offsetLSpec;
    vd = ec.isRev ? ec.e.v1 : ec.e.v2;
  } else {
    kc = 0;
    ec = null;
    if (!eb.fnext) return noCollide;
    const lb = faceEdgeShareLoop(eb.fnext, eb.e);
    if (!lb) return noCollide;
    if (lb.next.v === vc) vd = lb.next.next.v;
    else if (lb.v === vc) vd = lb.prev.v;
    else return noCollide;
  }
  if (ea.e === eb.e || (ec && ec.e === eb.e)) return noCollide;
  const th1 = angle3(va.co, vb.co, vc.co);
  const th2 = angle3(vb.co, vc.co, vd.co);
  const sin1 = Math.sin(th1);
  const sin2 = Math.sin(th2);
  const cos1 = Math.cos(th1);
  const cos2 = Math.cos(th2);
  const safeDivide = (a: number, b: number): number => (b === 0 ? 0 : a / b);
  let projected = safeDivide(ka + cos1 * kb, sin1) + safeDivide(kc + cos2 * kb, sin2);
  if (projected > BEVEL_EPSILON) {
    projected = p.offset * (dist(vb.co, vc.co) / projected);
    if (projected > BEVEL_EPSILON) limit = projected;
  }
  const FLT_EPSILON = 1.1920928955078125e-7;
  if (kb > FLT_EPSILON && (ka === 0 || kc === 0)) {
    kb = p.offset / kb;
    if (ka === 0) {
      let la = faceEdgeShareLoop(eb.fnext!, ea.e);
      if (la) {
        let aSideSlide = 0;
        let exteriorAngle = 0;
        let first = true;
        while (exteriorAngle < 0.0001) {
          if (first) {
            exteriorAngle = Math.PI - th1;
            first = false;
          } else {
            la = la.prev;
            exteriorAngle += Math.PI - angle3(la.v.co, la.next.v.co, la.next.next.v.co);
          }
          aSideSlide += edgeLength(la.e!) * Math.sin(exteriorAngle);
        }
        limit = Math.min(aSideSlide * kb, limit);
      }
    }
    if (kc === 0) {
      let lc = faceEdgeShareLoop(eb.fnext!, eb.e);
      if (lc) {
        lc = lc.next;
        let cSideSlide = 0;
        let exteriorAngle = 0;
        let first = true;
        while (exteriorAngle < 0.0001) {
          if (first) {
            exteriorAngle = Math.PI - th2;
            first = false;
          } else {
            lc = lc.next;
            exteriorAngle += Math.PI - angle3(lc.prev.v.co, lc.v.co, lc.next.v.co);
          }
          cSideSlide += edgeLength(lc.e!) * Math.sin(exteriorAngle);
        }
        limit = Math.min(cSideSlide * kb, limit);
      }
    }
  }
  return limit;
}

/** `bevel_limit_offset`. */
/** `vertex_collide_offset`: where two vertex bevels on one edge would meet. */
function vertexCollideOffset(p: Params, ea: EdgeHalf): number {
  const noCollide = p.offset + 1e6;
  if (p.offset === 0) return noCollide;
  const ka = ea.offsetLSpec / p.offset;
  const eb = findOtherEndEdgeHalf(p, ea).eh;
  const kb = eb ? eb.offsetLSpec / p.offset : 0;
  const kab = ka + kb;
  if (kab <= 0) return noCollide;
  return edgeLength(ea.e) / kab;
}

function bevelLimitOffset(p: Params, verts: BV[]): void {
  let limited = p.offset;
  for (const bmv of verts) {
    if (!p.tagged.has(bmv)) continue;
    const bv = p.vertHash.get(bmv);
    if (!bv) continue;
    for (const eh of bv.edges)
      limited = Math.min(p.affectVertices ? vertexCollideOffset(p, eh) : geometryCollideOffset(p, eh), limited);
  }
  if (limited < p.offset) {
    const factor = limited / p.offset;
    for (const bmv of verts) {
      if (!p.tagged.has(bmv)) continue;
      const bv = p.vertHash.get(bmv);
      if (!bv) continue;
      for (const eh of bv.edges) {
        eh.offsetLSpec *= factor;
        eh.offsetRSpec *= factor;
        eh.offsetL *= factor;
        eh.offsetR *= factor;
      }
    }
    p.offset = limited;
  }
}

// ── entry points ───────────────────────────────────────────────────────────

/**
 * Bevel a mesh's edges — Blender's Bevel modifier, or `bmesh.ops.bevel` when
 * given an explicit edge list (set `clampOverlap` and `loopSlide` to false to
 * get that operator's defaults).
 *
 * @example Every edge of a box, 2 mm, three segments:
 * ```ts
 * const { mesh } = bevelMesh(box({ size: [40, 20, 10] }), { offset: 2, segments: 3, edges: "all" });
 * ```
 *
 * **Layers** (compat-backlog A8): UVs, colours, vertex groups, materials and
 * wire edges are carried as Blender's bevel carries them — see the file's
 * header. Custom normals, creases, seams and sharp edges are dropped whole
 * (compat-backlog C17).
 */
export function bevelMesh(data: MeshData, opts: BevelMeshOptions): BevelResult {
  if (opts.miterOuter && opts.miterOuter !== "SHARP")
    throw new Error(`bevelMesh: miterOuter '${opts.miterOuter}' is not ported — only SHARP.`);
  if (opts.miterInner && opts.miterInner !== "SHARP")
    throw new Error(`bevelMesh: miterInner '${opts.miterInner}' is not ported — only SHARP.`);
  if (opts.vmeshMethod && opts.vmeshMethod !== "ADJ")
    throw new Error(`bevelMesh: vmeshMethod '${opts.vmeshMethod}' is not ported — only ADJ (Grid Fill).`);

  const P = Array.from({ length: data.positions.length / 3 }, (_, i) => [
    data.positions[i * 3]!,
    data.positions[i * 3 + 1]!,
    data.positions[i * 3 + 2]!,
  ]);
  const polys = data.polys.filter((poly) => poly.length >= 3);
  const bm = bmFromMesh({ positions: data.positions, polys, edges: data.edges }, { vertNormals: meshVertNormals(P, polys) });
  const faceMat = new Map<BF, number>();
  const origFaces = bm.faces.items.filter((f): f is BF => !!f);
  const kept = data.polys.map((poly, i) => (poly.length >= 3 ? i : -1)).filter((i) => i >= 0);
  if (data.materials) origFaces.forEach((f, i) => faceMat.set(f, data.materials![kept[i]!] ?? 0));

  // The layers: corners by `src` (bmFromMesh numbers the kept polys' corners
  // in order), groups by vertex.
  const hasUv = !!data.uvs && data.uvs.length === data.polys.length;
  const hasColor = !!data.colors && data.colors.length === data.polys.length;
  const corners: CornerVal[] = [];
  for (const i of kept)
    data.polys[i]!.forEach((_, k) => {
      const val: CornerVal = {};
      if (hasUv) val.uv = [...data.uvs![i]![k]!];
      if (hasColor) val.col = [...data.colors![i]![k]!];
      corners.push(val);
    });
  let groups: Map<BV, Map<string, number>> | null = null;
  if (data.groups) {
    groups = new Map();
    const g = groups;
    bm.verts.forEach((v) => v && g.set(v, new Map()));
    for (const [name, gr] of data.groups)
      for (const [vi, w] of gr) {
        const v = bm.verts[vi];
        if (v) g.get(v)!.set(name, w);
      }
  }

  const segments = Math.max(1, Math.floor(opts.segments ?? 1));
  const profile = opts.profile ?? 0.5;
  const p: Params = {
    bm,
    vertHash: new Map(),
    faceKind: new Map(),
    faceMat,
    selected: new Set(),
    tagged: new Set(),
    proSpacing: { xvals: null, yvals: null, xvals2: null, yvals2: null, seg2: 0, fullness: 0 },
    offset: opts.offset,
    offsetType: opts.offsetType ?? "OFFSET",
    seg: segments,
    profile,
    proSuperR: -Math.log(2) / Math.log(Math.sqrt(profile)),
    loopSlide: opts.loopSlide ?? true,
    limitOffset: opts.clampOverlap ?? true,
    offsetAdjust: false,
    weightOf: null,
    layers: {
      hasUv,
      hasColor,
      corners,
      groups,
      faceComponent: null,
      uvFaces: new Map(),
      uvVertMap: hasUv ? new Map() : null,
    },
    affectVertices: opts.affect === "VERTICES",
    affectVerticesOdd: opts.affect === "VERTICES" && segments % 2 === 1,
    vertexOffsetWeight: null,
  };
  p.offsetAdjust = !p.affectVertices && p.offsetType !== "PERCENT" && p.offsetType !== "ABSOLUTE";
  if (profile >= 0.95) p.proSuperR = PRO_SQUARE_R;
  else if (Math.abs(p.proSuperR - PRO_CIRCLE_R) < 1e-4) p.proSuperR = PRO_CIRCLE_R;
  else if (Math.abs(p.proSuperR - PRO_LINE_R) < 1e-4) p.proSuperR = PRO_LINE_R;
  else if (p.proSuperR < 1e-4) p.proSuperR = PRO_SQUARE_IN_R;

  // Which edges: tag them and their vertices, as the modifier does.
  const edges = liveEdges(bm);
  const sel = opts.edges ?? { angle: Math.PI / 6 };
  if (sel === "all") {
    for (const e of edges) if (isManifold(e)) p.selected.add(e);
  } else if (typeof sel === "object" && "angle" in sel) {
    const threshold = Math.cos(sel.angle + 0.000000175);
    for (const e of edges) {
      const pair = loopPair(e);
      if (pair && dot(pair[0].f.no, pair[1].f.no) < threshold) p.selected.add(e);
    }
  } else if (typeof sel === "object" && "vertexGroup" in sel) {
    // The modifier's VGROUP limit: a manifold edge whose two ends both weigh
    // at least 0.5 (`BKE_defvert_array_find_weight_safe`; 0.5 rather than
    // 0 so a cascaded bevel's interpolated weights do not select). The
    // weights only choose — the offsets are not scaled (compat-backlog B5).
    const vg = vertexGroupWeights(data, sel.vertexGroup, sel.invert);
    const wOf = (v: BV): number => (!vg ? 1 : vg.empty ? (sel.invert ? 1 : 0) : vg.weights[v.index]!);
    for (const e of edges) if (isManifold(e) && wOf(e.v1) >= 0.5 && wOf(e.v2) >= 0.5) p.selected.add(e);
  } else if (typeof sel === "object" && "weights" in sel) {
    // The modifier's WEIGHT limit: selected where the weight is non-zero, and
    // `use_weights` on, so every offset is scaled by its edge's weight. Only
    // original edges are ever asked (the bevel's own new edges are not in
    // the map, and Blender's new edges are not beveled in the same pass).
    const key = (e: BE): string =>
      e.v1.index < e.v2.index ? `${e.v1.index}_${e.v2.index}` : `${e.v2.index}_${e.v1.index}`;
    p.weightOf = (e) => sel.weights.get(key(e)) ?? 0;
    for (const e of edges) if (isManifold(e) && p.weightOf(e) !== 0) p.selected.add(e);
  } else {
    const verts = bm.verts;
    for (const [a, b] of sel as Iterable<readonly [number, number]>) {
      const va = verts[a];
      const vb = verts[b];
      const e = va && vb ? edgeExists(va, vb) : null;
      if (!e) throw new Error(`bevelMesh: no edge between vertices ${a} and ${b}`);
      if (isManifold(e)) p.selected.add(e);
    }
  }
  if (p.affectVertices) {
    // A vertex bevel chooses vertices: every one (limit NONE — and ANGLE,
    // which the modifier ignores for vertices), those at 0.5 or more in a
    // vertex group, whose raw weight then scales the offset, or a list.
    p.selected.clear();
    // An edge list or bevel weights choose edges, which a vertex bevel has no
    // use for — refused rather than read as "every vertex" (found by review).
    if (!opts.vertices && typeof sel === "object" && sel !== null && !("vertexGroup" in sel) && !("angle" in sel))
      throw new Error(
        'bevelMesh: affect "VERTICES" chooses vertices — pass `vertices`, a `{ vertexGroup }`, or "all"; not an edge list or edge weights.',
      );
    const all = bm.verts.filter((v): v is BV => !!v);
    if (opts.vertices) {
      for (const i of opts.vertices) {
        const v = bm.verts[i];
        if (!v) throw new Error(`bevelMesh: no vertex ${i}`);
        p.tagged.add(v);
      }
    } else if (typeof sel === "object" && sel !== null && "vertexGroup" in sel) {
      const vg = vertexGroupWeights(data, sel.vertexGroup, sel.invert);
      const wOf = (v: BV): number => (!vg ? 1 : vg.empty ? (sel.invert ? 1 : 0) : vg.weights[v.index]!);
      for (const v of all) if (wOf(v) >= 0.5) p.tagged.add(v);
      const raw = vertexGroupWeights(data, sel.vertexGroup, false);
      if (raw && !raw.empty) p.vertexOffsetWeight = (v) => raw.weights[v.index]!;
    } else for (const v of all) p.tagged.add(v);
  } else
    for (const e of p.selected) {
      p.tagged.add(e.v1);
      p.tagged.add(e.v2);
    }

  const result = (): BevelResult => {
    const mesh = bmToMesh(bm);
    const live = bm.faces.items.filter((f): f is BF => !!f);
    const names: BevelFaceKind[] = ["orig", "vert", "edge", "recon"];
    const faceKind = live.map((f) => names[p.faceKind.get(f) ?? FKind.ORIG]!);
    if (data.materials) mesh.materials = live.map((f) => faceMat.get(f) ?? 0);
    const C = p.layers.corners;
    if (hasUv) mesh.uvs = live.map((f) => faceLoops(f).map((l) => [...(C[l.src]?.uv ?? [0, 0])]));
    // A corner nothing was interpolated into holds the default: white.
    if (hasColor) mesh.colors = live.map((f) => faceLoops(f).map((l) => [...(C[l.src]?.col ?? [1, 1, 1, 1])]));
    if (groups) {
      const out = new Map<string, Map<number, number>>();
      for (const name of data.groups!.keys()) out.set(name, new Map());
      let n = 0;
      for (const v of bm.verts) {
        if (!v) continue;
        for (const [name, w] of groups.get(v) ?? []) out.get(name)?.set(n, w);
        n++;
      }
      mesh.groups = out;
    }
    const n0 = data.positions.length / 3;
    const origVert = bm.verts.filter((v): v is BV => !!v).map((v) => (v.index < n0 ? v.index : -1));
    return { mesh, faceKind, offset: p.offset, origVert };
  };
  if (p.offset <= 0 || (p.affectVertices ? p.tagged.size === 0 : p.selected.size === 0)) return result();

  setProfileSpacing(p);
  if (p.seg > 1) p.proSpacing.fullness = findProfileFullness(p);
  if (hasUv && p.seg % 2 === 1) p.layers.faceComponent = uvFaceComponents(p, origFaces);

  const verts = bm.verts.filter((v): v is BV => !!v);
  for (const v of verts) {
    if (!p.tagged.has(v)) continue;
    const bv = bevelVertConstruct(p, v);
    if (!p.limitOffset && bv) {
      buildBoundary(p, bv, true);
      determineUvVertConnectivity(p, v);
    }
  }
  if (p.limitOffset) {
    bevelLimitOffset(p, verts);
    for (const v of verts) {
      if (!p.tagged.has(v)) continue;
      const bv = p.vertHash.get(v);
      if (bv) {
        buildBoundary(p, bv, true);
        determineUvVertConnectivity(p, v);
      }
    }
  }
  if (p.offsetAdjust) adjustOffsets(p, verts);

  for (const v of verts) {
    if (!p.tagged.has(v)) continue;
    const bv = p.vertHash.get(v);
    if (bv) buildVmesh(p, bv);
  }
  if (!p.affectVertices) for (const e of edges) if (p.selected.has(e)) bevelBuildEdgePolygons(p, e);

  const rebuilt = new Set<BF>();
  for (const v of verts) {
    if (!p.tagged.has(v)) continue;
    for (const l of loopsOfVert(v)) {
      if (rebuilt.has(l.f)) continue;
      if (bevRebuildPolygon(p, l.f)) rebuilt.add(l.f);
    }
    bevelReattachWires(p, v);
  }
  for (const f of rebuilt) faceKill(bm, f);
  for (const v of verts)
    if (p.tagged.has(v)) {
      p.layers.uvVertMap?.delete(v);
      vertKill(bm, v);
    }
  bevelMergeUvs(p);
  return result();
}

/**
 * Wrap one mesh onto another — Blender's `SHRINKWRAP` modifier.
 *
 * Cheap for the same reason the normal modifiers were: the hard parts already
 * existed. `closestPointOnTriangleBary` was written for `DATA_TRANSFER` and is
 * exact rather than approximate, and `bake-common.ts` has a uniform grid with
 * a DDA traversal and Möller–Trumbore behind `rayNearestHit`. This file is the
 * measured rules on top of those two.
 *
 * ## The three methods
 *
 * | method | what it does |
 * |---|---|
 * | `nearestSurface` | the closest point on the target's surface, face interiors and rims included |
 * | `nearestVertex` | the closest target **vertex** |
 * | `project` | a ray along an axis (or the sum of several), or along the vertex's own normal |
 *
 * `nearestSurface` was checked against a target that is a single quad with a
 * source grid slid so that one column hangs past the rim: the vertices over
 * the quad drop straight down and the ones past it land **on the rim**, which
 * is what says "closest point on the surface" rather than "straight down".
 *
 * ## The offset points two different ways, and both are measured
 *
 * This is the part that would be wrong if guessed. `offset` is one number, but
 * the direction it travels depends on the mode:
 *
 * | mode | direction | rule |
 * |---|---|---|
 * | `onSurface` (default) | `normalize(original - hit)` | back the way the vertex came |
 * | `inside` | the target's **face** normal | clamp the signed distance to `<= -offset` |
 * | `outside` | the target's **face** normal | clamp the signed distance to `>= +offset` |
 * | `outsideSurface` | the target's **face** normal | always `hit + offset * n` |
 *
 * Each row is pinned by a case where the candidates disagree:
 *
 *   * **`onSurface` follows the travel direction, not the normal.** The vertex
 *     that lands on the quad's rim came back at
 *     `(0.53511, -0.2, 0.09363)` — exactly `hit + 0.1 * normalize(original -
 *     hit)`. The target's normal there is still ±z, which would have given
 *     `(0.5, -0.2, 0.1)`. Every vertex sitting squarely above a face agrees
 *     with both readings, so the rim is the only case that asks.
 *   * **the sign follows the vertex, not the world.** With the source moved
 *     *below* the target the same offset came out negative in z, and a vertex
 *     inside a closed box moved further in — so `offset` is "away from the
 *     surface on the side I was on", not "up".
 *   * **`onSurface` does nothing to a vertex already on the surface**, because
 *     `original - hit` is then the zero vector. Measured: it stays put rather
 *     than falling back to the normal.
 *   * **the three clamping modes keep a vertex that is already far enough.**
 *     `outside` leaves a vertex 0.4 outside alone and pushes one 0.05 outside
 *     out to 0.1; `inside` leaves one 0.3 inside alone. `outsideSurface`
 *     always snaps. All four probe points of a closed box fit, at two offsets.
 *
 * ## `project`
 *
 * A ray from the vertex, along `+axis`, `-axis` or both, taking the **nearest**
 * hit when both directions hit — measured on a closed box, where a vertex
 * inside is 0.4 from one face and 0.6 from the other and comes back on the
 * near one. `limit` is a maximum ray length and **0 means unlimited**: at 0.2
 * the same vertex finds nothing and stays put. With no axis chosen Blender
 * uses the vertex's own normal, and a vertex whose ray misses is left alone.
 *
 * **Several axes make one diagonal ray, not a composition.** Blender sums the
 * chosen unit axes and normalises (`proj_axis` in `shrinkwrap.cc`), so X and Z
 * together cast along `(1, 0, 1)/√2`. That is what a measurement once refused
 * as unreadable showed: a vertex at `(0.2, 0.1, 0.9)` above a box came back at
 * `(-0.2, 0.1, 0.5)` — moved by `(-0.4, 0, -0.4)`, along the negative diagonal.
 * Pass the axes as an array.
 *
 * ## `aboveSurface`
 *
 * The offset follows the target's **smooth** normal at the hit
 * (`BKE_shrinkwrap_compute_smooth_normal`): the hit triangle's three vertex
 * normals, blended by the hit's barycentric weights and normalised. Refused
 * until 2026-09-25 as "two unknowns, one measurement" — on a non-cubic box
 * `arm` was out on all 36 vertices by up to 9.5 mm. The source settles both:
 * the vertex normals are `Mesh::vert_normals` (**corner angle** weighted — this
 * file had them by area), and a quad is split (0,1,2)(0,2,3) unless that
 * diagonal is degenerate. A box's corners have three right angles, so its
 * corner normal is `(±1, ±1, ±1)/√3` whatever its proportions.
 *
 * ## `targetProject`
 *
 * The point on the target whose **interpolated** normal passes through the
 * vertex (`mesh_corner_tris_target_project`): Newton's method per triangle,
 * and where that fails on a triangle touching the boundary, each boundary
 * edge as a thin cylinder. The nearest success wins; with none, the plain
 * nearest surface point. Matched on a closed box and an open plane.
 *
 * **Past an open rim Blender is not deterministic**, and this does not follow
 * it there. `shrinkwrap_build_boundary_data` leaves two arrays uninitialised
 * (`boundary_verts`, `vert_status`) and `merge_vert_dir` reads them, so the
 * edge fallback runs on leftover memory — the same vertex landed in three
 * places in three runs. That is what the "opposite corner" once recorded here
 * as the rule was. This file starts those arrays at zero, which is what the
 * code plainly intends, and computes the edge fallback in float32 as Blender
 * does (its near root is lost to cancellation there, which decides which edge
 * wins).
 *
 * ## What is not offered
 *
 * * **`subsurf_levels`**, which subdivides the target first, and
 *   `use_invert_cull`, which moved nothing in any case measured.
 */
import type { MeshData } from "../../lib/mesh";
import { closestPointOnTriangleBary } from "./attribute-transfer";
import {
  buildTriGrid,
  meshBounds,
  rayNearestHit,
  smoothVertexNormals,
  type TriGrid,
} from "../bake-common";
import { f, sub as fsub, dot as fdot, cross as fcross, normalizeInPlace, meshVertNormals, type V3 } from "../blender-math";

export type ShrinkwrapMethod = "nearestSurface" | "nearestVertex" | "project" | "targetProject";

export type ShrinkwrapMode = "onSurface" | "inside" | "outside" | "outsideSurface" | "aboveSurface";

export interface ShrinkwrapProjectOptions {
  /**
   * Which way the ray goes. `"normal"` — Blender's "no axis selected" — uses
   * the vertex's own normal. Default `"normal"`.
   *
   * An array turns several of Blender's `use_project_x/y/z` on at once: the
   * ray goes along their normalised sum, `["x", "z"]` → `(1, 0, 1)/√2`. An
   * empty array is `"normal"`, as it is in Blender.
   */
  axis?: "x" | "y" | "z" | "normal" | readonly ("x" | "y" | "z")[];
  /** Blender's `use_negative_direction`. Default false, Blender's. */
  negative?: boolean;
  /** Blender's `use_positive_direction`. Default true, Blender's. */
  positive?: boolean;
  /** Blender's `project_limit` — the longest ray. **0 is unlimited.** */
  limit?: number;
}

export interface ShrinkwrapOptions {
  /** The mesh to wrap onto. Blender's `target`. */
  target: MeshData;
  /** Blender's `wrap_method`. Default `"nearestSurface"`, Blender's. */
  method?: ShrinkwrapMethod;
  /** Blender's `wrap_mode`. Default `"onSurface"`, Blender's. */
  mode?: ShrinkwrapMode;
  /** How far from the target to stop. Blender's `offset`. Default 0. */
  offset?: number;
  /** Only used when `method` is `"project"`. */
  project?: ShrinkwrapProjectOptions;
  /**
   * Which vertices may move. Default all of them — Blender uses a vertex
   * group, which this expresses as a plain set.
   */
  verts?: ReadonlySet<number>;
}

type Vec3 = [number, number, number];

/** A target, triangulated once, with everything the queries need. */
interface Target {
  positions: Float32Array;
  /** Triangle corner indices, three per triangle. */
  tris: number[];
  /** Which source polygon each triangle came from, for its face normal. */
  triFace: number[];
  faceNormals: Vec3[];
  vertexNormals: Float32Array;
  grid: TriGrid;
}

function normalized(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  return len > 1e-30 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 0, 0];
}

function faceNormal(P: Float32Array, poly: readonly number[]): Vec3 {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]! * 3;
    const b = poly[(i + 1) % poly.length]! * 3;
    nx += (P[a + 1]! - P[b + 1]!) * (P[a + 2]! + P[b + 2]!);
    ny += (P[a + 2]! - P[b + 2]!) * (P[a]! + P[b]!);
    nz += (P[a]! - P[b]!) * (P[a + 1]! + P[b + 1]!);
  }
  return normalized([nx, ny, nz]);
}

function prepare(target: MeshData): Target {
  const positions = Float32Array.from(target.positions);
  const tris: number[] = [];
  const triFace: number[] = [];
  const faceNormals: Vec3[] = [];
  for (const [f, poly] of target.polys.entries()) {
    faceNormals.push(faceNormal(positions, poly));
    // Blender's `corner_tris`: a quad as (0,1,2) (0,2,3) unless that diagonal
    // is degenerate (`is_quad_flip_v3_first_third_fast`), then (0,1,3)
    // (1,2,3). Larger faces as a fan here — Blender polyfills them, which is
    // the same only when they are convex.
    if (poly.length === 4 && quadFlips(positions, poly)) {
      tris.push(poly[0]!, poly[1]!, poly[3]!, poly[1]!, poly[2]!, poly[3]!);
      triFace.push(f, f);
      continue;
    }
    for (let i = 1; i + 1 < poly.length; i++) {
      tris.push(poly[0]!, poly[i]!, poly[i + 1]!);
      triFace.push(f);
    }
  }
  // `Mesh::vert_normals`: corner-angle weighted (the port shared with the
  // Displace and Wave modifiers).
  const pts: V3[] = [];
  for (let v = 0; v * 3 < positions.length; v++)
    pts.push([positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!]);
  const vertexNormals = Float32Array.from(meshVertNormals(pts, target.polys).flat());
  const bounds = meshBounds(positions);
  if (!bounds) throw new Error("shrinkwrap: the target has no vertices");
  return {
    positions,
    tris,
    triFace,
    faceNormals,
    vertexNormals,
    grid: buildTriGrid(positions, tris, bounds.min, bounds.max),
  };
}

interface Hit {
  point: Vec3;
  /** The target's flat normal at the hit. */
  faceNormal: Vec3;
  /** The triangle hit and the point's weights on its corners, for `aboveSurface`. */
  tri?: number;
  bary?: Vec3;
}

/** `is_quad_flip_v3_first_third_fast`: is the 0–2 diagonal degenerate? */
function quadFlips(P: Float32Array, q: readonly number[]): boolean {
  const at = (v: number): Vec3 => [P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!];
  const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const v1 = at(q[0]!);
  const d13 = sub(at(q[2]!), v1);
  const a = cross(sub(at(q[1]!), v1), d13);
  const b = cross(sub(at(q[3]!), v1), d13);
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] > 0;
}

/**
 * `BKE_shrinkwrap_compute_smooth_normal`: the hit triangle's vertex normals
 * blended by the hit's weights, normalised. (Blender does this only for faces
 * flagged sharp, or when the mesh has no sharp-face layer at all — which reads
 * backwards but is what it does; `MeshData` carries no such flag, and a mesh
 * from `from_pydata` has every face flagged, so the blend is the case here.)
 */
function smoothNormalAt(t: Target, hit: Hit): Vec3 {
  if (hit.tri === undefined || !hit.bary) return hit.faceNormal;
  const n: Vec3 = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const v = t.tris[hit.tri * 3 + c]!;
    for (let k = 0; k < 3; k++) n[k] = n[k]! + t.vertexNormals[v * 3 + k]! * hit.bary[c]!;
  }
  return normalized(n);
}

/** The closest point on the target's surface, and the face's normal there. */
function nearestSurface(t: Target, p: Vec3): Hit | null {
  let best = Infinity;
  let point: Vec3 = [0, 0, 0];
  let tri = -1;
  let bary: Vec3 = [1, 0, 0];
  for (let i = 0; i * 3 < t.tris.length; i++) {
    const a = t.tris[i * 3]! * 3;
    const b = t.tris[i * 3 + 1]! * 3;
    const c = t.tris[i * 3 + 2]! * 3;
    const r = closestPointOnTriangleBary(
      p[0], p[1], p[2],
      t.positions[a]!, t.positions[a + 1]!, t.positions[a + 2]!,
      t.positions[b]!, t.positions[b + 1]!, t.positions[b + 2]!,
      t.positions[c]!, t.positions[c + 1]!, t.positions[c + 2]!,
    );
    if (r.dist2 < best) {
      best = r.dist2;
      tri = i;
      bary = [r.u, r.v, r.w];
      point = [
        t.positions[a]! * r.u + t.positions[b]! * r.v + t.positions[c]! * r.w,
        t.positions[a + 1]! * r.u + t.positions[b + 1]! * r.v + t.positions[c + 1]! * r.w,
        t.positions[a + 2]! * r.u + t.positions[b + 2]! * r.v + t.positions[c + 2]! * r.w,
      ];
    }
  }
  if (tri < 0) return null;
  return { point, faceNormal: t.faceNormals[t.triFace[tri]!]!, tri, bary };
}

// ── TARGET_PROJECT ─────────────────────────────────────────────────────────
// `mesh_corner_tris_target_project` and what it calls, from `shrinkwrap.cc`.
// Per triangle, Newton's method finds the point whose **interpolated** normal
// passes through the vertex; where that fails on a triangle touching the
// boundary, the boundary edges are tried as thin cylinders. The nearest
// success wins; with none, the plain nearest surface point. Blender's BVH
// only skips triangles whose nearest point is already no better than the best
// hit — a lower bound — so trying every triangle gives the same answer except
// at exact ties.

type M3 = [Vec3, Vec3, Vec3]; // columns, as Blender's float[3][3]

const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const interp3 = (a: Vec3, b: Vec3, c: Vec3, w: Vec3): Vec3 => [
  a[0] * w[0] + b[0] * w[1] + c[0] * w[2],
  a[1] * w[0] + b[1] * w[1] + c[1] * w[2],
  a[2] * w[0] + b[2] * w[1] + c[2] * w[2],
];

/** `invert_m3` on columns; null when the determinant is zero. */
function invert3(m: M3): M3 | null {
  const [a, b, c] = m;
  const det = dot3(a, cross3(b, c));
  if (det === 0) return null;
  // The inverse's rows are the columns' pairwise cross products over det.
  const r0 = cross3(b, c);
  const r1 = cross3(c, a);
  const r2 = cross3(a, b);
  return [
    [r0[0] / det, r1[0] / det, r2[0] / det],
    [r0[1] / det, r1[1] / det, r2[1] / det],
    [r0[2] / det, r1[2] / det, r2[2] / det],
  ];
}
/** `mul_v3_m3v3` with column storage. */
const mulM3 = (m: M3, v: Vec3): Vec3 => [
  m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2],
  m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2],
  m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2],
];

/** `target_project_tri_clamp` */
function triClamp(x: Vec3): void {
  x[0] = Math.max(x[0], 0);
  x[1] = Math.max(x[1], 0);
  if (x[0] + x[1] > 1) {
    x[0] = x[0] / (x[0] + x[1]);
    x[1] = 1 - x[0];
  }
}

/** `target_project_tri_correct`: keep a step inside the barycentric triangle. */
function triCorrect(x: Vec3, step: Vec3, xNext: Vec3): boolean {
  const epsilon = 1e-5;
  const dirEpsilon = 0.5;
  let fixed = false;
  let locked = false;
  const sum = x[0] + x[1];
  const sstep = -(step[0] + step[1]);
  if (sum + sstep > 1) {
    const ldist = 1 - sum;
    if (ldist < epsilon * Math.SQRT2) {
      const len = Math.hypot(step[0], step[1]);
      if (len > epsilon && sstep > len * dirEpsilon * Math.SQRT2) return false;
      const d = (sum + sstep - 1) * 0.5;
      step[0] += d;
      step[1] += d;
      fixed = locked = true;
    } else {
      const k = ldist / sstep;
      step[0] *= k;
      step[1] *= k;
      step[2] *= k;
      fixed = true;
    }
  }
  for (let i = 0; i < 2; i++)
    if (step[i]! > x[i]!) {
      if (x[i]! < epsilon) {
        const len = Math.hypot(step[0], step[1]);
        if (len > epsilon && (locked || step[i]! > len * dirEpsilon)) return false;
        step[i] = x[i]!;
        fixed = true;
      } else {
        const k = x[i]! / step[i]!;
        step[0] *= k;
        step[1] *= k;
        step[2] *= k;
        fixed = true;
      }
    }
  if (fixed) {
    xNext[0] = x[0] - step[0];
    xNext[1] = x[1] - step[1];
    xNext[2] = x[2] - step[2];
    triClamp(xNext);
  }
  return true;
}

/** `target_project_solve_point_tri` with `BLI_newton3d_solve` (20 iterations, line search). */
function solvePointTri(
  co: [Vec3, Vec3, Vec3],
  no: [Vec3, Vec3, Vec3],
  point: Vec3,
  bary: Vec3,
  distSq: number,
): { co: Vec3; no: Vec3 } | null {
  const dist = Math.sqrt(distSq);
  const manhattan = (v: Vec3): number => Math.abs(v[0]) + Math.abs(v[1]) + Math.abs(v[2]);
  const magnitude = dist + manhattan(co[0]) + manhattan(co[1]) + manhattan(co[2]);
  const eps = (magnitude * 1e-6) ** 2;

  const x: Vec3 = [bary[0], bary[1], 0];
  const hitCo = interp3(co[0], co[1], co[2], bary);
  const hitNo = interp3(no[0], no[1], no[2], bary);
  x[2] = dot3(sub3(point, hitCo), hitNo) < 0 ? -dist : dist;

  const n02 = sub3(no[0], no[2]);
  const n12 = sub3(no[1], no[2]);
  const c02 = sub3(co[0], co[2]);
  const c12 = sub3(co[1], co[2]);
  triClamp(x);

  let coInterp: Vec3 = [0, 0, 0];
  let noInterp: Vec3 = [0, 0, 0];
  const delta = (v: Vec3): Vec3 => {
    const w: Vec3 = [v[0], v[1], 1 - v[0] - v[1]];
    coInterp = interp3(co[0], co[1], co[2], w);
    noInterp = interp3(no[0], no[1], no[2], w);
    return [
      coInterp[0] + noInterp[0] * v[2] - point[0],
      coInterp[1] + noInterp[1] * v[2] - point[1],
      coInterp[2] + noInterp[2] * v[2] - point[2],
    ];
  };
  const jacobian = (v: Vec3): M3 => [
    [c02[0] + n02[0] * v[2], c02[1] + n02[1] * v[2], c02[2] + n02[2] * v[2]],
    [c12[0] + n12[0] * v[2], c12[1] + n12[1] * v[2], c12[2] + n12[2] * v[2]],
    [
      no[2][0] + n02[0] * v[0] + n12[0] * v[1],
      no[2][1] + n02[1] * v[0] + n12[1] * v[1],
      no[2][2] + n02[2] * v[0] + n12[2] * v[1],
    ],
  ];

  let fdelta = delta(x);
  let fv = dot3(fdelta, fdelta);
  for (let i = 0; i === 0 || (i < 20 && fv > eps); i++) {
    const inv = invert3(jacobian(x));
    if (!inv) return null;
    const step = mulM3(inv, fdelta);
    const xNext: Vec3 = [x[0] - step[0], x[1] - step[1], x[2] - step[2]];
    if (!triCorrect(x, step, xNext)) return null;
    fdelta = delta(xNext);
    let nv = dot3(fdelta, fdelta);
    while (nv > fv && nv > eps) {
      const g0 = Math.sqrt(fv);
      const g1 = Math.sqrt(nv);
      const g01 = -g0 / Math.hypot(step[0], step[1], step[2]);
      const det = 2 * (g1 - g0 - g01);
      const l = Math.max(det === 0 ? 0.1 : -g01 / det, 0.1);
      step[0] *= l;
      step[1] *= l;
      step[2] *= l;
      xNext[0] = x[0] - step[0];
      xNext[1] = x[1] - step[1];
      xNext[2] = x[2] - step[2];
      fdelta = delta(xNext);
      nv = dot3(fdelta, fdelta);
    }
    x[0] = xNext[0];
    x[1] = xNext[1];
    x[2] = xNext[2];
    fv = nv;
  }
  if (!(fv <= eps)) return null;
  return { co: coInterp, no: noInterp };
}

interface Boundary {
  /** Edges used by exactly one face, keyed `lo_hi`. */
  edges: Set<string>;
  /** Per boundary vertex: the averaged edge direction and the normal-plane vector. */
  direction: Map<number, V3>;
  normalPlane: Map<number, V3>;
}

/** `shrinkwrap_build_boundary_data`. */
function boundaryOf(t: Target, polys: readonly (readonly number[])[]): Boundary | null {
  const key = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const uses = new Map<string, number>();
  const order: [number, number][] = [];
  for (const poly of polys)
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      const k = key(a, b);
      if (!uses.has(k)) order.push(a < b ? [a, b] : [b, a]);
      uses.set(k, (uses.get(k) ?? 0) + 1);
    }
  const edges = new Set<string>();
  for (const [k, n] of uses) if (n === 1) edges.add(k);
  if (edges.size === 0) return null;

  // `merge_vert_dir`: the sign bookkeeping cancels in the end (the edge's
  // direction is re-aligned against the edge before use). In float32 like the
  // rest of the edge fallback — see `projectEdge`.
  const direction = new Map<number, V3>();
  const status = new Map<number, number>();
  const merge = (v: number, dir: V3, side: number): void => {
    const d = direction.get(v) ?? [0, 0, 0];
    const st = status.get(v) ?? 0;
    const flip = st >= 0 ? st === side : fdot(d, dir) < 0;
    direction.set(v, flip ? fsub(d, dir) : [f(d[0]! + dir[0]!), f(d[1]! + dir[1]!), f(d[2]! + dir[2]!)]);
    status.set(v, st === 0 ? side : -1);
  };
  const at = (v: number): V3 => [t.positions[v * 3]!, t.positions[v * 3 + 1]!, t.positions[v * 3 + 2]!];
  for (const [a, b] of order) {
    if (!edges.has(key(a, b))) continue;
    const dir = fsub(at(b), at(a));
    normalizeInPlace(dir);
    merge(a, dir, 1);
    merge(b, dir, 2);
  }
  const normalPlane = new Map<number, V3>();
  for (const [v, d] of direction) {
    normalizeInPlace(d);
    const n: V3 = [t.vertexNormals[v * 3]!, t.vertexNormals[v * 3 + 1]!, t.vertexNormals[v * 3 + 2]!];
    const plane = fcross(fcross(n, d), n);
    normalizeInPlace(plane);
    normalPlane.set(v, plane);
  }
  return { edges, direction, normalPlane };
}

/**
 * `target_project_edge`: a boundary edge as an infinitely thin cylinder.
 *
 * **In float32, in C's order, on purpose.** On an edge that is nearly
 * symmetric the quadratic's `a` is nearly zero, and `(−b ± √det) / 2a` then
 * loses the near root to cancellation — Blender finds nothing on the near
 * edge and takes the **far** one. That is the "vertex past the rim lands on
 * the opposite side" that kept `TARGET_PROJECT` out until 2026-09-25; in
 * double the near root survives and every such vertex comes out 240 mm away
 * from Blender's. Same lesson as `SKIN`'s frames and `edgeFaceAdd`'s cloud.
 */
function projectEdge(t: Target, b: Boundary, a0: number, a1: number, p: Vec3): { co: Vec3; no: Vec3 }[] {
  const at = (v: number): V3 => [t.positions[v * 3]!, t.positions[v * 3 + 1]!, t.positions[v * 3 + 2]!];
  const vn = (v: number): V3 => [t.vertexNormals[v * 3]!, t.vertexNormals[v * 3 + 1]!, t.vertexNormals[v * 3 + 2]!];
  // The mesh stores an edge low index first.
  const [e0, e1] = a0 < a1 ? [a0, a1] : [a1, a0];
  const v0 = at(e0);
  const v1 = at(e1);
  const co: V3 = [f(p[0]), f(p[1]), f(p[2])];
  const dir = fsub(v1, v0);
  let d0 = b.normalPlane.get(e0)!;
  let d1 = b.normalPlane.get(e1)!;
  if (fdot(b.direction.get(e0)!, dir) < 0) d0 = [-d0[0]!, -d0[1]!, -d0[2]!];
  if (fdot(b.direction.get(e1)!, dir) < 0) d1 = [-d1[0]!, -d1[1]!, -d1[2]!];
  const d0v0 = fdot(d0, v0);
  const d0v1 = fdot(d0, v1);
  const d1v0 = fdot(d1, v0);
  const d1v1 = fdot(d1, v1);
  const d0co = fdot(d0, co);
  const a = f(f(f(d0v1 - d0v0) + d1v0) - d1v1);
  const out: { co: Vec3; no: Vec3 }[] = [];
  if (a === 0) return out;
  const bq = f(f(f(f(f(2 * d0v0) - d0v1) - d0co) - d1v0) + fdot(d1, co));
  const c = f(d0co - d0v0);
  const det = f(f(bq * bq) - f(f(4 * a) * c));
  if (!(det >= 0)) return out;
  const sdet = f(Math.sqrt(det));
  for (let i = det > 0 ? 2 : 0; i >= 0; i -= 2) {
    let x = f(f(-bq + f((i - 1) * sdet)) / f(2 * a));
    if (!(x >= -1e-6 && x <= 1 + 1e-6)) continue;
    x = Math.min(1, Math.max(0, x));
    const n0 = vn(e0);
    const n1 = vn(e1);
    // `interp_v3_v3v3`: a + (b − a)·t
    out.push({
      co: [0, 1, 2].map((k) => f(v0[k]! + f(f(v1[k]! - v0[k]!) * x))) as Vec3,
      no: [0, 1, 2].map((k) => f(n0[k]! + f(f(n1[k]! - n0[k]!) * x))) as Vec3,
    });
  }
  return out;
}

const boundaryCache = new WeakMap<Target, Boundary | null>();

function targetProject(t: Target, target: MeshData, p: Vec3): Hit | null {
  if (!boundaryCache.has(t)) boundaryCache.set(t, boundaryOf(t, target.polys));
  const boundary = boundaryCache.get(t)!;
  const at = (v: number): Vec3 => [t.positions[v * 3]!, t.positions[v * 3 + 1]!, t.positions[v * 3 + 2]!];
  const vn = (v: number): Vec3 => [t.vertexNormals[v * 3]!, t.vertexNormals[v * 3 + 1]!, t.vertexNormals[v * 3 + 2]!];
  const key = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);

  let bestSq = Infinity;
  let best: Hit | null = null;
  const update = (tri: number, co: Vec3, no: Vec3): void => {
    const d = sub3(co, p);
    const dsq = dot3(d, d);
    if (dsq < bestSq) {
      bestSq = dsq;
      best = { point: co, faceNormal: normalized(no), tri };
    }
  };
  for (let i = 0; i * 3 < t.tris.length; i++) {
    const tv = [t.tris[i * 3]!, t.tris[i * 3 + 1]!, t.tris[i * 3 + 2]!] as const;
    const co: [Vec3, Vec3, Vec3] = [at(tv[0]), at(tv[1]), at(tv[2])];
    const r = closestPointOnTriangleBary(p[0], p[1], p[2], ...co[0], ...co[1], ...co[2]);
    if (r.dist2 >= bestSq) continue;
    const solved = solvePointTri(co, [vn(tv[0]), vn(tv[1]), vn(tv[2])], p, [r.u, r.v, r.w], r.dist2);
    if (solved) {
      update(i, solved.co, solved.no);
      continue;
    }
    if (!boundary) continue;
    // The triangle's real edges (not a quad's diagonal) that are boundary.
    const poly = target.polys[t.triFace[i]!]!;
    for (let e = 0; e < 3; e++) {
      const a = tv[e]!;
      const b = tv[(e + 1) % 3]!;
      const ia = poly.indexOf(a);
      const ib = poly.indexOf(b);
      const adjacent = (ia + 1) % poly.length === ib || (ib + 1) % poly.length === ia;
      if (!adjacent || !boundary.edges.has(key(a, b))) continue;
      for (const hit of projectEdge(t, boundary, a, b, p)) update(i, hit.co, hit.no);
    }
  }
  return best ?? nearestSurface(t, p);
}

function nearestVertex(t: Target, p: Vec3): Hit | null {
  let best = Infinity;
  let at = -1;
  for (let v = 0; v * 3 < t.positions.length; v++) {
    const dx = t.positions[v * 3]! - p[0];
    const dy = t.positions[v * 3 + 1]! - p[1];
    const dz = t.positions[v * 3 + 2]! - p[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    // Strictly less, so the **lowest index** wins a tie. Blender's answer at a
    // tie comes out of its BVH traversal order, which is not something a
    // library can or should reproduce; this is decided and written down
    // instead (`probe-shrinkwrap.py` has a row of three tied vertices).
    if (d2 < best) {
      best = d2;
      at = v;
    }
  }
  if (at < 0) return null;
  const n: Vec3 = normalized([
    t.vertexNormals[at * 3]!,
    t.vertexNormals[at * 3 + 1]!,
    t.vertexNormals[at * 3 + 2]!,
  ]);
  return {
    point: [t.positions[at * 3]!, t.positions[at * 3 + 1]!, t.positions[at * 3 + 2]!],
    faceNormal: n,
  };
}

function project(t: Target, p: Vec3, dir: Vec3, opts: ShrinkwrapProjectOptions): Hit | null {
  const negative = opts.negative ?? false;
  const positive = opts.positive ?? true;
  const limit = opts.limit ?? 0;
  const tMax = limit > 0 ? limit : Infinity;
  let bestT = Infinity;
  let bestHit: Hit | null = null;
  for (const sign of [positive ? 1 : 0, negative ? -1 : 0]) {
    if (sign === 0) continue;
    const hit = rayNearestHit(
      t.grid, t.positions, t.tris,
      p[0], p[1], p[2],
      dir[0] * sign, dir[1] * sign, dir[2] * sign,
      tMax,
    );
    if (hit && hit.t < bestT) {
      bestT = hit.t;
      bestHit = {
        point: [
          p[0] + dir[0] * sign * hit.t,
          p[1] + dir[1] * sign * hit.t,
          p[2] + dir[2] * sign * hit.t,
        ],
        faceNormal: t.faceNormals[t.triFace[hit.face]!]!,
        tri: hit.face,
        bary: [hit.w0, hit.w1, hit.w2],
      };
    }
  }
  return bestHit;
}

/** Per-vertex normals of the source, for `project`'s `"normal"` axis. */
function sourceNormals(data: MeshData): Float32Array {
  const tris: number[] = [];
  for (const poly of data.polys)
    for (let i = 1; i + 1 < poly.length; i++) tris.push(poly[0]!, poly[i]!, poly[i + 1]!);
  return smoothVertexNormals(data.positions, tris, data.positions.length / 3);
}

/**
 * Move each vertex onto (or a fixed distance from) another mesh — Blender's
 * **Shrinkwrap** modifier.
 *
 * ```ts
 * shrinkwrap(mesh, { target });                                  // onto the surface
 * shrinkwrap(mesh, { target, offset: 0.01 });                    // 1 cm clear of it
 * shrinkwrap(mesh, { target, mode: "outside" });                 // never inside
 * shrinkwrap(mesh, { target, method: "project", project: { axis: "z", negative: true } });
 * ```
 *
 * The `offset` travels in a different direction for each mode, and all five
 * are measured — the table at the top of this file is worth reading before
 * choosing one.
 */
export function shrinkwrap(data: MeshData, options: ShrinkwrapOptions): MeshData {
  const method = options.method ?? "nearestSurface";
  const mode = options.mode ?? "onSurface";
  const offset = options.offset ?? 0;
  const t = prepare(options.target);
  if (t.tris.length === 0) throw new Error("shrinkwrap: the target has no faces");

  const projectOpts = options.project ?? {};
  // `proj_axis` in `shrinkwrap.cc`: the chosen unit axes summed; none is "normal".
  const rawAxis = projectOpts.axis ?? "normal";
  const axes = rawAxis === "normal" ? [] : typeof rawAxis === "string" ? [rawAxis] : rawAxis;
  const axisDir: Vec3 = [
    axes.includes("x") ? 1 : 0,
    axes.includes("y") ? 1 : 0,
    axes.includes("z") ? 1 : 0,
  ];
  const normals = method === "project" && axes.length === 0 ? sourceNormals(data) : null;

  const positions = Float32Array.from(data.positions);
  const count = positions.length / 3;
  for (let v = 0; v < count; v++) {
    if (options.verts && !options.verts.has(v)) continue;
    const p: Vec3 = [positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!];

    let hit: Hit | null;
    if (method === "nearestVertex") hit = nearestVertex(t, p);
    else if (method === "targetProject") hit = targetProject(t, options.target, p);
    else if (method === "project") {
      const dir: Vec3 = normals
        ? [normals[v * 3]!, normals[v * 3 + 1]!, normals[v * 3 + 2]!]
        : axisDir;
      hit = project(t, p, normalized(dir), projectOpts);
    } else hit = nearestSurface(t, p);

    // A ray that misses leaves its vertex exactly where it was — measured.
    if (!hit) continue;

    const out = place(t, p, hit, mode, offset);
    positions[v * 3] = out[0];
    positions[v * 3 + 1] = out[1];
    positions[v * 3 + 2] = out[2];
  }

  const result: MeshData = { positions, polys: data.polys.map((poly) => [...poly]) };
  if (data.creases) result.creases = new Map(data.creases);
  if (data.seams) result.seams = new Set(data.seams);
  if (data.sharp && data.sharp.size > 0) result.sharp = new Set(data.sharp);
  if (data.edges) result.edges = data.edges.map((e) => [...e]);
  if (data.uvs) result.uvs = data.uvs.map((f) => f.map((c) => [...c]));
  if (data.colors) result.colors = data.colors.map((f) => f.map((c) => [...c]));
  if (data.normals) result.normals = data.normals.map((f) => f.map((c) => [...c]));
  if (data.groups) result.groups = new Map([...data.groups].map(([k, g]) => [k, new Map(g)]));
  if (data.materials) result.materials = [...data.materials];
  return result;
}

/** Where the vertex ends up, given the hit and the mode. */
function place(t: Target, p: Vec3, hit: Hit, mode: ShrinkwrapMode, offset: number): Vec3 {
  const h = hit.point;
  if (mode === "aboveSurface") {
    // Along the target's **smooth** normal at the hit, whatever side the
    // vertex was on (`MOD_SHRINKWRAP_ABOVE_SURFACE`). 0 lands on the surface.
    if (offset === 0) return [h[0], h[1], h[2]];
    const n = smoothNormalAt(t, hit);
    return [h[0] + n[0] * offset, h[1] + n[1] * offset, h[2] + n[2] * offset];
  }
  const away: Vec3 = [p[0] - h[0], p[1] - h[1], p[2] - h[2]];

  if (mode === "onSurface") {
    // Back the way the vertex came. Zero length means it was already there,
    // and then nothing happens — measured, rather than falling back to a
    // normal.
    const d = normalized(away);
    return [h[0] + d[0] * offset, h[1] + d[1] * offset, h[2] + d[2] * offset];
  }

  // The three clamping modes work on the **signed** distance along the
  // target's flat normal, which is what says which side the vertex is on.
  const n = hit.faceNormal;
  const signed = away[0] * n[0] + away[1] * n[1] + away[2] * n[2];
  const want =
    mode === "inside"
      ? Math.min(signed, -offset)
      : mode === "outside"
        ? Math.max(signed, offset)
        : offset; // outsideSurface always snaps
  if (mode !== "outsideSurface" && want === signed) return p; // already far enough
  return [h[0] + n[0] * want, h[1] + n[1] * want, h[2] + n[2] * want];
}

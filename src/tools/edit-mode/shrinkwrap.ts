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
 * | `project` | a ray along one axis, or along the vertex's own normal |
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
 * **Only one axis at a time.** Blender allows `use_project_x/y/z` together and
 * the result is not a composition of the single-axis answers — a vertex at
 * `(0.2, 0.1, 0.9)` outside a box came back at `(-0.2, 0.1, 0.5)`, which
 * neither axis produces alone and which no reading of "do one then the other"
 * gives. Rather than guess, this asks for one axis and says so.
 *
 * ## What is not offered
 *
 * * **`TARGET_PROJECT`** — a ray along the *target's* normals. It agrees with
 *   `nearestSurface` wherever the foot lands inside a face, and when it does
 *   not, its fallback is unreadable: a vertex past the rim of a tilted quad
 *   came back at the **opposite corner**, `(-0.6, -0.6, -0.18)`. A mode whose
 *   only distinctive behaviour is a fallback nobody can predict is not worth
 *   shipping.
 * * **`ABOVE_SURFACE`**, whose offset follows the target's normal
 *   *interpolated at the hit* rather than a face normal. Its rule is readable
 *   only on shapes where the interpolation is degenerate. On a cube and on a
 *   single quad it matches the bilinear blend of the face's corner normals
 *   exactly — `(0.3651, 0.1826, 0.9129)` for a hit at `(0.2, 0.1, 0.5)`,
 *   against `(0, 0, 1)` for the flat normal, which is how the mode was
 *   distinguished at all. But those are cases where the blend is **affine in
 *   the face's parameters**, so every reading of it agrees; on a
 *   non-cubic box, where the corner normals are no longer symmetric, the
 *   parity row disagreed on **all 36 vertices of `arm`** by up to 9.5 mm.
 *   Two unknowns remain and one measurement cannot separate them: how the
 *   target's vertex normals are weighted, and how they are interpolated
 *   across a quad (Blender's own triangulation picks a diagonal by shape).
 *   The numbers are in `probe-shrinkwrap2.py` and the row's note for whoever
 *   picks it up.
 * * **several projection axes at once** — see above.
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

export type ShrinkwrapMethod = "nearestSurface" | "nearestVertex" | "project";

export type ShrinkwrapMode = "onSurface" | "inside" | "outside" | "outsideSurface";

export interface ShrinkwrapProjectOptions {
  /**
   * Which way the ray goes. `"normal"` — Blender's "no axis selected" — uses
   * the vertex's own normal. Default `"normal"`.
   *
   * **One axis only.** Blender lets several be on at once and the answer is
   * not the composition of the single-axis ones; that branch is measured and
   * unread (see the note at the top of this file).
   */
  axis?: "x" | "y" | "z" | "normal";
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

/**
 * Vertex normals as Blender's `mesh.vertex_normals` gives them: each adjacent
 * **polygon's** normal, weighted by that polygon's area.
 *
 * **Computed from the polygons, not from a triangulation**, and that is not a
 * detail. Fan-triangulating a cube's quads gives some corners one triangle
 * from a face and others two, so a per-triangle average is not symmetric and a
 * cube's corner normal comes out slightly off `(±1, ±1, ±1)/√3`. The
 * `aboveSurface` test caught exactly that: 0.23453 where Blender says
 * 0.23651.
 *
 * A cube cannot say whether the weight is area or corner angle — three equal
 * quads meet at every corner either way — so this takes the area, which is
 * what Blender documents, and the parity rows on a real cage are what would
 * show otherwise.
 */
function polygonVertexNormals(
  positions: Float32Array,
  polys: readonly number[][],
  faceNormals: readonly Vec3[],
): Float32Array {
  const out = new Float32Array(positions.length);
  for (const [f, poly] of polys.entries()) {
    const n = faceNormals[f]!;
    const area = polygonArea(positions, poly);
    for (const v of poly) {
      out[v * 3] = out[v * 3]! + n[0] * area;
      out[v * 3 + 1] = out[v * 3 + 1]! + n[1] * area;
      out[v * 3 + 2] = out[v * 3 + 2]! + n[2] * area;
    }
  }
  for (let v = 0; v * 3 < out.length; v++) {
    const len = Math.hypot(out[v * 3]!, out[v * 3 + 1]!, out[v * 3 + 2]!);
    if (len > 1e-30) {
      out[v * 3] = out[v * 3]! / len;
      out[v * 3 + 1] = out[v * 3 + 1]! / len;
      out[v * 3 + 2] = out[v * 3 + 2]! / len;
    }
  }
  return out;
}

/** Area of a polygon, by fan triangulation — the sum is diagonal-independent. */
function polygonArea(P: Float32Array, poly: readonly number[]): number {
  let area = 0;
  const ax = P[poly[0]! * 3]!;
  const ay = P[poly[0]! * 3 + 1]!;
  const az = P[poly[0]! * 3 + 2]!;
  for (let i = 1; i + 1 < poly.length; i++) {
    const b = poly[i]! * 3;
    const c = poly[i + 1]! * 3;
    const ux = P[b]! - ax, uy = P[b + 1]! - ay, uz = P[b + 2]! - az;
    const vx = P[c]! - ax, vy = P[c + 1]! - ay, vz = P[c + 2]! - az;
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return area;
}

function prepare(target: MeshData): Target {
  const positions = Float32Array.from(target.positions);
  const tris: number[] = [];
  const triFace: number[] = [];
  const faceNormals: Vec3[] = [];
  for (const [f, poly] of target.polys.entries()) {
    faceNormals.push(faceNormal(positions, poly));
    // Fan triangulation, the same one every other operator here uses.
    for (let i = 1; i + 1 < poly.length; i++) {
      tris.push(poly[0]!, poly[i]!, poly[i + 1]!);
      triFace.push(f);
    }
  }
  const vertexNormals = polygonVertexNormals(positions, target.polys, faceNormals);
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
}

/** The closest point on the target's surface, and the face's normal there. */
function nearestSurface(t: Target, p: Vec3): Hit | null {
  let best = Infinity;
  let point: Vec3 = [0, 0, 0];
  let tri = -1;
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
      point = [
        t.positions[a]! * r.u + t.positions[b]! * r.v + t.positions[c]! * r.w,
        t.positions[a + 1]! * r.u + t.positions[b + 1]! * r.v + t.positions[c + 1]! * r.w,
        t.positions[a + 2]! * r.u + t.positions[b + 2]! * r.v + t.positions[c + 2]! * r.w,
      ];
    }
  }
  if (tri < 0) return null;
  return { point, faceNormal: t.faceNormals[t.triFace[tri]!]! };
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
  const axis = projectOpts.axis ?? "normal";
  const normals = method === "project" && axis === "normal" ? sourceNormals(data) : null;

  const positions = Float32Array.from(data.positions);
  const count = positions.length / 3;
  for (let v = 0; v < count; v++) {
    if (options.verts && !options.verts.has(v)) continue;
    const p: Vec3 = [positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!];

    let hit: Hit | null;
    if (method === "nearestVertex") hit = nearestVertex(t, p);
    else if (method === "project") {
      const dir: Vec3 = normals
        ? [normals[v * 3]!, normals[v * 3 + 1]!, normals[v * 3 + 2]!]
        : axis === "x"
          ? [1, 0, 0]
          : axis === "y"
            ? [0, 1, 0]
            : [0, 0, 1];
      hit = project(t, p, normalized(dir), projectOpts);
    } else hit = nearestSurface(t, p);

    // A ray that misses leaves its vertex exactly where it was — measured.
    if (!hit) continue;

    const out = place(p, hit, mode, offset);
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
  return result;
}

/** Where the vertex ends up, given the hit and the mode. */
function place(p: Vec3, hit: Hit, mode: ShrinkwrapMode, offset: number): Vec3 {
  const h = hit.point;
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

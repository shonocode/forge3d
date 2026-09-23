/**
 * Custom normals — the five Blender operators that write an explicit normal
 * per face corner.
 *
 * `bpy.ops.mesh.split_normals` / `merge_normals` / `average_normals` /
 * `smooth_normals` / `point_normals`, plus the layer they all write:
 * `MeshData.normals`, added with this file and shaped like
 * {@link MeshData.uvs} — **per face corner**, because that is where Blender
 * keeps them (a cube has 24, not 8).
 *
 * The API map recorded all five, and the `NORMAL_EDIT` and `WEIGHTED_NORMAL`
 * modifiers with them, as "forge3d splits by angle and cannot hold an explicit
 * normal" — seven items behind one missing field. Wire edges (four operators)
 * and per-corner UV and colour (six) were the same sentence, and each turned
 * out to be one field.
 *
 * ## The rules, measured
 *
 * Blender 5.1.1, `probe-custom-normals.py` and `probe-custom-normals2.py`.
 * **A cube cannot tell the three weightings apart** — every face at its corner
 * has the same area and the same corner angle — so the second probe uses a fan
 * whose faces differ tenfold in area and threefold in corner angle, and every
 * candidate separates there:
 *
 * | operator | what it does |
 * |---|---|
 * | `splitNormals` | writes each corner's **face normal**, and marks **every edge sharp** (10 of 10 on the fan) |
 * | `mergeNormals` | the **plain average** of the face normals at the vertex, on every corner there — and **clears sharp** (0 of 10) |
 * | `averageNormals` | the same average, weighted: `plain`, `area`, or `angle`. Measured against all three predictions on the fan and matching one each |
 * | `smoothNormals` | `lerp(corner normal, plain average, factor)`, normalized. A cube's corner at 0.5 gives (-0.325, -0.325, -0.888), which is exactly that |
 * | `pointNormals` | every corner points from its vertex at the target |
 *
 * ## Sharp edges are part of the rule
 *
 * Averaging happens **within a smooth group**: corners at a vertex are
 * gathered through edges that are *not* sharp. That is why
 * `average_normals` does nothing after `split_normals` — the split marked
 * every edge, so each corner is alone in its group. Measured both ways, and
 * expressible here because `MeshData.sharp` arrived on 2026-09-23.
 */
import type { MeshData } from "../../lib/mesh";

export type NormalWeight = "plain" | "area" | "angle";

export interface AverageNormalsOptions {
  /**
   * How to weight the face normals. Blender's `average_type`:
   * `CUSTOM_NORMAL` is `plain`, `FACE_AREA` is `area`, `CORNER_ANGLE` is
   * `angle`. Default `plain`, which is Blender's default.
   */
  weight?: NormalWeight;
}

export interface SmoothNormalsOptions {
  /** Blender's `factor`, 0 keeps the corner normal and 1 is the average. */
  factor?: number;
}

export interface PointNormalsOptions {
  /** Blender's `target_location`. Default the origin. */
  target?: readonly [number, number, number];
  /** Blender's `invert`: point away from the target instead of at it. */
  invert?: boolean;
}

/**
 * The corner-normal type these operators pass around.
 *
 * The helpers below it — `faceNormal`, `faceArea`, `cornerAngle`,
 * `currentNormals`, `withNormals`, `smoothGroups` — are exported for
 * `normal-modifiers.ts`, which writes the same layer from Blender's two normal
 * modifiers and needs the same reading of "one smooth group". They are not in
 * the public barrel; the operators are.
 */
export type Vec3 = [number, number, number];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

function normalized(a: Vec3): Vec3 {
  const len = Math.hypot(a[0], a[1], a[2]);
  return len > 1e-30 ? [a[0] / len, a[1] / len, a[2] / len] : [0, 0, 0];
}

const key = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);

const at = (P: Float32Array, v: number): Vec3 => [P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!];

/** Newell's normal of a polygon, unit length — Blender's `polygon.normal`. */
export function faceNormal(P: Float32Array, poly: readonly number[]): Vec3 {
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

/** Area of a polygon, by fan triangulation. */
export function faceArea(P: Float32Array, poly: readonly number[]): number {
  let area = 0;
  const a = at(P, poly[0]!);
  for (let i = 1; i + 1 < poly.length; i++) {
    const b = at(P, poly[i]!);
    const c = at(P, poly[i + 1]!);
    const n = cross(sub(b, a), sub(c, a));
    area += Math.hypot(n[0], n[1], n[2]) / 2;
  }
  return area;
}

/** The interior angle of `poly` at its corner `i`. */
export function cornerAngle(P: Float32Array, poly: readonly number[], i: number): number {
  const v = at(P, poly[i]!);
  const a = normalized(sub(at(P, poly[(i + 1) % poly.length]!), v));
  const b = normalized(sub(at(P, poly[(i - 1 + poly.length) % poly.length]!), v));
  return Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
}

/** Per-corner face normals — the layer `splitNormals` writes. */
function faceNormalsPerCorner(data: MeshData): Vec3[][] {
  return data.polys.map((poly) => {
    const n = faceNormal(data.positions, poly);
    return poly.map(() => [...n] as Vec3);
  });
}

/** The layer as it stands: the stored one if there is one, else face normals. */
export function currentNormals(data: MeshData): Vec3[][] {
  if (!data.normals) return faceNormalsPerCorner(data);
  return data.normals.map((face) => face.map((n) => [n[0]!, n[1]!, n[2]!] as Vec3));
}

export function withNormals(data: MeshData, normals: Vec3[][], sharp?: Set<string> | null): MeshData {
  const out: MeshData = {
    positions: Float32Array.from(data.positions),
    polys: data.polys.map((p) => [...p]),
    normals: normals.map((f) => f.map((n) => [n[0], n[1], n[2]])),
  };
  if (data.creases) out.creases = new Map(data.creases);
  if (data.seams) out.seams = new Set(data.seams);
  if (data.edges) out.edges = data.edges.map((e) => [...e]);
  if (data.uvs) out.uvs = data.uvs.map((f) => f.map((c) => [...c]));
  if (data.colors) out.colors = data.colors.map((f) => f.map((c) => [...c]));
  const keep = sharp === undefined ? data.sharp : sharp;
  if (keep && keep.size > 0) out.sharp = new Set(keep);
  return out;
}

/**
 * Corners grouped by vertex **and smooth group**: two corners at the same
 * vertex belong together when a path of non-sharp edges joins their faces
 * around that vertex.
 *
 * This is the part of the rule that is easy to miss, and the reason
 * `averageNormals` does nothing after `splitNormals`.
 */
export function smoothGroups(data: MeshData): [number, number][][] {
  const sharp = data.sharp ?? new Set<string>();
  // corner id -> [face, index]; and the faces at each vertex
  const cornersAt = new Map<number, [number, number][]>();
  for (const [f, poly] of data.polys.entries())
    for (const [i, v] of poly.entries()) {
      const list = cornersAt.get(v);
      if (list) list.push([f, i]);
      else cornersAt.set(v, [[f, i]]);
    }
  // faces on each edge, to walk between them
  const facesOnEdge = new Map<string, number[]>();
  for (const [f, poly] of data.polys.entries())
    for (let i = 0; i < poly.length; i++) {
      const k = key(poly[i]!, poly[(i + 1) % poly.length]!);
      const list = facesOnEdge.get(k);
      if (list) list.push(f);
      else facesOnEdge.set(k, [f]);
    }

  const groups: [number, number][][] = [];
  for (const [v, corners] of cornersAt) {
    const byFace = new Map<number, number>();
    for (const [f, i] of corners) byFace.set(f, i);
    const seen = new Set<number>();
    for (const [f0] of corners) {
      if (seen.has(f0)) continue;
      const group: [number, number][] = [];
      const queue = [f0];
      seen.add(f0);
      while (queue.length > 0) {
        const f = queue.pop()!;
        group.push([f, byFace.get(f)!]);
        // step to the faces sharing a non-sharp edge that touches `v`
        const poly = data.polys[f]!;
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i]!;
          const b = poly[(i + 1) % poly.length]!;
          if (a !== v && b !== v) continue;
          const k = key(a, b);
          if (sharp.has(k)) continue;
          for (const other of facesOnEdge.get(k) ?? [])
            if (other !== f && byFace.has(other) && !seen.has(other)) {
              seen.add(other);
              queue.push(other);
            }
        }
      }
      groups.push(group);
    }
  }
  return groups;
}

/**
 * Write each corner's face normal and mark every edge sharp — Blender's
 * `bpy.ops.mesh.split_normals`.
 *
 * The sharp marking is not incidental: it is what makes the split stick, and
 * why `averageNormals` afterwards changes nothing (measured both ways).
 */
export function splitNormals(data: MeshData): MeshData {
  const sharp = new Set(data.sharp ?? []);
  for (const poly of data.polys)
    for (let i = 0; i < poly.length; i++) sharp.add(key(poly[i]!, poly[(i + 1) % poly.length]!));
  return withNormals(data, faceNormalsPerCorner(data), sharp);
}

/**
 * Average the face normals at each vertex onto all of its corners, and clear
 * every sharp edge — Blender's `bpy.ops.mesh.merge_normals`.
 *
 * The average is **plain** — not area- or angle-weighted. Measured on a fan
 * whose faces differ tenfold in area: the answer is the unweighted one to
 * 4e-5, which is float32.
 */
export function mergeNormals(data: MeshData): MeshData {
  const faceNs = data.polys.map((poly) => faceNormal(data.positions, poly));
  const acc = new Map<number, Vec3>();
  for (const [f, poly] of data.polys.entries())
    for (const v of poly) acc.set(v, add(acc.get(v) ?? [0, 0, 0], faceNs[f]!));
  const out = data.polys.map((poly) => poly.map((v) => normalized(acc.get(v)!)));
  return withNormals(data, out, null);
}

/**
 * Average the corner normals within each smooth group — Blender's
 * `bpy.ops.mesh.average_normals`.
 *
 * ```ts
 * averageNormals(mesh);                      // Blender's CUSTOM_NORMAL
 * averageNormals(mesh, { weight: "area" });  // FACE_AREA
 * averageNormals(mesh, { weight: "angle" }); // CORNER_ANGLE
 * ```
 *
 * Unlike {@link mergeNormals} this respects sharp edges and leaves them alone,
 * so on a mesh `splitNormals` has been over it changes nothing.
 */
export function averageNormals(data: MeshData, options: AverageNormalsOptions = {}): MeshData {
  const weight = options.weight ?? "plain";
  const current = currentNormals(data);
  const out = current.map((f) => f.map((n) => [...n] as Vec3));
  for (const group of smoothGroups(data)) {
    let acc: Vec3 = [0, 0, 0];
    for (const [f, i] of group) {
      const poly = data.polys[f]!;
      const w =
        weight === "plain"
          ? 1
          : weight === "area"
            ? faceArea(data.positions, poly)
            : cornerAngle(data.positions, poly, i);
      acc = add(acc, scale(current[f]![i]!, w));
    }
    const n = normalized(acc);
    for (const [f, i] of group) out[f]![i] = [...n] as Vec3;
  }
  return withNormals(data, out);
}

/**
 * Blend each corner normal toward the plain average at its vertex — Blender's
 * `bpy.ops.mesh.smooth_normals`.
 *
 * `factor` 0 leaves it, 1 is the average. Measured on a cube at 0.5: the
 * corner comes back at (-0.325, -0.325, -0.888), which is the normalized
 * midpoint between the face normal and the diagonal.
 */
export function smoothNormals(data: MeshData, options: SmoothNormalsOptions = {}): MeshData {
  const factor = options.factor ?? 0.5;
  const current = currentNormals(data);
  const out = current.map((f) => f.map((n) => [...n] as Vec3));
  for (const group of smoothGroups(data)) {
    let acc: Vec3 = [0, 0, 0];
    for (const [f, i] of group) acc = add(acc, current[f]![i]!);
    const target = normalized(acc);
    for (const [f, i] of group) {
      const n = current[f]![i]!;
      out[f]![i] = normalized([
        n[0] + (target[0] - n[0]) * factor,
        n[1] + (target[1] - n[1]) * factor,
        n[2] + (target[2] - n[2]) * factor,
      ]);
    }
  }
  return withNormals(data, out);
}

/**
 * Point every corner normal from its vertex at a target — Blender's
 * `bpy.ops.mesh.point_normals` in its `COORDINATES` mode.
 *
 * Default target is the origin, which is what the operator does with no
 * arguments (measured: a cube's corner at (-0.1, -0.1, -0.1) comes back
 * pointing at (+0.577, +0.577, +0.577)).
 *
 * The `MOUSE` mode and `spherize` are not offered: the first is an editor
 * interaction and the second has not been measured.
 */
export function pointNormals(data: MeshData, options: PointNormalsOptions = {}): MeshData {
  const target: Vec3 = [...(options.target ?? [0, 0, 0])] as Vec3;
  const sign = options.invert ? -1 : 1;
  const out = data.polys.map((poly) =>
    poly.map((v) => scale(normalized(sub(target, at(data.positions, v))), sign)),
  );
  return withNormals(data, out);
}

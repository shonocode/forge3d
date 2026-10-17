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
import { mathNormalize, meshFaceNormal, safeAcosApprox, sub as subF, dot as dotF, type V3 } from "../blender-math";

export type NormalWeight = "plain" | "area" | "angle";

export interface AverageNormalsOptions {
  /**
   * How to weight the face normals. Blender's `average_type`:
   * `CUSTOM_NORMAL` is `plain`, `FACE_AREA` is `area`, `CORNER_ANGLE` is
   * `angle`. Default `plain`, which is Blender's default.
   */
  weight?: NormalWeight;
  /**
   * Blender's `weight` (an integer, 1–100, default 50): how much the strongest faces dominate. At 50 every face counts by
   * its area / angle alone; above, each tier of weaker faces is divided by a further factor (100: only the strongest
   * tier); below, the weaker ones gain. Read from `edbm_average_normals_exec` (compat-backlog C101).
   */
  influence?: number;
  /** Blender's `threshold` (default 0.01): values closer than this are one tier. */
  threshold?: number;
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
  /** Blender's `align`: every corner along target − (the mean of the vertices), all parallel. */
  align?: boolean;
  /**
   * Blender's `spherize`: each corner's current normal mixed with the direction from its vertex to the target,
   * `normal·(1 − strength) + strength·unit(target − vertex)`. Takes precedence over `align`, as Blender's.
   */
  spherize?: boolean;
  /** Blender's `spherize_strength`. Default 0.1. */
  spherizeStrength?: number;
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

/** `BM_face_calc_area`: half the length of the Newell vector, in float (`area_poly_v3`). */
function newellArea(P: Float32Array, poly: readonly number[]): number {
  const f = Math.fround;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  let prev = poly[poly.length - 1]! * 3;
  for (const v of poly) {
    const c = v * 3;
    nx = f(nx + f(f(P[prev + 1]! - P[c + 1]!) * f(P[prev + 2]! + P[c + 2]!)));
    ny = f(ny + f(f(P[prev + 2]! - P[c + 2]!) * f(P[prev]! + P[c]!)));
    nz = f(nz + f(f(P[prev]! - P[c]!) * f(P[prev + 1]! + P[c + 1]!)));
    prev = c;
  }
  return f(f(Math.sqrt(f(f(f(nx * nx) + f(ny * ny)) + f(nz * nz)))) * 0.5);
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

/**
 * The normal each corner shows with no custom normal — `normals_calc_corners` without one, **to within a few float32
 * steps**: it sums in doubles and in {@link smoothGroups}' order. `cornerFans` (`normal-space.ts`) is the exact port,
 * fan order and float32 included; this one is what the normal operators were measured with. Per smooth fan
 * ({@link smoothGroups}), `accumulate_fan_normal`, the face normals (`face_normals_true`, Newell in float) weighted by
 * `safe_acos_approx` of the corner's two edges and normalised; a fan of one corner keeps its face's normal. A flat face's
 * corners are fans of one (`MeshData.sharpFaces`, compat-backlog C29a).
 */
export function fanNormals(data: MeshData): Vec3[][] {
  const P = data.positions;
  const PV: V3[] = Array.from({ length: P.length / 3 }, (_, v) => [P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!]);
  const faceN = data.polys.map((poly) => meshFaceNormal(PV, poly) as Vec3);
  const out: Vec3[][] = data.polys.map((poly, f) => poly.map(() => [...faceN[f]!] as Vec3));
  const weight = (f: number, i: number): number => {
    const poly = data.polys[f]!;
    const v = PV[poly[i]!]!;
    const dp = mathNormalize(subF(PV[poly[(i - 1 + poly.length) % poly.length]!]!, v));
    const dn = mathNormalize(subF(PV[poly[(i + 1) % poly.length]!]!, v));
    return safeAcosApprox(dotF(dp, dn));
  };
  for (const group of smoothGroups(data, { flatFaces: true })) {
    if (group.length === 1) continue;
    let sum: Vec3 = [0, 0, 0];
    for (const [f, i] of group) sum = add(sum, scale(faceN[f]!, weight(f, i)));
    const n = normalized(sum);
    for (const [f, i] of group) out[f]![i] = [...n] as Vec3;
  }
  return out;
}

/**
 * One normal per vertex from the corners' — Blender's `mix_normals_corner_to_vert`: each corner's normal weighted by
 * `safe_acos_approx` of its two edges, summed, normalised. What `Mesh::vert_normals()` gives once the mesh has corner
 * normals (a `custom_normal` layer), which Weighted Normal fills its untouched vertices with (compat-backlog C29a).
 */
export function mixCornerNormals(data: MeshData, corner: readonly (readonly Vec3[])[]): Vec3[] {
  const P = data.positions;
  const PV: V3[] = Array.from({ length: P.length / 3 }, (_, v) => [P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!]);
  const sum: Vec3[] = PV.map(() => [0, 0, 0]);
  data.polys.forEach((poly, f) =>
    poly.forEach((v, i) => {
      const dp = mathNormalize(subF(PV[poly[(i - 1 + poly.length) % poly.length]!]!, PV[v]!));
      const dn = mathNormalize(subF(PV[poly[(i + 1) % poly.length]!]!, PV[v]!));
      sum[v] = add(sum[v]!, scale(corner[f]![i]!, safeAcosApprox(dotF(dp, dn))));
    }),
  );
  return sum.map((s) => normalized(s));
}

/**
 * The layer as it stands: the stored one if there is one, else what each corner shows without one. With
 * `MeshData.sharpFaces` that is {@link fanNormals} (compat-backlog C29a). **Without it, the face normals** — every face
 * flat, which is not what `sharpFaces`' absence means elsewhere (every face smooth): it is what the operators here were
 * measured against, a mesh read from an OBJ without `s` lines (Blender makes every face flat), and kept so.
 */
export function currentNormals(data: MeshData): Vec3[][] {
  if (!data.normals) return data.sharpFaces && data.sharpFaces.length === data.polys.length ? fanNormals(data) : faceNormalsPerCorner(data);
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
  if (data.groups) out.groups = new Map([...data.groups].map(([k, g]) => [k, new Map(g)]));
  if (data.materials) out.materials = [...data.materials];
  if (data.faceStrength) out.faceStrength = [...data.faceStrength];
  if (data.sharpFaces) out.sharpFaces = [...data.sharpFaces];
  if (data.vertexCreases) out.vertexCreases = new Map(data.vertexCreases);
  return out;
}

/**
 * Corners grouped by vertex **and smooth group**: two corners at the same
 * vertex belong together when a path of non-sharp edges joins their faces
 * around that vertex.
 *
 * An edge joins two faces only as Blender's `BM_normals_loops_edges_tag` lets
 * it (compat-backlog C106): exactly two faces use it, and they run it in
 * opposite directions (`l_a->v != l_b->v`; `mesh_normals.cc` marks the same
 * edges sharp). An edge of three faces (a fin), or between a face and one wound
 * the other way, joins nothing. (A vertex where two fans meet only at the point —
 * a bowtie — was two groups already: no edge joins them.)
 *
 * This is the part of the rule that is easy to miss, and the reason
 * `averageNormals` does nothing after `splitNormals`.
 *
 * **Flat faces, two rules** (`MeshData.sharpFaces`, compat-backlog C29a). The corner-normal fans — what a corner shows,
 * and the spaces custom normals live in — stop at one: Blender makes both edges of each of its corners sharp
 * (`calc_connecting_edge_info`, `mesh_normals.cc` 1062), so every corner of it is a group of one. Pass `flatFaces`
 * for those. The edit-mode normal tools (Average, Smooth, Point) walk `BM_normals_loops_edges_tag`, which reads the
 * edge's flag and the winding and **not the faces** (`bmesh_mesh_normals.cc` 325): their groups cross flat faces —
 * measured, Average on a cube with two flat faces gives each vertex one normal on all three of its faces.
 */
export function smoothGroups(data: MeshData, opts: { flatFaces?: boolean } = {}): [number, number][][] {
  const sharp = data.sharp ?? new Set<string>();
  const flat = opts.flatFaces && data.sharpFaces && data.sharpFaces.length === data.polys.length ? data.sharpFaces : null;
  // corner id -> [face, index]; and the faces at each vertex
  const cornersAt = new Map<number, [number, number][]>();
  for (const [f, poly] of data.polys.entries())
    for (const [i, v] of poly.entries()) {
      const list = cornersAt.get(v);
      if (list) list.push([f, i]);
      else cornersAt.set(v, [[f, i]]);
    }
  // faces on each edge, with the vertex each runs it from, to walk between them
  const facesOnEdge = new Map<string, [number, number][]>();
  for (const [f, poly] of data.polys.entries())
    for (let i = 0; i < poly.length; i++) {
      const k = key(poly[i]!, poly[(i + 1) % poly.length]!);
      const list = facesOnEdge.get(k);
      if (list) list.push([f, poly[i]!]);
      else facesOnEdge.set(k, [[f, poly[i]!]]);
    }
  // The edges that join: two faces, opposite directions.
  const joins = (k: string): number[] | null => {
    const list = facesOnEdge.get(k);
    if (!list || list.length !== 2 || list[0]![1] === list[1]![1]) return null;
    if (flat && (flat[list[0]![0]] || flat[list[1]![0]])) return null;
    return [list[0]![0], list[1]![0]];
  };

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
          for (const other of joins(k) ?? [])
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
  // `normals_split_merge(do_merge = false)` shades every selected face flat too (`mesh_set_smooth_faces`, C29a).
  return { ...withNormals(data, faceNormalsPerCorner(data), sharp), sharpFaces: data.polys.map(() => true) };
}

/**
 * Average the corner normals at each vertex onto all of its corners, and clear
 * every sharp edge — Blender's `bpy.ops.mesh.merge_normals` (`normals_merge`).
 *
 * The average is **plain**, of each corner's **current** normal (`nloc`, read
 * before the sharp edges go — the custom normal where there is one), over the
 * fan the corner is in once they are gone (every corner at the vertex, but for
 * bowtie vertices, and fins and flipped faces — compat-backlog C106).
 * forge3d averaged the face normals until compat-backlog C101, which is the same
 * answer where every corner shows its face normal (a flat-shaded mesh with no
 * custom normals — what the first rows measured). A fan of one corner is left
 * as it is (`MLNOR_SPACE_IS_SINGLE`); an average below `CLNORS_VALID_VEC_LEN`
 * falls back to the fan's default normal (angle-weighted face normals).
 */
export function mergeNormals(data: MeshData): MeshData {
  const CLNORS_VALID_VEC_LEN = 1e-4;
  const current = currentNormals(data);
  const out = current.map((f) => f.map((n) => [...n] as Vec3));
  // The fans once the sharp edges are cleared and the faces made smooth — `normals_split_merge(do_merge = true)` does
  // both before merging, after reading the current normals (C106: the fans still stop at fins, flipped faces and bowtie
  // vertices; C29a: the faces).
  for (const group of smoothGroups({ ...data, sharp: undefined, sharpFaces: undefined })) {
    if (group.length === 1) continue; // `MLNOR_SPACE_IS_SINGLE`
    let sum: Vec3 = [0, 0, 0];
    for (const [f, i] of group) sum = add(sum, current[f]![i]!);
    if (Math.hypot(sum[0], sum[1], sum[2]) < CLNORS_VALID_VEC_LEN) {
      sum = [0, 0, 0];
      for (const [f, i] of group) {
        const poly = data.polys[f]!;
        sum = add(sum, scale(faceNormal(data.positions, poly), cornerAngle(data.positions, poly, i)));
      }
    }
    const n = normalized(sum);
    for (const [f, i] of group) out[f]![i] = [...n] as Vec3;
  }
  const merged = withNormals(data, out, null);
  if (merged.sharpFaces) merged.sharpFaces = data.polys.map(() => false);
  return merged;
}

/**
 * Average the corner normals within each smooth group — Blender's
 * `bpy.ops.mesh.average_normals` (`edbm_average_normals_exec`).
 *
 * ```ts
 * averageNormals(mesh);                      // Blender's CUSTOM_NORMAL
 * averageNormals(mesh, { weight: "area" });  // FACE_AREA
 * averageNormals(mesh, { weight: "angle" }); // CORNER_ANGLE
 * ```
 *
 * What gets weighted (compat-backlog C101): `plain` sums the corners' current
 * (custom) normals; `area` and `angle` weight the **face** normal
 * (`l->f->no`) by the face's area / the corner's angle — not the corner's
 * current normal, which is the same only where every corner shows its face
 * normal. The values go largest first; each time one is more than `threshold`
 * from the value that opened the current tier, the tier rank goes up and its
 * terms are divided by `weight^rank` (`influence`, mapped as Blender maps it).
 * A corner alone in its fan (both its edges sharp) takes its face normal.
 * The area is `BM_face_calc_area` — half the Newell vector — which a
 * non-planar quad has less of than its two triangles summed.
 *
 * Unlike {@link mergeNormals} this respects sharp edges and leaves them alone,
 * so on a mesh `splitNormals` has been over it changes nothing.
 */
export function averageNormals(data: MeshData, options: AverageNormalsOptions = {}): MeshData {
  const weight = options.weight ?? "plain";
  const absweight = options.influence ?? 50;
  const threshold = options.threshold ?? 0.01;
  const SHRT_MAX = 32767;
  let tierWeight = absweight / 50;
  if (absweight === 100) tierWeight = SHRT_MAX;
  else if (absweight === 1) tierWeight = 1 / SHRT_MAX;
  else if ((tierWeight - 1) * 25 > 1) tierWeight = (tierWeight - 1) * 25;
  const fr = Math.fround;
  const current = currentNormals(data);
  const faceNs = data.polys.map((poly) => faceNormal(data.positions, poly));
  const out = current.map((f) => f.map((n) => [...n] as Vec3));
  for (const group of smoothGroups(data)) {
    if (group.length === 1) {
      const [f, i] = group[0]!;
      out[f]![i] = [...faceNs[f]!] as Vec3;
      continue;
    }
    // `1 / area`, `1 / angle` or 1, in float; the heap gives the smallest first — the largest area / angle.
    const items = group
      .map(([f, i]) => {
        const poly = data.polys[f]!;
        const val =
          weight === "plain" ? 1 : weight === "area" ? fr(1 / newellArea(data.positions, poly)) : fr(1 / fr(cornerAngle(data.positions, poly, i)));
        return { f, i, val };
      })
      .sort((a, b) => a.val - b.val);
    let acc: Vec3 = [0, 0, 0];
    let tier = 0;
    let opened = items[0]!.val;
    for (const { f, i, val } of items) {
      // `compare_ff` in float, against the float threshold.
      if (!(Math.abs(fr(opened - val)) <= fr(threshold))) {
        tier++;
        opened = val;
      }
      const term = weight === "plain" ? current[f]![i]! : faceNs[f]!;
      acc = add(acc, scale(term, (1 / val) * (1 / Math.pow(tierWeight, tier))));
    }
    if (Math.hypot(acc[0], acc[1], acc[2]) < 1e-4) {
      // `CLNORS_VALID_VEC_LEN`: the default normal of the fan.
      acc = [0, 0, 0];
      for (const [f, i] of group) acc = add(acc, scale(faceNs[f]!, cornerAngle(data.positions, data.polys[f]!, i)));
    }
    const n = normalized(acc);
    for (const [f, i] of group) out[f]![i] = [...n] as Vec3;
  }
  return withNormals(data, out);
}

/**
 * Blend each corner normal toward the sum at its vertex — Blender's
 * `bpy.ops.mesh.smooth_normals` (`edbm_smooth_normals_exec`).
 *
 * The sum is not the vertex's own corners: for each corner Blender adds the
 * current normal of **every corner of every face round its vertex**
 * (`BM_FACES_OF_VERT` × `BM_LOOPS_OF_FACE`) — a face counts once per corner,
 * its corners at other vertices included, and sharp edges cut nothing
 * (compat-backlog C101; forge3d summed the vertex's corners within each smooth
 * group, the same answer on the flat fan and the cube the rows used). Then
 * `normalize(current·(1 − factor) + sum·factor)`, a corner left alone when
 * either vector is below `CLNORS_VALID_VEC_LEN`.
 *
 * `factor` 0 leaves it, 1 is the sum. Measured on a cube at 0.5: the
 * corner comes back at (-0.325, -0.325, -0.888).
 */
export function smoothNormals(data: MeshData, options: SmoothNormalsOptions = {}): MeshData {
  const factor = options.factor ?? 0.5;
  const CLNORS_VALID_VEC_LEN = 1e-4;
  const current = currentNormals(data);
  const out = current.map((f) => f.map((n) => [...n] as Vec3));
  // Per vertex: the sum over the faces using it (each once) of all their corners' normals.
  const sumAt = new Map<number, Vec3>();
  data.polys.forEach((poly, f) => {
    let faceSum: Vec3 = [0, 0, 0];
    for (const n of current[f]!) faceSum = add(faceSum, n);
    for (const v of new Set(poly)) sumAt.set(v, add(sumAt.get(v) ?? [0, 0, 0], faceSum));
  });
  data.polys.forEach((poly, f) => {
    poly.forEach((v, i) => {
      const sum = sumAt.get(v)!;
      if (Math.hypot(sum[0], sum[1], sum[2]) < CLNORS_VALID_VEC_LEN) return;
      const target = normalized(sum);
      const n = current[f]![i]!;
      const mixed: Vec3 = [
        n[0] * (1 - factor) + target[0] * factor,
        n[1] * (1 - factor) + target[1] * factor,
        n[2] * (1 - factor) + target[2] * factor,
      ];
      if (Math.hypot(mixed[0], mixed[1], mixed[2]) < CLNORS_VALID_VEC_LEN) return;
      out[f]![i] = normalized(mixed);
    });
  });
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
 * `target` is in the mesh's own coordinates (Blender subtracts the object's
 * location; the two agree for an object at the origin).
 *
 * `align` and `spherize` as `point_normals_apply` has them (compat-backlog C101):
 * `spherize` first, then `align`, else the direction from the vertex; `invert`
 * negates; a result shorter than `CLNORS_VALID_VEC_LEN` leaves the corner as it
 * was. The `MOUSE` mode is not offered: it is an editor interaction.
 */
export function pointNormals(data: MeshData, options: PointNormalsOptions = {}): MeshData {
  const target: Vec3 = [...(options.target ?? [0, 0, 0])] as Vec3;
  const sign = options.invert ? -1 : 1;
  const strength = options.spherizeStrength ?? 0.1;
  const current = currentNormals(data);
  // `bmesh_selected_verts_center_calc`: the mean of the (all, here) vertices.
  const count = data.positions.length / 3;
  let center: Vec3 = [0, 0, 0];
  for (let v = 0; v < count; v++) center = add(center, at(data.positions, v));
  center = scale(center, 1 / Math.max(1, count));
  const out = data.polys.map((poly, f) =>
    poly.map((v, i): Vec3 => {
      let n: Vec3;
      if (options.spherize) {
        const toward = scale(normalized(sub(target, at(data.positions, v))), strength);
        n = add(scale(current[f]![i]!, 1 - strength), toward);
      } else if (options.align) n = sub(target, center);
      else n = sub(target, at(data.positions, v));
      n = scale(n, sign);
      return Math.hypot(n[0], n[1], n[2]) >= 1e-4 ? normalized(n) : ([...current[f]![i]!] as Vec3);
    }),
  );
  return withNormals(data, out);
}

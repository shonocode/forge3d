/**
 * Combining and transforming {@link MeshData} — the assembly half of the
 * headless pipeline.
 *
 * `tools/modifiers.ts` already has mirror and array, but they work on the
 * editor's `OriginalGeometry` (triangles, typed in `state.ts`) and are wired
 * to the modifier stack. Exporting those would drag an editor type into the
 * public API and hand callers triangles, which `catmullClark` cannot refine.
 * These are the polygon equivalents, with no editor in sight.
 *
 * Everything here preserves creases and UV seams by remapping their vertex
 * keys, so a box you creased stays crisp after being mirrored, arrayed and
 * merged into a scene.
 *
 * Pure and headless — Vitest-pinned.
 */
import { withPositions, type MeshData } from "../lib/mesh";
import { seamKey } from "./edit-mode/half-edge";
import { carryFaceLayers, carryVertexLayers, defined, onlyEdgesOf, type FaceSource } from "./mesh-layers";
import { compactMesh } from "./mesh-repair";
import { weldByMap } from "./remove-doubles";
import { crtQsort } from "./edit-mode/triangle-fill";
import type { Vec3 } from "./generate";
import { bulletConvexHull } from "./hull/bullet-hull";

/** Shift every crease / seam key by `base`, appending into `out`. */
function remapKeys<T>(
  src: ReadonlyMap<string, T> | ReadonlySet<string> | undefined,
  base: number,
  add: (key: string, value: T) => void,
): void {
  if (!src) return;
  const entries =
    src instanceof Map
      ? src.entries()
      : (function* () {
          for (const k of src as ReadonlySet<string>) yield [k, undefined as T] as [string, T];
        })();
  for (const [key, value] of entries) {
    const [a, b] = key.split("_");
    add(seamKey(Number(a) + base, Number(b) + base), value);
  }
}

/**
 * Concatenate meshes into one, offsetting indices and carrying edge
 * attributes across.
 *
 * Nothing is welded: parts that touch stay separate surfaces, which is what
 * you want for a scene assembled from distinct objects. Run {@link weldMesh}
 * afterwards if you meant them to fuse.
 *
 * UVs are carried when any part has them; a part without UVs gets (0, 0) at
 * every corner so the layer stays shaped like `polys`. Custom normals are
 * carried only when every part has them.
 */
export function mergeMeshes(parts: readonly MeshData[]): MeshData {
  let total = 0;
  for (const p of parts) total += p.positions.length;
  const positions = new Float32Array(total);

  const polys: number[][] = [];
  const creases = new Map<string, number>();
  const seams = new Set<string>();
  // A layer is there when it is shaped for the part — `meshToData` hands
  // back `[]` for "none", which is not a layer with no faces.
  const shaped = (p: MeshData, k: "uvs" | "colors" | "normals" | "materials"): boolean =>
    (p[k]?.length ?? 0) > 0 && p[k]!.length === p.polys.length;
  const has = (k: "uvs" | "colors" | "normals" | "sharp" | "edges" | "groups" | "materials") =>
    parts.some((p) =>
      k === "uvs" || k === "colors" || k === "normals" || k === "materials"
        ? shaped(p, k)
        : k === "sharp" || k === "groups"
          ? (p[k]?.size ?? 0) > 0
          : (p[k]?.length ?? 0) > 0,
    );
  const uvs: number[][][] | undefined = has("uvs") ? [] : undefined;
  const colors: number[][][] | undefined = has("colors") ? [] : undefined;
  // Blender's join fills a part without custom normals with "automatic"
  // (`short2(0)` in `join_normals`): the corner's own normal, which Blender
  // reads off the face's smooth / flat flag and the sharp edges. A mesh here
  // without normals means "work them out from the geometry" and carries no
  // smooth / flat flag, so there is no value to write that would not bake a
  // shading in — the layer goes unless every part has one. Measured on flat
  // inputs, where "automatic" is the face normal (`join-custom-normals`,
  // `kind: "different"`, compat-backlog A9); found by review.
  const normals: number[][][] | undefined =
    parts.length > 0 && parts.every((p) => shaped(p, "normals")) ? [] : undefined;
  const sharp: Set<string> | undefined = has("sharp") ? new Set() : undefined;
  const edges: number[][] | undefined = has("edges") ? [] : undefined;
  const groups: Map<string, Map<number, number>> | undefined = has("groups") ? new Map() : undefined;
  const materials: number[] | undefined = has("materials") ? [] : undefined;
  let cursor = 0;

  for (const part of parts) {
    const base = cursor / 3;
    positions.set(part.positions, cursor);
    cursor += part.positions.length;
    for (const poly of part.polys) polys.push(poly.map((v) => v + base));
    // A part without a layer gets Blender's default for it: UV (0, 0), a
    // colour of 0, material slot 0, no group membership.
    part.polys.forEach((poly, f) => {
      uvs?.push(shaped(part, "uvs") ? part.uvs![f]!.map((c) => [...c]) : poly.map(() => [0, 0]));
      colors?.push(shaped(part, "colors") ? part.colors![f]!.map((c) => [...c]) : poly.map(() => [0, 0, 0, 0]));
      normals?.push(part.normals![f]!.map((c) => [...c]));
      // Slots are concatenated as numbers. Blender's join renumbers them by
      // the material in each slot, which `MeshData` does not carry.
      materials?.push(shaped(part, "materials") ? part.materials![f]! : 0);
    });
    remapKeys(part.creases, base, (k, v) => creases.set(k, v));
    remapKeys(part.seams, base, (k) => seams.add(k));
    if (sharp) remapKeys(part.sharp, base, (k) => sharp.add(k));
    for (const e of part.edges ?? []) edges?.push(e.map((v) => v + base));
    if (groups)
      for (const [name, g] of part.groups ?? []) {
        const ng = groups.get(name) ?? new Map<number, number>();
        for (const [v, w] of g) ng.set(v + base, w);
        groups.set(name, ng);
      }
  }

  const out: MeshData = { positions, polys, creases, seams };
  if (uvs) out.uvs = uvs;
  if (colors) out.colors = colors;
  if (normals) out.normals = normals;
  if (sharp) out.sharp = sharp;
  if (edges) out.edges = edges;
  if (groups) out.groups = groups;
  if (materials) out.materials = materials;
  return out;
}

export interface TransformOptions {
  /** Applied last. */
  translate?: Vec3;
  /** Euler angles in radians, applied X then Y then Z. */
  rotate?: Vec3;
  /** Per-axis scale, or one number for uniform. */
  scale?: Vec3 | number;
  /** Rotation and scale happen about this point. Default the origin. */
  pivot?: Vec3;
}

/**
 * Place a mesh in the world.
 *
 * A scale with an odd number of negative axes turns the mesh inside out, so
 * the winding is reversed to compensate — a mirrored chair still faces out.
 * UVs follow their corners through that reversal.
 */
export function transformMesh(data: MeshData, opts: TransformOptions): MeshData {
  const s = typeof opts.scale === "number" ? ([opts.scale, opts.scale, opts.scale] as Vec3) : (opts.scale ?? [1, 1, 1]);
  const [rx, ry, rz] = opts.rotate ?? [0, 0, 0];
  const [px, py, pz] = opts.pivot ?? [0, 0, 0];
  const [tx, ty, tz] = opts.translate ?? [0, 0, 0];

  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz2 = Math.sin(rz);

  const out = new Float32Array(data.positions.length);
  for (let i = 0; i < data.positions.length; i += 3) {
    let x = data.positions[i]! - px;
    let y = data.positions[i + 1]! - py;
    let z = data.positions[i + 2]! - pz;

    x *= s[0]; y *= s[1]; z *= s[2];

    let ty1 = y * cx - z * sx;
    let tz1 = y * sx + z * cx;
    y = ty1; z = tz1;

    const tx1 = x * cy + z * sy;
    tz1 = -x * sy + z * cy;
    x = tx1; z = tz1;

    const tx2 = x * cz - y * sz2;
    ty1 = x * sz2 + y * cz;
    x = tx2; y = ty1;

    out[i] = x + px + tx;
    out[i + 1] = y + py + ty;
    out[i + 2] = z + pz + tz;
  }

  const flipped = s[0] * s[1] * s[2] < 0;
  const placed = withPositions(data, out);
  if (flipped) {
    // `mesh_flip_faces`: the first corner stays first and the rest reverse
    // (`[a, b, c, d]` → `[a, d, c, b]`), the corner layers with them.
    const flip = <T>(f: T[]): T[] => (f.length ? [f[0]!, ...f.slice(1).reverse()] : f);
    placed.polys = placed.polys.map(flip);
    for (const k of ["uvs", "colors", "normals"] as const) placed[k] = placed[k]?.map(flip);
  }
  // A custom normal turns with the surface: the inverse transpose of the
  // linear part, which for rotate · scale is rotate · (1 / scale).
  if (placed.normals && s.some((k) => k === 0)) delete placed.normals;
  if (placed.normals)
    placed.normals = placed.normals.map((f) =>
      f.map(([nx, ny, nz]) => {
        let x = nx! / s[0], y = ny! / s[1], z = nz! / s[2];
        let t = y * cx - z * sx;
        z = y * sx + z * cx;
        y = t;
        t = x * cy + z * sy;
        z = -x * sy + z * cy;
        x = t;
        t = x * cz - y * sz2;
        y = x * sz2 + y * cz;
        x = t;
        const l = Math.hypot(x, y, z) || 1;
        return [x / l, y / l, z / l];
      }),
    );
  return placed;
}

export interface MirrorOptions {
  /** Keep the source alongside the reflection. Default true. */
  keepOriginal?: boolean;
  /**
   * Weld reflected vertices back onto the originals within this distance,
   * fusing the two halves into one surface across the mirror plane. 0 leaves
   * them as separate shells. Default 0.
   */
  weld?: number;
  /** Position of the mirror plane on `axis`. Default 0. */
  offset?: number;
}

/**
 * Reflect a mesh across an axis-aligned plane.
 *
 * Every layer is carried (the reflection through `transformMesh`, the two
 * halves through `mergeMeshes`). This is `bmesh.ops.mirror`'s reflection;
 * Blender's Mirror **modifier** — merge onto each vertex's own image, bisect,
 * several axes, UV mirroring, `.L` / `.R` groups — is {@link mirrorModifier}.
 */
export function mirrorMesh(data: MeshData, axis: "x" | "y" | "z", opts: MirrorOptions = {}): MeshData {
  const k = axis === "x" ? 0 : axis === "y" ? 1 : 2;
  const offset = opts.offset ?? 0;
  const scale: Vec3 = [k === 0 ? -1 : 1, k === 1 ? -1 : 1, k === 2 ? -1 : 1];
  const pivot: Vec3 = [k === 0 ? offset : 0, k === 1 ? offset : 0, k === 2 ? offset : 0];

  const reflected = transformMesh(data, { scale, pivot });
  if (opts.keepOriginal === false) return reflected;

  const merged = mergeMeshes([data, reflected]);
  return opts.weld ? weldMesh(merged, opts.weld) : merged;
}

/** Per-axis switches for {@link MirrorModifierOptions}. */
export interface MirrorAxes {
  x?: boolean;
  y?: boolean;
  z?: boolean;
}

/** Blender's Mirror modifier settings, with its defaults (compat-backlog B2). */
export interface MirrorModifierOptions {
  /** `use_axis`: which axes to mirror across, in X, Y, Z order. Default X only. */
  axes?: MirrorAxes;
  /** `use_mirror_merge`: weld each vertex onto its own image within `mergeThreshold`. Default on. */
  merge?: boolean;
  /** `merge_threshold`. Default 0.001. */
  mergeThreshold?: number;
  /** `use_bisect_axis`: cut the mesh at the plane first and drop the far side. */
  bisect?: MirrorAxes;
  /** `use_bisect_flip_axis`: keep the negative side instead. */
  bisectFlip?: MirrorAxes;
  /** `bisect_threshold`. Default 0.001. */
  bisectThreshold?: number;
  /** `use_mirror_u` / `use_mirror_v`: the copy's UVs become 1 − u (1 − v), plus `uvOffset`. */
  mirrorU?: boolean;
  mirrorV?: boolean;
  /** `mirror_offset_u` / `_v`: added where a coordinate is mirrored. */
  uvOffset?: readonly [number, number];
  /** `offset_u` / `offset_v`: added to every copied UV. */
  uvOffsetCopy?: readonly [number, number];
  /** `use_mirror_vertex_groups`: the copy's `.L` groups become `.R` and back. Default on. */
  mirrorVertexGroups?: boolean;
}

/**
 * Blender's `BLI_string_flip_side_name` (without stripping a number): the
 * name with its side swapped — `Arm.L` ↔ `Arm.R`, `l_hand` ↔ `r_hand`,
 * `LeftFoot` ↔ `RightFoot` — or the name itself when it has no side.
 */
export function flipSideName(name: string): string {
  if (name.length < 3) return name;
  let base = name;
  let number = "";
  if (/\d$/.test(base)) {
    const i = base.lastIndexOf(".");
    if (i >= 0 && /\d/.test(base[i + 1] ?? "")) {
      number = base.slice(i);
      base = base.slice(0, i);
    }
  }
  const len = base.length;
  const sep = (ch: string | undefined): boolean => ch === "." || ch === " " || ch === "-" || ch === "_";
  const swap: Record<string, string> = { l: "r", r: "l", L: "R", R: "L" };
  if (len > 1 && sep(base[len - 2]) && swap[base[len - 1]!]) return base.slice(0, len - 1) + swap[base[len - 1]!] + number;
  if (sep(base[1]) && swap[base[0]!]) return swap[base[0]!] + base.slice(1) + number;
  if (len > 5) {
    const low = base.toLowerCase();
    let i = low.indexOf("right");
    // Only the first occurrence counts, and only at the start or the end.
    if (i >= 0 && (i === 0 || i === len - 5)) {
      const rep = base[i] === "r" ? "left" : base[i + 1] === "I" ? "LEFT" : "Left";
      return base.slice(0, i) + rep + base.slice(i + 5) + number;
    }
    i = low.indexOf("left");
    if (i >= 0 && (i === 0 || i === len - 4)) {
      const rep = base[i] === "l" ? "right" : base[i + 1] === "E" ? "RIGHT" : "Right";
      return base.slice(0, i) + rep + base.slice(i + 4) + number;
    }
  }
  return name;
}

/**
 * Blender's **Mirror modifier** (`MOD_mirror.cc`, `mesh_mirror.cc`), with its
 * defaults — X only, merge on at 0.001, vertex groups mirrored.
 *
 * Axis by axis (X, then Y, then Z, each on the result of the last): cut at the
 * plane and drop the far side when bisecting; append a reflected copy (faces
 * turned, first corner kept); weld each vertex onto **its own image** — not
 * onto anything else — when the two are within the threshold, both moving to
 * their midpoint (`mesh_merge_verts`, no mixing). On the copy, UVs are
 * mirrored and offset as asked, and `.L` / `.R` vertex groups trade names; a
 * welded vertex holds both sides' groups at their mean
 * (`BKE_defvert_flip_merged`).
 *
 * {@link mirrorMesh} is `bmesh.ops.mirror`'s simpler reflection.
 */
export function mirrorModifier(data: MeshData, opts: MirrorModifierOptions = {}): MeshData {
  const axes = opts.axes ?? { x: true };
  let out = data;
  (["x", "y", "z"] as const).forEach((axis, k) => {
    if (axes[axis]) out = mirrorOnAxis(out, k, opts, !!opts.bisect?.[axis], !!opts.bisectFlip?.[axis]);
  });
  return out;
}

function mirrorOnAxis(data: MeshData, k: number, opts: MirrorModifierOptions, bisect: boolean, flip: boolean): MeshData {
  let src = data;
  if (bisect) {
    // `BKE_mesh_mirror_bisect_on_mirror_plane_for_modifier`: the plane's
    // normal points to the side that goes (-axis unless flipped), vertices
    // within the threshold are snapped onto it (`use_snap_center`).
    const t = opts.bisectThreshold ?? 0.001;
    const s = flip ? 1 : -1;
    const planeNo: Vec3 = [k === 0 ? s : 0, k === 1 ? s : 0, k === 2 ? s : 0];
    src = bisectPlane(src, { planeCo: [0, 0, 0], planeNo, dist: t, clearOuter: true });
    const P = Float32Array.from(src.positions);
    // `plane_point_test_v3`: on the plane is strictly within the threshold.
    for (let v = 0; v < P.length / 3; v++) if (Math.abs(P[v * 3 + k]!) < t) P[v * 3 + k] = 0;
    src = withPositions(src, P);
  }
  const n = src.positions.length / 3;
  const scale: Vec3 = [k === 0 ? -1 : 1, k === 1 ? -1 : 1, k === 2 ? -1 : 1];
  const reflected = transformMesh(src, { scale });
  const joined = mergeMeshes([src, reflected]);
  const faces0 = src.polys.length;

  // UVs of the copy.
  if (joined.uvs && (opts.mirrorU || opts.mirrorV || opts.uvOffsetCopy)) {
    const [ou, ov] = opts.uvOffset ?? [0, 0];
    const [cu, cv] = opts.uvOffsetCopy ?? [0, 0];
    for (let f = faces0; f < joined.uvs.length; f++)
      joined.uvs[f] = joined.uvs[f]!.map(([u, v]) => [
        (opts.mirrorU ? 1 - u! + ou : u!) + cu,
        (opts.mirrorV ? 1 - v! + ov : v!) + cv,
      ]);
  }

  // Which vertices weld onto their own image, and where they go. The copy
  // welds into the original (`use_correct_order_on_merge`, on for a modifier
  // made today), so the original keeps its index and its data.
  const P = Float32Array.from(joined.positions);
  const target = new Int32Array(2 * n).map((_, i) => i);
  if (opts.merge ?? true) {
    const tol = opts.mergeThreshold ?? 0.001;
    for (let i = 0; i < n; i++) {
      let d2 = 0;
      for (let a = 0; a < 3; a++) d2 += (P[i * 3 + a]! - P[(n + i) * 3 + a]!) ** 2;
      if (d2 < tol * tol) {
        target[n + i] = i;
        for (let a = 0; a < 3; a++) {
          const m = (P[i * 3 + a]! + P[(n + i) * 3 + a]!) / 2;
          P[i * 3 + a] = m;
          P[(n + i) * 3 + a] = m;
        }
      }
    }
  }
  let result = withPositions(joined, P);

  // Vertex groups: the copy's sides trade names; a welded original holds both.
  if ((opts.mirrorVertexGroups ?? true) && result.groups && result.groups.size > 0) {
    const names = [...result.groups.keys()];
    const partner = new Map<string, string>();
    for (const name of names) {
      if (partner.has(name)) continue;
      const other = flipSideName(name);
      if (other !== name && result.groups.has(other)) {
        partner.set(name, other);
        partner.set(other, name);
      }
    }
    if (partner.size > 0) {
      const groups = new Map([...result.groups].map(([g, m]) => [g, new Map(m)]));
      for (let i = 0; i < n; i++) {
        const copy = n + i;
        if (target[copy] !== copy) {
          // `BKE_defvert_flip_merged` on the original: each side it holds
          // and its partner both take their mean (a missing side counts 0).
          const held = names.filter((g) => groups.get(g)!.has(i));
          for (const g of held) {
            const p = partner.get(g);
            if (!p) continue;
            const w = 0.5 * ((groups.get(p)!.get(i) ?? 0) + groups.get(g)!.get(i)!);
            groups.get(p)!.set(i, w);
            groups.get(g)!.set(i, w);
          }
        } else {
          // `BKE_defvert_flip`: each membership moves to the partner group;
          // a group with no partner keeps its own.
          const before = new Map(names.map((g) => [g, groups.get(g)!.get(copy)] as const));
          for (const g of names) {
            const p = partner.get(g);
            if (!p) continue;
            if (before.get(p) === undefined) groups.get(g)!.delete(copy);
            else groups.get(g)!.set(copy, before.get(p)!);
          }
        }
      }
      result = { ...result, groups };
    }
  }

  if (!target.some((t, i) => t !== i)) return result;
  return weldByMap(result, (v) => target[v]!, "array");
}

export interface ArrayMeshOptions {
  /**
   * Blender's `relative_offset_displace`: a further step of this many times
   * the mesh's own size along each axis (its bounding box), added to
   * `offset`. `[1, 0, 0]` lays copies end to end along X whatever their size.
   */
  relative?: Vec3;
  /**
   * Blender's `use_merge_vertices` with this `merge_threshold`: each copy's
   * vertices weld onto the previous copy's within the distance. The survivor
   * stays where it was. Default off.
   */
  merge?: number;
  /** Blender's `use_merge_vertices_cap`: also weld the first copy onto the last. */
  mergeFirstLast?: boolean;
  /**
   * Blender's `start_cap`: a mesh placed one step **before** the first copy
   * (in its own coordinates, shifted back by the offset), welded onto the
   * first copy when `merge` is on.
   */
  startCap?: MeshData;
  /** Blender's `end_cap`: one step past the last copy, welded onto it when merging. */
  endCap?: MeshData;
  /**
   * Blender's `offset_object`: the empty's transform, **multiplied into** the
   * step (after the constant and relative offsets). A rotation here is what
   * makes a ring of copies; a scale makes each copy smaller than the last.
   */
  objectOffset?: TransformOptions;
  /**
   * Blender's `fit_type = FIT_LENGTH` with this `fit_length`: as many copies
   * as fit — `count` is then ignored and becomes `⌊(length + 1e-6) / |step| + 1⌋`,
   * `|step|` being the length of the whole step's translation.
   */
  fitLength?: number;
  /** Blender's `offset_u` / `offset_v`: copy `c` has its UVs moved by `c` times this. */
  uvOffset?: readonly [number, number];
}

/** A 4×3 affine map: rows of the linear part, then the translation. */
type Affine = [Vec3, Vec3, Vec3, Vec3];

/** An object's matrix from `TransformOptions` — scale, then X/Y/Z Euler, then translate (Blender's `loc · rot · scale`). */
function affineOf(t: TransformOptions): Affine {
  const s = typeof t.scale === "number" ? ([t.scale, t.scale, t.scale] as Vec3) : (t.scale ?? [1, 1, 1]);
  const [rx, ry, rz] = t.rotate ?? [0, 0, 0];
  const [px, py, pz] = t.pivot ?? [0, 0, 0];
  const [tx, ty, tz] = t.translate ?? [0, 0, 0];
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
  // R = Rz · Ry · Rx, row-major.
  const R: [Vec3, Vec3, Vec3] = [
    [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
    [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
    [-sy, cy * sx, cy * cx],
  ];
  const sc = (row: Vec3): Vec3 => [row[0] * s[0], row[1] * s[1], row[2] * s[2]];
  const L: [Vec3, Vec3, Vec3] = [sc(R[0]), sc(R[1]), sc(R[2])];
  // About the pivot: p' = L (p − pivot) + pivot + translate.
  const tr = (i: 0 | 1 | 2, pv: number, tv: number): number => pv + tv - (L[i][0] * px + L[i][1] * py + L[i][2] * pz);
  const t3: Vec3 = [tr(0, px, tx), tr(1, py, ty), tr(2, pz, tz)];
  return [L[0], L[1], L[2], t3];
}
const applyAffine = (m: Affine, p: Vec3): Vec3 => [
  m[0][0] * p[0] + m[0][1] * p[1] + m[0][2] * p[2] + m[3][0],
  m[1][0] * p[0] + m[1][1] * p[1] + m[1][2] * p[2] + m[3][1],
  m[2][0] * p[0] + m[2][1] * p[1] + m[2][2] * p[2] + m[3][2],
];
/** `a · b` (apply `b` first). */
function mulAffine(a: Affine, b: Affine): Affine {
  const lin = (i: number, j: number): number => a[i]![0] * b[0][j]! + a[i]![1] * b[1][j]! + a[i]![2] * b[2][j]!;
  const t = applyAffine(a, b[3]);
  return [
    [lin(0, 0), lin(0, 1), lin(0, 2)],
    [lin(1, 0), lin(1, 1), lin(1, 2)],
    [lin(2, 0), lin(2, 1), lin(2, 2)],
    t,
  ];
}
function invertAffine(m: Affine): Affine {
  const [a, b, c] = [m[0], m[1], m[2]];
  const det = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  const inv: [Vec3, Vec3, Vec3] = [
    [(b[1] * c[2] - b[2] * c[1]) / det, (a[2] * c[1] - a[1] * c[2]) / det, (a[1] * b[2] - a[2] * b[1]) / det],
    [(b[2] * c[0] - b[0] * c[2]) / det, (a[0] * c[2] - a[2] * c[0]) / det, (a[2] * b[0] - a[0] * b[2]) / det],
    [(b[0] * c[1] - b[1] * c[0]) / det, (a[1] * c[0] - a[0] * c[1]) / det, (a[0] * b[1] - a[1] * b[0]) / det],
  ];
  const t = m[3];
  const back = (r: Vec3): number => -(r[0] * t[0] + r[1] * t[1] + r[2] * t[2]);
  const it: Vec3 = [back(inv[0]), back(inv[1]), back(inv[2])];
  return [inv[0], inv[1], inv[2], it];
}
/** Positions through an affine map; faces, creases, seams, UVs as they were (no rewinding — Blender's Array does not). */
function placeAffine(data: MeshData, m: Affine, uvShift?: readonly [number, number]): MeshData {
  const P = data.positions;
  const out = new Float32Array(P.length);
  for (let i = 0; i < P.length; i += 3) {
    const q = applyAffine(m, [P[i]!, P[i + 1]!, P[i + 2]!]);
    out[i] = q[0];
    out[i + 1] = q[1];
    out[i + 2] = q[2];
  }
  const placed = withPositions(data, out);
  if (placed.uvs && uvShift) placed.uvs = placed.uvs.map((f) => f.map((c) => [c[0]! + uvShift[0], c[1]! + uvShift[1]]));
  // Custom normals by the inverse transpose of the linear part (the rows of
  // the inverse, read as columns); a singular map drops them.
  if (placed.normals) {
    const inv = invertAffine(m);
    if (!inv.every((r) => r.every(Number.isFinite))) delete placed.normals;
    else
      placed.normals = placed.normals.map((f) =>
        f.map(([x, y, z]) => {
          const nx = inv[0][0] * x! + inv[1][0] * y! + inv[2][0] * z!;
          const ny = inv[0][1] * x! + inv[1][1] * y! + inv[2][1] * z!;
          const nz = inv[0][2] * x! + inv[1][2] * y! + inv[2][2] * z!;
          const l = Math.hypot(nx, ny, nz) || 1;
          return [nx / l, ny / l, nz / l];
        }),
      );
  }
  return placed;
}

/**
 * `dm_mvert_map_doubles` (`MOD_array.cc`): map each `source` vertex to the
 * nearest `target` vertex within `dist`, scanning both sorted by the sum of
 * their coordinates (the CRT `qsort`, whose tie order decides equal
 * distances — `<=` keeps the later). A target already mapped elsewhere is
 * followed only while its final target stays within `dist`.
 */
function mapDoubles(
  map: Int32Array,
  P: Float32Array,
  targetStart: number,
  sourceStart: number,
  n: number,
  dist: number,
): void {
  mapDoublesBetween(map, P, targetStart, n, sourceStart, n, dist);
}

function mapDoublesBetween(
  map: Int32Array,
  P: Float32Array,
  targetStart: number,
  nTarget: number,
  sourceStart: number,
  nSource: number,
  dist: number,
): void {
  const n = nTarget;
  const f = Math.fround;
  const sum = (v: number): number => f(f(P[v * 3]! + P[v * 3 + 1]!) + P[v * 3 + 2]!);
  const lenSq = (a: number, b: number): number => {
    const x = f(P[b * 3]! - P[a * 3]!);
    const y = f(P[b * 3 + 1]! - P[a * 3 + 1]!);
    const z = f(P[b * 3 + 2]! - P[a * 3 + 2]!);
    return f(f(f(x * x) + f(y * y)) + f(z * z));
  };
  const cmp = (a: number, b: number): number => (sum(a) > sum(b) ? 1 : sum(a) < sum(b) ? -1 : 0);
  const target = Array.from({ length: n }, (_, i) => targetStart + i);
  const source = Array.from({ length: nSource }, (_, i) => sourceStart + i);
  crtQsort(target, cmp);
  crtQsort(source, cmp);
  const dist3 = f(f(Math.sqrt(3) + 0.00005) * dist);
  const distSq = f(dist * dist);
  let low = 0;
  let completed = false;
  for (const s of source) {
    if (map[s] !== -1) continue;
    if (completed) continue;
    const ss = sum(s);
    while (low < n && sum(target[low]!) < f(ss - dist3)) low++;
    if (low >= n) {
      completed = true;
      continue;
    }
    let best = -1;
    let bestSq = distSq;
    for (let t = low; t < n && sum(target[t]!) <= f(ss + dist3); t++) {
      const d = lenSq(s, target[t]!);
      if (d > bestSq) continue;
      bestSq = d;
      best = target[t]!;
      while (best !== -1 && map[best] !== -1 && map[best] !== best)
        best = lenSq(s, map[best]!) <= distSq ? map[best]! : -1; // `compare_len_v3v3`
    }
    map[s] = best;
  }
}

/**
 * Repeat a mesh `count` times, each copy one step on from the last —
 * Blender's **Array** modifier. The step is the constant `offset`, plus the
 * `relative` one, with the `objectOffset` transform multiplied in; copy `c`
 * sits at the step applied `c` times. Copies come after the original,
 * vertices and faces alike, then the start cap, then the end cap, as Blender
 * lays them out. Fit to a curve is not offered (it needs a curve object).
 */
export function arrayMesh(
  data: MeshData,
  count: number,
  offset: Vec3,
  options: ArrayMeshOptions = {},
): MeshData {
  // `offset`: translation by the constant and relative offsets, then the
  // object offset multiplied in on the right.
  const step: number[] = [offset[0], offset[1], offset[2]];
  if (options.relative) {
    const P = data.positions;
    for (let k = 0; k < 3; k++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = k; i < P.length; i += 3) {
        lo = Math.min(lo, P[i]!);
        hi = Math.max(hi, P[i]!);
      }
      if (hi >= lo) step[k] = step[k]! + options.relative[k]! * (hi - lo);
    }
  }
  let M: Affine = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [step[0]!, step[1]!, step[2]!]];
  if (options.objectOffset) M = mulAffine(M, affineOf(options.objectOffset));
  // `mat4_to_size`: the column lengths of the linear part.
  const hasScale = [0, 1, 2].some((j) => Math.abs(Math.hypot(M[0][j]!, M[1][j]!, M[2][j]!) - 1) > 1e-6);

  if (options.fitLength !== undefined) {
    const dist = Math.hypot(M[3][0], M[3][1], M[3][2]);
    count = dist > 1e-6 ? Math.floor((options.fitLength + 1e-6) / dist + 1) : 1;
  }
  count = Math.max(1, Math.floor(count));

  const parts: MeshData[] = [];
  let current: Affine = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, 0]];
  const uv = options.uvOffset;
  for (let i = 0; i < count; i++) {
    if (i > 0) current = mulAffine(current, M);
    parts.push(i === 0 ? data : placeAffine(data, current, uv ? [uv[0] * i, uv[1] * i] : undefined));
  }
  // Caps come after the copies, start then end (`mesh_merge_transform`): the
  // start one step before the first copy, the end one step after the last.
  if (options.startCap) parts.push(placeAffine(options.startCap, invertAffine(M)));
  if (options.endCap) parts.push(placeAffine(options.endCap, mulAffine(current, M)));
  const merged = mergeMeshes(parts);
  const dist = options.merge;
  if (dist === undefined) return merged;

  // `MOD_array.cc`, merge: copy 1 onto copy 0 by search; every later copy
  // repeats that mapping shifted by one copy (a pure translation keeps the
  // distances), followed while the final target stays in range.
  const n = data.positions.length / 3;
  const P = merged.positions;
  const map = new Int32Array(P.length / 3).fill(-1);
  const distSq = Math.fround(dist * dist);
  const lenSq = (a: number, b: number): number => {
    const f = Math.fround;
    const x = f(P[b * 3]! - P[a * 3]!);
    const y = f(P[b * 3 + 1]! - P[a * 3 + 1]!);
    const z = f(P[b * 3 + 2]! - P[a * 3 + 2]!);
    return f(f(f(x * x) + f(y * y)) + f(z * z));
  };
  if (count >= 2) mapDoubles(map, P, 0, n, n, dist);
  for (let c = 2; c < count; c++)
    if (hasScale) mapDoubles(map, P, (c - 1) * n, c * n, n, dist);
    else for (let k = 0; k < n; k++) {
      const self = c * n + k;
      let t = map[(c - 1) * n + k]!;
      if (t !== -1) {
        t += n;
        while (t !== -1 && map[t] !== -1 && map[t] !== t) t = lenSq(self, map[t]!) <= distSq ? map[t]! : -1;
      }
      map[self] = t;
    }
  if (options.mergeFirstLast && count > 1) mapDoubles(map, P, (count - 1) * n, 0, n, dist);
  // Each cap onto the copy it sits against.
  let capAt = n * count;
  if (options.startCap) {
    const m = options.startCap.positions.length / 3;
    mapDoublesBetween(map, P, 0, n, capAt, m, dist);
    capAt += m;
  }
  if (options.endCap) {
    const m = options.endCap.positions.length / 3;
    mapDoublesBetween(map, P, (count - 1) * n, n, capAt, m, dist);
  }

  // Follow chains to their end; a vertex that ends at itself stays.
  for (let v = 0; v < map.length; v++) {
    let t = map[v]!;
    if (t === -1) continue;
    while (map[t] !== -1 && map[t] !== t) t = map[t]!;
    map[v] = t === v ? -1 : t;
  }
  return weldByMap(merged, (v) => (map[v] === -1 ? v : map[v]!), "array");
}

/**
 * Repeat a mesh along a path of explicit placements.
 *
 * `arrayMesh` covers evenly spaced runs (drawer fronts, balusters). This one
 * covers the rest: six chairs around a table, three pendants at measured
 * centres, each with its own rotation.
 */
export function instanceMesh(data: MeshData, placements: readonly TransformOptions[]): MeshData {
  return mergeMeshes(placements.map((p) => transformMesh(data, p)));
}

export interface RadialArrayOptions {
  /** How many copies in total. The source counts as the first one. */
  count: number;
  /** Axis to turn about, through `center`. Default `"y"`. */
  axis?: "x" | "y" | "z" | Vec3;
  /** Point the axis passes through. Default the origin. */
  center?: Vec3;
  /**
   * Total sweep in radians. Default a full turn.
   *
   * **A full turn and a partial one space their copies differently, on
   * purpose.** Round a full turn, `count` copies sit `2π / count` apart and
   * nothing lands twice — three legs at 120°. Over a partial angle the first
   * copy is at 0 and the last is exactly *at* `angle` — five balusters fanned
   * across a quarter turn are five, not four and a gap.
   */
  angle?: number;
  /** Push each copy this far out from the axis before turning it. Default 0. */
  radius?: number;
}

/**
 * Copies turned about an axis — legs round a brazier, stools round an island.
 *
 * Blender's `bmesh.ops.spin(use_duplicate=True)`, and the two disagree about
 * counting in a way worth knowing, because it is the kind of difference that
 * shows up as a rendering artefact rather than an error:
 *
 *  - Blender's `steps` is how many copies to **add**, so the source plus
 *    `steps` copies come out; this `count` is the total.
 *  - Blender divides by `steps` whatever the angle, so a full turn puts the
 *    last copy **exactly on top of the first**. Measured on a cube: 40
 *    vertices of which 32 are distinct. Doubled geometry is invisible until
 *    something z-fights or a weld halves the model.
 *
 * So `radialArray({ count: n })` is `spin(steps = n - 1, angle = 2π(n-1)/n)`,
 * and over a partial angle it is plain `spin(steps = n - 1)`. The parity run
 * spells both (`parity/compare.ts`, op `spin`).
 */
export function radialArray(data: MeshData, opts: RadialArrayOptions): MeshData {
  const count = Math.max(1, Math.floor(opts.count));
  const angle = opts.angle ?? Math.PI * 2;
  const center = opts.center ?? ([0, 0, 0] as Vec3);
  const named: Record<"x" | "y" | "z", Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const axis: Vec3 =
    opts.axis === undefined || typeof opts.axis === "string" ? named[opts.axis ?? "y"] : opts.axis;
  const full = Math.abs(Math.abs(angle) - Math.PI * 2) < 1e-9;
  const step = count < 2 ? 0 : angle / (full ? count : count - 1);

  const source =
    opts.radius ? transformMesh(data, { translate: radialPush(axis, opts.radius) }) : data;

  const parts: MeshData[] = [];
  for (let i = 0; i < count; i++) parts.push(rotateAbout(source, center, axis, step * i));
  return mergeMeshes(parts);
}

/** A unit vector perpendicular to `axis`, scaled by `by` — "out from the axis". */
function radialPush(axis: Vec3, by: number): Vec3 {
  const a = normalize(axis);
  // Any perpendicular will do; take the one furthest from the axis so the
  // choice is stable rather than nearly-degenerate.
  const helper: Vec3 = Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const p = normalize(crossVec(a, helper));
  return [p[0] * by, p[1] * by, p[2] * by];
}

/** Rotate a mesh by `angle` about an arbitrary axis through `center`. */
function rotateAbout(data: MeshData, center: Vec3, axis: Vec3, angle: number): MeshData {
  if (angle === 0) return withPositions(data, Float32Array.from(data.positions));
  const [x, y, z] = normalize(axis);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  // Rodrigues, written out: `transformMesh` takes Euler angles, and turning an
  // arbitrary axis into Euler angles loses precision exactly where a ring
  // needs it — every copy inherits the error.
  const m = [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  ];

  const out = new Float32Array(data.positions.length);
  for (let i = 0; i < data.positions.length; i += 3) {
    const px = data.positions[i]! - center[0];
    const py = data.positions[i + 1]! - center[1];
    const pz = data.positions[i + 2]! - center[2];
    out[i] = m[0]! * px + m[1]! * py + m[2]! * pz + center[0];
    out[i + 1] = m[3]! * px + m[4]! * py + m[5]! * pz + center[1];
    out[i + 2] = m[6]! * px + m[7]! * py + m[8]! * pz + center[2];
  }
  const turned = withPositions(data, out);
  // Custom normals turn with the copy.
  if (turned.normals)
    turned.normals = turned.normals.map((f) =>
      f.map(([nx, ny, nz]) => [
        m[0]! * nx! + m[1]! * ny! + m[2]! * nz!,
        m[3]! * nx! + m[4]! * ny! + m[5]! * nz!,
        m[6]! * nx! + m[7]! * ny! + m[8]! * nz!,
      ]),
    );
  return turned;
}

const crossVec = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

const normalize = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export interface PathArrayOptions {
  /**
   * How many copies. Omit to space them by `spacing` instead.
   *
   * With a count the copies are spread evenly by **arc length**, first at the
   * start and last at the end of the path (or, on a closed path, one step
   * short of coming back round).
   */
  count?: number;
  /** Distance between copies along the path. Ignored when `count` is given. */
  spacing?: number;
  /** Join the last path point back to the first. Default false. */
  closed?: boolean;
  /** Which way is up for the copies. Default `[0, 1, 0]`. Same as `sweep`. */
  up?: Vec3;
  /** Turn each copy to follow the path. Default true. */
  follow?: boolean;
  /** Extra spin about the path, radians, added per copy index. */
  twistPerCopy?: number;
}

/**
 * Copies laid along a path, each turned to follow it — a chain, a fence, bolts
 * round a flange.
 *
 * The copy's local axes meet the path the same way `sweep`'s profile does: +z
 * runs along the path, +y is `up`, +x is the side. A link modelled lying in
 * the xy plane therefore threads the path without being pre-rotated, and
 * `twistPerCopy = π / 2` alternates them the way a real chain does.
 *
 * **No Blender reference.** Blender does this with an Array modifier fitted to
 * a curve plus a Curve modifier, which *deforms* the geometry along the curve
 * rather than placing rigid copies. That is a different operation with a
 * different result, so there is nothing to measure this against and no parity
 * claim is made — unlike `radialArray`, whose `spin` really is the same job.
 */
export function arrayAlongPath(
  data: MeshData,
  path: readonly Vec3[],
  opts: PathArrayOptions = {},
): MeshData {
  if (path.length < 2) return mergeMeshes([data]);
  const closed = opts.closed ?? false;
  const points = closed ? [...path, path[0]!] : [...path];

  // Cumulative arc length, so spacing means distance and not "per segment" —
  // a path with one long leg and three short ones would otherwise bunch.
  const cumulative: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(
      points[i]![0] - points[i - 1]![0],
      points[i]![1] - points[i - 1]![1],
      points[i]![2] - points[i - 1]![2],
    );
    cumulative.push(cumulative[i - 1]! + d);
  }
  const total = cumulative[cumulative.length - 1]!;
  if (total === 0) return mergeMeshes([data]);

  const distances: number[] = [];
  if (opts.count !== undefined) {
    const n = Math.max(1, Math.floor(opts.count));
    const step = n < 2 ? 0 : total / (closed ? n : n - 1);
    for (let i = 0; i < n; i++) distances.push(step * i);
  } else {
    const spacing = opts.spacing ?? total;
    for (let d = 0; d <= total + 1e-9; d += spacing) distances.push(d);
  }

  const up = normalize(opts.up ?? [0, 1, 0]);
  const follow = opts.follow ?? true;
  const twist = opts.twistPerCopy ?? 0;

  const parts: MeshData[] = [];
  distances.forEach((d, i) => {
    const { point, tangent } = sampleAt(points, cumulative, Math.min(d, total));
    let placed = data;
    if (twist) placed = rotateAbout(placed, [0, 0, 0], [0, 0, 1], twist * i);
    if (follow) placed = orientToFrame(placed, tangent, up);
    parts.push(transformMesh(placed, { translate: point }));
  });
  return mergeMeshes(parts);
}

/** Point and unit tangent at arc length `d` along a polyline. */
function sampleAt(
  points: readonly Vec3[],
  cumulative: readonly number[],
  d: number,
): { point: Vec3; tangent: Vec3 } {
  let seg = 0;
  while (seg < cumulative.length - 2 && cumulative[seg + 1]! < d) seg++;
  const a = points[seg]!;
  const b = points[seg + 1]!;
  const segLen = cumulative[seg + 1]! - cumulative[seg]!;
  const t = segLen === 0 ? 0 : (d - cumulative[seg]!) / segLen;
  return {
    point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
    tangent: normalize([b[0] - a[0], b[1] - a[1], b[2] - a[2]]),
  };
}

/** Rotate a mesh from the world axes onto (side, up, tangent). */
function orientToFrame(data: MeshData, tangent: Vec3, up: Vec3): MeshData {
  let side = crossVec(up, tangent);
  if (Math.hypot(side[0], side[1], side[2]) < 1e-9) {
    // The path runs straight up: any side will do, so take a stable one.
    side = crossVec([1, 0, 0], tangent);
    if (Math.hypot(side[0], side[1], side[2]) < 1e-9) side = crossVec([0, 0, 1], tangent);
  }
  side = normalize(side);
  const vUp = normalize(crossVec(tangent, side));

  const out = new Float32Array(data.positions.length);
  for (let i = 0; i < data.positions.length; i += 3) {
    const x = data.positions[i]!;
    const y = data.positions[i + 1]!;
    const z = data.positions[i + 2]!;
    out[i] = side[0] * x + vUp[0] * y + tangent[0] * z;
    out[i + 1] = side[1] * x + vUp[1] * y + tangent[1] * z;
    out[i + 2] = side[2] * x + vUp[2] * y + tangent[2] * z;
  }
  return withPositions(data, out);
}

/**
 * Fuse vertices that coincide, rewriting polygons to the survivors.
 *
 * Faces that collapse to fewer than three distinct vertices are dropped —
 * that is the intended outcome when welding closes a seam.
 *
 * For Blender's answer — the same survivors as `remove_doubles`, loose edges
 * where a face collapsed — use {@link removeDoubles} (`remove-doubles.ts`).
 * This one is the generators' seam-closer and picks survivors its own way.
 */
export function weldMesh(data: MeshData, tolerance = 1e-4): MeshData {
  const count = data.positions.length / 3;
  const cell = Math.max(tolerance, 1e-9);
  const inv = 1 / cell;

  // Buckets of one tolerance across, and **every neighbouring bucket is
  // searched**, because a pair can be a nanometre apart and still fall either
  // side of a bucket line. Snapping to the bucket alone — which is what this
  // did until it was measured — welds only what happens to round together:
  // against `remove_doubles` at 0.05 on the production cage it kept 145
  // vertices where Blender kept 113, and on an arm 20 against 10.
  const buckets = new Map<string, number[]>();
  const bucketOf = (x: number, y: number, z: number): string =>
    `${Math.floor(x * inv)},${Math.floor(y * inv)},${Math.floor(z * inv)}`;

  for (let v = 0; v < count; v++) {
    const key = bucketOf(data.positions[v * 3]!, data.positions[v * 3 + 1]!, data.positions[v * 3 + 2]!);
    const list = buckets.get(key);
    if (list) list.push(v);
    else buckets.set(key, [v]);
  }

  // **Claiming, not chaining.** Each vertex that is still free claims every
  // free vertex within tolerance; a vertex that has been claimed cannot claim
  // in turn. Making it transitive instead — a chain each link of which is
  // within tolerance — is the obvious reading and is wrong: measured at 0.05
  // on an arm cage, transitive closure collapsed all 36 vertices into **one**
  // where Blender kept 10.
  const claimedBy = new Int32Array(count).fill(-1);
  const limit = tolerance * tolerance;
  // Who gets to claim is decided by **position**, not by index: Blender sorts
  // the vertices before pairing them, and with index order the counts came out
  // 115 and 11 against its 113 and 10 — close enough to look like rounding and
  // not be.
  const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => {
    const sa = data.positions[a * 3]! + data.positions[a * 3 + 1]! + data.positions[a * 3 + 2]!;
    const sb = data.positions[b * 3]! + data.positions[b * 3 + 1]! + data.positions[b * 3 + 2]!;
    return sa === sb ? a - b : sa - sb;
  });
  for (const v of order) {
    if (claimedBy[v] !== -1) continue;
    const x = data.positions[v * 3]!;
    const y = data.positions[v * 3 + 1]!;
    const z = data.positions[v * 3 + 2]!;
    const cx = Math.floor(x * inv), cy = Math.floor(y * inv), cz = Math.floor(z * inv);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          for (const other of buckets.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
            if (other === v || claimedBy[other] !== -1) continue;
            const ox = data.positions[other * 3]! - x;
            const oy = data.positions[other * 3 + 1]! - y;
            const oz = data.positions[other * 3 + 2]! - z;
            if (ox * ox + oy * oy + oz * oz <= limit) claimedBy[other] = v;
          }
        }
  }

  // The survivor keeps its own position rather than the group's average —
  // Blender merges onto a vertex, not onto a midpoint.
  const remap = new Int32Array(count);
  const newIndex = new Map<number, number>();
  const positions: number[] = [];
  for (let v = 0; v < count; v++) {
    const keep = claimedBy[v] === -1 ? v : claimedBy[v]!;
    let id = newIndex.get(keep);
    if (id === undefined) {
      id = positions.length / 3;
      positions.push(
        data.positions[keep * 3]!,
        data.positions[keep * 3 + 1]!,
        data.positions[keep * 3 + 2]!,
      );
      newIndex.set(keep, id);
    }
    remap[v] = id;
  }

  // A corner that welds onto its neighbour is dropped with its UV, so the
  // layer stays shaped like the surviving polygons.
  const polys: number[][] = [];
  const sources: FaceSource[] = [];
  data.polys.forEach((poly, f) => {
    const ring: number[] = [];
    const corners: number[] = [];
    poly.forEach((v, i) => {
      const m = remap[v]!;
      if (ring[ring.length - 1] !== m) {
        ring.push(m);
        corners.push(i);
      }
    });
    while (ring.length > 1 && ring[0] === ring[ring.length - 1]) {
      ring.pop();
      corners.pop();
    }
    if (ring.length >= 3) {
      polys.push(ring);
      sources.push({ face: f, corners });
    }
  });

  const creases = new Map<string, number>();
  if (data.creases)
    for (const [key, value] of data.creases) {
      const [a, b] = key.split("_");
      const ma = remap[Number(a)]!;
      const mb = remap[Number(b)]!;
      if (ma !== mb) creases.set(seamKey(ma, mb), value);
    }
  const seams = new Set<string>();
  if (data.seams)
    for (const key of data.seams) {
      const [a, b] = key.split("_");
      const ma = remap[Number(a)]!;
      const mb = remap[Number(b)]!;
      if (ma !== mb) seams.add(seamKey(ma, mb));
    }

  // The other layers (compat-backlog A3): each corner and face from where it
  // came, a survivor's groups its own, sharp edges and wire edges moved onto
  // the survivors.
  const out: MeshData = { positions: new Float32Array(positions), polys, creases, seams, ...carryFaceLayers(data, sources) };
  if (data.sharp) {
    out.sharp = new Set();
    for (const key of data.sharp) {
      const [a, b] = key.split("_");
      const ma = remap[Number(a)]!;
      const mb = remap[Number(b)]!;
      if (ma !== mb) out.sharp.add(seamKey(ma, mb));
    }
  }
  if (data.edges) out.edges = data.edges.map((e) => e.map((v) => remap[v]!)).filter((e) => e[0] !== e[1]);
  if (data.groups) {
    out.groups = new Map();
    for (const [name, g] of data.groups) {
      const ng = new Map<number, number>();
      for (const [v, w] of g) if (claimedBy[v] === -1) ng.set(remap[v]!, w);
      out.groups.set(name, ng);
    }
  }
  return out;
}

/** Axis-aligned bounds, or null for an empty mesh. */
export function boundsOf(data: MeshData): { min: Vec3; max: Vec3; size: Vec3; center: Vec3 } | null {
  if (data.positions.length === 0) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < data.positions.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const v = data.positions[i + k]!;
      if (v < min[k]!) min[k] = v;
      if (v > max[k]!) max[k] = v;
    }
  return {
    min,
    max,
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
  };
}

// ── Solidify ───────────────────────────────────────────────────────────────

/** Options for {@link solidify}. */
export interface SolidifyOptions {
  /**
   * Blender's `thickness`. **Positive goes along the negative normal** — an
   * upward-facing plate solidified by 0.25 grows downward, and a closed shell
   * is hollowed inward rather than inflated. Measured against
   * `bmesh.ops.solidify` rather than assumed; negative reverses it.
   */
  thickness: number;
}

/**
 * The offset each vertex takes for one unit of thickness: a unit normal times
 * a shell factor — `calc_solidify_normals` and `solidify_add_thickness` in
 * Blender's `bmo_extrude.cc`.
 *
 * - The normal is built **per edge**, not per corner: each edge between two
 *   faces adds `n₁ + n₂` scaled to the angle between them, a boundary edge
 *   adds its face's normal times π/2, and an edge between two coplanar faces
 *   adds nothing. On flat and right-angled input that is the same direction as
 *   a corner-angle-weighted normal, which is why it passed there for months;
 *   on a curved cage it is up to 0.84° off (`arm`, 0.79 mm mean). Vertices on
 *   an edge with no face or more than two fall back to the usual
 *   corner-angle-weighted normal, as Blender's do.
 * - Face normals are `BM_face_normal_update`'s: a quad's is the cross of its
 *   **diagonals**, not Newell's — the two differ on a bent quad.
 * - The shell factor is the corner-angle-weighted mean of `1 / |n · n_face|`.
 *   It is what makes the thickness *even*: without it a cube corner moves
 *   `thickness` along its diagonal and each of the three faces ends up only
 *   `thickness/sqrt(3)` thick.
 */
function offsetBasis(data: MeshData): { normals: Float32Array; shell: Float64Array } {
  const P = data.positions;
  const count = P.length / 3;
  const at = (v: number): Vec3 => [P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!];
  const unit = (x: Vec3): Vec3 => {
    const len = Math.hypot(x[0], x[1], x[2]);
    return len > 1e-35 ? [x[0] / len, x[1] / len, x[2] / len] : [0, 0, 0];
  };
  const cross3 = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const minus = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

  const faceNormals: Vec3[] = data.polys.map((poly) => {
    if (poly.length === 3) return unit(cross3(minus(at(poly[0]!), at(poly[1]!)), minus(at(poly[1]!), at(poly[2]!))));
    if (poly.length === 4)
      return unit(cross3(minus(at(poly[0]!), at(poly[2]!)), minus(at(poly[1]!), at(poly[3]!))));
    return unit(newellNormal(P, poly));
  });

  /** The angle the polygon turns through at its `i`th vertex. */
  const cornerAngle = (poly: readonly number[], i: number): number => {
    const n = poly.length;
    const a = unit(minus(at(poly[(i + n - 1) % n]!), at(poly[i]!)));
    const b = unit(minus(at(poly[(i + 1) % n]!), at(poly[i]!)));
    return Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
  };

  // Faces around each edge, and which vertices touch an edge that is not
  // between one or two faces.
  const edgeFaces = new Map<string, { a: number; b: number; faces: number[] }>();
  data.polys.forEach((poly, f) => {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      const key = seamKey(a, b);
      const e = edgeFaces.get(key) ?? { a, b, faces: [] };
      e.faces.push(f);
      edgeFaces.set(key, e);
    }
  });
  const nonManifold = new Uint8Array(count);
  for (const e of edgeFaces.values())
    if (e.faces.length > 2) nonManifold[e.a] = nonManifold[e.b] = 1;

  const acc = new Float64Array(count * 3);
  const flatOnly = new Uint8Array(count); // Blender clears the vertex tag here
  for (const e of edgeFaces.values()) {
    if (e.faces.length > 2) continue;
    let add: Vec3;
    if (e.faces.length === 2) {
      const n1 = faceNormals[e.faces[0]!]!;
      const n2 = faceNormals[e.faces[1]!]!;
      // `angle_normalized_v3v3`
      const d = n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2];
      const angle =
        d >= 0
          ? 2 * Math.asin(Math.min(1, Math.hypot(n1[0] - n2[0], n1[1] - n2[1], n1[2] - n2[2]) / 2))
          : Math.PI - 2 * Math.asin(Math.min(1, Math.hypot(n1[0] + n2[0], n1[1] + n2[1], n1[2] + n2[2]) / 2));
      if (!(angle > 0)) {
        flatOnly[e.a] = flatOnly[e.b] = 1;
        continue;
      }
      const s = unit([n1[0] + n2[0], n1[1] + n2[1], n1[2] + n2[2]]);
      add = [s[0] * angle, s[1] * angle, s[2] * angle];
    } else {
      const n1 = faceNormals[e.faces[0]!]!;
      add = [n1[0] * (Math.PI / 2), n1[1] * (Math.PI / 2), n1[2] * (Math.PI / 2)];
    }
    for (const v of [e.a, e.b]) {
      acc[v * 3] = acc[v * 3]! + add[0];
      acc[v * 3 + 1] = acc[v * 3 + 1]! + add[1];
      acc[v * 3 + 2] = acc[v * 3 + 2]! + add[2];
    }
  }

  // The usual corner-angle-weighted normal, for non-manifold vertices.
  const cornerWeighted = new Float64Array(count * 3);
  const firstFace = new Int32Array(count).fill(-1);
  data.polys.forEach((poly, f) => {
    const [nx, ny, nz] = faceNormals[f]!;
    for (let i = 0; i < poly.length; i++) {
      const v = poly[i]!;
      if (firstFace[v] === -1) firstFace[v] = f;
      const w = cornerAngle(poly, i);
      cornerWeighted[v * 3] = cornerWeighted[v * 3]! + nx * w;
      cornerWeighted[v * 3 + 1] = cornerWeighted[v * 3 + 1]! + ny * w;
      cornerWeighted[v * 3 + 2] = cornerWeighted[v * 3 + 2]! + nz * w;
    }
  });

  const normals = new Float32Array(P.length);
  for (let v = 0; v < count; v++) {
    let n: Vec3;
    if (nonManifold[v]) n = unit([cornerWeighted[v * 3]!, cornerWeighted[v * 3 + 1]!, cornerWeighted[v * 3 + 2]!]);
    else {
      n = unit([acc[v * 3]!, acc[v * 3 + 1]!, acc[v * 3 + 2]!]);
      // Totally flat: every edge was between coplanar faces. Take a face's.
      if (n[0] === 0 && n[1] === 0 && n[2] === 0 && flatOnly[v] && firstFace[v]! >= 0) n = faceNormals[firstFace[v]!]!;
    }
    normals[v * 3] = n[0];
    normals[v * 3 + 1] = n[1];
    normals[v * 3 + 2] = n[2];
  }

  const num = new Float64Array(count);
  const den = new Float64Array(count);
  data.polys.forEach((poly, f) => {
    const [nx, ny, nz] = faceNormals[f]!;
    for (let i = 0; i < poly.length; i++) {
      const v = poly[i]!;
      const w = cornerAngle(poly, i);
      const dot = Math.abs(normals[v * 3]! * nx + normals[v * 3 + 1]! * ny + normals[v * 3 + 2]! * nz);
      // `shell_v3v3_normalized_to_dist`: SMALL_NUMBER is 1e-8.
      num[v] = num[v]! + (dot < 1e-8 ? 1 : 1 / dot) * w;
      den[v] = den[v]! + w;
    }
  });
  const shell = new Float64Array(count);
  for (let v = 0; v < count; v++) shell[v] = den[v]! > 0 ? num[v]! / den[v]! : 0;

  return { normals, shell };
}

/**
 * Give a surface thickness — Blender's `bmesh.ops.solidify(geom=, thickness=)`,
 * and the bones of the Solidify modifier.
 *
 * A copy of the surface is offset along the vertex normals, reversed so it
 * faces the other way, and the two are joined around the boundary with rim
 * quads. An open plate becomes a closed slab; a closed shell becomes a hollow
 * one with an inner surface.
 *
 * The thickness is **even**: a cube corner moves far enough along its diagonal
 * that all three of its faces end up `thickness` apart, rather than
 * `thickness / sqrt(3)`. See {@link offsetBasis} — this is the one part of the
 * operation where a plausible implementation is 12-15% wrong, so it was
 * measured off Blender rather than derived.
 *
 * This is the bmesh operator, not the Solidify modifier: the original surface
 * stays where it is (there is no `offset`), and the rim gets no separate
 * material.
 *
 * Creases and seams on the original surface carry through and are mirrored
 * onto the offset copy; the rim edges are left uncreased.
 *
 * **How far the agreement has been measured** (`parity --op solidify`):
 * identical to Blender at 0.0000 mm, flat, right-angled and curved, closed or
 * open. The curved case (the arm cage) drifted 0.79 mm until 2026-09-25: the
 * normal was corner-weighted, and Blender's solidify builds its own per edge
 * (see {@link offsetBasis}) — read from `bmo_extrude.cc` after measuring had
 * ruled out every vertex normal Blender exposes.
 *
 * **Layers** (compat-backlog A7): all of them. Both shells keep each face's
 * corners and slot (the inner one's corners reversed with it), a rim quad
 * copies its edge's two corners and its face's slot, every vertex's groups
 * go to its copy, edge flags to both shells (`solidify-layers`).
 */
export function solidify(data: MeshData, opts: SolidifyOptions): MeshData {
  const P = data.positions;
  const count = P.length / 3;
  const { normals: N, shell } = offsetBasis(data);
  const t = opts.thickness;

  const positions = new Float32Array(P.length * 2);
  positions.set(P, 0);
  for (let v = 0; v < count; v++) {
    const i = v * 3;
    const d = t * shell[v]!;
    positions[P.length + i] = P[i]! - N[i]! * d;
    positions[P.length + i + 1] = P[i + 1]! - N[i + 1]! * d;
    positions[P.length + i + 2] = P[i + 2]! - N[i + 2]! * d;
  }

  const polys: number[][] = [];
  const sources: FaceSource[] = [];
  data.polys.forEach((poly, f) => {
    polys.push([...poly]);
    sources.push({ face: f, corners: poly.map((_, i) => i) });
  });
  // The offset copy faces the other way, so its winding is reversed.
  data.polys.forEach((poly, f) => {
    polys.push([...poly].reverse().map((v) => v + count));
    sources.push({ face: f, corners: poly.map((_, i) => poly.length - 1 - i) });
  });
  // The corner layers: both shells keep the face's own; a rim quad takes the
  // corners of the edge it grows from, so it is a zero-width strip in UV
  // space — as Blender's rim loops, which copy from the face across the edge.

  // Rim: one quad per boundary edge, wound to agree with the face holding it.
  // `[b, a, a', b']` for a directed edge a->b — read off Blender's output.
  const uses = new Map<string, number>();
  for (const poly of data.polys)
    for (let i = 0; i < poly.length; i++) {
      const key = seamKey(poly[i]!, poly[(i + 1) % poly.length]!);
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  data.polys.forEach((poly, f) => {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      if (uses.get(seamKey(a, b)) !== 1) continue;
      polys.push([b, a, a + count, b + count]);
      const j = (i + 1) % poly.length;
      sources.push({ face: f, corners: [j, i, i, j] });
    }
  });

  // Every vertex is there twice; the edges' flags go to both shells, the
  // rim edges get none. Wire edges are not solidified and stay once.
  const source = [...Array.from({ length: count }, (_, v) => v), ...Array.from({ length: count }, (_, v) => v)];
  const vertexLayers = carryVertexLayers({ ...data, edges: undefined }, source);
  onlyEdgesOf(vertexLayers, polys);
  const out: MeshData = {
    positions,
    polys,
    creases: vertexLayers.creases ?? new Map(),
    seams: vertexLayers.seams ?? new Set(),
    ...defined(carryFaceLayers(data, sources)),
  };
  if (vertexLayers.sharp) out.sharp = vertexLayers.sharp;
  if (vertexLayers.groups) out.groups = vertexLayers.groups;
  if (data.edges && data.edges.length > 0) out.edges = data.edges.map((e) => [...e]);
  return out;
}

// ── Bisect ─────────────────────────────────────────────────────────────────

/** Options for {@link bisectPlane}. */
export interface WireframeOptions {
  /** The bar's full thickness — Blender's `thickness`. */
  thickness: number;
  /**
   * Put bars along open edges too — Blender's `use_boundary`. Default true.
   *
   * Off, a border edge gets only the half of its bar that faces the surface,
   * so a grid comes out with its outside edges open. That is Blender's
   * behaviour and it is rarely what a build script wants, hence the default.
   */
  boundary?: boolean;
}

/**
 * Replace every face with a solid frame along its edges — grates, railings,
 * shelving, anything that is "a grid, but made of bars".
 *
 * Blender's `bmesh.ops.wireframe` with `use_replace`, and the construction is
 * measured rather than invented — it was read off a cube and a grid-with-a-hole
 * before a line of this was written:
 *
 *  - each vertex becomes **two** points, `thickness / 2` along its normal
 *    either way
 *  - each *corner of each face* becomes one point, `thickness / 2` along that
 *    corner's bisector, in the face's plane
 *  - each edge becomes four quads per side it has: two reaching the inner
 *    point, two the outer
 *
 * The counts fall out of that and match Blender exactly: a cube gives 40
 * vertices and 48 faces, the grid 110 and 120 with `boundary` off, 130 and 160
 * with it on.
 *
 * **An open side is treated as one more face**, whose corner direction is the
 * negated sum of the real faces' — which is what puts the boundary point
 * outward on a sheet's rim and *into* the gap at the corner of a hole, both
 * measured, with no special case between them.
 *
 * Only `thickness` and `boundary`, and neither of Blender's defaults for
 * the modifier (even thickness on, boundary off): {@link wireframeModifier}
 * is the port of `BM_mesh_wireframe` itself, with every option
 * (compat-backlog B4).
 *
 * **Layers** (compat-backlog A7): each bar quad copies its source face's
 * corner at each vertex's source vertex, and its slot; every new vertex
 * copies its source vertex's groups (`wireframe-layers`). Edge flags do not
 * carry — every edge is new, as in Blender.
 */
export function wireframe(data: MeshData, opts: WireframeOptions): MeshData {
  const half = opts.thickness / 2;
  const withBoundary = opts.boundary ?? true;
  const P = data.positions;
  const at = (v: number): Vec3 => [P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!];

  const faceNormals = data.polys.map((poly) => normalize(newellNormal(P, poly)));

  // Per (face, corner): the in-plane bisector, pointing into the face.
  const bisectors: Vec3[][] = data.polys.map((poly, f) => {
    const n = poly.length;
    return poly.map((v, i) => {
      const p = at(v);
      const d1 = normalize(sub(at(poly[(i - 1 + n) % n]!), p));
      const d2 = normalize(sub(at(poly[(i + 1) % n]!), p));
      const sum: Vec3 = [d1[0] + d2[0], d1[1] + d2[1], d1[2] + d2[2]];
      if (Math.hypot(sum[0], sum[1], sum[2]) > 1e-6) return normalize(sum);
      // A straight corner has no bisector: take the in-plane perpendicular
      // and point it at the face's middle.
      const side = normalize(crossVec(faceNormals[f]!, d2));
      const toCentre = sub(faceCentre(P, poly), p);
      return side[0] * toCentre[0] + side[1] * toCentre[1] + side[2] * toCentre[2] >= 0
        ? side
        : ([-side[0], -side[1], -side[2]] as Vec3);
    });
  });

  // Vertex normals, weighted by the corner angle.
  //
  // Which weighting is not a detail: area weighting matches Blender on a cube
  // and a flat grid — where every weighting agrees — and drifts 4.5mm on the
  // curved production cage, because there the faces meeting at a vertex have
  // different sizes. Corner angle is what BMesh uses.
  const vertexNormal: Vec3[] = Array.from({ length: P.length / 3 }, () => [0, 0, 0] as Vec3);
  data.polys.forEach((poly, f) => {
    const unit = faceNormals[f]!;
    const n = poly.length;
    poly.forEach((v, i) => {
      const p = at(v);
      const d1 = normalize(sub(at(poly[(i - 1 + n) % n]!), p));
      const d2 = normalize(sub(at(poly[(i + 1) % n]!), p));
      const cos = Math.max(-1, Math.min(1, d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2]));
      const w = Math.acos(cos);
      const acc = vertexNormal[v]!;
      vertexNormal[v] = [acc[0] + unit[0] * w, acc[1] + unit[1] * w, acc[2] + unit[2] * w];
    });
  });

  const positions: number[] = [];
  // Every new vertex is a copy of one input vertex (`BM_vert_create` with it
  // as the example), for the vertex groups.
  const vertexSource: number[] = [];
  let from = -1;
  const push = (p: Vec3): number => {
    positions.push(p[0], p[1], p[2]);
    vertexSource.push(from);
    return positions.length / 3 - 1;
  };

  const inner: number[] = [];
  const outer: number[] = [];
  for (let v = 0; v < P.length / 3; v++) {
    const p = at(v);
    const n = normalize(vertexNormal[v]!);
    from = v;
    inner.push(push([p[0] - n[0] * half, p[1] - n[1] * half, p[2] - n[2] * half]));
    outer.push(push([p[0] + n[0] * half, p[1] + n[1] * half, p[2] + n[2] * half]));
  }

  // The corner points, indexed the way the polygons are.
  const corner: number[][] = data.polys.map((poly, f) =>
    poly.map((v, i) => {
      const p = at(v);
      const b = bisectors[f]![i]!;
      from = v;
      return push([p[0] + b[0] * half, p[1] + b[1] * half, p[2] + b[2] * half]);
    }),
  );

  // Which faces run along each edge, and in which direction.
  interface Side { a: number; b: number; point: (v: number) => number; f: number; ia: number; ib: number }
  const sides = new Map<string, Side[]>();
  data.polys.forEach((poly, f) => {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      const key = seamKey(a, b);
      const list = sides.get(key) ?? [];
      const ca = corner[f]![i]!;
      const cb = corner[f]![(i + 1) % poly.length]!;
      list.push({ a, b, point: (v) => (v === a ? ca : cb), f, ia: i, ib: (i + 1) % poly.length });
      sides.set(key, list);
    }
  });

  // An open edge's other side, built from a per-vertex point that exists only
  // when `boundary` is on.
  // The direction is per boundary EDGE, not per vertex: the in-plane
  // perpendicular to that edge, pointing away from the one face it has. A
  // vertex adds up whichever of those it is on.
  //
  // Reading it off the vertex instead — "away from the faces meeting here" —
  // agrees on a flat sheet and is wrong the moment the rim folds: on a cube
  // with its lid off, the rim points straight up in Blender and out along the
  // diagonal that way, 3.9mm apart on a 0.02 bar.
  const openDirection = new Map<number, Vec3>();
  const openPoint = new Map<number, number>();
  if (withBoundary) {
    data.polys.forEach((poly, f) => {
      const n = poly.length;
      const centre = faceCentre(P, poly);
      for (let i = 0; i < n; i++) {
        const a = poly[i]!;
        const b = poly[(i + 1) % n]!;
        if ((sides.get(seamKey(a, b))?.length ?? 0) !== 1) continue;
        const d = normalize(sub(at(b), at(a)));
        let away = normalize(crossVec(d, faceNormals[f]!));
        const mid = at(a);
        const toCentre = sub(centre, mid);
        if (away[0] * toCentre[0] + away[1] * toCentre[1] + away[2] * toCentre[2] > 0)
          away = [-away[0], -away[1], -away[2]];
        for (const v of [a, b]) {
          const acc = openDirection.get(v) ?? ([0, 0, 0] as Vec3);
          openDirection.set(v, [acc[0] + away[0], acc[1] + away[1], acc[2] + away[2]]);
        }
      }
    });
    for (const [v, sum] of openDirection) {
      const away = normalize(sum);
      const p = at(v);
      from = v;
      openPoint.set(
        v,
        push([p[0] + away[0] * half, p[1] + away[1] * half, p[2] + away[2] * half]),
      );
    }
  }

  const polys: number[][] = [];
  // Each quad's corners copy the source face's corner at each vertex's source
  // vertex, and its slot (`BM_elem_attrs_copy` from `l` / `l_next`).
  const sources: FaceSource[] = [];
  for (const [, list] of sides) {
    const all: Side[] = [...list];
    if (withBoundary && list.length === 1) {
      // The virtual face on the other side runs the opposite way round.
      const { a, b, f, ia, ib } = list[0]!;
      all.push({ a: b, b: a, point: (v) => openPoint.get(v)!, f, ia: ib, ib: ia });
    }
    for (const side of all) {
      const pa = side.point(side.a);
      const pb = side.point(side.b);
      polys.push([pa, pb, inner[side.b]!, inner[side.a]!]);
      sources.push({ face: side.f, corners: [side.ia, side.ib, side.ib, side.ia] });
      polys.push([pb, pa, outer[side.a]!, outer[side.b]!]);
      sources.push({ face: side.f, corners: [side.ib, side.ia, side.ia, side.ib] });
    }
  }

  const out: MeshData = { positions: Float32Array.from(positions), polys, ...defined(carryFaceLayers(data, sources)) };
  const groups = carryVertexLayers({ groups: data.groups } as MeshData, vertexSource).groups;
  if (groups) out.groups = groups;
  return out;
}

/** Newell's normal, un-normalised — its length is twice the polygon's area. */
function newellNormal(P: Float32Array, poly: readonly number[]): Vec3 {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]! * 3;
    const b = poly[(i + 1) % poly.length]! * 3;
    nx += (P[a + 1]! - P[b + 1]!) * (P[a + 2]! + P[b + 2]!);
    ny += (P[a + 2]! - P[b + 2]!) * (P[a]! + P[b]!);
    nz += (P[a]! - P[b]!) * (P[a + 1]! + P[b + 1]!);
  }
  return [nx, ny, nz];
}

function faceCentre(P: Float32Array, poly: readonly number[]): Vec3 {
  let x = 0, y = 0, z = 0;
  for (const v of poly) {
    x += P[v * 3]!;
    y += P[v * 3 + 1]!;
    z += P[v * 3 + 2]!;
  }
  const n = poly.length || 1;
  return [x / n, y / n, z / n];
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

export interface BisectPlaneOptions {
  /** A point on the cutting plane — Blender's `plane_co`. */
  planeCo: Vec3;
  /** The plane's normal; need not be unit length — Blender's `plane_no`. */
  planeNo: Vec3;
  /**
   * How close to the plane counts as lying on it — Blender's `dist`. Vertices
   * within this are used as they are rather than cut against, which is what
   * stops a cut passing through an existing vertex making a zero-length sliver.
   */
  dist?: number;
  /** Drop what is on the side the normal points to — Blender's `clear_outer`. */
  clearOuter?: boolean;
  /** Drop what is on the side the normal points away from — `clear_inner`. */
  clearInner?: boolean;
}

/**
 * Cut a mesh with a plane, optionally throwing one side away — Blender's
 * `bmesh.ops.bisect_plane`.
 *
 * Faces the plane crosses are split along it, with the new vertices shared
 * between neighbouring faces so the result stays manifold where the input was.
 *
 * **The hole is not filled.** Clearing a side leaves an open boundary, which
 * is what Blender's operator does too — the Bisect *tool* has a separate
 * "Fill" option that the operator does not. Follow with {@link solidify} for a
 * plate, or cap it yourself.
 *
 * `clearOuter` removes the side the normal points **to**. That was measured,
 * because the two names read equally well either way round.
 *
 * Creases and seams survive, and an edge that gets split passes its sharpness
 * to both halves. Vertices left unused by a cleared side are removed and the
 * indices compacted.
 *
 * **Layers** (compat-backlog A7): all of them. A cut vertex's corners are
 * linear between its edge's two corners in each face, and its vertex groups
 * mix the edge's ends (`BM_edge_split`); the halves of a face keep its
 * corners and slot; sharp edges follow the creases (`bisect-plane-layers`).
 */
export function bisectPlane(data: MeshData, opts: BisectPlaneOptions): MeshData {
  const P = data.positions;
  const [cx, cy, cz] = opts.planeCo;
  let [nx, ny, nz] = opts.planeNo;
  const nlen = Math.hypot(nx, ny, nz);
  if (nlen < 1e-20) throw new Error("bisectPlane: planeNo is zero length");
  nx /= nlen;
  ny /= nlen;
  nz /= nlen;
  const dist = opts.dist ?? 1e-6;

  const count = P.length / 3;
  const positions: number[] = Array.from(P);
  const side = new Int8Array(count);
  for (let v = 0; v < count; v++) {
    const d = (P[v * 3]! - cx) * nx + (P[v * 3 + 1]! - cy) * ny + (P[v * 3 + 2]! - cz) * nz;
    side[v] = d > dist ? 1 : d < -dist ? -1 : 0;
  }
  const signedDist = (v: number): number =>
    (positions[v * 3]! - cx) * nx +
    (positions[v * 3 + 1]! - cy) * ny +
    (positions[v * 3 + 2]! - cz) * nz;

  /** The vertex where edge a-b meets the plane, made once and shared. */
  const cutVerts = new Map<string, number>();
  const cutOn = (a: number, b: number): number => {
    const key = seamKey(a, b);
    const existing = cutVerts.get(key);
    if (existing !== undefined) return existing;
    const da = signedDist(a);
    const db = signedDist(b);
    const t = da / (da - db);
    const index = positions.length / 3;
    for (let k = 0; k < 3; k++)
      positions.push(positions[a * 3 + k]! + (positions[b * 3 + k]! - positions[a * 3 + k]!) * t);
    cutVerts.set(key, index);
    cutAt.set(index, { a, b, t });
    return index;
  };
  /** A cut vertex's edge and how far along it from `a`. */
  const cutAt = new Map<number, { a: number; b: number; t: number }>();
  /** How far along a→b the cut vertex on that edge sits. */
  const along = (a: number, m: number): number => {
    const c = cutAt.get(m)!;
    return c.a === a ? c.t : 1 - c.t;
  };

  const polys: number[][] = [];
  /** Which original edge each half came from, so creases can follow. */
  const splitParent = new Map<string, string>();
  // Per output face, the input face and each corner's source: one of its
  // corners, or a point along one of its edges (`BM_edge_split` interpolates
  // the face's two corners on the edge).
  type Corner = [number] | [number, number, number];
  const faceSrc: { face: number; corners: Corner[] }[] = [];

  data.polys.forEach((poly, f) => {
    let hasPos = false;
    let hasNeg = false;
    for (const v of poly) {
      if (side[v] === 1) hasPos = true;
      else if (side[v] === -1) hasNeg = true;
    }

    if (!hasPos || !hasNeg) {
      // Entirely on one side, or lying in the plane — keep or drop whole.
      const keep = hasPos ? !opts.clearOuter : hasNeg ? !opts.clearInner : true;
      if (keep) {
        polys.push([...poly]);
        faceSrc.push({ face: f, corners: poly.map((_, i) => [i] as Corner) });
      }
      return;
    }

    const above: number[] = [];
    const below: number[] = [];
    const aboveSrc: Corner[] = [];
    const belowSrc: Corner[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      const sa = side[a]!;
      const sb = side[b]!;

      if (sa >= 0) {
        above.push(a);
        aboveSrc.push([i]);
      }
      if (sa <= 0) {
        below.push(a);
        belowSrc.push([i]);
      }

      if (sa !== 0 && sb !== 0 && sa !== sb) {
        const m = cutOn(a, b);
        const src: Corner = [i, (i + 1) % poly.length, along(a, m)];
        above.push(m);
        below.push(m);
        aboveSrc.push(src);
        belowSrc.push(src);
        splitParent.set(seamKey(a, m), seamKey(a, b));
        splitParent.set(seamKey(m, b), seamKey(a, b));
      }
    }

    if (!opts.clearOuter && above.length >= 3) {
      polys.push(above);
      faceSrc.push({ face: f, corners: aboveSrc });
    }
    if (!opts.clearInner && below.length >= 3) {
      polys.push(below);
      faceSrc.push({ face: f, corners: belowSrc });
    }
  });

  // Compact: a cleared side leaves vertices nothing refers to.
  //
  // In index order, not in the order the faces happen to mention them, so a
  // cut that removes nothing returns the mesh with its numbering intact. First
  // use order would renumber an untouched mesh, which reads as a change.
  const used = new Set<number>();
  for (const poly of polys) for (const v of poly) used.add(v);
  const remap = new Int32Array(positions.length / 3).fill(-1);
  const kept: number[] = [];
  for (let v = 0; v < positions.length / 3; v++) {
    if (!used.has(v)) continue;
    remap[v] = kept.length / 3;
    kept.push(positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!);
  }

  const creases = new Map<string, number>();
  const seams = new Set<string>();
  const carry = (key: string, apply: (mapped: string) => void): void => {
    const [a, b] = key.split("_");
    const ma = remap[Number(a)]!;
    const mb = remap[Number(b)]!;
    if (ma >= 0 && mb >= 0 && ma !== mb) apply(seamKey(ma, mb));
  };
  // An edge the cut went through no longer exists as one edge, so its own key
  // must not survive — only the two halves below inherit it. Keeping it would
  // leave a crease on a vertex pair that is no longer joined.
  const wasSplit = new Set(splitParent.values());
  for (const [key, value] of data.creases ?? [])
    if (!wasSplit.has(key)) carry(key, (m) => creases.set(m, value));
  for (const key of data.seams ?? []) if (!wasSplit.has(key)) carry(key, (m) => seams.add(m));
  // A split edge hands its sharpness to both halves.
  for (const [half, parent] of splitParent) {
    const value = data.creases?.get(parent);
    if (value !== undefined) carry(half, (m) => creases.set(m, value));
    if (data.seams?.has(parent)) carry(half, (m) => seams.add(m));
  }

  const out: MeshData = {
    positions: new Float32Array(kept),
    polys: polys.map((poly) => poly.map((v) => remap[v]!)),
    creases,
    seams,
  };

  // The rest of the layers. Sharp edges as creases; wire edges whose ends
  // both survive (one the cut crosses is not split — not measured).
  if (data.sharp) {
    const sharp = new Set<string>();
    for (const key of data.sharp) if (!wasSplit.has(key)) carry(key, (m) => sharp.add(m));
    for (const [half, parent] of splitParent) if (data.sharp.has(parent)) carry(half, (m) => sharp.add(m));
    out.sharp = sharp;
  }
  if (data.edges) {
    const edges = data.edges
      .filter((e) => remap[e[0]!]! >= 0 && remap[e[1]!]! >= 0)
      .map((e) => [remap[e[0]!]!, remap[e[1]!]!]);
    if (edges.length > 0) out.edges = edges;
  }
  const corner = (layer: number[][][] | undefined): number[][][] | undefined =>
    layer && layer.length === data.polys.length
      ? faceSrc.map(({ face, corners }) =>
          corners.map((cn) => {
            const x = layer[face]![cn[0]]!;
            if (cn.length === 1) return [...x];
            const y = layer[face]![cn[1]]!;
            return x.map((v, j) => v + (y[j]! - v) * cn[2]);
          }),
        )
      : undefined;
  const uvs = corner(data.uvs);
  if (uvs) out.uvs = uvs;
  const colors = corner(data.colors);
  if (colors) out.colors = colors;
  const normals = corner(data.normals);
  if (normals) out.normals = normals;
  if (data.materials && data.materials.length === data.polys.length)
    out.materials = faceSrc.map(({ face }) => data.materials![face]!);
  if (data.groups) {
    // A cut vertex mixes its edge's ends (`BM_data_interp_from_verts` —
    // `layerInterp_mdeformvert`: a source counts where its weight times the
    // factor is not zero).
    out.groups = new Map();
    for (const [name, g] of data.groups) {
      const ng = new Map<number, number>();
      for (const [v, w] of g) if (v < count && remap[v]! >= 0) ng.set(remap[v]!, w);
      for (const [m, { a, b, t }] of cutAt) {
        if (remap[m]! < 0) continue;
        let member = false;
        let sum = 0;
        for (const [u, f] of [[a, 1 - t], [b, t]] as const) {
          const x = g.get(u);
          if (x !== undefined && x * f !== 0) {
            member = true;
            sum += x * f;
          }
        }
        if (member) ng.set(remap[m]!, Math.min(sum, 1));
      }
      out.groups.set(name, ng);
    }
  }
  return out;
}

// ── Symmetrize ─────────────────────────────────────────────────────────────

/** Options for {@link symmetrize}. */
export interface SymmetrizeOptions {
  /**
   * Which half to keep, and therefore which way it is copied. Blender's
   * `direction`, spelled exactly as Blender spells it — `'-X'` keeps the
   * negative side, `'X'` keeps the positive one. Measured: there is no `'+X'`,
   * and the two are easy to get backwards from the name alone.
   */
  direction: "-X" | "-Y" | "-Z" | "X" | "Y" | "Z";
  /** Weld distance across the mirror plane. Blender's `dist`. Default 1e-4. */
  dist?: number;
}

/**
 * Make a mesh symmetric by keeping one half and reflecting it — Blender's
 * `bmesh.ops.symmetrize(input=, direction=, dist=)`.
 *
 * Cut at the plane, throw the other side away, mirror what is left, weld the
 * seam. Exactly the three operations it looks like, and it is built from them
 * here — {@link bisectPlane} then {@link mirrorMesh} — so the parity already
 * measured for those carries over.
 *
 * What it is *for* is worth stating: a character modelled loosely on both sides
 * becomes exactly symmetric, and a rig mirrored onto it lands on matching
 * geometry. Modelling one half and symmetrizing is cheaper than keeping two
 * halves in step.
 *
 * **Layers** (compat-backlog A7): all of them, from {@link bisectPlane} and
 * {@link mirrorMesh} — the mirrored half is a copy, UVs not mirrored, as
 * Blender's (`symmetrize-layers`).
 */
export function symmetrize(data: MeshData, opts: SymmetrizeOptions): MeshData {
  const negative = opts.direction.startsWith("-");
  const letter = opts.direction[opts.direction.length - 1]!.toLowerCase() as "x" | "y" | "z";
  const axisIndex = letter === "x" ? 0 : letter === "y" ? 1 : 2;
  const planeNo: Vec3 =
    axisIndex === 0 ? [1, 0, 0] : axisIndex === 1 ? [0, 1, 0] : [0, 0, 1];

  // `clearOuter` drops the side the normal points to, so keeping the negative
  // half means clearing the outer one.
  const half = bisectPlane(data, {
    planeCo: [0, 0, 0],
    planeNo,
    clearOuter: negative,
    clearInner: !negative,
  });

  return mirrorMesh(half, letter, { weld: opts.dist ?? 1e-4 });
}

// ── Convex hull ────────────────────────────────────────────────────────────

/** What {@link convexHull} found. */
export interface ConvexHullReport {
  /** Input points strictly inside the hull, which the result does not contain. */
  interior: number;
  /**
   * True when the points have no volume — all on a line or a plane — so there
   * is no hull to build and the result is empty.
   */
  degenerate: boolean;
}

/**
 * The convex hull of a mesh's vertices — Blender's
 * `bmesh.ops.convex_hull(input=)`.
 *
 * Triangles, wound outward. The obvious use is a collision shape: a physics
 * engine wants the smallest convex solid that contains a prop, and computing
 * it from the render mesh beats authoring it by hand.
 *
 * Differs from Blender in one way worth knowing. `bmesh.ops.convex_hull`
 * mutates the mesh and leaves the interior vertices in it, unused, reporting
 * them in `geom_interior`. A function that returns a mesh has no reason to
 * carry them, so the result holds only the hull's own vertices and the count
 * goes in `report.interior`.
 *
 * The hull is Bullet's `btConvexHullComputer` (ported in `hull/bullet-hull.ts`),
 * which is what Blender calls, and each of its faces is fanned from its first
 * corner as Blender does. The four-points-with-volume search below only
 * decides the degenerate case.
 *
 * **Layers** (compat-backlog A7): a hull triangle that is already an input
 * face keeps it; any other copies the corners of the input faces along its
 * edges (`BM_face_copy_shared`) and takes its example face's slot; vertex
 * groups and edge flags stay with the surviving vertices and edges. Wire
 * edges go (they are not the hull). With the input's faces taken away first,
 * as the parity row does, the corners are zero and the slots 0
 * (`convex-hull-layers`); with them present the rule is Blender's but only
 * measured through that row's companion (`convex-hull-keep-layers`).
 */
export function convexHull(
  data: MeshData,
  report: ConvexHullReport = { interior: 0, degenerate: false },
): MeshData {
  const P = data.positions;
  const n = P.length / 3;
  const at = (i: number): Vec3 => [P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!];
  if (n < 4) {
    report.degenerate = true;
    return { positions: new Float32Array(), polys: [] };
  }

  // Scale the tolerance to the cloud, or a millimetre-sized prop and a
  // kilometre-sized one cannot both be right.
  let extent = 0;
  const lo: number[] = [...at(0)];
  const hi: number[] = [...at(0)];
  for (let i = 1; i < n; i++) {
    const p = at(i);
    for (let k = 0; k < 3; k++) {
      if (p[k]! < lo[k]!) lo[k] = p[k]!;
      if (p[k]! > hi[k]!) hi[k] = p[k]!;
    }
  }
  for (let k = 0; k < 3; k++) extent = Math.max(extent, hi[k]! - lo[k]!);
  const eps = Math.max(extent, 1) * 1e-9;

  const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  // Four points with volume between them. Taking the first four in order fails
  // the moment a mesh starts with a flat face, which most do.
  let i0 = 0;
  let i1 = -1;
  for (let i = 1; i < n && i1 < 0; i++)
    if (Math.hypot(...sub(at(i), at(i0))) > eps) i1 = i;
  if (i1 < 0) {
    report.degenerate = true;
    return { positions: new Float32Array(), polys: [] };
  }
  let i2 = -1;
  for (let i = 0; i < n && i2 < 0; i++) {
    if (i === i0 || i === i1) continue;
    if (Math.hypot(...cross(sub(at(i1), at(i0)), sub(at(i), at(i0)))) > eps) i2 = i;
  }
  if (i2 < 0) {
    report.degenerate = true;
    return { positions: new Float32Array(), polys: [] };
  }
  const base = cross(sub(at(i1), at(i0)), sub(at(i2), at(i0)));
  let i3 = -1;
  let best = eps;
  for (let i = 0; i < n; i++) {
    if (i === i0 || i === i1 || i === i2) continue;
    const d = Math.abs(dot(base, sub(at(i), at(i0))));
    if (d > best) {
      best = d;
      i3 = i;
    }
  }
  if (i3 < 0) {
    report.degenerate = true;
    return { positions: new Float32Array(), polys: [] };
  }

  // The hull itself is Bullet's (`btConvexHullComputer`, ported), as
  // Blender's `bmesh.ops.convex_hull` calls it: points on the hull's surface
  // but not at a corner — nearly coplanar ones — are kept or dropped by
  // Bullet's integer grid, and an incremental hull with a tolerance of its
  // own disagreed there (`character`: 420 vertices against 418, measured).
  const hull = bulletConvexHull(Array.from({ length: n }, (_, i) => at(i).map(Math.fround)));
  const used = new Set<number>();
  const tris: [number, number, number][] = [];
  const seen = new Set<string>();
  for (const face of hull.faces) {
    if (face.length < 3) continue;
    // Blender fans each of Bullet's faces from its first corner.
    const fv = face.map((k) => hull.originalIndex[k]!);
    for (let j = 2; j < fv.length; j++) {
      const t: [number, number, number] = [fv[0]!, fv[j - 1]!, fv[j]!];
      const key = [...t].sort((a, b) => a - b).join(",");
      if (seen.has(key)) continue; // `BM_face_exists`
      seen.add(key);
      tris.push(t);
      for (const v of t) used.add(v);
    }
  }

  // Keep only the vertices the hull uses, in input order.
  const remap = new Map<number, number>();
  const source: number[] = [];
  const positions: number[] = [];
  for (let v = 0; v < n; v++)
    if (used.has(v)) {
      remap.set(v, remap.size);
      source.push(v);
      positions.push(P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!);
    }

  // The corners, as `hull_output_triangles` sets them. A triangle that is
  // already an input face is that face, its corners and all. Otherwise each
  // of its edges that has faces copies the corners at both ends, the first
  // write winning from the triangle's first corner (`BM_face_copy_shared`):
  // from the oldest input face on the edge (`radial_next` of the new loop),
  // or — on an edge only the hull made — from the hull triangle made before
  // it there. The face's slot is the example's: the newest input face on the
  // triangle's first edge that has one (`hull_find_example_face`).
  const key = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const inputFaces = new Map<string, number[]>();
  const existing = new Map<string, number>();
  data.polys.forEach((p, f) => {
    for (let i = 0; i < p.length; i++) {
      const k = key(p[i]!, p[(i + 1) % p.length]!);
      (inputFaces.get(k) ?? inputFaces.set(k, []).get(k)!).push(f);
    }
    if (p.length === 3) existing.set([...p].sort((a, b) => a - b).join(","), f);
  });
  type Corner = { face: number; corner: number } | { hull: number; corner: number } | null;
  const hullOn = new Map<string, number>();
  const corners: Corner[][] = [];
  const outTris: number[][] = [];
  const material: number[] = [];
  tris.forEach((t, h) => {
    const same = existing.get([...t].sort((a, b) => a - b).join(","));
    if (same !== undefined) {
      const p = data.polys[same]!;
      outTris.push([...p]);
      corners.push(p.map((_, i) => ({ face: same, corner: i })));
      material.push(same);
    } else {
      outTris.push(t);
      const c: Corner[] = [null, null, null];
      let example = -1;
      for (let i = 0; i < 3; i++) {
        const a = t[i]!;
        const b = t[(i + 1) % 3]!;
        const faces = inputFaces.get(key(a, b));
        // `BM_FACES_OF_EDGE` starts at `e->l`, the newest loop: the newest
        // input face, unless a hull triangle already sits there — it is
        // skipped, and its `radial_next` is the oldest.
        if (example < 0 && faces) example = hullOn.has(key(a, b)) ? faces[0]! : faces[faces.length - 1]!;
        for (const [j, v] of [[i, a], [(i + 1) % 3, b]] as const) {
          if (c[j]) continue;
          if (faces) c[j] = { face: faces[0]!, corner: data.polys[faces[0]!]!.indexOf(v) };
          else {
            const prev = hullOn.get(key(a, b));
            if (prev !== undefined) c[j] = { hull: prev, corner: outTris[prev]!.indexOf(v) };
          }
        }
      }
      corners.push(c);
      material.push(example);
    }
    for (let i = 0; i < 3; i++) {
      const k = key(outTris[h]![i]!, outTris[h]![(i + 1) % 3]!);
      if (!hullOn.has(k)) hullOn.set(k, h);
    }
  });

  const polys = outTris.map((t) => t.map((v) => remap.get(v)!));
  const out: MeshData = { positions: new Float32Array(positions), polys };
  // A corner nothing was copied to holds the layer's default: 0, and white
  // for a colour (`layerDefault_mloopcol`).
  const layer = (src: number[][][] | undefined, blank: number, width0: number): number[][][] | undefined => {
    if (!src || src.length !== data.polys.length) return undefined;
    const width = src.find((f) => f.length > 0)?.[0]?.length ?? width0;
    const done: number[][][] = [];
    corners.forEach((cs) => {
      done.push(
        cs.map((c) =>
          !c ? new Array<number>(width).fill(blank) : "face" in c ? [...src[c.face]![c.corner]!] : [...done[c.hull]![c.corner]!],
        ),
      );
    });
    return done;
  };
  const uvs = layer(data.uvs, 0, 2);
  if (uvs) out.uvs = uvs;
  const colors = layer(data.colors, 1, 4);
  if (colors) out.colors = colors;
  const normals = layer(data.normals, 0, 3);
  if (normals) out.normals = normals;
  if (data.materials && data.materials.length === data.polys.length)
    out.materials = material.map((f) => (f < 0 ? 0 : data.materials![f]!));
  const vertexLayers = carryVertexLayers({ ...data, edges: undefined }, source);
  if (vertexLayers.groups) out.groups = vertexLayers.groups;
  // The hull's edges are made with `BM_CREATE_NO_DOUBLE`: an input edge it
  // runs along is that edge, flags and all.
  onlyEdgesOf(vertexLayers, polys);
  if (vertexLayers.creases) out.creases = vertexLayers.creases;
  if (vertexLayers.seams) out.seams = vertexLayers.seams;
  if (vertexLayers.sharp) out.sharp = vertexLayers.sharp;
  report.interior = n - remap.size;
  report.degenerate = polys.length === 0;
  return out;
}

export interface MaskOptions {
  /**
   * A vertex is kept when its weight is **strictly above** this. Default 0.5,
   * Blender's. Strictly: a weight of exactly 0.5 against a threshold of 0.5 is
   * dropped, measured.
   */
  threshold?: number;
  /**
   * Flip the test — keep what the weights do *not* select. Blender's
   * `invert_vertex_group`.
   *
   * **It inverts the test, not the weight.** Measured: four vertices at weight
   * 0.6 against a threshold of 0.3, inverted, all disappear. Had it inverted
   * the weight they would have stayed, because 1 − 0.6 is still above 0.3.
   */
  invert?: boolean;
}

/**
 * Keep the part of a mesh its weights select — Blender's **Mask** modifier.
 *
 * The cheap way to take a mesh apart along something other than its connected
 * pieces: keep the faces above a line, drop the half a mirror is about to
 * replace, cut a generated room down to the wall a screenshot needs.
 * {@link separateLoose} splits by what is joined to what; this splits by what
 * the caller says.
 *
 * `weights` is either a `Set` of vertices — every one of them weight 1, which
 * is what a selection means — or a `Map` from vertex to weight, which is what
 * a Blender vertex group is. A vertex not mentioned has weight 0.
 *
 * ## The two rules, measured
 *
 * - **A polygon survives only when every one of its vertices does.** Three
 *   corners of a quad in the group is not enough; the quad goes.
 * - **A kept vertex stays even when no polygon uses it.** Masking the middle
 *   of a sheet leaves its rim behind as loose vertices. Follow with
 *   {@link deleteLoose} if that is not wanted — Blender does not do it either.
 *
 * Vertices come back in their original order, renumbered, with creases and
 * seams carried through.
 */
export function maskMesh(
  data: MeshData,
  weights: ReadonlySet<number> | ReadonlyMap<number, number>,
  opts: MaskOptions = {},
): MeshData {
  const threshold = opts.threshold ?? 0.5;
  const invert = opts.invert ?? false;
  const weightOf = (v: number): number =>
    weights instanceof Map ? (weights.get(v) ?? 0) : weights.has(v) ? 1 : 0;

  const keep = new Set<number>();
  for (let v = 0; v < data.positions.length / 3; v++)
    if ((weightOf(v) > threshold) !== invert) keep.add(v);

  return compactMesh(data, keep);
}

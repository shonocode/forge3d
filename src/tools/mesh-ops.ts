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
import type { MeshData } from "../lib/mesh";
import { seamKey } from "./edit-mode/half-edge";
import { compactMesh } from "./mesh-repair";
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
 */
export function mergeMeshes(parts: readonly MeshData[]): MeshData {
  let total = 0;
  for (const p of parts) total += p.positions.length;
  const positions = new Float32Array(total);

  const polys: number[][] = [];
  const creases = new Map<string, number>();
  const seams = new Set<string>();
  let cursor = 0;

  for (const part of parts) {
    const base = cursor / 3;
    positions.set(part.positions, cursor);
    cursor += part.positions.length;
    for (const poly of part.polys) polys.push(poly.map((v) => v + base));
    remapKeys(part.creases, base, (k, v) => creases.set(k, v));
    remapKeys(part.seams, base, (k) => seams.add(k));
  }

  return { positions, polys, creases, seams };
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
  return {
    positions: out,
    polys: flipped ? data.polys.map((p) => [...p].reverse()) : data.polys.map((p) => [...p]),
    creases: data.creases ? new Map(data.creases) : undefined,
    seams: data.seams ? new Set(data.seams) : undefined,
  };
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

/** Reflect a mesh across an axis-aligned plane. */
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

/** Repeat a mesh `count` times, each copy shifted by `offset` from the last. */
export function arrayMesh(data: MeshData, count: number, offset: Vec3): MeshData {
  const parts: MeshData[] = [];
  for (let i = 0; i < count; i++)
    parts.push(
      i === 0
        ? data
        : transformMesh(data, { translate: [offset[0] * i, offset[1] * i, offset[2] * i] }),
    );
  return mergeMeshes(parts);
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
  if (angle === 0) return { ...data, polys: data.polys.map((p) => [...p]) };
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
  return {
    positions: out,
    polys: data.polys.map((p) => [...p]),
    creases: data.creases ? new Map(data.creases) : undefined,
    seams: data.seams ? new Set(data.seams) : undefined,
  };
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
  return {
    positions: out,
    polys: data.polys.map((p) => [...p]),
    creases: data.creases ? new Map(data.creases) : undefined,
    seams: data.seams ? new Set(data.seams) : undefined,
  };
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

  const polys: number[][] = [];
  for (const poly of data.polys) {
    const ring: number[] = [];
    for (const v of poly) {
      const m = remap[v]!;
      if (ring[ring.length - 1] !== m) ring.push(m);
    }
    while (ring.length > 1 && ring[0] === ring[ring.length - 1]) ring.pop();
    if (ring.length >= 3) polys.push(ring);
  }

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

  return { positions: new Float32Array(positions), polys, creases, seams };
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
  for (const poly of data.polys) polys.push([...poly]);
  // The offset copy faces the other way, so its winding is reversed.
  for (const poly of data.polys) polys.push([...poly].reverse().map((v) => v + count));

  // Rim: one quad per boundary edge, wound to agree with the face holding it.
  // `[b, a, a', b']` for a directed edge a->b — read off Blender's output.
  const uses = new Map<string, number>();
  for (const poly of data.polys)
    for (let i = 0; i < poly.length; i++) {
      const key = seamKey(poly[i]!, poly[(i + 1) % poly.length]!);
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  for (const poly of data.polys)
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      if (uses.get(seamKey(a, b)) !== 1) continue;
      polys.push([b, a, a + count, b + count]);
    }

  const creases = new Map<string, number>();
  const seams = new Set<string>();
  for (const [key, value] of data.creases ?? []) {
    const [a, b] = key.split("_");
    creases.set(key, value);
    creases.set(seamKey(Number(a) + count, Number(b) + count), value);
  }
  for (const key of data.seams ?? []) {
    const [a, b] = key.split("_");
    seams.add(key);
    seams.add(seamKey(Number(a) + count, Number(b) + count));
  }

  return { positions, polys, creases, seams };
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
 * Not implemented, and refused rather than approximated: Blender's
 * `use_even_offset` (measured to move every point — at a right angle it is the
 * difference between `t/2` along the bisector and `t/2` perpendicular),
 * `offset` (sliding the bar off the edge) and `use_crease`. Concave corners
 * are untested: the bisector points out of the face there, as it does for
 * `inset`.
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
  const push = (p: Vec3): number => {
    positions.push(p[0], p[1], p[2]);
    return positions.length / 3 - 1;
  };

  const inner: number[] = [];
  const outer: number[] = [];
  for (let v = 0; v < P.length / 3; v++) {
    const p = at(v);
    const n = normalize(vertexNormal[v]!);
    inner.push(push([p[0] - n[0] * half, p[1] - n[1] * half, p[2] - n[2] * half]));
    outer.push(push([p[0] + n[0] * half, p[1] + n[1] * half, p[2] + n[2] * half]));
  }

  // The corner points, indexed the way the polygons are.
  const corner: number[][] = data.polys.map((poly, f) =>
    poly.map((v, i) => {
      const p = at(v);
      const b = bisectors[f]![i]!;
      return push([p[0] + b[0] * half, p[1] + b[1] * half, p[2] + b[2] * half]);
    }),
  );

  // Which faces run along each edge, and in which direction.
  interface Side { a: number; b: number; point: (v: number) => number }
  const sides = new Map<string, Side[]>();
  data.polys.forEach((poly, f) => {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      const key = seamKey(a, b);
      const list = sides.get(key) ?? [];
      const ca = corner[f]![i]!;
      const cb = corner[f]![(i + 1) % poly.length]!;
      list.push({ a, b, point: (v) => (v === a ? ca : cb) });
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
      openPoint.set(
        v,
        push([p[0] + away[0] * half, p[1] + away[1] * half, p[2] + away[2] * half]),
      );
    }
  }

  const polys: number[][] = [];
  for (const [, list] of sides) {
    const all: Side[] = [...list];
    if (withBoundary && list.length === 1) {
      // The virtual face on the other side runs the opposite way round.
      const { a, b } = list[0]!;
      all.push({ a: b, b: a, point: (v) => openPoint.get(v)! });
    }
    for (const side of all) {
      const pa = side.point(side.a);
      const pb = side.point(side.b);
      polys.push([pa, pb, inner[side.b]!, inner[side.a]!]);
      polys.push([pb, pa, outer[side.a]!, outer[side.b]!]);
    }
  }

  return { positions: Float32Array.from(positions), polys };
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
    return index;
  };

  const polys: number[][] = [];
  /** Which original edge each half came from, so creases can follow. */
  const splitParent = new Map<string, string>();

  for (const poly of data.polys) {
    let hasPos = false;
    let hasNeg = false;
    for (const v of poly) {
      if (side[v] === 1) hasPos = true;
      else if (side[v] === -1) hasNeg = true;
    }

    if (!hasPos || !hasNeg) {
      // Entirely on one side, or lying in the plane — keep or drop whole.
      const keep = hasPos ? !opts.clearOuter : hasNeg ? !opts.clearInner : true;
      if (keep) polys.push([...poly]);
      continue;
    }

    const above: number[] = [];
    const below: number[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      const sa = side[a]!;
      const sb = side[b]!;

      if (sa >= 0) above.push(a);
      if (sa <= 0) below.push(a);

      if (sa !== 0 && sb !== 0 && sa !== sb) {
        const m = cutOn(a, b);
        above.push(m);
        below.push(m);
        splitParent.set(seamKey(a, m), seamKey(a, b));
        splitParent.set(seamKey(m, b), seamKey(a, b));
      }
    }

    if (!opts.clearOuter && above.length >= 3) polys.push(above);
    if (!opts.clearInner && below.length >= 3) polys.push(below);
  }

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

  return {
    positions: new Float32Array(kept),
    polys: polys.map((poly) => poly.map((v) => remap[v]!)),
    creases,
    seams,
  };
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
  const positions: number[] = [];
  for (let v = 0; v < n; v++)
    if (used.has(v)) {
      remap.set(v, remap.size);
      positions.push(P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!);
    }
  const polys = tris.map((t) => t.map((v) => remap.get(v)!));
  report.interior = n - remap.size;
  report.degenerate = polys.length === 0;
  return { positions: new Float32Array(positions), polys };
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

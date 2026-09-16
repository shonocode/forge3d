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
import type { Vec3 } from "./generate";

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

/**
 * Fuse vertices that coincide, rewriting polygons to the survivors.
 *
 * Faces that collapse to fewer than three distinct vertices are dropped —
 * that is the intended outcome when welding closes a seam.
 */
export function weldMesh(data: MeshData, tolerance = 1e-4): MeshData {
  const inv = 1 / Math.max(tolerance, 1e-9);
  const index = new Map<string, number>();
  const remap = new Int32Array(data.positions.length / 3);
  const positions: number[] = [];

  for (let v = 0; v < remap.length; v++) {
    const x = data.positions[v * 3]!;
    const y = data.positions[v * 3 + 1]!;
    const z = data.positions[v * 3 + 2]!;
    const key = `${Math.round(x * inv)},${Math.round(y * inv)},${Math.round(z * inv)}`;
    const hit = index.get(key);
    if (hit !== undefined) {
      remap[v] = hit;
    } else {
      const id = positions.length / 3;
      positions.push(x, y, z);
      index.set(key, id);
      remap[v] = id;
    }
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
 * a shell factor.
 *
 * Both halves are Blender's, and both were measured off `bmesh.ops.solidify`
 * rather than assumed — an offset of plain `normal * thickness` came out 12-15%
 * short on curved surfaces.
 *
 * - The normal is **angle-weighted**: each face contributes in proportion to
 *   the corner angle it turns through at that vertex, not its area and not
 *   equally. Area weighting is 5x worse here, measured.
 * - The shell factor is Blender's `BM_vert_calc_shell_factor` — the
 *   angle-weighted mean of `1 / |n · n_face|`. It is what makes the thickness
 *   *even*: without it a cube corner moves `thickness` along its diagonal and
 *   each of the three faces ends up only `thickness/sqrt(3)` thick. With it,
 *   every adjacent face is displaced by exactly `thickness`.
 */
function offsetBasis(data: MeshData): { normals: Float32Array; shell: Float64Array } {
  const P = data.positions;
  const count = P.length / 3;
  const normals = new Float32Array(P.length);
  const faceNormals: Array<[number, number, number]> = [];

  for (const poly of data.polys) {
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
    const len = Math.hypot(nx, ny, nz) || 1;
    faceNormals.push([nx / len, ny / len, nz / len]);
  }

  /** The angle the polygon turns through at its `i`th vertex. */
  const cornerAngle = (poly: readonly number[], i: number): number => {
    const v = poly[i]! * 3;
    const prev = poly[(i + poly.length - 1) % poly.length]! * 3;
    const next = poly[(i + 1) % poly.length]! * 3;
    const ax = P[prev]! - P[v]!;
    const ay = P[prev + 1]! - P[v + 1]!;
    const az = P[prev + 2]! - P[v + 2]!;
    const bx = P[next]! - P[v]!;
    const by = P[next + 1]! - P[v + 1]!;
    const bz = P[next + 2]! - P[v + 2]!;
    const la = Math.hypot(ax, ay, az);
    const lb = Math.hypot(bx, by, bz);
    if (la < 1e-20 || lb < 1e-20) return 0;
    const cos = (ax * bx + ay * by + az * bz) / (la * lb);
    return Math.acos(Math.max(-1, Math.min(1, cos)));
  };

  for (let f = 0; f < data.polys.length; f++) {
    const poly = data.polys[f]!;
    const [nx, ny, nz] = faceNormals[f]!;
    for (let i = 0; i < poly.length; i++) {
      const v = poly[i]!;
      const w = cornerAngle(poly, i);
      normals[v * 3] = normals[v * 3]! + nx * w;
      normals[v * 3 + 1] = normals[v * 3 + 1]! + ny * w;
      normals[v * 3 + 2] = normals[v * 3 + 2]! + nz * w;
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i]!, normals[i + 1]!, normals[i + 2]!);
    if (len > 1e-20) {
      normals[i] = normals[i]! / len;
      normals[i + 1] = normals[i + 1]! / len;
      normals[i + 2] = normals[i + 2]! / len;
    }
  }

  const num = new Float64Array(count);
  const den = new Float64Array(count);
  for (let f = 0; f < data.polys.length; f++) {
    const poly = data.polys[f]!;
    const [nx, ny, nz] = faceNormals[f]!;
    for (let i = 0; i < poly.length; i++) {
      const v = poly[i]!;
      const w = cornerAngle(poly, i);
      const dot = Math.abs(normals[v * 3]! * nx + normals[v * 3 + 1]! * ny + normals[v * 3 + 2]! * nz);
      num[v] = num[v]! + (dot > 1e-6 ? 1 / dot : 1) * w;
      den[v] = den[v]! + w;
    }
  }
  const shell = new Float64Array(count);
  for (let v = 0; v < count; v++) shell[v] = den[v]! > 1e-12 ? num[v]! / den[v]! : 1;

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
 * identical to Blender at 0.0000 mm on flat and right-angled input, closed or
 * open — vertex count, face count, area and volume all match to six digits. On
 * a *curved* closed surface the two drift: 0.79 mm mean on the 36-vertex arm
 * cage, 0.2% of its volume. The size is right (the shell factor agrees to
 * 0.09%); the direction differs by up to 0.84°, and Blender's own pre-operation
 * vertex normal does not explain where it moved either, so the remaining
 * difference is not simply a choice of normal weighting. Unresolved.
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

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

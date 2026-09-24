/**
 * Blender's Remesh modifier in its three dual-contouring modes — Blocks,
 * Smooth and Sharp — on top of the `intern/dualcon` port (`dualcon.ts`).
 *
 * `MOD_remesh.cc` hands dualcon the mesh's triangles (`corner_tris`: quads
 * split by the same rule as everywhere else in Blender, larger polygons by
 * `BLI_polyfill_calc`), its bounding box, and the modifier's settings, and
 * gets back a quad mesh. The Voxel mode is OpenVDB and is not here.
 */
import type { MeshData } from "../../lib/mesh";
import { triangulate } from "../boolean/intersect";
import { Octree, type DualConMode } from "./dualcon";

export type RemeshMode = "blocks" | "smooth" | "sharp";

export interface RemeshOptions {
  /** Blocks (cell centres), Smooth (mass point of the crossings) or Sharp (QEF). */
  mode: RemeshMode;
  /** Octree depth: the grid is 2^depth cells across. Blender's default 4. */
  octreeDepth?: number;
  /** How much of the grid the mesh fills (Blender's `scale`, default 0.9). */
  scale?: number;
  /** Sharp mode: how far the vertex may leave its cell (Blender's `sharpness`, default 1). */
  sharpness?: number;
  /** Remove pieces smaller than `threshold` × the largest (Blender default on, 1.0). */
  removeDisconnected?: boolean;
  threshold?: number;
}

const f = Math.fround;

/**
 * Remesh `data` into quads on an octree grid.
 *
 * ```ts
 * remesh(mesh, { mode: "smooth", octreeDepth: 5 });
 * ```
 */
export function remesh(data: MeshData, options: RemeshOptions): MeshData {
  const depth = options.octreeDepth ?? 4;
  const scale = f(options.scale ?? 0.9);
  if (scale === 0) throw new Error("remesh: zero scale cannot be solved");
  const P = data.positions;

  // `corner_tris`, in face order.
  const tris: number[][][] = [];
  for (const poly of data.polys)
    for (const [ids] of triangulate(poly, P)) tris.push(ids.map((v) => [P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!].map(f)));

  // `bounds_min_max`, then `DualConInputReader::reset`, in float.
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i * 3 < P.length; i++)
    for (let k = 0; k < 3; k++) {
      const c = f(P[i * 3 + k]!);
      min[k] = Math.min(min[k]!, c);
      max[k] = Math.max(max[k]!, c);
    }
  let maxsize = 0;
  for (let i = 0; i < 3; i++) maxsize = Math.max(f(max[i]! - min[i]!), maxsize);
  for (let i = 0; i < 3; i++) {
    min[i] = f(f(f(max[i]! + min[i]!) / 2) - f(maxsize / 2));
    // Blender's own order: the new `min` feeds the new `max`.
    max[i] = f(f(f(max[i]! + min[i]!) / 2) + f(maxsize / 2));
  }
  const inv = f(1 / scale);
  for (let i = 0; i < 3; i++) min[i] = f(min[i]! - f(f(maxsize * f(inv - 1)) / 2));
  maxsize = f(maxsize * inv);

  const mode: DualConMode = options.mode === "blocks" ? "centroid" : options.mode === "smooth" ? "masspoint" : "sharp";
  const octree = new Octree(
    min,
    maxsize,
    depth,
    mode,
    options.removeDisconnected ?? true,
    options.threshold ?? 1,
    options.sharpness ?? 1,
  );
  const out = octree.run(tris);
  return { positions: Float32Array.from(out.positions), polys: out.quads.map((q) => [...q]) };
}

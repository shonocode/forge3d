/**
 * Per-face-corner data — UVs and vertex colours — and the operators that
 * permute it.
 *
 * A "loop" in Blender is one corner of one face: a quad has four. Storing a UV
 * per loop rather than per vertex is what makes a seam possible at all, since
 * two faces meeting at an edge can then disagree about the UV along it.
 * `MeshData` had no such place, which blocked eight `bmesh.ops` together and
 * kept the compatibility matrix at 60/80.
 *
 * **They were not one problem.** Measured, four of the eight are a permutation
 * of each face's own loop list and need nothing but somewhere to put the
 * values; the other four move data between faces and are a different job. This
 * file is the four.
 *
 * Pure and headless. These take and return {@link MeshData}.
 *
 * ## The layer, and why it is shaped like this
 *
 * `uvs[f][i]` is the UV at corner `i` of polygon `f` — the same nesting as
 * `polys`, so a corner and its coordinate are always found the same way and
 * an operator that rebuilds `polys` cannot silently leave the layer behind
 * pointing at the old arity. Colours are `[r, g, b, a]` in the same shape.
 */
import type { MeshData } from "../../lib/mesh";

/** Which layer an operator works on. Blender has a separate op per layer. */
export type LoopLayer = "uv" | "color";

function layerOf(data: MeshData, layer: LoopLayer): number[][][] | undefined {
  return layer === "uv" ? data.uvs : data.colors;
}

function withLayer(data: MeshData, layer: LoopLayer, value: number[][][]): MeshData {
  const base: MeshData = {
    positions: new Float32Array(data.positions),
    polys: data.polys.map((p) => [...p]),
    ...(data.creases ? { creases: new Map(data.creases) } : {}),
    ...(data.seams ? { seams: new Set(data.seams) } : {}),
    ...(data.edges ? { edges: data.edges.map((e) => [...e]) } : {}),
    ...(data.uvs ? { uvs: data.uvs.map((f) => f.map((c) => [...c])) } : {}),
    ...(data.colors ? { colors: data.colors.map((f) => f.map((c) => [...c])) } : {}),
  };
  if (layer === "uv") base.uvs = value;
  else base.colors = value;
  return base;
}

function requireLayer(data: MeshData, layer: LoopLayer, who: string): number[][][] {
  const found = layerOf(data, layer);
  if (found === undefined)
    throw new Error(`${who}: this mesh has no ${layer} layer — there is nothing to move.`);
  if (found.length !== data.polys.length)
    throw new Error(
      `${who}: the ${layer} layer has ${found.length} entries for ` +
        `${data.polys.length} polygons. One per polygon, each as long as its ` +
        `polygon.`,
    );
  for (let f = 0; f < data.polys.length; f++)
    if (found[f]!.length !== data.polys[f]!.length)
      throw new Error(
        `${who}: polygon ${f} has ${data.polys[f]!.length} corners but its ` +
          `${layer} entry has ${found[f]!.length}.`,
      );
  return found;
}

/**
 * Reverse each chosen face's loop data — Blender's `reverse_uvs` and
 * `reverse_colors`.
 *
 * The cheap fix for a face whose texture reads mirrored: its corners keep
 * their positions and their coordinates run the other way round.
 *
 * Measured on a quad whose corners carried 0.0, 0.1, 0.2, 0.3 — they come back
 * 0.3, 0.2, 0.1, 0.0, and a face that was not chosen is untouched. The colour
 * operator does the same thing to the colour layer and leaves the UVs alone;
 * that symmetry was checked rather than assumed.
 */
export function reverseLoopData(
  data: MeshData,
  faces: ReadonlySet<number> | readonly number[],
  layer: LoopLayer = "uv",
): MeshData {
  const chosen = new Set(faces);
  const current = requireLayer(data, layer, "reverseLoopData");
  const next = current.map((corners, f) =>
    chosen.has(f) ? [...corners].reverse().map((c) => [...c]) : corners.map((c) => [...c]),
  );
  return withLayer(data, layer, next);
}

/**
 * Rotate each chosen face's loop data by one corner — Blender's `rotate_uvs`
 * and `rotate_colors`.
 *
 * What you reach for when a tiled texture is a quarter-turn out on one face.
 *
 * `ccw` is Blender's `use_ccw` and it is the **direction the data moves**, not
 * the direction it comes from. Measured on 0.0, 0.1, 0.2, 0.3:
 *
 * | | result |
 * |---|---|
 * | `ccw: false` (the default) | 0.3, 0.0, 0.1, 0.2 — each corner takes its predecessor's |
 * | `ccw: true` | 0.1, 0.2, 0.3, 0.0 — each corner takes its successor's |
 *
 * Confirmed on a triangle as well, in case four corners were hiding a
 * symmetry: 0.0, 0.1, 0.2 goes to 0.2, 0.0, 0.1 and to 0.1, 0.2, 0.0.
 */
export function rotateLoopData(
  data: MeshData,
  faces: ReadonlySet<number> | readonly number[],
  opts: { ccw?: boolean; layer?: LoopLayer } = {},
): MeshData {
  const ccw = opts.ccw ?? false;
  const layer = opts.layer ?? "uv";
  const chosen = new Set(faces);
  const current = requireLayer(data, layer, "rotateLoopData");

  const next = current.map((corners, f) => {
    if (!chosen.has(f) || corners.length < 2) return corners.map((c) => [...c]);
    const n = corners.length;
    return corners.map((_, i) => [...corners[ccw ? (i + 1) % n : (i + n - 1) % n]!]);
  });
  return withLayer(data, layer, next);
}

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

/** Every (face, corner) that sits on vertex `v`. */
function cornersAt(data: MeshData, v: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let f = 0; f < data.polys.length; f++) {
    const poly = data.polys[f]!;
    for (let i = 0; i < poly.length; i++) if (poly[i] === v) out.push([f, i]);
  }
  return out;
}

/** Component-wise mean of some corner values. */
function meanOf(values: readonly (readonly number[])[]): number[] {
  const width = values[0]!.length;
  const out = new Array<number>(width).fill(0);
  for (const value of values) for (let k = 0; k < width; k++) out[k]! += value[k]!;
  return out.map((x) => x / values.length);
}

/** Component-wise midpoint of the range — **not** the mean. */
function midpointOf(values: readonly (readonly number[])[]): number[] {
  const width = values[0]!.length;
  const lo = [...values[0]!];
  const hi = [...values[0]!];
  for (const value of values)
    for (let k = 0; k < width; k++) {
      if (value[k]! < lo[k]!) lo[k] = value[k]!;
      if (value[k]! > hi[k]!) hi[k] = value[k]!;
    }
  return lo.map((x, k) => (x + hi[k]!) / 2);
}

/**
 * Flatten the seam along an edge — Blender's `collapse_uvs`.
 *
 * Within **each face** using the edge, its two corners on that edge are set to
 * their mean. The two faces are not brought together: a seam across the edge
 * survives, and what goes is the variation *along* it.
 *
 * Measured on a 2×2 grid of quads. For the shared edge 1-4, the face holding
 * 0.10 and 0.20 there comes back holding 0.15 twice, and the face holding
 * 1.00 and 1.30 comes back holding 1.15 twice — each face averaged its own
 * pair, and neither took anything from the other.
 *
 * `edges` are vertex pairs; order within a pair does not matter.
 */
export function collapseLoopData(
  data: MeshData,
  edges: readonly (readonly number[])[],
  layer: LoopLayer = "uv",
): MeshData {
  const current = requireLayer(data, layer, "collapseLoopData");
  const next = current.map((corners) => corners.map((c) => [...c]));

  for (const edge of edges) {
    const [a, b] = edge as [number, number];
    for (let f = 0; f < data.polys.length; f++) {
      const poly = data.polys[f]!;
      const ia = poly.indexOf(a);
      const ib = poly.indexOf(b);
      if (ia < 0 || ib < 0) continue;
      // Only when they really are neighbours around this face, or a diagonal
      // would count as an edge of it.
      const n = poly.length;
      if ((ia + 1) % n !== ib && (ib + 1) % n !== ia) continue;
      const mid = meanOf([next[f]![ia]!, next[f]![ib]!]);
      next[f]![ia] = [...mid];
      next[f]![ib] = [...mid];
    }
  }
  return withLayer(data, layer, next);
}

/**
 * Give every corner at the chosen vertices one value, taken from `snap` —
 * Blender's `pointmerge_facedata`.
 *
 * The value is the **mean** of the corners at `snap` alone, and it is written
 * to every corner at every vertex in `verts`. What the other vertices held
 * does not enter the average; they are written over.
 *
 * Measured: on a 2×2 grid, snapping vertices 1 and 4 to vertex 4 gives every
 * one of those six corners 1.65, which is the mean of vertex 4's own four
 * (0.20, 1.30, 2.10, 3.00) and not of all six. Confirmed per component on a
 * set whose mean and midpoint differ in both: (0,1) (1,8) (2,9) (9,10) gives
 * (3, 7), the mean.
 */
export function pointmergeLoopData(
  data: MeshData,
  verts: ReadonlySet<number> | readonly number[],
  snap: number,
  layer: LoopLayer = "uv",
): MeshData {
  const current = requireLayer(data, layer, "pointmergeLoopData");
  const next = current.map((corners) => corners.map((c) => [...c]));

  const source = cornersAt(data, snap);
  if (source.length === 0)
    throw new Error(`pointmergeLoopData: vertex ${snap} is on no polygon, so it has no value to give.`);
  const value = meanOf(source.map(([f, i]) => current[f]![i]!));

  for (const v of new Set(verts))
    for (const [f, i] of cornersAt(data, v)) next[f]![i] = [...value];
  return withLayer(data, layer, next);
}

/**
 * Flatten the corners at the chosen vertices to one value — Blender's
 * `average_vert_facedata`.
 *
 * **It is the midpoint of the range, not the mean**, and that is measured
 * rather than read: four corners holding 0.20, 1.30, 2.10 and 3.00 come back
 * holding **1.60**, where the mean is 1.65. Three earlier probes failed to
 * explain a 0.700 and a 0.650 by trying to read it as some average; both are
 * midpoints.
 *
 * It is also **one value for the whole selection**, not one per vertex: given
 * two vertices whose own midpoints are 0.55 and 1.60, every corner at both
 * comes back 1.55, the midpoint across all of them together.
 *
 * Per component, confirmed on a set where mean and midpoint differ in both:
 * (0,1) (1,8) (2,9) (9,10) gives (4.5, 5.5).
 *
 * The difference from {@link pointmergeLoopData}, which is a mean, is the kind
 * of asymmetry worth not assuming away — the two were measured separately on
 * the same arrangement and answered differently.
 */
export function averageVertLoopData(
  data: MeshData,
  verts: ReadonlySet<number> | readonly number[],
  layer: LoopLayer = "uv",
): MeshData {
  const current = requireLayer(data, layer, "averageVertLoopData");
  const next = current.map((corners) => corners.map((c) => [...c]));

  const touched: Array<[number, number]> = [];
  for (const v of new Set(verts)) touched.push(...cornersAt(data, v));
  if (touched.length === 0) return withLayer(data, layer, next);

  const value = midpointOf(touched.map(([f, i]) => current[f]![i]!));
  for (const [f, i] of touched) next[f]![i] = [...value];
  return withLayer(data, layer, next);
}

/**
 * Carrying a {@link MeshData}'s layers through an operator that rebuilds it
 * from pieces of itself — compaction, subsets, copies, reversal, welding.
 *
 * Before 2026-09-25 (compat-backlog A3) most `MeshData` operators kept
 * creases and seams and silently lost the rest: UVs, colours, custom normals,
 * vertex groups, materials, sharp edges, wire edges. These helpers take the
 * one fact such an operator knows — where each output face and vertex came
 * from — and carry every layer from it.
 *
 * Pure and headless.
 */
import type { MeshData } from "../lib/mesh";
import { seamKey } from "./edit-mode/half-edge";

/**
 * An output face made of input face `face`'s corners, `corners[i]` for
 * output corner `i` — or, where that is a list, the plain mean of those
 * corners (the Weld modifier's `mix_attributes` over the loops that collapse
 * onto one vertex).
 */
export interface FaceSource {
  face: number;
  corners: readonly (number | readonly number[])[];
}

/**
 * The per-face layers (UV, colour, custom normal per corner; material per
 * face) for output faces built from the input's corners.
 */
export function carryFaceLayers(
  data: MeshData,
  sources: readonly FaceSource[],
): Pick<MeshData, "uvs" | "colors" | "normals" | "materials"> {
  const out: Pick<MeshData, "uvs" | "colors" | "normals" | "materials"> = {};
  const corner = (layer: number[][][] | undefined) =>
    layer && layer.length === data.polys.length
      ? sources.map((s) =>
          s.corners.map((c) => {
            if (typeof c === "number") return [...layer[s.face]![c]!];
            const out = layer[s.face]![c[0]!]!.map(() => 0);
            for (const k of c) layer[s.face]![k]!.forEach((x, j) => (out[j] = out[j]! + x / c.length));
            return out;
          }),
        )
      : undefined;
  const uvs = corner(data.uvs);
  const colors = corner(data.colors);
  const normals = corner(data.normals);
  // Always set, undefined when the input had no layer shaped for its faces,
  // so spreading this over a copy of the input never leaves an old layer.
  out.uvs = uvs;
  out.colors = colors;
  out.normals = normals;
  out.materials =
    data.materials && data.materials.length === data.polys.length
      ? sources.map((s) => data.materials![s.face]!)
      : undefined;
  return out;
}

/** Output faces that are input faces with their vertices renumbered (corners in order). */
export function sameFaces(faces: readonly number[], data: MeshData): FaceSource[] {
  return faces.map((f) => ({ face: f, corners: data.polys[f]!.map((_, i) => i) }));
}

/**
 * The per-vertex and per-edge layers when output vertex `v` is input vertex
 * `source[v]` (or -1 for a vertex with no single source). Edge flags and
 * wire edges follow their two ends; an edge whose end has no source is
 * dropped. A group loses the vertices that have no source — which is what a
 * new vertex is in Blender unless something interpolates it in.
 */
export function carryVertexLayers(
  data: MeshData,
  source: ArrayLike<number>,
): Pick<MeshData, "groups" | "creases" | "seams" | "sharp" | "edges"> {
  const out: Pick<MeshData, "groups" | "creases" | "seams" | "sharp" | "edges"> = {};
  // Input vertex -> output vertices (a vertex can be copied).
  const targets = new Map<number, number[]>();
  for (let v = 0; v < source.length; v++) {
    const s = source[v]!;
    if (s < 0) continue;
    const l = targets.get(s);
    if (l) l.push(v);
    else targets.set(s, [v]);
  }
  if (data.groups) {
    out.groups = new Map();
    for (const [name, g] of data.groups) {
      const ng = new Map<number, number>();
      for (const [v, w] of g) for (const t of targets.get(v) ?? []) ng.set(t, w);
      out.groups.set(name, ng);
    }
  }
  // An edge key maps to every pair of copies of its ends that are both used
  // by an output face or wire edge; the caller filters with `usedEdges`.
  const pairs = (key: string): string[] => {
    const [a, b] = key.split("_").map(Number) as [number, number];
    const ta = targets.get(a) ?? [];
    const tb = targets.get(b) ?? [];
    const out: string[] = [];
    for (const x of ta) for (const y of tb) out.push(seamKey(x, y));
    return out;
  };
  if (data.creases) {
    out.creases = new Map();
    for (const [k, w] of data.creases) for (const nk of pairs(k)) out.creases.set(nk, w);
  }
  if (data.seams) {
    out.seams = new Set();
    for (const k of data.seams) for (const nk of pairs(k)) out.seams.add(nk);
  }
  if (data.sharp) {
    out.sharp = new Set();
    for (const k of data.sharp) for (const nk of pairs(k)) out.sharp.add(nk);
  }
  if (data.edges) {
    out.edges = [];
    for (const [a, b] of data.edges as [number, number][])
      for (const x of targets.get(a) ?? []) for (const y of targets.get(b) ?? []) out.edges.push([x, y]);
  }
  return out;
}

/**
 * Keep only the edge keys that are edges of `polys` or `wire` — copies of
 * an edge whose ends ended up in different pieces are not edges at all.
 */
export function onlyEdgesOf(
  layers: Pick<MeshData, "creases" | "seams" | "sharp">,
  polys: readonly (readonly number[])[],
  wire: readonly (readonly number[])[] = [],
): void {
  const have = new Set<string>();
  for (const p of polys) for (let i = 0; i < p.length; i++) have.add(seamKey(p[i]!, p[(i + 1) % p.length]!));
  for (const e of wire) have.add(seamKey(e[0]!, e[1]!));
  if (layers.creases) for (const k of [...layers.creases.keys()]) if (!have.has(k)) layers.creases.delete(k);
  if (layers.seams) for (const k of [...layers.seams]) if (!have.has(k)) layers.seams.delete(k);
  if (layers.sharp) for (const k of [...layers.sharp]) if (!have.has(k)) layers.sharp.delete(k);
}

/** Drop the keys of a `Pick<MeshData, …>` whose value is undefined, for spreading. */
export function defined<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

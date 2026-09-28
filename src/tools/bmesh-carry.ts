/**
 * Layers carried as values through `bmesh-lite` operators — the stand-in for
 * BMesh customdata where an operator mixes it (`CustomData_bmesh_interp`) or
 * compares it, so a corner's UV and colour may come from different places.
 * Shared by the ports that need that: `inset.ts`, `fill-grid.ts`.
 *
 * UVs and byte colours interpolate (the colour rounded to a byte as
 * `layerInterp_mloopcol` does); a custom normal is two angles in Blender
 * (`CD_PROP_INT16_2D`, no interpolation) and is only ever copied. Vertex
 * groups mix by `layerInterp_mdeformvert`. Edge crease / sharp / seam follow
 * an edge made with an example.
 */
import type { MeshData } from "../lib/mesh";
import { f, meshVertNormals, type V3 } from "./blender-math";
import {
  bmFromMesh,
  bmToMesh,
  edgeCreateLike,
  faceLoops,
  liveEdges,
  liveFaces,
  vertCreate,
  type BE,
  type BF,
  type BL,
  type BM,
  type BV,
} from "./bmesh-lite";

// ── the layers, carried as values ──────────────────────────────────────────

export interface LoopData {
  uv?: number[];
  col?: number[];
  nor?: number[];
}
export type VertData = Map<string, number>;

export interface Carry {
  ld: Map<BL, LoopData>;
  vd: Map<BV, VertData>;
  ed: Map<BE, EdgeData>;
  /** Which layers exist, for a loop made with no example (`CustomData_bmesh_set_default`). */
  has: { uv: boolean; col: boolean; nor: boolean };
}
export interface EdgeData {
  crease?: number;
  sharp?: boolean;
  seam?: boolean;
}

export const copyLD = (x: LoopData | undefined): LoopData => ({
  ...(x?.uv ? { uv: [...x.uv] } : {}),
  ...(x?.col ? { col: [...x.col] } : {}),
  ...(x?.nor ? { nor: [...x.nor] } : {}),
});
/** `BM_elem_attrs_copy` between loops. */
export function copyLoop(c: Carry, src: BL, dst: BL): void {
  c.ld.set(dst, copyLD(c.ld.get(src)));
}
/** A vertex made with `example`: its data copied. */
export function vertLike(c: Carry, bm: BM, example: BV): BV {
  const v = vertCreate(bm, example.co);
  v.no = [...example.no];
  v.tag = example.tag;
  c.vd.set(v, new Map(c.vd.get(example)));
  return v;
}
export function edgeLike(c: Carry, bm: BM, v1: BV, v2: BV, example: BE): BE {
  const e = edgeCreateLike(bm, v1, v2, example);
  const d = c.ed.get(example);
  if (d) c.ed.set(e, { ...d });
  return e;
}
export function copyEdgeData(c: Carry, src: BE, dst: BE): void {
  const d = c.ed.get(src);
  if (d) c.ed.set(dst, { ...d });
}

/**
 * `CustomData_bmesh_interp` over the loop layers that interpolate: UVs
 * (`layerInterp_propfloat2`) and byte colours (`layerInterp_mloopcol`: the
 * weighted sum of the bytes, rounded and clamped to 0..255). The custom
 * normal has no interpolation and keeps what `dst` held.
 */
export function interpLoop(srcs: LoopData[], w: number[], dst: LoopData): void {
  const mix = (get: (x: LoopData) => number[] | undefined): number[] | undefined => {
    const first = srcs.find((s) => get(s));
    if (!first) return undefined;
    const out = new Array<number>(get(first)!.length).fill(0);
    srcs.forEach((s, i) => {
      const v = get(s);
      if (v) for (let k = 0; k < out.length; k++) out[k] = out[k]! + w[i]! * v[k]!;
    });
    return out;
  };
  const uv = mix((x) => x.uv);
  if (uv) dst.uv = uv.map((x) => f(x));
  const col = mix((x) => x.col?.map((c) => Math.round(c * 255)));
  if (col) dst.col = col.map((x) => Math.min(255, Math.max(0, Math.round(f(x)))) / 255);
}

/** `layerInterp_mdeformvert`: a group joins where weight × factor is not zero; the sum is capped at 1. */
export function interpVert(srcs: VertData[], w: number[]): VertData {
  const out: VertData = new Map();
  srcs.forEach((s, i) => {
    for (const [g, x] of s) {
      const y = x * w[i]!;
      if (y === 0) continue;
      out.set(g, (out.get(g) ?? 0) + y);
    }
  });
  for (const [g, x] of out) out.set(g, Math.min(x, 1));
  return out;
}

// ── in and out ─────────────────────────────────────────────────────────────

export const edgeKey = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);

const isLayerOf = (polys: number) => (x: number[][][] | undefined): boolean => x !== undefined && x.length === polys;

export function load(data: MeshData): { bm: BM; c: Carry; byInput: Map<number, BF> } {
  const P: V3[] = [];
  for (let i = 0; i < data.positions.length; i += 3)
    P.push([f(data.positions[i]!), f(data.positions[i + 1]!), f(data.positions[i + 2]!)]);
  const valid = data.polys.filter((p) => p.length >= 3);
  const isLayer = isLayerOf(data.polys.length);
  const bm = bmFromMesh(data, { vertNormals: meshVertNormals(P, valid) });
  // A mempool for vertices: operators here kill between creations (inset's
  // glue, grid fill's collapse) and Blender hands the slot to the next one.
  bm.vertPool = { free: [] };
  const c: Carry = {
    ld: new Map(),
    vd: new Map(),
    ed: new Map(),
    // A layer is there when it has one entry per face — so a layer on a mesh
    // with no faces yet (a wire ring) is there and new faces get its default,
    // while `meshToData`'s empty array for "no UVs" on a mesh with faces is not.
    // Custom normals only on a mesh that has faces: zero vectors on a wire
    // ring's fill would override the computed normals (`MeshData.normals`).
    has: { uv: isLayer(data.uvs), col: isLayer(data.colors), nor: data.polys.length > 0 && isLayer(data.normals) },
  };
  const byInput = new Map<number, BF>();
  for (const fc of liveFaces(bm)) {
    byInput.set(fc.src, fc);
    faceLoops(fc).forEach((l, k) => {
      const d: LoopData = {};
      const uv = data.uvs?.[fc.src]?.[k];
      if (uv) d.uv = [...uv];
      const col = data.colors?.[fc.src]?.[k];
      if (col) d.col = [...col];
      const nor = data.normals?.[fc.src]?.[k];
      if (nor) d.nor = [...nor];
      c.ld.set(l, d);
    });
  }
  bm.verts.forEach((v, i) => {
    if (!v) return;
    const d: VertData = new Map();
    for (const [name, g] of data.groups ?? []) {
      const w = g.get(i);
      if (w !== undefined) d.set(name, w);
    }
    c.vd.set(v, d);
  });
  for (const e of liveEdges(bm)) {
    const k = edgeKey(e.v1.index, e.v2.index);
    const d: EdgeData = {};
    const cr = data.creases?.get(k);
    if (cr !== undefined) d.crease = cr;
    if (data.sharp?.has(k)) d.sharp = true;
    if (data.seams?.has(k)) d.seam = true;
    if (d.crease !== undefined || d.sharp || d.seam) c.ed.set(e, d);
  }
  return { bm, c, byInput };
}

/** `BM_mesh_bm_to_me` with the carried layers; `at` numbers the live faces as the output does. */
export function saveMesh(bm: BM, c: Carry, data: MeshData): { mesh: MeshData; at: Map<BF, number> } {
  const out = bmToMesh(bm);
  const faces = liveFaces(bm);
  const at = new Map<BF, number>(faces.map((x, i) => [x, i]));
  const layer = (get: (d: LoopData) => number[] | undefined, blank: number, width: number): number[][][] =>
    faces.map((x) => faceLoops(x).map((l) => [...(get(c.ld.get(l) ?? {}) ?? new Array<number>(width).fill(blank))]));
  const width = (src: number[][][] | undefined, w: number): number => src?.find((x) => x.length)?.[0]?.length ?? w;
  if (c.has.uv) out.uvs = layer((d) => d.uv, 0, width(data.uvs, 2));
  if (c.has.col) out.colors = layer((d) => d.col, 1, width(data.colors, 4));
  if (c.has.nor) out.normals = layer((d) => d.nor, 0, width(data.normals, 3));
  if (data.materials && data.materials.length === data.polys.length)
    out.materials = faces.map((x) => (x.src >= 0 ? data.materials![x.src]! : 0));
  const remap = new Map<BV, number>();
  for (const v of bm.verts) if (v) remap.set(v, remap.size);
  if (data.groups) {
    out.groups = new Map([...data.groups.keys()].map((name) => [name, new Map<number, number>()]));
    for (const [v, i] of remap)
      for (const [name, w] of c.vd.get(v) ?? []) out.groups.get(name)?.set(i, w);
  }
  const creases = new Map<string, number>();
  const sharp = new Set<string>();
  const seams = new Set<string>();
  for (const e of liveEdges(bm)) {
    const d = c.ed.get(e);
    if (!d) continue;
    const k = edgeKey(remap.get(e.v1)!, remap.get(e.v2)!);
    if (d.crease !== undefined) creases.set(k, d.crease);
    if (d.sharp) sharp.add(k);
    if (d.seam) seams.add(k);
  }
  if (data.creases) out.creases = creases;
  if (data.sharp) out.sharp = sharp;
  if (data.seams) out.seams = seams;
  return { mesh: out, at };
}

/** A loop made with no example holds each layer's default: 0, and white for a colour. */
export function blankLoop(c: Carry): LoopData {
  const d: LoopData = {};
  if (c.has.uv) d.uv = [0, 0];
  if (c.has.col) d.col = [1, 1, 1, 1];
  if (c.has.nor) d.nor = [0, 0, 0];
  return d;
}


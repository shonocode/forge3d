import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { faceVerts, rebuildPolygons, seamKey, triangulateFaces, type EditMesh } from "./half-edge";
import { meshFromData } from "../../lib/mesh";
import { renderToSurface } from "../modifier-core";

/** Metadata key holding the polygon (quad / n-gon) structure — see build/commit. */
export const POLY_METADATA_KEY = "forge3dPolys";
/** Metadata key holding UV seam edge keys (string[] of "min_max" vertex pairs). */
export const SEAM_METADATA_KEY = "forge3dSeams";
/** Metadata key holding edge creases ([key, crease] pairs, Blender's 0..1 — compat-backlog C118). */
export const CREASE_METADATA_KEY = "forge3dCreases";
/**
 * Metadata key holding the surface vertex of each render vertex (number[], one per vertex): render vertices that are one
 * vertex of the surface — split only for a normal or a UV — share a number, and coincident vertices with different numbers
 * are different vertices (two parts that touch). Written by the modifier stack (`modifier-core.surfaceToRender`), by Edit
 * Mode's topology commit (C123) and by forge3d's primitives as they are made (`writeSurfaceWeld`). Without one the stack
 * welds by position (C113) and Edit Mode welds nothing (C123).
 */
export const WELD_METADATA_KEY = "forge3dWeld";
/**
 * Metadata key holding {@link keysSignature} of the buffer the vertex-keyed lists (weld, creases, seams) were written for.
 * A tool that rebuilds the buffer without knowing them (Weld Vertices, Shade, dyntopo) leaves them naming other vertices;
 * the signature no longer matches and they are dropped on read (compat-backlog C112, C113). Absent (files before
 * 2026-10-15): trusted, as before.
 */
export const KEYS_FOR_METADATA_KEY = "forge3dKeysFor";

/**
 * A fingerprint of a buffer's numbering: the vertex count and the index list (FNV-1a, 32 bit). Two buffers with the same
 * signature number their vertices alike for every purpose the keyed lists need.
 */
export function keysSignature(vertexCount: number, indices: ArrayLike<number>): string {
  let h = 0x811c9dc5;
  const mix = (x: number): void => {
    for (let s = 0; s < 32; s += 8) {
      h ^= (x >>> s) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  mix(vertexCount);
  mix(indices.length);
  for (let i = 0; i < indices.length; i++) mix(indices[i]!);
  return `${vertexCount}:${indices.length}:${h.toString(16)}`;
}

/** Whether the vertex-keyed lists on `meta` were written for this buffer (or carry no signature — older files). */
export function keysFitBuffer(meta: Record<string, unknown> | null, vertexCount: number, indices: ArrayLike<number>): boolean {
  const sig = meta?.[KEYS_FOR_METADATA_KEY];
  return typeof sig !== "string" || sig === keysSignature(vertexCount, indices);
}

/** Metadata key holding UV Editor pin vertex indices (number[]). */
export const UV_PIN_METADATA_KEY = "forge3dUVPins";

/**
 * What a Babylon mesh's metadata says about its render buffer, in **render vertex** numbers: the polygons (when the stored
 * list still fan-triangulates to the current index buffer — a stale one is dropped from the metadata, as before), the
 * creases and seams (when their signature fits the buffer), and the surface vertex of each render vertex (`forge3dWeld`,
 * when it fits). The modifier stack and CSG read this; Edit Mode builds on it (compat-backlog C123).
 */
export function readRenderTopology(source: Mesh): {
  polys: number[][] | null;
  creases: Map<string, number>;
  seams: Set<string>;
  weld: number[] | null;
} | null {
  const posData = source.getVerticesData(VertexBuffer.PositionKind);
  const indices = source.getIndices();
  if (!posData || !indices) return null;
  const numV = posData.length / 3;
  const meta = (source.metadata ?? null) as Record<string, unknown> | null;
  const fits = keysFitBuffer(meta, numV, indices);

  // Edge attributes (seams / creases) are keyed by vertex pairs, valid regardless of the polygon match.
  const scratch: EditMesh = {
    source, vertices: [], faces: [], halfEdges: [], positions: new Float32Array(posData), seams: new Set<string>(),
    creases: new Map<string, number>(), triToFace: [],
  };
  if (fits) restoreEdgeAttrs(source, scratch, numV);

  let polys: number[][] | null = null;
  const stored = readStoredPolys(source, numV);
  if (stored) {
    rebuildPolygons(scratch, scratch.positions, stored);
    if (sameIndices(triangulateFaces(scratch).indices, indices)) polys = stored.map((p) => [...p]);
    // Stale — the index buffer changed since the polys were written.
    else dropStoredPolys(source);
  }
  const rawWeld = meta?.[WELD_METADATA_KEY];
  const weld =
    fits && Array.isArray(rawWeld) && rawWeld.length === numV && rawWeld.every((w) => Number.isInteger(w)) ? (rawWeld as number[]) : null;
  return { polys, creases: scratch.creases, seams: scratch.seams, weld };
}

/**
 * Build an EditMesh from a Babylon Mesh — on its **surface**, not its render buffer (compat-backlog C123).
 *
 * A render buffer splits a vertex wherever a UV or the shading parts (a box drawn flat is 24 render vertices for 8
 * corners). Until 2026-10-16 Edit Mode took the render vertices as its own, so dragging a corner of a box tore it open and
 * every seam showed as a boundary. Now the render vertices are welded first — those the buffer's `forge3dWeld` list names
 * as one; without a list none, as before (see `weld:` below) — and Edit Mode works on the welded vertices, with the UVs
 * per face corner (`loopUVs`) and the shading kept as an Auto Smooth angle read off the normals. `commitTopology` splits
 * it back. `renderWeld` keeps the surface vertex of each render vertex, so a move (`commitPositions`) writes the render
 * buffer without rebuilding it.
 *
 * The faces: the stored polygons when they still match the index buffer (as before), else the render triangles one face
 * each. Creases and seams come off the metadata onto the surface edges.
 *
 * Returns null if the mesh has no position data or no indices — callers should fall back gracefully (typically by
 * refusing to enter Edit Mode).
 */
export function buildEditMesh(source: Mesh): EditMesh | null {
  const topo = readRenderTopology(source);
  if (!topo) return null;
  const positions = new Float32Array(source.getVerticesData(VertexBuffer.PositionKind)!);
  const indices = Array.from(source.getIndices()!);
  const normals = source.getVerticesData(VertexBuffer.NormalKind);
  const uvs = source.getVerticesData(VertexBuffer.UVKind);
  const polys = topo.polys ?? Array.from({ length: indices.length / 3 }, (_, t) => [indices[t * 3]!, indices[t * 3 + 1]!, indices[t * 3 + 2]!]);
  const { surface, smoothAngle, remap, normalSign } = renderToSurface({
    positions,
    normals: normals ? new Float32Array(normals) : null,
    uvs: uvs ? new Float32Array(uvs) : null,
    indices,
    polys,
    // Only what the buffer's own list says is one vertex is welded; without a list every render vertex is its own. A
    // position weld would fuse separate parts that touch (C113) and a plane's two sides; Blender imports a glTF unwelded
    // too. forge3d's primitives write a list when made (`writeSurfaceWeld`), the modifier stack and Edit Mode's commit
    // whenever they write a buffer.
    weld: topo.weld ?? Array.from({ length: positions.length / 3 }, (_, r) => r),
    creases: [...topo.creases],
    seams: [...topo.seams],
  });
  const em = meshFromData(surface);
  em.source = source;
  em.renderWeld = Array.from(remap);
  em.smoothAngle = smoothAngle;
  em.normalSign = normalSign;
  // The render buffer is not rewritten until a topology commit, so a picked render triangle is found by its corners: the
  // face holding all three of their surface vertices.
  em.triToFace = renderTrianglesToFaces(em, indices);
  return em;
}

/**
 * Read the mesh's UV buffer back onto the EditMesh's face corners, through `renderWeld` and `triToFace` — for a buffer
 * whose UVs were rewritten in place (the UV editor). Without a UV buffer the corners lose theirs.
 */
export function refreshLoopUVs(em: EditMesh): void {
  const mesh = em.source;
  const weld = em.renderWeld;
  if (!mesh || !weld) return;
  const uv = mesh.getVerticesData(VertexBuffer.UVKind);
  const indices = mesh.getIndices();
  if (!uv || !indices) {
    delete em.loopUVs;
    return;
  }
  const out = em.faces.map((_, f) => faceVerts(em, f).map(() => [0, 0]));
  for (let t = 0; t * 3 + 2 < indices.length; t++) {
    const f = em.triToFace[t] ?? -1;
    if (f < 0) continue;
    const verts = faceVerts(em, f);
    for (let k = 0; k < 3; k++) {
      const r = indices[t * 3 + k]!;
      const i = verts.indexOf(weld[r]!);
      if (i >= 0) out[f]![i] = [uv[r * 2]!, uv[r * 2 + 1]!];
    }
  }
  em.loopUVs = out;
}

/**
 * Write the surface vertex of each render vertex for a buffer made without one — welded by position (1e-6) — with the
 * signature of the buffer. forge3d's primitives call it as they are made: a Babylon box is 24 render vertices for 8
 * corners, and Edit Mode, which welds only what the list says (C123), then edits the 8.
 */
export function writeSurfaceWeld(mesh: Mesh): void {
  const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
  const indices = mesh.getIndices();
  if (!pos || !indices) return;
  const tris = Array.from({ length: indices.length / 3 }, (_, t) => [indices[t * 3]!, indices[t * 3 + 1]!, indices[t * 3 + 2]!]);
  const { remap } = renderToSurface({ positions: new Float32Array(pos), normals: null, uvs: null, indices: Array.from(indices), polys: tris });
  const meta = (mesh.metadata ?? {}) as Record<string, unknown>;
  meta[WELD_METADATA_KEY] = Array.from(remap);
  meta[KEYS_FOR_METADATA_KEY] = keysSignature(pos.length / 3, indices);
  mesh.metadata = meta;
}

const KEYED_METADATA = [WELD_METADATA_KEY, POLY_METADATA_KEY, CREASE_METADATA_KEY, SEAM_METADATA_KEY, KEYS_FOR_METADATA_KEY];

/**
 * A copy of the vertex-keyed lists in a mesh's metadata (weld, polygons, creases, seams and their signature), for an undo
 * that puts a buffer back: without them the buffer comes back and the lists stay the rebuilt one's (compat-backlog C125).
 */
export function snapshotKeyedMetadata(mesh: { metadata: unknown }): Record<string, unknown> {
  const meta = mesh.metadata as Record<string, unknown> | null;
  return Object.fromEntries(KEYED_METADATA.flatMap((k) => (meta?.[k] === undefined ? [] : [[k, structuredClone(meta[k])]])));
}

/** Put back what {@link snapshotKeyedMetadata} copied — and remove the lists it did not have. */
export function restoreKeyedMetadata(mesh: { metadata: unknown }, keyed: Record<string, unknown>): void {
  const meta = (mesh.metadata ?? {}) as Record<string, unknown>;
  for (const k of KEYED_METADATA) {
    if (k in keyed) meta[k] = structuredClone(keyed[k]);
    else delete meta[k];
  }
  mesh.metadata = meta;
}

/** The vertex-keyed lists of a render buffer, in its render vertex numbers (see {@link readRenderTopology}). */
export interface KeyedLists {
  weld: number[] | null;
  creases: Map<string, number>;
  seams: Set<string>;
  polys: number[][] | null;
}

/**
 * Carry the vertex-keyed lists of a buffer onto the buffer a tool rebuilt from it (compat-backlog C125), and sign them for
 * the new one. `from[v]` is the old render vertex each new vertex `v` came from, or -1 for one made new (its weld number is
 * then its own, past every old one; give it `weldOf` to say better). An edge of the new triangles whose ends came from the
 * ends of a creased or seamed edge keeps the mark; a polygon keeps its corners through `from` when each old corner went to
 * one new vertex (otherwise the polygons are left out, and Edit Mode reads triangles). `before` null (or without a weld
 * list): the buffer had none and gets none.
 */
export function carryKeyedLists(
  mesh: Mesh,
  before: KeyedLists | null,
  from: ArrayLike<number>,
  weldOf?: (v: number) => number,
): void {
  const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
  const indices = mesh.getIndices();
  if (!pos || !indices) return;
  const numV = pos.length / 3;
  const meta = (mesh.metadata ?? {}) as Record<string, unknown>;
  for (const k of [WELD_METADATA_KEY, SEAM_METADATA_KEY, CREASE_METADATA_KEY, POLY_METADATA_KEY]) delete meta[k];
  if (before) {
    if (before.weld) {
      let next = before.weld.reduce((m, w) => Math.max(m, w), -1) + 1;
      meta[WELD_METADATA_KEY] = Array.from({ length: numV }, (_, v) => (from[v]! >= 0 ? before.weld![from[v]!]! : weldOf ? weldOf(v) : next++));
    }
    const seams = new Set<string>();
    const creases = new Map<string, number>();
    if (before.seams.size || before.creases.size)
      for (let t = 0; t < indices.length; t += 3)
        for (let k = 0; k < 3; k++) {
          const a = indices[t + k]!, b = indices[t + ((k + 1) % 3)]!;
          if (from[a]! < 0 || from[b]! < 0) continue;
          const old = seamKey(from[a]!, from[b]!);
          if (before.seams.has(old)) seams.add(seamKey(a, b));
          const c = before.creases.get(old);
          if (c !== undefined) creases.set(seamKey(a, b), c);
        }
    if (seams.size) meta[SEAM_METADATA_KEY] = [...seams];
    if (creases.size) meta[CREASE_METADATA_KEY] = [...creases];
    if (before.polys) {
      // The old fan's triangles are the new buffer's, in order; read each polygon's corners off its own triangles. A
      // polygon whose corner went to two new vertices (a non-planar quad shaded flat) stays as its triangles.
      const polys: number[][] = [];
      let t = 0;
      let ok = before.polys.reduce((s, p) => s + p.length - 2, 0) * 3 === indices.length;
      for (const poly of ok ? before.polys : []) {
        const corner = new Map<number, number>();
        let whole = true;
        for (let i = 1; i + 1 < poly.length; i++)
          for (const [k, v] of [poly[0]!, poly[i]!, poly[i + 1]!].entries()) {
            const n = indices[(t + i - 1) * 3 + k]!;
            if (from[n] !== v) ok = false;
            else if (corner.has(v) && corner.get(v) !== n) whole = false;
            else corner.set(v, n);
          }
        if (whole) polys.push(poly.map((v) => corner.get(v)!));
        else for (let i = 0; i < poly.length - 2; i++) polys.push([indices[(t + i) * 3]!, indices[(t + i) * 3 + 1]!, indices[(t + i) * 3 + 2]!]);
        t += poly.length - 2;
      }
      if (ok) meta[POLY_METADATA_KEY] = polys;
    }
  }
  meta[KEYS_FOR_METADATA_KEY] = keysSignature(numV, indices);
  mesh.metadata = meta;
}

/** For each render triangle, the Edit Mode face over its three corners' surface vertices (-1 for one welded flat). */
export function renderTrianglesToFaces(em: EditMesh, indices: ArrayLike<number>): number[] {
  const weld = em.renderWeld!;
  const facesAt = new Map<number, number[]>();
  for (let f = 0; f < em.faces.length; f++)
    for (const v of faceVerts(em, f)) (facesAt.get(v) ?? facesAt.set(v, []).get(v)!).push(f);
  const out: number[] = [];
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const [a, b, c] = [weld[indices[t]!]!, weld[indices[t + 1]!]!, weld[indices[t + 2]!]!];
    const f = (facesAt.get(a) ?? []).find((g) => {
      const vs = faceVerts(em, g);
      return vs.includes(b) && vs.includes(c);
    });
    out.push(f ?? -1);
  }
  return out;
}

/** True iff an "a_b" edge key references two distinct in-range vertices. */
function validEdgeKey(k: unknown, numV: number): k is string {
  if (typeof k !== "string") return false;
  const us = k.indexOf("_");
  if (us <= 0) return false;
  const a = Number(k.slice(0, us));
  const b = Number(k.slice(us + 1));
  return Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b >= 0 && a < numV && b < numV && a !== b;
}

/** Populate em.seams / em.creases from mesh metadata (dropping stale keys). */
function restoreEdgeAttrs(source: Mesh, em: EditMesh, numV: number): void {
  const meta = (source.metadata ?? null) as Record<string, unknown> | null;
  if (!meta) return;
  const rawSeams = meta[SEAM_METADATA_KEY];
  if (Array.isArray(rawSeams)) {
    for (const k of rawSeams) if (validEdgeKey(k, numV)) em.seams.add(k);
  }
  const rawCreases = meta[CREASE_METADATA_KEY];
  if (Array.isArray(rawCreases)) {
    for (const pair of rawCreases) {
      if (!Array.isArray(pair) || pair.length !== 2) continue;
      const [k, s] = pair as [unknown, unknown];
      // Projects saved before C118 hold OpenSubdiv sharpness (0..4); a crease is 0..1, so anything above is fully sharp.
      if (validEdgeKey(k, numV) && typeof s === "number" && s > 0) em.creases.set(k, Math.min(s, 1));
    }
  }
}

/** Structurally validate the stored polygon list (shape + index range only). */
function readStoredPolys(source: Mesh, numV: number): number[][] | null {
  const meta = (source.metadata ?? null) as Record<string, unknown> | null;
  const raw = meta?.[POLY_METADATA_KEY];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  for (const poly of raw) {
    if (!Array.isArray(poly) || poly.length < 3) return null;
    for (const v of poly) {
      if (!Number.isInteger(v) || v < 0 || v >= numV) return null;
    }
  }
  return raw as number[][];
}

function dropStoredPolys(source: Mesh): void {
  const meta = source.metadata as Record<string, unknown> | null;
  if (meta && POLY_METADATA_KEY in meta) delete meta[POLY_METADATA_KEY];
}

function sameIndices(a: readonly number[], b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

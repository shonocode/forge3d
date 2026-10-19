import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { faceVerts, seamKey, sourceMesh, toPolygons, type EditMesh } from "./half-edge";
import { CREASE_METADATA_KEY, KEYS_FOR_METADATA_KEY, keysSignature, POLY_METADATA_KEY, SEAM_METADATA_KEY, UV_PIN_METADATA_KEY, WELD_METADATA_KEY } from "./build";
import { transferAttribute, transferSkinWeights } from "./attribute-transfer";
import { meshToData, type MeshData } from "../../lib/mesh";
import { DEFAULT_SMOOTH_ANGLE, surfaceToRender, transferUVs } from "../modifier-core";

/**
 * Write the EditMesh's positions back to the source Babylon mesh — the position-only path the gizmo runs on every pointer
 * move; topology unchanged. Through `renderWeld` each render vertex takes its Edit Mode vertex's position, so the copies a
 * UV or a hard edge split move together (compat-backlog C123). Normals follow the commit's own rule at the mesh's angle
 * (`surfaceNormals`); without `renderWeld`, `ComputeNormals` over the render triangles.
 */
export function commitPositions(em: EditMesh): void {
  const mesh = sourceMesh(em);
  const weld = em.renderWeld;
  let render = em.positions;
  if (weld) {
    render = new Float32Array(weld.length * 3);
    for (let r = 0; r < weld.length; r++) {
      const v = weld[r]! * 3;
      render[r * 3] = em.positions[v]!;
      render[r * 3 + 1] = em.positions[v + 1]!;
      render[r * 3 + 2] = em.positions[v + 2]!;
    }
  }
  mesh.updateVerticesData(VertexBuffer.PositionKind, render);
  const indices = mesh.getIndices();
  if (!indices) return;
  if (weld) {
    // The normals by the commit's own rule at the mesh's angle (C123 review: `ComputeNormals` over the render triangles
    // split the shading at every UV seam, and the next entry read a sphere as faceted off them).
    mesh.updateVerticesData(VertexBuffer.NormalKind, surfaceNormals(em, weld, indices));
    return;
  }
  const normals = new Float32Array(render.length);
  VertexData.ComputeNormals(render, indices, normals);
  mesh.updateVerticesData(VertexBuffer.NormalKind, normals);
}

/**
 * Each render vertex's normal as `surfaceToRender` makes it: the area-weighted normals of the faces round its Edit Mode
 * vertex that are within `em.smoothAngle` of the face its render triangles belong to, signed as the buffer's
 * (`em.normalSign`).
 */
function surfaceNormals(em: EditMesh, weld: readonly number[], indices: ArrayLike<number>): Float32Array {
  const P = em.positions;
  const area = em.faces.map((_, f) => {
    const p = faceVerts(em, f);
    let x = 0, y = 0, z = 0;
    for (let i = 0; i < p.length; i++) {
      const a = p[i]! * 3, b = p[(i + 1) % p.length]! * 3;
      x += (P[a + 1]! - P[b + 1]!) * (P[a + 2]! + P[b + 2]!);
      y += (P[a + 2]! - P[b + 2]!) * (P[a]! + P[b]!);
      z += (P[a]! - P[b]!) * (P[a + 1]! + P[b + 1]!);
    }
    return [x, y, z];
  });
  const fn = area.map(([x, y, z]) => {
    const l = Math.hypot(x!, y!, z!) || 1;
    return [x! / l, y! / l, z! / l];
  });
  const around = new Map<number, number[]>();
  em.faces.forEach((_, f) => {
    for (const v of faceVerts(em, f)) (around.get(v) ?? around.set(v, []).get(v)!).push(f);
  });
  const faceOf = new Int32Array(weld.length).fill(-1);
  for (let t = 0; t * 3 + 2 < indices.length; t++) {
    const f = em.triToFace[t] ?? -1;
    if (f < 0) continue;
    for (let k = 0; k < 3; k++) {
      const r = indices[t * 3 + k]!;
      if (faceOf[r]! < 0) faceOf[r] = f;
    }
  }
  const angle = em.smoothAngle ?? DEFAULT_SMOOTH_ANGLE;
  const cosT = angle >= Math.PI ? -2 : Math.cos(angle) - 1e-9;
  const sign = em.normalSign ?? -1;
  const out = new Float32Array(weld.length * 3);
  for (let r = 0; r < weld.length; r++) {
    const f = faceOf[r]!;
    if (f < 0) continue;
    let x = 0, y = 0, z = 0;
    for (const g of around.get(weld[r]!) ?? []) {
      const d = fn[f]![0]! * fn[g]![0]! + fn[f]![1]! * fn[g]![1]! + fn[f]![2]! * fn[g]![2]!;
      if (g === f || d >= cosT) {
        x += area[g]![0]!;
        y += area[g]![1]!;
        z += area[g]![2]!;
      }
    }
    const l = Math.hypot(x, y, z) || 1;
    out[r * 3] = (sign * x) / l;
    out[r * 3 + 1] = (sign * y) / l;
    out[r * 3 + 2] = (sign * z) / l;
  }
  return out;
}

/** The kinds `commitTopology` writes; any other buffer left at another length goes. */
const WRITTEN = new Set<string>([
  VertexBuffer.PositionKind, VertexBuffer.NormalKind, VertexBuffer.UVKind, VertexBuffer.MatricesIndicesKind, VertexBuffer.MatricesWeightsKind,
]);

/**
 * Full geometry commit — the EditMesh, which is the welded surface, split back into a render buffer and written to the
 * source mesh (compat-backlog C123): `surfaceToRender` at the mesh's Auto Smooth angle (`em.smoothAngle`, read off its
 * normals when Edit Mode was entered), each vertex split where its corners' UVs or normals part, faces fan-triangulated
 * in face order (so `triToFace` is the faces' fans).
 *
 * Layers: the UVs are the corners' own (`loopUVs`) where the operators carried them; where one did not, each corner's
 * UV is read off the old buffer at its position, nudged into its own face so a corner on a UV seam reads its side
 * (`transferUVs`). Skin weights (MatricesIndices/Weights) are sampled off the old buffer at every new render vertex — a
 * vertex where an old one was reads it exactly — so a renumbering (Merge) cannot shift them, as copying by index did.
 * Every other vertex buffer (colours, a second UV, tangents) is sampled across the same way, since the render vertices
 * are renumbered.
 *
 * Metadata, in the new render buffer's numbers: the polygons, the surface vertex of each render vertex (`forge3dWeld` —
 * until C123 a commit dropped it), the creases and seams on every render copy of their edges, and the signature of the
 * buffer they describe. UV pins are dropped: they name render vertices that are not the same any more.
 */
export function commitTopology(em: EditMesh): void {
  const mesh = sourceMesh(em);
  // The old buffers — the transfer source.
  const oldPos = mesh.getVerticesData(VertexBuffer.PositionKind);
  const oldIdx = mesh.getIndices();
  const oldUV = mesh.getVerticesData(VertexBuffer.UVKind);
  const oldMI = mesh.getVerticesData(VertexBuffer.MatricesIndicesKind);
  const oldMW = mesh.getVerticesData(VertexBuffer.MatricesWeightsKind);
  // Every other buffer (colours, a second UV, tangents…), to sample across — the render vertices are renumbered, so one
  // kept as it was would be in the old order (C123 review).
  const others: Array<{ kind: string; data: Float32Array; size: number }> = [];
  for (const kind of mesh.getVerticesDataKinds()) {
    if (WRITTEN.has(kind)) continue;
    const d = mesh.getVerticesData(kind);
    const vb = mesh.getVertexBuffer(kind);
    if (d && vb) others.push({ kind, data: new Float32Array(d), size: vb.getSize() });
  }

  const data = meshToData(em);
  const shaped = data.uvs.length === data.polys.length && data.uvs.every((f, i) => f.length === data.polys[i]!.length);
  if (shaped && data.uvs.length) {
    // Carried by the operators.
  } else if (oldUV && oldPos && oldIdx) {
    const tris: number[][] = [];
    const corners: number[][][] = [];
    for (let t = 0; t + 2 < oldIdx.length; t += 3) {
      const tri = [oldIdx[t]!, oldIdx[t + 1]!, oldIdx[t + 2]!];
      tris.push(tri);
      corners.push(tri.map((v) => [oldUV[v * 2]!, oldUV[v * 2 + 1]!]));
    }
    data.uvs = transferUVs({ positions: new Float32Array(oldPos), polys: tris, uvs: corners }, data) ?? [];
    // Kept on the corners, so an undo snapshot or the next commit has them (C123 review).
    if (data.uvs.length) em.loopUVs = data.uvs.map((f) => f.map((c) => [...c]));
  } else data.uvs = [];
  const surface: MeshData = { positions: data.positions, polys: data.polys, creases: data.creases, seams: data.seams };
  if (data.uvs.length) surface.uvs = data.uvs;
  const render = surfaceToRender(surface, em.smoothAngle ?? DEFAULT_SMOOTH_ANGLE, em.normalSign ?? -1);

  const vd = new VertexData();
  vd.positions = render.positions;
  vd.normals = render.normals;
  vd.indices = render.indices.slice();
  if (render.uvs) vd.uvs = render.uvs;
  if (oldPos && oldIdx && oldMI && oldMW) {
    const skin = transferSkinWeights(oldPos, oldIdx, oldMI, oldMW, render.positions, true);
    vd.matricesIndices = skin.matricesIndices;
    vd.matricesWeights = skin.matricesWeights;
  }
  vd.applyToMesh(mesh, true);
  const count = render.positions.length / 3;
  if (!render.uvs && mesh.getVerticesData(VertexBuffer.UVKind)) mesh.removeVerticesData(VertexBuffer.UVKind);
  for (const { kind, data: old, size } of others) {
    if (oldPos && oldIdx) mesh.setVerticesData(kind, transferAttribute(oldPos, oldIdx, old, render.positions, size, true), true, size);
    else mesh.removeVerticesData(kind);
  }

  em.renderWeld = render.weld;
  em.triToFace = render.polys.flatMap((p, f) => new Array<number>(Math.max(0, p.length - 2)).fill(f));

  const meta = (mesh.metadata ?? {}) as Record<string, unknown>;
  meta[POLY_METADATA_KEY] = render.polys;
  meta[WELD_METADATA_KEY] = render.weld;
  if (render.creases?.length) meta[CREASE_METADATA_KEY] = render.creases;
  else delete meta[CREASE_METADATA_KEY];
  if (render.seams?.length) meta[SEAM_METADATA_KEY] = render.seams;
  else delete meta[SEAM_METADATA_KEY];
  delete meta[UV_PIN_METADATA_KEY];
  meta[KEYS_FOR_METADATA_KEY] = keysSignature(count, render.indices);
  mesh.metadata = meta;
}

/**
 * Persist the polygon structure + edge attributes (seams / creases) on the source mesh's metadata **for a render buffer
 * that is the EditMesh one for one** (no `renderWeld`, or the identity) — what a mesh with no split vertex has. A mesh
 * with splits goes through {@link commitTopology}, which writes the metadata for the buffer it makes.
 */
export function writePolyMetadata(em: EditMesh): void {
  if (!isIdentity(em)) {
    commitTopology(em);
    return;
  }
  const mesh = sourceMesh(em);
  const meta = (mesh.metadata ?? {}) as Record<string, unknown>;
  meta[POLY_METADATA_KEY] = toPolygons(em);
  writeEdgeAttrMetadataInto(em, meta, mesh);
  signKeys(mesh, meta);
  mesh.metadata = meta;
}

function isIdentity(em: EditMesh): boolean {
  const w = em.renderWeld;
  return !w || (w.length === em.vertices.length && w.every((v, r) => v === r));
}

/** Stamp the keyed lists with the buffer they now describe (see `KEYS_FOR_METADATA_KEY`). */
function signKeys(mesh: ReturnType<typeof sourceMesh>, meta: Record<string, unknown>): void {
  const indices = mesh.getIndices();
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (indices && positions) meta[KEYS_FOR_METADATA_KEY] = keysSignature(positions.length / 3, indices);
}

/**
 * Persist only the edge attributes (seams / creases) — used by Mark Seam / Mark Crease, which change these without a
 * topology commit. Written on every render copy of each edge (compat-backlog C123: until then only on the copy clicked).
 */
export function writeEdgeAttrMetadata(em: EditMesh): void {
  const mesh = sourceMesh(em);
  const meta = (mesh.metadata ?? {}) as Record<string, unknown>;
  writeEdgeAttrMetadataInto(em, meta, mesh);
  signKeys(mesh, meta);
  mesh.metadata = meta;
}

function writeEdgeAttrMetadataInto(em: EditMesh, meta: Record<string, unknown>, mesh: ReturnType<typeof sourceMesh>): void {
  // Edit Mode's edge keys in the render buffer's numbers: every render edge whose ends weld to the edge's two vertices.
  const toRender = (keys: Iterable<string>): string[] => {
    if (isIdentity(em)) return [...keys];
    const weld = em.renderWeld!;
    const want = new Set(keys);
    const out = new Set<string>();
    const stored = meta[POLY_METADATA_KEY];
    const indices = mesh.getIndices() ?? [];
    const rings: number[][] = Array.isArray(stored)
      ? (stored as number[][])
      : Array.from({ length: indices.length / 3 }, (_, t) => [indices[t * 3]!, indices[t * 3 + 1]!, indices[t * 3 + 2]!]);
    for (const ring of rings)
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
        if (want.has(seamKey(weld[a]!, weld[b]!))) out.add(seamKey(a, b));
      }
    return [...out];
  };
  const seams = toRender(em.seams);
  if (seams.length) meta[SEAM_METADATA_KEY] = seams;
  else delete meta[SEAM_METADATA_KEY];
  const creaseKeys = toRender(em.creases.keys());
  const creases: Array<[string, number]> = isIdentity(em)
    ? [...em.creases]
    : creaseKeys.map((k) => {
        const [a, b] = k.split("_").map(Number) as [number, number];
        return [k, em.creases.get(seamKey(em.renderWeld![a]!, em.renderWeld![b]!))!];
      });
  if (creases.length) meta[CREASE_METADATA_KEY] = creases;
  else delete meta[CREASE_METADATA_KEY];
}

/** The metadata keys a commit writes — what an undo puts back. */
const FORGE_KEYS = [POLY_METADATA_KEY, WELD_METADATA_KEY, CREASE_METADATA_KEY, SEAM_METADATA_KEY, UV_PIN_METADATA_KEY, KEYS_FOR_METADATA_KEY];

function forgeKeys(meta: Record<string, unknown> | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of FORGE_KEYS) if (meta && k in meta) out[k] = structuredClone(meta[k]);
  return out;
}

/** The source mesh's buffers, index list and metadata as they are, with the EditMesh's map onto them — for an exact undo. */
export interface RenderSnapshot {
  kinds: Array<{ kind: string; data: Float32Array; size: number }>;
  indices: number[];
  metadata: Record<string, unknown> | null;
  renderWeld?: number[];
  triToFace: number[];
}

/**
 * Take the render buffer as it is. A topology undo puts this back rather than re-rendering the EditMesh, which would
 * number the render vertices afresh — and every other history entry kept by render vertex (UV editor, sculpt and
 * weight strokes) would then write into the wrong vertices (C123 review).
 */
export function snapshotRender(em: EditMesh): RenderSnapshot {
  const mesh = sourceMesh(em);
  const kinds: RenderSnapshot["kinds"] = [];
  for (const kind of mesh.getVerticesDataKinds()) {
    const d = mesh.getVerticesData(kind);
    const vb = mesh.getVertexBuffer(kind);
    if (d && vb) kinds.push({ kind, data: new Float32Array(d), size: vb.getSize() });
  }
  const meta = mesh.metadata as Record<string, unknown> | null;
  return {
    kinds,
    indices: Array.from(mesh.getIndices() ?? []),
    metadata: forgeKeys(meta),
    ...(em.renderWeld ? { renderWeld: [...em.renderWeld] } : {}),
    triToFace: [...em.triToFace],
  };
}

/** Put a {@link snapshotRender} back: the buffers (any other dropped), the indices, the metadata, the EditMesh's map. */
export function restoreRender(em: EditMesh, snap: RenderSnapshot): void {
  restoreRenderBuffers(sourceMesh(em), snap);
  if (snap.renderWeld) em.renderWeld = [...snap.renderWeld];
  else delete em.renderWeld;
  em.triToFace = [...snap.triToFace];
}

/**
 * The mesh half of {@link restoreRender}: buffers, indices and forge3d's metadata, with no EditMesh — for undoing a
 * whole Edit Mode session after it was left (compat-backlog C127).
 */
export function restoreRenderBuffers(mesh: ReturnType<typeof sourceMesh>, snap: RenderSnapshot): void {
  const vd = new VertexData();
  for (const { kind, data } of snap.kinds) vd.set(new Float32Array(data), kind);
  vd.indices = snap.indices.slice();
  vd.applyToMesh(mesh, true);
  // `VertexData.set` knows the usual kinds only; any other is put back on its own.
  for (const { kind, data, size } of snap.kinds)
    if (mesh.getVerticesData(kind)?.length !== data.length) mesh.setVerticesData(kind, new Float32Array(data), true, size);
  const keep = new Set(snap.kinds.map((k) => k.kind));
  for (const kind of mesh.getVerticesDataKinds()) if (!keep.has(kind)) mesh.removeVerticesData(kind);
  putForgeKeys(mesh, snap.metadata);
}

/** forge3d's own metadata keys back as they were (all plain data); any other metadata stays as it is, class instances and all. */
function putForgeKeys(mesh: ReturnType<typeof sourceMesh>, saved: Record<string, unknown> | null): void {
  const meta = (mesh.metadata ?? {}) as Record<string, unknown>;
  for (const k of FORGE_KEYS) {
    if (saved && k in saved) meta[k] = structuredClone(saved[k]);
    else delete meta[k];
  }
  mesh.metadata = meta;
}

/**
 * Part of the mesh: some vertex kinds (same length on both sides — no topology change between) and forge3d's metadata.
 * What an Edit Mode drag (positions, normals) or an edge mark (metadata only) needs to be undone once its EditMesh is
 * gone (compat-backlog C127) — a whole {@link snapshotRender} per drag was ~9 MB on a 53k-vertex mesh.
 */
export interface PartSnapshot {
  part: Array<{ kind: string; data: Float32Array }>;
  metadata: Record<string, unknown>;
}

export function snapshotPart(mesh: ReturnType<typeof sourceMesh>, kinds: readonly string[]): PartSnapshot {
  const part: PartSnapshot["part"] = [];
  for (const kind of kinds) {
    const d = mesh.getVerticesData(kind);
    if (d) part.push({ kind, data: new Float32Array(d) });
  }
  return { part, metadata: forgeKeys(mesh.metadata as Record<string, unknown> | null) };
}

/** Put a {@link snapshotPart} back. */
export function restorePart(mesh: ReturnType<typeof sourceMesh>, snap: PartSnapshot): void {
  for (const { kind, data } of snap.part) mesh.updateVerticesData(kind, new Float32Array(data));
  putForgeKeys(mesh, snap.metadata);
}


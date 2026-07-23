import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { rebuildPolygons, triangulateFaces, type EditMesh } from "./half-edge";

/** Metadata key holding the polygon (quad / n-gon) structure — see build/commit. */
export const POLY_METADATA_KEY = "forge3dPolys";
/** Metadata key holding UV seam edge keys (string[] of "min_max" vertex pairs). */
export const SEAM_METADATA_KEY = "forge3dSeams";
/** Metadata key holding Catmull-Clark creases ([key, σ] pairs). */
export const CREASE_METADATA_KEY = "forge3dCreases";
/** Metadata key holding UV Editor pin vertex indices (number[]). */
export const UV_PIN_METADATA_KEY = "forge3dUVPins";

/**
 * Build an EditMesh from a Babylon Mesh.
 *
 * Time complexity: O(F) where F is the face count.
 *
 * Returns null if the mesh has no position data or no indices — callers
 * should fall back gracefully (typically by refusing to enter Edit Mode).
 *
 * Polygon restore (V2): if `mesh.metadata.forge3dPolys` holds a polygon list
 * whose fan triangulation matches the CURRENT index buffer exactly, the
 * EditMesh is rebuilt with those quads / n-gons. Any mismatch (sculpt dyntopo,
 * modifiers, decimate, … changed the triangles since the last commit) discards
 * the stale metadata and falls back to a triangle build. The equality check is
 * O(F) and makes stale-metadata corruption structurally impossible.
 *
 * Caveat: assumes vertices that share a 3D position but appear at different
 * indices are intentionally distinct (UV seams, normal seams). The edge-twin
 * lookup is keyed by **vertex index** — not position — which means seam-split
 * edges will appear as boundaries even when the surface is closed. V1 accepts
 * this; weld in advance if it matters.
 */
export function buildEditMesh(source: Mesh): EditMesh | null {
  const posData = source.getVerticesData(VertexBuffer.PositionKind);
  const indices = source.getIndices();
  if (!posData || !indices) return null;

  const positions = new Float32Array(posData);
  const numV = positions.length / 3;

  const em: EditMesh = {
    source,
    vertices: [],
    faces: [],
    halfEdges: [],
    positions,
    seams: new Set<string>(),
    creases: new Map<string, number>(),
    triToFace: [],
  };

  // Edge attributes (seams / creases) are keyed by vertex pairs, valid
  // regardless of the polygon match, so restore them either way.
  restoreEdgeAttrs(source, em, numV);

  const stored = readStoredPolys(source, numV);
  if (stored) {
    rebuildPolygons(em, positions, stored);
    const tri = triangulateFaces(em);
    if (sameIndices(tri.indices, indices)) {
      em.triToFace = tri.triToFace;
      return em;
    }
    // Stale — the index buffer changed since the polys were written.
    dropStoredPolys(source);
  }

  const numF = indices.length / 3;
  const triPolys: number[][] = new Array(numF);
  for (let f = 0; f < numF; f++) {
    triPolys[f] = [indices[f * 3]!, indices[f * 3 + 1]!, indices[f * 3 + 2]!];
  }
  rebuildPolygons(em, positions, triPolys);
  em.triToFace = new Array<number>(numF);
  for (let f = 0; f < numF; f++) em.triToFace[f] = f;
  return em;
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
      if (validEdgeKey(k, numV) && typeof s === "number" && s > 0) em.creases.set(k, s);
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

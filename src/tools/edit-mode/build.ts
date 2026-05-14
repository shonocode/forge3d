import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { EditMesh, HalfEdge } from "./half-edge";

/**
 * Build an EditMesh from a Babylon Mesh.
 *
 * Time complexity: O(F) where F is the triangle count.
 *
 * Returns null if the mesh has no position data or no indices — callers
 * should fall back gracefully (typically by refusing to enter Edit Mode).
 *
 * Caveat: assumes a triangle-only mesh and that vertices that share a 3D
 * position but appear at different indices are intentionally distinct (UV
 * seams, normal seams). The edge-twin lookup is keyed by **vertex index**
 * — not position — which means seam-split edges will appear as boundaries
 * even when the surface is closed. V1 accepts this; weld in advance if it
 * matters.
 */
export function buildEditMesh(source: Mesh): EditMesh | null {
  const posData = source.getVerticesData(VertexBuffer.PositionKind);
  const indices = source.getIndices();
  if (!posData || !indices) return null;

  const positions = new Float32Array(posData);
  const numV = positions.length / 3;
  const numF = indices.length / 3;

  const vertices = new Array<{ he: number }>(numV);
  for (let i = 0; i < numV; i++) vertices[i] = { he: -1 };

  const faces = new Array<{ he: number }>(numF);
  const halfEdges = new Array<HalfEdge>(numF * 3);

  // Map "vMin_vMax" -> first half-edge index seen for that undirected edge.
  // The second occurrence becomes the twin.
  const edgeMap = new Map<number, number>();
  const key = (a: number, b: number): number => (a < b ? a * numV + b : b * numV + a);

  for (let f = 0; f < numF; f++) {
    const a = indices[f * 3]!;
    const b = indices[f * 3 + 1]!;
    const c = indices[f * 3 + 2]!;
    const i0 = f * 3;
    const i1 = f * 3 + 1;
    const i2 = f * 3 + 2;

    halfEdges[i0] = { v: a, next: i1, twin: -1, face: f };
    halfEdges[i1] = { v: b, next: i2, twin: -1, face: f };
    halfEdges[i2] = { v: c, next: i0, twin: -1, face: f };
    faces[f] = { he: i0 };

    if (vertices[a]!.he < 0) vertices[a]!.he = i0;
    if (vertices[b]!.he < 0) vertices[b]!.he = i1;
    if (vertices[c]!.he < 0) vertices[c]!.he = i2;

    pairEdge(edgeMap, halfEdges, key(a, b), i0);
    pairEdge(edgeMap, halfEdges, key(b, c), i1);
    pairEdge(edgeMap, halfEdges, key(c, a), i2);
  }

  return { source, vertices, faces, halfEdges, positions, seams: new Set<string>() };
}

function pairEdge(
  edgeMap: Map<number, number>,
  halfEdges: HalfEdge[],
  k: number,
  heIdx: number,
): void {
  const existing = edgeMap.get(k);
  if (existing === undefined) {
    edgeMap.set(k, heIdx);
  } else {
    halfEdges[existing]!.twin = heIdx;
    halfEdges[heIdx]!.twin = existing;
  }
}

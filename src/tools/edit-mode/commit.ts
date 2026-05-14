import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { EditMesh } from "./half-edge";

/**
 * Write the EditMesh's position buffer back to the source Babylon mesh.
 *
 * Position-only path — topology unchanged. Used by the gizmo drag loop where
 * we hit this every pointer move. For topology-changing operators
 * (Extrude / Delete / etc.), use `commitTopology` instead.
 */
export function commitPositions(em: EditMesh): void {
  const mesh = em.source;
  mesh.updateVerticesData(VertexBuffer.PositionKind, em.positions);

  const indices = mesh.getIndices();
  if (indices) {
    const normals = new Float32Array(em.positions.length);
    VertexData.ComputeNormals(em.positions, indices, normals);
    mesh.updateVerticesData(VertexBuffer.NormalKind, normals);
  }
}

/**
 * Full geometry commit — writes positions, indices, **and** recomputed normals
 * back to the source mesh. Required after any operator that changes vertex
 * count or face count (Extrude, Delete, Bevel, …).
 *
 * Note on attributes: this Phase 3 commit only writes position / index /
 * normal. UV, vertex color, and skin-weight buffers are **not** kept in sync
 * yet — the design doc (§7.1) flags skin-weight preservation as a known
 * deferred risk. Operators that add vertices duplicate positions only; new
 * verts inherit no UVs and no weights. Acceptable for V1 modelling on
 * untextured prototypes; track for Phase 6 polish.
 */
export function commitTopology(em: EditMesh, indices: number[] | Uint32Array | Uint16Array): void {
  const mesh = em.source;
  // Apply via VertexData so Babylon refreshes bounding info and submeshes.
  const vd = new VertexData();
  vd.positions = new Float32Array(em.positions);
  const idxArr = indices instanceof Array ? indices.slice() : Array.from(indices);
  vd.indices = idxArr;
  const normals = new Float32Array(em.positions.length);
  VertexData.ComputeNormals(em.positions, idxArr, normals);
  vd.normals = normals;
  vd.applyToMesh(mesh, true);
}

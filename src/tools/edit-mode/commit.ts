import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { EditMesh } from "./half-edge";
import { transferAttribute, transferSkinWeights } from "./attribute-transfer";

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
 * Attribute preservation: UVs and skin weights (MatricesIndices/Weights) are
 * carried through the topology change. Original vertices keep their values
 * verbatim (the vertex buffer is never compacted in V1, so indices are
 * stable); new vertices sample the OLD surface at their position — closest
 * point, barycentric interpolation (see attribute-transfer.ts). At commit
 * time new verts always sit on the old surface (extrude duplicates in place,
 * bevel/loop-cut split existing edges), so the transfer is exact.
 */
export function commitTopology(em: EditMesh, indices: number[] | Uint32Array | Uint16Array): void {
  const mesh = em.source;

  // Snapshot old buffers BEFORE overwriting — they are the transfer source.
  const oldPos = mesh.getVerticesData(VertexBuffer.PositionKind);
  const oldIdx = mesh.getIndices();
  const oldUV = mesh.getVerticesData(VertexBuffer.UVKind);
  const oldMI = mesh.getVerticesData(VertexBuffer.MatricesIndicesKind);
  const oldMW = mesh.getVerticesData(VertexBuffer.MatricesWeightsKind);

  // Apply via VertexData so Babylon refreshes bounding info and submeshes.
  const vd = new VertexData();
  vd.positions = new Float32Array(em.positions);
  const idxArr = indices instanceof Array ? indices.slice() : Array.from(indices);
  vd.indices = idxArr;
  const normals = new Float32Array(em.positions.length);
  VertexData.ComputeNormals(em.positions, idxArr, normals);
  vd.normals = normals;

  if (oldPos && oldIdx) {
    if (oldUV) {
      vd.uvs = transferAttribute(oldPos, oldIdx, oldUV, em.positions, 2);
    }
    if (oldMI && oldMW) {
      const skin = transferSkinWeights(oldPos, oldIdx, oldMI, oldMW, em.positions);
      vd.matricesIndices = skin.matricesIndices;
      vd.matricesWeights = skin.matricesWeights;
    }
  }
  vd.applyToMesh(mesh, true);
}

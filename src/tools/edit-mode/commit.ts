import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { toPolygons, triangulateFaces, type EditMesh } from "./half-edge";
import { CREASE_METADATA_KEY, POLY_METADATA_KEY, SEAM_METADATA_KEY } from "./build";
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
 * Full geometry commit — fan-triangulates the EditMesh's polygons, writes
 * positions, indices, **and** recomputed normals back to the source mesh,
 * refreshes `em.triToFace`, and stores the polygon structure in
 * `mesh.metadata.forge3dPolys` so quads / n-gons survive leaving Edit Mode.
 * Required after any operator that changes vertex count or face count
 * (Extrude, Delete, Bevel, …).
 *
 * Attribute preservation: UVs and skin weights (MatricesIndices/Weights) are
 * carried through the topology change. Original vertices keep their values
 * verbatim (the vertex buffer is never compacted except by Merge, which
 * remaps); new vertices sample the OLD surface at their position — closest
 * point, barycentric interpolation (see attribute-transfer.ts). At commit
 * time new verts always sit on the old surface (extrude duplicates in place,
 * bevel/loop-cut split existing edges), so the transfer is exact.
 */
export function commitTopology(em: EditMesh): void {
  const mesh = em.source;
  const tri = triangulateFaces(em);
  em.triToFace = tri.triToFace;

  // Snapshot old buffers BEFORE overwriting — they are the transfer source.
  const oldPos = mesh.getVerticesData(VertexBuffer.PositionKind);
  const oldIdx = mesh.getIndices();
  const oldUV = mesh.getVerticesData(VertexBuffer.UVKind);
  const oldMI = mesh.getVerticesData(VertexBuffer.MatricesIndicesKind);
  const oldMW = mesh.getVerticesData(VertexBuffer.MatricesWeightsKind);

  // Apply via VertexData so Babylon refreshes bounding info and submeshes.
  const vd = new VertexData();
  vd.positions = new Float32Array(em.positions);
  const idxArr = tri.indices.slice();
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
  writePolyMetadata(em);
}

/**
 * Persist the polygon structure + edge attributes (seams / creases) on the
 * source mesh's metadata. build.ts validates polys against the index buffer
 * on the next Edit Mode entry (stale copy → discarded), and keeps in-range
 * seam / crease keys. This is what makes quads / seams / creases survive
 * leaving Edit Mode and .forge3d round-trips (the sidecar reads these keys).
 */
export function writePolyMetadata(em: EditMesh): void {
  const mesh = em.source;
  const meta = (mesh.metadata ?? {}) as Record<string, unknown>;
  meta[POLY_METADATA_KEY] = toPolygons(em);
  writeEdgeAttrMetadataInto(em, meta);
  mesh.metadata = meta;
}

/**
 * Persist only the edge attributes (seams / creases) — used by Mark Seam /
 * Mark Crease, which change these without a topology commit.
 */
export function writeEdgeAttrMetadata(em: EditMesh): void {
  const mesh = em.source;
  const meta = (mesh.metadata ?? {}) as Record<string, unknown>;
  writeEdgeAttrMetadataInto(em, meta);
  mesh.metadata = meta;
}

function writeEdgeAttrMetadataInto(em: EditMesh, meta: Record<string, unknown>): void {
  if (em.seams.size > 0) meta[SEAM_METADATA_KEY] = [...em.seams];
  else delete meta[SEAM_METADATA_KEY];
  if (em.creases.size > 0) meta[CREASE_METADATA_KEY] = [...em.creases];
  else delete meta[CREASE_METADATA_KEY];
}

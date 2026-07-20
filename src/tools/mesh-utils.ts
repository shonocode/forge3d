import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { shadeAutoSmooth } from "./auto-smooth";

/** Default edge style for all meshes in the scene */
export const DEFAULT_EDGE_COLOR = new Color4(0.2, 0.2, 0.35, 0.1);
export const DEFAULT_EDGE_WIDTH = 0.4;

/** Selection highlight edge style */
export const SELECTED_EDGE_COLOR = new Color4(0.36, 0.5, 1, 0.7);
export const SELECTED_EDGE_WIDTH = 2;

/** Apply default wireframe edge rendering to a mesh. Safe to call on any mesh. */
export function applyDefaultEdges(mesh: AbstractMesh): void {
  try {
    mesh.enableEdgesRendering();
    mesh.edgesWidth = DEFAULT_EDGE_WIDTH;
    mesh.edgesColor = DEFAULT_EDGE_COLOR;
  } catch { /* not all meshes support edge rendering */ }
}

/** Apply selection highlight edges to a mesh. */
export function applySelectedEdges(mesh: AbstractMesh): void {
  try {
    mesh.edgesColor = SELECTED_EDGE_COLOR;
    mesh.edgesWidth = SELECTED_EDGE_WIDTH;
  } catch { /* ignore */ }
}

/** Reset a mesh's edges back to default style. */
export function resetEdges(mesh: AbstractMesh): void {
  try {
    mesh.edgesColor = DEFAULT_EDGE_COLOR;
    mesh.edgesWidth = DEFAULT_EDGE_WIDTH;
  } catch { /* ignore */ }
}

// ── Mesh Cleanup Tools ──

export interface VertexSnapshot {
  positions: Float32Array;
  normals: Float32Array | null;
  indices: number[];
  uvs: Float32Array | null;
  matricesIndices: Float32Array | null;
  matricesWeights: Float32Array | null;
}

/** Capture current vertex data for undo */
export function snapshotVertexData(mesh: AbstractMesh): VertexSnapshot | null {
  const positions = mesh.getVerticesData("position");
  const normals = mesh.getVerticesData("normal");
  const indices = mesh.getIndices();
  if (!positions || !indices) return null;
  const uvs = mesh.getVerticesData("uv");
  const mi = mesh.getVerticesData("matricesIndices");
  const mw = mesh.getVerticesData("matricesWeights");
  return {
    positions: new Float32Array(positions),
    normals: normals ? new Float32Array(normals) : null,
    indices: Array.from(indices),
    uvs: uvs ? new Float32Array(uvs) : null,
    matricesIndices: mi ? new Float32Array(mi) : null,
    matricesWeights: mw ? new Float32Array(mw) : null,
  };
}

/** Restore vertex data from a snapshot */
export function restoreVertexData(mesh: AbstractMesh, snap: VertexSnapshot): void {
  const m = mesh as Mesh;
  const vd = new VertexData();
  vd.positions = new Float32Array(snap.positions);
  if (snap.normals) vd.normals = new Float32Array(snap.normals);
  vd.indices = snap.indices.slice();
  if (snap.uvs) vd.uvs = new Float32Array(snap.uvs);
  if (snap.matricesIndices && snap.matricesWeights) {
    vd.matricesIndices = new Float32Array(snap.matricesIndices);
    vd.matricesWeights = new Float32Array(snap.matricesWeights);
  }
  vd.applyToMesh(m);
}

/** Recalculate normals from current geometry */
export function recalcNormals(mesh: AbstractMesh): boolean {
  const positions = mesh.getVerticesData("position");
  const indices = mesh.getIndices();
  if (!positions || !indices) return false;
  const normals = new Float32Array(positions.length);
  VertexData.ComputeNormals(positions, indices, normals);
  (mesh as Mesh).setVerticesData("normal", normals);
  return true;
}

/** Flip normals — negate all normals and reverse triangle winding */
export function flipNormals(mesh: AbstractMesh): boolean {
  const normals = mesh.getVerticesData("normal");
  const indices = mesh.getIndices();
  if (!normals || !indices) return false;

  // Negate normals
  const flipped = new Float32Array(normals.length);
  for (let i = 0; i < normals.length; i++) flipped[i] = -normals[i]!;
  (mesh as Mesh).setVerticesData("normal", flipped);

  // Reverse winding order (swap indices in each triangle)
  const newIndices = Array.from(indices);
  for (let i = 0; i < newIndices.length; i += 3) {
    const tmp = newIndices[i]!;
    newIndices[i] = newIndices[i + 2]!;
    newIndices[i + 2] = tmp;
  }
  (mesh as Mesh).setIndices(newIndices);
  return true;
}

/** Weld (merge) vertices within a distance tolerance */
export function weldVertices(mesh: AbstractMesh, tolerance = 0.001): boolean {
  const positions = mesh.getVerticesData("position");
  const normals = mesh.getVerticesData("normal");
  const indices = mesh.getIndices();
  if (!positions || !indices) return false;

  const vertCount = positions.length / 3;
  const remap = new Int32Array(vertCount);
  const newPos: number[] = [];
  const newNor: number[] = [];
  let newCount = 0;
  const tol2 = tolerance * tolerance;

  for (let i = 0; i < vertCount; i++) {
    const ix = positions[i * 3]!;
    const iy = positions[i * 3 + 1]!;
    const iz = positions[i * 3 + 2]!;

    // Check against existing merged vertices
    let merged = -1;
    for (let j = 0; j < newCount; j++) {
      const dx = newPos[j * 3]! - ix;
      const dy = newPos[j * 3 + 1]! - iy;
      const dz = newPos[j * 3 + 2]! - iz;
      if (dx * dx + dy * dy + dz * dz < tol2) {
        merged = j;
        break;
      }
    }

    if (merged >= 0) {
      remap[i] = merged;
    } else {
      remap[i] = newCount;
      newPos.push(ix, iy, iz);
      if (normals) newNor.push(normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!);
      newCount++;
    }
  }

  if (newCount === vertCount) return false; // nothing to weld

  // Remap indices
  const newIndices: number[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const a = remap[indices[i]!]!;
    const b = remap[indices[i + 1]!]!;
    const c = remap[indices[i + 2]!]!;
    if (a !== b && b !== c && a !== c) newIndices.push(a, b, c); // skip degenerate
  }

  const m = mesh as Mesh;
  const vd = new VertexData();
  vd.positions = new Float32Array(newPos);
  if (normals) vd.normals = new Float32Array(newNor);
  vd.indices = newIndices;
  vd.applyToMesh(m);
  return true;
}

/**
 * Rebuild the mesh's normals with an angle threshold (see
 * `auto-smooth.shadeAutoSmooth`): π = Shade Smooth, ~0 = Shade Flat,
 * between = Blender's Auto Smooth. Splits vertices only across hard edges;
 * UVs and skin weights are carried per source vertex.
 *
 * Returns false (no-op) when the mesh has morph targets — their per-target
 * position buffers can't survive a vertex-count change.
 */
export function applyShading(mesh: AbstractMesh, angleRad: number): boolean {
  const positions = mesh.getVerticesData("position");
  const indices = mesh.getIndices();
  if (!positions || !indices) return false;
  if ((mesh as Mesh).morphTargetManager) return false;

  const uvs = mesh.getVerticesData("uv");
  const mi = mesh.getVerticesData("matricesIndices");
  const mw = mesh.getVerticesData("matricesWeights");

  const r = shadeAutoSmooth(positions, Array.from(indices), angleRad);

  const vd = new VertexData();
  vd.positions = r.positions;
  vd.indices = r.indices.slice();
  vd.normals = r.normals;
  const n = r.sourceVerts.length;
  if (uvs) {
    const outUV = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const s = r.sourceVerts[i]! * 2;
      outUV[i * 2] = uvs[s]!;
      outUV[i * 2 + 1] = uvs[s + 1]!;
    }
    vd.uvs = outUV;
  }
  if (mi && mw) {
    const outMI = new Float32Array(n * 4);
    const outMW = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const s = r.sourceVerts[i]! * 4;
      for (let k = 0; k < 4; k++) {
        outMI[i * 4 + k] = mi[s + k]!;
        outMW[i * 4 + k] = mw[s + k]!;
      }
    }
    vd.matricesIndices = outMI;
    vd.matricesWeights = outMW;
  }
  vd.applyToMesh(mesh as Mesh, true);
  return true;
}

/** Center origin — move the mesh pivot to geometry center */
export function centerOrigin(mesh: AbstractMesh): boolean {
  const positions = mesh.getVerticesData("position");
  if (!positions) return false;

  // Compute centroid
  const cx = new Vector3(0, 0, 0);
  const count = positions.length / 3;
  for (let i = 0; i < count; i++) {
    cx.x += positions[i * 3]!;
    cx.y += positions[i * 3 + 1]!;
    cx.z += positions[i * 3 + 2]!;
  }
  cx.scaleInPlace(1 / count);

  if (cx.length() < 0.0001) return false; // already centered

  // Shift vertices by -centroid
  const shifted = new Float32Array(positions.length);
  for (let i = 0; i < count; i++) {
    shifted[i * 3] = positions[i * 3]! - cx.x;
    shifted[i * 3 + 1] = positions[i * 3 + 1]! - cx.y;
    shifted[i * 3 + 2] = positions[i * 3 + 2]! - cx.z;
  }
  (mesh as Mesh).setVerticesData("position", shifted);

  // Offset world position to compensate
  mesh.position.addInPlace(cx);
  return true;
}

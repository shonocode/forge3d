import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { shadeAutoSmooth } from "./auto-smooth";
import { carryKeyedLists, readRenderTopology, restoreKeyedMetadata, snapshotKeyedMetadata } from "./edit-mode/build";
import { fanTriangulate, seamKey } from "./edit-mode/half-edge";

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
  /** The vertex-keyed lists in the metadata (compat-backlog C125). */
  keyed: Record<string, unknown>;
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
    keyed: snapshotKeyedMetadata(mesh),
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
  restoreKeyedMetadata(m, snap.keyed);
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

/**
 * Flip normals — negate all normals and reverse triangle winding. The vertices keep their numbers, so the weld list,
 * creases and seams stay and are signed for the rewound buffer; the polygons are reversed too — each keeps its first
 * corner, so its fan is the reversed triangles (compat-backlog C125: until then the signature stopped matching and
 * Edit Mode lost the weld and the quads).
 */
export function flipNormals(mesh: AbstractMesh): boolean {
  const normals = mesh.getVerticesData("normal");
  const indices = mesh.getIndices();
  if (!normals || !indices) return false;
  const before = readRenderTopology(mesh as Mesh);
  const polys = before?.polys?.map((p) => [p[0]!, ...p.slice(1).reverse()]) ?? null;

  // Negate normals
  const flipped = new Float32Array(normals.length);
  for (let i = 0; i < normals.length; i++) flipped[i] = -normals[i]!;
  (mesh as Mesh).setVerticesData("normal", flipped);

  // Reverse winding order (swap indices in each triangle, or fan the reversed polygons)
  const newIndices = polys ? polys.flatMap(fanTriangulate) : Array.from(indices);
  if (!polys)
    for (let i = 0; i < newIndices.length; i += 3) {
      const tmp = newIndices[i]!;
      newIndices[i] = newIndices[i + 2]!;
      newIndices[i + 2] = tmp;
    }
  (mesh as Mesh).setIndices(newIndices);
  if (before) carryKeyedLists(mesh as Mesh, { ...before, polys }, Array.from({ length: normals.length / 3 }, (_, v) => v));
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
  const before = readRenderTopology(m);
  const vd = new VertexData();
  vd.positions = new Float32Array(newPos);
  if (normals) vd.normals = new Float32Array(newNor);
  vd.indices = newIndices;
  vd.applyToMesh(m);
  // Nothing coincident is left to tell apart, so a weld list becomes one number per vertex; the creases and seams follow
  // their ends, and the polygons when no corner of one merged into another (compat-backlog C125).
  if (before) {
    const creases = new Map<string, number>();
    const seams = new Set<string>();
    const key = (k: string): string => {
      const [a, b] = k.split("_").map(Number) as [number, number];
      return seamKey(remap[a]!, remap[b]!);
    };
    for (const [k, c] of before.creases) creases.set(key(k), Math.max(c, creases.get(key(k)) ?? 0));
    for (const k of before.seams) seams.add(key(k));
    const polys = before.polys?.map((p) => p.map((v) => remap[v]!)) ?? null;
    const identity = Array.from({ length: newCount }, (_, v) => v);
    carryKeyedLists(m, { weld: before.weld ? identity : null, creases, seams, polys }, identity);
  }
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

  const before = readRenderTopology(mesh as Mesh);
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
  // The vertices it split are one vertex of the surface: each keeps the weld number of its source — or the source's own
  // number when the buffer had no list, so what was apart before stays apart (compat-backlog C125; the CSG result comes
  // through here too).
  if (before)
    carryKeyedLists(mesh as Mesh, { ...before, weld: before.weld ?? Array.from({ length: positions.length / 3 }, (_, v) => v) }, r.sourceVerts);
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

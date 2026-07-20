import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import type { LinesMesh } from "@babylonjs/core/Meshes/linesMesh";
import { creaseOf, edgeEnd, edgeOrigin, faceVerts, forEachEdge, isSeam, type EditMesh } from "./half-edge";
import type { EditSelection } from "../../state";

const SELECTED_RGB: [number, number, number] = [1, 0.85, 0.15];
const UNSELECTED_VERTEX: [number, number, number] = [1, 1, 1];
const UNSELECTED_EDGE: [number, number, number] = [0.55, 0.55, 0.7];
const SEAM_RGB: [number, number, number] = [1, 0.25, 0.2];
const SEAM_SELECTED_RGB: [number, number, number] = [1, 0.55, 0.15]; // orange = both selected and seam
const CREASE_RGB: [number, number, number] = [0.2, 0.85, 1]; // cyan = Catmull-Clark crease
const CREASE_SELECTED_RGB: [number, number, number] = [0.55, 0.95, 1];

/**
 * Component overlay: three child meshes attached to the source mesh (so they
 * inherit its world transform). Rebuilt on selection or geometry change.
 *
 * - `vertices`: point-cloud mesh with per-vertex colors
 * - `edges`: line system with per-segment colors
 * - `faces`: thin overlay mesh with the selected face triangles
 */
export interface EditOverlay {
  vertices: Mesh;
  edges: LinesMesh | null;
  faces: Mesh | null;
  dispose(): void;
}

export function createOverlay(scene: Scene, em: EditMesh): EditOverlay {
  const vertices = new Mesh("edit-overlay-verts", scene);
  vertices.parent = em.source;
  vertices.isPickable = false;
  vertices.renderingGroupId = 1;
  vertices.alwaysSelectAsActiveMesh = true;
  vertices.material = makePointMaterial(scene);

  return {
    vertices,
    edges: null,
    faces: null,
    dispose() {
      vertices.material?.dispose();
      vertices.dispose();
      this.edges?.dispose();
      this.faces?.material?.dispose();
      this.faces?.dispose();
    },
  };
}

function makePointMaterial(scene: Scene): StandardMaterial {
  const m = new StandardMaterial("edit-overlay-vert-mat", scene);
  m.disableLighting = true;
  m.emissiveColor = Color3.White();
  m.pointsCloud = true;
  m.pointSize = 8;
  m.zOffset = -2; // pull verts in front of the source surface to avoid z-fight
  return m;
}

function makeFaceMaterial(scene: Scene): StandardMaterial {
  const m = new StandardMaterial("edit-overlay-face-mat", scene);
  m.disableLighting = true;
  m.emissiveColor = new Color3(SELECTED_RGB[0], SELECTED_RGB[1], SELECTED_RGB[2]);
  m.alpha = 0.35;
  m.backFaceCulling = false;
  m.zOffset = -1;
  return m;
}

/**
 * Rebuild all three overlay meshes. Call on selection change, mode change, or
 * after geometry edits (gizmo drag).
 */
export function rebuildOverlay(
  scene: Scene,
  overlay: EditOverlay,
  em: EditMesh,
  sel: EditSelection,
): void {
  rebuildVertices(overlay, em, sel);
  overlay.edges?.dispose();
  overlay.edges = buildEdgeLines(scene, em, sel);
  overlay.faces?.dispose();
  overlay.faces = buildFaceHighlight(scene, em, sel);
}

function rebuildVertices(overlay: EditOverlay, em: EditMesh, sel: EditSelection): void {
  const numV = em.vertices.length;
  const positions = new Float32Array(em.positions);
  const colors = new Float32Array(numV * 4);
  const indices = new Array<number>(numV);

  const showSelected = sel.mode === "vertex";
  for (let v = 0; v < numV; v++) {
    indices[v] = v;
    const isSel = showSelected && sel.indices.has(v);
    const rgb = isSel ? SELECTED_RGB : UNSELECTED_VERTEX;
    colors[v * 4] = rgb[0];
    colors[v * 4 + 1] = rgb[1];
    colors[v * 4 + 2] = rgb[2];
    colors[v * 4 + 3] = 1;
  }

  const vd = new VertexData();
  vd.positions = positions;
  vd.colors = colors;
  vd.indices = indices;
  vd.applyToMesh(overlay.vertices, true);
  overlay.vertices.useVertexColors = true;
}

function buildEdgeLines(scene: Scene, em: EditMesh, sel: EditSelection): LinesMesh {
  const lines: Vector3[][] = [];
  const colors: Color4[][] = [];
  const showSelected = sel.mode === "edge";

  forEachEdge(em, (he) => {
    const a = edgeOrigin(em, he);
    const b = edgeEnd(em, he);
    const pa = new Vector3(em.positions[a * 3]!, em.positions[a * 3 + 1]!, em.positions[a * 3 + 2]!);
    const pb = new Vector3(em.positions[b * 3]!, em.positions[b * 3 + 1]!, em.positions[b * 3 + 2]!);
    const isSel = showSelected && sel.indices.has(he);
    const isSeamEdge = isSeam(em, he);
    const isCreaseEdge = creaseOf(em, he) > 0;
    let rgb: [number, number, number];
    let alpha: number;
    // Priority: selected+seam > selected+crease > selected > seam > crease > plain.
    if (isSel && isSeamEdge) { rgb = SEAM_SELECTED_RGB; alpha = 1; }
    else if (isSel && isCreaseEdge) { rgb = CREASE_SELECTED_RGB; alpha = 1; }
    else if (isSel) { rgb = SELECTED_RGB; alpha = 1; }
    else if (isSeamEdge) { rgb = SEAM_RGB; alpha = 1; }
    else if (isCreaseEdge) { rgb = CREASE_RGB; alpha = 1; }
    else { rgb = UNSELECTED_EDGE; alpha = 0.7; }
    const c = new Color4(rgb[0], rgb[1], rgb[2], alpha);
    lines.push([pa, pb]);
    colors.push([c, c]);
  });

  const mesh = MeshBuilder.CreateLineSystem("edit-overlay-edges", { lines, colors }, scene);
  mesh.parent = em.source;
  mesh.isPickable = false;
  mesh.renderingGroupId = 1;
  return mesh;
}

function buildFaceHighlight(scene: Scene, em: EditMesh, sel: EditSelection): Mesh | null {
  if (sel.mode !== "face" || sel.indices.size === 0) return null;

  const positions: number[] = [];
  const indices: number[] = [];
  let cursor = 0;

  for (const f of sel.indices) {
    if (f < 0 || f >= em.faces.length) continue;
    // Fan-triangulate the polygon into the highlight mesh (n-gon aware).
    const verts = faceVerts(em, f);
    for (const v of verts) {
      positions.push(em.positions[v * 3]!, em.positions[v * 3 + 1]!, em.positions[v * 3 + 2]!);
    }
    for (let i = 1; i + 1 < verts.length; i++) {
      indices.push(cursor, cursor + i, cursor + i + 1);
    }
    cursor += verts.length;
  }

  if (positions.length === 0) return null;

  const mesh = new Mesh("edit-overlay-faces", scene);
  mesh.parent = em.source;
  mesh.isPickable = false;
  mesh.renderingGroupId = 1;
  const vd = new VertexData();
  vd.positions = new Float32Array(positions);
  vd.indices = indices;
  vd.applyToMesh(mesh, false);
  mesh.material = makeFaceMaterial(scene);
  return mesh;
}

/**
 * Update only the position buffers of the overlay meshes — no allocation
 * churn. Used during gizmo drag (vertex set unchanged, positions change every
 * frame).
 */
export function refreshOverlayPositions(scene: Scene, overlay: EditOverlay, em: EditMesh, sel: EditSelection): void {
  // Vertices: just write the position buffer.
  overlay.vertices.updateVerticesData(VertexBuffer.PositionKind, em.positions);
  // Edges and faces: rebuild (line/face vertex counts may differ from vertex
  // count, so per-buffer update is awkward; rebuild is simpler and still cheap
  // for the meshes we care about).
  overlay.edges?.dispose();
  overlay.edges = buildEdgeLines(scene, em, sel);
  overlay.faces?.dispose();
  overlay.faces = buildFaceHighlight(scene, em, sel);
}

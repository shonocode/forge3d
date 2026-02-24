import { Color4 } from "@babylonjs/core/Maths/math.color";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";

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

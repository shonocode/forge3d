import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { state } from "../state";
import { updateHierarchy, updateProperties } from "../ui/panels";
import { applySelectedEdges, resetEdges } from "./mesh-utils";

export function selectMesh(mesh: AbstractMesh | null, additive: boolean): void {
  if (!additive) {
    for (const m of state.selectedMeshes) {
      resetEdges(m);
    }
    state.selectedMeshes = [];
  }
  if (mesh && !state.selectedMeshes.includes(mesh)) {
    state.selectedMeshes.push(mesh);
    applySelectedEdges(mesh);
  }
  updateGizmo();
  updateHierarchy();
  updateProperties();
}

export function deselect(): void {
  selectMesh(null, false);
}

export function lastSelected(): AbstractMesh | undefined {
  return state.selectedMeshes[state.selectedMeshes.length - 1];
}

export function updateGizmo(): void {
  const { gizmoManager: gm, tool, selectedMeshes } = state;

  // Non-transform tools: detach first, then disable (order matters for Babylon.js internals)
  if (tool === "sculpt" || tool === "paint" || tool === "bone" || tool === "weight" || tool === "anim") {
    try {
      gm.attachToMesh(null);
      gm.positionGizmoEnabled = false;
      gm.rotationGizmoEnabled = false;
      gm.scaleGizmoEnabled = false;
    } catch { /* ignore */ }
    return;
  }

  try {
    gm.positionGizmoEnabled = false;
    gm.rotationGizmoEnabled = false;
    gm.scaleGizmoEnabled = false;

    if (!selectedMeshes.length) {
      gm.attachToMesh(null);
      return;
    }
    gm.attachToMesh(lastSelected()!);
    if (tool === "move") gm.positionGizmoEnabled = true;
    else if (tool === "rotate") gm.rotationGizmoEnabled = true;
    else if (tool === "scale") gm.scaleGizmoEnabled = true;
  } catch { /* ignore gizmo errors */ }
}

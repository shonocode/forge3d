import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { state, status } from "../state";
import { selectMesh, lastSelected, updateGizmo } from "./selection";
import { updateHierarchy, updateProperties } from "../ui/panels";
import { applyDefaultEdges } from "./mesh-utils";

export function duplicateSelected(): void {
  if (!state.selectedMeshes.length) return;
  const m = lastSelected()!;
  state.meshCounter++;
  const c = m.clone(m.name + "_cp" + state.meshCounter, null);
  if (!c) {
    status("⚠ 複製失敗");
    return;
  }
  c.position.x += 2;
  c.isPickable = true;
  applyDefaultEdges(c);
  state.allMeshes.push(c);
  selectMesh(c, false);
  updateHierarchy();
  status("複製");
}

/** Dispose all resources associated with a mesh */
function cleanupMesh(m: AbstractMesh): void {
  // Paint texture cleanup
  const tex = state.paintTextureMap.get(m.uniqueId);
  if (tex) {
    tex.dispose();
    state.paintTextureMap.delete(m.uniqueId);
  }
  // Morph target manager cleanup
  const morph = state.morphMap.get(m.uniqueId);
  if (morph) {
    morph.manager.dispose();
    state.morphMap.delete(m.uniqueId);
  }
  // Map instance cleanup
  state.mapInstances = state.mapInstances.filter(
    (mi) => !mi.meshUniqueIds.includes(m.uniqueId)
  );
  // Remove from allMeshes
  const idx = state.allMeshes.indexOf(m);
  if (idx >= 0) state.allMeshes.splice(idx, 1);
  m.dispose();
}

export function deleteSelected(): void {
  if (!state.selectedMeshes.length) return;
  for (const m of state.selectedMeshes) {
    cleanupMesh(m);
  }
  state.selectedMeshes = [];
  updateGizmo();
  updateHierarchy();
  updateProperties();
  status("削除");
}

export function deleteOne(name: string): void {
  const m = state.allMeshes.find((x) => x.name === name);
  if (!m) return;
  state.selectedMeshes = state.selectedMeshes.filter((x) => x !== m);
  cleanupMesh(m);
  updateHierarchy();
  updateProperties();
}

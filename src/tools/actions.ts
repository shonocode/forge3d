import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { MorphTargetManager } from "@babylonjs/core/Morph/morphTargetManager";
import { MorphTarget } from "@babylonjs/core/Morph/morphTarget";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { state, status } from "../state";
import { selectMesh, lastSelected, updateGizmo } from "./selection";
import { updateHierarchy, updateProperties } from "../ui/panels";
import { applyDefaultEdges } from "./mesh-utils";
import { addShadowCaster, removeShadowCaster } from "../viewport/shadows";
import { unregisterMeshForShading } from "../viewport/shading";
import { removeMeshFromLayers } from "./layers";

const TEX_SIZE = 1024;

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

  // Clone paint texture if exists
  const srcTex = state.paintTextureMap.get(m.uniqueId);
  if (srcTex) {
    const newTex = new DynamicTexture(
      "paintTex_" + c.uniqueId,
      TEX_SIZE,
      state.scene,
      true
    );
    const srcCtx = srcTex.getContext() as CanvasRenderingContext2D | null;
    const dstCtx = newTex.getContext() as CanvasRenderingContext2D | null;
    if (srcCtx && dstCtx) {
      dstCtx.drawImage(srcCtx.canvas, 0, 0);
      newTex.update();
    }
    const mat = c.material as PBRMaterial | null;
    if (mat && "albedoTexture" in mat) mat.albedoTexture = newTex;
    state.paintTextureMap.set(c.uniqueId, newTex);
  }

  // Clone morph targets if exists
  const srcMorph = state.morphMap.get(m.uniqueId);
  if (srcMorph && srcMorph.targets.length > 0) {
    const mm = new MorphTargetManager();
    const clonedTargets: import("@babylonjs/core").MorphTarget[] = [];
    for (const t of srcMorph.targets) {
      const ct = new MorphTarget(t.name, t.influence, state.scene);
      const tPos = t.getPositions();
      const tNor = t.getNormals();
      if (tPos) ct.setPositions(new Float32Array(tPos));
      if (tNor) ct.setNormals(new Float32Array(tNor));
      mm.addTarget(ct);
      clonedTargets.push(ct);
    }
    c.morphTargetManager = mm;
    state.morphMap.set(c.uniqueId, { manager: mm, targets: clonedTargets });
  }

  // Note: skeleton/weight data is not duplicated (complex bone index remapping)
  if (m.skeleton) {
    status("複製 (※スケルトン/ウェイトは未複製)");
  } else {
    status("複製");
  }

  addShadowCaster(c);
  state.allMeshes.push(c);
  selectMesh(c, false);
  updateHierarchy();

  // Undo: remove clone; Redo: re-add
  const clone = c;
  state.history.push({
    label: "Duplicate",
    undo() {
      clone.setEnabled(false);
      removeShadowCaster(clone);
      const idx = state.allMeshes.indexOf(clone);
      if (idx >= 0) state.allMeshes.splice(idx, 1);
      state.selectedMeshes = state.selectedMeshes.filter((x) => x !== clone);
      updateGizmo();
      updateHierarchy();
    },
    redo() {
      clone.setEnabled(true);
      addShadowCaster(clone);
      state.allMeshes.push(clone);
      selectMesh(clone, false);
      updateHierarchy();
    },
  });
}

/** Dispose all resources associated with a mesh */
export function cleanupMesh(m: AbstractMesh): void {
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
  // Skeleton assignment cleanup
  for (const [, skelData] of state.skeletonMap) {
    if (skelData.assignedMesh === m) {
      skelData.assignedMesh = null;
    }
  }
  // Modifier stack cleanup
  state.modifierMap.delete(m.uniqueId);
  state.originalGeometryMap.delete(m.uniqueId);
  // Map instance cleanup
  state.mapInstances = state.mapInstances.filter(
    (mi) => !mi.meshUniqueIds.includes(m.uniqueId)
  );
  removeShadowCaster(m);
  unregisterMeshForShading(m);
  removeMeshFromLayers(m);
  // Remove from allMeshes
  const idx = state.allMeshes.indexOf(m);
  if (idx >= 0) state.allMeshes.splice(idx, 1);
  m.dispose();
}

export function deleteSelected(): void {
  if (!state.selectedMeshes.length) return;
  const deleted = [...state.selectedMeshes];

  // Save parent relationships for undo, then detach children
  const parentMap = new Map<number, import("@babylonjs/core").AbstractMesh | null>();
  for (const m of deleted) {
    parentMap.set(m.uniqueId, (m.parent as import("@babylonjs/core").AbstractMesh) ?? null);
    // Detach children so they become root
    for (const child of state.allMeshes) {
      if (child.parent === m && !deleted.includes(child)) {
        child.setParent(null);
      }
    }
  }

  // Soft-delete: hide and remove from arrays but don't dispose
  for (const m of deleted) {
    m.setEnabled(false);
    removeShadowCaster(m);
    const idx = state.allMeshes.indexOf(m);
    if (idx >= 0) state.allMeshes.splice(idx, 1);
  }
  state.selectedMeshes = [];
  updateGizmo();
  updateHierarchy();
  updateProperties();

  state.history.push({
    label: "Delete",
    undo() {
      for (const m of deleted) {
        m.setEnabled(true);
        addShadowCaster(m);
        state.allMeshes.push(m);
      }
      // Restore parent relationships
      for (const m of deleted) {
        const p = parentMap.get(m.uniqueId);
        if (p) m.setParent(p);
      }
      selectMesh(deleted[deleted.length - 1]!, false);
      updateHierarchy();
      updateProperties();
    },
    redo() {
      for (const m of deleted) {
        for (const child of state.allMeshes) {
          if (child.parent === m) child.setParent(null);
        }
        m.setEnabled(false);
        removeShadowCaster(m);
        const idx = state.allMeshes.indexOf(m);
        if (idx >= 0) state.allMeshes.splice(idx, 1);
        state.selectedMeshes = state.selectedMeshes.filter((x) => x !== m);
      }
      updateGizmo();
      updateHierarchy();
      updateProperties();
    },
  });

  status("削除");
}

export function deleteOne(uid: number): void {
  const m = state.allMeshes.find((x) => x.uniqueId === uid);
  if (!m) return;

  // Soft-delete (not dispose) for undo support
  m.setEnabled(false);
  removeShadowCaster(m);
  state.selectedMeshes = state.selectedMeshes.filter((x) => x !== m);
  const idx = state.allMeshes.indexOf(m);
  if (idx >= 0) state.allMeshes.splice(idx, 1);
  updateGizmo();
  updateHierarchy();
  updateProperties();

  state.history.push({
    label: "Delete",
    undo() {
      m.setEnabled(true);
      addShadowCaster(m);
      state.allMeshes.push(m);
      selectMesh(m, false);
      updateHierarchy();
      updateProperties();
    },
    redo() {
      m.setEnabled(false);
      removeShadowCaster(m);
      const i = state.allMeshes.indexOf(m);
      if (i >= 0) state.allMeshes.splice(i, 1);
      state.selectedMeshes = state.selectedMeshes.filter((x) => x !== m);
      updateGizmo();
      updateHierarchy();
      updateProperties();
    },
  });
  status("削除");
}

import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { state, status } from "../state";
import type { LayerData } from "../state";
import { updateLayerUI } from "../ui/panels";

export function createLayer(name?: string): LayerData {
  state.layerCounter++;
  const layer: LayerData = {
    id: "layer_" + state.layerCounter,
    name: name ?? "Layer " + state.layerCounter,
    visible: true,
  };
  state.layers.push(layer);
  const prevActiveId = state.activeLayerId;
  state.activeLayerId = layer.id;
  status("Layer created: " + layer.name);

  state.history.push({
    label: "Create Layer",
    undo() {
      const i = state.layers.indexOf(layer);
      if (i >= 0) state.layers.splice(i, 1);
      state.activeLayerId = prevActiveId;
      updateLayerUI();
    },
    redo() {
      state.layers.push(layer);
      state.activeLayerId = layer.id;
      updateLayerUI();
    },
  });

  return layer;
}

export function deleteLayer(layerId: string): void {
  if (state.layers.length <= 1) {
    status("最後のレイヤーは削除不可");
    return;
  }
  const idx = state.layers.findIndex((l) => l.id === layerId);
  if (idx < 0) return;
  const layer = state.layers[idx]!;
  const prevActiveId = state.activeLayerId;

  // Save mesh assignments before moving
  const movedMeshes: [number, string][] = [];
  const fallbackId = state.layers.find((l) => l.id !== layerId)!.id;
  for (const [uid, lid] of state.meshLayerMap) {
    if (lid === layerId) {
      movedMeshes.push([uid, lid]);
      state.meshLayerMap.set(uid, fallbackId);
    }
  }

  state.layers.splice(idx, 1);
  if (state.activeLayerId === layerId) {
    state.activeLayerId = fallbackId;
  }
  status("Layer deleted");

  state.history.push({
    label: "Delete Layer",
    undo() {
      state.layers.splice(idx, 0, layer);
      for (const [uid, lid] of movedMeshes) state.meshLayerMap.set(uid, lid);
      state.activeLayerId = prevActiveId;
      updateLayerUI();
    },
    redo() {
      const i = state.layers.indexOf(layer);
      if (i >= 0) state.layers.splice(i, 1);
      for (const [uid] of movedMeshes) state.meshLayerMap.set(uid, fallbackId);
      if (state.activeLayerId === layerId) state.activeLayerId = fallbackId;
      updateLayerUI();
    },
  });
}

export function setActiveLayer(layerId: string): void {
  if (state.layers.find((l) => l.id === layerId)) {
    state.activeLayerId = layerId;
  }
}

export function toggleLayerVisibility(layerId: string): void {
  const layer = state.layers.find((l) => l.id === layerId);
  if (!layer) return;
  const wasVisible = layer.visible;
  layer.visible = !wasVisible;

  // Show/hide all meshes on this layer
  applyLayerVisibility(layerId, layer.visible);

  state.history.push({
    label: "Toggle Layer",
    undo() { layer.visible = wasVisible; applyLayerVisibility(layerId, wasVisible); updateLayerUI(); },
    redo() { layer.visible = !wasVisible; applyLayerVisibility(layerId, !wasVisible); updateLayerUI(); },
  });
}

function applyLayerVisibility(layerId: string, visible: boolean): void {
  for (const mesh of state.allMeshes) {
    if (state.meshLayerMap.get(mesh.uniqueId) === layerId) {
      mesh.setEnabled(visible);
    }
  }
}

export function assignMeshToLayer(mesh: AbstractMesh, layerId: string): void {
  state.meshLayerMap.set(mesh.uniqueId, layerId);
  // Respect layer visibility
  const layer = state.layers.find((l) => l.id === layerId);
  if (layer && !layer.visible) mesh.setEnabled(false);
}

export function getMeshesOnLayer(layerId: string): AbstractMesh[] {
  return state.allMeshes.filter((m) => state.meshLayerMap.get(m.uniqueId) === layerId);
}

/** Assign mesh to active layer (convenience for primitives/imports) */
export function assignToActiveLayer(mesh: AbstractMesh): void {
  assignMeshToLayer(mesh, state.activeLayerId);
}

/** Remove mesh from layer map (cleanup) */
export function removeMeshFromLayers(mesh: AbstractMesh): void {
  state.meshLayerMap.delete(mesh.uniqueId);
}

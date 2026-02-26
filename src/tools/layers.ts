import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { state, status } from "../state";
import type { LayerData } from "../state";

export function createLayer(name?: string): LayerData {
  state.layerCounter++;
  const layer: LayerData = {
    id: "layer_" + state.layerCounter,
    name: name ?? "Layer " + state.layerCounter,
    visible: true,
  };
  state.layers.push(layer);
  state.activeLayerId = layer.id;
  status("Layer created: " + layer.name);
  return layer;
}

export function deleteLayer(layerId: string): void {
  if (state.layers.length <= 1) {
    status("最後のレイヤーは削除不可");
    return;
  }
  const idx = state.layers.findIndex((l) => l.id === layerId);
  if (idx < 0) return;

  // Move meshes to the first available layer
  const fallbackId = state.layers.find((l) => l.id !== layerId)!.id;
  for (const [uid, lid] of state.meshLayerMap) {
    if (lid === layerId) state.meshLayerMap.set(uid, fallbackId);
  }

  state.layers.splice(idx, 1);
  if (state.activeLayerId === layerId) {
    state.activeLayerId = fallbackId;
  }
  status("Layer deleted");
}

export function setActiveLayer(layerId: string): void {
  if (state.layers.find((l) => l.id === layerId)) {
    state.activeLayerId = layerId;
  }
}

export function toggleLayerVisibility(layerId: string): void {
  const layer = state.layers.find((l) => l.id === layerId);
  if (!layer) return;
  layer.visible = !layer.visible;

  // Show/hide all meshes on this layer
  for (const mesh of state.allMeshes) {
    const meshLayerId = state.meshLayerMap.get(mesh.uniqueId);
    if (meshLayerId === layerId) {
      mesh.setEnabled(layer.visible);
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

import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { state, status } from "../state";
import type { MapInstance } from "../state";
import { modelStore } from "../storage/model-store";
import { metadataStore, type ModelMetadata } from "../storage/metadata-store";
import { selectMesh } from "./selection";
import { updateHierarchy, updateMapInstances } from "../ui/panels";
import { applyDefaultEdges } from "./mesh-utils";
import { addShadowCaster, removeShadowCaster } from "../viewport/shadows";
import { unregisterMeshForShading } from "../viewport/shading";
import { removeMeshFromLayers } from "./layers";
import { openFileDialog } from "../ui/file-input";

// ── Scene Layout types ──

export interface SceneLayoutObject {
  instanceId: string;
  modelId: string;
  modelName: string;
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
}

export interface SceneLayout {
  version: 1;
  name: string;
  timestamp: number;
  objects: SceneLayoutObject[];
}

// ── Model Library ──

export async function loadModelLibrary(): Promise<ModelMetadata[]> {
  try {
    return await metadataStore.getAll();
  } catch (e) {
    console.error("Failed to load model library:", e);
    return [];
  }
}

export async function deleteFromLibrary(modelId: string): Promise<void> {
  try {
    await modelStore.delete(modelId);
    await metadataStore.delete(modelId);
    status("Model deleted from library");
  } catch (e) {
    console.error("Delete error:", e);
    status("⚠ Delete error");
  }
}

// ── Model Placement ──

export async function placeModel(modelId: string, modelName: string): Promise<void> {
  try {
    status("Loading model...");
    await import("@babylonjs/loaders/glTF");
    const data = await modelStore.load(modelId);
    if (!data) {
      status("⚠ Model not found in storage");
      return;
    }

    const blob = new Blob([data], { type: "model/gltf-binary" });
    const url = URL.createObjectURL(blob);

    try {
      const result = await SceneLoader.ImportMeshAsync("", url, "", state.scene, null, ".glb");
      const instanceId = crypto.randomUUID();
      const meshUniqueIds: number[] = [];

      for (const mesh of result.meshes) {
        if (mesh.name === "__root__") continue;
        mesh.isPickable = true;
        applyDefaultEdges(mesh);

        // Tag mesh for map tracking
        if (!mesh.metadata) mesh.metadata = {};
        mesh.metadata.mapModelId = modelId;
        mesh.metadata.mapInstanceId = instanceId;

        addShadowCaster(mesh);
        meshUniqueIds.push(mesh.uniqueId);
        state.allMeshes.push(mesh);
      }

      const instance: MapInstance = {
        instanceId,
        modelId,
        modelName,
        meshUniqueIds,
      };
      state.mapInstances.push(instance);

      // Undo support for placement
      const iid = instanceId;
      state.history.push({
        label: "Place Model",
        undo() { removeMapInstance(iid); },
        redo() { void placeModel(modelId, modelName).then(() => {
          updateHierarchy();
        }).catch((e) => {
          console.warn("Redo place failed:", e);
          status("\u26a0 Redo failed");
        }); },
      });

      // Select the last imported mesh
      const lastMesh = result.meshes[result.meshes.length - 1];
      if (lastMesh) selectMesh(lastMesh, false);

      updateHierarchy();
      status("Placed: " + modelName);
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch (e) {
    console.error("Place model error:", e);
    status("⚠ Place error: " + (e as Error).message);
  }
}

export function removeMapInstance(instanceId: string): void {
  const idx = state.mapInstances.findIndex((m) => m.instanceId === instanceId);
  if (idx === -1) return;

  const instance = state.mapInstances[idx]!;

  // Remove meshes from scene
  for (const uid of instance.meshUniqueIds) {
    const meshIdx = state.allMeshes.findIndex((m) => m.uniqueId === uid);
    if (meshIdx !== -1) {
      const mesh = state.allMeshes[meshIdx]!;
      // Deselect if selected
      const selIdx = state.selectedMeshes.indexOf(mesh);
      if (selIdx !== -1) state.selectedMeshes.splice(selIdx, 1);
      removeShadowCaster(mesh);
      // Cleanup associated resources (paint, morph, skeleton, modifiers, shading, layers)
      const paintTex = state.paintTextureMap.get(mesh.uniqueId);
      if (paintTex) { paintTex.dispose(); state.paintTextureMap.delete(mesh.uniqueId); }
      const morph = state.morphMap.get(mesh.uniqueId);
      if (morph) { morph.manager.dispose(); state.morphMap.delete(mesh.uniqueId); }
      for (const [, skelData] of state.skeletonMap) {
        if (skelData.assignedMesh === mesh) skelData.assignedMesh = null;
      }
      state.modifierMap.delete(mesh.uniqueId);
      state.originalGeometryMap.delete(mesh.uniqueId);
      unregisterMeshForShading(mesh);
      removeMeshFromLayers(mesh);
      mesh.dispose();
      state.allMeshes.splice(meshIdx, 1);
    }
  }

  state.mapInstances.splice(idx, 1);
  updateHierarchy();
  status("Removed: " + instance.modelName);
}

export function clearAllMapInstances(): void {
  // Remove in reverse to avoid index issues
  while (state.mapInstances.length > 0) {
    removeMapInstance(state.mapInstances[state.mapInstances.length - 1]!.instanceId);
  }
  status("Scene cleared");
}

// ── Scene Layout Export / Import ──

export function exportSceneLayout(name: string): void {
  if (state.mapInstances.length === 0) {
    status("⚠ No placed models to export");
    return;
  }

  const objects: SceneLayoutObject[] = [];

  for (const inst of state.mapInstances) {
    // Find the first mesh of this instance for transform
    const mesh = state.allMeshes.find((m) => inst.meshUniqueIds.includes(m.uniqueId));
    if (!mesh) continue;

    objects.push({
      instanceId: inst.instanceId,
      modelId: inst.modelId,
      modelName: inst.modelName,
      position: { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z },
      rotation: { x: mesh.rotation.x, y: mesh.rotation.y, z: mesh.rotation.z },
      scale: { x: mesh.scaling.x, y: mesh.scaling.y, z: mesh.scaling.z },
    });
  }

  const layout: SceneLayout = {
    version: 1,
    name: name || "Untitled Layout",
    timestamp: Date.now(),
    objects,
  };

  const json = JSON.stringify(layout, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = (name || "layout") + ".json";
  a.click();
  URL.revokeObjectURL(url);
  status("Layout exported: " + layout.name);
}

export function importSceneLayout(): void {
  openFileDialog(".json", async (file) => {
    try {
      status("Importing layout...");
      const text = await file.text();
      const layout = JSON.parse(text) as SceneLayout;

      if (!layout.version || !layout.objects) {
        status("⚠ Invalid layout file");
        return;
      }

      const historyBefore = state.history.undoCount();
      const placedInstanceIds: string[] = [];
      let skipped = 0;

      for (const obj of layout.objects) {
        // Validate model exists in storage before attempting placement
        const data = await modelStore.load(obj.modelId);
        if (!data) {
          skipped++;
          console.warn("Layout import: model not found:", obj.modelName, obj.modelId);
          continue;
        }

        const prevCount = state.mapInstances.length;
        await placeModel(obj.modelId, obj.modelName);

        // Apply saved transform to the last placed instance (only if placeModel succeeded)
        if (state.mapInstances.length <= prevCount) continue;
        const inst = state.mapInstances[state.mapInstances.length - 1];
        if (!inst) continue;
        placedInstanceIds.push(inst.instanceId);

        for (const uid of inst.meshUniqueIds) {
          const mesh = state.allMeshes.find((m) => m.uniqueId === uid);
          if (mesh) {
            mesh.position.set(obj.position.x, obj.position.y, obj.position.z);
            mesh.rotation.set(obj.rotation.x, obj.rotation.y, obj.rotation.z);
            mesh.scaling.set(obj.scale.x, obj.scale.y, obj.scale.z);
          }
        }
      }

      // Replace individual placeModel undo entries with a single atomic entry
      if (placedInstanceIds.length > 0) {
        while (state.history.undoCount() > historyBefore) {
          state.history.popUndo();
        }
        const ids = [...placedInstanceIds];
        // Save layout data for redo
        const redoObjects = [...layout.objects];
        state.history.push({
          label: "Import Layout (" + ids.length + ")",
          undo() {
            for (const id of ids) removeMapInstance(id);
            updateHierarchy();
          },
          redo() {
            // Re-place all models from stored layout data
            void (async () => {
              for (const obj of redoObjects) {
                const d = await modelStore.load(obj.modelId);
                if (!d) continue;
                const prev = state.mapInstances.length;
                await placeModel(obj.modelId, obj.modelName);
                // Remove individual undo entry created by placeModel
                if (state.history.undoCount() > 0) state.history.popUndo();
                if (state.mapInstances.length <= prev) continue;
                const ri = state.mapInstances[state.mapInstances.length - 1];
                if (!ri) continue;
                for (const uid of ri.meshUniqueIds) {
                  const mesh = state.allMeshes.find((m) => m.uniqueId === uid);
                  if (mesh) {
                    mesh.position.set(obj.position.x, obj.position.y, obj.position.z);
                    mesh.rotation.set(obj.rotation.x, obj.rotation.y, obj.rotation.z);
                    mesh.scaling.set(obj.scale.x, obj.scale.y, obj.scale.z);
                  }
                }
              }
              updateHierarchy();
            })().catch((e) => {
              console.error("Redo layout failed:", e);
              status("\u26a0 Redo failed");
            });
          },
        });
      }

      const placed = layout.objects.length - skipped;
      status("Layout imported: " + layout.name + " (" + placed + "/" + layout.objects.length + " objects)" + (skipped ? " — " + skipped + " missing" : ""));
      updateMapInstances();
    } catch (e) {
      console.error("Import layout error:", e);
      status("⚠ Import error: " + (e as Error).message);
    }
  });
}

import "@babylonjs/serializers/glTF/2.0";
import { GLTF2Export } from "@babylonjs/serializers/glTF";
import { OBJExport } from "@babylonjs/serializers/OBJ";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import "@babylonjs/loaders/glTF";
import "@babylonjs/loaders/OBJ";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { state, status, showLoading, hideLoading } from "../state";
import type { SkeletonData } from "../state";
import { modelStore } from "../storage/model-store";
import { metadataStore, getStorageEstimate, type ModelMetadata } from "../storage/metadata-store";
import { selectMesh } from "../tools/selection";
import { updateHierarchy, updateBoneUI, updateAnimUI } from "../ui/panels";
import { applyDefaultEdges } from "../tools/mesh-utils";
import { addShadowCaster } from "../viewport/shadows";
import { registerMeshForShading } from "../viewport/shading";
import { createBoneVisualForImport, updateHierarchyVisualization, getActiveSkeleton } from "../tools/skeleton-tool";
import { assignToActiveLayer } from "../tools/layers";
import { openFileDialog } from "../ui/file-input";
import { prepareExportRig, disposeExportRig } from "./skeleton-export-bridge";
import type { ExportRig } from "./skeleton-export-bridge";

function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/^\.+/, "_")
    .trim() || "model";
}

function shouldExportNode(node: import("@babylonjs/core").Node): boolean {
  if (node.name.startsWith("bone_visual_") || node.name === "bone_hierarchy_lines") return false;
  // Linked TransformNodes belonging to bones must be emitted so the
  // GLTF skin references valid joint nodes.
  if (node.name.startsWith("boneTN_")) return true;
  return state.allMeshes.includes(node as never);
}

/**
 * Export the current scene as GLB and trigger download.
 */
export async function exportGLB(): Promise<void> {
  if (!state.allMeshes.length) {
    status("⚠ メッシュなし");
    return;
  }
  const raw = prompt("File name:", "model");
  if (!raw) return;
  const name = sanitizeFilename(raw);

  const skelData = getActiveSkeleton();
  let rig: ExportRig | null = null;
  try {
    showLoading("Exporting GLB...");
    status("Exporting GLB...");
    if (skelData && skelData.bones.length > 0) {
      rig = prepareExportRig(skelData, state.scene);
    }
    const result = await GLTF2Export.GLBAsync(state.scene, name, {
      shouldExportNode,
      shouldExportAnimation: () => true,
      animationSampleRate: 30,
    });
    const glbFile = result.glTFFiles[name + ".glb"];
    if (!glbFile) {
      status("⚠ Export failed");
      return;
    }
    const blob = glbFile as Blob;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name + ".glb";
    a.click();
    URL.revokeObjectURL(url);
    status("GLB exported: " + name + ".glb");
  } catch (e) {
    console.error("GLB export error:", e);
    status("⚠ Export エラー: " + (e as Error).message);
  } finally {
    if (skelData && rig) disposeExportRig(skelData, rig);
    hideLoading();
  }
}

/**
 * Serialize the current scene to GLB bytes (shared by Save-to-Library and
 * the .forge3d project exporter). Handles the skeleton export rig lifecycle.
 * Returns null when the scene has no meshes or the exporter yields no file.
 */
export async function serializeSceneToGlb(): Promise<ArrayBuffer | null> {
  if (!state.allMeshes.length) return null;
  const skelData = getActiveSkeleton();
  let rig: ExportRig | null = null;
  try {
    if (skelData && skelData.bones.length > 0) {
      rig = prepareExportRig(skelData, state.scene);
    }
    const result = await GLTF2Export.GLBAsync(state.scene, "model", {
      shouldExportNode,
      shouldExportAnimation: () => true,
      animationSampleRate: 30,
    });
    const glbFile = result.glTFFiles["model.glb"];
    if (!glbFile) return null;
    return await (glbFile as Blob).arrayBuffer();
  } finally {
    if (skelData && rig) disposeExportRig(skelData, rig);
  }
}

/**
 * Save current scene to the model library (OPFS + metadata).
 */
export async function saveToLibrary(): Promise<void> {
  if (!state.allMeshes.length) {
    status("⚠ メッシュなし");
    return;
  }
  const skelData = getActiveSkeleton();
  let rig: ExportRig | null = null;
  try {
    showLoading("Saving...");
    status("Saving...");
    if (skelData && skelData.bones.length > 0) {
      rig = prepareExportRig(skelData, state.scene);
    }
    const result = await GLTF2Export.GLBAsync(state.scene, "model", {
      shouldExportNode,
      shouldExportAnimation: () => true,
      animationSampleRate: 30,
    });
    const glbFile = result.glTFFiles["model.glb"];
    if (!glbFile) {
      status("⚠ Save failed");
      return;
    }
    const blob = glbFile as Blob;
    const buffer = await blob.arrayBuffer();
    const id = crypto.randomUUID();
    const now = Date.now();

    // Check storage quota
    const est = await getStorageEstimate();
    if (est && est.quota > 0 && est.usage / est.quota > 0.9) {
      status("⚠ ストレージ残量が少なくなっています (" + Math.round(est.usage / est.quota * 100) + "% 使用中)");
    }

    // Save binary to OPFS/IDB
    await modelStore.save(id, buffer);

    // Generate thumbnail from canvas
    const thumbnail = state.canvas.toDataURL("image/jpeg", 0.6);

    // Save metadata
    const meta: ModelMetadata = {
      id,
      name: "Model " + new Date(now).toLocaleString("ja-JP"),
      createdAt: now,
      updatedAt: now,
      tags: [],
      thumbnail,
      size: buffer.byteLength,
    };
    await metadataStore.save(meta);

    status("Saved: " + meta.name);
  } catch (e) {
    console.error("Save error:", e);
    status("⚠ Save エラー: " + (e as Error).message);
  } finally {
    if (skelData && rig) disposeExportRig(skelData, rig);
    hideLoading();
  }
}

function downloadText(content: string, filename: string): void {
  const blob = new Blob([content], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Export the current scene as OBJ + MTL and trigger download.
 */
export function exportOBJ(): void {
  const meshes = state.allMeshes.filter(
    (m) => !m.name.startsWith("bone_visual_") && m.name !== "bone_hierarchy_lines",
  ) as Mesh[];
  if (!meshes.length) { status("⚠ メッシュなし"); return; }
  const raw = prompt("File name:", "model");
  if (!raw) return;
  const name = sanitizeFilename(raw);

  const obj = OBJExport.OBJ(meshes, true, name + ".mtl", false);
  const seen = new Set<string>();
  let mtl = "";
  for (const m of meshes) {
    if (m.material && !seen.has(m.material.uniqueId.toString())) {
      seen.add(m.material.uniqueId.toString());
      mtl += OBJExport.MTL(m);
    }
  }
  downloadText(obj, name + ".obj");
  if (mtl) downloadText(mtl, name + ".mtl");
  status("OBJ exported: " + name + ".obj");
}

/** Convert StandardMaterial to PBRMaterial (for OBJ imports) */
function convertToPBR(mat: StandardMaterial): PBRMaterial {
  const pbr = new PBRMaterial(mat.name + "_pbr", state.scene);
  pbr.albedoColor = mat.diffuseColor ? mat.diffuseColor.clone() : new Color3(0.8, 0.8, 0.8);
  pbr.metallic = 0;
  pbr.roughness = 0.8;
  if (mat.diffuseTexture) pbr.albedoTexture = mat.diffuseTexture;
  if (mat.bumpTexture) pbr.bumpTexture = mat.bumpTexture;
  if (mat.alpha < 1) pbr.alpha = mat.alpha;
  return pbr;
}

/**
 * Load a File object directly (used by drag & drop and file picker).
 */
const MAX_WARN_SIZE = 100 * 1024 * 1024; // 100MB

export async function loadFileDirectly(file: File): Promise<void> {
  if (file.size > MAX_WARN_SIZE) {
    if (!confirm(`This file is ${(file.size / (1024 * 1024)).toFixed(0)}MB. Large files may slow down the app. Continue?`)) return;
  }
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const isOBJ = ext === "obj";
  try {
    showLoading("Loading " + file.name + "...");
    status("Loading " + file.name + "...");
    const result = await SceneLoader.ImportMeshAsync("", "", file, state.scene);
    for (const mesh of result.meshes) {
      if (mesh.name === "__root__") continue;
      if (isOBJ && mesh.material instanceof StandardMaterial) {
        const pbr = convertToPBR(mesh.material);
        mesh.material = pbr;
      }
      mesh.isPickable = true;
      applyDefaultEdges(mesh);
      addShadowCaster(mesh);
      registerMeshForShading(mesh);
      assignToActiveLayer(mesh);
      state.allMeshes.push(mesh);
    }
    if (result.meshes.length > 0) {
      selectMesh(result.meshes[result.meshes.length - 1]!, false);
    }
    if (!isOBJ) {
      for (const mesh of result.meshes) {
        if (!mesh.skeleton || mesh.name === "__root__") continue;

        state.skeletonCounter++;
        const skelId = "skel_" + state.skeletonCounter;
        const skelData: SkeletonData = {
          skeleton: mesh.skeleton,
          bones: [],
          assignedMesh: mesh,
          hierarchyLines: null,
        };

        for (const bone of mesh.skeleton.bones) {
          state.boneCounter++;
          const boneId = "bone_" + state.boneCounter;
          const pos = bone.getAbsolutePosition(mesh);
          const visual = createBoneVisualForImport(boneId, pos);

          const parentBone = bone.parent;
          let parentId: string | null = null;
          if (parentBone) {
            parentId = skelData.bones.find(b => b.bone === parentBone)?.id ?? null;
          }

          skelData.bones.push({
            id: boneId,
            name: bone.name,
            bone,
            parentId,
            visual,
          });
        }

        state.skeletonMap.set(skelId, skelData);
        state.activeSkeletonId = skelId;
        updateHierarchyVisualization(skelData);
        break;
      }

      if (result.animationGroups && result.animationGroups.length > 0) {
        state.importedAnimGroups = result.animationGroups;
        for (const ag of result.animationGroups) {
          ag.stop();
        }
      }
    }

    updateHierarchy();
    updateBoneUI();
    updateAnimUI();
    const meshCount = result.meshes.filter(m => m.name !== "__root__").length;
    if (isOBJ) {
      status(`Loaded: ${file.name} (${meshCount} meshes)`);
    } else {
      const boneCount = state.skeletonMap.get(state.activeSkeletonId ?? "")?.bones.length ?? 0;
      const animCount = state.importedAnimGroups.length;
      status(`Loaded: ${file.name} (${boneCount} bones, ${animCount} anims)`);
    }
  } catch (e) {
    console.error("Load error:", e);
    status("⚠ Load エラー: " + (e as Error).message);
  } finally {
    hideLoading();
  }
}

/**
 * Load a model file from disk (GLB, glTF, OBJ, STL).
 */
export function loadModelFromFile(): void {
  openFileDialog(".glb,.gltf,.obj,.stl", (file) => loadFileDirectly(file));
}


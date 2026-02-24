import "@babylonjs/serializers/glTF/2.0";
import { GLTF2Export } from "@babylonjs/serializers/glTF";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import "@babylonjs/loaders/glTF";
import { state, status } from "../state";
import type { SkeletonData } from "../state";
import { modelStore } from "../storage/model-store";
import { metadataStore, type ModelMetadata } from "../storage/metadata-store";
import { selectMesh } from "../tools/selection";
import { updateHierarchy, updateBoneUI, updateAnimUI } from "../ui/panels";
import { applyDefaultEdges } from "../tools/mesh-utils";
import { createBoneVisualForImport, updateHierarchyVisualization } from "../tools/skeleton-tool";

function shouldExportNode(node: import("@babylonjs/core").Node): boolean {
  if (node.name.startsWith("bone_visual_") || node.name === "bone_hierarchy_lines") return false;
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
  try {
    status("Exporting GLB...");
    const result = await GLTF2Export.GLBAsync(state.scene, "model", { shouldExportNode });
    const glbFile = result.glTFFiles["model.glb"];
    if (!glbFile) {
      status("⚠ Export failed");
      return;
    }
    const blob = glbFile as Blob;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "model.glb";
    a.click();
    URL.revokeObjectURL(url);
    status("GLB exported");
  } catch (e) {
    console.error("GLB export error:", e);
    status("⚠ Export エラー: " + (e as Error).message);
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
  try {
    status("Saving...");
    const result = await GLTF2Export.GLBAsync(state.scene, "model", { shouldExportNode });
    const glbFile = result.glTFFiles["model.glb"];
    if (!glbFile) {
      status("⚠ Save failed");
      return;
    }
    const blob = glbFile as Blob;
    const buffer = await blob.arrayBuffer();
    const id = crypto.randomUUID();
    const now = Date.now();

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

    status("💾 Saved: " + meta.name);
  } catch (e) {
    console.error("Save error:", e);
    status("⚠ Save エラー: " + (e as Error).message);
  }
}

/**
 * Load a GLB file from disk (file picker).
 */
export async function loadGLBFromFile(): Promise<void> {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".glb,.gltf";
  input.style.display = "none";
  document.body.appendChild(input);
  const cleanup = () => { if (input.parentNode) input.remove(); };
  window.addEventListener("focus", () => setTimeout(cleanup, 300), { once: true });
  input.addEventListener("change", async () => {
    cleanup();
    const file = input.files?.[0];
    if (!file) return;
    try {
      status("Loading " + file.name + "...");
      const result = await SceneLoader.ImportMeshAsync("", "", file, state.scene);
      for (const mesh of result.meshes) {
        if (mesh.name === "__root__") continue;
        mesh.isPickable = true;
        applyDefaultEdges(mesh);
        state.allMeshes.push(mesh);
      }
      if (result.meshes.length > 0) {
        selectMesh(result.meshes[result.meshes.length - 1]!, false);
      }
      // --- Import skeleton from loaded meshes ---
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
        break; // first skeleton only
      }

      // --- Import animation groups ---
      if (result.animationGroups && result.animationGroups.length > 0) {
        state.importedAnimGroups = result.animationGroups;
        // Stop all imported animations initially
        for (const ag of result.animationGroups) {
          ag.stop();
        }
      }

      updateHierarchy();
      updateBoneUI();
      updateAnimUI();
      const boneCount = state.skeletonMap.get(state.activeSkeletonId ?? "")?.bones.length ?? 0;
      const animCount = state.importedAnimGroups.length;
      status(`Loaded: ${file.name} (${boneCount} bones, ${animCount} anims)`);
    } catch (e) {
      console.error("Load error:", e);
      status("⚠ Load エラー: " + (e as Error).message);
    }
  });
  input.click();
}

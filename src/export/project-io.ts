/**
 * .forge3d project export / import — the DOM/Babylon integration layer over
 * the pure container in project-format.ts.
 *
 * Export bundles the scene GLB (meshes, materials-as-baked-textures,
 * skeletons, animations, morphs — everything glTF holds) with the sidecar
 * data GLB cannot express: editable procedural graphs, sculpt masks, and
 * layer organization. Import loads the GLB through the normal model-import
 * path, then re-associates the sidecar to the imported meshes by name.
 */

import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { state, status, showLoading, hideLoading } from "../state";
import {
  packProject,
  unpackProject,
  float32ToBase64,
  base64ToFloat32,
} from "./project-format";
import type { ProjectSidecar, ProjectMeshEntry, ProjectBoneConstraintEntry } from "./project-format";
import { serializeSceneToGlb, loadFileDirectly } from "./gltf-exporter";
import { serializeGraph, deserializeGraph } from "../materials/graph-io";
import {
  getProceduralGraph,
  getProceduralPreset,
  bakeProceduralToMesh,
} from "../materials/procedural-material";
import { refreshMaskVisual } from "../tools/sculpt";
import { validateMorphDrivers } from "../tools/morph-driver";
import { createLayer, toggleLayerVisibility, assignMeshToLayer } from "../tools/layers";
import { updateLayerUI, updateHierarchy } from "../ui/panels";
import { openFileDialog } from "../ui/file-input";

function sanitizeProjectName(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, "_").replace(/^\.+/, "_").trim() || "project";
}

/** Gather everything the GLB cannot carry into the sidecar. */
function collectSidecar(): ProjectSidecar {
  const layerNameById = new Map(state.layers.map((l) => [l.id, l.name]));
  const meshes: ProjectMeshEntry[] = [];

  for (const mesh of state.allMeshes) {
    const entry: ProjectMeshEntry = { name: mesh.name };
    const graph = getProceduralGraph(mesh);
    if (graph) {
      entry.proceduralGraph = serializeGraph(graph);
      const preset = getProceduralPreset(mesh);
      if (preset != null) entry.proceduralPreset = preset;
    }
    const mask = state.sculptMaskMap.get(mesh.uniqueId);
    if (mask) entry.sculptMask = float32ToBase64(mask);
    const layerId = state.meshLayerMap.get(mesh.uniqueId);
    const layerName = layerId ? layerNameById.get(layerId) : undefined;
    if (layerName) entry.layerName = layerName;
    if (entry.proceduralGraph || entry.sculptMask || entry.layerName) meshes.push(entry);
  }

  const sidecar: ProjectSidecar = {
    format: "forge3d-project",
    version: 1,
    meshes,
    layers: state.layers.map((l) => {
      const parentName = l.parentId ? state.layers.find((p) => p.id === l.parentId)?.name : undefined;
      return { name: l.name, visible: l.visible, ...(parentName ? { parent: parentName } : {}) };
    }),
  };
  const activeLayerName = layerNameById.get(state.activeLayerId);
  if (activeLayerName) sidecar.activeLayerName = activeLayerName;

  // Bone rolls (rest-orientation twist) — glTF can't carry them.
  const boneRolls: Record<string, number> = {};
  for (const [, skel] of state.skeletonMap) {
    for (const bd of skel.bones) {
      if (bd.roll) boneRolls[bd.name] = bd.roll;
    }
  }
  if (Object.keys(boneRolls).length) sidecar.boneRolls = boneRolls;

  // Bone constraints (Limit Rotation / Aim) — also outside glTF's model.
  const boneConstraints: Record<string, ProjectBoneConstraintEntry> = {};
  for (const [, skel] of state.skeletonMap) {
    for (const bd of skel.bones) {
      if (!bd.limitRotation && !bd.aimConstraint) continue;
      const entry: ProjectBoneConstraintEntry = {};
      if (bd.limitRotation) entry.limitRotation = { ...bd.limitRotation };
      if (bd.aimConstraint) entry.aim = { ...bd.aimConstraint };
      boneConstraints[bd.name] = entry;
    }
  }
  if (Object.keys(boneConstraints).length) sidecar.boneConstraints = boneConstraints;

  // Shape key drivers — meshes referenced by name (uniqueIds are per-session).
  const morphDrivers = state.morphDrivers
    .map((d) => {
      const mesh = state.allMeshes.find((m) => m.uniqueId === d.meshUniqueId);
      if (!mesh) return null;
      return {
        enabled: d.enabled,
        meshName: mesh.name,
        targetIndex: d.targetIndex,
        boneName: d.boneName,
        channel: d.channel,
        inMin: d.inMin,
        inMax: d.inMax,
      };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);
  if (morphDrivers.length) sidecar.morphDrivers = morphDrivers;

  return sidecar;
}

/** Export the whole scene as a portable .forge3d file (download). */
export async function exportProject(): Promise<void> {
  if (!state.allMeshes.length) {
    status("⚠ メッシュなし");
    return;
  }
  const raw = prompt("Project name:", "project");
  if (!raw) return;
  const name = sanitizeProjectName(raw);
  try {
    showLoading("Exporting project...");
    status("Exporting project...");
    const glbBuf = await serializeSceneToGlb();
    if (!glbBuf) {
      status("⚠ Project export failed");
      return;
    }
    const packed = packProject(collectSidecar(), new Uint8Array(glbBuf));
    const blob = new Blob([packed as unknown as BlobPart], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name + ".forge3d";
    a.click();
    URL.revokeObjectURL(url);
    status("Project exported: " + name + ".forge3d");
  } catch (e) {
    console.error("Project export error:", e);
    status("⚠ Project エラー: " + (e as Error).message);
  } finally {
    hideLoading();
  }
}

/** Re-attach sidecar data to freshly imported meshes (matched by name). */
function restoreSidecar(sidecar: ProjectSidecar, imported: AbstractMesh[]): void {
  // Layers: reuse an existing layer with the same name, create the rest.
  // Two passes so parents can be referenced regardless of array order.
  const layerIdByName = new Map(state.layers.map((l) => [l.name, l.id]));
  for (const l of sidecar.layers) {
    let id = layerIdByName.get(l.name);
    if (!id) {
      id = createLayer(l.name).id;
      layerIdByName.set(l.name, id);
    }
    const layer = state.layers.find((x) => x.id === id);
    if (layer && layer.visible !== l.visible) toggleLayerVisibility(id);
  }
  for (const l of sidecar.layers) {
    if (!l.parent) continue;
    const id = layerIdByName.get(l.name);
    const pid = layerIdByName.get(l.parent);
    const layer = id ? state.layers.find((x) => x.id === id) : undefined;
    if (layer && pid && pid !== id) layer.parentId = pid;
  }

  for (const entry of sidecar.meshes) {
    // GLB import may uniquify names; fall back to prefix match.
    const mesh =
      imported.find((m) => m.name === entry.name) ??
      imported.find((m) => m.name.startsWith(entry.name));
    if (!mesh) continue;

    if (entry.proceduralGraph) {
      try {
        const graph = deserializeGraph(entry.proceduralGraph);
        // Direct bake — import must not create undo entries.
        bakeProceduralToMesh(mesh, graph, entry.proceduralPreset);
      } catch (e) {
        console.warn("Project: procedural graph restore failed for", entry.name, e);
      }
    }

    if (entry.sculptMask) {
      try {
        const mask = base64ToFloat32(entry.sculptMask);
        const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
        if (pos && mask.length === pos.length / 3) {
          state.sculptMaskMap.set(mesh.uniqueId, mask);
          refreshMaskVisual(mesh);
        }
      } catch (e) {
        console.warn("Project: sculpt mask restore failed for", entry.name, e);
      }
    }

    if (entry.layerName) {
      const lid = layerIdByName.get(entry.layerName);
      if (lid) assignMeshToLayer(mesh, lid);
    }
  }

  if (sidecar.activeLayerName) {
    const lid = layerIdByName.get(sidecar.activeLayerName);
    if (lid) state.activeLayerId = lid;
  }

  // Bone rolls back onto the freshly imported skeleton's bones (by name).
  if (sidecar.boneRolls) {
    for (const [, skel] of state.skeletonMap) {
      for (const bd of skel.bones) {
        const roll = sidecar.boneRolls[bd.name];
        if (typeof roll === "number" && roll !== 0) bd.roll = roll;
      }
    }
  }

  // Bone constraints (Limit Rotation / Aim), matched by name like rolls.
  if (sidecar.boneConstraints) {
    for (const [, skel] of state.skeletonMap) {
      for (const bd of skel.bones) {
        const entry = sidecar.boneConstraints[bd.name];
        if (!entry) continue;
        if (entry.limitRotation) bd.limitRotation = { ...entry.limitRotation };
        if (entry.aim) bd.aimConstraint = { ...entry.aim };
      }
    }
  }

  // Shape key drivers — resolve mesh names against the freshly imported
  // meshes (fallback: whole scene); unresolvable / duplicate entries drop.
  if (sidecar.morphDrivers) {
    for (const e of validateMorphDrivers(sidecar.morphDrivers)) {
      const mesh =
        imported.find((m) => m.name === e.meshName) ??
        state.allMeshes.find((m) => m.name === e.meshName);
      if (!mesh) continue;
      const exists = state.morphDrivers.some(
        (d) => d.meshUniqueId === mesh.uniqueId && d.targetIndex === e.targetIndex,
      );
      if (exists) continue;
      state.morphDrivers.push({
        enabled: e.enabled,
        meshUniqueId: mesh.uniqueId,
        targetIndex: e.targetIndex,
        boneName: e.boneName,
        channel: e.channel,
        inMin: e.inMin,
        inMax: e.inMax,
      });
    }
  }

  updateLayerUI();
  updateHierarchy();
}

/** Open a .forge3d project file: load the GLB, then restore the sidecar. */
export async function importProjectFile(file: File): Promise<void> {
  try {
    showLoading("Opening project...");
    const data = new Uint8Array(await file.arrayBuffer());
    const { sidecar, glb } = unpackProject(data);

    const base = file.name.replace(/\.forge3d$/i, "") || "project";
    const glbFile = new File([glb as unknown as BlobPart], base + ".glb", { type: "model/gltf-binary" });

    const beforeUids = new Set(state.allMeshes.map((m) => m.uniqueId));
    await loadFileDirectly(glbFile);
    const imported = state.allMeshes.filter((m) => !beforeUids.has(m.uniqueId));

    restoreSidecar(sidecar, imported);
    status("Project opened: " + file.name);
  } catch (e) {
    console.error("Project open error:", e);
    status("⚠ Project エラー: " + (e as Error).message);
  } finally {
    hideLoading();
  }
}

/** File dialog wrapper for the Open Project button. */
export function openProjectDialog(): void {
  openFileDialog(".forge3d", (file) => importProjectFile(file));
}

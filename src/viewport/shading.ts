import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import type { Material } from "@babylonjs/core/Materials/material";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { state, status } from "../state";
import type { ViewportMode } from "../state";

// Storage for original materials when switching away from textured mode
const originalMaterials = new Map<number, Material | null>();
const originalWireframe = new Map<number, boolean>();
let matcapMaterial: StandardMaterial | null = null;

function getOrCreateMatcap(): StandardMaterial {
  if (matcapMaterial) return matcapMaterial;
  const mat = new StandardMaterial("__matcap", state.scene);
  mat.disableLighting = true;

  // Generate matcap texture via DynamicTexture
  const tex = new DynamicTexture("__matcapTex", 256, state.scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const cx = 128, cy = 128, r = 120;
  const grad = ctx.createRadialGradient(cx - 20, cy - 20, 0, cx, cy, r);
  grad.addColorStop(0, "#e8e8e8");
  grad.addColorStop(0.5, "#a0a0a0");
  grad.addColorStop(0.85, "#505060");
  grad.addColorStop(1, "#202030");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);
  tex.update();

  mat.emissiveTexture = tex;
  mat.backFaceCulling = true;
  matcapMaterial = mat;
  return mat;
}

function storeOriginals(): void {
  for (const m of state.allMeshes) {
    if (!originalMaterials.has(m.uniqueId)) {
      originalMaterials.set(m.uniqueId, m.material);
      originalWireframe.set(m.uniqueId, m.material?.wireframe ?? false);
    }
  }
}

function restoreOriginals(): void {
  for (const m of state.allMeshes) {
    const orig = originalMaterials.get(m.uniqueId);
    if (orig !== undefined) {
      m.material = orig;
    }
    const origWire = originalWireframe.get(m.uniqueId);
    if (origWire !== undefined && m.material) {
      m.material.wireframe = origWire;
    }
  }
  state.scene.environmentIntensity = state.envIntensity;
}

function clearStoredOriginals(): void {
  originalMaterials.clear();
  originalWireframe.clear();
}

export function setViewportMode(mode: ViewportMode): void {
  const prev = state.viewportMode;
  if (prev === mode) return;

  // If leaving textured mode, store originals
  if (prev === "textured") {
    storeOriginals();
  }

  // Restore from any previous non-textured mode first
  if (prev !== "textured") {
    restoreOriginals();
  }

  switch (mode) {
    case "textured":
      // Already restored above
      clearStoredOriginals();
      break;

    case "solid":
      // If coming directly from textured, originals already stored
      if (prev === "textured") storeOriginals();
      state.scene.environmentIntensity = 0;
      break;

    case "wire":
      if (prev === "textured") storeOriginals();
      for (const m of state.allMeshes) {
        if (m.material) m.material.wireframe = true;
      }
      break;

    case "matcap": {
      if (prev === "textured") storeOriginals();
      const mc = getOrCreateMatcap();
      for (const m of state.allMeshes) {
        m.material = mc;
      }
      break;
    }
  }

  state.viewportMode = mode;
  status(mode.charAt(0).toUpperCase() + mode.slice(1) + " mode");
}

/** Register a new mesh with the shading system — applies current mode */
export function registerMeshForShading(mesh: AbstractMesh): void {
  if (state.viewportMode === "textured") return;

  // Store this mesh's original material
  originalMaterials.set(mesh.uniqueId, mesh.material);
  originalWireframe.set(mesh.uniqueId, mesh.material?.wireframe ?? false);

  // Apply current mode
  switch (state.viewportMode) {
    case "solid":
      // No material swap needed, just env intensity is already 0
      break;
    case "wire":
      if (mesh.material) mesh.material.wireframe = true;
      break;
    case "matcap":
      mesh.material = getOrCreateMatcap();
      break;
  }
}

/** Unregister a mesh from the shading system */
export function unregisterMeshForShading(mesh: AbstractMesh): void {
  originalMaterials.delete(mesh.uniqueId);
  originalWireframe.delete(mesh.uniqueId);
}

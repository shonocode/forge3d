import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { state, status } from "../state";

export type TextureSlot = "albedo" | "normal" | "metallic" | "ao" | "emissive";

const SLOT_PROP: Record<TextureSlot, string> = {
  albedo: "albedoTexture",
  normal: "bumpTexture",
  metallic: "metallicTexture",
  ao: "ambientTexture",
  emissive: "emissiveTexture",
};

export function importTextureForSlot(mesh: AbstractMesh, slot: TextureSlot): void {
  const mat = mesh.material as PBRMaterial | null;
  if (!mat || !("albedoTexture" in mat)) {
    status("\u26a0 PBRMaterial required");
    return;
  }

  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*,.ktx2,.ktx";
  input.style.display = "none";
  document.body.appendChild(input);
  const cleanup = () => { if (input.parentNode) input.remove(); };
  window.addEventListener("focus", () => setTimeout(cleanup, 300), { once: true });

  input.addEventListener("change", () => {
    cleanup();
    const file = input.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const tex = new Texture(url, state.scene, false, true, Texture.TRILINEAR_SAMPLINGMODE, () => {
      URL.revokeObjectURL(url);
    });
    tex.name = file.name;

    const prop = SLOT_PROP[slot];
    (mat as unknown as Record<string, unknown>)[prop] = tex;

    // Metallic texture: configure channels per glTF spec
    if (slot === "metallic") {
      mat.useMetallnessFromMetallicTextureBlue = true;
      mat.useRoughnessFromMetallicTextureGreen = true;
    }

    // Clear paint texture if albedo is replaced by import
    if (slot === "albedo") {
      const paintTex = state.paintTextureMap.get(mesh.uniqueId);
      if (paintTex) {
        paintTex.dispose();
        state.paintTextureMap.delete(mesh.uniqueId);
      }
    }

    status("Texture: " + file.name + " \u2192 " + slot);
  });
  input.click();
}

export function clearTextureSlot(mesh: AbstractMesh, slot: TextureSlot): void {
  const mat = mesh.material as PBRMaterial | null;
  if (!mat || !("albedoTexture" in mat)) return;

  const prop = SLOT_PROP[slot];
  const existing = (mat as unknown as Record<string, unknown>)[prop] as Texture | null;
  if (existing) {
    existing.dispose();
    (mat as unknown as Record<string, unknown>)[prop] = null;
  }

  // Also clear paint texture if clearing albedo
  if (slot === "albedo") {
    const paintTex = state.paintTextureMap.get(mesh.uniqueId);
    if (paintTex) {
      paintTex.dispose();
      state.paintTextureMap.delete(mesh.uniqueId);
    }
  }

  status("Cleared: " + slot + " texture");
}

export function getTextureInfo(mesh: AbstractMesh): Record<TextureSlot, { name: string } | null> {
  const result = { albedo: null, normal: null, metallic: null, ao: null, emissive: null } as Record<TextureSlot, { name: string } | null>;
  const mat = mesh.material as PBRMaterial | null;
  if (!mat || !("albedoTexture" in mat)) return result;

  for (const slot of Object.keys(SLOT_PROP) as TextureSlot[]) {
    const tex = (mat as unknown as Record<string, unknown>)[SLOT_PROP[slot]] as Texture | null;
    if (tex) {
      result[slot] = { name: tex.name || slot };
    }
  }
  return result;
}

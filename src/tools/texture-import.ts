import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { state, status } from "../state";
import { openFileDialog } from "../ui/file-input";

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

  openFileDialog("image/*,.ktx2,.ktx", (file) => {
    const url = URL.createObjectURL(file);
    const tex = new Texture(url, state.scene, false, true, Texture.TRILINEAR_SAMPLINGMODE, () => {
      // Delay revoke to ensure GPU has fetched the blob data
      setTimeout(() => URL.revokeObjectURL(url), 500);
    });
    tex.name = file.name;

    const prop = SLOT_PROP[slot];
    (mat as unknown as Record<string, unknown>)[prop] = tex;

    // Metallic texture: configure channels per glTF spec
    if (slot === "metallic") {
      mat.useMetallnessFromMetallicTextureBlue = true;
      mat.useRoughnessFromMetallicTextureGreen = true;
    }

    // Clear paint texture (and its layer stack) if albedo is replaced by
    // import — the next stroke reseeds the Base layer from the new image.
    if (slot === "albedo") {
      const paintTex = state.paintTextureMap.get(mesh.uniqueId);
      if (paintTex) {
        paintTex.dispose();
        state.paintTextureMap.delete(mesh.uniqueId);
      }
      state.paintLayersMap.delete(mesh.uniqueId);
    }

    status("Texture: " + file.name + " \u2192 " + slot);
  });
}

export function clearTextureSlot(mesh: AbstractMesh, slot: TextureSlot): void {
  const mat = mesh.material as PBRMaterial | null;
  if (!mat || !("albedoTexture" in mat)) return;

  const prop = SLOT_PROP[slot];
  const existing = (mat as unknown as Record<string, unknown>)[prop] as Texture | null;
  if (!existing) return;

  // Don't dispose — keep reference for undo
  (mat as unknown as Record<string, unknown>)[prop] = null;

  // Detach paint texture if clearing albedo (keep for undo)
  let paintTex: import("@babylonjs/core/Materials/Textures/dynamicTexture").DynamicTexture | null = null;
  if (slot === "albedo") {
    paintTex = state.paintTextureMap.get(mesh.uniqueId) ?? null;
    if (paintTex) state.paintTextureMap.delete(mesh.uniqueId);
  }

  state.history.push({
    label: "Clear Texture",
    undo() {
      (mat as unknown as Record<string, unknown>)[prop] = existing;
      if (paintTex) state.paintTextureMap.set(mesh.uniqueId, paintTex);
    },
    redo() {
      (mat as unknown as Record<string, unknown>)[prop] = null;
      if (paintTex) state.paintTextureMap.delete(mesh.uniqueId);
    },
  });

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

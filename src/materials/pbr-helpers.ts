import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { Material } from "@babylonjs/core/Materials/material";
import { state } from "../state";

/**
 * Create a default PBR material with the given name and base color.
 */
export function createDefaultPBR(name: string, hex: string): PBRMaterial {
  const m = new PBRMaterial(name, state.scene);
  const c = Color3.FromHexString(hex);
  m.albedoColor = c;
  m.metallic = 0;
  m.roughness = 0.5;
  m.emissiveColor = Color3.Black();
  m.emissiveIntensity = 0;
  // Ensure good default behavior
  m.useRadianceOverAlpha = false;
  m.forceIrradianceInFragment = true;
  return m;
}

/**
 * Get albedo color from any material type (PBR or Standard).
 */
export function getAlbedoColor(mat: Material | null): Color3 | null {
  if (!mat) return null;
  if ("albedoColor" in mat && (mat as PBRMaterial).albedoColor) {
    return (mat as PBRMaterial).albedoColor;
  }
  // Fallback for legacy StandardMaterial
  if ("diffuseColor" in mat && (mat as any).diffuseColor) {
    return (mat as any).diffuseColor as Color3;
  }
  return null;
}

/**
 * Set albedo color on any material type.
 */
export function setAlbedoColor(mat: Material | null, color: Color3): void {
  if (!mat) return;
  if ("albedoColor" in mat) {
    (mat as PBRMaterial).albedoColor = color;
  } else if ("diffuseColor" in mat) {
    (mat as any).diffuseColor = color;
  }
}

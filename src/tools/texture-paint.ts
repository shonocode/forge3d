import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { PickingInfo } from "@babylonjs/core/Collisions/pickingInfo";
import { state, status } from "../state";

const TEX_SIZE = 1024;

/**
 * Ensure a DynamicTexture exists for the mesh, creating one if needed.
 * Replaces the material's diffuseTexture with a paintable DynamicTexture.
 */
export function ensurePaintTexture(mesh: AbstractMesh): DynamicTexture {
  const existing = state.paintTextureMap.get(mesh.uniqueId);
  if (existing) return existing;

  const tex = new DynamicTexture(
    "paintTex_" + mesh.uniqueId,
    TEX_SIZE,
    state.scene,
    true // generate mip maps
  );

  // Fill with the mesh's current diffuse color or white
  const ctx = tex.getContext();
  if (!ctx) {
    status("⚠ Paint context unavailable");
    return tex;
  }
  const mat = mesh.material as StandardMaterial | null;
  const baseColor = mat?.diffuseColor?.toHexString() ?? "#ffffff";
  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
  tex.update();

  // Assign to material
  if (mat && mat instanceof StandardMaterial) {
    mat.diffuseTexture = tex;
  } else {
    const newMat = new StandardMaterial("paintMat_" + mesh.uniqueId, state.scene);
    newMat.diffuseTexture = tex;
    mesh.material = newMat;
  }

  state.paintTextureMap.set(mesh.uniqueId, tex);
  status("Paint texture initialized");
  return tex;
}

/**
 * Paint at the UV coordinates from a pick result.
 */
export function paintAt(mesh: AbstractMesh, pick: PickingInfo): void {
  const uv = pick.getTextureCoordinates();
  if (!uv) return;

  const tex = ensurePaintTexture(mesh);
  const ctx = tex.getContext() as CanvasRenderingContext2D | null;
  if (!ctx) return;
  const { color, size, opacity, eraser } = state.paintConfig;

  // UV → Canvas coordinates (flip V)
  const cx = uv.x * TEX_SIZE;
  const cy = (1 - uv.y) * TEX_SIZE;

  ctx.save();

  if (eraser) {
    ctx.globalCompositeOperation = "destination-out";
    ctx.globalAlpha = 1;
  } else {
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = opacity;
  }

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, size, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
  tex.update();
}

/**
 * Clear the paint texture (fill with base color).
 */
export function clearPaintTexture(mesh: AbstractMesh): void {
  const tex = state.paintTextureMap.get(mesh.uniqueId);
  if (!tex) return;

  const ctx = tex.getContext() as CanvasRenderingContext2D | null;
  if (!ctx) return;
  const mat = mesh.material as StandardMaterial | null;
  const baseColor = mat?.diffuseColor?.toHexString() ?? "#ffffff";
  ctx.fillStyle = baseColor;
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
  tex.update();
  status("Paint cleared");
}

/**
 * Check if a mesh has UV coordinates (required for painting).
 */
export function hasUVs(mesh: AbstractMesh): boolean {
  return !!(mesh as Mesh).getVerticesData?.("uv");
}

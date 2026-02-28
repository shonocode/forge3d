import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { PickingInfo } from "@babylonjs/core/Collisions/pickingInfo";
import { state, status } from "../state";
import { getAlbedoColor } from "../materials/pbr-helpers";

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
    false // skip mipmaps for paint performance
  );

  const ctx = tex.getContext();
  if (!ctx) {
    status("\u26a0 Paint context unavailable");
    return tex;
  }

  // If an existing albedo texture exists, try to draw it onto the DynamicTexture canvas
  let drawnExisting = false;
  if (mesh.material && "albedoTexture" in mesh.material) {
    const existingTex = (mesh.material as PBRMaterial).albedoTexture;
    if (existingTex && !(existingTex instanceof DynamicTexture)) {
      // Try to load existing texture via its URL onto canvas synchronously
      const texUrl = (existingTex as unknown as { url?: string }).url;
      if (texUrl) {
        const img = new Image();
        const texToDispose = existingTex;
        img.onload = () => {
          ctx.drawImage(img, 0, 0, TEX_SIZE, TEX_SIZE);
          tex.update();
          texToDispose.dispose();
        };
        img.onerror = () => {
          // Fallback: fill with solid color on load failure
          const baseColor = getAlbedoColor(mesh.material)?.toHexString() ?? "#ffffff";
          ctx.fillStyle = baseColor;
          ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
          tex.update();
          texToDispose.dispose();
        };
        img.src = texUrl;
        drawnExisting = true; // Image loading handles canvas; skip immediate fill
      } else {
        existingTex.dispose();
      }
    }
  }

  // Fill with the mesh's current albedo color as base
  if (!drawnExisting) {
    const baseColor = getAlbedoColor(mesh.material)?.toHexString() ?? "#ffffff";
    ctx.fillStyle = baseColor;
    ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
  }
  tex.update();

  // Assign to material
  if (mesh.material && "albedoTexture" in mesh.material) {
    (mesh.material as PBRMaterial).albedoTexture = tex;
  } else {
    const newMat = new PBRMaterial("paintMat_" + mesh.uniqueId, state.scene);
    newMat.albedoTexture = tex;
    newMat.metallic = 0;
    newMat.roughness = 0.5;
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

  ctx.globalCompositeOperation = "source-over";
  if (eraser) {
    // Paint with base color to restore original appearance
    ctx.fillStyle = getAlbedoColor(mesh.material)?.toHexString() ?? "#ffffff";
    ctx.globalAlpha = 1;
  } else {
    ctx.fillStyle = color;
    ctx.globalAlpha = opacity;
  }
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

  // Snapshot before clear for undo
  const beforeData = ctx.getImageData(0, 0, TEX_SIZE, TEX_SIZE);

  const baseColor = getAlbedoColor(mesh.material)?.toHexString() ?? "#ffffff";
  ctx.fillStyle = baseColor;
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
  tex.update();

  state.history.push({
    label: "Clear Paint",
    undo() {
      const t = state.paintTextureMap.get(mesh.uniqueId);
      if (!t) return;
      const c = t.getContext() as CanvasRenderingContext2D | null;
      if (!c) return;
      c.putImageData(beforeData, 0, 0);
      t.update();
    },
    redo() {
      const t = state.paintTextureMap.get(mesh.uniqueId);
      if (!t) return;
      const c = t.getContext() as CanvasRenderingContext2D | null;
      if (!c) return;
      c.fillStyle = baseColor;
      c.globalCompositeOperation = "source-over";
      c.globalAlpha = 1;
      c.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
      t.update();
    },
  });

  status("Paint cleared");
}

/**
 * Check if a mesh has UV coordinates (required for painting).
 */
export function hasUVs(mesh: AbstractMesh): boolean {
  const uvs = mesh.getVerticesData("uv");
  return uvs != null && uvs.length > 0;
}

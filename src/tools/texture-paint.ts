import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { PickingInfo } from "@babylonjs/core/Collisions/pickingInfo";
import { state, status } from "../state";
import { getAlbedoColor } from "../materials/pbr-helpers";
import { brushAlpha, isSeamJump, strokeDabs } from "./paint-brush";

/** Size for a NEW paint texture (existing textures keep their own size). */
const texCreateSize = (): number => state.paintConfig.resolution || 1024;

/** Actual canvas size of an existing paint texture. */
const texSizeOf = (tex: DynamicTexture): number => tex.getSize().width;

/**
 * Ensure a DynamicTexture exists for the mesh, creating one if needed.
 * Replaces the material's diffuseTexture with a paintable DynamicTexture.
 */
export function ensurePaintTexture(mesh: AbstractMesh): DynamicTexture {
  const existing = state.paintTextureMap.get(mesh.uniqueId);
  if (existing) return existing;

  const size = texCreateSize();
  const tex = new DynamicTexture(
    "paintTex_" + mesh.uniqueId,
    size,
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
          ctx.drawImage(img, 0, 0, size, size);
          tex.update();
          texToDispose.dispose();
        };
        img.onerror = () => {
          // Fallback: fill with solid color on load failure
          const baseColor = getAlbedoColor(mesh.material)?.toHexString() ?? "#ffffff";
          ctx.fillStyle = baseColor;
          ctx.fillRect(0, 0, size, size);
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
    ctx.fillRect(0, 0, size, size);
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

// ── Stroke engine (F-M11) ──
//
// Dabs are interpolated between successive pointer events (uniform arc-
// length spacing) so fast drags paint a continuous line instead of dots,
// and each dab renders as a radial gradient whose profile follows
// `brushAlpha` (hardness 1 = crisp circle, 0 = airbrush).

/** Previous dab position of the in-progress stroke (canvas px), per mesh. */
let _lastDab: { uid: number; x: number; y: number } | null = null;

/** Reset stroke continuity — call on pointerdown before the first dab. */
export function beginPaintStroke(): void {
  _lastDab = null;
}

/** One soft dab at (x, y). Gradient stops sample the brushAlpha profile. */
function drawDab(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
  opacity: number,
  hardness: number,
): void {
  const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
  // Piecewise-linear approximation of the smoothstep falloff.
  const stops = hardness >= 1 ? [0, 1] : [0, hardness, hardness + (1 - hardness) * 0.33, hardness + (1 - hardness) * 0.66, 1];
  for (const t of stops) {
    g.addColorStop(Math.min(1, Math.max(0, t)), colorWithAlpha(color, opacity * brushAlpha(t >= 1 ? 1 : t, hardness)));
  }
  ctx.fillStyle = g;
  ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
}

function colorWithAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const gr = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${gr},${b},${Math.max(0, Math.min(1, alpha))})`;
}

/**
 * Paint at the UV coordinates from a pick result. Dabs since the previous
 * event are interpolated (unless the pick hopped across a UV seam).
 */
export function paintAt(mesh: AbstractMesh, pick: PickingInfo): void {
  const uv = pick.getTextureCoordinates();
  if (!uv) return;

  const tex = ensurePaintTexture(mesh);
  const ctx = tex.getContext() as CanvasRenderingContext2D | null;
  if (!ctx) return;
  const { color, size, opacity, eraser, hardness } = state.paintConfig;
  const texSize = texSizeOf(tex);
  // Brush size is calibrated on a 1024 atlas — scale for other resolutions.
  const radius = size * (texSize / 1024);

  // UV → Canvas coordinates (flip V)
  const cx = uv.x * texSize;
  const cy = (1 - uv.y) * texSize;

  let dabs: Array<[number, number]>;
  if (
    _lastDab &&
    _lastDab.uid === mesh.uniqueId &&
    !isSeamJump(_lastDab.x, _lastDab.y, cx, cy, texSize)
  ) {
    dabs = strokeDabs(_lastDab.x, _lastDab.y, cx, cy, Math.max(1, radius * 0.35));
  } else {
    dabs = [[cx, cy]];
  }
  _lastDab = { uid: mesh.uniqueId, x: cx, y: cy };

  const fill = eraser
    ? getAlbedoColor(mesh.material)?.toHexString() ?? "#ffffff"
    : color;
  const alpha = eraser ? 1 : opacity;

  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  for (const [dx, dy] of dabs) drawDab(ctx, dx, dy, radius, fill, alpha, hardness);
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
  const texSize = texSizeOf(tex);

  // Snapshot before clear for undo
  const beforeData = ctx.getImageData(0, 0, texSize, texSize);

  const baseColor = getAlbedoColor(mesh.material)?.toHexString() ?? "#ffffff";
  ctx.fillStyle = baseColor;
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.fillRect(0, 0, texSize, texSize);
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
      c.fillRect(0, 0, texSize, texSize);
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

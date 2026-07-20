import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { PickingInfo } from "@babylonjs/core/Collisions/pickingInfo";
import { state, status } from "../state";
import { getAlbedoColor } from "../materials/pbr-helpers";
import { brushAlpha, isSeamJump, strokeDabs } from "./paint-brush";
import {
  blendToCompositeOp,
  canRemoveLayer,
  makeBaseMeta,
  makeLayerMeta,
  nextActiveAfterRemove,
  LAYER_BLENDS,
  type LayerBlend,
  type PaintLayerMeta,
} from "./paint-layers";
import { escapeHtml } from "../ui/escape";

/** One paint layer: metadata + its own transparent canvas. */
export interface PaintLayer extends PaintLayerMeta {
  canvas: OffscreenCanvas;
}

/** A mesh's layer stack (bottom-up; index 0 = opaque Base). */
export interface MeshPaintLayers {
  layers: PaintLayer[];
  active: number;
}

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

// ── Layer stack (F-M11) ──

/**
 * Ensure the mesh has a layer stack. The Base layer is seeded from the
 * current DynamicTexture content, so an imported albedo / base-color fill
 * becomes layer 0 and older single-layer paintings keep looking identical.
 */
export function ensurePaintLayers(mesh: AbstractMesh): MeshPaintLayers {
  const existing = state.paintLayersMap.get(mesh.uniqueId);
  if (existing) return existing;
  const tex = ensurePaintTexture(mesh);
  const size = texSizeOf(tex);
  const base = new OffscreenCanvas(size, size);
  const bctx = base.getContext("2d")!;
  const texCtx = tex.getContext() as CanvasRenderingContext2D | null;
  if (texCtx) bctx.drawImage(texCtx.canvas, 0, 0);
  const stack: MeshPaintLayers = {
    layers: [{ ...makeBaseMeta(), canvas: base }],
    active: 0,
  };
  state.paintLayersMap.set(mesh.uniqueId, stack);
  updatePaintLayersUI();
  return stack;
}

/** Composite the layer stack bottom-up into the mesh's DynamicTexture. */
export function compositePaintLayers(meshUniqueId: number): void {
  const tex = state.paintTextureMap.get(meshUniqueId);
  const stack = state.paintLayersMap.get(meshUniqueId);
  if (!tex || !stack) return;
  const ctx = tex.getContext() as CanvasRenderingContext2D | null;
  if (!ctx) return;
  const size = texSizeOf(tex);
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, size, size);
  for (const layer of stack.layers) {
    if (!layer.visible) continue;
    ctx.globalAlpha = layer.opacity;
    ctx.globalCompositeOperation = layer.isBase ? "source-over" : blendToCompositeOp(layer.blend);
    ctx.drawImage(layer.canvas, 0, 0, size, size);
  }
  ctx.restore();
  tex.update();
}

/** The canvas strokes are currently painting into (undo snapshots read it). */
export function getActivePaintLayer(meshUniqueId: number): PaintLayer | null {
  const stack = state.paintLayersMap.get(meshUniqueId);
  return stack ? stack.layers[stack.active] ?? null : null;
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
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
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
 * event are interpolated (unless the pick hopped across a UV seam) and land
 * on the ACTIVE layer; the stack is then composited to the visible texture.
 *
 * Eraser semantics per layer: on Base it repaints the material's base color
 * (nothing below to reveal); on overlay layers it erases to transparency
 * (destination-out), revealing the layers underneath.
 */
export function paintAt(mesh: AbstractMesh, pick: PickingInfo): void {
  const uv = pick.getTextureCoordinates();
  if (!uv) return;

  const tex = ensurePaintTexture(mesh);
  const stack = ensurePaintLayers(mesh);
  const layer = stack.layers[stack.active];
  if (!layer) return;
  const ctx = layer.canvas.getContext("2d");
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

  const eraseToTransparent = eraser && !layer.isBase;
  const fill = eraser
    ? eraseToTransparent
      ? "#ffffff" // color irrelevant for destination-out; alpha profile erases
      : getAlbedoColor(mesh.material)?.toHexString() ?? "#ffffff"
    : color;
  const alpha = eraser ? 1 : opacity;

  ctx.save();
  ctx.globalCompositeOperation = eraseToTransparent ? "destination-out" : "source-over";
  for (const [dx, dy] of dabs) drawDab(ctx, dx, dy, radius, fill, alpha, hardness);
  ctx.restore();
  compositePaintLayers(mesh.uniqueId);
}

/**
 * Clear the ACTIVE paint layer: Base refills with the material's base
 * color, overlay layers clear to transparency. One undo entry.
 */
export function clearPaintTexture(mesh: AbstractMesh): void {
  const tex = state.paintTextureMap.get(mesh.uniqueId);
  if (!tex) return;
  const stack = ensurePaintLayers(mesh);
  const layer = stack.layers[stack.active];
  if (!layer) return;
  const ctx = layer.canvas.getContext("2d");
  if (!ctx) return;
  const texSize = texSizeOf(tex);

  // Snapshot before clear for undo
  const beforeData = ctx.getImageData(0, 0, texSize, texSize);

  const baseColor = getAlbedoColor(mesh.material)?.toHexString() ?? "#ffffff";
  const doClear = (c: OffscreenCanvasRenderingContext2D): void => {
    c.save();
    c.globalCompositeOperation = "source-over";
    c.globalAlpha = 1;
    if (layer.isBase) {
      c.fillStyle = baseColor;
      c.fillRect(0, 0, texSize, texSize);
    } else {
      c.clearRect(0, 0, texSize, texSize);
    }
    c.restore();
  };
  doClear(ctx);
  compositePaintLayers(mesh.uniqueId);

  state.history.push({
    label: "Clear Paint",
    undo() {
      const c = layer.canvas.getContext("2d");
      if (!c) return;
      c.putImageData(beforeData, 0, 0);
      compositePaintLayers(mesh.uniqueId);
    },
    redo() {
      const c = layer.canvas.getContext("2d");
      if (!c) return;
      doClear(c);
      compositePaintLayers(mesh.uniqueId);
    },
  });

  status(`Paint cleared (${layer.name})`);
}

/**
 * Check if a mesh has UV coordinates (required for painting).
 */
export function hasUVs(mesh: AbstractMesh): boolean {
  const uvs = mesh.getVerticesData("uv");
  return uvs != null && uvs.length > 0;
}

// ── Layer operations + panel UI ────────────────────────────────────────────

/** Add a transparent overlay layer on top and make it active (undoable). */
export function addPaintLayer(mesh: AbstractMesh): void {
  const tex = ensurePaintTexture(mesh);
  const stack = ensurePaintLayers(mesh);
  const size = texSizeOf(tex);
  const layer: PaintLayer = { ...makeLayerMeta(stack.layers.length), canvas: new OffscreenCanvas(size, size) };
  const prevActive = stack.active;
  stack.layers.push(layer);
  stack.active = stack.layers.length - 1;
  compositePaintLayers(mesh.uniqueId);
  updatePaintLayersUI();

  state.history.push({
    label: "Add Paint Layer",
    undo() {
      const s = state.paintLayersMap.get(mesh.uniqueId);
      if (!s) return;
      const idx = s.layers.indexOf(layer);
      if (idx >= 0) s.layers.splice(idx, 1);
      s.active = Math.min(prevActive, s.layers.length - 1);
      compositePaintLayers(mesh.uniqueId);
      updatePaintLayersUI();
    },
    redo() {
      const s = state.paintLayersMap.get(mesh.uniqueId);
      if (!s) return;
      s.layers.push(layer);
      s.active = s.layers.length - 1;
      compositePaintLayers(mesh.uniqueId);
      updatePaintLayersUI();
    },
  });
  status(`Layer added: ${layer.name}`);
}

/** Remove a non-base layer (undoable — the canvas content survives in history). */
export function removePaintLayer(mesh: AbstractMesh, index: number): void {
  const stack = state.paintLayersMap.get(mesh.uniqueId);
  if (!stack || !canRemoveLayer(stack.layers, index)) {
    status("⚠ Base レイヤーは削除できない");
    return;
  }
  const layer = stack.layers[index]!;
  const prevActive = stack.active;
  stack.layers.splice(index, 1);
  stack.active = nextActiveAfterRemove(prevActive, index);
  compositePaintLayers(mesh.uniqueId);
  updatePaintLayersUI();

  state.history.push({
    label: "Delete Paint Layer",
    undo() {
      const s = state.paintLayersMap.get(mesh.uniqueId);
      if (!s) return;
      s.layers.splice(index, 0, layer);
      s.active = prevActive;
      compositePaintLayers(mesh.uniqueId);
      updatePaintLayersUI();
    },
    redo() {
      const s = state.paintLayersMap.get(mesh.uniqueId);
      if (!s) return;
      const idx = s.layers.indexOf(layer);
      if (idx >= 0) s.layers.splice(idx, 1);
      s.active = nextActiveAfterRemove(prevActive, index);
      compositePaintLayers(mesh.uniqueId);
      updatePaintLayersUI();
    },
  });
  status(`Layer deleted: ${layer.name}`);
}

/**
 * Rebuild the Paint tab's layer list. Shows a hint until the mesh has a
 * stack (created lazily on first stroke / Add Layer). Topmost layer first,
 * Photoshop-style.
 */
export function updatePaintLayersUI(): void {
  const el = document.getElementById("paintLayersC");
  if (!el) return;
  const mesh = state.selectedMeshes[state.selectedMeshes.length - 1];
  const stack = mesh ? state.paintLayersMap.get(mesh.uniqueId) : undefined;
  if (!mesh || !stack) {
    el.innerHTML = '<div class="empty" style="font-size:9px;">ペイント開始で Base レイヤーが作られる</div>';
    return;
  }

  const rows: string[] = [];
  for (let i = stack.layers.length - 1; i >= 0; i--) {
    const l = stack.layers[i]!;
    const active = i === stack.active;
    const blendOpts = LAYER_BLENDS
      .map((b) => `<option value="${b}"${l.blend === b ? " selected" : ""}>${b}</option>`)
      .join("");
    rows.push(`
      <div class="sr pl-row" data-idx="${i}" style="display:flex;align-items:center;gap:3px;font-size:9px;padding:2px 3px;border-radius:3px;${active ? "background:var(--acg,rgba(255,200,0,0.12));" : ""}cursor:pointer;">
        <input type="checkbox" class="pl-vis" data-idx="${i}"${l.visible ? " checked" : ""} title="表示 / 非表示">
        <span style="flex:1;${active ? "color:var(--ac2);font-weight:600;" : ""}">${escapeHtml(l.name)}</span>
        <select class="pl-blend" data-idx="${i}" style="font-size:9px;width:64px;"${l.isBase ? " disabled" : ""}>${blendOpts}</select>
        <input type="range" class="pl-op" data-idx="${i}" min="0" max="1" step="0.05" value="${l.opacity}" style="width:44px;" title="Opacity">
        ${l.isBase ? "" : `<button class="abtn dan pl-del" data-idx="${i}" style="padding:0 4px;font-size:9px;min-width:0;">✕</button>`}
      </div>`);
  }
  el.innerHTML = rows.join("");

  const m = mesh;
  el.querySelectorAll<HTMLElement>(".pl-row").forEach((row) => {
    row.addEventListener("click", (ev) => {
      // Ignore clicks that landed on the row's own controls.
      const t = ev.target as HTMLElement;
      if (t.closest(".pl-vis, .pl-blend, .pl-op, .pl-del")) return;
      const s = state.paintLayersMap.get(m.uniqueId);
      if (!s) return;
      s.active = Number(row.dataset.idx);
      updatePaintLayersUI();
    });
  });
  el.querySelectorAll<HTMLInputElement>(".pl-vis").forEach((inp) => {
    inp.addEventListener("change", () => {
      const l = state.paintLayersMap.get(m.uniqueId)?.layers[Number(inp.dataset.idx)];
      if (!l) return;
      l.visible = inp.checked;
      compositePaintLayers(m.uniqueId);
    });
  });
  el.querySelectorAll<HTMLSelectElement>(".pl-blend").forEach((sel) => {
    sel.addEventListener("change", () => {
      const l = state.paintLayersMap.get(m.uniqueId)?.layers[Number(sel.dataset.idx)];
      if (!l) return;
      l.blend = sel.value as LayerBlend;
      compositePaintLayers(m.uniqueId);
    });
  });
  el.querySelectorAll<HTMLInputElement>(".pl-op").forEach((inp) => {
    inp.addEventListener("input", () => {
      const l = state.paintLayersMap.get(m.uniqueId)?.layers[Number(inp.dataset.idx)];
      if (!l) return;
      l.opacity = Number(inp.value);
      compositePaintLayers(m.uniqueId);
    });
  });
  el.querySelectorAll<HTMLButtonElement>(".pl-del").forEach((btn) => {
    btn.addEventListener("click", () => removePaintLayer(m, Number(btn.dataset.idx)));
  });
}

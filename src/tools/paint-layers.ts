/**
 * Paint layer model (F-M11) — pure metadata logic, headless.
 *
 * A mesh's paint stack is a bottom-up list of layers: index 0 is the opaque
 * Base layer (the old single-texture behavior), everything above it is a
 * transparent overlay with its own opacity + blend mode. Strokes go into
 * the ACTIVE layer's canvas; the visible result is composited bottom-up
 * into the mesh's DynamicTexture.
 *
 * This module holds the parts that don't touch a canvas: blend-mode
 * mapping and stack manipulation rules (Vitest-pinned). The canvases and
 * compositing live in texture-paint.ts.
 */

export type LayerBlend = "normal" | "multiply" | "screen" | "overlay";

export const LAYER_BLENDS: readonly LayerBlend[] = ["normal", "multiply", "screen", "overlay"];

/** Canvas 2D composite operation for each blend mode. */
export function blendToCompositeOp(blend: LayerBlend): GlobalCompositeOperation {
  switch (blend) {
    case "multiply": return "multiply";
    case "screen": return "screen";
    case "overlay": return "overlay";
    default: return "source-over";
  }
}

export interface PaintLayerMeta {
  name: string;
  visible: boolean;
  /** 0–1, applied when compositing. */
  opacity: number;
  blend: LayerBlend;
  /** The bottom layer — opaque, cannot be removed. */
  isBase: boolean;
}

/** New overlay layer meta with a unique-ish default name. */
export function makeLayerMeta(existingCount: number): PaintLayerMeta {
  return { name: `Layer ${existingCount}`, visible: true, opacity: 1, blend: "normal", isBase: false };
}

/** Base-layer meta (index 0 of every stack). */
export function makeBaseMeta(): PaintLayerMeta {
  return { name: "Base", visible: true, opacity: 1, blend: "normal", isBase: true };
}

/** Only non-base layers with a valid index can be removed. */
export function canRemoveLayer(metas: readonly PaintLayerMeta[], index: number): boolean {
  const m = metas[index];
  return !!m && !m.isBase;
}

/**
 * Active index after removing `removed` from a stack of `lenAfter + 1`
 * layers: indices above the removed slot shift down; removing the active
 * layer activates the one below it (never < 0).
 */
export function nextActiveAfterRemove(active: number, removed: number): number {
  if (active === removed) return Math.max(0, removed - 1);
  return active > removed ? active - 1 : active;
}

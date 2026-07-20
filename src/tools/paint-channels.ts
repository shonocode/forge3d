/**
 * Non-albedo channel painting (F-M11) — pure math, headless.
 *
 * Roughness and metalness are painted as GRAYSCALE strokes into per-channel
 * canvases and packed into one glTF metallic-roughness texture:
 * G = roughness, B = metalness (the standard ORM layout minus occlusion).
 *
 * Packing trick: each channel canvas stores its scalar tinted into its own
 * RGB slot (roughness as pure green, metalness as pure blue). Compositing
 * them onto a black canvas with the additive "lighter" operation yields
 * (0, rough, metal) per texel with no per-pixel JS loops.
 *
 * The brush "value" comes from the shared color picker via Rec.709 luma —
 * white paints 1.0 (fully rough / fully metallic), black paints 0.
 */

export type PaintChannel = "albedo" | "roughness" | "metallic";

/** Rec.709 luma of a #rrggbb hex color, in [0, 1]. */
export function luminance01(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return y < 0 ? 0 : y > 1 ? 1 : y;
}

/** #rrggbb → [r, g, b] bytes. */
export function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16) || 0,
    parseInt(hex.slice(3, 5), 16) || 0,
    parseInt(hex.slice(5, 7), 16) || 0,
  ];
}

/**
 * RGB bytes that write scalar `v01` into the channel's packed slot
 * (green for roughness, blue for metalness). Albedo has no tint — callers
 * paint the picker color directly.
 */
export function channelTintRgb(channel: PaintChannel, v01: number): [number, number, number] {
  const v = Math.round(Math.max(0, Math.min(1, v01)) * 255);
  if (channel === "roughness") return [0, v, 0];
  if (channel === "metallic") return [0, 0, v];
  return [v, v, v];
}

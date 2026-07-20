/**
 * UV island packing (F-M9) — shelf-based rect packing that replaces the old
 * fixed grid. Islands keep their aspect ratio and are packed by descending
 * height into shelves, then the whole layout is uniformly scaled to fit the
 * 0–1 UV box. This wastes far less space than the grid (which forced every
 * island into an identical square cell regardless of shape).
 *
 * Pure and headless — Vitest-pinned. The unwrap integration (turning
 * placements into per-corner UVs) lives in uv-unwrap.ts.
 */

/** An island's un-normalized UV-space size. */
export interface PackRect {
  w: number;
  h: number;
}

/**
 * Where one island lands after packing. Island-local UVs map as
 * `packedU = (u - island.minU) * scale + offsetU` (same `scale` for every
 * island so relative texel density is preserved across the atlas).
 */
export interface PackPlacement {
  offsetU: number;
  offsetV: number;
  scale: number;
}

export interface PackResult {
  placements: PackPlacement[];
  /** Fraction of the 0–1 box covered by island bounding boxes (packing quality). */
  coverage: number;
}

/**
 * Shelf-pack `rects` into the unit square.
 *
 * `margin` (0–1 UV space) is the gap kept around every island; it's applied
 * in the pre-scale layout so the final gap scales down with everything else,
 * but it reliably separates islands.
 *
 * Order of operations:
 *  1. Add margin to each rect and sort by descending height.
 *  2. Lay them left-to-right on shelves; a rect that would overflow the
 *     target width starts a new shelf stacked above the previous.
 *  3. Uniformly scale the used bounding box to fit 0–1.
 *
 * The target shelf width is √(total padded area), which yields a roughly
 * square overall layout — the shape a uniform fit-to-unit-square rewards.
 */
export function packRects(rects: readonly PackRect[], margin = 0.02): PackResult {
  const n = rects.length;
  if (n === 0) return { placements: [], coverage: 0 };

  // Padded sizes + bounding-box areas.
  const padded = rects.map((r) => ({
    w: Math.max(r.w, 1e-6) + margin,
    h: Math.max(r.h, 1e-6) + margin,
  }));
  let totalArea = 0;
  let maxW = 0;
  for (const p of padded) {
    totalArea += p.w * p.h;
    if (p.w > maxW) maxW = p.w;
  }
  const shelfWidth = Math.max(maxW, Math.sqrt(totalArea));

  // Sort island indices by descending padded height for tight shelves.
  const order = [...Array(n).keys()].sort((a, b) => padded[b]!.h - padded[a]!.h);

  const rawX = new Array<number>(n);
  const rawY = new Array<number>(n);
  let cursorX = 0;
  let cursorY = 0;
  let shelfH = 0;
  let usedW = 0;

  for (const i of order) {
    const p = padded[i]!;
    if (cursorX > 0 && cursorX + p.w > shelfWidth) {
      // Overflow — start a new shelf above the current one.
      cursorY += shelfH;
      cursorX = 0;
      shelfH = 0;
    }
    rawX[i] = cursorX;
    rawY[i] = cursorY;
    cursorX += p.w;
    if (cursorX > usedW) usedW = cursorX;
    if (p.h > shelfH) shelfH = p.h;
  }
  const usedH = cursorY + shelfH;

  // Uniform fit into the unit square.
  const scale = 1 / Math.max(usedW, usedH, 1e-6);

  const placements: PackPlacement[] = new Array(n);
  for (let i = 0; i < n; i++) {
    // Offset by half the (scaled) margin so the padding sits around the
    // island, not just on its right/top.
    placements[i] = {
      offsetU: (rawX[i]! + margin / 2) * scale,
      offsetV: (rawY[i]! + margin / 2) * scale,
      scale,
    };
  }

  // Coverage = summed island (un-padded) bbox area at final scale.
  let covered = 0;
  for (let i = 0; i < n; i++) {
    covered += rects[i]!.w * rects[i]!.h * scale * scale;
  }

  return { placements, coverage: covered };
}

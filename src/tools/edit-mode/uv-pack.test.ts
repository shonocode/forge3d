import { describe, it, expect } from "vitest";
import { packRects, type PackRect } from "./uv-pack";

/** Axis-aligned bbox of a placed island in final UV space. */
function placedBox(rect: PackRect, p: { offsetU: number; offsetV: number; scale: number }) {
  return {
    minU: p.offsetU,
    minV: p.offsetV,
    maxU: p.offsetU + rect.w * p.scale,
    maxV: p.offsetV + rect.h * p.scale,
  };
}

function overlaps(
  a: ReturnType<typeof placedBox>,
  b: ReturnType<typeof placedBox>,
  eps = 1e-9
): boolean {
  return a.minU < b.maxU - eps && b.minU < a.maxU - eps && a.minV < b.maxV - eps && b.minV < a.maxV - eps;
}

describe("packRects", () => {
  it("returns empty for no islands", () => {
    expect(packRects([]).placements).toEqual([]);
  });

  it("keeps every island inside the 0–1 box", () => {
    const rects: PackRect[] = [
      { w: 2, h: 1 }, { w: 1, h: 3 }, { w: 1.5, h: 1.5 }, { w: 0.5, h: 2 },
    ];
    const { placements } = packRects(rects, 0.02);
    for (let i = 0; i < rects.length; i++) {
      const b = placedBox(rects[i]!, placements[i]!);
      expect(b.minU).toBeGreaterThanOrEqual(-1e-9);
      expect(b.minV).toBeGreaterThanOrEqual(-1e-9);
      expect(b.maxU).toBeLessThanOrEqual(1 + 1e-9);
      expect(b.maxV).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it("packs islands without overlap", () => {
    const rects: PackRect[] = [
      { w: 2, h: 1 }, { w: 1, h: 3 }, { w: 1.5, h: 1.5 }, { w: 0.5, h: 2 }, { w: 1, h: 1 },
    ];
    const { placements } = packRects(rects, 0.02);
    const boxes = rects.map((r, i) => placedBox(r, placements[i]!));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect(overlaps(boxes[i]!, boxes[j]!)).toBe(false);
      }
    }
  });

  it("shares one scale across all islands (uniform texel density)", () => {
    const { placements } = packRects([{ w: 3, h: 1 }, { w: 1, h: 1 }], 0.02);
    expect(placements[0]!.scale).toBeCloseTo(placements[1]!.scale, 12);
  });

  it("preserves aspect ratio per island", () => {
    const rects: PackRect[] = [{ w: 4, h: 1 }];
    const { placements } = packRects(rects, 0);
    const b = placedBox(rects[0]!, placements[0]!);
    expect((b.maxU - b.minU) / (b.maxV - b.minV)).toBeCloseTo(4, 5);
  });

  it("beats a naive grid on coverage for varied aspect ratios", () => {
    // Long thin strips: a square-cell grid wastes most of each cell.
    const rects: PackRect[] = Array.from({ length: 6 }, () => ({ w: 4, h: 0.5 }));
    const { coverage } = packRects(rects, 0.01);
    // Grid would put each 8:1 strip in a square cell → ≤ ~1/8 fill ≈ 0.125.
    expect(coverage).toBeGreaterThan(0.4);
  });

  it("a single island nearly fills the box", () => {
    const { coverage } = packRects([{ w: 2, h: 2 }], 0);
    expect(coverage).toBeCloseTo(1, 5);
  });
});

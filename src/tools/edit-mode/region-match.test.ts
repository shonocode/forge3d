/**
 * `selectSimilarRegion` (compat-backlog C100) on a 6 × 6 sheet; the counts are Blender 5.1.1's
 * (`compare-select.ts`, `region-grid-*`).
 */
import { describe, it, expect } from "vitest";
import type { MeshData } from "../../lib/mesh";
import { selectSimilarRegion } from "./region-match";

function grid6(): MeshData {
  const n = 6;
  const positions: number[] = [];
  for (let r = 0; r <= n; r++) for (let c = 0; c <= n; c++) positions.push(c * 0.1, 0, r * 0.1);
  const polys: number[][] = [];
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) polys.push([r * (n + 1) + c, (r + 1) * (n + 1) + c, (r + 1) * (n + 1) + c + 1, r * (n + 1) + c + 1]);
  return { positions: new Float32Array(positions), polys };
}

describe("selectSimilarRegion", () => {
  it("a 2×2 block in the middle finds blocks over the whole sheet", () => {
    expect(selectSimilarRegion(grid6(), "face", { faces: [14, 15, 20, 21] }).faces.length).toBe(36);
  });

  it("a 2×2 block in a corner finds 32 faces' worth", () => {
    expect(selectSimilarRegion(grid6(), "face", { faces: [0, 1, 6, 7] }).faces.length).toBe(32);
  });

  it("a 3×2 block: the regions claim their edges in edge order", () => {
    expect(selectSimilarRegion(grid6(), "face", { faces: [7, 8, 9, 13, 14, 15] }).faces.length).toBe(14);
  });

  it("two faces with no vertex inside add nothing (the walk has nowhere to go)", () => {
    expect([...selectSimilarRegion(grid6(), "face", { faces: [14, 15] }).faces].sort((a, b) => a - b)).toEqual([14, 15]);
  });

  it("refuses one face", () => {
    expect(() => selectSimilarRegion(grid6(), "face", { faces: [14] })).toThrow(/no face regions/);
  });
});

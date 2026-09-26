import { describe, expect, it } from "vitest";
import type { MeshData } from "../lib/mesh";
import { screwModifier } from "./screw-modifier";

// A two-edge profile in the xz plane, starting on the Z axis.
function profile(): MeshData {
  return {
    positions: new Float32Array([0, 0, 0, 0.5, 0, 0.2, 0.3, 0, 0.6]),
    polys: [],
    edges: [
      [0, 1],
      [1, 2],
    ],
  };
}

describe("screwModifier", () => {
  it("a whole turn closes: steps rings of every vertex, a quad per edge per step", () => {
    const out = screwModifier(profile(), { steps: 8 });
    expect(out.positions.length / 3).toBe(3 * 8);
    expect(out.polys).toHaveLength(2 * 8);
  });

  it("an open turn keeps both ends: steps + 1 rings", () => {
    const out = screwModifier(profile(), { steps: 4, angle: Math.PI });
    expect(out.positions.length / 3).toBe(3 * 5);
    expect(out.polys).toHaveLength(2 * 4);
    // Half a turn about Z takes (0.5, 0, 0.2) to (−0.5, 0, 0.2).
    expect(out.positions[(4 * 3 + 1) * 3]).toBeCloseTo(-0.5, 5);
  });

  it("mergeVertices welds the copies of a vertex on the axis", () => {
    const out = screwModifier(profile(), { steps: 8, mergeVertices: true });
    expect(out.positions.length / 3).toBe(1 + 2 * 8);
    // The bands at the axis become triangles.
    expect(out.polys.filter((p) => p.length === 3)).toHaveLength(8);
  });

  it("drops the input's faces and bands every edge of them", () => {
    const quad: MeshData = {
      positions: new Float32Array([1, 0, 0, 2, 0, 0, 2, 0, 1, 1, 0, 1]),
      polys: [[0, 1, 2, 3]],
      materials: [3],
    };
    const out = screwModifier(quad, { axis: "Z", steps: 4, angle: Math.PI / 2 });
    expect(out.polys).toHaveLength(4 * 4);
    expect(new Set(out.materials)).toEqual(new Set([3]));
  });
});

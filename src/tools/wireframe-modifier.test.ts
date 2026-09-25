import { describe, it, expect } from "vitest";
import { wireframeModifier } from "./wireframe-modifier";
import type { MeshData } from "../lib/mesh";

const cube = (): MeshData => ({
  positions: new Float32Array([
    -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
    -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
  ]),
  polys: [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]],
});

describe("wireframeModifier (Blender's Wireframe modifier — compat-backlog B4)", () => {
  it("makes a cube into bars: two points per vertex, one per corner, two quads per face side", () => {
    const out = wireframeModifier(cube());
    expect(out.positions.length / 3).toBe(8 * 2 + 24);
    expect(out.polys).toHaveLength(24 * 2);
  });

  it("keeps the input with replace off", () => {
    const out = wireframeModifier(cube(), { replace: false });
    expect(out.positions.length / 3).toBe(8 + 8 * 2 + 24);
    expect(out.polys).toHaveLength(6 + 24 * 2);
  });

  it("even thickness pushes a right-angled corner's point further in than plain", () => {
    // The first corner point is the 17th vertex (after the 8 × 2 side points).
    const corner = (m: MeshData): number[] => [m.positions[16 * 3]!, m.positions[16 * 3 + 1]!, m.positions[16 * 3 + 2]!];
    const even = corner(wireframeModifier(cube(), { thickness: 0.1 }));
    const plain = corner(wireframeModifier(cube(), { thickness: 0.1, evenThickness: false }));
    const fromCorner = (p: number[]): number => Math.hypot(p[0]! + 0.5, p[1]! + 0.5, p[2]! + 0.5);
    expect(fromCorner(even)).toBeCloseTo(fromCorner(plain) * Math.SQRT2, 5);
  });
});

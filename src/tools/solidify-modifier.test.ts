import { describe, it, expect } from "vitest";
import { solidifyModifier } from "./solidify-modifier";
import type { MeshData } from "../lib/mesh";

/** A unit cube without its top: five quads, a square rim of four edges. */
const openCube = (): MeshData => ({
  positions: new Float32Array([
    -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
    -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
  ]),
  // Missing +y ([3, 7, 6, 2]).
  polys: [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [0, 4, 7, 3], [1, 2, 6, 5]],
});

describe("solidifyModifier (Blender's Solidify modifier, Simple mode — compat-backlog B3)", () => {
  it("doubles the mesh and closes each boundary edge with a rim quad", () => {
    const out = solidifyModifier(openCube(), { thickness: 0.1 });
    expect(out.positions.length / 3).toBe(16);
    expect(out.polys).toHaveLength(5 + 5 + 4);
  });

  it("puts the shell inside by default (offset -1) and outside at offset 1", () => {
    const inside = solidifyModifier(openCube(), { thickness: 0.1 });
    // The copy of vertex 0 moves inward, toward the centre.
    const c = [inside.positions[8 * 3]!, inside.positions[8 * 3 + 1]!, inside.positions[8 * 3 + 2]!];
    expect(Math.hypot(...c)).toBeLessThan(Math.hypot(0.5, 0.5, 0.5));
    const outside = solidifyModifier(openCube(), { thickness: 0.1, offset: 1 });
    // At offset 1 the original moves outward and the copy stays.
    expect(outside.positions[8 * 3]).toBeCloseTo(-0.5, 6);
    expect(Math.abs(outside.positions[0]!)).toBeGreaterThan(0.5);
  });

  it("rim only keeps the input's faces and adds just the rim", () => {
    const out = solidifyModifier(openCube(), { thickness: 0.1, rimOnly: true });
    expect(out.positions.length / 3).toBe(8 + 4);
    expect(out.polys).toHaveLength(5 + 4);
  });

  it("even thickness pushes a corner further than plain", () => {
    const plain = solidifyModifier(openCube(), { thickness: 0.1 });
    const even = solidifyModifier(openCube(), { thickness: 0.1, evenThickness: true });
    const d = (m: MeshData): number =>
      Math.hypot(m.positions[8 * 3]! + 0.5, m.positions[8 * 3 + 1]! + 0.5, m.positions[8 * 3 + 2]! + 0.5);
    expect(d(even)).toBeGreaterThan(d(plain));
  });
});

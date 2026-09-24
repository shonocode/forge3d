import { describe, it, expect } from "vitest";
import { meshFromData, meshToData } from "../../lib/mesh";
import { extrudeManifold } from "./face-transform";

/** A unit cube with its top face only (+y), six quads. */
function cube() {
  return {
    positions: Float32Array.from([-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5]),
    polys: [
      [0, 3, 2, 1],
      [4, 5, 6, 7],
      [0, 1, 5, 4],
      [3, 7, 6, 2],
      [0, 4, 7, 3],
      [1, 2, 6, 5],
    ],
  };
}

describe("extrudeManifold", () => {
  it("folds every wall into the sides when they stand perpendicular — the top just moves", () => {
    // Blender: a cube's top pushed out stays 8 vertices / 6 faces, 1.2 tall.
    const em = meshFromData(cube());
    extrudeManifold(em, new Set([3]), [0, 0.2, 0]);
    const out = meshToData(em);
    expect(out.positions.length / 3).toBe(8);
    expect(out.polys).toHaveLength(6);
    const ys = new Set<number>();
    for (let i = 1; i < out.positions.length; i += 3) ys.add(Math.round(out.positions[i]! * 100) / 100);
    expect([...ys].sort()).toEqual([-0.5, 0.7]);
  });
});

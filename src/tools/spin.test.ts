import { describe, expect, it } from "vitest";
import type { MeshData } from "../lib/mesh";
import { spin } from "./spin";

// A wire profile: three points along x at y = 0, two edges, no face.
function profile(): MeshData {
  return {
    positions: new Float32Array([1, 0, 0, 1.5, 0.5, 0, 1, 1, 0]),
    polys: [],
    edges: [
      [0, 1],
      [1, 2],
    ],
  };
}
const all = { verts: [0, 1, 2], edges: [[0, 1], [1, 2]] as [number, number][] };

describe("spin", () => {
  it("sweeps a wire profile into a band of quads, one ring per step", () => {
    const out = spin(profile(), all, { axis: [0, 1, 0], angle: Math.PI, steps: 4 });
    expect(out.positions.length / 3).toBe(3 * 5);
    expect(out.polys).toHaveLength(2 * 4);
    // The last ring is the profile turned half way round: x negated.
    const last = [...out.positions.slice(12 * 3)];
    expect(last[0]).toBeCloseTo(-1, 5);
    expect(last[2]).toBeCloseTo(0, 5);
  });

  it("with useMerge closes a whole turn instead of doubling the first ring", () => {
    const open = spin(profile(), all, { axis: [0, 1, 0], angle: Math.PI * 2, steps: 6 });
    const shut = spin(profile(), all, { axis: [0, 1, 0], angle: Math.PI * 2, steps: 6, useMerge: true });
    expect(open.positions.length / 3).toBe(3 * 7);
    expect(shut.positions.length / 3).toBe(3 * 6);
    expect(shut.polys).toHaveLength(2 * 6);
    expect(shut.edges ?? []).toHaveLength(0);
  });

  it("useDuplicate leaves turned copies, unjoined", () => {
    const out = spin(profile(), all, { axis: [0, 1, 0], angle: Math.PI, steps: 2, useDuplicate: true });
    expect(out.positions.length / 3).toBe(9);
    expect(out.polys).toHaveLength(0);
    expect(out.edges).toHaveLength(6);
  });

  it("turns dvec with each step's rotation before moving the step", () => {
    // A quarter turn per step about y; dvec along x turns to −z, then −x.
    const out = spin(
      { positions: new Float32Array([1, 0, 0]), polys: [] },
      { verts: [0] },
      { axis: [0, 1, 0], angle: Math.PI, steps: 2, dvec: [0.1, 0, 0] },
    );
    // Step 1: (1,0,0) turned 90° → (0,0,−1), plus R90·dvec = (0,0,−0.1).
    expect(out.positions[3 * 1 + 2]).toBeCloseTo(-1.1, 5);
  });
});

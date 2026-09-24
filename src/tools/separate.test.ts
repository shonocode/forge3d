import { describe, it, expect } from "vitest";
import { separateSelected, separateByMaterial } from "./mesh-repair";

/** Three quads in a row along x, sharing edges. */
function strip() {
  const positions: number[] = [];
  for (let x = 0; x <= 3; x++) positions.push(x, 0, 0, x, 0, 1);
  const polys = [0, 1, 2].map((i) => [i * 2, i * 2 + 1, i * 2 + 3, i * 2 + 2]);
  return { positions: Float32Array.from(positions), polys };
}

describe("separateSelected", () => {
  it("copies the chosen faces out and keeps the seam's vertices on both sides", () => {
    const { part, rest } = separateSelected(strip(), new Set([1]));
    expect(part.polys).toHaveLength(1);
    expect(part.positions.length / 3).toBe(4);
    // The rest keeps both outer quads and all four seam vertices.
    expect(rest.polys).toHaveLength(2);
    expect(rest.positions.length / 3).toBe(8);
  });

  it("drops a vertex from the rest only when nothing left uses it", () => {
    const { rest } = separateSelected(strip(), new Set([2]));
    expect(rest.positions.length / 3).toBe(6);
  });
});

describe("separateByMaterial", () => {
  it("peels off the first face's material first and leaves the last in the original", () => {
    const mesh = { ...strip(), materials: [2, 0, 2] };
    const pieces = separateByMaterial(mesh);
    expect(pieces.map((p) => p.material)).toEqual([2, 0]);
    expect(pieces[0]!.mesh.polys).toHaveLength(2);
    expect(pieces[1]!.mesh.polys).toHaveLength(1);
  });
});

import { describe, it, expect } from "vitest";
import type { MeshData } from "../../lib/mesh";
import { selectEdgeLoops, selectEdgeRings } from "./edge-walkers";

/** Parity rows in `compare-select.ts` (compat-backlog C80); the sheet is the 4 x 4 grid they use. */
const grid = (): MeshData => {
  const positions: number[] = [];
  for (let r = 0; r <= 4; r++) for (let c = 0; c <= 4; c++) positions.push(c * 0.1 - 0.2, r * 0.1 - 0.2, 0);
  const polys: number[][] = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) polys.push([r * 5 + c, r * 5 + c + 1, (r + 1) * 5 + c + 1, (r + 1) * 5 + c]);
  return { positions: Float32Array.from(positions), polys };
};

describe("selectEdgeLoops", () => {
  it("takes the column through a middle edge of a sheet", () => {
    const sel = selectEdgeLoops(grid(), "edge", { edges: [[7, 12]] });
    expect(sel.edges).toEqual([[2, 7], [7, 12], [12, 17], [17, 22]]);
  });

  it("stops at the corners of the sheet's boundary unless corners are not delimiters", () => {
    expect(selectEdgeLoops(grid(), "edge", { edges: [[0, 1]] }).edges).toHaveLength(4);
    expect(selectEdgeLoops(grid(), "edge", { edges: [[0, 1]] }, { delimit: [] }).edges).toHaveLength(16);
  });

  it("stops before a vertex on a seam, and walks along the seam when it starts on one", () => {
    const seams = new Set(["15_16", "16_17", "17_18", "18_19"]);
    const across = selectEdgeLoops({ ...grid(), seams }, "edge", { edges: [[7, 12]] }, { delimit: ["seam"] });
    expect(across.edges).toHaveLength(3);
    const along = selectEdgeLoops({ ...grid(), seams }, "edge", { edges: [[16, 17]] }, { delimit: ["seam"] });
    expect(along.edges).toEqual([[15, 16], [16, 17], [17, 18], [18, 19]]);
  });
});

describe("selectEdgeRings", () => {
  it("runs across the faces from a middle edge, and stops at a material change when asked", () => {
    expect(selectEdgeRings(grid(), "edge", { edges: [[1, 6]] }).edges).toHaveLength(5);
    const materials = [0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1];
    expect(selectEdgeRings({ ...grid(), materials }, "edge", { edges: [[1, 6]] }, { delimit: ["material", "ngons"] }).edges).toHaveLength(3);
  });

  it("selects only the edge it starts on when that edge delimits", () => {
    const seams = new Set(["7_8"]);
    expect(selectEdgeRings({ ...grid(), seams }, "edge", { edges: [[7, 8]] }, { delimit: ["seam", "ngons"] }).edges).toEqual([[7, 8]]);
  });
});

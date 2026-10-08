import { describe, it, expect } from "vitest";
import type { MeshData } from "../../lib/mesh";
import { selectShortestPath } from "./select-path";
import { selectSimilar } from "./select-similar";

/** Parity rows are `path-*` in `compare-select.ts` (compat-backlog C83). */
const grid = (): MeshData => {
  const positions: number[] = [];
  for (let r = 0; r <= 4; r++) for (let c = 0; c <= 4; c++) positions.push(c * 0.1 - 0.2, r * 0.1 - 0.2, 0);
  const polys: number[][] = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) polys.push([r * 5 + c, r * 5 + c + 1, (r + 1) * 5 + c + 1, (r + 1) * 5 + c]);
  return { positions: Float32Array.from(positions), polys };
};

describe("selectShortestPath", () => {
  it("joins two vertices along edges, or across faces with face stepping", () => {
    expect(selectShortestPath(grid(), "vertex", { verts: [0, 24] }).verts).toHaveLength(9);
    expect(selectShortestPath(grid(), "vertex", { verts: [0, 24] }, { faceStep: true }).verts).toEqual([0, 6, 12, 18, 24]);
  });

  it("deselects a path that is already selected", () => {
    expect(selectShortestPath(grid(), "vertex", { verts: [0, 1] }).verts).toEqual([]);
  });

  it("leaves the first element and every other one alone with the checker", () => {
    const sel = selectShortestPath(grid(), "vertex", { verts: [0, 4] }, { skip: 1, nth: 1 });
    // 0 and 4 were selected; along 0‥4 the checker selects depths 1 and 3 (vertices 2 and 4).
    expect(sel.verts).toEqual([0, 2, 4]);
  });

  it("steps edges across faces into a ring", () => {
    const sel = selectShortestPath(grid(), "edge", { edges: [[0, 5], [3, 8]] }, { faceStep: true });
    expect(sel.edges).toHaveLength(4);
  });

  it("does nothing with fewer than two selected", () => {
    expect(selectShortestPath(grid(), "face", { faces: [3] }).faces).toEqual([3]);
  });
});

describe("selectSimilar", () => {
  it("selects boundary edges like a boundary edge", () => {
    const sel = selectSimilar(grid(), "edge", { edges: [[0, 1]] }, { type: "EDGE_FACES" });
    expect(sel.edges).toHaveLength(16);
  });

  it("compares LESS against the median of the selected values, as Blender's KD-tree search does", () => {
    // Selected areas 1, 4 and 9 (the median is 4, the largest 9); the unselected face's area is 6.
    const mesh: MeshData = {
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 3, 0, 0, 5, 0, 0, 5, 2, 0, 3, 2, 0, 6, 0, 0, 8, 0, 0, 8, 3, 0, 6, 3, 0, 9, 0, 0, 12, 0, 0, 12, 3, 0, 9, 3, 0]),
      polys: [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 14, 15]],
    };
    const sel = selectSimilar(mesh, "face", { faces: [0, 1, 3] }, { type: "FACE_AREA", compare: "LESS", threshold: 0 });
    expect(sel.faces).toEqual([0, 1, 3]);
  });
});

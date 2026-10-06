import { describe, it, expect } from "vitest";
import type { MeshData } from "../../lib/mesh";
import { selectAxis, selectByPoleCount, selectMirror, selectRandom } from "./select-sets";

/** Parity rows are in `compare-select.ts` (compat-backlog C81). */
const grid = (): MeshData => {
  const positions: number[] = [];
  for (let r = 0; r <= 4; r++) for (let c = 0; c <= 4; c++) positions.push(c * 0.1 - 0.2, r * 0.1 - 0.2, 0);
  const polys: number[][] = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) polys.push([r * 5 + c, r * 5 + c + 1, (r + 1) * 5 + c + 1, (r + 1) * 5 + c]);
  return { positions: Float32Array.from(positions), polys };
};

describe("selectAxis", () => {
  it("takes the columns at or beyond the active vertex's x, and the faces they close", () => {
    const pos = selectAxis(grid(), "vertex", { verts: [12], active: 12 }, { sign: "pos", axis: "x" });
    expect(pos.verts).toHaveLength(15);
    expect(pos.faces).toHaveLength(8);
    expect(selectAxis(grid(), "vertex", { verts: [12], active: 12 }, { sign: "align", axis: "y" }).verts).toHaveLength(25 - 20);
  });

  it("does nothing when everything is selected", () => {
    const all = Array.from({ length: 25 }, (_, i) => i);
    expect(selectAxis(grid(), "vertex", { verts: all, active: 0 }, { sign: "pos" }).verts).toHaveLength(25);
  });
});

describe("selectRandom", () => {
  it("takes int(count * ratio) elements, the same ones for the same seed", () => {
    const a = selectRandom(grid(), "vertex", {}, { ratio: 0.3, seed: 0 });
    expect(a.verts).toHaveLength(7);
    expect(selectRandom(grid(), "vertex", {}, { ratio: 0.3, seed: 0 }).verts).toEqual(a.verts);
    expect(selectRandom(grid(), "vertex", {}, { ratio: 0.3, seed: 1 }).verts).not.toEqual(a.verts);
  });
});

describe("selectByPoleCount", () => {
  it("leaves out the rim of a sheet (non-manifold) unless asked, and finds the interior fours' complement", () => {
    expect(selectByPoleCount(grid(), "vertex", {}).verts).toEqual([]);
    expect(selectByPoleCount(grid(), "vertex", {}, { excludeNonManifold: false }).verts).toHaveLength(16);
    expect(selectByPoleCount(grid(), "vertex", {}, { poleCount: 4, type: "equal" }).verts).toHaveLength(9);
  });
});

describe("selectMirror", () => {
  it("selects the vertex at the mirrored position and drops the original unless extending", () => {
    const m = selectMirror(grid(), "vertex", { verts: [0] }, { axes: ["x"] });
    expect(m.verts).toEqual([4]);
    expect(selectMirror(grid(), "vertex", { verts: [0] }, { axes: ["x"], extend: true }).verts).toEqual([0, 4]);
  });
});

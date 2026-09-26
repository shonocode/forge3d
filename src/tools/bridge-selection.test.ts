import { describe, expect, it } from "vitest";
import type { MeshData } from "../lib/mesh";
import { bridgeSelection } from "./bridge-selection";

// Two unit squares, one at y = 0 facing down and one at y = 1 facing up,
// each a single quad: the ends of a box with no walls.
function twoSquares(): MeshData {
  return {
    positions: new Float32Array([
      0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1,
      0, 1, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1,
    ]),
    polys: [
      [0, 1, 2, 3],
      [4, 7, 6, 5],
    ],
  };
}
const rims: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
];

describe("bridgeSelection", () => {
  it("bridges two loops with a band of quads", () => {
    const out = bridgeSelection(twoSquares(), { edges: rims });
    expect(out.polys).toHaveLength(2 + 4);
    expect(out.positions.length / 3).toBe(8);
  });

  it("cuts the band with number_cuts, PATH by default", () => {
    const out = bridgeSelection(twoSquares(), { edges: rims }, { cuts: 2 });
    expect(out.positions.length / 3).toBe(8 + 4 * 2);
    expect(out.polys).toHaveLength(2 + 4 * 3);
    // PATH with smoothness 1: the handles space the cuts unevenly along the
    // straight band, so they are not at y = 1/3 and 2/3.
    const ys = [...Array(8).keys()].map((k) => out.positions[(8 + k) * 3 + 1]!);
    expect(ys.some((y) => Math.abs(y - 1 / 3) > 1e-3 && Math.abs(y - 2 / 3) > 1e-3)).toBe(true);
  });

  it("LINEAR with no profile leaves the cuts evenly on the edges", () => {
    const out = bridgeSelection(twoSquares(), { edges: rims }, { cuts: 2, interpolation: "LINEAR", smoothness: 0 });
    const ys = [...Array(8).keys()].map((k) => out.positions[(8 + k) * 3 + 1]!).sort();
    for (const y of ys) expect(Math.min(Math.abs(y - 1 / 3), Math.abs(y - 2 / 3))).toBeLessThan(1e-6);
  });

  it("useMerge welds the first loop into the second at mergeFactor", () => {
    const out = bridgeSelection(twoSquares(), { edges: rims }, { useMerge: true, mergeFactor: 0.25 });
    expect(out.positions.length / 3).toBe(4);
    for (let v = 0; v < 4; v++) expect(out.positions[v * 3 + 1]).toBeCloseTo(0.25, 6);
  });

  it("given faces, deletes them and bridges the holes they leave", () => {
    // A closed cube: select the top and bottom and a tunnel of four walls
    // stands where they were — the existing walls, so nothing new is made.
    const cube: MeshData = {
      positions: twoSquares().positions,
      polys: [
        [0, 1, 2, 3],
        [4, 7, 6, 5],
        [0, 4, 5, 1],
        [1, 5, 6, 2],
        [2, 6, 7, 3],
        [3, 7, 4, 0],
      ],
    };
    const out = bridgeSelection(cube, { faces: [0, 1] }, { cuts: 1, interpolation: "LINEAR", smoothness: 0 });
    expect(out.polys).toHaveLength(8);
    expect(out.positions.length / 3).toBe(12);
  });
});

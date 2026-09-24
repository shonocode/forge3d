import { describe, it, expect } from "vitest";
import { build, blenderShuffle } from "./build";

/** A 2×2 grid of quads, 9 vertices. */
function grid() {
  const positions: number[] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) positions.push(c, 0, r);
  const polys: number[][] = [];
  for (let r = 0; r < 2; r++)
    for (let c = 0; c < 2; c++) polys.push([r * 3 + c, (r + 1) * 3 + c, (r + 1) * 3 + c + 1, r * 3 + c + 1]);
  return { positions: Float32Array.from(positions), polys };
}

describe("build", () => {
  it("shows every face once the frame passes the end, none before the start", () => {
    expect(build(grid(), { frame: 101 }).polys).toHaveLength(4);
    expect(build(grid(), { frame: 1 }).positions).toHaveLength(0);
  });

  it("keeps faces first to last, vertices in the order they are first used", () => {
    const out = build(grid(), { frame: 51 }); // half: 2 of 4 faces
    expect(out.polys).toHaveLength(2);
    expect(out.polys[0]).toEqual([0, 1, 2, 3]);
  });

  it("keeps edges between surviving vertices even where their face is gone", () => {
    // A strip of three quads listed left, right, middle. Two of three kept:
    // the left and right ones, whose corners include both ends of the middle
    // quad's two cross edges — those come out as loose edges.
    const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 0, 0, 1, 1, 0, 1, 2, 0, 1, 3, 0, 1]);
    const polys = [
      [0, 4, 5, 1],
      [2, 6, 7, 3],
      [1, 5, 6, 2],
    ];
    const out = build({ positions, polys }, { frame: 68 }); // 3 × 0.67 → 2
    expect(out.polys).toHaveLength(2);
    expect(out.positions.length / 3).toBe(8);
    expect(out.edges).toHaveLength(2);
  });

  it("reverse counts down", () => {
    expect(build(grid(), { frame: 26, reverse: true }).polys).toHaveLength(3);
  });

  it("shuffles with Blender's generator — a permutation, the same for the same seed", () => {
    const a = blenderShuffle(10, 7);
    expect([...a].sort((x, y) => x - y)).toEqual([...Array(10).keys()]);
    expect(blenderShuffle(10, 7)).toEqual(a);
    expect(blenderShuffle(10, 8)).not.toEqual(a);
  });
});

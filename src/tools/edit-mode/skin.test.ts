import { describe, it, expect } from "vitest";
import type { MeshData } from "../../lib/mesh";
import { skin } from "./skin";

/**
 * `skin`, against Blender 5.1.1 — every number from `probe-skin.py`.
 *
 * The constants (how many rings, where they sit) were read from
 * `MOD_skin.cc`; these tests are the measurements that confirmed them.
 */

function skeleton(points: [number, number, number][], edges: [number, number][]): MeshData {
  return { positions: Float32Array.from(points.flat()), polys: [], edges };
}

function coords(m: MeshData): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < m.positions.length; i += 3)
    out.push([m.positions[i]!, m.positions[i + 1]!, m.positions[i + 2]!]);
  return out;
}

function expectCoords(got: number[][], want: number[][]): void {
  expect(got.length).toBeGreaterThanOrEqual(want.length);
  want.forEach((w, i) => {
    for (let k = 0; k < 3; k++) expect(got[i]![k]!, `vertex ${i} axis ${k}`).toBeCloseTo(w[k]!, 4);
  });
}

describe("skin", () => {
  it("wraps one edge in a square tube with two rings along it", () => {
    // Blender: 16 vertices, 14 quads. L / (r̄₀ + r̄₁) = 1 / 0.5 = 2 rings.
    const out = skin(skeleton([[0, 0, 0], [0, 0, 1]], [[0, 1]]));
    expect(out.positions.length / 3).toBe(16);
    expect(out.polys).toHaveLength(14);
    expect(out.polys.every((p) => p.length === 4)).toBe(true);
    expectCoords(coords(out), [
      [0.25, -0.25, 0], [-0.25, -0.25, 0], [-0.25, 0.25, 0], [0.25, 0.25, 0],
      [0.25, -0.25, 1], [-0.25, -0.25, 1], [-0.25, 0.25, 1], [0.25, 0.25, 1],
      [0.25, -0.25, 1 / 3], [-0.25, -0.25, 1 / 3], [-0.25, 0.25, 1 / 3], [0.25, 0.25, 1 / 3],
      [0.25, -0.25, 2 / 3], [-0.25, -0.25, 2 / 3], [-0.25, 0.25, 2 / 3], [0.25, 0.25, 2 / 3],
    ]);
    // The two caps, wound as Blender winds them.
    expect(out.polys[0]).toEqual([0, 1, 2, 3]);
    expect(out.polys[1]).toEqual([7, 6, 5, 4]);
  });

  it("orients an edge off the vertical by z × x", () => {
    // Blender, along x and along the diagonal (1, 1, 1).
    const x = skin(skeleton([[0, 0, 0], [1, 0, 0]], [[0, 1]]));
    expectCoords(coords(x), [[0, 0.25, -0.25], [0, -0.25, -0.25], [0, -0.25, 0.25], [0, 0.25, 0.25]]);
    const d = skin(skeleton([[0, 0, 0], [1, 1, 1]], [[0, 1]]));
    expect(d.positions.length / 3).toBe(20); // √3 / 0.5 → 3 rings
    expectCoords(coords(d), [
      [-0.07471, 0.27884, -0.20412], [0.27884, -0.07471, -0.20412],
      [0.07471, -0.27884, 0.20412], [-0.27884, 0.07471, 0.20412],
    ]);
  });

  it("counts rings by length over radius", () => {
    // Radius 0.5 on a unit edge: one ring, 12 vertices.
    expect(skin(skeleton([[0, 0, 0], [0, 0, 1]], [[0, 1]]), { radius: 0.5 }).positions.length / 3).toBe(12);
  });

  it("maps radius x and y onto the edge's two cross axes", () => {
    for (const [r, xr, yr] of [[[0.5, 0.1], 0.5, 0.1], [[0.1, 0.5], 0.1, 0.5]] as const) {
      const c = coords(skin(skeleton([[0, 0, 0], [0, 0, 1]], [[0, 1]]), { radius: r }));
      expect(Math.max(...c.map((p) => p[0]!))).toBeCloseTo(xr, 6);
      expect(Math.max(...c.map((p) => p[1]!))).toBeCloseTo(yr, 6);
    }
  });

  it("spaces the rings by the radius ratio when the ends differ", () => {
    // Radii 0.5 → 0.1: one ring at t = 0.5^0.6 = 0.65975, radius 0.2361.
    const c = coords(
      skin(skeleton([[0, 0, 0], [0, 0, 1]], [[0, 1]]), { radius: [[0.5, 0.5], [0.1, 0.1]] }),
    );
    expectCoords(c.slice(8), [
      [0.2361, -0.2361, 0.65975], [-0.2361, -0.2361, 0.65975],
      [-0.2361, 0.2361, 0.65975], [0.2361, 0.2361, 0.65975],
    ]);
  });

  it("gives a straight or bent middle node one ring", () => {
    // Blender: 28 vertices for both; the L's middle ring sits on the bisector.
    const straight = skin(skeleton([[0, 0, 0], [0, 0, 1], [0, 0, 2]], [[0, 1], [1, 2]]));
    expect(straight.positions.length / 3).toBe(28);
    expect(straight.polys).toHaveLength(26);
    const bent = skin(skeleton([[0, 0, 0], [0, 0, 1], [1, 0, 1]], [[0, 1], [1, 2]]));
    expect(bent.positions.length / 3).toBe(28);
    expectCoords(coords(bent).slice(4, 12), [
      [0.17678, -0.25, 0.82322], [-0.17678, -0.25, 1.17678],
      [-0.17678, 0.25, 1.17678], [0.17678, 0.25, 0.82322],
      [1, -0.25, 0.75], [1, -0.25, 1.25], [1, 0.25, 1.25], [1, 0.25, 0.75],
    ]);
  });

  it("builds a different mesh when the root moves", () => {
    // Blender: 28 / 26 with the root at an end, 32 / 30 with it in the middle,
    // where the node gets two bridged frames instead of one.
    const chain = skeleton([[0, 0, 0], [0, 0, 1], [0, 0, 2]], [[0, 1], [1, 2]]);
    for (const [root, verts, faces] of [[0, 28, 26], [1, 32, 30], [2, 28, 26]] as const) {
      const out = skin(chain, { roots: [root] });
      expect(out.positions.length / 3, `root ${root}`).toBe(verts);
      expect(out.polys, `root ${root}`).toHaveLength(faces);
    }
  });

  it("ring count repeats per edge along a longer chain", () => {
    // Blender: five in a row is 52 vertices, 50 quads.
    const five = skin(skeleton([0, 1, 2, 3, 4].map((i) => [0, 0, i]), [[0, 1], [1, 2], [2, 3], [3, 4]]));
    expect(five.positions.length / 3).toBe(52);
    expect(five.polys).toHaveLength(50);
  });

  it("refuses a branch node rather than guessing", () => {
    expect(() =>
      skin(skeleton([[0, 0, 0], [0, 0, 1], [0, 0, 2], [1, 0, 1]], [[0, 1], [1, 2], [1, 3]])),
    ).toThrow(/branch nodes/);
  });
});

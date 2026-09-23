import { describe, it, expect } from "vitest";
import type { MeshData } from "../../lib/mesh";
import { setSharpnessByAngle } from "./sharpness";

/**
 * `setSharpnessByAngle`, against Blender.
 *
 * Every number is Blender 5.1.1, from `probe-sharpness.py` and
 * `probe-sharpness2.py`. The second probe exists because the first could not
 * see two of the five answers — the threshold, because the case was not
 * producing the angle it was named after, and `extend`, because the edge
 * marked by hand was a boundary edge, which this operator never touches.
 */

/** Two quads hinged along the x axis, the second rotated by `deg`. */
function hinge(deg: number, size = 0.2): MeshData {
  const a = (deg * Math.PI) / 180;
  return {
    positions: Float32Array.from([
      -size, 0, 0,
      size, 0, 0,
      size, 0, size,
      -size, 0, size,
      size, Math.sin(a) * size, -Math.cos(a) * size,
      -size, Math.sin(a) * size, -Math.cos(a) * size,
    ]),
    polys: [
      [0, 1, 2, 3],
      [1, 0, 5, 4],
    ],
  };
}

/** Three quads in a row: the first fold `degA`, the second a further `degB`. */
function strip(degA: number, degB: number, size = 0.2): MeshData {
  const a = (degA * Math.PI) / 180;
  const b = ((degA + degB) * Math.PI) / 180;
  const pts: [number, number][] = [
    [0, 0],
    [0, size],
    [Math.sin(a) * size, size + Math.cos(a) * size],
    [Math.sin(a) * size + Math.sin(b) * size, size + Math.cos(a) * size + Math.cos(b) * size],
  ];
  const positions: number[] = [];
  for (const [y, z] of pts) positions.push(-size, y, z, size, y, z);
  return {
    positions: Float32Array.from(positions),
    polys: [
      [0, 1, 3, 2],
      [2, 3, 5, 4],
      [4, 5, 7, 6],
    ],
  };
}

const deg = (d: number): number => (d * Math.PI) / 180;

describe("setSharpnessByAngle", () => {
  it("marks an edge whose faces meet at the limit or more", () => {
    // Measured on hinges of 10, 30, 45, 60, 90 and 120 degrees, each asked one
    // degree either side of its own angle: below is sharp, above is not.
    for (const fold of [10, 30, 45, 60, 90, 120]) {
      const below = setSharpnessByAngle(hinge(fold), { angle: deg(fold - 1) });
      expect([...(below.sharp ?? [])], `fold ${fold}, limit ${fold - 1}`).toEqual(["0_1"]);
      const above = setSharpnessByAngle(hinge(fold), { angle: deg(fold + 1) });
      expect([...(above.sharp ?? [])], `fold ${fold}, limit ${fold + 1}`).toEqual([]);
    }
  });

  it("never marks a boundary edge, whatever the limit", () => {
    // A 90 degree hinge at a 30 degree limit: only the fold. Everything else
    // on that mesh has one face.
    const out = setSharpnessByAngle(hinge(90), { angle: deg(30) });
    expect([...(out.sharp ?? [])]).toEqual(["0_1"]);
  });

  it("clears a flag under the limit by default, and keeps it with extend", () => {
    // The strip's two folds measure 60 and 10 degrees. Mark the shallow one by
    // hand and ask for 30: Blender leaves [(2,3)] with extend off and
    // [(2,3), (4,5)] with it on.
    const marked = (): MeshData => ({ ...strip(60, 10), sharp: new Set(["4_5"]) });
    const cleared = setSharpnessByAngle(marked(), { angle: deg(30) });
    expect([...(cleared.sharp ?? [])].sort()).toEqual(["2_3"]);
    const kept = setSharpnessByAngle(marked(), { angle: deg(30), extend: true });
    expect([...(kept.sharp ?? [])].sort()).toEqual(["2_3", "4_5"]);
  });

  it("does not clear a boundary edge's flag", () => {
    // Measured: a hand-marked boundary edge survives the default, which
    // clears. The operator only ever looks at edges with two faces.
    const base: MeshData = { ...hinge(10), sharp: new Set(["0_2"]) };
    const out = setSharpnessByAngle(base, { angle: deg(80) });
    expect([...(out.sharp ?? [])]).toEqual(["0_2"]);
  });

  it("only considers the edges it is given", () => {
    // Measured: with only the boundary (0,2) selected, a 90 degree fold at a
    // 30 degree limit marks nothing.
    const only = setSharpnessByAngle(hinge(90), { angle: deg(30), edges: new Set(["0_2"]) });
    expect([...(only.sharp ?? [])]).toEqual([]);
    const fold = setSharpnessByAngle(hinge(90), { angle: deg(30), edges: new Set(["0_1"]) });
    expect([...(fold.sharp ?? [])]).toEqual(["0_1"]);
  });

  it("moves nothing and changes no face", () => {
    const before = hinge(90);
    const out = setSharpnessByAngle(before, { angle: deg(30) });
    expect([...out.positions]).toEqual([...before.positions]);
    expect(out.polys).toEqual(before.polys);
  });

  it("uses 30 degrees when not told otherwise, as Blender does", () => {
    expect([...(setSharpnessByAngle(hinge(45)).sharp ?? [])]).toEqual(["0_1"]);
    expect([...(setSharpnessByAngle(hinge(20)).sharp ?? [])]).toEqual([]);
  });
});

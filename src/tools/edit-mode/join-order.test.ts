import { describe, it, expect } from "vitest";
import { joinTrianglePairs, quadCalcError } from "./join-order";

const PI = Math.fround(Math.PI);

describe("quadCalcError (bmo_join_triangles.cc, compat-backlog C74)", () => {
  it("is 0 for a flat square", () => {
    expect(quadCalcError([0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0])).toBeCloseTo(0, 6);
  });

  it("grows when the quad is a rhombus, folded, or has a dent", () => {
    const square = quadCalcError([0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]);
    const rhombus = quadCalcError([0, 0, 0], [1, 0, 0], [1.5, 1, 0], [0.5, 1, 0]);
    const folded = quadCalcError([0, 0, 0], [1, 0, 0], [1, 1, 0.4], [0, 1, 0]);
    const dent = quadCalcError([0, 0, 0], [1, 0, 0], [1, 1, 0], [0.8, 0.8, 0]);
    expect(rhombus).toBeGreaterThan(square);
    expect(folded).toBeGreaterThan(square);
    expect(dent).toBeGreaterThan(rhombus);
  });
});

describe("joinTrianglePairs", () => {
  /** A unit square cut on 0-2, and a second square beside it cut on the other diagonal. */
  const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 2, 0, 0, 2, 1, 0]);
  const polys = [[0, 1, 2], [0, 2, 3], [1, 4, 5], [1, 5, 2]];

  it("takes the pair that makes the squarest quad first, and does not reuse a face", () => {
    const pairs = joinTrianglePairs(positions, polys, null, PI, PI);
    expect(pairs).toHaveLength(2);
    const sets = pairs.map((p) => [p.first, p.second].sort().join());
    expect(sets.sort()).toEqual(["0,1", "2,3"]);
  });

  it("leaves out faces that are not in the input", () => {
    const pairs = joinTrianglePairs(positions, polys, new Set([0, 1]), PI, PI);
    expect(pairs).toHaveLength(1);
    expect([pairs[0]!.first, pairs[0]!.second].sort()).toEqual([0, 1]);
  });

  it("delimits by the angle between the faces", () => {
    // The second triangle folded 90° up about the shared edge.
    const folded = Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    const tris = [[0, 1, 2], [0, 2, 3]];
    expect(joinTrianglePairs(folded, tris, null, PI, PI)).toHaveLength(1);
    const bent = Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0.5, 1]);
    expect(joinTrianglePairs(bent, tris, null, Math.fround(0.3), PI)).toHaveLength(0);
    expect(joinTrianglePairs(bent, tris, null, PI, PI)).toHaveLength(1);
  });

  it("delimits a quad with a corner far from square when the shape threshold is on", () => {
    const sliver = Float32Array.from([0, 0, 0, 1, 0, 0, 3, 1, 0, 2, 1, 0]);
    const tris = [[0, 1, 2], [0, 2, 3]];
    expect(joinTrianglePairs(sliver, tris, null, PI, PI)).toHaveLength(1);
    expect(joinTrianglePairs(sliver, tris, null, PI, Math.fround(0.3))).toHaveLength(0);
  });
});

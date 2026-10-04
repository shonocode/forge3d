/**
 * `bmo_offset_edgeloops.cc` as a port (compat-backlog C27): the counts are the ones Blender 5.1.1 gave for the same
 * selections in the parity sweep (`offset-edgeloops*` rows).
 */
import { describe, it, expect } from "vitest";
import { offsetEdgeLoopsPort } from "./offset-edgeloops";

/** A unit cube centred on the origin (the parity `cube`'s corners, outward quads). */
function cube(): { positions: Float32Array; polys: number[][] } {
  const p = [-0.5, 0.5];
  const positions: number[] = [];
  for (const z of p) for (const y of p) for (const x of p) positions.push(x, y, z);
  return {
    positions: Float32Array.from(positions),
    polys: [
      [0, 2, 3, 1],
      [4, 5, 7, 6],
      [0, 1, 5, 4],
      [2, 6, 7, 3],
      [0, 4, 6, 2],
      [1, 3, 7, 5],
    ],
  };
}

function area(positions: Float32Array, polys: readonly number[][]): number {
  let total = 0;
  for (const poly of polys) {
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]! * 3;
      const b = poly[(i + 1) % poly.length]! * 3;
      nx += (positions[a + 1]! - positions[b + 1]!) * (positions[a + 2]! + positions[b + 2]!);
      ny += (positions[a + 2]! - positions[b + 2]!) * (positions[a]! + positions[b]!);
      nz += (positions[a]! - positions[b]!) * (positions[a + 1]! + positions[b + 1]!);
    }
    total += Math.hypot(nx, ny, nz) / 2;
  }
  return total;
}

describe("offsetEdgeLoopsPort", () => {
  it("moves nothing: every vertex it makes lies on one that was there", () => {
    const m = cube();
    const out = offsetEdgeLoopsPort(m.positions, m.polys, [[0, 1]])!;
    const at = (i: number): string => [out.positions[i * 3], out.positions[i * 3 + 1], out.positions[i * 3 + 2]].join(",");
    const before = new Set(Array.from({ length: 8 }, (_, i) => [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]].join(",")));
    for (const v of out.added) expect(before.has(at(v))).toBe(true);
    expect(area(out.positions, out.polys)).toBeCloseTo(area(m.positions, m.polys), 6);
  });

  it("an edge inside a closed mesh, caps off: 12 vertices and 8 faces on a cube", () => {
    const m = cube();
    const out = offsetEdgeLoopsPort(m.positions, m.polys, [[0, 1]])!;
    expect(out.positions.length / 3).toBe(12);
    expect(out.polys).toHaveLength(8);
    expect(out.added.size).toBe(4);
  });

  it("a path of edges on a cube: 16 vertices and 10 faces (Blender's count for 2,6 · 6,5 · 5,4)", () => {
    const m = cube();
    const out = offsetEdgeLoopsPort(m.positions, m.polys, [
      [2, 6],
      [6, 5],
      [5, 4],
    ])!;
    expect(out.positions.length / 3).toBe(16);
    expect(out.polys).toHaveLength(10);
  });

  it("states where each corner and material comes from, for the layers", () => {
    const m = cube();
    const out = offsetEdgeLoopsPort(m.positions, m.polys, [[0, 1]])!;
    expect(out.faces).toHaveLength(out.polys.length);
    // An input face keeps its own corners and material.
    expect(out.faces[0]!.material).toBe(0);
    expect(out.faces[0]!.corners.every((c) => c.length >= 1)).toBe(true);
    // Every vertex it made says which input vertex its data is.
    for (const v of out.added) expect(out.origins.has(v)).toBe(true);
  });

  it("returns null for nothing selected", () => {
    const m = cube();
    expect(offsetEdgeLoopsPort(m.positions, m.polys, [])).toBeNull();
  });
});

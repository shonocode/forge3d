import { describe, it, expect } from "vitest";
import { extrudeVertIndiv } from "./wire";
import { meshFromData, meshToData } from "../../lib/mesh";
import { deleteLoose, compactMesh } from "../mesh-repair";
import type { MeshData } from "../../lib/mesh";

/** The quad the Blender probe used: (0,0) (1,0) (1,1) (0,1). */
function quad(): MeshData {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    polys: [[0, 1, 2, 3]],
  };
}

const at = (m: MeshData, v: number): number[] => [
  m.positions[v * 3]!,
  m.positions[v * 3 + 1]!,
  m.positions[v * 3 + 2]!,
];

describe("extrudeVertIndiv", () => {
  // Every expectation is a Blender 5.1.1 result from
  // tools/modeling/parity/probe-wire.py.

  it("puts each duplicate exactly on its original", () => {
    // Extruding moves nothing — the same contract extrudeFaces has, and what
    // Blender does: v4 comes back at (0, 0, 0), on top of v0.
    const out = extrudeVertIndiv(quad(), [0]);
    expect(out.positions.length / 3).toBe(5);
    expect(at(out, 4)).toEqual(at(out, 0));
  });

  it("leaves the faces alone", () => {
    const before = quad();
    const out = extrudeVertIndiv(before, [0, 1, 2, 3]);
    expect(out.polys).toEqual(before.polys);
  });

  it("makes one wire edge per vertex, in vertex order", () => {
    // Blender: extruding 0,1,2,3 of a quad gives (0,4) (1,5) (2,6) (3,7).
    const out = extrudeVertIndiv(quad(), [0, 1, 2, 3]);
    expect(out.positions.length / 3).toBe(8);
    expect(out.edges).toEqual([
      [0, 4],
      [1, 5],
      [2, 6],
      [3, 7],
    ]);
  });

  it("takes the vertices in ascending order however they are given", () => {
    const a = extrudeVertIndiv(quad(), [2, 0]);
    const b = extrudeVertIndiv(quad(), [0, 2]);
    expect(a.edges).toEqual(b.edges);
    expect(a.edges).toEqual([
      [0, 4],
      [2, 5],
    ]);
  });

  it("keeps the wire edges a mesh already had", () => {
    const withWire: MeshData = { ...quad(), edges: [[1, 3]] };
    const out = extrudeVertIndiv(withWire, [0]);
    expect(out.edges).toEqual([
      [1, 3],
      [0, 4],
    ]);
  });

  it("does not modify its input", () => {
    const before = quad();
    extrudeVertIndiv(before, [0, 1]);
    expect(before.positions.length / 3).toBe(4);
    expect(before.edges).toBeUndefined();
  });

  it("refuses a vertex the mesh does not have", () => {
    expect(() => extrudeVertIndiv(quad(), [9])).toThrow(/not a vertex/);
    expect(() => extrudeVertIndiv(quad(), [-1])).toThrow(/not a vertex/);
  });
});

describe("wire edges through the rest of the library", () => {
  it("survive a meshFromData / meshToData round trip", () => {
    // `EditMesh` carries them untouched; nothing in the operator layer reads
    // them. Without this they would vanish the moment a mesh entered an
    // operator, and nothing in the parity harness would say so.
    const withWire: MeshData = { ...quad(), edges: [[0, 2]] };
    const back = meshToData(meshFromData(withWire));
    expect(back.edges).toEqual([[0, 2]]);
    expect(back.polys).toEqual(withWire.polys);
  });

  it("come back empty for a mesh that never had any", () => {
    expect(meshToData(meshFromData(quad())).edges).toEqual([]);
  });

  it("are renumbered by compactMesh, and dropped when an end goes", () => {
    // Renumbering is the one thing that can invalidate them, and `compactMesh`
    // is the shared path for every operator that does it.
    const m: MeshData = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0]),
      polys: [],
      edges: [
        [1, 2],
        [0, 3],
      ],
    };
    const kept = compactMesh(m, new Set([1, 2, 3]));
    // 1→0, 2→1, 3→2. The edge 0-3 loses an end and goes.
    expect(kept.edges).toEqual([[0, 1]]);
  });

  it("do not stop deleteLoose from sweeping their vertices", () => {
    // A known consequence worth pinning rather than discovering: `deleteLoose`
    // keeps the vertices a *polygon* uses, and a wire edge is not a polygon.
    // The wire vertices go, and the edge goes with them.
    const out = deleteLoose(extrudeVertIndiv(quad(), [0]));
    expect(out.positions.length / 3).toBe(4);
    expect(out.edges).toEqual([]);
  });
});

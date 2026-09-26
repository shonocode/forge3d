import { describe, expect, it } from "vitest";
import type { MeshData } from "../lib/mesh";
import { deleteGeometry } from "./delete-geometry";

// A unit cube of quads, wound outward: 0-3 bottom (y = 0), 4-7 top (y = 1).
function cube(): MeshData {
  return {
    positions: new Float32Array([
      0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1,
      0, 1, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1,
    ]),
    polys: [
      [0, 1, 2, 3], // bottom
      [4, 7, 6, 5], // top
      [0, 4, 5, 1],
      [1, 5, 6, 2],
      [2, 6, 7, 3],
      [3, 7, 4, 0],
    ],
  };
}

// A 2×1 strip of quads in the xz plane: 0 1 2 / 3 4 5.
function strip(): MeshData {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 0, 1, 1, 0, 1, 2, 0, 1]),
    polys: [
      [0, 3, 4, 1],
      [1, 4, 5, 2],
    ],
  };
}

describe("deleteGeometry", () => {
  it("VERTS takes the vertex's edges and faces, and renumbers what is left", () => {
    const out = deleteGeometry(cube(), { verts: [4] }, "VERTS");
    expect(out.positions.length / 3).toBe(7);
    expect(out.polys).toEqual([
      [0, 1, 2, 3],
      [1, 4, 5, 2],
      [2, 5, 6, 3],
    ]);
    // The far edges of the three removed faces all lie on a face that stays.
    expect(out.edges).toBeUndefined();
  });

  it("EDGES removes an end only once it has no edge left", () => {
    // All three edges at vertex 4: it goes, its neighbours keep other edges.
    const out = deleteGeometry(cube(), { edges: [[4, 0], [4, 5], [4, 7]] }, "EDGES");
    expect(out.positions.length / 3).toBe(7);
    expect(out.polys).toHaveLength(3);
  });

  it("EDGES_FACES ignores a face given on its own", () => {
    const out = deleteGeometry(cube(), { faces: [0] }, "EDGES_FACES");
    expect(out.polys).toHaveLength(6);
  });

  it("FACES_ONLY leaves the face's edges as wire", () => {
    const out = deleteGeometry(strip(), { faces: [1] }, "FACES_ONLY");
    expect(out.polys).toEqual([[0, 3, 4, 1]]);
    expect(out.positions.length / 3).toBe(6);
    expect(out.edges?.length).toBe(3);
  });

  it("FACES drops what only the face used; KEEP_BOUNDARY keeps the rim", () => {
    const faces = deleteGeometry(strip(), { faces: [1] }, "FACES");
    expect(faces.positions.length / 3).toBe(4);
    expect(faces.edges).toBeUndefined();
    const rim = deleteGeometry(strip(), { faces: [1] }, "FACES_KEEP_BOUNDARY");
    expect(rim.positions.length / 3).toBe(6);
    expect(rim.edges?.length).toBe(3);
  });

  it("TAGGED_ONLY removes exactly what is given", () => {
    // Face 0 and edge 2–5 (which takes face 1 with it); vertex 5 stays.
    const out = deleteGeometry(strip(), { faces: [0], edges: [[2, 5]] }, "TAGGED_ONLY");
    expect(out.polys).toEqual([]);
    expect(out.positions.length / 3).toBe(6);
    expect(out.edges?.length).toBe(6);
  });

  it("FACES keeps a vertex a wire edge still uses, and drops a given loose vertex", () => {
    const data: MeshData = {
      positions: new Float32Array([...strip().positions, 2, 1, 0, 5, 5, 5]),
      polys: strip().polys,
      edges: [[2, 6]],
    };
    const out = deleteGeometry(data, { faces: [1], verts: [7] }, "FACES");
    // 4 and 1 stay on face 0, 2 on the wire edge; 5 and the loose 7 go.
    expect(out.positions.length / 3).toBe(6);
    expect(out.edges).toEqual([[2, 5]]);
  });

  it("carries groups, creases and face layers with their elements", () => {
    const data: MeshData = {
      ...strip(),
      groups: new Map([["g", new Map([[5, 0.5], [0, 1]])]]),
      creases: new Map([["1_4", 0.3], ["2_5", 0.7]]),
      materials: [2, 3],
    };
    const out = deleteGeometry(data, { verts: [2] }, "VERTS");
    expect(out.materials).toEqual([2]);
    // 5 becomes 4 once 2 is gone; the crease on 2–5 goes with its edge.
    expect(out.groups?.get("g")).toEqual(new Map([[4, 0.5], [0, 1]]));
    expect(out.creases).toEqual(new Map([["1_3", 0.3]]));
  });
});

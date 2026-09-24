import { describe, it, expect } from "vitest";
import { edgeFaceAdd, ringOf } from "./face-add";
import { meshFromData, meshToData } from "../../lib/mesh";
import type { MeshData } from "../../lib/mesh";

/**
 * A 2x2 quad grid in the XY plane spanning ±0.5 — the shape the Blender probe
 * used. Vertex `r * 3 + c`, so 0 is (-0.5, -0.5) and 8 is (0.5, 0.5).
 */
function grid(): MeshData {
  const positions: number[] = [];
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) positions.push(c * 0.5 - 0.5, r * 0.5 - 0.5, 0);
  const polys: number[][] = [];
  for (let r = 0; r < 2; r++)
    for (let c = 0; c < 2; c++)
      polys.push([r * 3 + c, r * 3 + c + 1, (r + 1) * 3 + c + 1, (r + 1) * 3 + c]);
  return { positions: new Float32Array(positions), polys };
}

/** The unit cube with its +Z face missing — a square hole to fill. */
function openCube(): MeshData {
  return {
    positions: new Float32Array([
      -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
      -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
    ]),
    polys: [[0, 3, 2, 1], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]],
  };
}

/**
 * The face as a cycle starting at its lowest vertex, so two spellings of the
 * same ring compare equal. Direction still matters — that is the winding.
 */
function cycle(face: readonly number[]): number[] {
  const at = face.indexOf(Math.min(...face));
  return [...face.slice(at), ...face.slice(0, at)];
}

const added = (before: MeshData, after: MeshData): number[] =>
  cycle(after.polys[after.polys.length - 1]!);

function run(mesh: MeshData, verts: number[]): { data: MeshData; face: number | null } {
  const em = meshFromData(mesh);
  const face = edgeFaceAdd(em, new Set(verts));
  return { data: meshToData(em), face };
}

describe("edgeFaceAdd", () => {
  // Every expectation below is a Blender 5.1.1 result from
  // tools/modeling/parity/probe-face-add.py, written as a cycle because a
  // face's vertex list has no canonical starting point.

  it("fills a hole the way the shell is wound", () => {
    // Blender: (4, 5, 6, 7) — the same direction the +Z face would have had.
    const before = openCube();
    const { data, face } = run(before, [4, 5, 6, 7]);
    expect(face).toBe(5);
    expect(data.polys).toHaveLength(6);
    expect(added(before, data)).toEqual([4, 5, 6, 7]);
  });

  it("reverses when that is the direction the neighbours leave free", () => {
    // Blender: (0, 8, 5, 2, 1) for the five vertices of an L on the grid. The
    // ascending-angle order is 0,1,2,5,8, which would run *with* four faces
    // that already use those edges.
    const before = grid();
    const { data } = run(before, [0, 1, 2, 5, 8]);
    expect(added(before, data)).toEqual([0, 8, 5, 2, 1]);
  });

  it("makes a triangle across a quad that no edge of it already exists on", () => {
    // Blender: (6, 2, 0).
    const before = grid();
    const { data } = run(before, [0, 2, 6]);
    expect(added(before, data)).toEqual([0, 6, 2]); // the same cycle as (6,2,0)
  });

  it("rings four corners rather than taking them in index order", () => {
    // Blender: (2, 0, 6, 8). Index order 0,2,6,8 is a Z and would cross itself.
    const before = grid();
    const { data } = run(before, [0, 2, 6, 8]);
    expect(added(before, data)).toEqual([0, 6, 8, 2]);
  });

  it("free-standing faces come out exactly as Blender writes them, start and all", () => {
    // The two grid cases once filed as "degenerate, not readable". Both are
    // ties in the cloud normal that Blender breaks in float32: in double the
    // triangle's two candidates for `co_b` are exactly equal and the face
    // comes out facing the other way.
    const tri = run(grid(), [0, 2, 6]);
    expect(tri.data.polys[tri.face!]).toEqual([6, 2, 0]);
    const quad = run(grid(), [0, 2, 6, 8]);
    expect(quad.data.polys[quad.face!]).toEqual([2, 0, 6, 8]);
  });

  it("does not depend on the order the vertices are handed over in", () => {
    // Measured: picking [0,2,6,8] and [8,0,6,2] gave Blender the same face.
    const a = run(grid(), [0, 2, 6, 8]);
    const b = run(grid(), [8, 0, 6, 2]);
    expect(added(grid(), a.data)).toEqual(added(grid(), b.data));
  });

  it("changes nothing when the face is already there", () => {
    // Blender returns CANCELLED for the four corners of an existing quad.
    const before = grid();
    const { data, face } = run(before, [0, 1, 4, 3]);
    expect(face).toBeNull();
    expect(data.polys).toHaveLength(4);
  });

  it("makes a wire edge from two vertices, not a face", () => {
    // Blender: selecting two opposite corners of a grid leaves a loose edge
    // (0, 8) and no new face. `MeshData` had nowhere to put one until
    // 2026-09-22 and this threw instead.
    const before = grid();
    const { data, face } = run(before, [0, 8]);
    expect(face).toBeNull();
    expect(data.polys).toHaveLength(4);
    expect(data.edges).toEqual([[0, 8]]);
  });

  it("changes nothing when the two already have an edge", () => {
    // Blender returns CANCELLED for two adjacent corners.
    const { data, face } = run(grid(), [0, 1]);
    expect(face).toBeNull();
    expect(data.edges).toEqual([]);
    expect(data.polys).toHaveLength(4);
  });

  it("does not add the same wire edge twice", () => {
    const em = meshFromData(grid());
    edgeFaceAdd(em, new Set([0, 8]));
    edgeFaceAdd(em, new Set([8, 0]));
    expect(meshToData(em).edges).toEqual([[0, 8]]);
  });

  it("still refuses a single vertex", () => {
    expect(() => run(grid(), [3])).toThrow(/two to make an edge/);
  });

  it("refuses a collinear selection", () => {
    expect(() => run(grid(), [0, 1, 2])).toThrow(/collinear/);
  });
});

describe("ringOf", () => {
  it("puts a reflex polygon's vertices in angular order, not in its outline", () => {
    // A known limit, and it is Blender's too: the ring is the angular order
    // about the centroid, so a genuinely non-convex set does not come back as
    // the outline a person would draw. Blender's answer for the six-point L
    // was not that outline either.
    const L = new Float32Array([
      0, 0, 0, 2, 0, 0, 2, 1, 0, 1, 1, 0, 1, 2, 0, 0, 2, 0,
    ]);
    const ring = ringOf(L, new Set([0, 1, 2, 3, 4, 5]));
    expect(ring).toHaveLength(6);
    expect([...ring].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

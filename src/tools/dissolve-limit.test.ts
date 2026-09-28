import { describe, expect, it } from "vitest";
import type { MeshData } from "../lib/mesh";
import { dissolveLimitMesh, decimatePlanar } from "./dissolve-limit";

/** A flat n×n sheet facing +y. */
function sheet(n: number): MeshData {
  const positions: number[] = [];
  for (let r = 0; r <= n; r++) for (let c = 0; c <= n; c++) positions.push(c, 0, r);
  const polys: number[][] = [];
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) polys.push([r * (n + 1) + c, (r + 1) * (n + 1) + c, (r + 1) * (n + 1) + c + 1, r * (n + 1) + c + 1]);
  return { positions: Float32Array.from(positions), polys };
}

describe("dissolveLimitMesh (BM_mesh_decimate_dissolve_ex)", () => {
  it("joins a flat sheet into one quad and drops the straight-through vertices", () => {
    const out = dissolveLimitMesh(sheet(3), { angleLimit: 0.01 });
    expect(out.polys).toHaveLength(1);
    expect(out.polys[0]).toHaveLength(4);
    expect(out.positions.length / 3).toBe(4);
  });

  it("leaves it alone at an angle of exactly 0 (strictly less)", () => {
    expect(dissolveLimitMesh(sheet(3), { angleLimit: 0 }).polys).toHaveLength(9);
  });

  it("keeps edges between materials with delimit material", () => {
    const data = { ...sheet(2), materials: [0, 0, 1, 1] };
    const out = dissolveLimitMesh(data, { angleLimit: 0.1, delimit: ["material"] });
    expect(out.polys).toHaveLength(2);
    expect([...out.materials!].sort()).toEqual([0, 1]);
    expect(dissolveLimitMesh(data, { angleLimit: 0.1 }).polys).toHaveLength(1);
  });

  it("keeps sharp edges with delimit sharp, and their flag", () => {
    const data = { ...sheet(2), sharp: new Set(["1_4", "4_7"]) };
    const out = dissolveLimitMesh(data, { angleLimit: 0.1, delimit: ["sharp"] });
    expect(out.polys).toHaveLength(2);
    // The middle vertex sits straight between the two sharp edges and goes, so they become one.
    expect(out.sharp?.size).toBe(1);
  });

  it("only dissolves the input edges and vertices", () => {
    // Just the middle column edge of a 2×1 strip.
    const strip: MeshData = { positions: Float32Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 0, 1, 1, 0, 1, 2, 0, 1]), polys: [[0, 3, 4, 1], [1, 4, 5, 2]] };
    const out = dissolveLimitMesh(strip, { angleLimit: 0.1, edges: [[1, 4]], verts: [] });
    expect(out.polys).toHaveLength(1);
    expect(out.polys[0]).toHaveLength(6); // 1 and 4 stay: not input vertices
  });
});

describe("decimatePlanar (MOD_decimate.cc, Planar)", () => {
  it("leaves a mesh of three faces or fewer alone", () => {
    const three: MeshData = {
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 2, 0, 0, 2, 0, 1]),
      polys: [[0, 3, 2], [0, 2, 1], [1, 2, 5, 4]],
    };
    expect(decimatePlanar(three, { angleLimit: 0.1 }).polys).toHaveLength(3);
    expect(dissolveLimitMesh(three, { angleLimit: 0.1 }).polys).toHaveLength(1);
  });

  it("does not clamp the angle to 90° as the operator does", () => {
    // A regular tetrahedron: its face normals are about 109.5° apart, past the
    // operator's 90° clamp and inside 2.0 rad (and it has four faces).
    const t: MeshData = {
      positions: Float32Array.from([1, 1, 1, 1, -1, -1, -1, 1, -1, -1, -1, 1]),
      polys: [[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]],
    };
    expect(decimatePlanar(t, { angleLimit: 2.0 }).polys.length).toBeLessThan(4);
    expect(dissolveLimitMesh(t, { angleLimit: 2.0 }).polys).toHaveLength(4);
  });
});

describe("dissolveLimitMesh keeps an existing face a join would repeat (#144383)", () => {
  it("drops the joined copy", () => {
    // A quad with its two triangles lying on it.
    const data: MeshData = {
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1]),
      polys: [[0, 3, 2, 1], [0, 2, 1], [0, 3, 2]],
      materials: [7, 1, 2],
    };
    const out = dissolveLimitMesh(data, { angleLimit: 0.1 });
    expect(out.polys).toHaveLength(1);
    expect(out.materials).toEqual([7]);
  });
});

import { describe, expect, it } from "vitest";
import type { MeshData } from "../lib/mesh";
import { insetIndividualMesh, insetRegionMesh } from "./inset";

/** Cube spanning -1..1, every face wound outward; face 3 is +y. */
function cube(): MeshData {
  return {
    positions: new Float32Array([-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1]),
    polys: [
      [0, 3, 2, 1],
      [4, 5, 6, 7],
      [0, 1, 5, 4],
      [2, 3, 7, 6],
      [0, 4, 7, 3],
      [1, 2, 6, 5],
    ],
  };
}

/** A flat n×n sheet facing +y with a UV that is a linear map of the position. */
function sheet(n: number): MeshData {
  const positions: number[] = [];
  for (let r = 0; r <= n; r++) for (let c = 0; c <= n; c++) positions.push(c, 0, r);
  const polys: number[][] = [];
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) polys.push([r * (n + 1) + c, (r + 1) * (n + 1) + c, (r + 1) * (n + 1) + c + 1, r * (n + 1) + c + 1]);
  const P = Float32Array.from(positions);
  const uvs = polys.map((p) => p.map((v) => [P[v * 3]! / 8 + 0.1, P[v * 3 + 2]! / 4]));
  return { positions: P, polys, uvs };
}

describe("insetIndividualMesh (bmo_face_inset_individual)", () => {
  it("keeps the face, moves it, and puts the rim after every old face", () => {
    const out = insetIndividualMesh(cube(), [3], { thickness: 0.1, depth: 0.5 });
    expect(out.mesh.polys).toHaveLength(10);
    expect(out.inner).toEqual([3]);
    expect(out.rim).toEqual([6, 7, 8, 9]);
    for (const v of out.mesh.polys[3]!) expect(out.mesh.positions[v * 3 + 1]).toBeCloseTo(1.5, 6);
  });

  it("scales the bisector by the corner's mean edge length with useRelativeOffset", () => {
    const out = insetIndividualMesh(cube(), [3], { thickness: 0.1, useRelativeOffset: true });
    for (const v of out.mesh.polys[3]!) expect(Math.abs(out.mesh.positions[v * 3]!)).toBeCloseTo(1 - 0.2 / Math.SQRT2, 5);
  });
});

describe("insetRegionMesh (bmo_inset_region_exec)", () => {
  it("re-interpolates the region's UVs over the old faces with useInterpolate", () => {
    // A UV that is linear in the position is reproduced exactly by mean value
    // weights on a convex face: every region corner reads the map at its new place.
    const data = sheet(3);
    const out = insetRegionMesh(data, [0, 1, 2, 3, 4, 5, 6, 7, 8], {
      thickness: 0.2,
      useBoundary: true,
      useInterpolate: true,
    });
    const P = out.mesh.positions;
    for (const f of out.inner)
      out.mesh.polys[f]!.forEach((v, k) => {
        const uv = out.mesh.uvs![f]![k]!;
        expect(uv[0]).toBeCloseTo(P[v * 3]! / 8 + 0.1, 5);
        expect(uv[1]).toBeCloseTo(P[v * 3 + 2]! / 4, 5);
      });
  });

  it("without useInterpolate the region keeps its old UVs", () => {
    const data = sheet(3);
    const out = insetRegionMesh(data, [0, 1, 2, 3, 4, 5, 6, 7, 8], { thickness: 0.2, useBoundary: true });
    expect(out.mesh.uvs![0]).toEqual(data.uvs![0]);
  });

  it("glues the wire copies of the boundary edges back into one vertex", () => {
    // An open box with every face selected: each rim vertex on the old
    // boundary is one vertex, not the two its wire edges split into.
    const c = cube();
    const open: MeshData = { positions: c.positions, polys: c.polys.filter((_, i) => i !== 3) };
    const out = insetRegionMesh(open, [0, 1, 2, 3, 4], { thickness: 0.2, useBoundary: true });
    expect(out.mesh.positions.length / 3).toBe(12);
    expect(out.rim).toHaveLength(4);
  });
});

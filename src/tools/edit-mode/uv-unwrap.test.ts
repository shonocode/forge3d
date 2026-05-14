import { describe, it, expect } from "vitest";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { buildEditMesh } from "./build";
import { forEachEdge, isSeam, seamKey } from "./half-edge";
import { smartUVProject, toggleSeams } from "./uv-unwrap";

function makeStubMesh(positions: number[], indices: number[]): Mesh {
  let pos = new Float32Array(positions);
  let ind = indices.slice();
  return {
    getVerticesData: () => pos,
    getIndices: () => ind,
    updateVerticesData: (_kind: string, data: Float32Array) => { pos = new Float32Array(data); },
    setVerticesData: (_kind: string, data: Float32Array) => { pos = new Float32Array(data); },
    setIndices: (data: number[]) => { ind = data.slice(); },
  } as unknown as Mesh;
}

function makeCube(): Mesh {
  const positions = [
    -1, -1, -1,  1, -1, -1,  1, 1, -1,  -1, 1, -1,
    -1, -1,  1,  1, -1,  1,  1, 1,  1,  -1, 1,  1,
  ];
  const indices = [
    0, 2, 1,  0, 3, 2,
    4, 5, 6,  4, 6, 7,
    0, 1, 5,  0, 5, 4,
    3, 7, 6,  3, 6, 2,
    0, 4, 7,  0, 7, 3,
    1, 2, 6,  1, 6, 5,
  ];
  return makeStubMesh(positions, indices);
}

describe("seam helpers", () => {
  it("seamKey is direction-agnostic", () => {
    expect(seamKey(3, 5)).toBe(seamKey(5, 3));
    expect(seamKey(3, 5)).toBe("3_5");
  });

  it("toggleSeams flips the set entry", () => {
    const em = buildEditMesh(makeCube())!;
    let firstEdge = -1;
    forEachEdge(em, (he) => { if (firstEdge < 0) firstEdge = he; });
    expect(em.seams.size).toBe(0);
    toggleSeams(em, new Set([firstEdge]));
    expect(em.seams.size).toBe(1);
    expect(isSeam(em, firstEdge)).toBe(true);
    toggleSeams(em, new Set([firstEdge]));
    expect(em.seams.size).toBe(0);
    expect(isSeam(em, firstEdge)).toBe(false);
  });
});

describe("smartUVProject", () => {
  it("unwraps a cube into the 0–1 UV box", () => {
    const em = buildEditMesh(makeCube())!;
    const result = smartUVProject(em);

    // V1 ships split-per-face form: 12 tris × 3 verts = 36 positions.
    expect(result.positions.length).toBe(12 * 3 * 3);
    expect(result.indices).toHaveLength(12 * 3);
    expect(result.uvs.length).toBe(12 * 3 * 2);

    // All UVs must lie inside [0, 1].
    for (let i = 0; i < result.uvs.length; i++) {
      const v = result.uvs[i]!;
      expect(v).toBeGreaterThanOrEqual(-1e-6);
      expect(v).toBeLessThanOrEqual(1 + 1e-6);
    }
  });

  it("clusters all 6 cube faces — coplanar tri pairs share an island", () => {
    const em = buildEditMesh(makeCube())!;
    const result = smartUVProject(em);

    // Each cube face = 2 coplanar tris. Within a cluster, the 4 corner UVs
    // should form a non-degenerate quad. A simple check: each cluster's UV
    // bbox area should be roughly the same (cube faces are uniform).
    // Walk the result triangles and group by the UV cell they occupy.
    // With 6 islands packed into a 3×2 grid: each cell ≈ 1/3 × 1/2.
    const cellW = 1 / 3;
    const cellH = 1 / 2;
    const cellCounts = new Map<string, number>();
    for (let f = 0; f < 12; f++) {
      const u0 = result.uvs[f * 6]!;
      const v0 = result.uvs[f * 6 + 1]!;
      const col = Math.floor(u0 / cellW);
      const row = Math.floor(v0 / cellH);
      const key = `${col}_${row}`;
      cellCounts.set(key, (cellCounts.get(key) ?? 0) + 1);
    }
    // 6 clusters × 2 tris each = each cell has 2 tris
    expect(cellCounts.size).toBe(6);
    for (const [, n] of cellCounts) expect(n).toBe(2);
  });

  it("respects seams — adding a seam splits a cluster", () => {
    const em = buildEditMesh(makeCube())!;
    // Without seams: 6 clusters (cube faces).
    const baseline = smartUVProject(em);
    // Find the diagonal half-edge of the -z face (shared between tris 0 and 1).
    // It's the canonical edge with both adjacent faces 0 and 1.
    let diagonal = -1;
    forEachEdge(em, (he) => {
      if (diagonal >= 0) return;
      const twin = em.halfEdges[he]!.twin;
      if (twin < 0) return;
      const f1 = em.halfEdges[he]!.face;
      const f2 = em.halfEdges[twin]!.face;
      if ((f1 === 0 && f2 === 1) || (f1 === 1 && f2 === 0)) diagonal = he;
    });
    expect(diagonal).toBeGreaterThanOrEqual(0);
    toggleSeams(em, new Set([diagonal]));

    const seamed = smartUVProject(em);
    // Splitting one cluster into 2 → 7 clusters → 7 islands → packed in 3×3 grid.
    const cellW3 = 1 / 3;
    const cellH3 = 1 / 3;
    const seamedCells = new Set<string>();
    for (let f = 0; f < 12; f++) {
      const u0 = seamed.uvs[f * 6]!;
      const v0 = seamed.uvs[f * 6 + 1]!;
      const col = Math.floor(u0 / cellW3);
      const row = Math.floor(v0 / cellH3);
      seamedCells.add(`${col}_${row}`);
    }
    expect(seamedCells.size).toBe(7);
    // Baseline still has 6 clusters
    const baselineCells = new Set<string>();
    for (let f = 0; f < 12; f++) {
      const u0 = baseline.uvs[f * 6]!;
      const v0 = baseline.uvs[f * 6 + 1]!;
      const col = Math.floor(u0 / (1 / 3));
      const row = Math.floor(v0 / (1 / 2));
      baselineCells.add(`${col}_${row}`);
    }
    expect(baselineCells.size).toBe(6);
  });
});

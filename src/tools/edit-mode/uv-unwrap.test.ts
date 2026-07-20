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

/**
 * Count connected components of the triangle list by shared vertex index.
 * On welded unwrap output, that equals the island count (island-internal
 * tris share verts, cross-island tris don't) — packing-layout independent.
 */
function countIslands(indices: number[]): number {
  const parent = new Map<number, number>();
  const find = (v: number): number => {
    let r = v;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(v, r);
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i]!, b = indices[i + 1]!, c = indices[i + 2]!;
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    if (!parent.has(c)) parent.set(c, c);
    union(a, b); union(b, c);
  }
  const roots = new Set<number>();
  for (const v of parent.keys()) roots.add(find(v));
  return roots.size;
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

    // Cluster-welded form (F-M9): each of the 6 face islands welds its 4
    // shared corners → 6 × 4 = 24 verts (each cube corner is on 3 faces so
    // it splits 3 ways). Still 12 tris / 36 indices.
    expect(result.positions.length).toBe(24 * 3);
    expect(result.uvs.length).toBe(24 * 2);
    expect(result.indices).toHaveLength(12 * 3);
    // Every index must reference a real vertex.
    const vCount = result.positions.length / 3;
    for (const idx of result.indices) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(vCount);
    }

    // All UVs must lie inside [0, 1].
    for (let i = 0; i < result.uvs.length; i++) {
      const v = result.uvs[i]!;
      expect(v).toBeGreaterThanOrEqual(-1e-6);
      expect(v).toBeLessThanOrEqual(1 + 1e-6);
    }
  });

  it("welds cluster-internal verts (fewer than split-per-face)", () => {
    const em = buildEditMesh(makeCube())!;
    const result = smartUVProject(em);
    // Split-per-face would be 36; welding shares each face-quad's diagonal.
    expect(result.positions.length / 3).toBeLessThan(36);
    expect(result.positions.length / 3).toBe(24);
  });

  it("clusters all 6 cube faces — coplanar tri pairs share an island", () => {
    const em = buildEditMesh(makeCube())!;
    const result = smartUVProject(em);
    // Islands are welded, so triangles of one island share vertex indices
    // and different islands don't → connected-component count = island count.
    // This is packing-layout independent (unlike the old grid-cell check).
    expect(countIslands(result.indices)).toBe(6);
  });

  it("respects seams — adding a seam splits a cluster", () => {
    const em = buildEditMesh(makeCube())!;
    const baseline = smartUVProject(em);
    expect(countIslands(baseline.indices)).toBe(6);

    // Find the diagonal half-edge of the -z face (shared between tris 0 and 1).
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
    // Splitting one cluster into 2 → 7 islands.
    expect(countIslands(seamed.indices)).toBe(7);
  });
});

describe("smartUVProject conformal (LSCM)", () => {
  it("unwraps a cube with the conformal method, UVs in the 0–1 box", () => {
    const em = buildEditMesh(makeCube())!;
    const result = smartUVProject(em, { method: "conformal" });
    // Same clustering / weld topology as planar (6 islands × 4 verts).
    expect(result.positions.length).toBe(24 * 3);
    expect(result.indices).toHaveLength(12 * 3);
    expect(countIslands(result.indices)).toBe(6);
    for (let i = 0; i < result.uvs.length; i++) {
      expect(result.uvs[i]!).toBeGreaterThanOrEqual(-1e-6);
      expect(result.uvs[i]!).toBeLessThanOrEqual(1 + 1e-6);
    }
    // No NaNs from the solver.
    for (const v of result.uvs) expect(Number.isFinite(v)).toBe(true);
  });

  it("is deterministic", () => {
    const a = smartUVProject(buildEditMesh(makeCube())!, { method: "conformal" });
    const b = smartUVProject(buildEditMesh(makeCube())!, { method: "conformal" });
    expect(Array.from(a.uvs)).toEqual(Array.from(b.uvs));
  });
});

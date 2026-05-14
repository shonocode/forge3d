import { describe, it, expect } from "vitest";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { buildEditMesh } from "./build";
import { commitPositions } from "./commit";
import { canonicalEdge, edgeEnd, edgeOrigin, faceVertices, forEachEdge } from "./half-edge";

/**
 * Stub Babylon Mesh — exposes just the methods build/commit touch. Keeps the
 * test node-environment compatible (no NullEngine boot needed).
 */
function makeStubMesh(positions: number[], indices: number[]): Mesh {
  let pos = new Float32Array(positions);
  let normals = new Float32Array(positions.length);
  let ind = indices.slice();
  return {
    getVerticesData(kind: string): Float32Array | null {
      if (kind === "position") return pos;
      if (kind === "normal") return normals;
      return null;
    },
    getIndices(): number[] | null { return ind; },
    updateVerticesData(kind: string, data: Float32Array): void {
      if (kind === "position") pos = new Float32Array(data);
      else if (kind === "normal") normals = new Float32Array(data);
    },
    setVerticesData(kind: string, data: Float32Array): void {
      if (kind === "position") pos = new Float32Array(data);
      else if (kind === "normal") normals = new Float32Array(data);
    },
    setIndices(data: number[]): void { ind = data.slice(); },
    // Helpers for tests
    _getPos: () => pos,
    _getNormals: () => normals,
  } as unknown as Mesh;
}

// Unit cube: 8 unique vertices, 12 triangles (2 per face × 6 faces).
function makeCube(): Mesh {
  const positions = [
    -1, -1, -1,  // 0
     1, -1, -1,  // 1
     1,  1, -1,  // 2
    -1,  1, -1,  // 3
    -1, -1,  1,  // 4
     1, -1,  1,  // 5
     1,  1,  1,  // 6
    -1,  1,  1,  // 7
  ];
  const indices = [
    0, 2, 1,  0, 3, 2, // -z
    4, 5, 6,  4, 6, 7, // +z
    0, 1, 5,  0, 5, 4, // -y
    3, 7, 6,  3, 6, 2, // +y
    0, 4, 7,  0, 7, 3, // -x
    1, 2, 6,  1, 6, 5, // +x
  ];
  return makeStubMesh(positions, indices);
}

describe("buildEditMesh", () => {
  it("returns null when mesh has no positions", () => {
    const m = { getVerticesData: () => null, getIndices: () => [0, 1, 2] } as unknown as Mesh;
    expect(buildEditMesh(m)).toBeNull();
  });

  it("returns null when mesh has no indices", () => {
    const m = {
      getVerticesData: () => new Float32Array(9),
      getIndices: () => null,
    } as unknown as Mesh;
    expect(buildEditMesh(m)).toBeNull();
  });

  it("builds correct vertex / face / half-edge counts for a cube", () => {
    const em = buildEditMesh(makeCube())!;
    expect(em).not.toBeNull();
    expect(em.vertices).toHaveLength(8);
    expect(em.faces).toHaveLength(12);
    expect(em.halfEdges).toHaveLength(36);
  });

  it("every half-edge of a closed mesh has a twin", () => {
    const em = buildEditMesh(makeCube())!;
    for (let i = 0; i < em.halfEdges.length; i++) {
      expect(em.halfEdges[i]!.twin).toBeGreaterThanOrEqual(0);
    }
  });

  it("twin relationship is symmetric", () => {
    const em = buildEditMesh(makeCube())!;
    for (let i = 0; i < em.halfEdges.length; i++) {
      const t = em.halfEdges[i]!.twin;
      if (t >= 0) {
        expect(em.halfEdges[t]!.twin).toBe(i);
      }
    }
  });

  it("face half-edges form a 3-cycle with consistent face id", () => {
    const em = buildEditMesh(makeCube())!;
    for (let f = 0; f < em.faces.length; f++) {
      const h0 = em.faces[f]!.he;
      const h1 = em.halfEdges[h0]!.next;
      const h2 = em.halfEdges[h1]!.next;
      const h3 = em.halfEdges[h2]!.next;
      expect(h3).toBe(h0);
      expect(em.halfEdges[h0]!.face).toBe(f);
      expect(em.halfEdges[h1]!.face).toBe(f);
      expect(em.halfEdges[h2]!.face).toBe(f);
    }
  });

  it("faceVertices returns the same triple as the source index buffer", () => {
    const em = buildEditMesh(makeCube())!;
    const [a, b, c] = faceVertices(em, 0);
    expect([a, b, c]).toEqual([0, 2, 1]);
  });

  it("forEachEdge visits each undirected edge exactly once (cube → 18 edges)", () => {
    const em = buildEditMesh(makeCube())!;
    // Cube triangulated as 2 tris per face has 18 unique edges
    // (12 cube edges + 6 face diagonals = 18).
    let count = 0;
    const seen = new Set<number>();
    forEachEdge(em, (he) => {
      count++;
      const c = canonicalEdge(em, he);
      seen.add(c);
    });
    expect(count).toBe(18);
    expect(seen.size).toBe(18);
  });

  it("edgeOrigin and edgeEnd return distinct adjacent vertices", () => {
    const em = buildEditMesh(makeCube())!;
    forEachEdge(em, (he) => {
      const a = edgeOrigin(em, he);
      const b = edgeEnd(em, he);
      expect(a).not.toBe(b);
    });
  });
});

describe("commitPositions", () => {
  it("writes mutated EditMesh positions back to the source mesh", () => {
    const mesh = makeCube();
    const em = buildEditMesh(mesh)!;
    // Move vertex 0 by (10, 20, 30)
    em.positions[0] = 9;   // was -1
    em.positions[1] = 19;
    em.positions[2] = 29;
    commitPositions(em);

    const out = (mesh as unknown as { _getPos: () => Float32Array })._getPos();
    expect(out[0]).toBe(9);
    expect(out[1]).toBe(19);
    expect(out[2]).toBe(29);
    // Other vertices untouched
    expect(out[3]).toBe(1);
    expect(out[4]).toBe(-1);
  });
});

import { describe, it, expect } from "vitest";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { buildEditMesh } from "./build";
import { canonicalEdge, faceVertices, faceVerts, forEachEdge } from "./half-edge";
import { meshFromData, meshToData } from "../../lib/mesh";
import { bevelEdges, deleteFaces, deleteFacesByEdges, deleteFacesByVertices, extrudeEdges, extrudeFaces, insetFaces, flipDiagonalByVerts, loopCut, rotateEdges, trisToQuads } from "./operators";

/** Same stub mesh as half-edge.test.ts — just the surface we touch. */
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

describe("deleteFaces", () => {
  it("no-op when selection is empty", () => {
    const em = buildEditMesh(makeCube())!;
    const sel = deleteFaces(em, new Set());
    expect(sel.size).toBe(0);
    expect(em.faces).toHaveLength(12);
  });

  it("removes one face cleanly", () => {
    const em = buildEditMesh(makeCube())!;
    deleteFaces(em, new Set([0]));
    expect(em.faces).toHaveLength(11);
    // Vertex count is preserved (we don't run a loose-vert sweep)
    expect(em.vertices).toHaveLength(8);
  });

  it("opens a boundary where deleted faces met live ones", () => {
    const em = buildEditMesh(makeCube())!;
    // Delete one face from the -z side. The triangle (0, 2, 1) shares edges:
    //   0→2 with face (0, 3, 2)
    //   2→1 with face (1, 2, 6)
    //   1→0 with face (0, 1, 5)
    deleteFaces(em, new Set([0]));
    // Exactly 3 half-edges should now be boundaries (twin=-1) where they
    // previously had a twin pointing into the deleted face.
    let boundaries = 0;
    for (const he of em.halfEdges) if (he.twin < 0) boundaries++;
    expect(boundaries).toBe(3);
  });
});

describe("extrudeFaces", () => {
  it("returns empty set and leaves mesh untouched on empty selection", () => {
    const em = buildEditMesh(makeCube())!;
    const sel = extrudeFaces(em, new Set());
    expect(sel.size).toBe(0);
    expect(em.faces).toHaveLength(12);
    expect(em.vertices).toHaveLength(8);
  });

  it("single-triangle extrude → 3 new verts, 1 cap + 3 skirt quads added", () => {
    const em = buildEditMesh(makeCube())!;
    // Pick face 0 — its three verts (0, 2, 1) are all on the boundary so all 3 dup.
    const newSel = extrudeFaces(em, new Set([0]));
    // Vertex count: 8 + 3 duplicates = 11
    expect(em.vertices).toHaveLength(11);
    // Face count: 11 unchanged (12 - 1 removed) + 3 skirt quads (V2) + 1 cap = 15
    expect(em.faces).toHaveLength(15);
    expect(newSel.size).toBe(1);
  });

  it("two-triangle (whole cube face) extrude → cap stays closed", () => {
    const em = buildEditMesh(makeCube())!;
    // Faces 0 and 1 form the -z quad. Boundary = 4 cube edges (4 skirt quads).
    const newSel = extrudeFaces(em, new Set([0, 1]));
    // Verts on the -z face: 0, 1, 2, 3 — all 4 duplicate.
    expect(em.vertices).toHaveLength(12);
    // Face count: 10 unchanged + 4 skirt quads (V2) + 2 cap = 16
    expect(em.faces).toHaveLength(16);
    expect(newSel.size).toBe(2);
    // Cap retains the original triangulation shape.
    const cap0 = faceVertices(em, [...newSel][0]!);
    const cap1 = faceVertices(em, [...newSel][1]!);
    // Each cap triangle should be made of duplicate verts (indices >= 8).
    for (const v of [...cap0, ...cap1]) expect(v).toBeGreaterThanOrEqual(8);
  });

  it("extruded cap is topologically disconnected from the rest", () => {
    const em = buildEditMesh(makeCube())!;
    const newSel = extrudeFaces(em, new Set([0, 1]));
    // None of the cap's verts appear in the unselected original faces.
    const capVerts = new Set<number>();
    for (const f of newSel) for (const v of faceVertices(em, f)) capVerts.add(v);
    for (let f = 0; f < em.faces.length; f++) {
      if (newSel.has(f)) continue;
      // The skirt faces use both original and dup verts — but the "interior"
      // cube faces shouldn't touch any cap vert.
      // (Loose check: at least the +z face — faces 2 & 3, indices 4..7 — has no cap verts.)
    }
    // Targeted: faces 2 and 3 (the +z cube side from the original) referenced
    // verts 4,5,6,7 only — never the new dups. Find them in the rebuilt mesh
    // by their original triangulation pattern.
    let foundOpposite = 0;
    for (let f = 0; f < em.faces.length; f++) {
      const [a, b, c] = faceVertices(em, f);
      const onlyOriginalPlusZ = [a, b, c].every((v) => v >= 4 && v <= 7);
      if (onlyOriginalPlusZ) foundOpposite++;
    }
    expect(foundOpposite).toBe(2);
  });

  it("twin pairing is reestablished after extrude", () => {
    const em = buildEditMesh(makeCube())!;
    extrudeFaces(em, new Set([0, 1]));
    // Every half-edge that has a twin must have a symmetric twin pointer.
    for (let i = 0; i < em.halfEdges.length; i++) {
      const t = em.halfEdges[i]!.twin;
      if (t >= 0) expect(em.halfEdges[t]!.twin).toBe(i);
    }
    // The new mesh should be a closed manifold again — no boundaries.
    let bnd = 0;
    forEachEdge(em, (he) => { if (em.halfEdges[he]!.twin < 0) bnd++; });
    expect(bnd).toBe(0);
    // canonicalEdge round-trips
    forEachEdge(em, (he) => {
      const c = canonicalEdge(em, he);
      const t = em.halfEdges[he]!.twin;
      expect(c === he || c === t).toBe(true);
    });
  });
});

describe("insetFaces", () => {
  it("is a no-op for zero amount or empty selection", () => {
    const em = buildEditMesh(makeCube())!;
    expect(insetFaces(em, new Set(), 0.2).size).toBe(0);
    expect(em.faces).toHaveLength(12);
    const sel2 = insetFaces(em, new Set([0]), 0);
    // 0-amount inset leaves selection as-is (caller's contract: returns the
    // pre-existing set, ungrouped — keeps the gizmo where it was)
    expect(sel2.has(0)).toBe(true);
    expect(em.faces).toHaveLength(12);
  });

  it("single-tri inset adds 3 verts and 3 skirt quads + 1 cap face", () => {
    const em = buildEditMesh(makeCube())!;
    const sel = insetFaces(em, new Set([0]), 0.3);
    expect(em.vertices).toHaveLength(8 + 3);
    // 11 untouched + 3 skirt quads (V2) + 1 cap = 15
    expect(em.faces).toHaveLength(15);
    expect(sel.size).toBe(1);
  });

  it("cap is strictly smaller than the original face", () => {
    const em = buildEditMesh(makeCube())!;
    // Capture face 0's vertex positions before
    const before = faceVertices(em, 0).map((v) => [
      em.positions[v * 3]!, em.positions[v * 3 + 1]!, em.positions[v * 3 + 2]!,
    ] as const);
    const beforeCentroid = [
      (before[0]![0] + before[1]![0] + before[2]![0]) / 3,
      (before[0]![1] + before[1]![1] + before[2]![1]) / 3,
      (before[0]![2] + before[1]![2] + before[2]![2]) / 3,
    ];

    const newSel = insetFaces(em, new Set([0]), 0.3);
    const capFace = [...newSel][0]!;
    const cap = faceVertices(em, capFace);
    // Each cap vertex must be closer to the centroid than its original.
    for (let i = 0; i < 3; i++) {
      const v = cap[i]!;
      const dx = em.positions[v * 3]! - beforeCentroid[0]!;
      const dy = em.positions[v * 3 + 1]! - beforeCentroid[1]!;
      const dz = em.positions[v * 3 + 2]! - beforeCentroid[2]!;
      const distSq = dx * dx + dy * dy + dz * dz;
      const obx = before[i]![0] - beforeCentroid[0]!;
      const oby = before[i]![1] - beforeCentroid[1]!;
      const obz = before[i]![2] - beforeCentroid[2]!;
      const origDistSq = obx * obx + oby * oby + obz * obz;
      expect(distSq).toBeLessThan(origDistSq);
    }
  });
});

/**
 * 2-tri quad: 4 verts, 2 tris sharing a diagonal. Bevel V1's fan guard only
 * accepts this topology — any closed mesh fails because endpoints fan into
 * more than 2 faces (which the V1 algorithm can't rewire safely).
 */
function makeQuadPair(): Mesh {
  const positions = [
    0, 0, 0,   // 0
    1, 0, 0,   // 1
    1, 1, 0,   // 2
    0, 1, 0,   // 3
  ];
  const indices = [0, 1, 2,  0, 2, 3];
  return makeStubMesh(positions, indices);
}

describe("bevelEdges", () => {
  it("is a no-op on empty selection or zero width", () => {
    const em = buildEditMesh(makeQuadPair())!;
    expect(bevelEdges(em, new Set(), { offset: 15 }).size).toBe(0);
    let firstEdge = -1;
    forEachEdge(em, (he) => { if (firstEdge < 0) firstEdge = he; });
    const noop = bevelEdges(em, new Set([firstEdge]), { offset: 0 });
    expect(em.faces).toHaveLength(2);
    expect(noop.has(firstEdge)).toBe(true);
  });

  it("greedily bevels a subset when selected edges share endpoints, reporting skips", () => {
    const em = buildEditMesh(makeCube())!;
    // Collect two interior edges that share an endpoint vertex.
    const canonical: number[] = [];
    forEachEdge(em, (he) => { if (em.halfEdges[he]!.twin >= 0) canonical.push(he); });
    const first = canonical[0]!;
    const a = em.halfEdges[first]!.v;
    const second = canonical.find((he) => {
      if (he === first) return false;
      const o = em.halfEdges[he]!.v;
      const d = em.halfEdges[em.halfEdges[he]!.next]!.v;
      return o === a || d === a;
    })!;
    const info = { skipped: 0 };
    const result = bevelEdges(em, new Set([first, second]), { offset: 15 }, info);
    // One edge beveled (1 chamfer quad in V2), the shared-vertex one skipped.
    expect(result.size).toBe(1);
    expect(info.skipped).toBe(1);
    expect(em.faces.length).toBeGreaterThan(12);
  });

  it("bevels the diagonal of a 2-tri quad into a chamfer band", () => {
    const em = buildEditMesh(makeQuadPair())!;
    let diagonal = -1;
    forEachEdge(em, (he) => { if (em.halfEdges[he]!.twin >= 0 && diagonal < 0) diagonal = he; });
    expect(diagonal).toBeGreaterThanOrEqual(0);

    const result = bevelEdges(em, new Set([diagonal]), { offset: 20 });
    // 2 original tris (remapped) + 1 chamfer quad (V2) = 3 (no caps because
    // the fan around each endpoint has only F1+F2, so no implicit split).
    expect(em.faces).toHaveLength(3);
    expect(result.size).toBe(1);
    // 4 original, both beveled ends replaced by two rails each: 4 - 2 + 4 = 6.
    // This used to say 8, from when the operator left the beveled vertices in
    // the buffer unreferenced. Blender counts them gone, and so does this now.
    expect(em.vertices).toHaveLength(6);
  });

  it("refuses a branch selection rather than beveling half of it", () => {
    const em = buildEditMesh(makeCube())!;
    // Two edges sharing a vertex. This is what asking for a loop looks like
    // from the inside, and the greedy matching can only take one of them.
    let first = -1;
    let second = -1;
    forEachEdge(em, (he) => {
      if (first < 0) { first = he; return; }
      if (second >= 0) return;
      const a = edgeOrigin(em, first);
      const b = edgeEnd(em, first);
      const c = edgeOrigin(em, he);
      const d = edgeEnd(em, he);
      if (c === a || c === b || d === a || d === b) second = he;
    });
    expect(second).toBeGreaterThanOrEqual(0);

    // Silent until 2026-09-18: half the selection was beveled and the caller
    // was handed a Set with no way to know. A brazier's rim came back with 12
    // of its 24 edges chamfered and nothing said so.
    expect(() => bevelEdges(em, new Set([first, second]), { offset: 15 })).toThrow(/branch/);

    // Opting in still works, and still reports.
    const em2 = buildEditMesh(makeCube())!;
    const info = { skipped: 0 };
    bevelEdges(em2, new Set([first, second]), { offset: 15 }, info);
    expect(info.skipped).toBe(1);
  });

  it("bevels a cube edge — one new vertex per non-beveled edge, ring closes the corner", () => {
    const em = buildEditMesh(makeCube())!;
    // Pick the first canonical edge. In this cube triangulation it is an
    // interior manifold edge whose endpoints each carry five faces, so four
    // of the edges at each end are not the beveled one.
    let target = -1;
    forEachEdge(em, (he) => { if (target < 0) target = he; });
    const result = bevelEdges(em, new Set([target]), { offset: 20 });

    // Topology delta:
    //   - 12 original tris remapped (no faces removed)
    //   - +1 chamfer quad
    //   - +1 corner polygon per endpoint
    expect(em.faces).toHaveLength(12 + 1 + 2);
    expect(result.size).toBe(1);
    // This used to say 10, from when the operator put two new vertices at each
    // end — the two ends of the rail — and bridged the faces between them with
    // a triangle. Blender puts one on *every* edge at the vertex that is not
    // the beveled one, which here is four per end: 8 - 2 + 8. Measured against
    // Blender on an octahedron and a hexagonal bipyramid at 1, 2 and 4
    // segments, all 0.0000mm; see `tools/modeling/parity/README.md`.
    expect(em.vertices).toHaveLength(14);
  });

  it("bevels an edge held by quads — a cube, which it could not do before", () => {
    // Every edge of a quad cube is held by two quads, and the operator used to
    // require triangles, so this whole shape was unbevelable. Measured against
    // Blender: 8 verts and 6 faces become 10 and 7, exactly.
    const em = meshFromData({
      positions: new Float32Array([
        -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
        -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
      ]),
      polys: [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]],
    });
    let target = -1;
    forEachEdge(em, (he) => {
      const a = edgeOrigin(em, he);
      const b = edgeEnd(em, he);
      if ((a === 2 && b === 3) || (a === 3 && b === 2)) target = he;
    });
    const info = { skipped: 0 };
    bevelEdges(em, new Set([target]), { offset: 20 }, info);

    expect(info.skipped).toBe(0);
    expect(em.vertices).toHaveLength(10);
    expect(em.faces).toHaveLength(7);
    // No corner caps: the one face between F1 and F2 at each end absorbs the
    // whole rail run, which is what Blender does — the two quads at those
    // corners come back as pentagons.
    const arities = Array.from({ length: em.faces.length }, (_, f) => faceVerts(em, f).length).sort();
    expect(arities).toEqual([4, 4, 4, 4, 4, 5, 5]);
  });

  it("segments and profile follow Blender's counts", () => {
    // Measured: n segments give 8 + 2n verts and 6 + n faces on a cube.
    for (const [segments, verts, faces] of [
      [1, 10, 7],
      [2, 12, 8],
      [3, 14, 9],
      [4, 16, 10],
    ] as const) {
      const em = meshFromData({
        positions: new Float32Array([
          -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
          -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
        ]),
        polys: [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]],
      });
      let target = -1;
      forEachEdge(em, (he) => {
        const a = edgeOrigin(em, he);
        const b = edgeEnd(em, he);
        if ((a === 2 && b === 3) || (a === 3 && b === 2)) target = he;
      });
      bevelEdges(em, new Set([target]), { offset: 20, segments });
      expect(em.vertices).toHaveLength(verts);
      expect(em.faces).toHaveLength(faces);
    }
  });

  it("bevel preserves manifold closure (no new boundaries)", () => {
    const em = buildEditMesh(makeCube())!;
    let target = -1;
    forEachEdge(em, (he) => { if (target < 0) target = he; });
    bevelEdges(em, new Set([target]), { offset: 20 });
    let boundaries = 0;
    forEachEdge(em, (he) => { if (em.halfEdges[he]!.twin < 0) boundaries++; });
    expect(boundaries).toBe(0);
  });

  it("bevel preserves twin symmetry across the rebuilt mesh", () => {
    const em = buildEditMesh(makeCube())!;
    let target = -1;
    forEachEdge(em, (he) => { if (target < 0) target = he; });
    bevelEdges(em, new Set([target]), { offset: 20 });
    for (let i = 0; i < em.halfEdges.length; i++) {
      const t = em.halfEdges[i]!.twin;
      if (t >= 0) expect(em.halfEdges[t]!.twin).toBe(i);
    }
  });
});

describe("extrudeEdges", () => {
  it("is a no-op on empty selection", () => {
    const em = buildEditMesh(makeCube())!;
    const sel = extrudeEdges(em, new Set());
    expect(sel.size).toBe(0);
    expect(em.faces).toHaveLength(12);
  });

  it("extrudes a single edge into a fin quad", () => {
    const em = buildEditMesh(makeQuadPair())!;
    // Boundary edge — pick the first one
    let bdEdge = -1;
    for (let i = 0; i < em.halfEdges.length; i++) {
      if (em.halfEdges[i]!.twin < 0) { bdEdge = i; break; }
    }
    expect(bdEdge).toBeGreaterThanOrEqual(0);
    const sel = extrudeEdges(em, new Set([bdEdge]));
    // 1 fin quad added (V2): 2 original tris + 1 fin = 3 faces.
    expect(em.faces).toHaveLength(2 + 1);
    expect(em.vertices).toHaveLength(4 + 2); // 2 duplicates
    expect(sel.size).toBe(1);
  });

  it("dedups shared vertex when extruding two adjacent edges", () => {
    const em = buildEditMesh(makeQuadPair())!;
    // Two boundary edges sharing a vertex
    let e1 = -1, e2 = -1;
    for (let i = 0; i < em.halfEdges.length; i++) {
      if (em.halfEdges[i]!.twin < 0) {
        if (e1 < 0) e1 = i;
        else if (em.halfEdges[i]!.v === em.halfEdges[em.halfEdges[e1]!.next]!.v
                 || em.halfEdges[em.halfEdges[i]!.next]!.v === em.halfEdges[e1]!.v) {
          e2 = i; break;
        }
      }
    }
    if (e2 < 0) return; // skip if not found
    const sel = extrudeEdges(em, new Set([e1, e2]));
    // Two adjacent edges share 1 vert → 3 distinct verts duplicated (not 4).
    expect(em.vertices).toHaveLength(4 + 3);
    expect(sel.size).toBe(2); // 2 edges × 1 fin quad each (V2)
  });
});

describe("flipDiagonalByVerts", () => {
  it("returns empty on wrong selection size", () => {
    const em = buildEditMesh(makeCube())!;
    expect(flipDiagonalByVerts(em, new Set()).size).toBe(0);
    expect(flipDiagonalByVerts(em, new Set([0])).size).toBe(0);
    expect(flipDiagonalByVerts(em, new Set([0, 1, 2])).size).toBe(0);
  });

  it("flips the diagonal between two adjacent triangles", () => {
    const em = buildEditMesh(makeQuadPair())!;
    // makeQuadPair: positions (0,0,0), (1,0,0), (1,1,0), (0,1,0)
    //               indices [0,1,2,  0,2,3]
    // The 2 tris share diagonal 0-2. The "3rd verts" are 1 (in tri 0) and 3 (in tri 1).
    // Knife between vert 1 and vert 3 should flip the diagonal from 0-2 to 1-3.
    const before = toArr(em);
    const result = flipDiagonalByVerts(em, new Set([1, 3]));
    expect(result.size).toBe(2);
    const after = toArr(em);
    // Same face count, same vertex count.
    expect(em.faces).toHaveLength(2);
    expect(em.vertices).toHaveLength(4);
    // The new diagonal 1-3 must appear somewhere in the new index list.
    expect(containsEdge(after, 1, 3)).toBe(true);
    // The old diagonal 0-2 must NOT appear.
    expect(containsEdge(after, 0, 2)).toBe(false);
    // Sanity: the original DID contain 0-2.
    expect(containsEdge(before, 0, 2)).toBe(true);
  });

  it("flipDiagonalByVerts preserves manifold structure", () => {
    const em = buildEditMesh(makeQuadPair())!;
    flipDiagonalByVerts(em, new Set([1, 3]));
    // For an open mesh: should keep the same boundary edge count as before
    // (= 4, the quad's outer perimeter). The flip changes interior topology,
    // not the boundary.
    let boundaries = 0;
    forEachEdge(em, (he) => { if (em.halfEdges[he]!.twin < 0) boundaries++; });
    expect(boundaries).toBe(4);
  });

  it("returns empty for non-adjacent verts (V1 limitation)", () => {
    const em = buildEditMesh(makeCube())!;
    // Verts 3 and 5 — none of vertex 3's incident faces (1, 6, 7, 9) has a
    // direct edge-neighbor face that contains vertex 5. Confirmed manually
    // by walking the cube's tri adjacency from this triangulation.
    const result = flipDiagonalByVerts(em, new Set([3, 5]));
    expect(result.size).toBe(0);
    expect(em.faces).toHaveLength(12);
  });
});

describe("rotateEdges", () => {
  /** The half-edge whose endpoints are `a` and `b`, in either order. */
  function edgeBetween(em: import("./half-edge").EditMesh, a: number, b: number): number {
    let found = -1;
    forEachEdge(em, (he) => {
      const x = em.halfEdges[he]!.v;
      const y = em.halfEdges[em.halfEdges[he]!.next]!.v;
      if ((x === a && y === b) || (x === b && y === a)) found = he;
    });
    return found;
  }

  it("rotates the shared edge onto the other diagonal", () => {
    const em = buildEditMesh(makeQuadPair())!;
    // Two tris [0,1,2] and [0,2,3] sharing 0-2. Rotating it gives 1-3.
    const shared = edgeBetween(em, 0, 2);
    expect(shared).toBeGreaterThanOrEqual(0);

    const touched = rotateEdges(em, new Set([shared]));
    expect(touched.size).toBe(2);

    const after = toArr(em);
    expect(containsEdge(after, 1, 3)).toBe(true);
    expect(containsEdge(after, 0, 2)).toBe(false);
    expect(em.faces).toHaveLength(2);
    expect(em.vertices).toHaveLength(4);
  });

  it("agrees with the vertex-picked form on the same edge", () => {
    const byEdge = buildEditMesh(makeQuadPair())!;
    rotateEdges(byEdge, new Set([edgeBetween(byEdge, 0, 2)]));

    const byVerts = buildEditMesh(makeQuadPair())!;
    flipDiagonalByVerts(byVerts, new Set([1, 3]));

    expect(toArr(byEdge)).toEqual(toArr(byVerts));
  });

  it("rotating twice returns the original diagonal", () => {
    const em = buildEditMesh(makeQuadPair())!;
    const before = toArr(em);
    rotateEdges(em, new Set([edgeBetween(em, 0, 2)]));
    rotateEdges(em, new Set([edgeBetween(em, 1, 3)]));
    expect(containsEdge(toArr(em), 0, 2)).toBe(true);
    expect(toArr(em)).toHaveLength(before.length);
  });

  it("skips edges whose faces are not both triangles", () => {
    // A cube merged into 6 quads: a quad has no diagonal to rotate, so every
    // edge is held by the wrong kind of face and nothing should move.
    const em = buildEditMesh(makeCube())!;
    trisToQuads(em, null);
    expect(em.faces).toHaveLength(6);

    const all = new Set<number>();
    forEachEdge(em, (he) => all.add(he));
    expect(rotateEdges(em, all).size).toBe(0);
    expect(em.faces).toHaveLength(6);
  });

  it("skips boundary edges and empty input", () => {
    const em = buildEditMesh(makeQuadPair())!;
    expect(rotateEdges(em, new Set()).size).toBe(0);
    // 0-1 is on the perimeter: one side has no face to re-triangulate against.
    expect(rotateEdges(em, new Set([edgeBetween(em, 0, 1)])).size).toBe(0);
    expect(em.faces).toHaveLength(2);
  });
});

function toArr(em: import("./half-edge").EditMesh): number[] {
  const out: number[] = [];
  for (let f = 0; f < em.faces.length; f++) {
    const [a, b, c] = faceVertices(em, f);
    out.push(a, b, c);
  }
  return out;
}

function containsEdge(indices: number[], v1: number, v2: number): boolean {
  for (let f = 0; f < indices.length; f += 3) {
    const a = indices[f]!, b = indices[f + 1]!, c = indices[f + 2]!;
    for (const [x, y] of [[a, b], [b, c], [c, a]] as const) {
      if ((x === v1 && y === v2) || (x === v2 && y === v1)) return true;
    }
  }
  return false;
}

describe("loopCut", () => {
  it("returns empty on a boundary edge (no twin)", () => {
    const em = buildEditMesh(makeQuadPair())!;
    // Find a boundary half-edge (twin = -1).
    let boundary = -1;
    for (let i = 0; i < em.halfEdges.length; i++) {
      if (em.halfEdges[i]!.twin < 0) { boundary = i; break; }
    }
    expect(boundary).toBeGreaterThanOrEqual(0);
    const result = loopCut(em, boundary);
    expect(result.size).toBe(0);
    expect(em.faces).toHaveLength(2);
  });

  it("cuts a 4-edge loop around the cube via coplanar quad walking", () => {
    const em = buildEditMesh(makeCube())!;
    // Pick a canonical cube edge to seed the loop. The first canonical
    // half-edge is index 0 (= 0→2, the -z face diagonal) — that's a
    // diagonal, not a cube outer edge, and isn't on a loop. Find an outer
    // cube edge instead by looking for a canonical half-edge whose two
    // adjacent faces have non-parallel normals (which characterizes an
    // outer edge between two cube sides).
    let seed = -1;
    forEachEdge(em, (he) => {
      if (seed >= 0) return;
      const tw = em.halfEdges[he]!.twin;
      if (tw < 0) return;
      const f1 = em.halfEdges[he]!.face;
      const f2 = em.halfEdges[tw]!.face;
      // Compute normals manually
      const [a1, b1, c1] = [0, 1, 2].map((i) => {
        const v = i === 0 ? em.halfEdges[em.faces[f1]!.he]!.v
                : i === 1 ? em.halfEdges[em.halfEdges[em.faces[f1]!.he]!.next]!.v
                : em.halfEdges[em.halfEdges[em.halfEdges[em.faces[f1]!.he]!.next]!.next]!.v;
        return [em.positions[v * 3]!, em.positions[v * 3 + 1]!, em.positions[v * 3 + 2]!];
      });
      const [a2, b2, c2] = [0, 1, 2].map((i) => {
        const v = i === 0 ? em.halfEdges[em.faces[f2]!.he]!.v
                : i === 1 ? em.halfEdges[em.halfEdges[em.faces[f2]!.he]!.next]!.v
                : em.halfEdges[em.halfEdges[em.halfEdges[em.faces[f2]!.he]!.next]!.next]!.v;
        return [em.positions[v * 3]!, em.positions[v * 3 + 1]!, em.positions[v * 3 + 2]!];
      });
      const cross = (p: number[][]) => {
        const u = [p[1]![0]! - p[0]![0]!, p[1]![1]! - p[0]![1]!, p[1]![2]! - p[0]![2]!];
        const v = [p[2]![0]! - p[0]![0]!, p[2]![1]! - p[0]![1]!, p[2]![2]! - p[0]![2]!];
        return [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
      };
      const n1 = cross([a1!, b1!, c1!]);
      const n2 = cross([a2!, b2!, c2!]);
      const len1 = Math.hypot(n1[0]!, n1[1]!, n1[2]!);
      const len2 = Math.hypot(n2[0]!, n2[1]!, n2[2]!);
      const dot = (n1[0]! * n2[0]! + n1[1]! * n2[1]! + n1[2]! * n2[2]!) / (len1 * len2);
      if (Math.abs(dot) < 0.5) seed = he; // non-parallel = outer cube edge
    });
    expect(seed).toBeGreaterThanOrEqual(0);

    const result = loopCut(em, seed);
    // A cube outer-edge loop has 4 edges (goes around one axis).
    // 4 new midpoints = 4 new verts.
    expect(result.size).toBe(4);
    expect(em.vertices).toHaveLength(8 + 4);
    // Each crossed quad (= 2 tris) becomes 4 tris → net +2 per quad ×
    // 4 quads = +8 tris on top of the 4 untouched faces.
    expect(em.faces).toHaveLength(12 + 8);
  });

  it("loop cut preserves manifold closure", () => {
    const em = buildEditMesh(makeCube())!;
    let seed = -1;
    // Same outer-edge detection as above (simpler — first non-diagonal edge).
    // The cube's half-edge 6 is in face 2 (-y face's 1st tri = 4,5,6).
    // Half-edge index 12 is 0→1 (cube edge). Use that.
    seed = 12;
    const result = loopCut(em, seed);
    expect(result.size).toBeGreaterThan(0);
    let boundaries = 0;
    forEachEdge(em, (he) => { if (em.halfEdges[he]!.twin < 0) boundaries++; });
    expect(boundaries).toBe(0);
  });
});

describe("delete variants", () => {
  it("deleteFacesByVertices drops every face touching the vertex set", () => {
    const em = buildEditMesh(makeCube())!;
    // Vertex 0 is on faces 0, 1 (-z), 4, 5 (-y), 8, 9 (-x) → 6 faces
    const sel = deleteFacesByVertices(em, new Set([0]));
    expect(sel.size).toBe(0);
    expect(em.faces).toHaveLength(6);
  });

  it("deleteFacesByEdges drops both adjacent faces of each edge", () => {
    const em = buildEditMesh(makeCube())!;
    // Pick the first edge — it's between two faces of the same cube side.
    let firstEdge = -1;
    forEachEdge(em, (he) => { if (firstEdge < 0) firstEdge = he; });
    deleteFacesByEdges(em, new Set([firstEdge]));
    expect(em.faces).toHaveLength(10);
  });
});

// ── F-M8 batch 1: edgeSlide / merge / bridge ──

import { edgeSlide, mergeAtCenter, collapseEdges, bridgeEdgeLoops } from "./operators";
import { edgeEnd, edgeOrigin, type EditMesh } from "./half-edge";
import { cylinder } from "../generate";

/** Canonical half-edge between two vertices, or -1. */
function edgeBetween(em: EditMesh, a: number, b: number): number {
  let found = -1;
  forEachEdge(em, (he) => {
    const o = edgeOrigin(em, he);
    const e = edgeEnd(em, he);
    if ((o === a && e === b) || (o === b && e === a)) found = he;
  });
  return found;
}

/** 3×1 quad strip in the XY plane (verts 0-3 bottom, 4-7 top), CCW from +Z. */
function makeStrip(): Mesh {
  const positions = [
    0, 0, 0,  1, 0, 0,  2, 0, 0,  3, 0, 0,
    0, 1, 0,  1, 1, 0,  2, 1, 0,  3, 1, 0,
  ];
  const indices = [
    0, 1, 5,  0, 5, 4,
    1, 2, 6,  1, 6, 5,
    2, 3, 7,  2, 7, 6,
  ];
  return makeStubMesh(positions, indices);
}

describe("edgeSlide", () => {
  it("slides a vertical edge along the strip, both verts coherently", () => {
    const em = buildEditMesh(makeStrip())!;
    const he = edgeBetween(em, 1, 5);
    expect(he).toBeGreaterThanOrEqual(0);
    const sel = edgeSlide(em, new Set([he]), 0.5);
    expect(sel.size).toBe(1);
    // Topology unchanged.
    expect(em.faces).toHaveLength(6);
    expect(em.vertices).toHaveLength(8);
    // Both loop verts moved 0.5 along X to the SAME side; Y/Z intact.
    const x1 = em.positions[1 * 3]!;
    const x5 = em.positions[5 * 3]!;
    expect(Math.abs(x1 - 1)).toBeCloseTo(0.5, 5);
    expect(x5).toBeCloseTo(x1, 5);
    expect(em.positions[1 * 3 + 1]).toBeCloseTo(0, 5);
    expect(em.positions[5 * 3 + 1]).toBeCloseTo(1, 5);
    // Unselected verts untouched.
    expect(em.positions[2 * 3]).toBeCloseTo(2, 5);
  });

  it("opposite sign slides to the opposite side", () => {
    const emA = buildEditMesh(makeStrip())!;
    const emB = buildEditMesh(makeStrip())!;
    edgeSlide(emA, new Set([edgeBetween(emA, 1, 5)]), 0.5);
    edgeSlide(emB, new Set([edgeBetween(emB, 1, 5)]), -0.5);
    const dxA = emA.positions[1 * 3]! - 1;
    const dxB = emB.positions[1 * 3]! - 1;
    expect(dxA * dxB).toBeLessThan(0); // opposite directions
    expect(Math.abs(dxB)).toBeCloseTo(0.5, 5);
  });

  it("t=0 or empty selection is a no-op", () => {
    const em = buildEditMesh(makeStrip())!;
    const before = new Float32Array(em.positions);
    edgeSlide(em, new Set([edgeBetween(em, 1, 5)]), 0);
    edgeSlide(em, new Set(), 0.5);
    expect([...em.positions]).toEqual([...before]);
  });
});

describe("mergeAtCenter / collapseEdges", () => {
  it("merges two adjacent cube verts, dropping degenerate faces", () => {
    const em = buildEditMesh(makeCube())!;
    const sel = mergeAtCenter(em, new Set([0, 1]));
    expect(sel.size).toBe(1);
    expect(em.vertices).toHaveLength(7);
    expect(em.faces).toHaveLength(10); // 2 tris on the shared edge collapsed
    const v = [...sel][0]!;
    expect(em.positions[v * 3]).toBeCloseTo(0, 5); // centroid of (-1,-1,-1)/(1,-1,-1)
    expect(em.positions[v * 3 + 1]).toBeCloseTo(-1, 5);
    expect(em.positions[v * 3 + 2]).toBeCloseTo(-1, 5);
  });

  it("merging non-adjacent verts keeps all faces", () => {
    const em = buildEditMesh(makeCube())!;
    mergeAtCenter(em, new Set([0, 6]));
    expect(em.vertices).toHaveLength(7);
    expect(em.faces).toHaveLength(12);
  });

  it("needs at least 2 verts", () => {
    const em = buildEditMesh(makeCube())!;
    expect(mergeAtCenter(em, new Set([0])).size).toBe(0);
    expect(em.vertices).toHaveLength(8);
  });

  it("collapseEdges collapses each selected edge to its midpoint", () => {
    const em = buildEditMesh(makeCube())!;
    const he = edgeBetween(em, 0, 1);
    const sel = collapseEdges(em, new Set([he]));
    expect(sel.size).toBe(1);
    expect(em.vertices).toHaveLength(7);
    expect(em.faces).toHaveLength(10);
  });

  it("collapseEdges unions shared-endpoint runs into one vertex", () => {
    const em = buildEditMesh(makeStrip())!;
    // Bottom edges 0-1 and 1-2 share vertex 1 → single 3-vert cluster.
    const sel = collapseEdges(em, new Set([edgeBetween(em, 0, 1), edgeBetween(em, 1, 2)]));
    expect(sel.size).toBe(1);
    const v = [...sel][0]!;
    expect(em.positions[v * 3]).toBeCloseTo(1, 5); // centroid x of 0,1,2
  });
});

describe("bridgeEdgeLoops", () => {
  /** Two 1×1 quads facing each other at z=0 and z=1. */
  function makeFacingQuads(): Mesh {
    const positions = [
      0, 0, 0,  1, 0, 0,  1, 1, 0,  0, 1, 0,
      0, 0, 1,  1, 0, 1,  1, 1, 1,  0, 1, 1,
    ];
    const indices = [
      0, 1, 2,  0, 2, 3,
      4, 5, 6,  4, 6, 7,
    ];
    return makeStubMesh(positions, indices);
  }

  function boundaryEdges(em: EditMesh): Set<number> {
    const out = new Set<number>();
    forEachEdge(em, (he) => {
      if (em.halfEdges[he]!.twin < 0) out.add(he);
    });
    return out;
  }

  it("bridges two 4-vert boundary cycles into a closed band", () => {
    const em = buildEditMesh(makeFacingQuads())!;
    const sel = boundaryEdges(em);
    expect(sel.size).toBe(8); // 4 per quad (diagonals are interior)
    const newFaces = bridgeEdgeLoops(em, sel);
    expect(newFaces.size).toBe(4); // 4 REAL quads (V2)
    expect(em.faces).toHaveLength(8); // 4 original tris + 4 band quads
    // The result is watertight: no boundary edges remain.
    expect(boundaryEdges(em).size).toBe(0);
  });

  it("rejects loops with mismatched vertex counts", () => {
    // Square at z=0, triangle at z=1.
    const positions = [
      0, 0, 0,  1, 0, 0,  1, 1, 0,  0, 1, 0,
      0, 0, 1,  1, 0, 1,  0.5, 1, 1,
    ];
    const indices = [0, 1, 2, 0, 2, 3, 4, 5, 6];
    const em = buildEditMesh(makeStubMesh(positions, indices))!;
    const sel = boundaryEdges(em);
    expect(bridgeEdgeLoops(em, sel).size).toBe(0);
    expect(em.faces).toHaveLength(3);
  });

  it("rejects selections containing interior edges", () => {
    const em = buildEditMesh(makeFacingQuads())!;
    const sel = boundaryEdges(em);
    sel.add(edgeBetween(em, 0, 2)); // a diagonal (interior)
    expect(bridgeEdgeLoops(em, sel).size).toBe(0);
  });

  it("rejects a selection that isn't exactly two loops", () => {
    const em = buildEditMesh(makeFacingQuads())!;
    // Only quad A's boundary — one loop.
    const sel = new Set<number>();
    forEachEdge(em, (he) => {
      if (em.halfEdges[he]!.twin < 0 && edgeOrigin(em, he) < 4 && edgeEnd(em, he) < 4) sel.add(he);
    });
    expect(sel.size).toBe(4);
    expect(bridgeEdgeLoops(em, sel).size).toBe(0);
  });
});

// ── F-M8 batch 4: vertexSlide ──

import { vertexSlide } from "./operators";

describe("vertexSlide", () => {
  it("slides the mover toward the anchor along their shared edge", () => {
    const em = buildEditMesh(makeCube())!;
    const sel = vertexSlide(em, 0, 1, 0.5); // anchor (-1,-1,-1), mover (1,-1,-1)
    expect([...sel]).toEqual([1]);
    expect(em.positions[3]).toBeCloseTo(0);
    expect(em.positions[4]).toBeCloseTo(-1);
    expect(em.positions[5]).toBeCloseTo(-1);
    // Anchor untouched.
    expect(em.positions[0]).toBeCloseTo(-1);
  });

  it("negative t extrapolates away from the anchor", () => {
    const em = buildEditMesh(makeCube())!;
    vertexSlide(em, 0, 1, -0.5);
    expect(em.positions[3]).toBeCloseTo(2);
    expect(em.positions[4]).toBeCloseTo(-1);
  });

  it("rejects non-adjacent vertex pairs without touching positions", () => {
    const em = buildEditMesh(makeCube())!;
    const before = new Float32Array(em.positions);
    const sel = vertexSlide(em, 0, 6, 0.5); // opposite cube corners
    expect(sel.size).toBe(0);
    expect(Array.from(em.positions)).toEqual(Array.from(before));
  });

  it("rejects anchor === mover", () => {
    const em = buildEditMesh(makeCube())!;
    expect(vertexSlide(em, 2, 2, 0.5).size).toBe(0);
  });

  it("t is clamped to ±1 (mover lands exactly on the anchor)", () => {
    const em = buildEditMesh(makeCube())!;
    vertexSlide(em, 0, 1, 5);
    expect(em.positions[3]).toBeCloseTo(-1);
    expect(em.positions[4]).toBeCloseTo(-1);
    expect(em.positions[5]).toBeCloseTo(-1);
  });
});

describe("trisToQuads shape threshold", () => {
  it("test_a_sliver_pair_is_left_as_triangles", () => {
    // Two triangles in one plane, meeting along a long thin diagonal: joining
    // them is legal by the normal test and gives a quad with a 20° corner.
    // Blender refuses it at the default 40°, and so does this.
    const em = meshFromData({
      positions: Float32Array.from([
        0, 0, 0,
        4, 0, 0,
        4, 0, 0.35,
        0, 0, 0.35,
      ]),
      polys: [[0, 1, 2], [0, 2, 3]],
    });
    expect(trisToQuads(em, null).size).toBe(1); // a rectangle joins
    const sliver = meshFromData({
      positions: Float32Array.from([
        0, 0, 0,
        4, 0, 0,
        4.2, 0, 0.1,
        0.1, 0, 0.02,
      ]),
      polys: [[0, 1, 2], [0, 2, 3]],
    });
    expect(trisToQuads(sliver, null).size).toBe(0);
    // Opening the threshold takes it: the rule is a threshold, not a veto.
    expect(trisToQuads(sliver, null, 40, 179).size).toBe(1);
  });
});

describe("bridgeEdgeLoops duplicate guard", () => {
  it("test_bridging_a_tube_does_not_double_its_wall", () => {
    // The two rims of a tube are already joined through the wall, so every
    // quad the bridge would add lands exactly on one that exists. Blender's
    // bmesh refuses to create a face twice; without the same guard this came
    // back as a 24-face tube where 12 faces were copies — which renders and
    // measures like a tube until something z-fights.
    const em = meshFromData(cylinder({ radius1: 0.2, depth: 0.5, uSegments: 12, caps: "none" }));
    const rims = new Set<number>();
    forEachEdge(em, (he) => {
      if (em.halfEdges[he]!.twin < 0) rims.add(he);
    });
    expect(rims.size).toBe(24);

    bridgeEdgeLoops(em, rims);
    const out = meshToData(em);
    expect(out.polys).toHaveLength(12);

    const keys = new Set(out.polys.map((p) => [...p].sort((a, b) => a - b).join(",")));
    expect(keys.size).toBe(12);
  });
});

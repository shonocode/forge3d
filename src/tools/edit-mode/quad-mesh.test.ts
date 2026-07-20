import { describe, it, expect } from "vitest";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { buildEditMesh, CREASE_METADATA_KEY, POLY_METADATA_KEY, SEAM_METADATA_KEY } from "./build";
import { writePolyMetadata } from "./commit";
import {
  faceVertexCount,
  faceVerts,
  fanTriangulate,
  forEachEdge,
  hasNonTriFaces,
  rebuildPolygons,
  toPolygons,
  triangulateFaces,
  type EditMesh,
} from "./half-edge";
import { collapseEdges, extrudeFaces, insetFaces, loopCut, quadsToTris, trisToQuads } from "./operators";
import { smartUVProject } from "./uv-unwrap";

/** Stub Babylon Mesh — exposes just the surface build/commit touch. */
function makeStubMesh(positions: number[], indices: number[], metadata?: Record<string, unknown>): Mesh {
  let pos = new Float32Array(positions);
  let normals = new Float32Array(positions.length);
  let ind = indices.slice();
  return {
    metadata: metadata ?? null,
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

const CUBE_POSITIONS = [
  -1, -1, -1,  1, -1, -1,  1, 1, -1,  -1, 1, -1,
  -1, -1,  1,  1, -1,  1,  1, 1,  1,  -1, 1,  1,
];

/** Quad cube: 6 CCW-outward quads. */
const CUBE_QUADS: number[][] = [
  [0, 3, 2, 1], // -z
  [4, 5, 6, 7], // +z
  [0, 1, 5, 4], // -y
  [3, 7, 6, 2], // +y
  [0, 4, 7, 3], // -x
  [1, 2, 6, 5], // +x
];

const TRI_CUBE_INDICES = [
  0, 2, 1,  0, 3, 2,
  4, 5, 6,  4, 6, 7,
  0, 1, 5,  0, 5, 4,
  3, 7, 6,  3, 6, 2,
  0, 4, 7,  0, 7, 3,
  1, 2, 6,  1, 6, 5,
];

/** Build a quad-cube EditMesh directly via rebuildPolygons. */
function makeQuadCubeEM(): EditMesh {
  const indices = CUBE_QUADS.flatMap((q) => fanTriangulate(q));
  const em = buildEditMesh(makeStubMesh(CUBE_POSITIONS, indices))!;
  rebuildPolygons(em, new Float32Array(CUBE_POSITIONS), CUBE_QUADS);
  em.triToFace = triangulateFaces(em).triToFace;
  return em;
}

function expectManifold(em: EditMesh): void {
  for (let i = 0; i < em.halfEdges.length; i++) {
    const t = em.halfEdges[i]!.twin;
    expect(t).toBeGreaterThanOrEqual(0);
    expect(em.halfEdges[t]!.twin).toBe(i);
  }
}

describe("half-edge V2 core (quad cube)", () => {
  it("rebuildPolygons builds a watertight quad cube (24 half-edges, 12 edges)", () => {
    const em = makeQuadCubeEM();
    expect(em.faces).toHaveLength(6);
    expect(em.halfEdges).toHaveLength(24);
    expect(hasNonTriFaces(em)).toBe(true);
    for (let f = 0; f < 6; f++) expect(faceVertexCount(em, f)).toBe(4);
    expectManifold(em);
    let edges = 0;
    forEachEdge(em, () => edges++);
    expect(edges).toBe(12); // real cube edges only — no diagonals
  });

  it("toPolygons round-trips through rebuildPolygons", () => {
    const em = makeQuadCubeEM();
    const polys = toPolygons(em);
    expect(polys).toEqual(CUBE_QUADS);
    rebuildPolygons(em, em.positions, polys);
    expect(toPolygons(em)).toEqual(CUBE_QUADS);
  });

  it("triangulateFaces fans each quad into 2 tris with triToFace back-map", () => {
    const em = makeQuadCubeEM();
    const { indices, triToFace } = triangulateFaces(em);
    expect(indices).toHaveLength(12 * 3);
    expect(triToFace).toHaveLength(12);
    for (let t = 0; t < 12; t++) expect(triToFace[t]).toBe(Math.floor(t / 2));
    // Each fan triangle's verts are a subset of its face's verts.
    for (let t = 0; t < 12; t++) {
      const fv = new Set(faceVerts(em, triToFace[t]!));
      for (let k = 0; k < 3; k++) expect(fv.has(indices[t * 3 + k]!)).toBe(true);
    }
  });
});

describe("buildEditMesh polygon metadata restore", () => {
  it("restores quads when metadata matches the index buffer", () => {
    const indices = CUBE_QUADS.flatMap((q) => fanTriangulate(q));
    const mesh = makeStubMesh(CUBE_POSITIONS, indices, { [POLY_METADATA_KEY]: CUBE_QUADS });
    const em = buildEditMesh(mesh)!;
    expect(em.faces).toHaveLength(6);
    expect(toPolygons(em)).toEqual(CUBE_QUADS);
    expect(em.triToFace).toHaveLength(12);
    expect(em.triToFace[3]).toBe(1);
  });

  it("discards stale metadata whose triangulation mismatches the index buffer", () => {
    // Tri-cube index buffer but metadata claiming a different quad layout.
    const mesh = makeStubMesh(CUBE_POSITIONS, TRI_CUBE_INDICES, { [POLY_METADATA_KEY]: CUBE_QUADS });
    const em = buildEditMesh(mesh)!;
    expect(em.faces).toHaveLength(12); // fell back to triangles
    expect(hasNonTriFaces(em)).toBe(false);
    const meta = (mesh.metadata ?? {}) as Record<string, unknown>;
    expect(meta[POLY_METADATA_KEY]).toBeUndefined(); // stale copy dropped
  });

  it("ignores malformed metadata (short polys, out-of-range verts)", () => {
    const bad = { [POLY_METADATA_KEY]: [[0, 1], [0, 1, 99]] };
    const em = buildEditMesh(makeStubMesh(CUBE_POSITIONS, TRI_CUBE_INDICES, bad))!;
    expect(em.faces).toHaveLength(12);
  });
});

describe("seam / crease metadata persistence (.forge3d v2)", () => {
  it("writePolyMetadata stores polys + seams + creases; build restores them", () => {
    const em = makeQuadCubeEM();
    em.seams.add("0_3");
    em.seams.add("1_2");
    em.creases.set("0_1", 1);
    em.creases.set("2_3", 2.5);
    writePolyMetadata(em);

    const meta = em.source.metadata as Record<string, unknown>;
    expect(meta[SEAM_METADATA_KEY]).toEqual(["0_3", "1_2"]);
    expect(meta[CREASE_METADATA_KEY]).toEqual([["0_1", 1], ["2_3", 2.5]]);

    // Fresh build off the SAME mesh (metadata carries polys + edge attrs).
    const em2 = buildEditMesh(em.source)!;
    expect(em2.faces).toHaveLength(6); // quads restored
    expect([...em2.seams].sort()).toEqual(["0_3", "1_2"]);
    expect(em2.creases.get("0_1")).toBe(1);
    expect(em2.creases.get("2_3")).toBe(2.5);
  });

  it("drops out-of-range or degenerate edge keys on restore", () => {
    const meta = {
      [POLY_METADATA_KEY]: CUBE_QUADS,
      [SEAM_METADATA_KEY]: ["0_3", "0_99", "5_5", "bad"],
      [CREASE_METADATA_KEY]: [["1_2", 1], ["3_100", 2], ["4_4", 1], ["ok", 1]],
    };
    const indices = CUBE_QUADS.flatMap((q) => fanTriangulate(q));
    const em = buildEditMesh(makeStubMesh(CUBE_POSITIONS, indices, meta))!;
    expect([...em.seams]).toEqual(["0_3"]); // only the valid in-range key
    expect([...em.creases.keys()]).toEqual(["1_2"]);
  });

  it("clears metadata keys when seams / creases are emptied", () => {
    const em = makeQuadCubeEM();
    em.seams.add("0_3");
    writePolyMetadata(em);
    expect((em.source.metadata as Record<string, unknown>)[SEAM_METADATA_KEY]).toBeDefined();
    em.seams.clear();
    writePolyMetadata(em);
    expect((em.source.metadata as Record<string, unknown>)[SEAM_METADATA_KEY]).toBeUndefined();
  });
});

describe("trisToQuads / quadsToTris", () => {
  it("joins a triangulated cube into 6 quads (watertight, diagonals gone)", () => {
    const em = buildEditMesh(makeStubMesh(CUBE_POSITIONS, TRI_CUBE_INDICES))!;
    const quads = trisToQuads(em, null);
    expect(quads.size).toBe(6);
    expect(em.faces).toHaveLength(6);
    for (let f = 0; f < 6; f++) expect(faceVertexCount(em, f)).toBe(4);
    expectManifold(em);
    let edges = 0;
    forEachEdge(em, () => edges++);
    expect(edges).toBe(12);
  });

  it("respects a face-selection scope", () => {
    const em = buildEditMesh(makeStubMesh(CUBE_POSITIONS, TRI_CUBE_INDICES))!;
    const quads = trisToQuads(em, new Set([0, 1])); // only the -z pair
    expect(quads.size).toBe(1);
    expect(em.faces).toHaveLength(11); // 10 remaining tris + 1 quad
  });

  it("does not merge across sharp (non-coplanar) edges", () => {
    const em = buildEditMesh(makeStubMesh(CUBE_POSITIONS, TRI_CUBE_INDICES))!;
    trisToQuads(em, null);
    // The 6 quads must each be planar cube sides — every quad's verts share
    // one coordinate at ±1.
    for (let f = 0; f < em.faces.length; f++) {
      const vs = faceVerts(em, f);
      let planar = false;
      for (let axis = 0; axis < 3; axis++) {
        const c = em.positions[vs[0]! * 3 + axis]!;
        if (vs.every((v) => em.positions[v * 3 + axis] === c)) planar = true;
      }
      expect(planar).toBe(true);
    }
  });

  it("quadsToTris fan-triangulates back to 12 tris", () => {
    const em = makeQuadCubeEM();
    const tris = quadsToTris(em, null);
    expect(tris.size).toBe(12);
    expect(em.faces).toHaveLength(12);
    expect(hasNonTriFaces(em)).toBe(false);
    expectManifold(em);
  });

  it("quadsToTris returns empty on an all-tri mesh", () => {
    const em = buildEditMesh(makeStubMesh(CUBE_POSITIONS, TRI_CUBE_INDICES))!;
    expect(quadsToTris(em, null).size).toBe(0);
    expect(em.faces).toHaveLength(12);
  });
});

describe("polygon-aware operators on a quad cube", () => {
  it("extrudeFaces emits quad skirts and a quad cap", () => {
    const em = makeQuadCubeEM();
    const sel = extrudeFaces(em, new Set([0]));
    expect(sel.size).toBe(1);
    // 5 untouched + 4 skirt quads + 1 cap = 10 faces, all quads.
    expect(em.faces).toHaveLength(10);
    for (let f = 0; f < em.faces.length; f++) expect(faceVertexCount(em, f)).toBe(4);
    expect(em.vertices).toHaveLength(12);
    expectManifold(em);
  });

  it("insetFaces keeps the cap arity and emits quad skirts", () => {
    const em = makeQuadCubeEM();
    const sel = insetFaces(em, new Set([1]), 0.3);
    expect(sel.size).toBe(1);
    expect(em.faces).toHaveLength(10); // 5 + 4 skirts + 1 cap
    const cap = [...sel][0]!;
    expect(faceVertexCount(em, cap)).toBe(4);
    expectManifold(em);
  });

  it("loopCut walks real quads and splits them into quads", () => {
    const em = makeQuadCubeEM();
    // Seed: any edge — the ring crosses 4 quads and leaves 2 untouched.
    let seed = -1;
    forEachEdge(em, (he) => { if (seed < 0) seed = he; });
    const newVerts = loopCut(em, seed);
    expect(newVerts.size).toBe(4);
    expect(em.faces).toHaveLength(10); // 4 crossed → 8 quads, +2 untouched
    let quadCount = 0;
    for (let f = 0; f < em.faces.length; f++) {
      if (faceVertexCount(em, f) === 4) quadCount++;
    }
    expect(quadCount).toBe(10); // quad flow preserved — no tris introduced
    expectManifold(em);
  });

  it("collapseEdges degrades adjacent quads to tris instead of dropping them", () => {
    const em = makeQuadCubeEM();
    // Collapse cube edge 0-1 (shared by -z and -y quads).
    let target = -1;
    forEachEdge(em, (he) => {
      const a = em.halfEdges[he]!.v;
      const b = em.halfEdges[em.halfEdges[he]!.next]!.v;
      if ((a === 0 && b === 1) || (a === 1 && b === 0)) target = he;
    });
    expect(target).toBeGreaterThanOrEqual(0);
    const sel = collapseEdges(em, new Set([target]));
    expect(sel.size).toBe(1);
    expect(em.faces).toHaveLength(6); // no face dropped
    const arities = Array.from({ length: 6 }, (_, f) => faceVertexCount(em, f)).sort();
    expect(arities).toEqual([3, 3, 4, 4, 4, 4]); // 2 quads became tris
    expect(em.vertices).toHaveLength(7);
  });

  it("undo snapshot round-trip: toPolygons → op → rebuildPolygons restores quads", () => {
    const em = makeQuadCubeEM();
    const beforePos = new Float32Array(em.positions);
    const beforePolys = toPolygons(em);
    extrudeFaces(em, new Set([0]));
    expect(em.faces).toHaveLength(10);
    rebuildPolygons(em, beforePos, beforePolys);
    expect(toPolygons(em)).toEqual(CUBE_QUADS);
    expectManifold(em);
  });
});

describe("smartUVProject on quads", () => {
  it("preserves quad polygons through the unwrap", () => {
    const em = makeQuadCubeEM();
    const result = smartUVProject(em);
    expect(result.polys).toHaveLength(6);
    for (const p of result.polys) expect(p).toHaveLength(4);
    // Fan indices: 6 quads × 2 tris.
    expect(result.indices).toHaveLength(36);
    // Cluster-welded cube: 6 islands × 4 verts (each side its own cluster).
    expect(result.positions.length / 3).toBe(24);
    expect(result.sourceVerts).toHaveLength(24);
    // All UVs land inside the unit square.
    for (let i = 0; i < result.uvs.length; i++) {
      expect(result.uvs[i]!).toBeGreaterThanOrEqual(-1e-6);
      expect(result.uvs[i]!).toBeLessThanOrEqual(1 + 1e-6);
    }
  });
});

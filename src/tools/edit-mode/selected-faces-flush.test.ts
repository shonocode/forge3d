import { describe, it, expect } from "vitest";
import { meshFromData, meshToData, type MeshData } from "../../lib/mesh";
import { convertSelectedFaces, selectedFacesFlushed, trisToQuadsOperator } from "./index";
import { canonicalEdge, edgeEnd, edgeOrigin, faceHalfEdges, faceVerts, toPolygons } from "./half-edge";
import { triangulateEditFaces, trisToQuads } from "./operators";

// The GUI's Tris to Quads and Triangulate act on the selected faces only, vertices and edges selecting the faces they
// enclose, as Blender's operators (`faces=%hf`, `totfacesel == 0` → nothing) — compat-backlog C117.

/** A 3 × 3 grid of quads, vertices row by row. */
function grid(): MeshData {
  const positions: number[] = [];
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) positions.push(x, y, 0);
  const polys: number[][] = [];
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) polys.push([y * 4 + x, y * 4 + x + 1, y * 4 + x + 5, y * 4 + x + 4]);
  return { positions: new Float32Array(positions), polys };
}

describe("selectedFacesFlushed", () => {
  it("vertex mode: only the faces every corner of which is selected", () => {
    const em = meshFromData(grid());
    // The bottom-left quad's corners and one more vertex: that quad only.
    expect([...selectedFacesFlushed(em, "vertex", new Set([0, 1, 4, 5, 6]))]).toEqual([0]);
    // Two quads' corners.
    expect([...selectedFacesFlushed(em, "vertex", new Set([0, 1, 2, 4, 5, 6]))].sort()).toEqual([0, 1]);
  });

  it("edge mode: only the faces every edge of which is selected", () => {
    const em = meshFromData(grid());
    const edges = new Set(faceHalfEdges(em, 4)); // the middle quad's edges, as half-edges of that face
    expect([...selectedFacesFlushed(em, "edge", edges)]).toEqual([4]);
    // Three of its edges: no face.
    expect(selectedFacesFlushed(em, "edge", new Set([...edges].slice(0, 3))).size).toBe(0);
    // The same edges named by their other half-edge (every edge of the middle quad has one).
    const twins = new Set([...edges].map((he) => em.halfEdges[he]!.twin));
    expect([...twins].every((he) => he >= 0 && !edges.has(he))).toBe(true);
    expect([...selectedFacesFlushed(em, "edge", twins)]).toEqual([4]);
  });

  it("an empty selection selects no face", () => {
    const em = meshFromData(grid());
    for (const mode of ["vertex", "edge", "face"] as const) expect(selectedFacesFlushed(em, mode, new Set()).size).toBe(0);
  });

  it("Triangulate on a vertex selection changes the enclosed faces and no other", () => {
    const em = meshFromData(grid());
    const faces = selectedFacesFlushed(em, "vertex", new Set([0, 1, 2, 4, 5, 6]));
    triangulateEditFaces(em, faces);
    const polys = toPolygons(em);
    expect(polys.filter((p) => p.length === 3)).toHaveLength(4);
    expect(polys.filter((p) => p.length === 4)).toHaveLength(7);
  });

  it("Tris to Quads on an edge selection joins inside it and no further", () => {
    const em = meshFromData(grid());
    triangulateEditFaces(em, null);
    const all = meshToData(em).polys.length; // 18 triangles
    // The two triangles of the first quad: their edges selected.
    const tris = [0, 1].map((f) => new Set(faceHalfEdges(em, f)));
    const edges = new Set([...tris[0]!, ...tris[1]!]);
    const faces = selectedFacesFlushed(em, "edge", edges);
    expect(faces.size).toBe(2);
    trisToQuads(em, faces);
    const polys = toPolygons(em);
    expect(polys).toHaveLength(all - 1);
    expect(polys.filter((p) => p.length === 4)).toHaveLength(1);
  });
});

describe("convertSelectedFaces (what the GUI runs)", () => {
  const tri = (m: Parameters<typeof triangulateEditFaces>[0], f: ReadonlySet<number>): Set<number> => triangulateEditFaces(m, f);

  it("vertex mode: the enclosed faces change, the mode and the vertex selection stay", () => {
    const em = meshFromData(grid());
    const ids = new Set([0, 1, 2, 4, 5, 6]);
    const sel = convertSelectedFaces(em, "vertex", ids, tri)!;
    expect([...sel].sort((a, b) => a - b)).toEqual([...ids]);
    expect(toPolygons(em).filter((p) => p.length === 3)).toHaveLength(4);
  });

  it("edge mode: the old edges and the new faces' edges", () => {
    const em = meshFromData(grid());
    const edges = new Set(faceHalfEdges(em, 4));
    const before = new Set([...edges].map((he) => [edgeOrigin(em, he), edgeEnd(em, he)].sort((a, b) => a - b).join("_")));
    const sel = convertSelectedFaces(em, "edge", edges, tri)!;
    const names = new Set([...sel].map((he) => [edgeOrigin(em, he), edgeEnd(em, he)].sort((a, b) => a - b).join("_")));
    // The quad's four edges and its new diagonal.
    expect(names.size).toBe(5);
    for (const k of before) expect(names.has(k)).toBe(true);
    for (const he of sel) expect(he).toBe(canonicalEdge(em, he));
  });

  it("face mode: a selected face the operator leaves alone stays selected", () => {
    const em = meshFromData(grid());
    triangulateEditFaces(em, new Set([0])); // faces: 8 quads, then the two triangles of the first
    const quad = toPolygons(em).findIndex((p) => p.length === 4);
    const tris = toPolygons(em).flatMap((p, f) => (p.length === 3 ? [f] : []));
    const sel = convertSelectedFaces(em, "face", new Set([quad, ...tris]), tri)!;
    // The quad is cut into two; the two triangles were already triangles — still selected.
    expect(sel.size).toBe(4);
    expect([...sel].every((f) => faceVerts(em, f).length === 3)).toBe(true);
  });

  it("returns null and leaves the mesh alone when the operator changes nothing", () => {
    const em = meshFromData(grid());
    triangulateEditFaces(em, null);
    const before = toPolygons(em);
    expect(convertSelectedFaces(em, "face", new Set([0, 1]), tri)).toBeNull();
    expect(toPolygons(em)).toEqual(before);
    expect(convertSelectedFaces(em, "vertex", new Set(), (m, f) => trisToQuads(m, f))).toBeNull();
  });
});

describe("Tris to Quads with exactly two faces selected", () => {
  it("joins them with no angle limit, as Blender does for a face pair (180°); the 40° default refuses", () => {
    // Two triangles folded 90° along their shared edge.
    const data: MeshData = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]), polys: [[0, 1, 2], [0, 3, 1]] };
    expect(trisToQuads(meshFromData(data), new Set([0, 1])).size).toBe(0);
    expect(trisToQuadsOperator(meshFromData(data), new Set([0, 1])).size).toBe(1);
    // Through the GUI's path, the pair picked by its four vertices.
    expect(convertSelectedFaces(meshFromData(data), "vertex", new Set([0, 1, 2, 3]), trisToQuadsOperator)).not.toBeNull();
  });

  it("three or more faces keep the 40° limits", () => {
    const data: MeshData = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0]),
      polys: [[0, 1, 2], [0, 3, 1], [1, 4, 2]],
    };
    const em = meshFromData(data);
    // The flat pair (0, 2) may join; the folded one may not.
    const out = trisToQuadsOperator(em, new Set([0, 1, 2]));
    expect(out.size).toBe(1);
    expect(toPolygons(em).filter((p) => p.length === 3)).toHaveLength(1);
    expect(faceVerts(em, [...out][0]!).sort()).toEqual([0, 1, 2, 4]);
  });
});


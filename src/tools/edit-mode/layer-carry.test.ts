/**
 * The per-corner layers (UV, colour, normals) never come out of an operator
 * describing faces that no longer exist — compat-backlog A2.
 *
 * Every topology change goes through `rebuildPolygons`, which either carries
 * a layer (operators checked against Blender with a `-uv` parity row) or
 * drops it. Before 2026-09-25 it did neither: extruding one face of a box
 * came back with 10 faces and 6 UV faces, and no error.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { meshFromData, meshToData, type MeshData } from "../../lib/mesh";
import { forEachEdge, canonicalEdge, rebuildPolygons, type EditMesh } from "./half-edge";
import * as ops from "./operators";
import * as dissolve from "./dissolve";
import * as refine from "./refine";

/** A 3×3 sheet of quads in z = 0, every corner its own UV. */
function sheet(): MeshData {
  const positions: number[] = [];
  for (let j = 0; j <= 3; j++) for (let i = 0; i <= 3; i++) positions.push(i, j, 0);
  const polys: number[][] = [];
  for (let j = 0; j < 3; j++)
    for (let i = 0; i < 3; i++) {
      const a = j * 4 + i;
      polys.push([a, a + 1, a + 5, a + 4]);
    }
  const uvs = polys.map((p, f) => p.map((_, c) => [f / 10 + c / 100, f / 20]));
  const colors = polys.map((p, f) => p.map((_, c) => [f / 9, c / 4, 0, 1]));
  return { positions: new Float32Array(positions), polys, uvs, colors };
}

function edgesOf(em: EditMesh, pred: (a: number, b: number) => boolean): Set<number> {
  const out = new Set<number>();
  forEachEdge(em, (he) => {
    const h = em.halfEdges[he]!;
    if (pred(h.v, em.halfEdges[h.next]!.v)) out.add(canonicalEdge(em, he));
  });
  return out;
}

/** Shaped like the faces, or absent. Never stale. */
function consistent(out: Required<MeshData>): boolean {
  for (const layer of [out.uvs, out.colors, out.normals]) {
    if (layer.length === 0) continue;
    if (layer.length !== out.polys.length) return false;
    if (!layer.every((f, i) => f.length === out.polys[i]!.length)) return false;
  }
  return true;
}

// [name, operator, carries] — `carries` is true for the operators with a
// `-uv` parity row, which must keep the layer rather than drop it.
const CASES: Array<[string, (em: EditMesh) => unknown, boolean]> = [
  ["extrudeFaces", (em) => ops.extrudeFaces(em, new Set([4])), true],
  ["extrudeEdges", (em) => ops.extrudeEdges(em, edgesOf(em, (a, b) => a < 4 && b < 4)), true],
  ["insetFaces", (em) => ops.insetFaces(em, new Set([4]), 0.1), true],
  ["insetRegion", (em) => ops.insetRegion(em, new Set([4]), { thickness: 0.1 }), true],
  ["loopCut", (em) => ops.loopCut(em, [...edgesOf(em, (a, b) => (a === 1 && b === 5) || (a === 5 && b === 1))][0]!), false],
  ["deleteFaces", (em) => ops.deleteFaces(em, new Set([4])), true],
  ["deleteFacesByVertices", (em) => ops.deleteFacesByVertices(em, new Set([5])), true],
  ["mergeAtCenter", (em) => ops.mergeAtCenter(em, new Set([5, 6])), true],
  ["collapseEdges", (em) => ops.collapseEdges(em, edgesOf(em, (a, b) => a + b === 11 && Math.abs(a - b) === 1)), false],
  ["weldVerts", (em) => ops.weldVerts(em, new Map([[6, 5]])), true],
  ["reverseFaces", (em) => ops.reverseFaces(em, new Set([0, 4])), true],
  ["extrudeDiscreteFaces", (em) => ops.extrudeDiscreteFaces(em, new Set([4])), true],
  ["connectVertPair", (em) => ops.connectVertPair(em, 5, 10), true],
  ["splitEdges", (em) => ops.splitEdges(em, edgesOf(em, (a, b) => a + b === 11 && Math.abs(a - b) === 1)), true],
  ["duplicateFaces", (em) => ops.duplicateFaces(em, new Set([4])), true],
  ["splitFaces", (em) => ops.splitFaces(em, new Set([4])), true],
  ["quadsToTris", (em) => ops.quadsToTris(em, null), true],
  ["trisToQuads", (em) => { ops.quadsToTris(em, null); ops.trisToQuads(em, null, 40, 40); }, true],
  ["flipQuadTessellation", (em) => ops.flipQuadTessellation(em, new Set([4])), true],
  ["subdivideCatmullClark", (em) => ops.subdivideCatmullClark(em, 1), false],
  ["dissolveFaces", (em) => dissolve.dissolveFaces(em, new Set([0, 1, 3, 4])), true],
  ["dissolveEdges", (em) => dissolve.dissolveEdges(em, edgesOf(em, (a, b) => a + b === 11 && Math.abs(a - b) === 1)), true],
  ["dissolveVerts", (em) => dissolve.dissolveVerts(em, new Set([5])), true],
  ["connectVerts", (em) => dissolve.connectVerts(em, new Set([5, 10])), true],
  ["poke", (em) => refine.poke(em, new Set([4])), true],
  ["subdivideEdges", (em) => refine.subdivideEdges(em, edgesOf(em, (a, b) => a < 4 && b < 4), { cuts: 2 }), true],
  ["bisectEdges", (em) => refine.bisectEdges(em, edgesOf(em, (a, b) => a < 4 && b < 4), 2), true],
  ["holesFill", (em) => { ops.deleteFaces(em, new Set([4])); refine.holesFill(em); }, true],
];

describe("per-corner layers through the operators", () => {
  for (const [name, run, carries] of CASES) {
    it(`${name}: ${carries ? "carries" : "carries or drops"} the layers, never leaves them stale`, () => {
      const em = meshFromData(sheet());
      run(em);
      const out = meshToData(em);
      expect(consistent(out)).toBe(true);
      if (carries) {
        expect(out.uvs.length).toBe(out.polys.length);
        expect(out.colors.length).toBe(out.polys.length);
      }
    });
  }

  it("the default keeps faces that did not change and nothing else", () => {
    const em = meshFromData(sheet());
    const before = meshToData(em);
    rebuildPolygons(em, em.positions, before.polys.map((p) => [...p]));
    expect(meshToData(em).uvs).toEqual(before.uvs);
    rebuildPolygons(em, em.positions, [...before.polys.slice(1), [0, 1, 5]]);
    expect(meshToData(em).uvs).toEqual([]);
  });

  it("a renumbered vertex is not the same vertex (merge compacts the survivors)", () => {
    // Found by review: faces [3,4,5] and [0,1,2] plus two loose vertices;
    // merging the loose pair compacts the numbering, and the default rule
    // matched each face by number to the *other* face's corners.
    const positions = new Float32Array([0, 0, 0, 0, 1, 0, 0, 0, 1, 5, 0, 0, 5, 1, 0, 5, 0, 1, 9, 9, 9, 9, 9, 8]);
    const em = meshFromData({
      positions,
      polys: [[3, 4, 5], [0, 1, 2]],
      uvs: [[[0.5, 0], [0.5, 0.1], [0.5, 0.2]], [[0, 0], [0, 0.1], [0, 0.2]]],
    });
    ops.mergeAtCenter(em, new Set([6, 7]));
    const out = meshToData(em);
    expect(consistent(out)).toBe(true);
    out.polys.forEach((p, f) => {
      if (!out.uvs.length) return;
      const x = out.positions[p[0]! * 3]!;
      expect(out.uvs[f]![0]![0]).toBe(x === 5 ? 0.5 : 0);
    });
  });

  it("a joined face keeps, at each corner, the face whose edge leaves it", () => {
    // Found by review: a concave quad A and the triangle B filling its notch.
    // The joined triangle lies wholly inside A's vertices, but its edge 2→0
    // was B's, so BM_faces_join keeps B's corner at 2.
    const em = meshFromData({
      positions: new Float32Array([0, 0, 0, 2, 0, 0, 1, 2, 0, 1, 0.5, 0]),
      polys: [[0, 1, 2, 3], [0, 3, 2]],
      uvs: [[[0, 0], [0.1, 0], [0.2, 0], [0.3, 0]], [[0, 1], [0.3, 1], [0.2, 1]]],
    });
    dissolve.dissolveFaces(em, new Set([0, 1]));
    const out = meshToData(em);
    expect(out.polys).toHaveLength(1);
    const poly = out.polys[0]!;
    const at = (v: number) => out.uvs[0]![poly.indexOf(v)]!;
    expect(at(0)).toEqual([0, 0]);
    expect(at(1)).toEqual([0.1, 0]);
    expect(at(2)).toEqual([0.2, 1]);
  });

  it("a cut point takes its face's two corners on the edge, linearly", () => {
    const em = meshFromData(sheet());
    refine.bisectEdges(em, edgesOf(em, (a, b) => (a === 0 && b === 1) || (a === 1 && b === 0)), 1);
    const out = meshToData(em);
    const f = out.polys.findIndex((p) => p.includes(16));
    const c = out.polys[f]!.indexOf(16);
    // Face 0's corners 0 and 1 are (0, 0) and (0.01, 0).
    expect(out.uvs[f]![c]![0]).toBeCloseTo(0.005, 9);
    expect(out.uvs[f]![c]![1]).toBeCloseTo(0, 9);
  });
});

describe("topology changes go through rebuildPolygons", () => {
  it("no file outside half-edge.ts assigns em.faces or em.halfEdges", () => {
    const dir = new URL(".", import.meta.url).pathname;
    const offenders: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts") || name === "half-edge.ts") continue;
      const src = readFileSync(join(dir, name), "utf8");
      if (/\bem\.(faces|halfEdges)\s*=[^=]/.test(src)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});

describe("flipQuadTessellation", () => {
  it("turns quads only — an n-gon keeps its first corner (bmo_flip_quad_tessellation_exec)", () => {
    // Until 2026-09-25 it turned n-gons too, and BEAUTY splits an n-gon by
    // where it starts: arm's hexagon caps came out different (compat-backlog A5).
    const em = meshFromData({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 2, 1, 0, 1, 1, 0, 0, 1, 0, 3, 0, 0, 3, 1, 0]),
      polys: [[0, 1, 2, 3, 4, 5], [2, 6, 7, 3]],
    });
    ops.flipQuadTessellation(em, new Set([0, 1]));
    expect(meshToData(em).polys).toEqual([[0, 1, 2, 3, 4, 5], [6, 7, 3, 2]]);
  });
});

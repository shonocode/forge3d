/**
 * Faces shaded flat — `MeshData.sharpFaces`, Blender's `sharp_face` (compat-backlog C29a): carried like a material,
 * stopping the corner-normal fans, and set by Split / Merge Normals.
 */
import { describe, it, expect } from "vitest";
import type { MeshData } from "../../lib/mesh";
import { meshFromData, meshToData } from "../../lib/mesh";
import { rebuildPolygons, toPolygons, forEachEdge, edgeOrigin, edgeEnd } from "./half-edge";
import { currentNormals, fanNormals, mergeNormals, mixCornerNormals, smoothGroups, splitNormals } from "./normals";
import { dissolveEdges } from "./dissolve";
import { weightedNormal } from "./normal-modifiers";
import { calcEdges } from "../bmesh-lite";

/** A unit cube, outward faces: bottom (z = 0), top, then the four sides. Faces 0 and 3 flat. */
function cube(): MeshData {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]);
  const polys = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]];
  return { positions, polys, sharpFaces: polys.map((_, f) => f % 3 === 0) };
}
const close = (a: readonly number[], b: readonly number[], eps = 1e-5): boolean => a.every((x, i) => Math.abs(x - b[i]!) < eps);

describe("the corner fans and flat faces", () => {
  it("a flat face's corners are fans of one; the edit-mode groups cross it", () => {
    const m = cube();
    const fans = smoothGroups(m, { flatFaces: true });
    // Vertex 0 is on faces 0 (flat), 2 and 4: a fan of the two smooth ones and one of the flat one.
    const at0 = fans.filter((g) => g.some(([f, i]) => m.polys[f]![i] === 0)).map((g) => g.length).sort();
    expect(at0).toEqual([1, 2]);
    // `BM_normals_loops_edges_tag` reads no face flag: one group of three.
    const tools = smoothGroups(m).filter((g) => g.some(([f, i]) => m.polys[f]![i] === 0));
    expect(tools.map((g) => g.length)).toEqual([3]);
  });

  it("fanNormals: the flat face's own normal, the smooth fan's angle-weighted mean", () => {
    const m = cube();
    const n = fanNormals(m);
    expect(close(n[0]![0]!, [0, 0, -1])).toBe(true); // face 0, flat, at vertex 0
    const s = Math.SQRT1_2;
    expect(close(n[2]![0]!, [0, -1, 0])).toBe(false); // not face 2's own normal…
    expect(close(n[2]![0]!, [-s, -s, 0], 1e-4)).toBe(true); // …but faces 2 and 4 together
  });

  it("currentNormals: the fans with the flag, the face normals without it (as measured before C29a)", () => {
    const m = cube();
    expect(close(currentNormals(m)[2]![0]!, [-Math.SQRT1_2, -Math.SQRT1_2, 0], 1e-4)).toBe(true);
    const bare = { ...m, sharpFaces: undefined };
    expect(close(currentNormals(bare)[2]![0]!, [0, -1, 0])).toBe(true);
  });

  it("mixCornerNormals: 2 × the smooth fan's normal + the flat face's, at vertex 0", () => {
    const m = cube();
    const v0 = mixCornerNormals(m, fanNormals(m))[0]!;
    const want = [-Math.SQRT2, -Math.SQRT2, -1].map((x) => x / Math.sqrt(5));
    expect(close(v0, want, 1e-4)).toBe(true);
  });
});

describe("Split and Merge Normals set the faces' flag", () => {
  it("split makes every face flat, merge every face smooth", () => {
    expect(splitNormals(cube()).sharpFaces).toEqual([true, true, true, true, true, true]);
    expect(mergeNormals(cube()).sharpFaces).toEqual([false, false, false, false, false, false]);
  });

  it("merge averages across the flat faces it is about to make smooth", () => {
    const out = mergeNormals(cube());
    const atV0 = out.polys.flatMap((p, f) => p.flatMap((v, i) => (v === 0 ? [out.normals![f]![i]!] : [])));
    expect(atV0).toHaveLength(3);
    for (const n of atV0) expect(close(n, atV0[0]!)).toBe(true);
  });

  it("split without the flag still writes it — Blender shades the selected faces flat", () => {
    expect(splitNormals({ ...cube(), sharpFaces: undefined }).sharpFaces).toEqual([true, true, true, true, true, true]);
  });
});

describe("carried like a material", () => {
  it("meshFromData / meshToData round-trip it, and a mesh without it stays without", () => {
    expect(meshToData(meshFromData(cube())).sharpFaces).toEqual(cube().sharpFaces);
    expect(meshToData(meshFromData({ ...cube(), sharpFaces: undefined })).sharpFaces).toBeUndefined();
  });

  it("a face made with no source face is flat — a new BMFace has no BM_ELEM_SMOOTH", () => {
    const m = cube();
    m.sharpFaces = m.polys.map(() => false);
    const em = meshFromData(m);
    const polys = toPolygons(em);
    rebuildPolygons(em, em.positions, [...polys, [0, 2, 6]], {
      faces: [...polys.map(() => undefined), { corners: [[], [], []], material: -1 }],
    });
    expect(em.faceSharp).toEqual([false, false, false, false, false, false, true]);
  });
});

describe("dissolveEdges keeps the face Blender's join keeps", () => {
  /** Two quads side by side, face 0 flat and slot 0, face 1 smooth and slot 1. */
  const pair = (): MeshData => ({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 1, 0, 1, 1, 0, 2, 1, 0]),
    polys: [[0, 1, 4, 3], [1, 2, 5, 4]],
    materials: [0, 1],
    sharpFaces: [true, false],
  });

  it("the joined face copies the face whose loop was added to the edge last — the higher-numbered one", () => {
    const em = meshFromData(pair());
    const middle = new Set<number>();
    forEachEdge(em, (he) => {
      const [a, b] = [edgeOrigin(em, he), edgeEnd(em, he)].sort((x, y) => x - y);
      if (a === 1 && b === 4) middle.add(he);
    });
    dissolveEdges(em, middle);
    const out = meshToData(em);
    expect(out.polys).toHaveLength(1);
    expect(out.sharpFaces).toEqual([false]);
    expect(out.materials).toEqual([1]);
  });

  it("a joined face is the newest: it outranks a higher-numbered face it meets next", () => {
    // Face 0 in the middle, 1 on the left, 2 on the right. The first edge in Blender's order joins 0 with one side and
    // copies that side (the higher number); the joined face is then newer than the other side, so it keeps that copy —
    // where the higher-number rule alone would give face 2 whichever edge came first.
    const m: MeshData = {
      positions: new Float32Array([1, 0, 0, 2, 0, 0, 2, 1, 0, 1, 1, 0, 0, 0, 0, 0, 1, 0, 3, 0, 0, 3, 1, 0]),
      polys: [[0, 1, 2, 3], [4, 0, 3, 5], [1, 6, 7, 2]],
      materials: [10, 11, 12],
      sharpFaces: [false, true, false],
    };
    const order = calcEdges(m.polys, 1).map(([a, b]) => `${a}_${b}`);
    const first = order.indexOf("0_3") < order.indexOf("1_2") ? 1 : 2;
    const em = meshFromData(m);
    const middle = new Set<number>();
    forEachEdge(em, (he) => {
      const [a, b] = [edgeOrigin(em, he), edgeEnd(em, he)].sort((x, y) => x - y);
      if ((a === 0 && b === 3) || (a === 1 && b === 2)) middle.add(he);
    });
    dissolveEdges(em, middle);
    const out = meshToData(em);
    expect(out.polys).toHaveLength(1);
    expect(out.materials).toEqual([m.materials![first]]);
    expect(out.sharpFaces).toEqual([m.sharpFaces![first]]);
  });
});

describe("Weighted Normal's untouched corners", () => {
  it("one item per vertex: a vertex outside the group keeps the mix of its corner normals (`custom_set_from_verts`)", () => {
    const m = cube();
    m.groups = new Map([["g", new Map([1, 2, 3, 4, 5, 6, 7].map((v) => [v, 1] as [number, number]))]]);
    const out = weightedNormal(m, { vertexGroup: "g" });
    const want = mixCornerNormals(m, fanNormals(m))[0]!;
    out.polys.forEach((p, f) => p.forEach((v, i) => v === 0 && expect(close(out.normals![f]![i]!, want, 1e-4)).toBe(true)));
  });
});

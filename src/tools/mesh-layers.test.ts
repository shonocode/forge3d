/**
 * Every layer a `MeshData` carries, through every public operator —
 * compat-backlog A3.
 *
 * Before 2026-09-25 most operators kept creases and seams and silently lost
 * the rest: a probe of 42 paths found vertex groups surviving two of them.
 * The table below is the contract: the operators in `CARRY` hand every layer
 * back; the ones in `DROPS` build new geometry whose layers need Blender's
 * interpolation, which is not ported (compat-backlog A6 / A7), and they drop
 * those layers **whole** — never a layer shaped for other faces.
 */
import { describe, it, expect } from "vitest";
import * as L from "../lib/index";
import { rebuildPolygons } from "./edit-mode/half-edge";
import type { MeshData } from "../lib/mesh";


function cube(): MeshData {
  const positions = new Float32Array([
    -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
    -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
  ]);
  const polys = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [0, 4, 7, 3]];
  return {
    positions,
    polys,
    creases: new Map([["0_1", 0.5]]),
    seams: new Set(["0_1"]),
    sharp: new Set(["0_1"]),
    edges: [[0, 6]],
    uvs: polys.map((p, f) => p.map((_, c) => [f / 10, c / 10])),
    colors: polys.map((p, f) => p.map((_, c) => [f / 6, c / 4, 0, 1])),
    normals: polys.map((p) => p.map(() => [0, 0, 1])),
    groups: new Map([["g", new Map([[0, 0.5], [6, 1]])]]),
    materials: polys.map((_, f) => f % 2),
  };
}

type Layer = "uvs" | "colors" | "normals" | "groups" | "materials" | "creases" | "seams" | "sharp" | "edges";
const ALL: Layer[] = ["uvs", "colors", "normals", "groups", "materials", "creases", "seams", "sharp", "edges"];

/** Present and shaped for these faces, absent, or (the failure) stale. */
function state(out: MeshData, k: Layer): "ok" | "absent" | "stale" {
  const F = out.polys.length;
  if (k === "uvs" || k === "colors" || k === "normals") {
    const l = out[k];
    if (!l || l.length === 0) return "absent";
    return l.length === F && l.every((f, i) => f.length === out.polys[i]!.length) ? "ok" : "stale";
  }
  if (k === "materials") {
    const m = out.materials;
    if (!m || m.length === 0) return "absent";
    return m.length === F ? "ok" : "stale";
  }
  if (k === "groups") {
    const g = out.groups;
    if (!g || g.size === 0) return "absent";
    const n = out.positions.length / 3;
    for (const grp of g.values()) for (const v of grp.keys()) if (v >= n) return "stale";
    return [...g.values()].some((grp) => grp.size > 0) ? "ok" : "absent";
  }
  if (k === "edges") {
    const e = out.edges;
    if (!e || e.length === 0) return "absent";
    const n = out.positions.length / 3;
    return e.every((x) => x.every((v) => v < n)) ? "ok" : "stale";
  }
  const set = out[k];
  if (!set || set.size === 0) return "absent";
  const n = out.positions.length / 3;
  for (const key of set.keys()) for (const v of String(key).split("_")) if (Number(v) >= n) return "stale";
  return "ok";
}

// Every layer comes back.
const CARRY: Array<[string, () => MeshData, Layer[]?]> = [
  ["mergeMeshes", () => L.mergeMeshes([cube(), cube()])],
  ["transformMesh", () => L.transformMesh(cube(), { translate: [1, 0, 0], rotate: [0.3, 0, 0] })],
  ["transformMesh (mirror)", () => L.transformMesh(cube(), { scale: [-1, 1, 1] })],
  ["mirrorMesh", () => L.mirrorMesh(cube(), "x")],
  ["arrayMesh", () => L.arrayMesh(cube(), 2, [2, 0, 0])],
  ["radialArray", () => L.radialArray(cube(), { count: 3 } as never)],
  ["weldMesh", () => L.weldMesh(cube())],
  ["maskMesh", () => L.maskMesh(cube(), new Set([0, 1, 2, 3])), ALL.filter((k) => k !== "edges")],
  ["removeDoubles", () => L.removeDoubles(cube(), 1e-4)],
  ["mergeByDistance", () => L.mergeByDistance(cube(), 1e-4)],
  ["reorderSpatial", () => L.reorderSpatial(cube())],
  ["build", () => L.build(cube(), { frame: 200 } as never)],
  ["displace", () => L.displace(cube(), { strength: 0.1 } as never)],
  ["offsetAlongNormals", () => L.offsetAlongNormals(cube(), 0.1)],
  ["cast", () => L.cast(cube())],
  ["simpleDeform", () => L.simpleDeform(cube(), { mode: "twist", angle: 0.5 } as never)],
  ["wave", () => L.wave(cube())],
  ["warp", () => L.warp(cube(), { radius: 1, from: {}, to: { at: [0.1, 0, 0] } })],
  ["recalcFaceNormals", () => L.recalcFaceNormals(cube())],
  ["connectVertsConcave", () => L.connectVertsConcave(cube())],
  ["triangulate", () => L.triangulate(cube(), { quadMethod: "fixed" })],
  ["triangulate (beauty)", () => L.triangulate(cube())],
  ["deleteLoose", () => L.deleteLoose(cube())],
  ["compactMesh", () => L.compactMesh(cube(), new Set([0, 1, 2, 3, 4, 5, 6, 7]))],
  ["uvWarp", () => L.uvWarp(cube())],
  ["shrinkwrap", () => L.shrinkwrap(cube(), { target: cube() } as never)],
  ["smoothMesh", () => L.smoothMesh(cube())],
  ["laplacianSmooth", () => L.laplacianSmooth(cube())],
  ["planarFaces", () => L.planarFaces(cube(), [0])],
  ["smoothLaplacianVert", () => L.smoothLaplacianVert(cube())],
  ["setSharpnessByAngle", () => L.setSharpnessByAngle(cube())],
  ["weightedNormal", () => L.weightedNormal(cube())],
  ["normalEdit", () => L.normalEdit(cube())],
  ["meshFromData / meshToData", () => L.meshToData(L.meshFromData(cube()))],
];

// New geometry whose layers need interpolation that is not ported: these
// may drop a layer, whole. (Which ones they keep is listed so a change shows.)
const DROPS: Array<[string, () => MeshData, Layer[]]> = [
  ["solidify", () => L.solidify(cube(), { thickness: 0.1 }), ["uvs", "creases", "seams"]],
  ["wireframe", () => L.wireframe(cube(), { thickness: 0.05 }), []],
  ["symmetrize", () => L.symmetrize(cube(), { direction: "-X" }), ["creases", "seams"]],
  ["convexHull", () => L.convexHull(cube()), []],
  ["bisectPlane", () => L.bisectPlane(cube(), { planeCo: [0, 0, 0], planeNo: [1, 0, 0] } as never), ["creases", "seams"]],
  ["decimateCollapse", () => L.decimateCollapse(cube(), { ratio: 0.5 }), []],
  ["remesh", () => L.remesh(cube(), { mode: "blocks" } as never), []],
  ["unsubdivide", () => L.unsubdivide(cube()), ["edges"]],
  [
    "booleanMesh",
    () =>
      L.booleanMesh(L.mergeMeshes([cube(), L.transformMesh(cube(), { translate: [0.5, 0.5, 0.5] })]), {
        operation: "union",
        parts: [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1],
      } as never),
    [],
  ],
  ["bevelMesh", () => L.bevelMesh(cube(), { offset: 0.1 } as never).mesh, ["materials", "edges"]],
];

describe("MeshData layers through the operators", () => {
  for (const [name, run, expected = ALL] of CARRY) {
    it(`${name} carries ${expected.length === ALL.length ? "every layer" : expected.join(", ")}`, () => {
      const out = run();
      for (const k of ALL) {
        const s = state(out, k);
        expect(s, `${name}: ${k}`).not.toBe("stale");
        if (expected.includes(k)) expect(s, `${name}: ${k}`).toBe("ok");
      }
    });
  }
  for (const [name, run, keeps] of DROPS) {
    it(`${name} keeps ${keeps.join(", ") || "no layer"} and drops the rest whole`, () => {
      const out = run();
      for (const k of ALL) {
        const s = state(out, k);
        expect(s, `${name}: ${k}`).not.toBe("stale");
        if (keeps.includes(k)) expect(s, `${name}: ${k}`).toBe("ok");
      }
    });
  }
});

describe("the values follow their vertex or face", () => {
  const weightAt = (out: MeshData, x: number, y: number, z: number): number | undefined => {
    const P = out.positions;
    for (let v = 0; v < P.length / 3; v++)
      if (Math.abs(P[v * 3]! - x) < 1e-6 && Math.abs(P[v * 3 + 1]! - y) < 1e-6 && Math.abs(P[v * 3 + 2]! - z) < 1e-6)
        return out.groups?.get("g")?.get(v);
    return undefined;
  };

  it("mergeMeshes offsets the second part's group members", () => {
    const out = L.mergeMeshes([cube(), cube()]);
    expect([...out.groups!.get("g")!]).toEqual([[0, 0.5], [6, 1], [8, 0.5], [14, 1]]);
    expect(out.materials).toEqual([0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1]);
  });

  it("mergeMeshes takes meshToData's output, whose absent layers are []", () => {
    // Found by review: `[]` is truthy, and the part was read as having a
    // UV / colour / normal layer with no faces in it — a TypeError.
    const plain = L.meshToData(L.meshFromData({ positions: cube().positions, polys: cube().polys }));
    const out = L.mergeMeshes([plain, cube()]);
    expect(out.uvs).toHaveLength(12);
    expect(out.uvs![0]).toEqual([[0, 0], [0, 0], [0, 0], [0, 0]]);
    expect(out.normals).toBeUndefined();
    expect(() => L.mirrorMesh(plain, "x")).not.toThrow();
  });

  it("transformMesh with a zero scale drops the custom normals instead of NaN", () => {
    const out = L.transformMesh(cube(), { scale: [1, 0, 1] });
    expect(out.normals).toBeUndefined();
  });

  it("reorderSpatial moves each weight with its vertex", () => {
    const out = L.reorderSpatial(cube());
    expect(weightAt(out, -0.5, -0.5, -0.5)).toBe(0.5);
    expect(weightAt(out, 0.5, 0.5, 0.5)).toBe(1);
  });

  it("mergeByDistance (the Weld modifier) mixes the merged vertices' weights", () => {
    // Vertex 1 sits on vertex 0: the survivor is at the mean of 0.5 and
    // (not a member) 0 — do_mix_data.
    const c = cube();
    c.positions[3] = -0.5;
    const out = L.mergeByDistance(c, 1e-4);
    expect(weightAt(out, -0.5, -0.5, -0.5)).toBeCloseTo(0.25, 9);
  });

  it("removeDoubles keeps the survivor's own weights", () => {
    const c = cube();
    c.positions[3] = -0.5;
    const out = L.removeDoubles(c, 1e-4);
    expect(weightAt(out, -0.5, -0.5, -0.5)).toBe(0.5);
  });

  it("a subdivided edge's new vertex mixes its ends' weights (BM_edge_split)", () => {
    const em = L.meshFromData(cube());
    const edges = new Set<number>();
    L.forEachEdge(em, (he) => {
      const a = L.edgeOrigin(em, he);
      const b = L.edgeEnd(em, he);
      if ((a === 0 && b === 3) || (a === 3 && b === 0)) edges.add(he);
    });
    L.subdivideEdges(em, edges, { cuts: 1 });
    const out = L.meshToData(em);
    expect(weightAt(out, -0.5, 0, -0.5)).toBeCloseTo(0.25, 9);
    expect(out.materials).toHaveLength(out.polys.length);
  });

  it("a rebuild with no known origin for a new vertex drops the groups whole", () => {
    const em = L.meshFromData(cube());
    const polys = L.toPolygons(em);
    // Fan face 0 round a new centre that nothing says where it came from.
    const P = Float32Array.from([...em.positions, 0, -0.5, 0]);
    const c = P.length / 3 - 1;
    const f0 = polys[0]!;
    const fan = f0.map((v, i) => [v, f0[(i + 1) % f0.length]!, c]);
    rebuildPolygons(em, P, [...polys.slice(1), ...fan]);
    const out = L.meshToData(em);
    expect(out.groups.size).toBe(0);
    expect(out.materials).toEqual([]);
  });

  it("subdivideCatmullClark carries them: linear groups, the parent's slot", () => {
    const em = L.meshFromData(cube());
    L.subdivideCatmullClark(em, 1);
    const out = L.meshToData(em);
    expect(out.materials).toHaveLength(out.polys.length);
    expect(out.groups.size).toBeGreaterThan(0);
  });
});

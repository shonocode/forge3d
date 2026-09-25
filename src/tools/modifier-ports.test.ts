import { describe, it, expect } from "vitest";
import type { MeshData } from "../lib/mesh";
import { smoothMesh } from "./smooth-mesh";
import { offsetAlongNormals, textureDisplace } from "./displace";
import { mergeByDistance, removeDoubles } from "./remove-doubles";
import { transferEdgeData, transferLoopData, transferWeights } from "./data-transfer";
import { arrayMesh } from "./mesh-ops";
import { createVert } from "./edit-mode/wire";
import { beautifyFill } from "./beautify-fill";
import { wave } from "./deform";
import { shrinkwrap } from "./edit-mode/shrinkwrap";

/**
 * The five modifiers the map counted as "had" until 2026-09-25, when their
 * parity rows were first made (`array-mod`, `displace-mod`, `weld-mod`,
 * `smooth-mod`, `data-transfer`) and three of them turned out to be a
 * different operation from the one the map named. Each test pins the property
 * that tells the port from the operator it was confused with.
 */

const xs = (m: MeshData): number[] => {
  const out: number[] = [];
  for (let i = 0; i < m.positions.length; i += 3) out.push(Math.round(m.positions[i]! * 1e6) / 1e6);
  return out;
};

describe("smoothMesh (the Smooth modifier)", () => {
  it("pulls toward the mean of edge midpoints, and moves the ends too", () => {
    // A chain 0 — 1 — 3 on loose edges, one pass at factor 1. The end vertex
    // goes to its one midpoint (0.5); `smoothVert` would pin it. The middle
    // goes to the mean of 0.5 and 2 — not of its neighbours 0 and 3.
    const chain: MeshData = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 3, 0, 0]),
      polys: [],
      edges: [[0, 1], [1, 2]],
    };
    expect(xs(smoothMesh(chain, { factor: 1 }))).toEqual([0.5, 1.25, 2]);
  });
});

describe("offsetAlongNormals (the Displace modifier, no texture)", () => {
  it("weights each face by the corner angle, not by its area", () => {
    // A 2×2 floor (+Y) and a 2×0.2 wall (+Z) meet along an edge at a right
    // angle. At the shared corner both corner angles are 90°, so the normal
    // is at 45° — an area weighting would lean it ten times toward the floor.
    const corner: MeshData = {
      positions: new Float32Array([0, 0, 0, 2, 0, 0, 2, 0, 2, 0, 0, 2, 2, 0.2, 0, 0, 0.2, 0]),
      polys: [
        [0, 3, 2, 1],
        [0, 1, 4, 5],
      ],
    };
    const out = offsetAlongNormals(corner, 0.1);
    expect(out.positions[0]).toBeCloseTo(0, 6);
    expect(out.positions[1]).toBeCloseTo(0.1 / Math.SQRT2, 5);
    expect(out.positions[2]).toBeCloseTo(0.1 / Math.SQRT2, 5);
  });
});

describe("mergeByDistance (the Weld modifier)", () => {
  it("clusters in index order and moves the survivor to the mean", () => {
    // Vertex 0 sits between the others and claims both at 0.05. The survivor
    // is vertex 0, at the mean of all three.
    const line: MeshData = { positions: new Float32Array([0.04, 0, 0, 0, 0, 0, 0.08, 0, 0]), polys: [] };
    expect(xs(mergeByDistance(line, 0.05))).toEqual([0.04]);
    // Reordered so the end comes first: it claims only its neighbour, and the
    // far end stays. `removeDoubles` keeps a vertex where it was instead.
    const ends: MeshData = { positions: new Float32Array([0, 0, 0, 0.04, 0, 0, 0.08, 0, 0]), polys: [] };
    expect(xs(mergeByDistance(ends, 0.05))).toEqual([0.02, 0.08]);
    expect(xs(removeDoubles(ends, 0.05))).not.toEqual([0.02, 0.08]);
  });
});

describe("transferWeights (the Data Transfer modifier, nearest vertex)", () => {
  it("carries weight and membership from the nearest source vertex", () => {
    const source: MeshData = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0]),
      polys: [],
      groups: new Map([["A", new Map([[0, 0.3]])]]),
    };
    // Target vertex 0 is nearest source 1 (not in A), vertex 1 nearest source 0.
    const target: MeshData = { positions: new Float32Array([0.9, 0, 0, 0.1, 0, 0]), polys: [] };
    const out = transferWeights(target, source);
    expect([...out.groups!.get("A")!]).toEqual([[1, 0.3]]);
  });
});

describe("arrayMesh merge (the Array modifier)", () => {
  it("welds each copy onto the previous one within the distance, the survivor staying put", () => {
    const bar: MeshData = { positions: new Float32Array([0, 0, 0, 1, 0, 0]), polys: [] };
    // Copies end to end: the copy's first vertex sits on the original's last.
    const out = arrayMesh(bar, 3, [0, 0, 0], { relative: [1, 0, 0], merge: 0.01 });
    expect(xs(out)).toEqual([0, 1, 2, 3]);
  });
});

describe("createVert (bmesh.ops.create_vert)", () => {
  it("adds one loose vertex at the end", () => {
    const out = createVert({ positions: new Float32Array([0, 0, 0]), polys: [] }, [1, 2, 3]);
    expect([...out.positions]).toEqual([0, 0, 0, 1, 2, 3]);
    expect(out.polys).toEqual([]);
  });
});

describe("beautifyFill (bmesh.ops.beautify_fill)", () => {
  it("area turns a long diagonal into the short one; angle only cares about the fold", () => {
    // A flat thin kite split along its long axis 0–2. By area over perimeter
    // the pair sharing 1–3 is better; by angle both are flat, so no gain.
    const kite: MeshData = {
      positions: new Float32Array([0, 0, 0, 1, -0.2, 0, 2, 0, 0, 1, 0.2, 0]),
      polys: [
        [0, 1, 2],
        [0, 2, 3],
      ],
    };
    const shared = (m: MeshData): number[] => m.polys[0]!.filter((v) => m.polys[1]!.includes(v)).sort();
    expect(shared(beautifyFill(kite, { method: "area" }))).toEqual([1, 3]);
    expect(shared(beautifyFill(kite, { method: "angle" }))).toEqual([0, 2]);
  });
});

describe("wave normal (the Wave modifier's use_normal)", () => {
  it("moves along the vertex normal, and only on the chosen axes", () => {
    // A flat sheet facing +z: along the normal is along z, and with only the
    // normal's x on nothing moves.
    const sheet: MeshData = {
      positions: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
      polys: [[0, 1, 2, 3]],
    };
    const opts = { height: 0.5, width: 3, narrowness: 0.5 };
    expect([...wave(sheet, { ...opts, normal: true }).positions]).toEqual([...wave(sheet, opts).positions]);
    expect([...wave(sheet, { ...opts, normal: { x: true } }).positions]).toEqual([...sheet.positions]);
  });
});

describe("shrinkwrap targetProject", () => {
  it("lands where the target's interpolated normal passes through the vertex", () => {
    // Above a box's top face off-centre: the blended corner normals lean
    // outward, so the foot is pulled toward the centre relative to the plain
    // nearest point (0.3, 0.2, 0.5), and stays on the face.
    const box: MeshData = {
      positions: new Float32Array([
        -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
        -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
      ]),
      polys: [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]],
    };
    const point: MeshData = { positions: new Float32Array([0.3, 0.2, 0.9]), polys: [] };
    const out = shrinkwrap(point, { target: box, method: "targetProject" });
    expect(out.positions[2]).toBeCloseTo(0.5, 5);
    expect(out.positions[0]!).toBeLessThan(0.3 - 1e-3);
    expect(out.positions[1]!).toBeLessThan(0.2 - 1e-3);
  });
});

describe("arrayMesh relative offset (the Array modifier)", () => {
  it("adds the mesh's own size times the factor to the constant offset", () => {
    const bar: MeshData = { positions: new Float32Array([0, 0, 0, 2, 0, 0]), polys: [] };
    // Constant 0.5 plus relative 1 × width 2: the copy starts at 2.5.
    expect(xs(arrayMesh(bar, 2, [0.5, 0, 0], { relative: [1, 0, 0] }))).toEqual([0, 2, 2.5, 4.5]);
  });
});

describe("arrayMesh object offset, fit length, UV offset", () => {
  const point: MeshData = { positions: new Float32Array([1, 0, 0]), polys: [], edges: [] };
  const round = (m: MeshData): number[] => Array.from(m.positions, (x) => Math.round(x * 1e5) / 1e5 + 0);

  it("multiplies the object's transform in, so a quarter turn makes a ring", () => {
    const ring = arrayMesh(point, 4, [0, 0, 0], { objectOffset: { rotate: [0, 0, Math.PI / 2] } });
    expect(round(ring)).toEqual([1, 0, 0, 0, 1, 0, -1, 0, 0, 0, -1, 0]);
  });

  it("fits as many copies as the length allows, whatever count says", () => {
    const bar: MeshData = { positions: new Float32Array([0, 0, 0, 1, 0, 0]), polys: [], edges: [[0, 1]] };
    // ⌊(5 + 1e-6) / 2 + 1⌋ = 3 copies at a step of 2.
    expect(arrayMesh(bar, 10, [2, 0, 0], { fitLength: 5 }).positions.length / 3).toBe(6);
  });

  it("moves copy c's UVs by c times the UV offset", () => {
    const quad: MeshData = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
      polys: [[0, 1, 2, 3]],
      uvs: [[[0, 0], [0.1, 0], [0.1, 0.1], [0, 0.1]]],
    };
    const out = arrayMesh(quad, 2, [2, 0, 0], { uvOffset: [0.5, 0.25] });
    expect(out.uvs![1]![0]).toEqual([0.5, 0.25]);
    expect(out.uvs![0]![0]).toEqual([0, 0]);
  });
});

describe("mergeByDistance connected (the Weld modifier, CONNECTED)", () => {
  it("merges only ends of an edge, not vertices that are merely close", () => {
    // Two separate edges whose near ends are 0.01 apart, and one short edge.
    const m: MeshData = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 1.01, 0, 0, 2, 0, 0, 3, 0, 0, 3.005, 0, 0]),
      polys: [],
      edges: [[0, 1], [2, 3], [4, 5]],
    };
    expect(mergeByDistance(m, 0.02).positions.length / 3).toBe(4);
    expect(mergeByDistance(m, 0.02, { mode: "connected" }).positions.length / 3).toBe(5);
  });
});

describe("transferEdgeData (Data Transfer, edge data)", () => {
  it("carries sharp and crease by topology, and clears what the source does not have", () => {
    const quad = (sharp: string[], creases: [string, number][]): MeshData => ({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
      polys: [[0, 1, 2, 3]],
      sharp: new Set(sharp),
      creases: new Map(creases),
    });
    const out = transferEdgeData(quad(["2_3"], [["0_3", 1]]), quad(["0_1"], [["1_2", 0.5]]), { mapping: "topology" });
    expect([...out.sharp!]).toEqual(["0_1"]);
    expect([...out.creases!]).toEqual([["1_2", 0.5]]);
  });
});

describe("transferLoopData (Data Transfer, face corner data)", () => {
  // Two unit quads side by side, face 0 at x ∈ [0, 1] and face 1 at [1, 2].
  const strip = (seams: string[]): MeshData => ({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 1, 0, 1, 1, 0, 2, 1, 0]),
    polys: [
      [0, 1, 4, 3],
      [1, 2, 5, 4],
    ],
    seams: new Set(seams),
    uvs: [
      [[0, 0], [0.01, 0], [0.02, 0], [0.03, 0]],
      [[0.5, 0.5], [0.51, 0.5], [0.52, 0.5], [0.53, 0.5]],
    ],
  });
  // A target quad over most of face 1, its left side reaching into face 0.
  const target: MeshData = {
    positions: new Float32Array([0.9, 0, 0.01, 2, 0, 0.01, 2, 1, 0.01, 0.9, 1, 0.01]),
    polys: [[0, 1, 2, 3]],
  };

  it("copies by corner index under topology", () => {
    const out = transferLoopData(strip([]), strip([]), { mapping: "topology" });
    expect(out.uvs).toEqual(strip([]).uvs);
  });

  it("keeps one face on one side of a seam", () => {
    // Without a seam the left corners find face 0; with the shared edge a
    // seam, the face's best island is face 1's and every corner reads it.
    const joined = transferLoopData(target, strip([]), { mapping: "faceNearest", layers: ["uvs"] });
    const cut = transferLoopData(target, strip(["1_4"]), { mapping: "faceNearest", layers: ["uvs"] });
    expect(joined.uvs![0]![0]).toEqual([0.01, 0]);
    expect(cut.uvs![0]![0]).toEqual([0.5, 0.5]);
    expect(cut.uvs![0]![1]).toEqual([0.51, 0.5]);
  });
});

describe("textureDisplace (the Displace modifier with a texture)", () => {
  const points: MeshData = { positions: new Float32Array([0.4, 0, 0, -0.6, 0, 0]), polys: [], edges: [] };

  it("moves (value − mid level) · strength; a linear Blend reads (1 + x) / 2", () => {
    const out = textureDisplace(points, { texture: { type: "BLEND" }, direction: "z", strength: 2 });
    expect(out.positions[2]).toBeCloseTo(0.4, 6);
    expect(out.positions[5]).toBeCloseTo(-0.6, 6);
  });

  it("reads white with no texture", () => {
    const out = textureDisplace(points, { direction: "y", midLevel: 0.25 });
    expect(out.positions[1]).toBeCloseTo(0.75, 6);
  });
});

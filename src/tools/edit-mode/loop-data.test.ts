import { describe, it, expect } from "vitest";
import {
  reverseLoopData,
  rotateLoopData,
  collapseLoopData,
  pointmergeLoopData,
  averageVertLoopData,
  faceAttributeFill,
} from "./loop-data";
import { meshFromData, meshToData } from "../../lib/mesh";
import type { MeshData } from "../../lib/mesh";

/**
 * The two quads the Blender probe used, sharing edge 1-2, with each corner's
 * u naming it: face index plus corner index over ten.
 *
 *   3---2---5
 *   |   |   |
 *   0---1---4
 */
function twoQuads(): MeshData {
  return {
    positions: new Float32Array([
      0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 2, 0, 0, 2, 1, 0,
    ]),
    polys: [
      [0, 1, 2, 3],
      [1, 4, 5, 2],
    ],
    uvs: [
      [[0.0, 0], [0.1, 0], [0.2, 0], [0.3, 0]],
      [[1.0, 0], [1.1, 0], [1.2, 0], [1.3, 0]],
    ],
    colors: [
      [[0.0, 0, 0, 1], [0.1, 0, 0, 1], [0.2, 0, 0, 1], [0.3, 0, 0, 1]],
      [[1.0, 0, 0, 1], [1.1, 0, 0, 1], [1.2, 0, 0, 1], [1.3, 0, 0, 1]],
    ],
  };
}

/** The u of each corner, rounded, so a row reads like the probe's output. */
const us = (m: MeshData, f: number): number[] =>
  m.uvs![f]!.map((c) => Math.round(c[0]! * 10) / 10);

const reds = (m: MeshData, f: number): number[] =>
  m.colors![f]!.map((c) => Math.round(c[0]! * 10) / 10);

describe("reverseLoopData", () => {
  // Every expectation is a Blender 5.1.1 result from
  // tools/modeling/parity/probe-loop.py and probe-loop2.py.

  it("reverses the chosen face's corners", () => {
    // Blender: 0.0 0.1 0.2 0.3 -> 0.3 0.2 0.1 0.0.
    const out = reverseLoopData(twoQuads(), [0]);
    expect(us(out, 0)).toEqual([0.3, 0.2, 0.1, 0]);
  });

  it("leaves the faces it was not given alone", () => {
    const out = reverseLoopData(twoQuads(), [0]);
    expect(us(out, 1)).toEqual([1, 1.1, 1.2, 1.3]);
  });

  it("works on the colour layer and leaves the UVs alone", () => {
    // Measured: `reverse_colors` on face 0 reverses the colours and the UV
    // layer comes back untouched. The two layers are independent.
    const out = reverseLoopData(twoQuads(), [0], "color");
    expect(reds(out, 0)).toEqual([0.3, 0.2, 0.1, 0]);
    expect(us(out, 0)).toEqual([0, 0.1, 0.2, 0.3]);
  });

  it("does not modify its input", () => {
    const before = twoQuads();
    reverseLoopData(before, [0]);
    expect(us(before, 0)).toEqual([0, 0.1, 0.2, 0.3]);
  });
});

describe("rotateLoopData", () => {
  it("moves each corner's data to the next one by default", () => {
    // Blender, use_ccw=False: 0.0 0.1 0.2 0.3 -> 0.3 0.0 0.1 0.2.
    expect(us(rotateLoopData(twoQuads(), [0]), 0)).toEqual([0.3, 0, 0.1, 0.2]);
  });

  it("moves it the other way with ccw", () => {
    // Blender, use_ccw=True: -> 0.1 0.2 0.3 0.0.
    expect(us(rotateLoopData(twoQuads(), [0], { ccw: true }), 0)).toEqual([
      0.1, 0.2, 0.3, 0,
    ]);
  });

  it("does the same on a triangle", () => {
    // Four corners could hide a symmetry; three cannot. Blender: 0.0 0.1 0.2
    // goes to 0.2 0.0 0.1 and to 0.1 0.2 0.0.
    const tri: MeshData = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      polys: [[0, 1, 2]],
      uvs: [[[0.0, 0], [0.1, 0], [0.2, 0]]],
    };
    expect(us(rotateLoopData(tri, [0]), 0)).toEqual([0.2, 0, 0.1]);
    expect(us(rotateLoopData(tri, [0], { ccw: true }), 0)).toEqual([0.1, 0.2, 0]);
  });

  it("matches on the colour layer", () => {
    // Measured: `rotate_colors` gives the same permutation as `rotate_uvs`.
    expect(reds(rotateLoopData(twoQuads(), [0], { layer: "color" }), 0)).toEqual([
      0.3, 0, 0.1, 0.2,
    ]);
  });

  it("four rotations come back to where they started", () => {
    let m = twoQuads();
    for (let i = 0; i < 4; i++) m = rotateLoopData(m, [0]);
    expect(us(m, 0)).toEqual([0, 0.1, 0.2, 0.3]);
  });
});

describe("the layer has to describe the mesh it is on", () => {
  it("refuses a mesh with no such layer", () => {
    const bare: MeshData = { ...twoQuads(), uvs: undefined };
    expect(() => reverseLoopData(bare, [0])).toThrow(/no uv layer/);
  });

  it("refuses a layer with the wrong number of faces", () => {
    const m = twoQuads();
    m.uvs = [m.uvs![0]!];
    expect(() => reverseLoopData(m, [0])).toThrow(/1 entries for 2 polygons/);
  });

  it("refuses a face whose corner count disagrees", () => {
    const m = twoQuads();
    m.uvs![1] = [[0, 0], [1, 0]];
    expect(() => rotateLoopData(m, [1])).toThrow(/4 corners but its uv entry has 2/);
  });
});

describe("loop layers through the rest of the library", () => {
  it("survive a meshFromData / meshToData round trip", () => {
    const back = meshToData(meshFromData(twoQuads()));
    expect(back.uvs).toHaveLength(2);
    expect(back.uvs[0]![1]).toEqual([0.1, 0]);
    expect(back.colors[1]![3]).toEqual([1.3, 0, 0, 1]);
  });

  it("come back empty for a mesh that never had any", () => {
    const bare: MeshData = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      polys: [[0, 1, 2]],
    };
    expect(meshToData(meshFromData(bare)).uvs).toEqual([]);
  });
});

/**
 * The 2×2 block of quads the probe used, whose centre vertex 4 belongs to all
 * four faces. Corner `i` of face `f` carries `f + i/10`.
 *
 *   6---7---8
 *   | 2 | 3 |
 *   3---4---5
 *   | 0 | 1 |
 *   0---1---2
 */
function grid2x2(): MeshData {
  const positions: number[] = [];
  for (const y of [0, 1, 2]) for (const x of [0, 1, 2]) positions.push(x, y, 0);
  const polys = [
    [0, 1, 4, 3],
    [1, 2, 5, 4],
    [3, 4, 7, 6],
    [4, 5, 8, 7],
  ];
  return {
    positions: new Float32Array(positions),
    polys,
    uvs: polys.map((p, f) => p.map((_, i) => [f + i / 10, 0])),
  };
}

/** The u at the corner of face `f` sitting on vertex `v`. */
function uAt(m: MeshData, f: number, v: number): number {
  const i = m.polys[f]!.indexOf(v);
  return Math.round(m.uvs![f]![i]![0]! * 1000) / 1000;
}

describe("collapseLoopData", () => {
  it("averages each face's own pair on the edge, separately", () => {
    // Blender on the shared edge 1-4: face 0's 0.10 and 0.20 both become
    // 0.15, face 1's 1.00 and 1.30 both become 1.15. Neither face takes
    // anything from the other — the seam across the edge survives.
    const out = collapseLoopData(grid2x2(), [[1, 4]]);
    expect(uAt(out, 0, 1)).toBe(0.15);
    expect(uAt(out, 0, 4)).toBe(0.15);
    expect(uAt(out, 1, 1)).toBe(1.15);
    expect(uAt(out, 1, 4)).toBe(1.15);
  });

  it("works on a boundary edge, where only one face uses it", () => {
    // Blender: face 0's 0.00 and 0.10 both become 0.05.
    const out = collapseLoopData(grid2x2(), [[0, 1]]);
    expect(uAt(out, 0, 0)).toBe(0.05);
    expect(uAt(out, 0, 1)).toBe(0.05);
  });

  it("leaves faces that do not use the edge alone", () => {
    const out = collapseLoopData(grid2x2(), [[1, 4]]);
    expect(uAt(out, 2, 4)).toBe(2.1);
    expect(uAt(out, 3, 4)).toBe(3);
  });

  it("ignores a pair that is a diagonal rather than an edge", () => {
    // 0 and 4 are both corners of face 0 but not neighbours around it.
    const out = collapseLoopData(grid2x2(), [[0, 4]]);
    expect(uAt(out, 0, 0)).toBe(0);
    expect(uAt(out, 0, 4)).toBe(0.2);
  });
});

describe("pointmergeLoopData", () => {
  it("writes the mean of the snap vertex's corners to every chosen corner", () => {
    // Blender, snapping vertices 1 and 4 to vertex 4: every one of those six
    // corners becomes 1.65 — the mean of vertex 4's own four (0.20, 1.30,
    // 2.10, 3.00) and **not** of all six.
    const out = pointmergeLoopData(grid2x2(), [1, 4], 4);
    for (const [f, v] of [[0, 1], [1, 1], [0, 4], [1, 4], [2, 4], [3, 4]] as const)
      expect(uAt(out, f, v), `face ${f} vertex ${v}`).toBe(1.65);
  });

  it("takes a vertex with one corner as that corner's value", () => {
    // Blender, snapping 0 and 1 to 0: all three corners become 0.00.
    const out = pointmergeLoopData(grid2x2(), [0, 1], 0);
    expect(uAt(out, 0, 0)).toBe(0);
    expect(uAt(out, 0, 1)).toBe(0);
    expect(uAt(out, 1, 1)).toBe(0);
  });

  it("is a mean, per component", () => {
    // (0,1) (1,8) (2,9) (9,10) has mean (3, 7) and midpoint (4.5, 5.5).
    // Blender answers (3, 7) — the mean, in both components.
    const m = grid2x2();
    const spread: Array<[number, number]> = [[0, 1], [1, 8], [2, 9], [9, 10]];
    let k = 0;
    for (let f = 0; f < 4; f++) {
      const i = m.polys[f]!.indexOf(4);
      m.uvs![f]![i] = [...spread[k++]!];
    }
    const out = pointmergeLoopData(m, [4], 4);
    const i = out.polys[0]!.indexOf(4);
    expect(out.uvs![0]![i]).toEqual([3, 7]);
  });
});

describe("averageVertLoopData", () => {
  it("is the midpoint of the range, not the mean", () => {
    // Vertex 4's four corners hold 0.20, 1.30, 2.10, 3.00. The mean is 1.65
    // and Blender answers **1.60**, which is (0.20 + 3.00) / 2. Three earlier
    // probes failed trying to read this as an average.
    const out = averageVertLoopData(grid2x2(), [4]);
    for (const f of [0, 1, 2, 3]) expect(uAt(out, f, 4)).toBe(1.6);
  });

  it("gives the whole selection one value, not one per vertex", () => {
    // Vertices 1 and 4 have their own midpoints — 0.55 and 1.60 — and Blender
    // gives every corner at both 1.55, which is the midpoint across all six
    // together: (0.10 + 3.00) / 2.
    const out = averageVertLoopData(grid2x2(), [1, 4]);
    for (const [f, v] of [[0, 1], [1, 1], [0, 4], [1, 4], [2, 4], [3, 4]] as const)
      expect(uAt(out, f, v), `face ${f} vertex ${v}`).toBe(1.55);
  });

  it("works on vertices with no face in common", () => {
    // Blender: vertices 0 and 2 give 0.55 = (0.00 + 1.10) / 2.
    const out = averageVertLoopData(grid2x2(), [0, 2]);
    expect(uAt(out, 0, 0)).toBe(0.55);
    expect(uAt(out, 1, 2)).toBe(0.55);
  });

  it("is a midpoint per component, unlike pointmerge's mean", () => {
    // The same spread that gives pointmerge (3, 7) gives this (4.5, 5.5).
    // The asymmetry between the two operators is measured, not assumed.
    const m = grid2x2();
    const spread: Array<[number, number]> = [[0, 1], [1, 8], [2, 9], [9, 10]];
    let k = 0;
    for (let f = 0; f < 4; f++) {
      const i = m.polys[f]!.indexOf(4);
      m.uvs![f]![i] = [...spread[k++]!];
    }
    const out = averageVertLoopData(m, [4]);
    const i = out.polys[0]!.indexOf(4);
    expect(out.uvs![0]![i]).toEqual([4.5, 5.5]);
  });
});

describe("faceAttributeFill", () => {
  /** Two quads sharing edge 1-2, the shape the first fill probe used. */
  function pair(): MeshData {
    const polys = [
      [0, 1, 2, 3],
      [1, 4, 5, 2],
    ];
    return {
      positions: new Float32Array([
        0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 2, 0, 0, 2, 1, 0,
      ]),
      polys,
      uvs: polys.map((p, f) => p.map((_, i) => [f + i / 10, 0])),
    };
  }

  it("takes the neighbour's value at the vertices they share", () => {
    // Blender: filling face 0 of the pair gives it 0.0, 1.0, 1.3, 0.3 — its
    // corners on v1 and v2 take face 1's values there, and the two corners
    // face 1 does not touch are left alone.
    const out = faceAttributeFill(pair(), [0]);
    expect(uAt(out, 0, 0)).toBe(0);
    expect(uAt(out, 0, 1)).toBe(1);
    expect(uAt(out, 0, 2)).toBe(1.3);
    expect(uAt(out, 0, 3)).toBe(0.3);
  });

  it("leaves the source alone", () => {
    const out = faceAttributeFill(pair(), [0]);
    expect(out.uvs![1]!.map((c) => c[0])).toEqual([1, 1.1, 1.2, 1.3]);
  });

  it("does nothing when there is no source", () => {
    // Give both faces and neither has a neighbour outside the selection.
    const before = pair();
    const out = faceAttributeFill(before, [0, 1]);
    expect(out.uvs).toEqual(before.uvs);
  });

  it("needs a shared edge — a shared corner gives nothing", () => {
    // Measured in both directions: two quads meeting at one point exchange
    // nothing at all.
    const polys = [
      [0, 1, 2, 3],
      [2, 4, 5, 6],
    ];
    const touching: MeshData = {
      positions: new Float32Array([
        0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 2, 1, 0, 2, 2, 0, 1, 2, 0,
      ]),
      polys,
      uvs: polys.map((p, f) => p.map((_, i) => [f + i / 10, 0])),
    };
    expect(faceAttributeFill(touching, [0]).uvs).toEqual(touching.uvs);
    expect(faceAttributeFill(touching, [1]).uvs).toEqual(touching.uvs);
  });

  it("at a corner two neighbours share, the corner walk decides (probe-fill2.py)", () => {
    // Blender, filling each quad of the 2x2 grid alone: the centre corner
    // takes the edge *into* it — except face 3, whose centre corner is its
    // corner 0 and is reached first by the edge going *out*. Once refused as
    // "not a rule"; it is `BM_face_copy_shared`'s first-write-wins walk.
    expect(uAt(faceAttributeFill(grid2x2(), [0]), 0, 4)).toBe(1.3); // in: face 1
    expect(uAt(faceAttributeFill(grid2x2(), [1]), 1, 4)).toBe(3.0); // in: face 3
    expect(uAt(faceAttributeFill(grid2x2(), [2]), 2, 4)).toBe(0.2); // in: face 0
    expect(uAt(faceAttributeFill(grid2x2(), [3]), 3, 4)).toBe(1.3); // out: face 1
  });

  it("fills in waves, so a filled face is a source for the next", () => {
    // Faces 0 and 1 given. The stack pops face 1 first; it takes face 3's
    // values, and face 0 — filled after it — then takes its centre corner from
    // face 1 across the edge into it: face 3's 3.0 arriving by way of face 1,
    // not face 2's 2.1 from the only original neighbour it has there.
    const out = faceAttributeFill(grid2x2(), [0, 1]);
    expect(uAt(out, 1, 4)).toBe(3.0);
    expect(uAt(out, 0, 4)).toBe(3.0);
  });
});

import { describe, it, expect } from "vitest";
import { reverseLoopData, rotateLoopData } from "./loop-data";
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

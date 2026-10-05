/**
 * The vertex groups of the modifiers that read one their own way (compat-backlog C31; the parity rows `*-vgroup*`).
 */
import { describe, it, expect } from "vitest";
import type { MeshData } from "../lib/mesh";
import { cast, simpleDeform, wave, warp } from "./deform";
import { laplacianSmooth } from "./edit-mode/laplacian-smooth";
import { mergeByDistance } from "./remove-doubles";
import { weightedNormal, normalEdit } from "./edit-mode/normal-modifiers";
import { uvWarp } from "./edit-mode/uv-modifiers";
import { shrinkwrap } from "./edit-mode/shrinkwrap";

/** Four vertices of a square at z 0; vertex 0 weight 0 (a member), 1 weight 1, 2 weight 0.5, 3 not a member. */
function square(): MeshData {
  return {
    positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
    polys: [[0, 1, 2, 3]],
    groups: new Map([["G", new Map([[0, 0], [1, 1], [2, 0.5]])]]),
  };
}

const at = (m: MeshData, v: number): number[] => [m.positions[v * 3]!, m.positions[v * 3 + 1]!, m.positions[v * 3 + 2]!];

describe("modifier vertex groups", () => {
  it("cast: a vertex with weight 0 stays, the rest go the weighted part of the way", () => {
    const out = cast(square(), { shape: "sphere", factor: 1, size: 2, vertexGroup: "G" });
    expect(at(out, 0)).toEqual([-1, -1, 0]); // weight 0
    expect(at(out, 3)).toEqual([-1, 1, 0]); // not a member
    const full = Math.SQRT2 * 0 + 2 / Math.SQRT2; // the sphere of radius 2 along (1,-1,0)/√2
    expect(at(out, 1)[0]).toBeCloseTo(full, 5);
    expect(at(out, 2)[0]).toBeCloseTo(1 + (full - 1) * 0.5, 5);
  });

  it("cast: inverted, the non-members move and weight 1 stays", () => {
    const out = cast(square(), { shape: "sphere", factor: 1, size: 2, vertexGroup: "G", invertVertexGroup: true });
    expect(at(out, 1)).toEqual([1, -1, 0]);
    expect(at(out, 0)[0]).not.toBe(-1);
  });

  it("a group nobody is in applies in full, as does a missing one", () => {
    const m = square();
    m.groups = new Map([["G", new Map()]]);
    const a = cast(m, { shape: "sphere", factor: 1, size: 2, vertexGroup: "G" });
    const b = cast(square(), { shape: "sphere", factor: 1, size: 2, vertexGroup: "nope" });
    const plain = cast(square(), { shape: "sphere", factor: 1, size: 2 });
    expect(Array.from(a.positions)).toEqual(Array.from(plain.positions));
    expect(Array.from(b.positions)).toEqual(Array.from(plain.positions));
  });

  it("simpleDeform blends the old and the deformed position by the weight", () => {
    const m = square();
    m.polys = [[0, 1, 2, 3]];
    m.positions = Float32Array.from([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]);
    const plain = simpleDeform(m, { mode: "taper", axis: "z", factor: 1 });
    const out = simpleDeform(m, { mode: "taper", axis: "z", factor: 1, vertexGroup: "G" });
    expect(at(out, 0)).toEqual(at(m, 0)); // weight 0
    expect(at(out, 1)).toEqual(at(plain, 1)); // weight 1
    expect(at(out, 2)[0]).toBeCloseTo(1 + (at(plain, 2)[0]! - 1) * 0.5, 6);
  });

  it("wave skips weight 0 and scales the ridge by the rest", () => {
    const m = square();
    const plain = wave(m, { height: 1, width: 10, narrowness: 0.1, speed: 0, along: "x" });
    const out = wave(m, { height: 1, width: 10, narrowness: 0.1, speed: 0, along: "x", vertexGroup: "G" });
    expect(at(out, 0)[2]).toBe(0);
    expect(at(out, 1)[2]).toBeCloseTo(at(plain, 1)[2]!, 6);
    expect(at(out, 2)[2]).toBeCloseTo(at(plain, 2)[2]! * 0.5, 6);
  });

  it("warp skips a vertex with no weight", () => {
    const out = warp(square(), {
      from: {},
      to: { at: [0, 0, 1] },
      radius: 5,
      falloff: "constant",
      vertexGroup: "G",
    });
    expect(at(out, 0)[2]).toBe(0);
    expect(at(out, 1)[2]).toBeCloseTo(1, 6);
    expect(at(out, 2)[2]).toBeCloseTo(0.5, 6);
  });

  it("laplacian smooth: a weight of 0 holds a vertex where it is", () => {
    const grid: MeshData = {
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 1, 0, 1.3, 1.2, 0, 2, 1, 0, 0, 2, 0, 1, 2, 0, 2, 2, 0]),
      polys: [[0, 1, 4, 3], [1, 2, 5, 4], [3, 4, 7, 6], [4, 5, 8, 7]],
      groups: new Map([["G", new Map([[4, 0]])]]),
    };
    const out = laplacianSmooth(grid, { lambda: 0.5, vertexGroup: "G" });
    expect(at(out, 4)).toEqual([1.3, 1.2, 0].map(Math.fround));
  });

  it("weld: only members merge", () => {
    const m: MeshData = {
      positions: Float32Array.from([0, 0, 0, 0.001, 0, 0, 1, 0, 0, 1.001, 0, 0, 1, 1, 0]),
      polys: [],
      groups: new Map([["G", new Map([[0, 1], [1, 1]])]]),
    };
    const out = mergeByDistance(m, 0.01, { vertexGroup: "G" });
    // 0 and 1 are members and merge; 2 and 3 are not and stay apart.
    expect(out.positions.length / 3).toBe(4);
  });

  it("weighted normal: a vertex outside the group keeps the mesh's own normal", () => {
    const m: MeshData = {
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0.5, 0.5, 1]),
      polys: [[0, 1, 2, 3], [0, 1, 4], [1, 2, 4]],
      groups: new Map([["G", new Map([[4, 1]])]]),
    };
    const plain = weightedNormal(m, {});
    const out = weightedNormal(m, { vertexGroup: "G" });
    expect(out.normals).toBeDefined();
    expect(out.normals![0]![0]).not.toEqual(plain.normals![0]![0]);
  });

  it("normal edit: the mix factor is the vertex's weight times the factor", () => {
    const m = square();
    m.positions = Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
    const full = normalEdit(m, { target: [0, 0, 0], noPolynorsFix: true });
    const out = normalEdit(m, { target: [0, 0, 0], noPolynorsFix: true, vertexGroup: "G" });
    // Corner 1 (weight 1) is fully the radial normal, corner 0 (weight 0) is the original.
    expect(out.normals![0]![1]).toEqual(full.normals![0]![1]);
    expect(out.normals![0]![0]).toEqual([0, 0, 1]);
  });

  it("uv warp: a corner moves the weighted part of the way", () => {
    const m = square();
    m.uvs = [[[0, 0], [1, 0], [1, 1], [0, 1]]];
    const plain = uvWarp(m, { offset: [1, 0] });
    const out = uvWarp(m, { offset: [1, 0], vertexGroup: "G" });
    expect(out.uvs![0]![0]).toEqual([0, 0]);
    expect(out.uvs![0]![1]).toEqual(plain.uvs![0]![1]);
    expect(out.uvs![0]![2]![0]).toBeCloseTo(1.5, 6);
  });

  it("shrinkwrap: a vertex goes the weighted part of the way", () => {
    const target: MeshData = { positions: Float32Array.from([-5, -5, -1, 5, -5, -1, 5, 5, -1, -5, 5, -1]), polys: [[0, 1, 2, 3]] };
    const out = shrinkwrap(square(), { target, vertexGroup: "G" });
    expect(at(out, 0)[2]).toBe(0);
    expect(at(out, 1)[2]).toBeCloseTo(-1, 6);
    expect(at(out, 2)[2]).toBeCloseTo(-0.5, 6);
  });
});

describe("shrinkwrap: subsurf_levels (compat-backlog C39)", () => {
  it("rays along the normal start from the vertex's subdivided position", () => {
    // A cube above a plane at z = −2, projected along the normals: each corner's ray starts from where one Catmull-Clark level
    // puts it (nearer the middle), so the landing point is not straight below the corner.
    const h = 0.5;
    const cube: MeshData = {
      positions: Float32Array.from([-h, -h, -h, h, -h, -h, h, h, -h, -h, h, -h, -h, -h, h, h, -h, h, h, h, h, -h, h, h]),
      polys: [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]],
    };
    const target: MeshData = { positions: Float32Array.from([-9, -9, -9, 9, -9, -9, 9, 9, -9, -9, 9, -9]), polys: [[0, 1, 2, 3]] };
    // An asymmetric box: on a symmetric one the subdivided position lies on the same diagonal as the corner.
    for (let i = 0; i < 8; i++) {
      cube.positions[i * 3] = cube.positions[i * 3]! * 1.7 + cube.positions[i * 3 + 2]! * 0.3;
      cube.positions[i * 3 + 1] = cube.positions[i * 3 + 1]! * 0.8;
    }
    const plain = shrinkwrap(cube, { target, method: "project", mode: "onSurface", project: { axis: "normal" } });
    const sub = shrinkwrap(cube, { target, method: "project", mode: "onSurface", project: { axis: "normal", subsurfLevels: 1 } });
    expect(Array.from(sub.positions)).not.toEqual(Array.from(plain.positions));
  });
});

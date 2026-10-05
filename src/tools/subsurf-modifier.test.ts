/**
 * `subsurfModifier` — Blender's Subdivision Surface modifier with the layers it carries (compat-backlog C42). The expected
 * numbers come from OpenSubdiv's rules, written out; the parity rows `subdiv-creases*` measure the same against Blender.
 */
import { describe, it, expect } from "vitest";
import { subsurfModifier } from "./subsurf-modifier";
import type { MeshData } from "../lib/mesh";

function cube(): MeshData {
  const positions = new Float32Array([
    -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
    -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
  ]);
  const polys = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [0, 4, 7, 3]];
  return { positions, polys };
}

const at = (m: MeshData, v: number): number[] => [m.positions[v * 3]!, m.positions[v * 3 + 1]!, m.positions[v * 3 + 2]!];

describe("subsurfModifier", () => {
  it("reads a crease as 10·crease² — a crease of 1 keeps the edge's two ends where they were on a corner of three", () => {
    const data = cube();
    // All three edges at vertex 6 fully sharp: a corner, which does not move.
    data.creases = new Map([["2_6", 1], ["5_6", 1], ["6_7", 1]]);
    const out = subsurfModifier(data, { levels: 1 });
    expect(at(out, 6)).toEqual([0.5, 0.5, 0.5]);
  });

  it("blends a corner into a crease by the mean sharpness of the edges that decay (OpenSubdiv's fractional weight)", () => {
    const data = cube();
    // Vertex 6: two edges at σ = 3.6 (they survive as σ = 2.6) and one at σ = 0.4 (it decays). The parent is a corner, the
    // child a crease through vertices 5 and 7; the weight is that of the decaying edge alone — 0.4, not the mean of all three.
    data.creases = new Map([["5_6", 0.6], ["6_7", 0.6], ["2_6", 0.2]]);
    const out = subsurfModifier(data, { levels: 1 });
    const [x, y, z] = at(out, 6) as [number, number, number];
    expect(x).toBeCloseTo(0.4 * 0.5 + 0.6 * 0.375, 6);
    expect(y).toBeCloseTo(0.4 * 0.5 + 0.6 * 0.375, 6);
    expect(z).toBeCloseTo(0.5, 6);
  });

  it("copies crease, seam and sharp to both child edges of every original edge", () => {
    const data = cube();
    data.creases = new Map([["0_1", 0.5]]);
    data.seams = new Set(["0_1"]);
    data.sharp = new Set(["0_1"]);
    const out = subsurfModifier(data, { levels: 1 });
    for (const layer of [out.creases ? [...out.creases.keys()] : [], [...(out.seams ?? [])], [...(out.sharp ?? [])]]) {
      expect(layer).toHaveLength(2);
      const ends = layer.flatMap((k) => k.split("_").map(Number));
      expect(ends.filter((v) => v === 0)).toHaveLength(1);
      expect(ends.filter((v) => v === 1)).toHaveLength(1);
      // The two edges share the new edge point.
      const mid = ends.filter((v) => v !== 0 && v !== 1);
      expect(mid[0]).toBe(mid[1]);
    }
    // The crease value is unchanged: the refined sharpness lives in OpenSubdiv's tables, not in the mesh.
    expect([...out.creases!.values()]).toEqual([0.5, 0.5]);
  });

  it("gives the four faces made from a face that face's material", () => {
    const data = cube();
    data.materials = [0, 1, 2, 3, 4, 5];
    const out = subsurfModifier(data, { levels: 1 });
    expect(out.materials).toHaveLength(24);
    for (let f = 0; f < 6; f++) expect(out.materials!.slice(f * 4, f * 4 + 4)).toEqual([f, f, f, f]);
  });

  it("puts a new vertex in a group only if a corner of its coarse face is in it", () => {
    const data = cube();
    // Vertex 0 lies in faces 0, 2 and 5; faces 1, 3 and 4 have no corner in the group.
    data.groups = new Map([["g", new Map([[0, 1]])]]);
    const out = subsurfModifier(data, { levels: 1 });
    const w = out.groups!.get("g")!;
    const facePoint = (f: number): number => 8 + f;
    expect(w.get(facePoint(0))).toBeCloseTo(0.25, 6);
    expect(w.has(facePoint(1))).toBe(false);
    expect(w.has(facePoint(3))).toBe(false);
    expect(w.has(facePoint(4))).toBe(false);
  });

  it("with useCreases off, ignores the creases", () => {
    const data = cube();
    data.creases = new Map([["0_1", 1]]);
    const plain = subsurfModifier(cube(), { levels: 1 });
    const off = subsurfModifier(data, { levels: 1, useCreases: false });
    expect(Array.from(off.positions)).toEqual(Array.from(plain.positions));
    expect(off.creases).toBeUndefined();
  });
});

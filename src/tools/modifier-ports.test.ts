import { describe, it, expect } from "vitest";
import type { MeshData } from "../lib/mesh";
import { smoothMesh } from "./smooth-mesh";
import { offsetAlongNormals } from "./displace";
import { mergeByDistance, removeDoubles } from "./remove-doubles";
import { transferWeights } from "./data-transfer";
import { arrayMesh } from "./mesh-ops";

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

describe("arrayMesh relative offset (the Array modifier)", () => {
  it("adds the mesh's own size times the factor to the constant offset", () => {
    const bar: MeshData = { positions: new Float32Array([0, 0, 0, 2, 0, 0]), polys: [] };
    // Constant 0.5 plus relative 1 × width 2: the copy starts at 2.5.
    expect(xs(arrayMesh(bar, 2, [0.5, 0, 0], { relative: [1, 0, 0] }))).toEqual([0, 2, 2.5, 4.5]);
  });
});

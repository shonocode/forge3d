import { describe, it, expect } from "vitest";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { buildMeshGraph, dijkstra, computeAutoWeightsGeodesic } from "./geodesic-weights";
import { computeAutoWeights, type BoneSegment } from "./auto-weights";

const MAX_INFLUENCES = 4;

function weightForBone(
  indices: Float32Array,
  weights: Float32Array,
  vi: number,
  boneIndex: number
): number {
  for (let s = 0; s < MAX_INFLUENCES; s++) {
    const base = vi * MAX_INFLUENCES + s;
    if (indices[base] === boneIndex) return weights[base]!;
  }
  return 0;
}

/**
 * Build a thin triangle ribbon following a 2D centerline (z is the ribbon
 * width). Returns flat positions + triangle indices. Vertex `2*i` / `2*i+1`
 * are the two rim vertices at centerline point `i`.
 */
function buildRibbon(center: Array<[number, number]>): {
  positions: Float32Array;
  indices: Uint32Array;
} {
  const pos: number[] = [];
  for (const [x, y] of center) {
    pos.push(x, y, 0.05); // rim A
    pos.push(x, y, -0.05); // rim B
  }
  const idx: number[] = [];
  for (let i = 0; i < center.length - 1; i++) {
    const a0 = 2 * i;
    const b0 = 2 * i + 1;
    const a1 = 2 * (i + 1);
    const b1 = 2 * (i + 1) + 1;
    idx.push(a0, b0, a1);
    idx.push(b0, b1, a1);
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}

describe("buildMeshGraph", () => {
  it("welds vertices sharing a position into one node", () => {
    // Two triangles forming a quad; the shared edge has duplicate positions.
    const positions = new Float32Array([
      0, 0, 0, // 0
      1, 0, 0, // 1
      0, 1, 0, // 2
      1, 0, 0, // 3 (dup of 1)
      0, 1, 0, // 4 (dup of 2)
      1, 1, 0, // 5
    ]);
    const indices = new Uint32Array([0, 1, 2, 3, 5, 4]);
    const g = buildMeshGraph(positions, indices);
    // 4 unique positions → 4 nodes.
    expect(g.nodeCount).toBe(4);
    // Duplicated vertices map to the same node.
    expect(g.vertexToNode[1]).toBe(g.vertexToNode[3]);
    expect(g.vertexToNode[2]).toBe(g.vertexToNode[4]);
  });

  it("creates symmetric edges with Euclidean weights", () => {
    const positions = new Float32Array([0, 0, 0, 3, 0, 0, 0, 4, 0]);
    const indices = new Uint32Array([0, 1, 2]);
    const g = buildMeshGraph(positions, indices);
    // node 0↔1 distance 3, 0↔2 distance 4, 1↔2 distance 5.
    const edge = (a: number, b: number) => g.adjacency[a]!.find((e) => e.to === b)?.w;
    expect(edge(0, 1)).toBeCloseTo(3, 6);
    expect(edge(1, 0)).toBeCloseTo(3, 6);
    expect(edge(0, 2)).toBeCloseTo(4, 6);
    expect(edge(1, 2)).toBeCloseTo(5, 6);
  });
});

describe("dijkstra", () => {
  it("computes shortest path distance with a seed offset", () => {
    // Path 0-1-2 along X at unit spacing.
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]);
    const indices = new Uint32Array([0, 1, 1, 1, 2, 2]); // edges 0-1 and 1-2
    const g = buildMeshGraph(positions, indices);
    const dist = dijkstra(g, g.vertexToNode[0]!, 0.5);
    expect(dist[g.vertexToNode[0]!]).toBeCloseTo(0.5, 6);
    expect(dist[g.vertexToNode[1]!]).toBeCloseTo(1.5, 6);
    expect(dist[g.vertexToNode[2]!]).toBeCloseTo(2.5, 6);
  });
});

describe("computeAutoWeightsGeodesic", () => {
  const flat = buildRibbon([
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 0],
  ]);
  const segments: BoneSegment[] = [
    { boneIndex: 0, head: new Vector3(0, 0, 0), tail: new Vector3(0, 0, 0) },
    { boneIndex: 1, head: new Vector3(3, 0, 0), tail: new Vector3(3, 0, 0) },
  ];

  it("normalizes weights to sum to 1 and is 4-wide", () => {
    const { indices, weights } = computeAutoWeightsGeodesic(flat.positions, flat.indices, segments);
    const vcount = flat.positions.length / 3;
    expect(weights).toHaveLength(vcount * MAX_INFLUENCES);
    for (let vi = 0; vi < vcount; vi++) {
      let sum = 0;
      for (let s = 0; s < MAX_INFLUENCES; s++) sum += weights[vi * MAX_INFLUENCES + s]!;
      expect(sum).toBeCloseTo(1, 5);
    }
  });

  it("binds the end vertices to their nearest bone along the surface", () => {
    const { indices, weights } = computeAutoWeightsGeodesic(flat.positions, flat.indices, segments);
    // Vertex 0 sits at centerline (0,0) — bone 0; last rim vertex at (3,0) — bone 1.
    expect(weightForBone(indices, weights, 0, 0)).toBeGreaterThan(0.8);
    const last = flat.positions.length / 3 - 1;
    expect(weightForBone(indices, weights, last, 1)).toBeGreaterThan(0.8);
  });

  it("prevents spatial bleed across a fold that distance-based binding suffers", () => {
    // U-fold: endpoints (0,0) and (0,2) are 2 apart in space but ~8 along the
    // surface. Bone 0 sits at the start, bone 1 at the end.
    const u = buildRibbon([
      [0, 0],
      [1, 0],
      [2, 0],
      [2, 1],
      [2, 2],
      [1, 2],
      [0, 2],
    ]);
    const seg: BoneSegment[] = [
      { boneIndex: 0, head: new Vector3(0, 0, 0), tail: new Vector3(0, 0, 0) },
      { boneIndex: 1, head: new Vector3(0, 2, 0), tail: new Vector3(0, 2, 0) },
    ];

    // The rim vertex at centerline point (1,2) — spatially ~2.2 from bone 0 but
    // ~7 along the surface; it should belong to bone 1.
    const targetVi = 2 * 5; // centerline index 5 = (1,2), rim A

    const geo = computeAutoWeightsGeodesic(u.positions, u.indices, seg);
    const euc = computeAutoWeights(u.positions, seg);

    const geoBleed = weightForBone(geo.indices, geo.weights, targetVi, 0);
    const eucBleed = weightForBone(euc.indices, euc.weights, targetVi, 0);

    // Geodesic gives bone 0 far less bleed than plain distance does.
    expect(geoBleed).toBeLessThan(eucBleed);
    expect(geoBleed).toBeLessThan(0.05);
    // And the vertex is dominated by the topologically-near bone 1.
    expect(weightForBone(geo.indices, geo.weights, targetVi, 1)).toBeGreaterThan(0.9);
  });
});

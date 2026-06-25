import { describe, it, expect } from "vitest";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import {
  computeAutoWeights,
  distancePointToSegment,
  type BoneSegment,
} from "./auto-weights";

const MAX_INFLUENCES = 4;

/** Read the weight assigned to a specific bone index for vertex `vi`. */
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

describe("distancePointToSegment", () => {
  it("measures perpendicular distance to the segment body", () => {
    const d = distancePointToSegment(
      new Vector3(0.5, 1, 0),
      new Vector3(0, 0, 0),
      new Vector3(1, 0, 0)
    );
    expect(d).toBeCloseTo(1, 6);
  });

  it("clamps to the nearest endpoint past the segment ends", () => {
    const d = distancePointToSegment(
      new Vector3(3, 0, 0),
      new Vector3(0, 0, 0),
      new Vector3(1, 0, 0)
    );
    expect(d).toBeCloseTo(2, 6); // 2 past the b endpoint
  });

  it("handles a degenerate (point) segment", () => {
    const d = distancePointToSegment(
      new Vector3(0, 3, 4),
      new Vector3(0, 0, 0),
      new Vector3(0, 0, 0)
    );
    expect(d).toBeCloseTo(5, 6);
  });
});

describe("computeAutoWeights", () => {
  // Two bones: bone 0 along the lower X axis, bone 1 along the upper segment.
  const segments: BoneSegment[] = [
    { boneIndex: 0, head: new Vector3(0, 0, 0), tail: new Vector3(1, 0, 0) },
    { boneIndex: 1, head: new Vector3(1, 0, 0), tail: new Vector3(2, 0, 0) },
  ];

  it("binds a vertex predominantly to its nearest bone", () => {
    // Vertex sitting right on bone 1's body.
    const positions = new Float32Array([1.5, 0.05, 0]);
    const { indices, weights } = computeAutoWeights(positions, segments);

    const w0 = weightForBone(indices, weights, 0, 0);
    const w1 = weightForBone(indices, weights, 0, 1);
    expect(w1).toBeGreaterThan(w0);
    expect(w1).toBeGreaterThan(0.8);
  });

  it("normalizes each vertex's weights to sum to 1", () => {
    const positions = new Float32Array([
      0.5, 0.2, 0, // near bone 0
      1.5, 0.2, 0, // near bone 1
      1.0, 0.5, 0, // between both
    ]);
    const { weights } = computeAutoWeights(positions, segments);

    for (let vi = 0; vi < 3; vi++) {
      let sum = 0;
      for (let s = 0; s < MAX_INFLUENCES; s++) sum += weights[vi * MAX_INFLUENCES + s]!;
      expect(sum).toBeCloseTo(1, 5);
    }
  });

  it("produces 4-wide buffers regardless of bone count", () => {
    const positions = new Float32Array([0, 0, 0, 1, 1, 1]);
    const { indices, weights } = computeAutoWeights(positions, segments);
    expect(indices).toHaveLength(2 * MAX_INFLUENCES);
    expect(weights).toHaveLength(2 * MAX_INFLUENCES);
  });

  it("splits weight roughly evenly for an equidistant vertex", () => {
    // Equidistant from both segments' shared joint at (1,0,0).
    const positions = new Float32Array([1.0, 0.5, 0]);
    const { indices, weights } = computeAutoWeights(positions, segments);
    const w0 = weightForBone(indices, weights, 0, 0);
    const w1 = weightForBone(indices, weights, 0, 1);
    expect(Math.abs(w0 - w1)).toBeLessThan(0.05);
  });

  it("falls back to the root bone when there are no segments", () => {
    const positions = new Float32Array([5, 5, 5]);
    const { indices, weights } = computeAutoWeights(positions, []);
    expect(indices[0]).toBe(0);
    expect(weights[0]).toBe(1);
  });

  it("respects a maxInfluences cap of 1 (hard binding)", () => {
    const positions = new Float32Array([1.5, 0.05, 0]);
    const { indices, weights } = computeAutoWeights(positions, segments, {
      maxInfluences: 1,
    });
    // Only one non-zero slot, fully weighted.
    expect(weights[0]).toBeCloseTo(1, 6);
    expect(weights[1]).toBe(0);
    expect(indices[0]).toBe(1); // nearest bone
  });
});

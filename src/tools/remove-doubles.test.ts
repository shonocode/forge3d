import { describe, it, expect } from "vitest";
import { removeDoubles, doublesByDistance } from "./remove-doubles";

describe("removeDoubles", () => {
  it("merges a vertex onto its twin and keeps the survivor where it was", () => {
    // Two triangles sharing an edge, the shared corners duplicated.
    const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    const out = removeDoubles({ positions, polys: [[0, 1, 2], [3, 4, 5]] }, 0.001);
    expect(out.positions.length / 3).toBe(4);
    expect(out.polys).toHaveLength(2);
    // Every survivor is an input point, not an average.
    for (let i = 0; i < out.positions.length; i += 3)
      expect([0, 1]).toContain(out.positions[i]);
  });

  it("does nothing when nothing is within the distance", () => {
    const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const out = removeDoubles({ positions, polys: [[0, 1, 2]] }, 0.1);
    expect(Array.from(out.positions)).toEqual(Array.from(positions));
    expect(out.polys).toEqual([[0, 1, 2]]);
  });

  it("keeps the most central vertex of a cluster, not the first", () => {
    // Three points in a row, 0.01 apart; all within 0.05 of each other. The
    // middle one is nearest the centroid, so it survives.
    const positions = Float32Array.from([0, 0, 0, 0.01, 0, 0, 0.02, 0, 0]);
    const dup = doublesByDistance(positions, 0.05);
    const kept = [...new Set(Array.from(dup))];
    expect(kept).toEqual([1]);
  });

  it("drops a face that collapses and leaves its edges loose", () => {
    // A thin triangle whose two close corners merge: the face is gone, the
    // edge between the survivors stays.
    const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 1, 0.0001, 0]);
    const out = removeDoubles({ positions, polys: [[0, 1, 2]] }, 0.001);
    expect(out.polys).toHaveLength(0);
    expect(out.edges).toHaveLength(1);
  });
});

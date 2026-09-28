import { describe, it, expect } from "vitest";
import { removeDoubles, removeDoublesSelected, doublesByDistance } from "./remove-doubles";

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

describe("removeDoublesSelected (bpy.ops.mesh.remove_doubles)", () => {
  // Three points 0.01 apart in a row, and a triangle to hold them.
  const row = (): { positions: Float32Array; polys: number[][] } => ({
    positions: Float32Array.from([0, 0, 0, 0.01, 0, 0, 0.02, 0, 0, 0, 1, 0]),
    polys: [[0, 1, 3], [1, 2, 3]],
  });

  it("moves the survivor to the cluster's centroid by default", () => {
    const out = removeDoublesSelected(row(), 0.05);
    expect(out.positions.length / 3).toBe(2);
    expect(out.positions[0]).toBeCloseTo(0.01, 6);
  });

  it("keeps the survivor in place with useCentroid false, as bmesh.ops does", () => {
    const out = removeDoublesSelected(row(), 0.05, { useCentroid: false });
    expect(Array.from(out.positions)).toEqual(Array.from(removeDoubles(row(), 0.05).positions));
  });

  it("searches only the selection", () => {
    // 0 and 1 selected: 2 is within range but not searched, so it stays.
    const out = removeDoublesSelected(row(), 0.05, { verts: [0, 1] });
    expect(out.positions.length / 3).toBe(3);
  });

  it("merges selected vertices into an unselected one first (keep_verts)", () => {
    // 1 unselected: 0 and 2 both go to it, and it moves to the mean of the three.
    const out = removeDoublesSelected(row(), 0.05, { verts: [0, 2], useUnselected: true });
    expect(out.positions.length / 3).toBe(2);
    expect(out.positions[0]).toBeCloseTo(0.01, 6);
    const dup = doublesByDistance(row().positions, 0.05, (i) => i === 1);
    // 3 is alone: the second pass finds only itself and points it at itself (it stays).
    expect(Array.from(dup)).toEqual([1, 1, 1, 3]);
  });
});

describe("removeDoublesSelected — the edges of its options", () => {
  const pair = (): { positions: Float32Array; polys: number[][] } => ({
    positions: Float32Array.from([0, 0, 0, 5e-7, 0, 0, 1, 0, 0, 0, 1, 0]),
    polys: [[0, 2, 3], [1, 2, 3]],
  });

  it("changes nothing with nothing selected", () => {
    const out = removeDoublesSelected(pair(), 0.05, { verts: [] });
    expect(out.positions.length / 3).toBe(4);
  });

  it("clamps the distance to the operator's minimum, 1e-6", () => {
    // 5e-7 apart: a distance of 0 still merges them, as Blender's threshold cannot go below 1e-6.
    expect(removeDoublesSelected(pair(), 0).positions.length / 3).toBe(3);
  });

  it("with everything selected, useUnselected has nothing to keep and clusters as usual", () => {
    const a = removeDoublesSelected(pair(), 0.001, { useUnselected: true });
    const b = removeDoublesSelected(pair(), 0.001);
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
  });
});

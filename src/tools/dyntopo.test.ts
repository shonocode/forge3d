import { describe, it, expect } from "vitest";
import { refineWithinRadii, remapAttribute } from "./dyntopo";

// A single large triangle in the z=0 plane, CCW.
const TRI_POS = [0, 0, 0, 2, 0, 0, 0, 2, 0];
const TRI_IDX = [0, 1, 2];

// Signed area sum of all triangles (z=0 plane) — winding/overlap sanity check.
function signedArea(pos: Float32Array | number[], idx: Uint32Array | number[]): number {
  let total = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]! * 3, b = idx[t + 1]! * 3, c = idx[t + 2]! * 3;
    const ax = pos[a]!, ay = pos[a + 1]!;
    const bx = pos[b]!, by = pos[b + 1]!;
    const cx = pos[c]!, cy = pos[c + 1]!;
    total += ((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
  }
  return total;
}

describe("refineWithinRadii — gating", () => {
  it("leaves geometry unchanged when all edges are shorter than detail", () => {
    const res = refineWithinRadii(TRI_POS, TRI_IDX, [[0, 0, 0]], 10, 100);
    expect(res.changed).toBe(false);
    expect(res.indices.length).toBe(3);
    expect(res.positions.length).toBe(9);
  });

  it("leaves geometry unchanged when the brush is out of radius", () => {
    const res = refineWithinRadii(TRI_POS, TRI_IDX, [[100, 100, 0]], 1, 0.1);
    expect(res.changed).toBe(false);
    expect(res.indices.length).toBe(3);
  });

  it("splits all three edges when long edges are in radius (1→4)", () => {
    const res = refineWithinRadii(TRI_POS, TRI_IDX, [[0.5, 0.5, 0]], 10, 0.1);
    expect(res.changed).toBe(true);
    expect(res.indices.length).toBe(12); // 4 triangles
    expect(res.positions.length).toBe(18); // 3 original + 3 midpoints
    expect(res.parents.length).toBe(3);
  });
});

describe("refineWithinRadii — correctness", () => {
  it("preserves total signed area (planar midpoint subdivision)", () => {
    const before = signedArea(TRI_POS, TRI_IDX);
    const res = refineWithinRadii(TRI_POS, TRI_IDX, [[0.5, 0.5, 0]], 10, 0.1);
    const after = signedArea(res.positions, res.indices);
    expect(after).toBeCloseTo(before, 6);
  });

  it("keeps positive area (consistent CCW winding) for a 2-edge split", () => {
    // A radius that catches two edges but not the far corner forces partial split.
    // Tall thin triangle so only edges near the origin qualify.
    const pos = [0, 0, 0, 4, 0, 0, 0, 0.2, 0];
    const idx = [0, 1, 2];
    const res = refineWithinRadii(pos, idx, [[0, 0, 0]], 0.5, 0.1);
    expect(res.changed).toBe(true);
    // Every sub-triangle must wind CCW (positive area) — no flipped/overlapping tris.
    for (let t = 0; t < res.indices.length; t += 3) {
      const a = res.indices[t]! * 3, b = res.indices[t + 1]! * 3, c = res.indices[t + 2]! * 3;
      const area =
        ((res.positions[b]! - res.positions[a]!) * (res.positions[c + 1]! - res.positions[a + 1]!) -
          (res.positions[c]! - res.positions[a]!) * (res.positions[b + 1]! - res.positions[a + 1]!)) / 2;
      expect(area).toBeGreaterThan(0);
    }
  });

  it("shares midpoints between adjacent triangles (watertight, no T-junctions)", () => {
    // Two triangles sharing edge (1,2) forming a quad.
    const pos = [0, 0, 0, 2, 0, 0, 0, 2, 0, 2, 2, 0];
    const idx = [0, 1, 2, 1, 3, 2];
    const res = refineWithinRadii(pos, idx, [[1, 1, 0]], 10, 0.1);
    // Shared edge (1,2) must produce exactly one midpoint, not two.
    const midpoints = res.positions.length / 3 - 4;
    // 5 unique edges (two outer per triangle + one shared) → 5 midpoints, not 6.
    expect(midpoints).toBe(5);
  });

  it("records parents as original vertices that average to the midpoint", () => {
    const res = refineWithinRadii(TRI_POS, TRI_IDX, [[0.5, 0.5, 0]], 10, 0.1);
    const origCount = 3;
    res.parents.forEach(([pa, pb], i) => {
      const v = (origCount + i) * 3;
      expect(res.positions[v]!).toBeCloseTo((TRI_POS[pa * 3]! + TRI_POS[pb * 3]!) / 2, 6);
      expect(res.positions[v + 1]!).toBeCloseTo((TRI_POS[pa * 3 + 1]! + TRI_POS[pb * 3 + 1]!) / 2, 6);
    });
  });
});

describe("remapAttribute", () => {
  it("keeps original values and averages parents for new vertices", () => {
    const parents: Array<[number, number]> = [[0, 1]];
    const mask = [0, 1, 0.5];
    const out = remapAttribute(mask, parents, 1);
    expect(Array.from(out)).toEqual([0, 1, 0.5, 0.5]); // new vertex = avg(0,1)
  });

  it("interpolates multi-component attributes (UV)", () => {
    const parents: Array<[number, number]> = [[0, 2]];
    const uv = [0, 0, 1, 0, 1, 1];
    const out = remapAttribute(uv, parents, 2);
    expect(Array.from(out.slice(6))).toEqual([0.5, 0.5]); // avg of (0,0) and (1,1)
  });
});

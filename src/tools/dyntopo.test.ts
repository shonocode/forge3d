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

// ── Edge collapse ──────────────────────────────────────────────────────────

import { collapseWithinRadii, remapAttributeBySources, COLLAPSE_FACTOR } from "./dyntopo";

/** Count undirected-edge occurrences — a closed mesh has every edge exactly 2. */
function edgeUse(idx: ArrayLike<number>): Map<string, number> {
  const m = new Map<string, number>();
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]!, b = idx[t + 1]!, c = idx[t + 2]!;
    for (const [u, v] of [[a, b], [b, c], [c, a]] as const) {
      const k = u < v ? `${u}_${v}` : `${v}_${u}`;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
  }
  return m;
}

/** Octahedron with vert 2 (0,1,0) pulled next to vert 0 (1,0,0) → tiny edge 0-2. */
function makeSquashedOcta(): { pos: number[]; idx: number[] } {
  const pos = [
    1, 0, 0,      // 0 +x
    -1, 0, 0,     // 1 -x
    1, 0.01, 0,   // 2 (was +y — squashed onto vert 0)
    0, -1, 0,     // 3 -y
    0, 0, 1,      // 4 +z
    0, 0, -1,     // 5 -z
  ];
  const idx = [
    0, 2, 4,  2, 1, 4,  1, 3, 4,  3, 0, 4,
    2, 0, 5,  1, 2, 5,  3, 1, 5,  0, 3, 5,
  ];
  return { pos, idx };
}

describe("collapseWithinRadii", () => {
  it("is a no-op when no edge is short enough", () => {
    const { pos, idx } = makeSquashedOcta();
    const res = collapseWithinRadii(pos, idx, [[0, 0, 0]], 10, 0.001);
    expect(res.changed).toBe(false);
    expect(Array.from(res.indices)).toEqual(idx);
    expect(res.sources).toEqual([]);
  });

  it("is a no-op when the short edge is out of the brush radius", () => {
    const { pos, idx } = makeSquashedOcta();
    const res = collapseWithinRadii(pos, idx, [[-50, 0, 0]], 1, 0.5);
    expect(res.changed).toBe(false);
  });

  it("collapses the tiny octahedron edge and stays watertight", () => {
    const { pos, idx } = makeSquashedOcta();
    // detail 0.5 → collapse threshold 0.2; edge 0-2 has length 0.01.
    const res = collapseWithinRadii(pos, idx, [[1, 0, 0]], 2, 0.5);
    expect(res.changed).toBe(true);
    expect(res.positions.length / 3).toBe(5);  // 6 → 5 verts
    expect(res.indices.length / 3).toBe(6);    // 8 → 6 faces
    // Closed surface: every edge shared by exactly 2 faces.
    for (const c of edgeUse(res.indices).values()) expect(c).toBe(2);
    // Survivor sits at the collapsed edge's midpoint.
    const surv = res.sources.findIndex(([a, b]) => a !== b);
    expect(surv).toBeGreaterThanOrEqual(0);
    expect(res.positions[surv * 3]).toBeCloseTo(1, 6);
    expect(res.positions[surv * 3 + 1]).toBeCloseTo(0.005, 6);
  });

  it("sources average per-vertex attributes across the merged pair", () => {
    const { pos, idx } = makeSquashedOcta();
    const res = collapseWithinRadii(pos, idx, [[1, 0, 0]], 2, 0.5);
    const maskIn = new Float32Array([1, 0, 0.5, 0, 0, 0]); // vert0=1, vert2=0.5
    const maskOut = remapAttributeBySources(maskIn, res.sources, 1);
    expect(maskOut.length).toBe(5);
    const surv = res.sources.findIndex(([a, b]) => a !== b);
    expect(maskOut[surv]).toBeCloseTo(0.75, 6); // avg(1, 0.5)
    // An untouched vertex passes through verbatim.
    const kept = res.sources.findIndex(([a, b]) => a === b && a === 1);
    expect(maskOut[kept]).toBe(0);
  });

  it("collapses only an independent edge set per pass (chains shrink progressively)", () => {
    // A strip of 4 tiny segments along x, fanned to an apex: verts 0..4 on the
    // x-axis 0.05 apart, apex 5 above. Edges 0-1, 1-2, 2-3, 3-4 are all short —
    // one pass may only take non-adjacent ones (0-1 and 2-3), never a chain.
    const pos = [
      0, 0, 0,  0.05, 0, 0,  0.1, 0, 0,  0.15, 0, 0,  0.2, 0, 0,
      0.1, 5, 0,
    ];
    const idx = [0, 1, 5, 1, 2, 5, 2, 3, 5, 3, 4, 5];
    const res = collapseWithinRadii(pos, idx, [[0.1, 0, 0]], 10, 0.5);
    expect(res.changed).toBe(true);
    // 2 independent collapses → 6-2 = 4 verts, 4-2 = 2 faces.
    expect(res.positions.length / 3).toBe(4);
    expect(res.indices.length / 3).toBe(2);
    // No degenerate triangles.
    for (let t = 0; t < res.indices.length; t += 3) {
      const a = res.indices[t]!, b = res.indices[t + 1]!, c = res.indices[t + 2]!;
      expect(a !== b && b !== c && c !== a).toBe(true);
    }
  });

  it("link condition rejects a collapse whose endpoints share 3 neighbors", () => {
    // Edge 0-1 (tiny) with 2 incident faces, but verts 0 and 1 also both
    // connect to vert 4 through side faces → common neighbors {2,3,4} = 3.
    const pos = [
      0, 0, 0,  0.01, 0, 0,     // 0, 1 — tiny edge
      0.5, 1, 0,  0.5, -1, 0,   // 2, 3 — the two face-opposite verts
      1.5, 0, 0,                // 4 — extra shared neighbor
    ];
    const idx = [
      0, 1, 2,  1, 0, 3,  // the edge's 2 faces
      0, 2, 4,  2, 1, 4,  // both endpoints reach 4
    ];
    const res = collapseWithinRadii(pos, idx, [[0, 0, 0]], 10, 0.5);
    expect(res.changed).toBe(false);
  });

  it("collapse threshold follows COLLAPSE_FACTOR", () => {
    const { pos, idx } = makeSquashedOcta();
    // Edge length 0.01; detail chosen so threshold sits just below it → no-op.
    const justBelow = 0.01 / COLLAPSE_FACTOR - 1e-4;
    expect(collapseWithinRadii(pos, idx, [[1, 0, 0]], 2, justBelow).changed).toBe(false);
    const justAbove = 0.01 / COLLAPSE_FACTOR + 1e-4;
    expect(collapseWithinRadii(pos, idx, [[1, 0, 0]], 2, justAbove).changed).toBe(true);
  });
});

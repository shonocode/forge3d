import { describe, it, expect } from "vitest";
import { shadeAutoSmooth } from "./auto-smooth";

/** Unit cube, 8 shared verts, 12 tris (same layout as edit-mode tests). */
const CUBE_POS = [
  -1, -1, -1,  1, -1, -1,  1, 1, -1,  -1, 1, -1,
  -1, -1,  1,  1, -1,  1,  1, 1,  1,  -1, 1,  1,
];
const CUBE_IDX = [
  0, 2, 1,  0, 3, 2,
  4, 5, 6,  4, 6, 7,
  0, 1, 5,  0, 5, 4,
  3, 7, 6,  3, 6, 2,
  0, 4, 7,  0, 7, 3,
  1, 2, 6,  1, 6, 5,
];

/** Flat 2-tri plane in XY. */
const PLANE_POS = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
const PLANE_IDX = [0, 1, 2, 0, 2, 3];

const DEG = Math.PI / 180;

describe("shadeAutoSmooth", () => {
  it("smooth (180°) keeps the cube's 8 vertices with averaged normals", () => {
    const r = shadeAutoSmooth(CUBE_POS, CUBE_IDX, Math.PI);
    expect(r.positions.length / 3).toBe(8);
    expect(r.indices).toHaveLength(36);
    // Corner vertex normal points diagonally outward (≈ ±1/√3 per axis).
    const v0 = r.sourceVerts.indexOf(0);
    const inv3 = 1 / Math.sqrt(3);
    expect(Math.abs(r.normals[v0 * 3]!)).toBeCloseTo(inv3, 1);
    expect(Math.abs(r.normals[v0 * 3 + 1]!)).toBeCloseTo(inv3, 1);
    expect(Math.abs(r.normals[v0 * 3 + 2]!)).toBeCloseTo(inv3, 1);
  });

  it("auto smooth 30° splits cube corners into one vertex per face plane", () => {
    const r = shadeAutoSmooth(CUBE_POS, CUBE_IDX, 30 * DEG);
    // 8 corners × 3 face planes each = 24 verts; coplanar tri pairs share.
    expect(r.positions.length / 3).toBe(24);
    // Every output normal is axis-aligned (flat per face).
    for (let v = 0; v < 24; v++) {
      const n = [r.normals[v * 3]!, r.normals[v * 3 + 1]!, r.normals[v * 3 + 2]!];
      const mx = Math.max(...n.map(Math.abs));
      expect(mx).toBeCloseTo(1, 5);
    }
  });

  it("a coplanar plane never splits, even at tiny angles", () => {
    const r = shadeAutoSmooth(PLANE_POS, PLANE_IDX, 1 * DEG);
    expect(r.positions.length / 3).toBe(4);
    // All normals +Z (CCW winding in XY).
    for (let v = 0; v < 4; v++) {
      expect(r.normals[v * 3 + 2]!).toBeCloseTo(1, 5);
    }
  });

  it("threshold between the dihedral angles picks smooth vs hard per edge", () => {
    // Two quads meeting at 90° along the Y axis ("open book").
    //   left face in XY plane, right face in ZY plane.
    const pos = [
      -1, 0, 0,  0, 0, 0,  0, 1, 0,  -1, 1, 0, // left quad
      0, 0, 1,  0, 1, 1,                        // right quad's far edge
    ];
    const idx = [
      0, 1, 2,  0, 2, 3, // left (normal +Z)
      1, 4, 5,  1, 5, 2, // right (normal +X)
    ];
    const hard = shadeAutoSmooth(pos, idx, 45 * DEG);
    // Shared verts 1 and 2 split (fold is 90° > 45°) → 6 + 2 = 8 verts.
    expect(hard.positions.length / 3).toBe(8);

    const soft = shadeAutoSmooth(pos, idx, 120 * DEG);
    // 90° < 120° → smooth across the fold, no splits.
    expect(soft.positions.length / 3).toBe(6);
    // Shared vertex normal blends the left (+Z) and right (−X, from this
    // fixture's winding) faces — both components present, unit length.
    const v1 = soft.sourceVerts.indexOf(1);
    const nx = soft.normals[v1 * 3]!;
    const nz = soft.normals[v1 * 3 + 2]!;
    expect(nx).toBeLessThan(-0.3);
    expect(nz).toBeGreaterThan(0.3);
    expect(Math.hypot(nx, soft.normals[v1 * 3 + 1]!, nz)).toBeCloseTo(1, 5);
  });

  it("sourceVerts maps every output vertex to its input vertex", () => {
    const r = shadeAutoSmooth(CUBE_POS, CUBE_IDX, 30 * DEG);
    for (let v = 0; v < r.sourceVerts.length; v++) {
      const src = r.sourceVerts[v]!;
      expect(r.positions[v * 3]).toBe(CUBE_POS[src * 3]);
      expect(r.positions[v * 3 + 1]).toBe(CUBE_POS[src * 3 + 1]);
      expect(r.positions[v * 3 + 2]).toBe(CUBE_POS[src * 3 + 2]);
    }
  });
});

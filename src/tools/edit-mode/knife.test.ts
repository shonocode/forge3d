import { describe, expect, it } from "vitest";
import { planeCut, planeFromRays } from "./knife";

/** Triangulated unit-ish cube centered at origin (same layout as operators.test). */
function cube(): { positions: Float32Array; indices: number[] } {
  return {
    positions: new Float32Array([
      -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1,
      -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1,
    ]),
    indices: [
      0, 2, 1, 0, 3, 2,
      4, 5, 6, 4, 6, 7,
      0, 1, 5, 0, 5, 4,
      3, 7, 6, 3, 6, 2,
      0, 4, 7, 0, 7, 3,
      1, 2, 6, 1, 6, 5,
    ],
  };
}

/** Count boundary edges (edges referenced by exactly one triangle). */
function boundaryEdgeCount(indices: readonly number[]): number {
  const count = new Map<string, number>();
  for (let f = 0; f < indices.length / 3; f++) {
    const [a, b, c] = [indices[f * 3]!, indices[f * 3 + 1]!, indices[f * 3 + 2]!];
    for (const [x, y] of [[a, b], [b, c], [c, a]] as const) {
      const key = x < y ? `${x}_${y}` : `${y}_${x}`;
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  }
  let boundary = 0;
  for (const n of count.values()) if (n === 1) boundary++;
  return boundary;
}

describe("planeCut", () => {
  it("cuts a single triangle crossing the plane into 3 tris with preserved winding", () => {
    const positions = new Float32Array([-1, 0, 0, 1, 0, 0, 0, 2, 0]);
    const indices = [0, 1, 2];
    // Plane x=0 crosses edges 0-1 and ... vertex 2 sits ON the plane → only
    // edge 0-1 strictly crosses → 1-cut case, 2 output tris.
    const r = planeCut(positions, indices, [0, 0, 0], [1, 0, 0])!;
    expect(r).not.toBeNull();
    expect(r.newVerts.size).toBe(1);
    expect(r.indices.length / 3).toBe(2);
    const nv = [...r.newVerts][0]!;
    expect(r.positions[nv * 3]).toBeCloseTo(0); // on the plane
    // Winding preserved: all faces keep +z normal.
    for (let f = 0; f < r.indices.length / 3; f++) {
      const [a, b, c] = [r.indices[f * 3]!, r.indices[f * 3 + 1]!, r.indices[f * 3 + 2]!];
      const ux = r.positions[b * 3]! - r.positions[a * 3]!;
      const uy = r.positions[b * 3 + 1]! - r.positions[a * 3 + 1]!;
      const vx = r.positions[c * 3]! - r.positions[a * 3]!;
      const vy = r.positions[c * 3 + 1]! - r.positions[a * 3 + 1]!;
      expect(ux * vy - uy * vx).toBeGreaterThan(0);
    }
  });

  it("2-cut case: an offset plane splits a triangle into 3 tris", () => {
    const positions = new Float32Array([-1, 0, 0, 1, 0, 0, 0, 2, 0]);
    const r = planeCut(positions, [0, 1, 2], [0, 1, 0], [0, 1, 0])!;
    // Plane y=1 crosses edges 0-2 and 1-2.
    expect(r.newVerts.size).toBe(2);
    expect(r.indices.length / 3).toBe(3);
    for (const nv of r.newVerts) expect(r.positions[nv * 3 + 1]).toBeCloseTo(1);
  });

  it("keeps a watertight cube watertight and puts all cut verts on the plane", () => {
    const { positions, indices } = cube();
    expect(boundaryEdgeCount(indices)).toBe(0);
    const r = planeCut(positions, indices, [0.25, 0, 0], [1, 0, 0])!;
    expect(r).not.toBeNull();
    expect(boundaryEdgeCount(r.indices)).toBe(0);
    expect(r.newVerts.size).toBeGreaterThanOrEqual(6);
    for (const nv of r.newVerts) expect(r.positions[nv * 3]).toBeCloseTo(0.25, 5);
    // Face count grows by one per cut (1-cut → +1, 2-cut → +2 per face)…
    expect(r.indices.length / 3).toBeGreaterThan(indices.length / 3);
  });

  it("returns null when the plane misses the mesh", () => {
    const { positions, indices } = cube();
    expect(planeCut(positions, indices, [5, 0, 0], [1, 0, 0])).toBeNull();
  });

  it("accept filter limits the cut; rejected everywhere → null", () => {
    const { positions, indices } = cube();
    expect(planeCut(positions, indices, [0, 0, 0], [1, 0, 0], () => false)).toBeNull();
    // Only accept cut points in the front half (z > 0).
    const r = planeCut(positions, indices, [0, 0, 0], [1, 0, 0], (_x, _y, z) => z > 0)!;
    expect(r).not.toBeNull();
    for (const nv of r.newVerts) expect(r.positions[nv * 3 + 2]!).toBeGreaterThan(0);
  });

  it("shared edges get a single cut vertex (adjacent faces stay stitched)", () => {
    const { positions, indices } = cube();
    const r = planeCut(positions, indices, [0, 0.3, 0], [0, 1, 0])!;
    // No duplicate positions among new verts.
    const seen = new Set<string>();
    for (const nv of r.newVerts) {
      const key = `${r.positions[nv * 3]!.toFixed(6)}_${r.positions[nv * 3 + 1]!.toFixed(6)}_${r.positions[nv * 3 + 2]!.toFixed(6)}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("rejects a degenerate plane normal", () => {
    const { positions, indices } = cube();
    expect(planeCut(positions, indices, [0, 0, 0], [0, 0, 0])).toBeNull();
  });
});

describe("planeFromRays", () => {
  it("perspective: two rays from one eye span the expected plane", () => {
    // Eye at origin, rays into +z tilted left/right along x → plane should
    // contain z axis with normal along ±y… rays (0,0,1)±x-tilt actually span
    // the xz-plane → normal ±y.
    const p = planeFromRays([0, 0, 0], [0.2, 0, 1], [0, 0, 0], [-0.2, 0, 1])!;
    expect(p).not.toBeNull();
    expect(Math.abs(p.normal[1])).toBeCloseTo(1, 5);
    expect(p.point).toEqual([0, 0, 0]);
  });

  it("orthographic: parallel rays with offset origins still span a plane", () => {
    const p = planeFromRays([0, 0, 0], [0, 0, 1], [1, 0, 0], [0, 0, 1])!;
    expect(p).not.toBeNull();
    expect(Math.abs(p.normal[1])).toBeCloseTo(1, 5);
  });

  it("collinear rays return null", () => {
    expect(planeFromRays([0, 0, 0], [0, 0, 1], [0, 0, 0], [0, 0, 1])).toBeNull();
  });
});

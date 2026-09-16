/**
 * `symmetrize` and `convexHull` against Blender 5.1.1.
 *
 * The symmetrize direction in particular is measured rather than reasoned
 * about: `'-X'` keeps the negative half, and there is no `'+X'` at all.
 */
import { describe, it, expect } from "vitest";
import type { MeshData } from "../lib/mesh";
import { symmetrize, convexHull, type ConvexHullReport } from "./mesh-ops";

/** Two quads, a small one at x < 0 and a big one at x > 0. */
function lopsided(): MeshData {
  return {
    positions: new Float32Array([
      -2, 0, 0, -1, 0, 0, -1, 1, 0, -2, 1, 0,
      1, 0, 0, 3, 0, 0, 3, 1, 0, 1, 1, 0,
    ]),
    polys: [
      [0, 1, 2, 3],
      [4, 5, 6, 7],
    ],
  };
}

const xs = (m: MeshData): number[] => {
  const out = new Set<number>();
  for (let i = 0; i < m.positions.length; i += 3) out.add(Math.round(m.positions[i]! * 1e4) / 1e4);
  return [...out].sort((a, b) => a - b);
};

describe("symmetrize", () => {
  it("'-X' keeps the negative half and mirrors it", () => {
    // Measured: x values come back -2, -1, 1, 2 — the small quad, twice.
    const out = symmetrize(lopsided(), { direction: "-X" });
    expect(xs(out)).toEqual([-2, -1, 1, 2]);
  });

  it("'X' keeps the positive half", () => {
    // Measured: -3, -1, 1, 3 — the big quad, twice.
    const out = symmetrize(lopsided(), { direction: "X" });
    expect(xs(out)).toEqual([-3, -1, 1, 3]);
  });

  it("works on the other axes", () => {
    const rotated: MeshData = {
      positions: new Float32Array([0, -2, 0, 0, -1, 0, 1, -1, 0, 1, -2, 0]),
      polys: [[0, 1, 2, 3]],
    };
    const out = symmetrize(rotated, { direction: "-Y" });
    const ys = new Set<number>();
    for (let i = 1; i < out.positions.length; i += 3) ys.add(Math.round(out.positions[i]! * 1e4) / 1e4);
    expect([...ys].sort((a, b) => a - b)).toEqual([-2, -1, 1, 2]);
  });
});

describe("convexHull", () => {
  /** Unit cube corners, plus one point buried in the middle. */
  function cubeWithInterior(): MeshData {
    return {
      positions: new Float32Array([
        0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
        0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
        0.5, 0.5, 0.5,
      ]),
      polys: [],
    };
  }

  const blank = (): ConvexHullReport => ({ interior: 0, degenerate: false });

  it("wraps a cube's corners in 12 triangles and drops the interior point", () => {
    const report = blank();
    const hull = convexHull(cubeWithInterior(), report);

    expect(hull.polys).toHaveLength(12);
    for (const poly of hull.polys) expect(poly).toHaveLength(3);
    expect(hull.positions).toHaveLength(24); // 8 corners, not 9
    expect(report.interior).toBe(1);
    expect(report.degenerate).toBe(false);
  });

  it("every face points outward", () => {
    const hull = convexHull(cubeWithInterior());
    const P = hull.positions;
    // The centroid is inside a convex solid, so every face's outward normal
    // must point away from it.
    let cx = 0, cy = 0, cz = 0;
    const n = P.length / 3;
    for (let v = 0; v < n; v++) {
      cx += P[v * 3]!; cy += P[v * 3 + 1]!; cz += P[v * 3 + 2]!;
    }
    cx /= n; cy /= n; cz /= n;

    for (const [a, b, c] of hull.polys as [number, number, number][]) {
      const ux = P[b * 3]! - P[a * 3]!, uy = P[b * 3 + 1]! - P[a * 3 + 1]!, uz = P[b * 3 + 2]! - P[a * 3 + 2]!;
      const vx = P[c * 3]! - P[a * 3]!, vy = P[c * 3 + 1]! - P[a * 3 + 1]!, vz = P[c * 3 + 2]! - P[a * 3 + 2]!;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const dx = P[a * 3]! - cx, dy = P[a * 3 + 1]! - cy, dz = P[a * 3 + 2]! - cz;
      expect(nx * dx + ny * dy + nz * dz).toBeGreaterThan(0);
    }
  });

  it("encloses every input point", () => {
    // 40 points on and inside a sphere: no point may end up outside a face.
    const positions: number[] = [];
    let seed = 12345;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 40; i++) {
      const r = 0.4 + rand() * 0.6;
      const t = rand() * Math.PI * 2;
      const u = rand() * 2 - 1;
      const s = Math.sqrt(1 - u * u);
      positions.push(r * s * Math.cos(t), r * s * Math.sin(t), r * u);
    }
    const input: MeshData = { positions: new Float32Array(positions), polys: [] };
    const hull = convexHull(input);
    const P = hull.positions;

    let worst = -Infinity;
    for (const [a, b, c] of hull.polys as [number, number, number][]) {
      const ux = P[b * 3]! - P[a * 3]!, uy = P[b * 3 + 1]! - P[a * 3 + 1]!, uz = P[b * 3 + 2]! - P[a * 3 + 2]!;
      const vx = P[c * 3]! - P[a * 3]!, vy = P[c * 3 + 1]! - P[a * 3 + 1]!, vz = P[c * 3 + 2]! - P[a * 3 + 2]!;
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      for (let v = 0; v < positions.length / 3; v++) {
        const d =
          (positions[v * 3]! - P[a * 3]!) * nx +
          (positions[v * 3 + 1]! - P[a * 3 + 1]!) * ny +
          (positions[v * 3 + 2]! - P[a * 3 + 2]!) * nz;
        worst = Math.max(worst, d);
      }
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it("says so when the points have no volume", () => {
    const flat: MeshData = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
      polys: [],
    };
    const report = blank();
    const hull = convexHull(flat, report);
    expect(report.degenerate).toBe(true);
    expect(hull.polys).toHaveLength(0);
  });

  it("starts from four points with volume, not the first four in order", () => {
    // The first four here are coplanar; a naive seed tetrahedron fails, and
    // most real meshes start with a flat face.
    const input: MeshData = {
      positions: new Float32Array([
        0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
        0.5, 0.5, 1,
      ]),
      polys: [],
    };
    const report = blank();
    const hull = convexHull(input, report);
    expect(report.degenerate).toBe(false);
    expect(hull.polys.length).toBeGreaterThanOrEqual(4);
  });
});

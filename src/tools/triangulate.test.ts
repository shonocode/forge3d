import { describe, it, expect } from "vitest";
import type { MeshData } from "../lib/mesh";
import { triangulate } from "./triangulate";

/**
 * `triangulate` — `BM_face_triangulate`. The agreement with Blender is the
 * parity rows `triangulate` (FIXED) and `triangulate-beauty` (BEAUTY), both
 * to the vertex set of every face; these check the rules on shapes whose
 * answer can be worked out by hand.
 */

/** A flat rhombus: 0–2 is the long diagonal (4), 1–3 the short one (2). */
const rhombus: MeshData = {
  positions: Float32Array.from([-2, 0, 0, 0, 0, 1, 2, 0, 0, 0, 0, -1]),
  polys: [[0, 1, 2, 3]],
};

const diagonal = (m: MeshData): string => {
  const [a, b] = m.polys as [number[], number[]];
  return a.filter((v) => b.includes(v)).sort().join("-");
};

/** Signed area in the xz plane, for checking that the winding survives. */
const areaY = (m: MeshData, p: number[]): number => {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i]!, b = p[(i + 1) % p.length]!;
    s += m.positions[a * 3 + 2]! * m.positions[b * 3]! - m.positions[a * 3]! * m.positions[b * 3 + 2]!;
  }
  return s / 2;
};

describe("triangulate", () => {
  it("cuts 0–2 with fixed, 1–3 with alternate", () => {
    expect(diagonal(triangulate(rhombus, { quadMethod: "fixed" }))).toBe("0-2");
    expect(diagonal(triangulate(rhombus, { quadMethod: "alternate" }))).toBe("1-3");
  });

  it("takes the better-shaped pair with beauty, which here is the short diagonal", () => {
    // Area over perimeter: 1–3 gives 0.618 against 0–2's 0.472.
    expect(diagonal(triangulate(rhombus))).toBe("1-3");
    expect(diagonal(triangulate(rhombus, { quadMethod: "shortEdge" }))).toBe("1-3");
    expect(diagonal(triangulate(rhombus, { quadMethod: "longEdge" }))).toBe("0-2");
  });

  it("never folds a concave quad, whatever the method prefers", () => {
    // A dart: vertex 1 is pushed past the 0–2 line, so 0–2 lies outside.
    const dart: MeshData = {
      positions: Float32Array.from([-2, 0, 0, 0, 0, -0.5, 2, 0, 0, 0, 0, -1]),
      polys: [[0, 1, 2, 3]],
    };
    expect(diagonal(triangulate(dart))).toBe("1-3");
  });

  it("splits an n-gon into n − 2 triangles that keep its winding and area", () => {
    const n = 7;
    const positions: number[] = [];
    for (let i = 0; i < n; i++) positions.push(Math.cos((2 * Math.PI * i) / n), 0, -Math.sin((2 * Math.PI * i) / n));
    const ngon: MeshData = { positions: Float32Array.from(positions), polys: [[...Array(n).keys()]] };
    for (const ngonMethod of ["beauty", "earClip"] as const) {
      const out = triangulate(ngon, { ngonMethod });
      expect(out.polys).toHaveLength(n - 2);
      const whole = areaY(ngon, ngon.polys[0]!);
      const parts = out.polys.map((t) => areaY(out, t));
      for (const a of parts) expect(Math.sign(a)).toBe(Math.sign(whole));
      expect(parts.reduce((s, a) => s + a, 0)).toBeCloseTo(whole, 5);
    }
  });

  it("leaves triangles and vertices alone", () => {
    const tri: MeshData = { positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 0, 1]), polys: [[0, 1, 2]] };
    const out = triangulate(tri);
    expect(out.polys).toEqual([[0, 1, 2]]);
    expect([...out.positions]).toEqual([...tri.positions]);
  });
});

describe("triangulate carries UVs", () => {
  it("each triangle corner takes the UV of the source corner on the same vertex", () => {
    const src: MeshData = {
      positions: Float32Array.from([0, 0, 0, 2, 0, 0, 2, 0, 1, 0, 0, 1, 1, 0, 1.5]),
      polys: [[0, 1, 2, 3], [3, 2, 4]],
      uvs: [[[0, 0], [1, 0], [1, 0.5], [0, 0.5]], [[0, 0.5], [1, 0.5], [0.5, 0.75]]],
    };
    const uvOfVertex = [[0, 0], [1, 0], [1, 0.5], [0, 0.5], [0.5, 0.75]];
    const out = triangulate(src);
    expect(out.uvs).toHaveLength(out.polys.length);
    out.polys.forEach((p, f) => p.forEach((v, i) => expect(out.uvs![f]![i]).toEqual(uvOfVertex[v])));
  });
});

import { describe, it, expect } from "vitest";
import { booleanBuffers, type RenderBuffer } from "./csg-core";

/**
 * The GUI's CSG path — render buffers through `booleanMesh`. The boolean
 * itself is measured against Blender elsewhere (ADR-012, the `boolean-*`
 * parity rows); these check the buffer handling around it.
 */

/**
 * A box as a renderer holds it: 24 vertices (4 per face, so each face has its
 * own normal and UVs), and — optionally — wound the other way round, as a
 * left-handed renderer's front faces are.
 */
function renderBox(center: number[], size: number, inward: boolean): RenderBuffer {
  const h = size / 2;
  const [cx, cy, cz] = center as [number, number, number];
  const corner = (i: number): number[] => [cx + (i & 1 ? h : -h), cy + (i & 2 ? h : -h), cz + (i & 4 ? h : -h)];
  // outward (right-handed) quads over the corner numbering above
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const polys: number[][] = [];
  quads.forEach((q, fi) => {
    const base = positions.length / 3;
    q.forEach((c, k) => {
      positions.push(...corner(c));
      uvs.push(fi / 6 + (k === 1 || k === 2 ? 1 / 6 : 0), k >= 2 ? 1 : 0);
    });
    const face = inward ? [base, base + 3, base + 2, base + 1] : [base, base + 1, base + 2, base + 3];
    polys.push(face);
    indices.push(face[0]!, face[1]!, face[2]!, face[0]!, face[2]!, face[3]!);
  });
  return { positions, indices, uvs, polys };
}

/** Signed volume of a triangle buffer (right-handed). */
function volume(r: { positions: ArrayLike<number>; indices: ArrayLike<number> }): number {
  let v = 0;
  const P = r.positions;
  for (let t = 0; t < r.indices.length; t += 3) {
    const [a, b, c] = [r.indices[t]! * 3, r.indices[t + 1]! * 3, r.indices[t + 2]! * 3];
    v += (P[a]! * (P[b + 1]! * P[c + 2]! - P[b + 2]! * P[c + 1]!) -
      P[a + 1]! * (P[b]! * P[c + 2]! - P[b + 2]! * P[c]!) +
      P[a + 2]! * (P[b]! * P[c + 1]! - P[b + 1]! * P[c]!)) / 6;
  }
  return v;
}

describe("booleanBuffers", () => {
  // Two unit boxes overlapping in 0.5 × 0.7 × 0.8 = 0.28.
  const A = [0, 0, 0];
  const B = [0.5, 0.3, 0.2];

  for (const inward of [false, true]) {
    it(`computes union, difference and intersection (${inward ? "left-handed" : "right-handed"} winding)`, () => {
      const sign = inward ? -1 : 1;
      const run = (op: "union" | "difference" | "intersect") =>
        booleanBuffers(renderBox(A, 1, inward), renderBox(B, 1, inward), op);
      // The result keeps the inputs' winding, so the signed volume keeps its sign.
      expect(volume(run("union"))).toBeCloseTo(sign * 1.72, 5);
      expect(volume(run("difference"))).toBeCloseTo(sign * 0.72, 5);
      expect(volume(run("intersect"))).toBeCloseTo(sign * 0.28, 5);
    });
  }

  it("welds the render vertices, so a box's faces are its 8 corners", () => {
    // Intersecting a box with a bigger one gives the box back: 6 faces.
    const r = booleanBuffers(renderBox(A, 1, true), renderBox(A, 3, true), "intersect");
    expect(r.faceCount).toBe(6);
    expect(volume(r)).toBeCloseTo(-1, 5);
  });

  it("carries UVs, split at the seams", () => {
    const r = booleanBuffers(renderBox(A, 1, false), renderBox(A, 3, false), "intersect");
    expect(r.uvs).not.toBeNull();
    // Each of the 6 faces keeps its own UV strip, so no two faces share a
    // vertex any more: 24, not 8.
    expect(r.positions.length / 3).toBe(24);
    for (const u of r.uvs!) expect(u).toBeGreaterThanOrEqual(-1e-6);
  });

  it("returns nothing for an intersection of boxes that do not touch", () => {
    const r = booleanBuffers(renderBox(A, 1, false), renderBox([3, 0, 0], 1, false), "intersect");
    expect(r.indices).toHaveLength(0);
  });
});

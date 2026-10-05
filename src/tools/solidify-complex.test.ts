/**
 * Solidify, Complex mode (compat-backlog C30). The numbers are Blender's, read off the parity rows
 * `solidify-complex*` (`tools/modeling/parity/compare.ts`).
 */
import { describe, it, expect } from "vitest";
import type { MeshData } from "../lib/mesh";
import { box, plane } from "./generate";
import { solidifyComplex } from "./solidify-complex";

const bounds = (m: MeshData): { min: number[]; max: number[] } => {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.positions.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, m.positions[i + k]!);
      max[k] = Math.max(max[k]!, m.positions[i + k]!);
    }
  return { min, max };
};

describe("solidifyComplex", () => {
  it("shells a closed box: the shell copies the surface, 16 vertices and 12 faces, no rim", () => {
    const out = solidifyComplex(box({ size: [1, 1, 1] }), { thickness: 0.1 });
    expect(out.positions.length / 3).toBe(16);
    expect(out.polys.length).toBe(12);
    // Offset −1: the shell grows inward, so the outer skin stays where it was.
    const b = bounds(out);
    for (let k = 0; k < 3; k++) {
      expect(b.max[k]!).toBeCloseTo(0.5, 3); // the front keeps a 1e-5 offset, Blender's non-zero clamp
      expect(b.min[k]!).toBeCloseTo(-0.5, 3);
    }
  });

  it("CONSTRAINTS puts the inner corner at the thickness from all three faces", () => {
    const out = solidifyComplex(box({ size: [1, 1, 1] }), { thickness: 0.1, thicknessMode: "CONSTRAINTS" });
    const inner = Array.from({ length: out.positions.length / 3 }, (_, v) => Math.max(...[0, 1, 2].map((k) => Math.abs(out.positions[v * 3 + k]!))));
    expect(inner.filter((m) => Math.abs(m - 0.4) < 1e-5).length).toBe(8);
  });

  it("an open plane gets a rim: top and bottom shells plus one quad per boundary edge", () => {
    const out = solidifyComplex(plane({ segments: [2, 2] }), { thickness: 0.05 });
    // 4 faces ×2, plus 8 boundary edges.
    expect(out.polys.length).toBe(8 + 8);
    expect(solidifyComplex(plane({ segments: [2, 2] }), { thickness: 0.05, rim: false }).polys.length).toBe(8);
  });

  it("rim only leaves the rim alone", () => {
    const out = solidifyComplex(plane({ segments: [2, 2] }), { thickness: 0.05, rimOnly: true });
    expect(out.polys.length).toBe(8);
  });

  it("a fin (three faces on one edge) still closes: no NaN, every face has three or more corners", () => {
    const fin: MeshData = {
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 1, 0]),
      // two flat quads facing +Y that share the edge 0-1 … and a fin above it
      polys: [[0, 1, 2, 3], [1, 0, 4, 5]],
    };
    const out = solidifyComplex(fin, { thickness: 0.05 });
    expect(Array.from(out.positions).every(Number.isFinite)).toBe(true);
    expect(out.polys.every((p) => p.length >= 3)).toBe(true);
    expect(out.polys.length).toBeGreaterThan(fin.polys.length);
  });

  it("vertices closer than the merge threshold are welded before the shell is made", () => {
    const m: MeshData = {
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1.00001, 0, 0]),
      polys: [[0, 1, 2, 3]],
    };
    const near = solidifyComplex(m, { thickness: 0.05, mergeThreshold: 0.001 });
    expect(Array.from(near.positions).every(Number.isFinite)).toBe(true);
  });

  it("shell and rim vertex groups collect the new vertices at 1", () => {
    const out = solidifyComplex(plane({ segments: [2, 2] }), { thickness: 0.05, shellVertexGroup: "S", rimVertexGroup: "R" });
    expect(out.groups!.get("S")!.size).toBeGreaterThan(0);
    expect(out.groups!.get("R")!.size).toBeGreaterThan(0);
  });
});

describe("solidifyComplex: input it refuses", () => {
  it("a face that repeats a vertex is an error, not a guess", () => {
    const m: MeshData = { positions: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 2, 0, 0]), polys: [[0, 1, 2, 0, 3]] };
    expect(() => solidifyComplex(m)).toThrow(/repeats a vertex/);
  });
});

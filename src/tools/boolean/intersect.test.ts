import { describe, it, expect } from "vitest";
import type { MeshData } from "../../lib/mesh";
import { intersect } from "./intersect";

/**
 * `intersect`, against Blender 5.1.1's exact solver (`probe-intersect.py`).
 */

/** Two unit cubes in one mesh, the second moved by `offset`, faces as Blender's `create_cube`. */
function twoCubes(offset: [number, number, number]): MeshData {
  const positions: number[] = [];
  const polys: number[][] = [];
  for (const [ox, oy, oz] of [[0, 0, 0], offset]) {
    const base = positions.length / 3;
    for (const [x, y, z] of [
      [-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, -0.5], [-0.5, 0.5, 0.5],
      [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5],
    ])
      positions.push(x + ox!, y + oy!, z + oz!);
    for (const f of [
      [0, 1, 3, 2], [2, 3, 7, 6], [6, 7, 5, 4], [4, 5, 1, 0], [2, 6, 4, 0], [7, 3, 1, 5],
    ])
      polys.push(f.map((v) => v + base));
  }
  return { positions: Float32Array.from(positions), polys };
}

function sizes(polys: number[][]): Record<number, number> {
  const out: Record<number, number> = {};
  for (const p of polys) out[p.length] = (out[p.length] ?? 0) + 1;
  return out;
}

/** Edges used by more than two faces — the cut edges, when nothing is separated. */
function manyFaceEdges(polys: number[][]): number {
  const count = new Map<string, number>();
  for (const p of polys)
    p.forEach((u, i) => {
      const v = p[(i + 1) % p.length]!;
      const k = u < v ? `${u}_${v}` : `${v}_${u}`;
      count.set(k, (count.get(k) ?? 0) + 1);
    });
  return [...count.values()].filter((c) => c > 2).length;
}

function usedVerts(polys: number[][]): number {
  return new Set(polys.flat()).size;
}

describe("intersect", () => {
  it("cuts two cubes in general position the way Blender does", () => {
    // Blender, separate_mode NONE: 22 v, 36 e, 18 f — 12 quads and 6 hexagons,
    // and the 6 cut edges each shared by four faces.
    const out = intersect(twoCubes([0.5, 0.3, 0.2]));
    expect(out.holes).toEqual([]);
    expect(sizes(out.polys)).toEqual({ 4: 12, 6: 6 });
    expect(usedVerts(out.polys)).toBe(22);
    expect(manyFaceEdges(out.polys)).toBe(6);
  });

  it("cuts only across the two sets in twoSets mode", () => {
    // SELECT_UNSELECT with the second cube selected gives the same faces here:
    // the only intersections are between the two cubes anyway.
    const out = intersect(twoCubes([0.5, 0.3, 0.2]), {
      mode: "twoSets",
      set: new Set([6, 7, 8, 9, 10, 11]),
    });
    expect(sizes(out.polys)).toEqual({ 4: 12, 6: 6 });
    expect(usedVerts(out.polys)).toBe(22);
  });

  it("keeps one copy of a coplanar overlap", () => {
    // Blender: 16 v, 28 e, 16 f, all quads, 8 edges on more than two faces.
    // Each of the four shared planes is cut at x = 0 and x = 0.5, and the
    // overlapping piece — produced by both cubes, with the same four
    // vertices — appears **once**: 4 × 3 + 4 end faces = 16. Keeping both
    // copies gives 20, which is what the first version did.
    const out = intersect(twoCubes([0.5, 0, 0]));
    expect(sizes(out.polys)).toEqual({ 4: 16 });
    expect(usedVerts(out.polys)).toBe(16);
    expect(manyFaceEdges(out.polys)).toBe(8);
  });

  it("leaves a mesh that does not touch itself alone", () => {
    const out = intersect(twoCubes([3, 0, 0]));
    expect(sizes(out.polys)).toEqual({ 4: 12 });
    expect(usedVerts(out.polys)).toBe(16);
  });
});

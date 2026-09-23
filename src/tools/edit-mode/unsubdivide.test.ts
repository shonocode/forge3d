import { describe, it, expect } from "vitest";
import type { MeshData } from "../../lib/mesh";
import { unsubdivide } from "./unsubdivide";

/**
 * `unsubdivide`, against Blender.
 *
 * Every count here is Blender 5.1.1, printed by
 * `tools/modeling/parity/probe-unsubdivide.py`.
 */

/** An `n` by `n` grid of quads, so `(n+1)^2` vertices. */
function grid(n: number, size = 0.1 * n): MeshData {
  const step = size / n;
  const positions: number[] = [];
  for (let r = 0; r <= n; r++)
    for (let c = 0; c <= n; c++) positions.push(c * step - size / 2, 0, r * step - size / 2);
  const polys: number[][] = [];
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      polys.push([
        r * (n + 1) + c,
        (r + 1) * (n + 1) + c,
        (r + 1) * (n + 1) + c + 1,
        r * (n + 1) + c + 1,
      ]);
  return { positions: Float32Array.from(positions), polys };
}

function triangulated(n: number): MeshData {
  const g = grid(n);
  const polys: number[][] = [];
  for (const q of g.polys) {
    polys.push([q[0]!, q[1]!, q[2]!]);
    polys.push([q[0]!, q[2]!, q[3]!]);
  }
  return { positions: g.positions, polys };
}

const counts = (m: MeshData): [number, number] => [m.positions.length / 3, m.polys.length];

describe("unsubdivide", () => {
  it("halves a grid and keeps its corners", () => {
    // Measured: 2x2 9 -> 8 verts and 4 -> 5 faces; 3x3 16 -> 10 and 9 -> 8;
    // 4x4 25 -> 16 and 16 -> 13; 5x5 36 -> 20 and 25 -> 18;
    // 6x6 49 -> 28 and 36 -> 25.
    for (const [n, verts, faces] of [
      [2, 8, 5],
      [3, 10, 8],
      [4, 16, 13],
      [5, 20, 18],
      [6, 28, 25],
    ]) {
      expect(counts(unsubdivide(grid(n!))), `grid ${n}`).toEqual([verts, faces]);
    }
  });

  it("dissolves the (i+j) even side of a grid, corners aside", () => {
    // The rule is "the first eligible vertex in index order is kept", and on a
    // grid that comes out as the even side going. The corners are not eligible
    // at all — two boundary edges is none of the five cases — so they stay.
    const before = grid(4);
    const after = unsubdivide(before);
    const kept = new Set<string>();
    for (let v = 0; v < after.positions.length / 3; v++)
      kept.add(
        [0, 1, 2].map((k) => after.positions[v * 3 + k]!.toFixed(6)).join(" "),
      );
    const gone: number[] = [];
    for (let v = 0; v < 25; v++) {
      const at = [0, 1, 2].map((k) => before.positions[v * 3 + k]!.toFixed(6)).join(" ");
      if (!kept.has(at)) gone.push(v);
    }
    expect(gone).toEqual([2, 6, 8, 10, 12, 14, 16, 18, 22]);
    for (const corner of [0, 4, 20, 24]) expect(gone).not.toContain(corner);
  });

  it("leaves a triangle mesh completely alone", () => {
    // Not because a checkerboard cannot be two-coloured — because nothing is
    // eligible. A triangulated grid's interior vertices have six edges and its
    // boundary vertices have two boundary edges plus more. Measured: 25 verts
    // and 32 faces in, the same out, and the same for an icosphere.
    expect(counts(unsubdivide(triangulated(4)))).toEqual([25, 32]);
  });

  it("stops when a pass finds nothing left to dissolve", () => {
    // Measured on an 8x8 grid: 44 verts after one pass, 32 after two, 27 after
    // three, and 27 after four — the fourth pass marks nothing and stops.
    expect(counts(unsubdivide(grid(8), { iterations: 1 }))[0]).toBe(44);
    expect(counts(unsubdivide(grid(8), { iterations: 2 }))[0]).toBe(32);
    expect(counts(unsubdivide(grid(8), { iterations: 3 }))[0]).toBe(27);
    expect(counts(unsubdivide(grid(8), { iterations: 4 }))[0]).toBe(27);
  });

  it("moves nothing — every surviving vertex keeps its position", () => {
    const before = grid(4);
    const after = unsubdivide(before);
    const was = new Set<string>();
    for (let v = 0; v < 25; v++)
      was.add([0, 1, 2].map((k) => before.positions[v * 3 + k]!.toFixed(6)).join(" "));
    for (let v = 0; v < after.positions.length / 3; v++)
      expect(
        was.has([0, 1, 2].map((k) => after.positions[v * 3 + k]!.toFixed(6)).join(" ")),
        `vertex ${v}`,
      ).toBe(true);
  });

  it("leaves a mesh with nothing eligible untouched, whatever the iterations", () => {
    const tri = triangulated(4);
    expect(counts(unsubdivide(tri, { iterations: 5 }))).toEqual([25, 32]);
  });

  it("keeps the winding — the merged face is not inside out", () => {
    // The ring of a dissolved fan has two orderings, the same vertices either
    // way, and picking the wrong one turns the mesh inside out while **every
    // distance measure still reads 0.0000 mm**. The parity harness caught it
    // on signed volume; this pins it here, where it is cheaper to see.
    const cube: MeshData = {
      positions: Float32Array.from([
        -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
        -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
      ]),
      // wound outward
      polys: [
        [0, 3, 2, 1],
        [4, 5, 6, 7],
        [0, 1, 5, 4],
        [1, 2, 6, 5],
        [2, 3, 7, 6],
        [3, 0, 4, 7],
      ],
    };
    const signedVolume = (m: MeshData): number => {
      let sum = 0;
      for (const poly of m.polys)
        for (let i = 1; i + 1 < poly.length; i++) {
          const [a, b, c] = [poly[0]!, poly[i]!, poly[i + 1]!];
          const p = [0, 1, 2].map((k) => m.positions[a * 3 + k]!);
          const q = [0, 1, 2].map((k) => m.positions[b * 3 + k]!);
          const r = [0, 1, 2].map((k) => m.positions[c * 3 + k]!);
          sum +=
            (p[0]! * (q[1]! * r[2]! - q[2]! * r[1]!) -
              p[1]! * (q[0]! * r[2]! - q[2]! * r[0]!) +
              p[2]! * (q[0]! * r[1]! - q[1]! * r[0]!)) /
            6;
        }
      return sum;
    };
    expect(signedVolume(cube)).toBeCloseTo(1, 6);
    const out = unsubdivide(cube);
    // Measured against Blender: a cube's eight corners all have three
    // manifold edges, so four of them dissolve and a tetrahedron is left.
    expect(counts(out)).toEqual([4, 4]);
    expect(signedVolume(out)).toBeGreaterThan(0);
    expect(signedVolume(out)).toBeCloseTo(0.333333, 5);
  });
});

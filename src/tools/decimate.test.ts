import { describe, it, expect } from "vitest";
import { decimateCollapse } from "./decimate";
import { sphere, box } from "./generate";
import type { MeshData } from "../lib/mesh";

/**
 * `decimateCollapse` — Blender's Decimate ▸ Collapse, ported. The agreement
 * with Blender is the parity row `decimate-collapse` (and
 * `probe-decimate-collapse.py`, 18 cases over four ratios, every vertex
 * 0.0000 mm); the counts below are Blender's, copied from those runs.
 */

/**
 * The parity input `grid`: 5×5 vertices 0.1 apart on y = 0. The coordinates
 * are written out rather than computed — `3 * 0.1 - 0.2` is not the `0.1` the
 * OBJ carries, and a flat grid's answer is decided by ties.
 */
function flatGrid(): MeshData {
  const at = [-0.2, -0.1, 0, 0.1, 0.2];
  const positions: number[] = [];
  for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) positions.push(at[i]!, 0, at[j]!);
  const polys: number[][] = [];
  for (let j = 0; j < 4; j++)
    for (let i = 0; i < 4; i++) {
      const a = j * 5 + i;
      polys.push([a, a + 5, a + 6, a + 1]);
    }
  return { positions: Float32Array.from(positions), polys };
}

/** The parity input `cube`. */
function cube(): MeshData {
  return {
    positions: Float32Array.from([
      -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
      -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
    ]),
    polys: [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]],
  };
}

const triCount = (m: MeshData): number => m.polys.reduce((sum, p) => sum + p.length - 2, 0);
/** "4x3 2x4": how many faces of each size. */
function sizes(m: MeshData): string {
  const c = new Map<number, number>();
  for (const p of m.polys) c.set(p.length, (c.get(p.length) ?? 0) + 1);
  return [...c].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${v}x${k}`).join(" ");
}

describe("decimateCollapse", () => {
  it("gives Blender's counts on a flat grid, where only topology decides", () => {
    // Every quadric cost on a flat sheet is zero, so the order comes from the
    // topology fallback and the heap's ties — the hardest case to match.
    const out3 = decimateCollapse(flatGrid(), { ratio: 0.3 });
    expect([out3.positions.length / 3, sizes(out3)]).toEqual([9, "7x3 1x4"]);
    const out8 = decimateCollapse(flatGrid(), { ratio: 0.8 });
    expect([out8.positions.length / 3, sizes(out8)]).toEqual([20, "4x3 10x4"]);
    for (let i = 1; i < out8.positions.length; i += 3) expect(Math.abs(out8.positions[i]!)).toBe(0);
  });

  it("joins the surviving triangles of a quad back into it", () => {
    const out = decimateCollapse(cube(), { ratio: 0.8 });
    expect([out.positions.length / 3, sizes(out)]).toEqual([6, "4x3 2x4"]);
    // …and leaves them as triangles when asked.
    const tris = decimateCollapse(cube(), { ratio: 0.8, triangulate: true });
    expect(tris.polys.every((p) => p.length === 3)).toBe(true);
    expect(tris.positions.length / 3).toBe(6);
  });

  it("returns the input at ratio 1, as the modifier does", () => {
    const g = flatGrid();
    const out = decimateCollapse(g, { ratio: 1 });
    expect(out.polys).toEqual(g.polys);
    expect([...out.positions]).toEqual([...g.positions]);
  });

  it("bottoms a closed shell out at two triangles, like Blender", () => {
    // Blender takes a 12-triangle cube to 2 triangles over 3 vertices for
    // every ratio from 0.25 down to 0 (probe-decimate3.py).
    for (const ratio of [0.25, 0.1, 0.05, 0]) {
      const out = decimateCollapse(box({ width: 1, height: 1, depth: 1 }), { ratio });
      expect(triCount(out), `ratio ${ratio}`).toBe(2);
      expect(out.positions.length / 3, `ratio ${ratio}`).toBe(3);
    }
  });

  it("lets an open sheet go all the way, like Blender", () => {
    expect(triCount(decimateCollapse(flatGrid(), { ratio: 0 }))).toBe(0);
  });

  it("uses every vertex it returns", () => {
    const out = decimateCollapse(sphere({ segments: 16, rings: 8, radius: 1 }), { ratio: 0.4 });
    const used = new Set(out.polys.flat());
    expect(used.size).toBe(out.positions.length / 3);
  });

  it("is deterministic", () => {
    const s = sphere({ segments: 16, rings: 8, radius: 1 });
    const a = decimateCollapse(s, { ratio: 0.45 });
    const b = decimateCollapse(s, { ratio: 0.45 });
    expect([...a.positions]).toEqual([...b.positions]);
    expect(a.polys).toEqual(b.polys);
  });
});

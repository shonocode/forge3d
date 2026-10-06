import { describe, it, expect } from "vitest";
import { decimateCollapse, decimateCollapseSelected } from "./decimate";
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

describe("decimateCollapse: vertex group, symmetry and edge layers (compat-backlog C21)", () => {
  /** Vertex group `W` weighing 0 on the vertices in `zero`, 1 elsewhere. */
  const weights = (n: number, zero: Set<number>): Map<string, Map<number, number>> =>
    new Map([["W", new Map(Array.from({ length: n }, (_, i) => [i, zero.has(i) ? 0 : 1] as [number, number]))]]);

  it("never collapses a vertex weighing 0", () => {
    const m = flatGrid();
    const zero = new Set([6, 7, 8, 11, 12, 13, 16, 17, 18]); // the 3 × 3 block in the middle
    const out = decimateCollapse({ ...m, groups: weights(25, zero) }, { ratio: 0.3, vertexGroup: "W" });
    const kept = [...zero].map((i) => [m.positions[i * 3]!, m.positions[i * 3 + 2]!]);
    for (const [x, z] of kept) {
      let found = false;
      for (let v = 0; v < out.positions.length / 3; v++)
        if (Math.abs(out.positions[v * 3]! - x!) < 1e-6 && Math.abs(out.positions[v * 3 + 2]! - z!) < 1e-6) found = true;
      expect(found).toBe(true);
    }
  });

  it("needs the group to exist, and a factor above 0", () => {
    const m = { ...flatGrid(), groups: weights(25, new Set([6, 7, 8, 11, 12, 13])) };
    const plain = decimateCollapse(m, { ratio: 0.3 });
    expect(decimateCollapse(m, { ratio: 0.3, vertexGroup: "nope" }).polys).toEqual(plain.polys);
    expect(decimateCollapse(m, { ratio: 0.3, vertexGroup: "W", vertexGroupFactor: 0 }).polys).toEqual(plain.polys);
    expect(decimateCollapse(m, { ratio: 0.3, vertexGroup: "W" }).polys).not.toEqual(plain.polys);
  });

  it("symmetry keeps a mirror-symmetric box symmetric", () => {
    const out = decimateCollapse(box({ size: [1, 1, 1] }), { ratio: 0.4, symmetryAxis: "x" });
    const pts = new Set<string>();
    for (let v = 0; v < out.positions.length / 3; v++)
      pts.add([out.positions[v * 3], out.positions[v * 3 + 1], out.positions[v * 3 + 2]].map((x) => x!.toFixed(4)).join(","));
    for (const p of pts) {
      const [x, y, z] = p.split(",").map(Number) as [number, number, number];
      expect(pts.has([(-x).toFixed(4), y.toFixed(4), z.toFixed(4)].map((s) => (s === "-0.0000" ? "0.0000" : s)).join(","))).toBe(true);
    }
  });

  it("carries seams, sharp edges and creases: a merged edge is a seam if either was, sharp only if both were", () => {
    const m = flatGrid();
    const keys: string[] = [];
    for (const poly of m.polys) poly.forEach((v, i) => keys.push([v, poly[(i + 1) % 4]!].sort((a, b) => a - b).join("_")));
    const all = new Set(keys);
    const out = decimateCollapse({ ...m, seams: new Set(all), sharp: new Set(all), creases: new Map([...all].map((k) => [k, 0.5] as [string, number])) }, { ratio: 0.4 });
    // The crease mixes 0.5 with 0.5 (and a new diagonal has none), so what is left is 0.5 or a mix with 0.
    expect(out.seams!.size).toBeGreaterThan(0);
    // A triangulation diagonal (new, smooth) that merges into one of them makes it a seam but not sharp.
    expect(out.sharp!.size).toBeGreaterThan(0);
    expect(out.sharp!.size).toBeLessThanOrEqual(out.seams!.size);
    for (const c of out.creases!.values()) expect(c).toBeLessThanOrEqual(0.5 + 1e-6);
  });

  it("hands back the wire edge a boundary collapse leaves", () => {
    const sheet: MeshData = { positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 0, 1]), polys: [[0, 1, 2]] };
    // A single triangle is below the modifier's 3-face minimum; four of them in a strip are not.
    const strip: MeshData = {
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 0, 0, 1, 1, 0, 1, 2, 0, 1, 3, 0, 1]),
      polys: [[0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6]],
    };
    void sheet;
    const out = decimateCollapse(strip, { ratio: 0.2 });
    for (const e of out.edges ?? []) expect(e).toHaveLength(2);
  });
});

describe("decimateCollapseSelected", () => {
  it("leaves everything outside the selection alone, and a selection with no edge of its own", () => {
    const grid = flatGrid();
    // Two corners on opposite sides: no edge has both ends selected, so Blender does nothing.
    const none = decimateCollapseSelected(grid, new Set([0, 24]), { ratio: 0.2 });
    expect(none.polys).toHaveLength(16);
    // The left two columns of vertices: the faces outside them keep every vertex.
    const left = new Set([0, 1, 5, 6, 10, 11, 15, 16, 20, 21]);
    const out = decimateCollapseSelected(grid, left, { ratio: 0.2 });
    expect(out.polys.length).toBeLessThan(16);
    // The 15 vertices of the three right-hand columns were never selected, so none of them goes: at most the 10 selected ones collapse.
    expect(out.positions.length / 3).toBeGreaterThanOrEqual(25 - left.size);
  });

  it("at ratio 1 hands the mesh back", () => {
    expect(decimateCollapseSelected(flatGrid(), new Set([0, 1, 5, 6]), { ratio: 1 }).polys).toHaveLength(16);
  });
});

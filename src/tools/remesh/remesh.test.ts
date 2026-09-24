import { describe, it, expect } from "vitest";
import type { MeshData } from "../../lib/mesh";
import { remesh } from "./remesh";

/**
 * `remesh`, against Blender 5.1.1's Remesh modifier (dualcon modes). The
 * counts come from `probe-remesh.py` and the parity rows `remesh-*`.
 */

/** A unit cube as Blender's `create_cube` winds it. */
function cube(offset = [0, 0, 0], size = 1): MeshData {
  const positions: number[] = [];
  for (const [x, y, z] of [
    [-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, -0.5], [-0.5, 0.5, 0.5],
    [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5],
  ])
    positions.push(offset[0]! + x! * size, offset[1]! + y! * size, offset[2]! + z! * size);
  return {
    positions: Float32Array.from(positions),
    polys: [[0, 1, 3, 2], [2, 3, 7, 6], [6, 7, 5, 4], [4, 5, 1, 0], [2, 6, 4, 0], [7, 3, 1, 5]],
  };
}

const join = (a: MeshData, b: MeshData): MeshData => ({
  positions: Float32Array.from([...a.positions, ...b.positions]),
  polys: [...a.polys, ...b.polys.map((p) => p.map((v) => v + a.positions.length / 3))],
});

/** Edges used by exactly two faces, and by any other number. */
function edgeUse(polys: number[][]): { two: number; other: number } {
  const count = new Map<string, number>();
  for (const p of polys)
    p.forEach((u, i) => {
      const v = p[(i + 1) % p.length]!;
      const k = u < v ? `${u}_${v}` : `${v}_${u}`;
      count.set(k, (count.get(k) ?? 0) + 1);
    });
  let two = 0;
  let other = 0;
  for (const c of count.values()) if (c === 2) two++;
  else other++;
  return { two, other };
}

describe("remesh", () => {
  it("remeshes a cube into Blender's quads, depth by depth", () => {
    // probe-remesh.py: 56/54, 296/294, 1352/1350 — the same in every mode.
    for (const [depth, v, f] of [[2, 56, 54], [3, 296, 294], [4, 1352, 1350]] as const) {
      for (const mode of ["blocks", "smooth", "sharp"] as const) {
        const out = remesh(cube(), { mode, octreeDepth: depth });
        expect([out.positions.length / 3, out.polys.length]).toEqual([v, f]);
        expect(out.polys.every((p) => p.length === 4)).toBe(true);
      }
    }
  });

  it("closes an open mesh: the holes are traced and patched", () => {
    const open = cube();
    open.polys = open.polys.slice(1); // one face missing
    const out = remesh(open, { mode: "smooth", octreeDepth: 3 });
    expect(edgeUse(out.polys).other).toBe(0);
    expect(out.positions.length / 3).toBe(out.polys.length + 2); // genus 0
  });

  it("puts Blocks vertices on the cell grid and Smooth ones on the surface", () => {
    const blocks = remesh(cube(), { mode: "blocks", octreeDepth: 3 });
    const smooth = remesh(cube(), { mode: "smooth", octreeDepth: 3 });
    // Smooth: every vertex is an average of crossings of the cube's faces —
    // inside the cube, and on its surface where a cell meets only one face
    // (in a corner cell the average of crossings on three faces is inside).
    const P = Array.from(smooth.positions, Math.abs);
    expect(Math.max(...P)).toBeCloseTo(0.5, 5);
    expect(P.every((c) => c <= 0.5 + 1e-6)).toBe(true);
    // Blocks: the grid is 1/0.9 wide in 8 cells, so the outermost cell centres
    // sit at ±(1/0.9)(0.5 − 1/16) = ±0.4861.
    const B = Array.from(blocks.positions, Math.abs);
    expect(Math.max(...B)).toBeCloseTo((1 / 0.9) * (0.5 - 1 / 16), 5);
  });

  it("drops the smaller of two pieces unless told to keep it", () => {
    const two = join(cube(), cube([2, 0, 0], 0.5));
    const kept = remesh(two, { mode: "smooth", octreeDepth: 4, removeDisconnected: false });
    const dropped = remesh(two, { mode: "smooth", octreeDepth: 4 });
    expect(dropped.polys.length).toBeLessThan(kept.polys.length);
    expect(edgeUse(dropped.polys).other).toBe(0);
  });

  it("refuses a zero scale, as the modifier does", () => {
    expect(() => remesh(cube(), { mode: "blocks", scale: 0 })).toThrow(/zero scale/);
  });
});

import { describe, it, expect } from "vitest";
import { decimateCollapse } from "./decimate";
import { sphere, box } from "./generate";
import type { MeshData } from "../lib/mesh";

/** An n×n quad grid in the XY plane spanning ±size/2, with a bump pattern. */
function grid(n: number, size: number, height = 0): MeshData {
  const positions: number[] = [];
  const step = size / n;
  for (let r = 0; r <= n; r++)
    for (let c = 0; c <= n; c++)
      positions.push(c * step - size / 2, r * step - size / 2, height * (((r * 7 + c * 13) % 11) / 11));
  const polys: number[][] = [];
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      polys.push([r * (n + 1) + c, r * (n + 1) + c + 1, (r + 1) * (n + 1) + c + 1, (r + 1) * (n + 1) + c]);
  return { positions: new Float32Array(positions), polys };
}

const triCount = (m: MeshData): number =>
  m.polys.reduce((sum, p) => sum + p.length - 2, 0);

/** The largest distance from any vertex of `b` to the nearest vertex of `a`. */
function maxDrift(a: MeshData, b: MeshData): number {
  let worst = 0;
  for (let j = 0; j < b.positions.length / 3; j++) {
    let best = Infinity;
    for (let i = 0; i < a.positions.length / 3; i++) {
      const d = Math.hypot(
        a.positions[i * 3]! - b.positions[j * 3]!,
        a.positions[i * 3 + 1]! - b.positions[j * 3 + 1]!,
        a.positions[i * 3 + 2]! - b.positions[j * 3 + 2]!,
      );
      if (d < best) best = d;
    }
    if (best > worst) worst = best;
  }
  return worst;
}

describe("decimateCollapse", () => {
  it("counts triangles, not faces", () => {
    // Blender's `ratio` is measured against the triangle count: a 32-triangle
    // grid at 0.5 comes back with 16 whether it went in as quads or triangles.
    const quads = grid(4, 1, 0.05);
    expect(triCount(quads)).toBe(32);
    expect(triCount(decimateCollapse(quads, { ratio: 0.5 }))).toBeLessThanOrEqual(16);
    expect(triCount(decimateCollapse(quads, { ratio: 0.25 }))).toBeLessThanOrEqual(8);
  });

  it("rounds the target down", () => {
    // 32 × 0.1 is 3.2, and Blender comes back with 3.
    const out = decimateCollapse(grid(4, 1, 0.05), { ratio: 0.1 });
    expect(triCount(out)).toBeLessThanOrEqual(3);
  });

  it("returns the triangulated input at ratio 1", () => {
    const before = grid(3, 1, 0.05);
    const out = decimateCollapse(before, { ratio: 1 });
    expect(triCount(out)).toBe(triCount(before));
    expect(out.polys.every((p) => p.length === 3)).toBe(true);
  });

  it("leaves every output vertex on or near the original surface", () => {
    // The point of a quadric: the cheap collapses are the ones that do not
    // move the surface. On a sphere of radius 1 halved, nothing should have
    // wandered far from where the original vertices were.
    const s = sphere({ segments: 24, rings: 12, radius: 1 });
    const out = decimateCollapse(s, { ratio: 0.5 });
    expect(maxDrift(s, out)).toBeLessThan(0.15);
  });

  it("keeps a sheet's outline until the inside is gone", () => {
    // Boundary vertices carry an extra plane, so they are expensive. A flat
    // grid taken down hard should still have its four corners.
    const g = grid(6, 2);
    const out = decimateCollapse(g, { ratio: 0.2 });
    const corners: Array<[number, number]> = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (const [x, y] of corners) {
      let found = false;
      for (let v = 0; v < out.positions.length / 3; v++)
        if (
          Math.abs(out.positions[v * 3]! - x) < 1e-5 &&
          Math.abs(out.positions[v * 3 + 1]! - y) < 1e-5
        )
          found = true;
      expect(found, `corner (${x}, ${y})`).toBe(true);
    }
  });

  it("emits only triangles, and only vertices it uses", () => {
    const out = decimateCollapse(sphere({ segments: 16, rings: 8, radius: 1 }), { ratio: 0.4 });
    expect(out.polys.every((p) => p.length === 3)).toBe(true);
    const used = new Set(out.polys.flat());
    expect(used.size).toBe(out.positions.length / 3);
    // …and no triangle refers to a vertex that is not there.
    for (const v of used) expect(v).toBeLessThan(out.positions.length / 3);
  });

  it("bottoms a closed shell out at two triangles, like Blender", () => {
    // Measured, not guessed — the first version of this test asserted "at
    // least four" from intuition and the implementation returned zero.
    // Blender takes a 12-triangle cube to 2 triangles over 3 vertices for
    // every ratio from 0.25 down to 0, and refuses to go further:
    // probe-decimate3.py.
    for (const ratio of [0.25, 0.1, 0.05, 0]) {
      const out = decimateCollapse(box({ width: 1, height: 1, depth: 1 }), { ratio });
      expect(triCount(out), `ratio ${ratio}`).toBe(2);
      expect(out.positions.length / 3, `ratio ${ratio}`).toBe(3);
    }
  });

  it("lets an open sheet go all the way, like Blender", () => {
    // The other half of the same measurement: a flat grid has no closed-shell
    // floor and Blender takes it to nothing at ratio 0.
    const out = decimateCollapse(grid(6, 2), { ratio: 0 });
    expect(triCount(out)).toBe(0);
  });

  it("is deterministic", () => {
    // Blender's is — five runs of the same input agree exactly — so a
    // different answer run to run would be this side's bug, not a fact of life.
    const s = sphere({ segments: 16, rings: 8, radius: 1 });
    const a = decimateCollapse(s, { ratio: 0.45 });
    const b = decimateCollapse(s, { ratio: 0.45 });
    expect([...a.positions]).toEqual([...b.positions]);
    expect(a.polys).toEqual(b.polys);
  });
});

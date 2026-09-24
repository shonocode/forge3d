import { describe, it, expect } from "vitest";
import { meshFromData, meshToData } from "../../lib/mesh";
import { extrudeRepeat } from "./face-transform";

/** A 2x2 grid of quads in y = 0, facing +y. */
function grid() {
  const positions: number[] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) positions.push(c, 0, r);
  const polys: number[][] = [];
  for (let r = 0; r < 2; r++)
    for (let c = 0; c < 2; c++) polys.push([r * 3 + c, (r + 1) * 3 + c, (r + 1) * 3 + c + 1, r * 3 + c + 1]);
  return { positions: Float32Array.from(positions), polys };
}

describe("extrudeRepeat", () => {
  it("stacks the region `steps` times, each moved by the offset", () => {
    const em = meshFromData(grid());
    extrudeRepeat(em, new Set([0, 1, 2, 3]), { steps: 3, offset: [0, 0.5, 0] });
    const out = meshToData(em);
    const ys = new Set<number>();
    for (let i = 1; i < out.positions.length; i += 3) ys.add(Math.round(out.positions[i]! * 100) / 100);
    expect([...ys].sort()).toEqual([0, 0.5, 1, 1.5]);
  });

  it("keeps a whole open sheet's originals at the first step, so it becomes a solid", () => {
    // Blender, 4×4 grid, every face: 25 → 50 → 66 → 82 vertices
    // (`probe-extrude-repeat2.py`). The region borders no face outside it, so
    // the first extrusion keeps the originals; later steps extrude the cap,
    // which does border the walls.
    const n = 4;
    const positions: number[] = [];
    for (let r = 0; r <= n; r++) for (let c = 0; c <= n; c++) positions.push(c, 0, r);
    const polys: number[][] = [];
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++) polys.push([r * 5 + c, (r + 1) * 5 + c, (r + 1) * 5 + c + 1, r * 5 + c + 1]);
    const counts = [1, 2, 3].map((steps) => {
      const em = meshFromData({ positions: Float32Array.from(positions), polys });
      extrudeRepeat(em, new Set(polys.map((_, i) => i)), { steps, offset: [0, 0.1, 0] });
      const out = meshToData(em);
      return [out.positions.length / 3, out.polys.length];
    });
    expect(counts).toEqual([
      [50, 48],
      [66, 64],
      [82, 80],
    ]);
  });

  it("leaves no vertex behind inside the old region", () => {
    // The grid's middle vertex is interior to the region: Blender takes it
    // along with the faces, so none of the three copies of it stays loose.
    const em = meshFromData(grid());
    extrudeRepeat(em, new Set([0, 1, 2, 3]), { steps: 3, offset: [0, 0.5, 0] });
    const out = meshToData(em);
    const used = new Set(out.polys.flat());
    expect(used.size).toBe(out.positions.length / 3);
  });
});

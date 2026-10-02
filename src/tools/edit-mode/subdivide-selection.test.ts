/**
 * `subdivideSelection` (`bpy.ops.mesh.subdivide`) and `subdivideEdges`' fractal
 * (compat-backlog C15). The fractal arithmetic is pinned by the parity rows
 * `subdivide-edges-fractal*` and `subdivide-bpy*`; the numbers here are what
 * `probe-subdivide-fractal.py` read off Blender 5.1.1, and the properties the
 * operator's choices are meant to give.
 */
import { describe, it, expect } from "vitest";
import { meshFromData, meshToData } from "../../lib/mesh";
import { rngSrandom } from "../blender-rng";
import { subdivideEdges, subdivideSelection } from "./refine";

/** A unit quad in the XY plane, facing +Z. */
function quad() {
  return { positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), polys: [[0, 1, 2, 3]] };
}
const allEdges = (em: ReturnType<typeof meshFromData>): Set<number> => new Set(em.halfEdges.map((_, i) => i));

describe("BlenderRng (BLI_rng_new_srandom)", () => {
  it("gives the numbers the Subdivide fractal's offsets are made of", () => {
    // Pinned from the generator that reproduced Blender's cut points to the last bit.
    expect(rngSrandom(0).float()).toBeCloseTo(0.29383063316345215, 12);
    const r = rngSrandom(3);
    expect([r.float(), r.float(), r.float()]).toEqual([0.2780737578868866, 0.38831156492233276, 0.5517542958259583].map(Math.fround));
    expect(rngSrandom(255).float()).toBeCloseTo(0.6556839346885681, 12);
  });
});

describe("subdivideEdges fractal", () => {
  const run = (seed: number, alongNormal = 0) => {
    const em = meshFromData(quad());
    subdivideEdges(em, allEdges(em), { cuts: 1, useGridFill: true, fractal: 0.2, alongNormal, seed });
    return meshToData(em).positions;
  };

  it("is deterministic and the seed changes it", () => {
    expect(Array.from(run(3))).toEqual(Array.from(run(3)));
    expect(Array.from(run(3))).not.toEqual(Array.from(run(4)));
  });

  it("moves the corners of a cut edge too (alter_co at 0 and 1), and nothing without it", () => {
    const flat = meshFromData(quad());
    subdivideEdges(flat, allEdges(flat), { cuts: 1, useGridFill: true });
    expect(Array.from(meshToData(flat).positions.slice(0, 12))).toEqual(Array.from(quad().positions));
    expect(Array.from(run(3).slice(0, 12))).not.toEqual(Array.from(quad().positions));
  });

  it("with along_normal 1 pushes along the normal only — a flat sheet stays flat in XY", () => {
    const p = run(3, 1);
    // The sheet faces +Z; every vertex of a 1-cut quad lies on its original lines, shifted in z only.
    for (let v = 0; v < p.length / 3; v++) {
      const x = p[v * 3]!;
      const y = p[v * 3 + 1]!;
      const onGrid = [0, 0.5, 1].some((g) => Math.abs(x - g) < 1e-5) && [0, 0.5, 1].some((g) => Math.abs(y - g) < 1e-5);
      expect(onGrid).toBe(true);
    }
  });
});

describe("subdivideSelection (the operator's choices)", () => {
  it("fills the grid by default — a quad with its four edges cut becomes four", () => {
    const em = meshFromData(quad());
    subdivideSelection(em, allEdges(em));
    expect(meshToData(em).polys).toHaveLength(4);
  });

  it("divides fractal by 2.5 (the operator does) — same as the op with fractal / 2.5", () => {
    const a = meshFromData(quad());
    subdivideSelection(a, allEdges(a), { fractal: 1, seed: 5 });
    const b = meshFromData(quad());
    subdivideEdges(b, allEdges(b), { cuts: 1, useGridFill: true, smoothFalloff: "LINEAR", fractal: Math.fround(1 / 2.5), seed: 5 });
    expect(Array.from(meshToData(a).positions)).toEqual(Array.from(meshToData(b).positions));
  });

  it("with ngon off, one cut edge fans (use_single_edge) instead of growing a pentagon", () => {
    const one = (ngon: boolean) => {
      const em = meshFromData(quad());
      const first = new Set([0]);
      subdivideSelection(em, first, { ngon });
      return meshToData(em).polys.map((p) => p.length).sort();
    };
    expect(one(true)).toEqual([5]);
    expect(one(false)).toEqual([3, 3, 3]);
  });
});

import { describe, it, expect } from "vitest";
import { computeFalloffWeights } from "./proportional";

/** Verts on the X axis at integer positions 0..4. */
const LINE = new Float32Array([
  0, 0, 0,
  1, 0, 0,
  2, 0, 0,
  3, 0, 0,
  4, 0, 0,
]);

describe("computeFalloffWeights", () => {
  it("seeds get weight 1; verts beyond the radius are omitted", () => {
    const w = computeFalloffWeights(LINE, [0], 1.5, "linear");
    expect(w.get(0)).toBe(1);
    expect(w.get(1)).toBeCloseTo(1 - 1 / 1.5, 5);
    expect(w.has(2)).toBe(false); // d=2 ≥ r
    expect(w.has(4)).toBe(false);
  });

  it("uses the distance to the NEAREST seed", () => {
    const w = computeFalloffWeights(LINE, [0, 4], 1.5, "linear");
    // v2 is 2 away from both seeds → outside; v1/v3 are 1 away from a seed.
    expect(w.has(2)).toBe(false);
    expect(w.get(1)).toBeCloseTo(1 - 1 / 1.5, 5);
    expect(w.get(3)).toBeCloseTo(1 - 1 / 1.5, 5);
  });

  it("smooth falloff is smoothstep-shaped", () => {
    const w = computeFalloffWeights(LINE, [0], 2, "smooth");
    const t = 1 - 1 / 2; // v1: t = 0.5
    expect(w.get(1)).toBeCloseTo(t * t * (3 - 2 * t), 5);
  });

  it("sharp falloff decays faster than linear", () => {
    const lin = computeFalloffWeights(LINE, [0], 2, "linear").get(1)!;
    const sharp = computeFalloffWeights(LINE, [0], 2, "sharp").get(1)!;
    expect(sharp).toBeLessThan(lin);
    expect(sharp).toBeCloseTo(lin * lin, 5);
  });

  it("radius 0 (proportional off) returns only the seeds", () => {
    const w = computeFalloffWeights(LINE, [1, 2], 0);
    expect(w.size).toBe(2);
    expect(w.get(1)).toBe(1);
    expect(w.get(2)).toBe(1);
  });
});

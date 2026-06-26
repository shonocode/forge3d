import { describe, it, expect } from "vitest";
import { createMask, paintMask } from "./sculpt-mask";

describe("createMask", () => {
  it("allocates a zeroed mask", () => {
    const m = createMask(4);
    expect(m.length).toBe(4);
    expect(Array.from(m)).toEqual([0, 0, 0, 0]);
  });
});

describe("paintMask", () => {
  // 3 vertices: one at the center, one nearby, one far away.
  const positions = [0, 0, 0, 0.2, 0, 0, 10, 0, 0];

  it("raises mask toward 1 within radius and leaves far vertices untouched", () => {
    const mask = createMask(3);
    const changed = paintMask(mask, positions, [[0, 0, 0]], 1, 1, 1, false);
    expect(changed).toBe(true);
    expect(mask[0]!).toBeGreaterThan(0);
    expect(mask[0]!).toBeLessThanOrEqual(1);
    expect(mask[1]!).toBeGreaterThan(0);
    expect(mask[2]!).toBe(0); // far vertex out of radius
  });

  it("clamps to 1 under repeated strong dabs", () => {
    const mask = createMask(3);
    for (let i = 0; i < 20; i++) paintMask(mask, positions, [[0, 0, 0]], 1, 1, 1, false);
    expect(mask[0]!).toBeCloseTo(1, 5);
  });

  it("lowers mask back toward 0 when inverted", () => {
    const mask = new Float32Array([1, 1, 0]);
    paintMask(mask, positions, [[0, 0, 0]], 1, 1, 1, true);
    expect(mask[0]!).toBeLessThan(1);
  });

  it("reports no change when the brush is empty", () => {
    const mask = createMask(3);
    const changed = paintMask(mask, positions, [[50, 50, 50]], 1, 1, 1, false);
    expect(changed).toBe(false);
    expect(Array.from(mask)).toEqual([0, 0, 0]);
  });

  it("uses the strongest of several symmetric centers", () => {
    const pos = [0.4, 0, 0]; // single vertex
    const farOnly = createMask(1);
    paintMask(farOnly, pos, [[0, 0, 0]], 0.5, 0.3, 1, false);
    const both = createMask(1);
    paintMask(both, pos, [[0, 0, 0], [0.5, 0, 0]], 0.5, 0.3, 1, false);
    // The nearby second center dominates, so the combined dab is stronger.
    expect(both[0]!).toBeGreaterThan(farOnly[0]!);
  });
});

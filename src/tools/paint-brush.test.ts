import { describe, expect, it } from "vitest";
import { brushAlpha, fitWithin, isSeamJump, strokeAngle, strokeDabs } from "./paint-brush";

describe("strokeDabs", () => {
  it("spaces dabs evenly and always ends at the pointer", () => {
    const dabs = strokeDabs(0, 0, 10, 0, 2);
    expect(dabs.length).toBe(5);
    expect(dabs[0]).toEqual([2, 0]);
    expect(dabs[4]).toEqual([10, 0]);
  });

  it("appends the end point when the distance is not a spacing multiple", () => {
    const dabs = strokeDabs(0, 0, 5, 0, 2);
    expect(dabs[dabs.length - 1]).toEqual([5, 0]);
    expect(dabs.length).toBe(3); // 2, 4, 5
  });

  it("a zero-length segment yields exactly one dab at the end", () => {
    expect(strokeDabs(3, 4, 3, 4, 2)).toEqual([[3, 4]]);
  });

  it("works on diagonals (uniform arc-length spacing)", () => {
    const dabs = strokeDabs(0, 0, 3, 4, 1); // length 5
    expect(dabs.length).toBe(5);
    const [x, y] = dabs[0]!;
    expect(Math.hypot(x, y)).toBeCloseTo(1, 6);
  });

  it("clamps degenerate spacing instead of infinite-looping", () => {
    const dabs = strokeDabs(0, 0, 2, 0, 0);
    expect(dabs.length).toBeLessThan(10);
    expect(dabs[dabs.length - 1]).toEqual([2, 0]);
  });
});

describe("isSeamJump", () => {
  it("flags hops longer than 25% of the atlas", () => {
    expect(isSeamJump(0, 0, 300, 0, 1024)).toBe(true);
    expect(isSeamJump(0, 0, 200, 0, 1024)).toBe(false);
  });
});

describe("fitWithin / strokeAngle", () => {
  it("fits preserving aspect (longer side = max)", () => {
    expect(fitWithin(200, 100, 50)).toEqual([50, 25]);
    expect(fitWithin(100, 200, 50)).toEqual([25, 50]);
    expect(fitWithin(0, 100, 50)).toEqual([50, 50]); // degenerate
  });

  it("strokeAngle points along the segment", () => {
    expect(strokeAngle(0, 0, 1, 0)).toBeCloseTo(0);
    expect(strokeAngle(0, 0, 0, 1)).toBeCloseTo(Math.PI / 2);
    expect(strokeAngle(0, 0, -1, 0)).toBeCloseTo(Math.PI);
  });
});

describe("brushAlpha", () => {
  it("is opaque at the center and transparent at the rim", () => {
    expect(brushAlpha(0, 0.5)).toBe(1);
    expect(brushAlpha(1, 0.5)).toBe(0);
  });

  it("hardness widens the opaque core", () => {
    expect(brushAlpha(0.7, 0.8)).toBe(1); // inside the hard core
    expect(brushAlpha(0.7, 0.2)).toBeLessThan(1);
    expect(brushAlpha(0.7, 0.2)).toBeGreaterThan(0);
  });

  it("falls off monotonically outside the core", () => {
    let prev = 1;
    for (let t = 0.2; t <= 1.001; t += 0.1) {
      const a = brushAlpha(t, 0.2);
      expect(a).toBeLessThanOrEqual(prev + 1e-9);
      prev = a;
    }
  });

  it("hardness 1 is a hard-edged circle", () => {
    expect(brushAlpha(0.99, 1)).toBe(1);
    expect(brushAlpha(1, 1)).toBe(0);
  });
});

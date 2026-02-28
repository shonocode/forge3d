import { describe, it, expect } from "vitest";
import { getEasingFunction, EASING_TYPES, type EasingType } from "./easing";

describe("getEasingFunction", () => {
  // All easing functions should return 0 at t=0
  it.each(EASING_TYPES)("%s returns 0 at t=0", (type) => {
    const fn = getEasingFunction(type);
    expect(fn(0)).toBeCloseTo(0, 10);
  });

  // All easing functions should return 1 at t=1
  it.each(EASING_TYPES)("%s returns 1 at t=1", (type) => {
    const fn = getEasingFunction(type);
    expect(fn(1)).toBeCloseTo(1, 10);
  });

  // Linear is identity
  it("linear is identity", () => {
    const fn = getEasingFunction("linear");
    expect(fn(0.5)).toBe(0.5);
    expect(fn(0.25)).toBe(0.25);
    expect(fn(0.75)).toBe(0.75);
  });

  // Specific easing formulas
  it("easeInQuad matches t^2", () => {
    const fn = getEasingFunction("easeInQuad");
    expect(fn(0.5)).toBeCloseTo(0.25, 10);
    expect(fn(0.3)).toBeCloseTo(0.09, 10);
  });

  it("easeOutQuad matches t*(2-t)", () => {
    const fn = getEasingFunction("easeOutQuad");
    expect(fn(0.5)).toBeCloseTo(0.75, 10);
  });

  it("easeInCubic matches t^3", () => {
    const fn = getEasingFunction("easeInCubic");
    expect(fn(0.5)).toBeCloseTo(0.125, 10);
  });

  // InOut functions equal ~0.5 at t=0.5
  it.each(
    EASING_TYPES.filter((t) => t.includes("InOut")),
  )("%s returns ~0.5 at t=0.5", (type) => {
    const fn = getEasingFunction(type);
    expect(fn(0.5)).toBeCloseTo(0.5, 5);
  });

  // Quad/cubic easings are monotonically increasing
  it("quad/cubic easings are monotonically increasing", () => {
    const monotonic: EasingType[] = [
      "linear",
      "easeInQuad",
      "easeOutQuad",
      "easeInOutQuad",
      "easeInCubic",
      "easeOutCubic",
      "easeInOutCubic",
    ];
    for (const type of monotonic) {
      const fn = getEasingFunction(type);
      let prev = fn(0);
      for (let t = 0.01; t <= 1.0; t += 0.01) {
        const curr = fn(t);
        expect(curr).toBeGreaterThanOrEqual(prev - 1e-10);
        prev = curr;
      }
    }
  });

  // Bounce easings stay in [0, 1] range
  it("bounce easings stay in [0, 1]", () => {
    const bounceTypes: EasingType[] = [
      "easeInBounce",
      "easeOutBounce",
      "easeInOutBounce",
    ];
    for (const type of bounceTypes) {
      const fn = getEasingFunction(type);
      for (let t = 0; t <= 1.0; t += 0.01) {
        const v = fn(t);
        expect(v).toBeGreaterThanOrEqual(-0.001);
        expect(v).toBeLessThanOrEqual(1.001);
      }
    }
  });

  // Fallback for unknown type
  it("returns linear for unknown type", () => {
    const fn = getEasingFunction("unknown" as EasingType);
    expect(fn(0.5)).toBe(0.5);
  });

  // EASING_TYPES completeness
  it("EASING_TYPES has 13 entries", () => {
    expect(EASING_TYPES).toHaveLength(13);
  });
});

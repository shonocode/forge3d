import { describe, it, expect } from "vitest";
import { mirrorPoint, symmetricCenters } from "./sculpt-symmetry";

describe("mirrorPoint", () => {
  it("negates the chosen axis only", () => {
    expect(mirrorPoint(1, 2, 3, "x")).toEqual([-1, 2, 3]);
    expect(mirrorPoint(1, 2, 3, "y")).toEqual([1, -2, 3]);
    expect(mirrorPoint(1, 2, 3, "z")).toEqual([1, 2, -3]);
  });
});

describe("symmetricCenters", () => {
  it("returns just the original when no axis is enabled", () => {
    const c = symmetricCenters(1, 2, 3, { x: false, y: false, z: false });
    expect(c).toEqual([[1, 2, 3]]);
  });

  it("doubles centers per enabled axis", () => {
    expect(symmetricCenters(1, 2, 3, { x: true, y: false, z: false })).toHaveLength(2);
    expect(symmetricCenters(1, 2, 3, { x: true, y: true, z: false })).toHaveLength(4);
    expect(symmetricCenters(1, 2, 3, { x: true, y: true, z: true })).toHaveLength(8);
  });

  it("includes the correct X mirror", () => {
    const c = symmetricCenters(1, 2, 3, { x: true, y: false, z: false });
    expect(c).toContainEqual([1, 2, 3]);
    expect(c).toContainEqual([-1, 2, 3]);
  });

  it("dedups a dab on a symmetry plane", () => {
    // x=0 lies on the X mirror plane → its reflection coincides with itself.
    const c = symmetricCenters(0, 2, 3, { x: true, y: false, z: false });
    expect(c).toHaveLength(1);
    expect(c).toEqual([[0, 2, 3]]);
  });
});

import { describe, expect, it } from "vitest";
import { channelValue, evalDriver, findDriver, validateMorphDrivers, type MorphDriver } from "./morph-driver";

describe("evalDriver", () => {
  it("maps the input range linearly to [0,1] with clamping", () => {
    expect(evalDriver(0, 0, 1)).toBe(0);
    expect(evalDriver(0.5, 0, 1)).toBeCloseTo(0.5);
    expect(evalDriver(1, 0, 1)).toBe(1);
    expect(evalDriver(-5, 0, 1)).toBe(0); // clamp low
    expect(evalDriver(5, 0, 1)).toBe(1); // clamp high
    expect(evalDriver(0.75, 0.5, 1.5)).toBeCloseTo(0.25);
  });

  it("a reversed range (inMin > inMax) inverts the mapping", () => {
    expect(evalDriver(1, 1, 0)).toBe(0);
    expect(evalDriver(0, 1, 0)).toBe(1);
    expect(evalDriver(0.25, 1, 0)).toBeCloseTo(0.75);
  });

  it("a zero span always yields 0", () => {
    expect(evalDriver(123, 0.5, 0.5)).toBe(0);
  });
});

describe("channelValue", () => {
  const pose = { rotation: { x: 1, y: 2, z: 3 }, position: { x: 4, y: 5, z: 6 } };
  it("selects each channel", () => {
    expect(channelValue(pose, "rx")).toBe(1);
    expect(channelValue(pose, "ry")).toBe(2);
    expect(channelValue(pose, "rz")).toBe(3);
    expect(channelValue(pose, "px")).toBe(4);
    expect(channelValue(pose, "py")).toBe(5);
    expect(channelValue(pose, "pz")).toBe(6);
  });
});

describe("validateMorphDrivers", () => {
  const good = {
    enabled: true, meshName: "body", targetIndex: 0, boneName: "arm_L",
    channel: "rx", inMin: 0, inMax: 1.2,
  };

  it("accepts well-formed entries and defaults enabled to true", () => {
    const r = validateMorphDrivers([good, { ...good, enabled: undefined }]);
    expect(r).toHaveLength(2);
    expect(r[1]!.enabled).toBe(true);
  });

  it("drops malformed entries without throwing", () => {
    const r = validateMorphDrivers([
      good,
      null,
      42,
      { ...good, meshName: "" },
      { ...good, boneName: 7 },
      { ...good, targetIndex: -1 },
      { ...good, targetIndex: 1.5 },
      { ...good, channel: "qq" },
      { ...good, inMin: NaN },
      { ...good, inMax: "1" },
    ]);
    expect(r).toHaveLength(1);
    expect(r[0]!.meshName).toBe("body");
  });

  it("non-array input yields an empty list", () => {
    expect(validateMorphDrivers(undefined)).toEqual([]);
    expect(validateMorphDrivers({})).toEqual([]);
  });
});

describe("findDriver", () => {
  it("matches on (mesh, target)", () => {
    const d: MorphDriver = {
      enabled: true, meshUniqueId: 7, targetIndex: 2, boneName: "b",
      channel: "ry", inMin: 0, inMax: 1,
    };
    expect(findDriver([d], 7, 2)).toBe(d);
    expect(findDriver([d], 7, 1)).toBeNull();
    expect(findDriver([d], 8, 2)).toBeNull();
  });
});

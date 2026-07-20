import { describe, expect, it } from "vitest";
import { channelTintRgb, hexToRgb, luminance01 } from "./paint-channels";

describe("luminance01", () => {
  it("white is 1, black is 0", () => {
    expect(luminance01("#ffffff")).toBeCloseTo(1, 5);
    expect(luminance01("#000000")).toBe(0);
  });

  it("uses Rec.709 weights (green dominates)", () => {
    expect(luminance01("#00ff00")).toBeCloseTo(0.7152, 4);
    expect(luminance01("#ff0000")).toBeCloseTo(0.2126, 4);
    expect(luminance01("#0000ff")).toBeCloseTo(0.0722, 4);
  });

  it("mid gray lands mid-scale", () => {
    const y = luminance01("#808080");
    expect(y).toBeGreaterThan(0.45);
    expect(y).toBeLessThan(0.55);
  });
});

describe("channelTintRgb / hexToRgb", () => {
  it("packs roughness into green and metalness into blue", () => {
    expect(channelTintRgb("roughness", 1)).toEqual([0, 255, 0]);
    expect(channelTintRgb("metallic", 0.5)).toEqual([0, 0, 128]);
  });

  it("clamps out-of-range values", () => {
    expect(channelTintRgb("roughness", -1)).toEqual([0, 0, 0]);
    expect(channelTintRgb("metallic", 2)).toEqual([0, 0, 255]);
  });

  it("albedo yields a neutral gray of the value", () => {
    expect(channelTintRgb("albedo", 1)).toEqual([255, 255, 255]);
  });

  it("hexToRgb parses channels", () => {
    expect(hexToRgb("#ff8000")).toEqual([255, 128, 0]);
    expect(hexToRgb("#000000")).toEqual([0, 0, 0]);
  });
});

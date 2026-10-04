import { describe, expect, it } from "vitest";
import { evaluateColorRamp } from "./colorband";
import { sampleImage, type TextureImage } from "./image-texture";
import { evaluateTexture, textureValue } from "./texture";

/**
 * The IMAGE texture and the colour ramp (compat-backlog C19). The numbers that
 * matter were measured against Blender by the `displace-tex-image*` /
 * `displace-tex-ramp*` parity rows; what is pinned here is what follows by hand
 * from the C: pixel lookup, the box filter at a pixel's centre, the extension
 * modes, the ramp's stop arithmetic.
 */

/** 4 × 2, red = 40·x, green = 100·y, blue 0, opaque. Row 0 is the bottom. */
function image(): TextureImage {
  const data = new Uint8Array(4 * 2 * 4);
  for (let y = 0; y < 2; y++)
    for (let x = 0; x < 4; x++) data.set([40 * x, 100 * y, 0, 255], 4 * (y * 4 + x));
  return { width: 4, height: 2, data };
}

/** The coordinate a modifier hands over for the centre of pixel (x, y): `2·u − 1`. */
const centre = (x: number, y: number): [number, number, number] => [(2 * (x + 0.5)) / 4 - 1, (2 * (y + 0.5)) / 2 - 1, 0];

describe("sampleImage", () => {
  it("reads the pixel at its centre, filtered or not", () => {
    for (const useInterpolation of [true, false]) {
      const s = sampleImage({ type: "IMAGE", image: image(), useInterpolation }, centre(2, 1))!;
      expect(s.color[0]).toBeCloseTo(80 / 255, 5);
      expect(s.color[1]).toBeCloseTo(100 / 255, 5);
      expect(s.alpha).toBe(1);
    }
  });

  it("averages two pixels where the box straddles their edge", () => {
    // On the edge between x = 1 and x = 2 the unit box covers half of each.
    const s = sampleImage({ type: "IMAGE", image: image() }, [0, (2 * 1.5) / 2 - 1, 0])!;
    expect(s.color[0]).toBeCloseTo((40 + 80) / 2 / 255, 5);
  });

  it("wraps with REPEAT, clamps with EXTEND, and leaves CLIP outside empty", () => {
    const base = { type: "IMAGE", image: image(), useInterpolation: false } as const;
    const out: [number, number, number] = [2 * (4.5 / 4) - 1, (2 * 1.5) / 2 - 1, 0]; // u = 1.125: past the right edge
    expect(sampleImage({ ...base, extension: "REPEAT" }, out)!.color[0]).toBeCloseTo(0, 5); // wraps to x = 0
    expect(sampleImage({ ...base, extension: "EXTEND" }, out)!.color[0]).toBeCloseTo(120 / 255, 5); // x = 3
    expect(sampleImage({ ...base, extension: "CLIP" }, out)).toBeNull();
  });

  it("reads nothing without an image, and the texture value is then 0", () => {
    expect(sampleImage({ type: "IMAGE" }, [0, 0, 0])).toBeNull();
    expect(textureValue({ type: "IMAGE" }, [0, 0, 0]).intensity).toBe(0);
  });

  it("gives the mean of the three channels as the value", () => {
    const v = textureValue({ type: "IMAGE", image: image(), useInterpolation: false }, centre(3, 1));
    expect(v.intensity).toBeCloseTo((120 + 100 + 0) / 3 / 255, 5);
    expect(v.hasColor).toBe(true);
  });

  it("divides a transparent pixel's colour back out of the average", () => {
    const img: TextureImage = { width: 1, height: 1, data: Uint8Array.from([255, 0, 0, 128]) };
    const s = sampleImage({ type: "IMAGE", image: img, useInterpolation: false }, [0, 0, 0])!;
    expect(s.color[0]).toBeCloseTo(1, 5);
    expect(s.alpha).toBeCloseTo(128 / 255, 5);
    // Without use_alpha the colour stays pre-multiplied and the alpha is 1.
    const plain = sampleImage({ type: "IMAGE", image: img, useInterpolation: false, useAlpha: false }, [0, 0, 0])!;
    expect(plain.alpha).toBe(1);
  });
});

describe("evaluateColorRamp", () => {
  const two = { elements: [{ position: 0.25, color: [0, 0, 0, 1] as const }, { position: 0.75, color: [1, 0.5, 0, 1] as const }] };

  it("is flat before the first stop and after the last for LINEAR", () => {
    expect(evaluateColorRamp(two, 0)).toEqual([0, 0, 0, 1]);
    expect(evaluateColorRamp(two, 1)).toEqual([1, 0.5, 0, 1]);
  });

  it("blends linearly between stops, and CONSTANT holds the left one", () => {
    const mid = evaluateColorRamp(two, 0.5)!;
    expect(mid[0]).toBeCloseTo(0.5, 6);
    expect(mid[1]).toBeCloseTo(0.25, 6);
    expect(evaluateColorRamp({ ...two, interpolation: "CONSTANT" }, 0.5)).toEqual([0, 0, 0, 1]);
  });

  it("EASE agrees with LINEAR at the stops and the middle", () => {
    const ease = { ...two, interpolation: "EASE" as const };
    expect(evaluateColorRamp(ease, 0.5)![0]).toBeCloseTo(0.5, 6);
    expect(evaluateColorRamp(ease, 0.375)![0]).toBeLessThan(0.25);
  });

  it("has no answer for a ramp without stops, and a single stop is a constant", () => {
    expect(evaluateColorRamp({ elements: [] }, 0.5)).toBeNull();
    expect(evaluateColorRamp({ elements: [{ position: 0.5, color: [0.2, 0.4, 0.6, 1] }] }, 0.9)).toEqual([
      Math.fround(0.2),
      Math.fround(0.4),
      Math.fround(0.6),
      1,
    ]);
  });

  it("HSV blends take the short way round the hue wheel", () => {
    const wrap = {
      colorMode: "HSV" as const,
      elements: [
        { position: 0, color: [1, 0.1, 0, 1] as const }, // hue ≈ 0.03
        { position: 1, color: [1, 0, 0.1, 1] as const }, // hue ≈ 0.97
      ],
    };
    const [r, g, b] = evaluateColorRamp(wrap, 0.5)!;
    // Halfway round the short way is red, not green/cyan.
    expect(r).toBeGreaterThan(0.99);
    expect(g).toBeLessThan(0.1);
    expect(b).toBeLessThan(0.1);
  });

  it("a texture with a ramp reports a colour result", () => {
    const r = evaluateTexture({ type: "BLEND", colorRamp: two }, [0, 0, 0]);
    expect(r.hasColor).toBe(true);
  });
});

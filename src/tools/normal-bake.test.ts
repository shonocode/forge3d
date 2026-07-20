import { describe, expect, it } from "vitest";
import { bakeNormalFromHigh } from "./normal-bake";

/** Low-poly quad on the XZ plane at y=0, UVs covering the unit square. */
function lowQuad(): { positions: number[]; indices: number[]; uvs: number[] } {
  return {
    positions: [-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1],
    indices: [0, 2, 1, 0, 3, 2], // +Y facing
    uvs: [0, 0, 1, 0, 1, 1, 0, 1],
  };
}

/** High quad: same footprint, rotated `angle` around the Z axis (tilts the normal toward ±X). */
function highQuad(angle: number, y = 0): { positions: number[]; indices: number[] } {
  const c = Math.cos(angle), s = Math.sin(angle);
  const rot = (x: number, yy: number, z: number): [number, number, number] =>
    [x * c - yy * s, x * s + yy * c, z];
  const pts = [
    rot(-2, y, -2), rot(2, y, -2), rot(2, y, 2), rot(-2, y, 2),
  ].flat();
  return { positions: pts, indices: [0, 2, 1, 0, 3, 2] };
}

function centerPixel(pixels: Uint8ClampedArray, res: number): [number, number, number] {
  const t = ((res >> 1) * res + (res >> 1)) * 4;
  return [pixels[t]!, pixels[t + 1]!, pixels[t + 2]!];
}

const OPTS = { resolution: 32 };

describe("bakeNormalFromHigh", () => {
  it("identical flat surfaces bake the flat normal (128,128,255)", () => {
    const low = lowQuad();
    const high = highQuad(0);
    const r = bakeNormalFromHigh(low.positions, low.indices, low.uvs, high.positions, high.indices, OPTS)!;
    expect(r).not.toBeNull();
    expect(r.hitRatio).toBeGreaterThan(0.95);
    const [pr, pg, pb] = centerPixel(r.pixels, r.resolution);
    expect(Math.abs(pr - 128)).toBeLessThanOrEqual(2);
    expect(Math.abs(pg - 128)).toBeLessThanOrEqual(2);
    expect(pb).toBeGreaterThan(250);
  });

  it("a tilted high surface shifts the encoded normal off-center", () => {
    const low = lowQuad();
    const high = highQuad(Math.PI / 9); // 20° tilt around Z
    const r = bakeNormalFromHigh(low.positions, low.indices, low.uvs, high.positions, high.indices, OPTS)!;
    const [pr, , pb] = centerPixel(r.pixels, r.resolution);
    // The X component of the sampled normal is ±sin20° ≈ ±0.34 → R departs
    // from 128 by ~44 in one direction; B stays high (cos20° ≈ 0.94).
    expect(Math.abs(pr - 128)).toBeGreaterThan(30);
    expect(pb).toBeGreaterThan(230);
  });

  it("is deterministic", () => {
    const low = lowQuad();
    const high = highQuad(0.3);
    const r1 = bakeNormalFromHigh(low.positions, low.indices, low.uvs, high.positions, high.indices, OPTS)!;
    const r2 = bakeNormalFromHigh(low.positions, low.indices, low.uvs, high.positions, high.indices, OPTS)!;
    expect(Array.from(r1.pixels)).toEqual(Array.from(r2.pixels));
  });

  it("misses fall back to the flat normal and drop hitRatio", () => {
    const low = lowQuad();
    const high = highQuad(0, 100); // far outside the cage range
    const r = bakeNormalFromHigh(low.positions, low.indices, low.uvs, high.positions, high.indices, OPTS)!;
    expect(r.hitRatio).toBe(0);
    const [pr, pg, pb] = centerPixel(r.pixels, r.resolution);
    expect(Math.abs(pr - 128)).toBeLessThanOrEqual(2);
    expect(Math.abs(pg - 128)).toBeLessThanOrEqual(2);
    expect(pb).toBeGreaterThan(250);
  });

  it("returns null for degenerate input", () => {
    const low = lowQuad();
    expect(bakeNormalFromHigh([], [], [], low.positions, low.indices, OPTS)).toBeNull();
    expect(bakeNormalFromHigh(low.positions, low.indices, low.uvs, [], [], OPTS)).toBeNull();
  });
});

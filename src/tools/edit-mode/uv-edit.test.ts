import { describe, expect, it } from "vitest";
import {
  STRETCH_MAX,
  computeFaceStretch,
  computeUVIslands,
  faceAtUVPoint,
  rotateUVs,
  scaleUVs,
  stretchToColor,
  translateUVs,
  uvBounds,
} from "./uv-edit";

describe("computeUVIslands", () => {
  it("two disconnected triangles form two islands", () => {
    const indices = [0, 1, 2, 3, 4, 5];
    const r = computeUVIslands(indices, 6);
    expect(r.islands.length).toBe(2);
    expect(r.islandOfVert[0]).toBe(r.islandOfVert[2]);
    expect(r.islandOfVert[3]).toBe(r.islandOfVert[5]);
    expect(r.islandOfVert[0]).not.toBe(r.islandOfVert[3]);
    expect(r.islandFaces[r.islandOfVert[0]!]).toEqual([0]);
    expect(r.islandFaces[r.islandOfVert[3]!]).toEqual([1]);
  });

  it("triangles sharing a vertex merge into one island", () => {
    const indices = [0, 1, 2, 2, 3, 4];
    const r = computeUVIslands(indices, 5);
    expect(r.islands.length).toBe(1);
    expect(r.islands[0]!.length).toBe(5);
    expect(r.islandFaces[0]).toEqual([0, 1]);
  });

  it("unreferenced vertices get island -1 and join no island", () => {
    const indices = [0, 1, 2];
    const r = computeUVIslands(indices, 4);
    expect(r.islandOfVert[3]).toBe(-1);
    expect(r.islands[0]!).not.toContain(3);
  });
});

describe("UV transforms", () => {
  it("translateUVs shifts only the given verts", () => {
    const uvs = new Float32Array([0, 0, 1, 0, 0.5, 1]);
    translateUVs(uvs, [0, 2], 0.25, -0.5);
    expect(uvs[0]).toBeCloseTo(0.25);
    expect(uvs[1]).toBeCloseTo(-0.5);
    expect(uvs[2]).toBeCloseTo(1); // untouched
    expect(uvs[4]).toBeCloseTo(0.75);
    expect(uvs[5]).toBeCloseTo(0.5);
  });

  it("rotateUVs by 90° CCW around a pivot keeps the pivot fixed", () => {
    const uvs = new Float32Array([1, 0.5, 0.5, 0.5]);
    rotateUVs(uvs, [0, 1], Math.PI / 2, 0.5, 0.5);
    // (1, 0.5) rotates to (0.5, 1); the pivot vert stays put.
    expect(uvs[0]).toBeCloseTo(0.5);
    expect(uvs[1]).toBeCloseTo(1);
    expect(uvs[2]).toBeCloseTo(0.5);
    expect(uvs[3]).toBeCloseTo(0.5);
  });

  it("scaleUVs scales distances from the pivot uniformly", () => {
    const uvs = new Float32Array([1, 1, 0.5, 0.5]);
    scaleUVs(uvs, [0, 1], 2, 0.5, 0.5);
    expect(uvs[0]).toBeCloseTo(1.5);
    expect(uvs[1]).toBeCloseTo(1.5);
    expect(uvs[2]).toBeCloseTo(0.5);
    expect(uvs[3]).toBeCloseTo(0.5);
  });

  it("uvBounds reports the bbox of the vertex subset", () => {
    const uvs = [0, 0, 2, 3, -1, 1];
    expect(uvBounds(uvs, [1, 2])).toEqual({ minU: -1, minV: 1, maxU: 2, maxV: 3 });
    expect(uvBounds(uvs, [])).toEqual({ minU: 0, minV: 0, maxU: 0, maxV: 0 });
  });
});

describe("faceAtUVPoint", () => {
  const uvs = [0, 0, 1, 0, 0, 1, 2, 2, 3, 2, 2, 3];
  const indices = [0, 1, 2, 3, 4, 5];

  it("finds the containing face", () => {
    expect(faceAtUVPoint(uvs, indices, 0.2, 0.2)).toBe(0);
    expect(faceAtUVPoint(uvs, indices, 2.2, 2.2)).toBe(1);
  });

  it("returns -1 outside all faces", () => {
    expect(faceAtUVPoint(uvs, indices, 0.9, 0.9)).toBe(-1);
    expect(faceAtUVPoint(uvs, indices, -1, -1)).toBe(-1);
  });

  it("is winding-agnostic", () => {
    expect(faceAtUVPoint(uvs, [2, 1, 0], 0.2, 0.2)).toBe(0);
  });
});

describe("computeFaceStretch", () => {
  // Two identical right triangles in 3D (unit legs, z=0 plane).
  const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0];
  const indices = [0, 1, 2, 3, 4, 5];

  it("uniform mapping scores 1 on every face", () => {
    // UVs congruent to the 3D shapes (any common scale is fine).
    const uvs = [0, 0, 0.5, 0, 0, 0.5, 0.6, 0, 1.1, 0, 0.6, 0.5];
    const s = computeFaceStretch(positions, uvs, indices);
    expect(s[0]).toBeCloseTo(1, 5);
    expect(s[1]).toBeCloseTo(1, 5);
  });

  it("a squashed face scores worse than an intact one", () => {
    // Face 1's V extent is squashed 4× → anisotropic stretch.
    const uvs = [0, 0, 0.5, 0, 0, 0.5, 0.6, 0, 1.1, 0, 0.6, 0.125];
    const s = computeFaceStretch(positions, uvs, indices);
    expect(s[1]!).toBeGreaterThan(s[0]!);
    expect(s[1]!).toBeGreaterThan(1.2);
  });

  it("a degenerate UV face is capped at STRETCH_MAX", () => {
    const uvs = [0, 0, 0.5, 0, 0, 0.5, 0.6, 0, 1.1, 0, 0.6, 0]; // face 1 collapsed to a line
    const s = computeFaceStretch(positions, uvs, indices);
    expect(s[1]).toBe(STRETCH_MAX);
  });

  it("all-degenerate input returns 1s (no density reference)", () => {
    const uvs = new Array(12).fill(0);
    const s = computeFaceStretch(positions, uvs, indices);
    expect(Array.from(s)).toEqual([1, 1]);
  });

  it("under-scaled faces are penalized like over-scaled ones", () => {
    // Face 1 uniformly shrunk 4× relative to face 0 — same shape, wasted texels.
    const uvs = [0, 0, 0.5, 0, 0, 0.5, 0.6, 0, 0.725, 0, 0.6, 0.125];
    const s = computeFaceStretch(positions, uvs, indices);
    expect(s[1]!).toBeGreaterThan(s[0]!);
  });
});

describe("stretchToColor", () => {
  it("ramps blue → green → red as stretch grows", () => {
    const low = stretchToColor(1);
    const mid = stretchToColor(2.25);
    const high = stretchToColor(4);
    expect(low[2]).toBeGreaterThan(low[0]); // blue-dominant
    expect(mid[1]).toBeGreaterThan(mid[0]); // green-dominant
    expect(mid[1]).toBeGreaterThan(mid[2]);
    expect(high[0]).toBeGreaterThan(high[1]); // red-dominant
    expect(high[0]).toBeGreaterThan(high[2]);
  });
});

import { describe, expect, it } from "vitest";
import { bakeAO } from "./ao-bake";

/** Quad (two tris) on the XZ plane at y=0, UV-mapped to the full 0–1 square. */
function groundQuad(size = 2): { positions: number[]; indices: number[]; uvs: number[] } {
  const s = size / 2;
  return {
    positions: [-s, 0, -s, s, 0, -s, s, 0, s, -s, 0, s],
    indices: [0, 2, 1, 0, 3, 2], // +Y facing
    uvs: [0, 0, 1, 0, 1, 1, 0, 1],
  };
}

/** Average RGB value of covered center region of the baked map. */
function centerValue(pixels: Uint8ClampedArray, res: number): number {
  let sum = 0, n = 0;
  const lo = Math.floor(res * 0.4);
  const hi = Math.ceil(res * 0.6);
  for (let y = lo; y < hi; y++) {
    for (let x = lo; x < hi; x++) {
      sum += pixels[(y * res + x) * 4]!;
      n++;
    }
  }
  return sum / n;
}

const OPTS = { resolution: 32, samples: 8 };

describe("bakeAO", () => {
  it("an open plane bakes to (near) white", () => {
    const { positions, indices, uvs } = groundQuad();
    const r = bakeAO(positions, indices, uvs, OPTS)!;
    expect(r).not.toBeNull();
    expect(r.coverage).toBeGreaterThan(0.9); // full-square UV map
    expect(centerValue(r.pixels, r.resolution)).toBeGreaterThan(250);
  });

  it("a closely-facing surface pair bakes dark", () => {
    const g = groundQuad();
    // Down-facing ceiling at y=0.1 over the same footprint. Its UVs overwrite
    // the square during rasterization, so the sampled surface is the ceiling
    // underside — whose hemisphere stares straight at the ground 0.1 away.
    const base = g.positions.length / 3;
    const s = 1;
    g.positions.push(-s, 0.1, -s, s, 0.1, -s, s, 0.1, s, -s, 0.1, s);
    g.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    g.uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    const r = bakeAO(g.positions, g.indices, g.uvs, OPTS)!;
    const open = bakeAO(groundQuad().positions, groundQuad().indices, groundQuad().uvs, OPTS)!;
    expect(centerValue(r.pixels, r.resolution)).toBeLessThan(120);
    expect(centerValue(r.pixels, r.resolution)).toBeLessThan(centerValue(open.pixels, open.resolution));
  });

  it("is deterministic (same input → identical pixels)", () => {
    const { positions, indices, uvs } = groundQuad();
    const r1 = bakeAO(positions, indices, uvs, OPTS)!;
    const r2 = bakeAO(positions, indices, uvs, OPTS)!;
    expect(Array.from(r1.pixels)).toEqual(Array.from(r2.pixels));
  });

  it("dilation fills texels just outside the island border", () => {
    const { positions, indices } = groundQuad();
    // Shrink the island to the middle half of UV space — border texels
    // outside it should still receive dilated values.
    const uvs = [0.25, 0.25, 0.75, 0.25, 0.75, 0.75, 0.25, 0.75];
    const r = bakeAO(positions, indices, uvs, { ...OPTS, dilatePasses: 3 })!;
    const res = r.resolution;
    // A texel 2px outside the island's left edge (island starts at x=8 for res 32).
    const outside = r.pixels[((res >> 1) * res + Math.floor(res * 0.25) - 2) * 4]!;
    expect(outside).toBeGreaterThan(200); // filled from the white island, not 0
  });

  it("returns null for empty or degenerate input", () => {
    expect(bakeAO([], [], [], OPTS)).toBeNull();
    expect(bakeAO([0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 1, 2], [0, 0, 0, 0, 0, 0], OPTS)).toBeNull();
  });

  it("strength scales the darkening", () => {
    const g = groundQuad();
    const base = g.positions.length / 3;
    const s = 1;
    g.positions.push(-s, 0.1, -s, s, 0.1, -s, s, 0.1, s, -s, 0.1, s);
    g.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    g.uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    const full = bakeAO(g.positions, g.indices, g.uvs, { ...OPTS, strength: 1 })!;
    const half = bakeAO(g.positions, g.indices, g.uvs, { ...OPTS, strength: 0.5 })!;
    expect(centerValue(half.pixels, half.resolution)).toBeGreaterThan(
      centerValue(full.pixels, full.resolution),
    );
  });
});

/**
 * Tests for the Blender legacy-texture port.
 *
 * Blender is not run here, so nothing below is a number "Blender says". What
 * is pinned: values that follow by hand from the C formulas (lattice points
 * where the noises vanish, BLEND progressions, MAGIC at the origin, the
 * musgrave recurrences when every octave samples 0), structural facts of the
 * code (float32 results, determinism, symmetries, orderings, the defaults),
 * and value ranges.
 */

import { describe, expect, it } from "vitest";
import {
  cellNoise,
  cellNoiseU,
  cellNoiseV3,
  genericNoise,
  genericTurbulence,
  hnoise,
  mgFbm,
  mgRidgedMultiFractal,
  newPerlin,
  newPerlinU,
  orgBlenderNoise,
  orgBlenderNoiseS,
  orgPerlinNoise,
  signedBasis,
  voronoi,
  NOISE_BASIS,
} from "./noise";
import { evaluateTexture, textureValue, type ProceduralTexture } from "./texture";

const f = Math.fround;
const isF32 = (v: number): boolean => Math.fround(v) === v;

/** A fixed, irregular sample set (no randomness). */
function samples(n = 64): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i < n; i++) {
    out.push([
      Math.sin(i * 1.7) * 3.1 + i * 0.013,
      Math.cos(i * 2.3) * 2.7 - 0.4,
      Math.sin(i * 0.61 + 1) * 4.3,
    ]);
  }
  return out;
}

const ALL_BASES = Object.keys(NOISE_BASIS) as (keyof typeof NOISE_BASIS)[];

describe("noise primitives", () => {
  it("orgBlenderNoise is exactly 0.5 on the integer lattice (only corner 0 weighs, with a zero offset)", () => {
    for (const p of [[0, 0, 0], [1, 2, 3], [-4, 7, -1], [100, -3, 12]] as const) {
      expect(orgBlenderNoise(p[0], p[1], p[2])).toBe(0.5);
      expect(orgBlenderNoiseS(p[0], p[1], p[2])).toBe(0);
    }
  });

  it("improved and original Perlin vanish on the integer lattice", () => {
    for (const p of [[0, 0, 0], [3, -2, 5], [-7, 1, 0]] as const) {
      expect(newPerlin(p[0], p[1], p[2])).toBe(0);
      expect(newPerlinU(p[0], p[1], p[2])).toBe(0.5);
      expect(orgPerlinNoise(p[0], p[1], p[2])).toBe(0);
    }
  });

  it("BLI_noise_hnoise: (1 + p) / noisesize on the lattice gives 0.5; noisesize 0 gives 0", () => {
    expect(hnoise(0.5, 0, 0.5, 1)).toBe(0.5); // (1,1.5,2)/0.5 = (2,3,4)
    expect(hnoise(0, 0.3, 0.2, 0.1)).toBe(0);
  });

  it("orgBlenderNoise stays in [0, 1] and every result is a float32", () => {
    for (const [x, y, z] of samples(200)) {
      const n = orgBlenderNoise(x, y, z);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(1);
      expect(isF32(n)).toBe(true);
      expect(isF32(newPerlin(x, y, z))).toBe(true);
      expect(isF32(orgPerlinNoise(x, y, z))).toBe(true);
    }
  });

  it("cell noise is constant inside a unit cell, in [0, 1), and the signed form is 2u - 1", () => {
    const a = cellNoiseU(0.2, 0.3, 0.4);
    expect(cellNoiseU(0.7, 0.8, 0.9)).toBe(a);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
    expect(cellNoise(0.2, 0.3, 0.4)).toBe(f(f(2 * a) - 1));
    // A different cell is (for these cells) a different value.
    expect(cellNoiseU(1.2, 0.3, 0.4)).not.toBe(a);
    for (const [x, y, z] of samples(100)) {
      const u = cellNoiseU(x, y, z);
      expect(u >= 0 && u < 1).toBe(true);
    }
  });

  it("voronoi: F1 <= F2 <= F3 <= F4, all finite; every point is filled", () => {
    for (const [x, y, z] of samples(100)) {
      for (let metric = 0; metric <= 6; metric++) {
        const { da, pa } = voronoi(x, y, z, 2.5, metric);
        expect(da[0]).toBeLessThanOrEqual(da[1]);
        expect(da[1]).toBeLessThanOrEqual(da[2]);
        expect(da[2]).toBeLessThanOrEqual(da[3]);
        expect(da[3]).toBeLessThan(1e9);
        expect(pa.every((c) => Number.isFinite(c))).toBe(true);
      }
    }
  });

  it("voronoi: at a cell's own feature point F1 is 0 and that point is pa[0..2]", () => {
    // BLI_noise_cell_v3 returns HASHPNT of the cell, the same feature point voronoi uses.
    const p = cellNoiseV3(0.5, 0.5, 0.5); // cell (0, 0, 0): point = HASHPNT(0,0,0) + 0
    const { da, pa } = voronoi(p[0], p[1], p[2], 1, 0);
    expect(da[0]).toBe(0);
    expect(pa.slice(0, 3)).toEqual(p);
  });

  it("generic turbulence with 0 extra octaves equals generic noise, for every basis and hardness", () => {
    for (const b of ALL_BASES) {
      for (const hard of [false, true]) {
        for (const [x, y, z] of samples(8)) {
          expect(genericTurbulence(0.25, x, y, z, 0, hard, NOISE_BASIS[b])).toBe(
            genericNoise(0.25, x, y, z, hard, NOISE_BASIS[b]),
          );
        }
      }
    }
  });

  it("hard noise is |2n - 1| of soft noise", () => {
    for (const [x, y, z] of samples(20)) {
      const soft = genericNoise(0.3, x, y, z, false, NOISE_BASIS.IMPROVED_PERLIN);
      expect(genericNoise(0.3, x, y, z, true, NOISE_BASIS.IMPROVED_PERLIN)).toBe(
        f(Math.abs(f(f(2 * soft) - 1))),
      );
    }
  });

  it("an unknown noise basis falls back to Blender Original (the C switch's default)", () => {
    const [x, y, z] = [0.31, -0.72, 1.4];
    expect(genericNoise(0.25, x, y, z, false, 99)).toBe(genericNoise(0.25, x, y, z, false, 0));
    expect(signedBasis(99)).toBe(signedBasis(0));
  });

  it("fBm with one octave is the signed basis itself", () => {
    for (const [x, y, z] of samples(10)) {
      expect(mgFbm(x, y, z, 1, 2, 1, NOISE_BASIS.IMPROVED_PERLIN)).toBe(newPerlin(x, y, z));
    }
  });

  it("ridged multifractal at a lattice point: 1 + 2^-H per extra octave when offset = gain = 1", () => {
    // Every octave samples noise 0: signal = 1, weight = 1, result += pwHL^k.
    expect(mgRidgedMultiFractal(0, 0, 0, 1, 2, 2, 1, 1, 0)).toBe(1.5);
    expect(mgRidgedMultiFractal(0, 0, 0, 1, 2, 3, 1, 1, 0)).toBe(1.75);
  });
});

describe("evaluateTexture — BLEND (hand-computed)", () => {
  const blend = (progression: NonNullable<Extract<ProceduralTexture, { type: "BLEND" }>["progression"]>) =>
    ({ type: "BLEND", progression }) as const;

  it("LINEAR is (1 + x) / 2 and, with the defaults, BRICONT is the identity", () => {
    expect(evaluateTexture(blend("LINEAR"), [0, 0, 0]).intensity).toBe(0.5);
    expect(evaluateTexture(blend("LINEAR"), [0.5, 9, 9]).intensity).toBe(0.75);
    expect(evaluateTexture(blend("LINEAR"), [-1, 0, 0]).intensity).toBe(0);
  });

  it("use_clamp is off by default (DNA sets TEX_NO_CLAMP): values leave [0, 1]", () => {
    expect(evaluateTexture(blend("LINEAR"), [3, 0, 0]).intensity).toBe(2);
    expect(evaluateTexture({ ...blend("LINEAR"), useClamp: true }, [3, 0, 0]).intensity).toBe(1);
    expect(evaluateTexture(blend("LINEAR"), [-3, 0, 0]).intensity).toBe(-1);
  });

  it("BRICONT: (tin - 0.5) * contrast + intensity - 0.5", () => {
    const t = { type: "BLEND", intensity: 1.25, contrast: 2 } as const;
    // tin 0.5 → 0 * 2 + 1.25 - 0.5
    expect(evaluateTexture(t, [0, 0, 0]).intensity).toBe(0.75);
    // tin 0.75 → 0.25 * 2 + 1.25 - 0.5
    expect(evaluateTexture(t, [0.5, 0, 0]).intensity).toBe(1.25);
  });

  it("QUADRATIC, EASING, DIAGONAL", () => {
    expect(evaluateTexture(blend("QUADRATIC"), [0, 0, 0]).intensity).toBe(0.25);
    expect(evaluateTexture(blend("QUADRATIC"), [-3, 0, 0]).intensity).toBe(0);
    expect(evaluateTexture(blend("EASING"), [0, 0, 0]).intensity).toBe(0.5); // 3/4 - 2/8
    expect(evaluateTexture(blend("EASING"), [5, 0, 0]).intensity).toBe(1);
    expect(evaluateTexture(blend("DIAGONAL"), [0.5, 0.5, 0]).intensity).toBe(0.75);
  });

  it("SPHERICAL / QUADRATIC_SPHERE / RADIAL", () => {
    expect(evaluateTexture(blend("SPHERICAL"), [0, 0, 0]).intensity).toBe(1);
    expect(evaluateTexture(blend("SPHERICAL"), [0, 0.5, 0]).intensity).toBe(0.5);
    expect(evaluateTexture(blend("SPHERICAL"), [2, 0, 0]).intensity).toBe(0);
    expect(evaluateTexture(blend("QUADRATIC_SPHERE"), [0, 0, 0.5]).intensity).toBe(0.25);
    expect(evaluateTexture(blend("RADIAL"), [1, 0, 0]).intensity).toBe(0.5);
    expect(evaluateTexture(blend("RADIAL"), [0, 1, 0]).intensity).toBeCloseTo(0.75, 6);
    expect(evaluateTexture(blend("RADIAL"), [-1, 0, 0]).intensity).toBeCloseTo(1, 6);
  });

  it("use_flip_axis VERTICAL swaps x and y", () => {
    const v = { type: "BLEND", useFlipAxis: "VERTICAL" } as const;
    expect(evaluateTexture(v, [0, 0.5, 0]).intensity).toBe(0.75);
    expect(evaluateTexture(v, [0.5, 0, 0]).intensity).toBe(0.5);
  });

  it("is intensity-only: no colour, colour mirrors tin", () => {
    const r = evaluateTexture(blend("LINEAR"), [0.5, 0, 0]);
    expect(r.hasColor).toBe(false);
    expect(r.color).toEqual([0.75, 0.75, 0.75]);
  });
});

describe("evaluateTexture — other types (hand-computed points)", () => {
  it("MAGIC at the origin, depth 0: colour (0.5, 0, 1), tin 0.5", () => {
    // turb = 5 / 5 = 1; (x, y, z) = (sin 0, cos 0, -cos 0) = (0, 1, -1); divided by
    // 2 * turb → (0, 0.5, -0.5); colour = 0.5 - that; tin = (1/3)(sum).
    const r0 = evaluateTexture({ type: "MAGIC", noiseDepth: 0 }, [0, 0, 0]);
    expect(r0.hasColor).toBe(true);
    expect(r0.color).toEqual([0.5, 0, 1]);
    expect(r0.intensity).toBe(0.5);
    expect(r0.alpha).toBe(1);
    expect(textureValue({ type: "MAGIC", noiseDepth: 0 }, [0, 0, 0]).intensity).toBe(0.5);
  });

  it("MAGIC saturation 0 turns the colour grey at the max channel (hsv round trip)", () => {
    const r = evaluateTexture({ type: "MAGIC", noiseDepth: 0, saturation: 0 }, [0, 0, 0]);
    expect(r.color).toEqual([1, 1, 1]);
  });

  it("MAGIC use_clamp clamps only negative channels (BRICONTRGB has no upper clamp)", () => {
    const t = { type: "MAGIC", noiseDepth: 0, intensity: 1.5, useClamp: true } as const;
    // channels + 0.5: (1, 0.5, 1.5)
    expect(evaluateTexture(t, [0, 0, 0]).color).toEqual([1, 0.5, 1.5]);
    // intensity 0.75: channel - 0.5 + 0.75 - 0.5 = channel - 0.25
    const low = { type: "MAGIC", noiseDepth: 0, intensity: 0.75 } as const;
    expect(evaluateTexture(low, [0, 0, 0]).color).toEqual([0.25, -0.25, 0.75]);
    expect(evaluateTexture({ ...low, useClamp: true }, [0, 0, 0]).color).toEqual([0.25, 0, 0.75]);
  });

  it("WOOD bands: sin / saw / tri wave forms at a = 0", () => {
    expect(evaluateTexture({ type: "WOOD" }, [0, 0, 0]).intensity).toBe(0.5);
    expect(evaluateTexture({ type: "WOOD", noiseBasis2: "SAW" }, [0, 0, 0]).intensity).toBe(0);
    expect(evaluateTexture({ type: "WOOD", noiseBasis2: "TRI" }, [0, 0, 0]).intensity).toBe(1);
    // a = 10 (x + y + z) = π/2 → sin = 1
    expect(evaluateTexture({ type: "WOOD" }, [Math.PI / 20, 0, 0]).intensity).toBeCloseTo(1, 6);
    // a = π → saw 0.5, tri 0
    expect(evaluateTexture({ type: "WOOD", noiseBasis2: "SAW" }, [Math.PI / 10, 0, 0]).intensity).toBeCloseTo(0.5, 6);
    expect(evaluateTexture({ type: "WOOD", noiseBasis2: "TRI" }, [Math.PI / 10, 0, 0]).intensity).toBeCloseTo(0, 6);
  });

  it("WOOD rings are even in every axis (x*x is sign-blind)", () => {
    const t = { type: "WOOD", woodType: "RINGS" } as const;
    for (const [x, y, z] of samples(20)) {
      const a = evaluateTexture(t, [x, y, z]).intensity;
      expect(evaluateTexture(t, [-x, y, -z]).intensity).toBe(a);
      expect(evaluateTexture(t, [x, -y, z]).intensity).toBe(a);
    }
  });

  it("MUSGRAVE at the origin (every octave samples noise 0)", () => {
    const at0 = (t: ProceduralTexture): number => evaluateTexture(t, [0, 0, 0]).intensity;
    // BRICONT(0) = 0, BRICONT(1) = 1, BRICONT(1.5) = 1.5 with the defaults.
    expect(at0({ type: "MUSGRAVE", musgraveType: "FBM" })).toBe(0);
    expect(at0({ type: "MUSGRAVE", musgraveType: "MULTIFRACTAL" })).toBe(1);
    expect(at0({ type: "MUSGRAVE", musgraveType: "RIDGED_MULTIFRACTAL" })).toBe(1.5);
    expect(at0({ type: "MUSGRAVE", musgraveType: "HYBRID_MULTIFRACTAL" })).toBe(1.5);
    expect(at0({ type: "MUSGRAVE", musgraveType: "HETERO_TERRAIN" })).toBe(1.5);
    // noise_intensity scales before BRICONT: 2 * 1.5 = 3
    expect(at0({ type: "MUSGRAVE", musgraveType: "RIDGED_MULTIFRACTAL", noiseIntensity: 2 })).toBe(3);
  });

  it("DISTORTED_NOISE with distortion 0 is the plain basis at p / noise_scale", () => {
    const t = { type: "DISTORTED_NOISE", distortion: 0, noiseBasis: "IMPROVED_PERLIN" } as const;
    expect(evaluateTexture(t, [0, 0, 0]).intensity).toBe(0); // BRICONT(0)
    for (const [x, y, z] of samples(10)) {
      const s = f(1 / f(0.25));
      const n = newPerlin(f(f(x) * s), f(f(y) * s), f(f(z) * s));
      expect(evaluateTexture(t, [x, y, z]).intensity).toBe(f(f(f(f(n - 0.5) * 1) + 1) - 0.5));
    }
  });

  it("VORONOI default (weight_1 = 1): intensity is BRICONT(F1) at p / noise_scale", () => {
    for (const [x, y, z] of samples(10)) {
      const s = f(1 / f(0.25));
      const { da } = voronoi(f(f(x) * s), f(f(y) * s), f(f(z) * s), 2.5, 0);
      expect(evaluateTexture({ type: "VORONOI" }, [x, y, z]).intensity).toBe(
        f(f(f(f(da[0] - 0.5) * 1) + 1) - 0.5),
      );
    }
  });

  it("VORONOI colour modes return colour; the value average replaces tin", () => {
    for (const mode of ["POSITION", "POSITION_OUTLINE", "POSITION_OUTLINE_INTENSITY"] as const) {
      const t = { type: "VORONOI", colorMode: mode } as const;
      const r = evaluateTexture(t, [0.3, 0.1, -0.2]);
      expect(r.hasColor).toBe(true);
      const v = textureValue(t, [0.3, 0.1, -0.2]);
      expect(v.intensity).toBe(f(f(1 / 3) * f(f(r.color[0] + r.color[1]) + r.color[2])));
    }
  });

  it("STUCCI ignores intensity / contrast (Blender applies no BRICONT)", () => {
    const p: [number, number, number] = [0.37, -0.2, 0.61];
    const a = evaluateTexture({ type: "STUCCI" }, p).intensity;
    expect(evaluateTexture({ type: "STUCCI", intensity: 2, contrast: 3 }, p).intensity).toBe(a);
  });

  it("STUCCI wall out is 1 - wall in (same offset; Blender Original noise is in [0, 1])", () => {
    for (const p of samples(20)) {
      const wi = evaluateTexture({ type: "STUCCI", stucciType: "WALL_IN" }, p).intensity;
      const wo = evaluateTexture({ type: "STUCCI", stucciType: "WALL_OUT" }, p).intensity;
      expect(wo).toBe(Math.max(f(1 - wi), 0));
    }
  });

  it("CLOUDS colour: red is the grey tin; red = green where x = y (swapped arguments)", () => {
    const grey = evaluateTexture({ type: "CLOUDS" }, [0.3, 0.3, 0.7]);
    const col = evaluateTexture({ type: "CLOUDS", cloudType: "COLOR" }, [0.3, 0.3, 0.7]);
    expect(col.hasColor).toBe(true);
    expect(col.intensity).toBe(grey.intensity); // tin is not BRICONT-ed on the colour path
    expect(col.color[0]).toBe(col.color[1]);
  });
});

describe("evaluateTexture — contracts", () => {
  const all: ProceduralTexture[] = [
    { type: "CLOUDS" },
    { type: "CLOUDS", cloudType: "COLOR", noiseType: "HARD_NOISE", noiseBasis: "VORONOI_CRACKLE" },
    { type: "WOOD", woodType: "RINGNOISE", noiseBasis: "ORIGINAL_PERLIN" },
    { type: "WOOD", woodType: "BANDNOISE", noiseBasis2: "TRI" },
    { type: "MARBLE" },
    { type: "MARBLE", marbleType: "SHARPER", noiseBasis2: "SAW", noiseBasis: "CELL_NOISE" },
    { type: "MAGIC", noiseDepth: 10 },
    { type: "BLEND", progression: "EASING" },
    { type: "STUCCI", stucciType: "WALL_IN", noiseBasis: "VORONOI_F2" },
    { type: "MUSGRAVE", musgraveType: "HYBRID_MULTIFRACTAL", octaves: 3.5, noiseBasis: "IMPROVED_PERLIN" },
    { type: "MUSGRAVE", musgraveType: "FBM", octaves: 2.25, dimensionMax: 0.5 },
    { type: "VORONOI", distanceMetric: "MINKOVSKY", minkovskyExponent: 1.3, weight2: -0.5 },
    { type: "VORONOI", distanceMetric: "CHEBYCHEV", colorMode: "POSITION_OUTLINE" },
    { type: "DISTORTED_NOISE", noiseDistortion: "VORONOI_F1", noiseBasis: "ORIGINAL_PERLIN" },
  ];

  it("is deterministic and every output is a float32", () => {
    for (const t of all) {
      for (const p of samples(16)) {
        const a = evaluateTexture(t, p);
        const b = evaluateTexture(t, p);
        expect(b).toEqual(a);
        expect(isF32(a.intensity)).toBe(true);
        expect(a.color.every(isF32)).toBe(true);
        expect(Number.isFinite(a.intensity)).toBe(true);
      }
    }
  });

  it("with use_clamp, BRICONT-ed intensity-only textures stay in [0, 1]", () => {
    // STUCCI is left out: it applies no BRICONT, so use_clamp does not reach it.
    for (const t of all.filter((t) => t.type !== "STUCCI")) {
      for (const p of samples(16)) {
        const r = evaluateTexture({ ...t, useClamp: true, intensity: 1.7, contrast: 3 }, p);
        if (!r.hasColor) {
          expect(r.intensity).toBeGreaterThanOrEqual(0);
          expect(r.intensity).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("default CLOUDS (Blender Original, turbulence normalised) lies in [0, 1]", () => {
    for (const p of samples(100)) {
      const v = evaluateTexture({ type: "CLOUDS" }, p).intensity;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("textureValue copies tin into the colour for intensity-only textures", () => {
    const v = textureValue({ type: "MARBLE" }, [0.2, 0.4, 0.1]);
    expect(v.hasColor).toBe(false);
    expect(v.color).toEqual([v.intensity, v.intensity, v.intensity]);
    expect(v.intensity).toBe(evaluateTexture({ type: "MARBLE" }, [0.2, 0.4, 0.1]).intensity);
  });

  it("rejects the NOISE type (clock-seeded in Blender) at run time", () => {
    expect(() => evaluateTexture({ type: "NOISE" } as unknown as ProceduralTexture, [0, 0, 0])).toThrow(
      /not reproducible/,
    );
  });
});

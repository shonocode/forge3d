/**
 * Blender's legacy procedural textures (`bpy.types.Texture`: Clouds, Wood,
 * Marble, Magic, Blend, Stucci, Musgrave, Voronoi, Distorted Noise), evaluated
 * at a point — the thing the Displace / Wave / Warp modifiers sample.
 *
 * Source (tag **v5.1.1**):
 * - `source/blender/render/intern/texture_procedural.cc` — `multitex` and the
 *   per-type functions (`clouds`, `wood`, `marble`, `magic`, `blend`, `stucci`,
 *   `mg_mFractalOrfBmTex`, `mg_ridgedOrHybridMFTex`, `mg_HTerrainTex`,
 *   `mg_distNoiseTex`, `voronoiTex`)
 * - `source/blender/render/intern/texture_common.h` — the `BRICONT` /
 *   `BRICONTRGB` brightness/contrast macros
 * - `source/blender/blenkernel/intern/texture.cc` — `BKE_texture_get_value_ex`
 * - `source/blender/makesdna/DNA_texture_types.h` — the defaults (`struct Tex`
 *   member initialisers, which `texture_init_data` copies)
 * - `source/blender/makesrna/intern/rna_texture.cc` — property / enum names
 *
 * Property names are the RNA names in camelCase (`noise_scale` →
 * `noiseScale`, `intensity` is DNA `bright`, `noise_intensity` is
 * `ns_outscale`). Every property is optional and defaults to Blender's value.
 *
 * ## What is not here
 *
 * - **`NOISE`** (the "Noise" texture type): `texnoise` draws from
 *   `BLI_rng_thread_rand`, a per-thread generator seeded with `clock()` in
 *   `RE_texture_rng_init` and advanced by every call. Its output depends on
 *   wall-clock time, thread and call history, so there is nothing
 *   reproducible to port.
 * - **`IMAGE`** and node textures (`use_nodes`).
 * - **Colour ramp** (`use_color_ramp`): when set, `multitex` replaces the
 *   result by `BKE_colorband_evaluate(coba, tin)` and marks it RGB. Not
 *   ported; a ramp-less texture is what is evaluated here.
 * - `nabla` only matters for bump-mapping normals, which this does not compute.
 *
 * ## Faithful oddities (these are Blender's behaviour, not bugs here)
 *
 * - `use_clamp` defaults to **off** (DNA sets `TEX_NO_CLAMP`), so with
 *   `intensity`/`contrast` other than 1 the intensity can leave [0, 1].
 * - `STUCCI` applies no `BRICONT` at all — intensity/contrast do nothing.
 * - For colour results (`MAGIC`, `CLOUDS` colour, `VORONOI` position modes)
 *   `BRICONTRGB` adjusts the colour but **not** `tin`; the intensity is the
 *   raw one. `BKE_texture_get_value` then discards it and uses the colour
 *   average instead ({@link textureValue}).
 * - `DISTORTED_NOISE`: RNA `noise_basis` is DNA `noisebasis2` (the sampled
 *   noise) and `noise_distortion` is `noisebasis` (the distorting noise).
 *
 * Float arithmetic follows noise.ts (fround per operation, C order).
 *
 * Pure and headless.
 */

import {
  DISTANCE_METRIC,
  NOISE_BASIS,
  cellNoiseV3,
  genericNoise,
  genericTurbulence,
  mgFbm,
  mgHeteroTerrain,
  mgHybridMultiFractal,
  mgMultiFractal,
  mgRidgedMultiFractal,
  mgVariableLacunarity,
  voronoi,
  type DistanceMetric,
  type NoiseBasis,
} from "./noise";

const f = Math.fround;

// ── Types ─────────────────────────────────────────────────────────────────

/** Colour/intensity controls every texture type has (RNA `Texture`). */
export interface TextureCommon {
  /** RNA `intensity` (DNA `bright`). Default 1. */
  intensity?: number;
  /** RNA `contrast`. Default 1. */
  contrast?: number;
  /** RNA `saturation` — colour results only. Default 1. */
  saturation?: number;
  /** RNA `factor_red` (`rfac`) — colour results only. Default 1. */
  factorRed?: number;
  /** RNA `factor_green` (`gfac`). Default 1. */
  factorGreen?: number;
  /** RNA `factor_blue` (`bfac`). Default 1. */
  factorBlue?: number;
  /** RNA `use_clamp` (inverse of `TEX_NO_CLAMP`). Default **false**. */
  useClamp?: boolean;
}

/** RNA `noise_type`. */
export type NoiseType = "SOFT_NOISE" | "HARD_NOISE";
/** RNA `noise_basis_2` of Wood / Marble (the wave form). */
export type WaveForm = "SIN" | "SAW" | "TRI";

/** `CLOUDS`. */
export interface CloudsTexture extends TextureCommon {
  type: "CLOUDS";
  /** Default 0.25. */
  noiseScale?: number;
  /** Default 2. */
  noiseDepth?: number;
  /** Default `BLENDER_ORIGINAL`. */
  noiseBasis?: NoiseBasis;
  /** Default `SOFT_NOISE`. */
  noiseType?: NoiseType;
  /** Default `GRAYSCALE`. */
  cloudType?: "GRAYSCALE" | "COLOR";
}

/** `WOOD`. */
export interface WoodTexture extends TextureCommon {
  type: "WOOD";
  /** Default 0.25. */
  noiseScale?: number;
  /** Default 5. */
  turbulence?: number;
  /** Default `BLENDER_ORIGINAL`. */
  noiseBasis?: NoiseBasis;
  /** Default `SOFT_NOISE`. */
  noiseType?: NoiseType;
  /** Default `BANDS`. */
  woodType?: "BANDS" | "RINGS" | "BANDNOISE" | "RINGNOISE";
  /** Default `SIN`. */
  noiseBasis2?: WaveForm;
}

/** `MARBLE`. */
export interface MarbleTexture extends TextureCommon {
  type: "MARBLE";
  /** Default 0.25. */
  noiseScale?: number;
  /** Default 2. */
  noiseDepth?: number;
  /** Default 5. */
  turbulence?: number;
  /** Default `BLENDER_ORIGINAL`. */
  noiseBasis?: NoiseBasis;
  /** Default `SOFT_NOISE`. */
  noiseType?: NoiseType;
  /** Default `SOFT`. */
  marbleType?: "SOFT" | "SHARP" | "SHARPER";
  /** Default `SIN`. */
  noiseBasis2?: WaveForm;
}

/** `MAGIC`. */
export interface MagicTexture extends TextureCommon {
  type: "MAGIC";
  /** Default 2. Depths above 10 behave like 10. */
  noiseDepth?: number;
  /** Default 5. */
  turbulence?: number;
}

/** `BLEND`. */
export interface BlendTexture extends TextureCommon {
  type: "BLEND";
  /** Default `LINEAR`. */
  progression?:
    | "LINEAR"
    | "QUADRATIC"
    | "EASING"
    | "DIAGONAL"
    | "SPHERICAL"
    | "QUADRATIC_SPHERE"
    | "RADIAL";
  /** Default `HORIZONTAL`; `VERTICAL` swaps x and y (`TEX_FLIPBLEND`). */
  useFlipAxis?: "HORIZONTAL" | "VERTICAL";
}

/** `STUCCI`. */
export interface StucciTexture extends TextureCommon {
  type: "STUCCI";
  /** Default 0.25. */
  noiseScale?: number;
  /** Default 5. */
  turbulence?: number;
  /** Default `BLENDER_ORIGINAL`. */
  noiseBasis?: NoiseBasis;
  /** Default `SOFT_NOISE`. */
  noiseType?: NoiseType;
  /** Default `PLASTIC`. */
  stucciType?: "PLASTIC" | "WALL_IN" | "WALL_OUT";
}

/** `MUSGRAVE`. */
export interface MusgraveTexture extends TextureCommon {
  type: "MUSGRAVE";
  /** Default `MULTIFRACTAL`. */
  musgraveType?: "MULTIFRACTAL" | "RIDGED_MULTIFRACTAL" | "HYBRID_MULTIFRACTAL" | "FBM" | "HETERO_TERRAIN";
  /** RNA `dimension_max` (DNA `mg_H`). Default 1. */
  dimensionMax?: number;
  /** Default 2. */
  lacunarity?: number;
  /** Default 2 (fractional octaves are blended). */
  octaves?: number;
  /** Default 1 (ridged / hybrid / hetero only). */
  offset?: number;
  /** Default 1 (ridged / hybrid only). */
  gain?: number;
  /** RNA `noise_intensity` (DNA `ns_outscale`). Default 1. */
  noiseIntensity?: number;
  /** Default 0.25. */
  noiseScale?: number;
  /** Default `BLENDER_ORIGINAL`. */
  noiseBasis?: NoiseBasis;
}

/** `VORONOI`. */
export interface VoronoiTexture extends TextureCommon {
  type: "VORONOI";
  /** RNA `weight_1`. Default 1. */
  weight1?: number;
  /** Default 0. */
  weight2?: number;
  /** Default 0. */
  weight3?: number;
  /** Default 0. */
  weight4?: number;
  /** Default 2.5 (used by `MINKOVSKY` only). */
  minkovskyExponent?: number;
  /** Default `DISTANCE`. */
  distanceMetric?: DistanceMetric;
  /** Default `INTENSITY`. */
  colorMode?: "INTENSITY" | "POSITION" | "POSITION_OUTLINE" | "POSITION_OUTLINE_INTENSITY";
  /** RNA `noise_intensity` (DNA `ns_outscale`). Default 1. */
  noiseIntensity?: number;
  /** Default 0.25. */
  noiseScale?: number;
}

/** `DISTORTED_NOISE`. */
export interface DistortedNoiseTexture extends TextureCommon {
  type: "DISTORTED_NOISE";
  /** RNA `distortion` (DNA `dist_amount`). Default 1. */
  distortion?: number;
  /** Default 0.25. */
  noiseScale?: number;
  /** RNA `noise_basis` — the sampled noise (DNA `noisebasis2`). Default `BLENDER_ORIGINAL`. */
  noiseBasis?: NoiseBasis;
  /** RNA `noise_distortion` — the distorting noise (DNA `noisebasis`). Default `BLENDER_ORIGINAL`. */
  noiseDistortion?: NoiseBasis;
}

/** A procedural texture, discriminated by RNA `type`. (`NOISE` and `IMAGE` are not supported.) */
export type ProceduralTexture =
  | CloudsTexture
  | WoodTexture
  | MarbleTexture
  | MagicTexture
  | BlendTexture
  | StucciTexture
  | MusgraveTexture
  | VoronoiTexture
  | DistortedNoiseTexture;

/** What `multitex` leaves in `TexResult`, plus its `TEX_RGB` return bit. */
export interface TextureResult {
  /** `tin`. For colour results this is the raw intensity (not `BRICONT`-adjusted). */
  intensity: number;
  /**
   * `trgba[0..2]` when `hasColor`. Intensity-only textures do not write it in
   * Blender; here it is filled with `intensity` (what `BKE_texture_get_value`
   * does) so the field is always meaningful.
   */
  color: [number, number, number];
  /** `trgba[3]`: 1 for colour results; intensity-only results report 1 as well (Blender leaves it unwritten). */
  alpha: number;
  /** `multitex(...) & TEX_RGB`. */
  hasColor: boolean;
}

// ── Shared pieces ─────────────────────────────────────────────────────────

interface Common {
  bright: number;
  contrast: number;
  saturation: number;
  rfac: number;
  gfac: number;
  bfac: number;
  clamp: boolean;
}

function common(t: TextureCommon): Common {
  return {
    bright: f(t.intensity ?? 1),
    contrast: f(t.contrast ?? 1),
    saturation: f(t.saturation ?? 1),
    rfac: f(t.factorRed ?? 1),
    gfac: f(t.factorGreen ?? 1),
    bfac: f(t.factorBlue ?? 1),
    clamp: t.useClamp ?? false,
  };
}

/** `BRICONT`: `(tin - 0.5) * contrast + bright - 0.5`, clamped to [0, 1] only with `use_clamp`. */
function bricont(tin: number, c: Common): number {
  tin = f(f(f(f(tin - 0.5) * c.contrast) + c.bright) - 0.5);
  if (c.clamp) {
    if (tin < 0) tin = 0;
    else if (tin > 1) tin = 1;
  }
  return tin;
}

/** `rgb_to_hsv` (`blenlib/intern/math_color.cc`). */
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  let k = 0;
  if (g < b) {
    const t = g; g = b; b = t;
    k = -1;
  }
  let minGb = b;
  if (r < g) {
    const t = r; r = g; g = t;
    k = f(f(-2 / 6) - k);
    minGb = Math.min(g, b);
  }
  const chroma = f(r - minGb);
  const h = Math.abs(f(k + f(f(g - b) / f(f(6 * chroma) + f(1e-20)))));
  const s = f(chroma / f(r + f(1e-20)));
  return [h, s, r];
}

/** `hsv_to_rgb` (`blenlib/intern/math_color.cc`). */
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const h6 = f(h * 6);
  const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
  const nr = clamp01(f(Math.abs(f(h6 - 3)) - 1));
  const ng = clamp01(f(2 - Math.abs(f(h6 - 2))));
  const nb = clamp01(f(2 - Math.abs(f(h6 - 4))));
  const ch = (n: number): number => f(f(f(f(n - 1) * s) + 1) * v);
  return [ch(nr), ch(ng), ch(nb)];
}

/** `BRICONTRGB`: per-channel factor × brightness/contrast, negative clamp, then saturation. */
function bricontRgb(rgb: [number, number, number], c: Common): [number, number, number] {
  const adj = (v: number, fac: number): number =>
    f(fac * f(f(f(f(v - 0.5) * c.contrast) + c.bright) - 0.5));
  let r = adj(rgb[0], c.rfac);
  let g = adj(rgb[1], c.gfac);
  let b = adj(rgb[2], c.bfac);
  if (c.clamp) {
    if (r < 0) r = 0;
    if (g < 0) g = 0;
    if (b < 0) b = 0;
  }
  if (c.saturation !== 1) {
    const hsv = rgbToHsv(r, g, b);
    hsv[1] = f(hsv[1] * c.saturation);
    [r, g, b] = hsvToRgb(hsv[0], hsv[1], hsv[2]);
    if (c.saturation > 1 && c.clamp) {
      if (r < 0) r = 0;
      if (g < 0) g = 0;
      if (b < 0) b = 0;
    }
  }
  return [r, g, b];
}

const basis = (b: NoiseBasis | undefined): number => NOISE_BASIS[b ?? "BLENDER_ORIGINAL"];
const isHard = (t: NoiseType | undefined): boolean => (t ?? "SOFT_NOISE") !== "SOFT_NOISE";

const intOnly = (tin: number): TextureResult => ({
  intensity: tin,
  color: [tin, tin, tin],
  alpha: 1,
  hasColor: false,
});
const withColor = (tin: number, rgb: [number, number, number]): TextureResult => ({
  intensity: tin,
  color: rgb,
  alpha: 1,
  hasColor: true,
});

// Wave forms of wood / marble.
const TWO_PI_F = f(2 * Math.PI);
/** `tex_sin`: `0.5 + 0.5 * sin(a)`. */
function texSin(a: number): number {
  return f(0.5 + f(0.5 * f(Math.sin(a))));
}
/** `tex_saw`: `a mod 2π / 2π`, via C's truncating `int(a / b)`. */
function texSaw(a: number): number {
  const b = TWO_PI_F;
  const n = Math.trunc(f(a / b));
  a = f(a - f(n * b));
  if (a < 0) a = f(a + b);
  return f(a / b);
}
/** `tex_tri`: `1 - 2 |floor(a/2π + 0.5) - a/2π|`. */
function texTri(a: number): number {
  const inv = f(1 / TWO_PI_F);
  const q = f(a * inv);
  return f(1 - f(2 * Math.abs(f(Math.floor(f(q + 0.5)) - q))));
}
const waveform = (w: WaveForm | undefined): ((a: number) => number) =>
  w === "SAW" ? texSaw : w === "TRI" ? texTri : texSin;

// ── Per-type evaluation (`texture_procedural.cc`) ─────────────────────────

/** `blend`. */
function evalBlend(t: BlendTexture, v: [number, number, number]): TextureResult {
  const c = common(t);
  const flip = t.useFlipAxis === "VERTICAL";
  const x = flip ? v[1] : v[0];
  const y = flip ? v[0] : v[1];
  let tin: number;
  switch (t.progression ?? "LINEAR") {
    case "LINEAR":
      tin = f(f(1 + x) / 2);
      break;
    case "QUADRATIC":
      tin = f(f(1 + x) / 2);
      tin = tin < 0 ? 0 : f(tin * tin);
      break;
    case "EASING": {
      tin = f(f(1 + x) / 2);
      if (tin <= 0) tin = 0;
      else if (tin >= 1) tin = 1;
      else {
        const s = f(tin * tin);
        tin = f(f(3 * s) - f(f(2 * s) * tin));
      }
      break;
    }
    case "DIAGONAL":
      tin = f(f(f(2 + x) + y) / 4);
      break;
    case "RADIAL":
      tin = f(f(f(Math.atan2(y, x)) / TWO_PI_F) + 0.5);
      break;
    default: {
      // SPHERICAL / QUADRATIC_SPHERE
      tin = f(1 - f(Math.sqrt(f(f(f(x * x) + f(y * y)) + f(v[2] * v[2])))));
      tin = Math.max(tin, 0);
      if (t.progression === "QUADRATIC_SPHERE") tin = f(tin * tin);
    }
  }
  return intOnly(bricont(tin, c));
}

/** `clouds`. */
function evalClouds(t: CloudsTexture, v: [number, number, number]): TextureResult {
  const c = common(t);
  const ns = f(t.noiseScale ?? 0.25);
  const depth = t.noiseDepth ?? 2;
  const hard = isHard(t.noiseType);
  const nb = basis(t.noiseBasis);
  const tin = genericTurbulence(ns, v[0], v[1], v[2], depth, hard, nb);
  if (t.cloudType === "COLOR") {
    const g = genericTurbulence(ns, v[1], v[0], v[2], depth, hard, nb);
    const b = genericTurbulence(ns, v[1], v[2], v[0], depth, hard, nb);
    return withColor(tin, bricontRgb([tin, g, b], c));
  }
  return intOnly(bricont(tin, c));
}

/** `wood` / `wood_int`. */
function evalWood(t: WoodTexture, v: [number, number, number]): TextureResult {
  const c = common(t);
  const [x, y, z] = v;
  const wave = waveform(t.noiseBasis2);
  const wt = t.woodType ?? "BANDS";
  const band = (): number => f(f(f(x + y) + z) * 10);
  const ring = (): number => f(f(Math.sqrt(f(f(f(x * x) + f(y * y)) + f(z * z)))) * 20);
  const noise = (): number =>
    f(
      f(t.turbulence ?? 5) *
        genericNoise(f(t.noiseScale ?? 0.25), x, y, z, isHard(t.noiseType), basis(t.noiseBasis)),
    );
  let wi: number;
  if (wt === "BANDS") wi = wave(band());
  else if (wt === "RINGS") wi = wave(ring());
  else if (wt === "BANDNOISE") {
    const n = noise();
    wi = wave(f(band() + n));
  } else {
    const n = noise();
    wi = wave(f(ring() + n));
  }
  return intOnly(bricont(wi, c));
}

/** `marble` / `marble_int`. */
function evalMarble(t: MarbleTexture, v: [number, number, number]): TextureResult {
  const c = common(t);
  const [x, y, z] = v;
  const n = f(5 * f(f(x + y) + z));
  const turb = genericTurbulence(
    f(t.noiseScale ?? 0.25),
    x,
    y,
    z,
    t.noiseDepth ?? 2,
    isHard(t.noiseType),
    basis(t.noiseBasis),
  );
  let mi = f(n + f(f(t.turbulence ?? 5) * turb));
  mi = waveform(t.noiseBasis2)(mi);
  if (t.marbleType === "SHARP") mi = f(Math.sqrt(mi));
  else if (t.marbleType === "SHARPER") mi = f(Math.sqrt(f(Math.sqrt(mi))));
  return intOnly(bricont(mi, c));
}

/** `magic`. */
function evalMagic(t: MagicTexture, v: [number, number, number]): TextureResult {
  const c = common(t);
  const n = t.noiseDepth ?? 2;
  let turb = f(f(t.turbulence ?? 5) / 5);
  const sin = (a: number): number => f(Math.sin(a));
  const cos = (a: number): number => f(Math.cos(a));
  const [t0, t1, t2] = v;
  let x = sin(f(f(f(t0 + t1) + t2) * 5));
  let y = cos(f(f(f(-t0 + t1) - t2) * 5));
  let z = -cos(f(f(f(-t0 - t1) + t2) * 5));
  if (n > 0) {
    x = f(x * turb);
    y = f(y * turb);
    z = f(z * turb);
    y = -cos(f(f(x - y) + z));
    y = f(y * turb);
    if (n > 1) {
      x = cos(f(f(x - y) - z));
      x = f(x * turb);
      if (n > 2) {
        z = sin(f(f(-x - y) - z));
        z = f(z * turb);
        if (n > 3) {
          x = -cos(f(f(-x + y) - z));
          x = f(x * turb);
          if (n > 4) {
            y = -sin(f(f(-x + y) + z));
            y = f(y * turb);
            if (n > 5) {
              y = -cos(f(f(-x + y) + z));
              y = f(y * turb);
              if (n > 6) {
                x = cos(f(f(x + y) + z));
                x = f(x * turb);
                if (n > 7) {
                  z = sin(f(f(x + y) - z));
                  z = f(z * turb);
                  if (n > 8) {
                    x = -cos(f(f(-x - y) + z));
                    x = f(x * turb);
                    if (n > 9) {
                      y = -sin(f(f(x - y) + z));
                      y = f(y * turb);
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  if (turb !== 0) {
    turb = f(turb * 2);
    x = f(x / turb);
    y = f(y / turb);
    z = f(z / turb);
  }
  const rgb: [number, number, number] = [f(0.5 - x), f(0.5 - y), f(0.5 - z)];
  const tin = f(f(1 / 3) * f(f(rgb[0] + rgb[1]) + rgb[2]));
  return withColor(tin, bricontRgb(rgb, c));
}

/** `stucci` — note: no `BRICONT`. */
function evalStucci(t: StucciTexture, v: [number, number, number]): TextureResult {
  const ns = f(t.noiseScale ?? 0.25);
  const hard = isHard(t.noiseType);
  const nb = basis(t.noiseBasis);
  const stype = t.stucciType ?? "PLASTIC";
  const b2 = genericNoise(ns, v[0], v[1], v[2], hard, nb);
  let ofs = f(f(t.turbulence ?? 5) / 200);
  if (stype !== "PLASTIC") ofs = f(ofs * f(b2 * b2));
  let tin = genericNoise(ns, v[0], v[1], f(f(v[2]) + ofs), hard, nb);
  if (stype === "WALL_OUT") tin = f(1 - tin);
  tin = Math.max(tin, 0);
  return intOnly(tin);
}

/** `1 / noisesize` scaling that `multitex` applies to musgrave / voronoi / distorted noise. */
function scaled(ns: number | undefined, v: [number, number, number]): [number, number, number] {
  const s = f(1 / f(ns ?? 0.25));
  return [f(v[0] * s), f(v[1] * s), f(v[2] * s)];
}

/** `mg_mFractalOrfBmTex` / `mg_ridgedOrHybridMFTex` / `mg_HTerrainTex`. */
function evalMusgrave(t: MusgraveTexture, v: [number, number, number]): TextureResult {
  const c = common(t);
  const [x, y, z] = scaled(t.noiseScale, v);
  const H = f(t.dimensionMax ?? 1);
  const lac = f(t.lacunarity ?? 2);
  const oct = f(t.octaves ?? 2);
  const ofs = f(t.offset ?? 1);
  const gain = f(t.gain ?? 1);
  const nb = basis(t.noiseBasis);
  const outscale = f(t.noiseIntensity ?? 1);
  let m: number;
  switch (t.musgraveType ?? "MULTIFRACTAL") {
    case "MULTIFRACTAL":
      m = mgMultiFractal(x, y, z, H, lac, oct, nb);
      break;
    case "FBM":
      m = mgFbm(x, y, z, H, lac, oct, nb);
      break;
    case "RIDGED_MULTIFRACTAL":
      m = mgRidgedMultiFractal(x, y, z, H, lac, oct, ofs, gain, nb);
      break;
    case "HYBRID_MULTIFRACTAL":
      m = mgHybridMultiFractal(x, y, z, H, lac, oct, ofs, gain, nb);
      break;
    case "HETERO_TERRAIN":
      m = mgHeteroTerrain(x, y, z, H, lac, oct, ofs, nb);
      break;
  }
  return intOnly(bricont(f(outscale * m), c));
}

/** `mg_distNoiseTex`. */
function evalDistortedNoise(t: DistortedNoiseTexture, v: [number, number, number]): TextureResult {
  const c = common(t);
  const [x, y, z] = scaled(t.noiseScale, v);
  const tin = mgVariableLacunarity(
    x,
    y,
    z,
    f(t.distortion ?? 1),
    basis(t.noiseDistortion),
    basis(t.noiseBasis),
  );
  return intOnly(bricont(tin, c));
}

/** `voronoiTex`. */
function evalVoronoi(t: VoronoiTexture, v: [number, number, number]): TextureResult {
  const c = common(t);
  const [x, y, z] = scaled(t.noiseScale, v);
  const w1 = f(t.weight1 ?? 1);
  const w2 = f(t.weight2 ?? 0);
  const w3 = f(t.weight3 ?? 0);
  const w4 = f(t.weight4 ?? 0);
  const aw1 = Math.abs(w1);
  const aw2 = Math.abs(w2);
  const aw3 = Math.abs(w3);
  const aw4 = Math.abs(w4);
  let sc = f(f(f(aw1 + aw2) + aw3) + aw4);
  if (sc !== 0) sc = f(f(t.noiseIntensity ?? 1) / sc);

  const { da, pa } = voronoi(
    x,
    y,
    z,
    f(t.minkovskyExponent ?? 2.5),
    DISTANCE_METRIC[t.distanceMetric ?? "DISTANCE"],
  );
  // dot_v4v4(&vn_w1, da)
  const dot = f(f(f(f(w1 * da[0]) + f(w2 * da[1])) + f(w3 * da[2])) + f(w4 * da[3]));
  const tin = f(sc * Math.abs(dot));

  const mode = t.colorMode ?? "INTENSITY";
  if (mode === "INTENSITY") return intOnly(bricont(tin, c));

  const rgb: [number, number, number] = [0, 0, 0];
  const weights = [aw1, aw2, aw3, aw4];
  for (let k = 0; k < 4; k++) {
    const ca = cellNoiseV3(pa[3 * k]!, pa[3 * k + 1]!, pa[3 * k + 2]!);
    const w = weights[k]!;
    for (let ch = 0; ch < 3; ch++) {
      rgb[ch] = k === 0 ? f(w * ca[ch]!) : f(rgb[ch]! + f(w * ca[ch]!));
    }
  }
  let t1: number;
  if (mode === "POSITION_OUTLINE" || mode === "POSITION_OUTLINE_INTENSITY") {
    t1 = f(f(da[1] - da[0]) * 10);
    t1 = Math.min(t1, 1);
    t1 = mode === "POSITION_OUTLINE_INTENSITY" ? f(t1 * tin) : f(t1 * sc);
  } else {
    t1 = sc;
  }
  for (let ch = 0; ch < 3; ch++) rgb[ch] = f(rgb[ch]! * t1);
  return withColor(tin, bricontRgb(rgb, c));
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Evaluate a procedural texture at `co` — Blender's `multitex` for the
 * non-image, non-node types (no colour ramp): the intensity `tin`, the colour
 * `trgba` and whether the texture returned colour (`TEX_RGB`).
 *
 * `co` is the texture-space coordinate as `multitex` receives it (for the
 * Displace modifier: after its own mapping, e.g. local coordinates).
 *
 * @throws for a `type` outside {@link ProceduralTexture} (e.g. `"NOISE"`,
 *   whose Blender output is not reproducible — see the module comment).
 */
export function evaluateTexture(
  tex: ProceduralTexture,
  co: readonly [number, number, number] | [number, number, number],
): TextureResult {
  const v: [number, number, number] = [f(co[0]), f(co[1]), f(co[2])];
  switch (tex.type) {
    case "BLEND":
      return evalBlend(tex, v);
    case "CLOUDS":
      return evalClouds(tex, v);
    case "WOOD":
      return evalWood(tex, v);
    case "MARBLE":
      return evalMarble(tex, v);
    case "MAGIC":
      return evalMagic(tex, v);
    case "STUCCI":
      return evalStucci(tex, v);
    case "MUSGRAVE":
      return evalMusgrave(tex, v);
    case "VORONOI":
      return evalVoronoi(tex, v);
    case "DISTORTED_NOISE":
      return evalDistortedNoise(tex, v);
    default: {
      const t = (tex as { type: unknown }).type;
      throw new Error(
        `evaluateTexture: unsupported texture type ${String(t)}` +
          (t === "NOISE" ? " (Blender's NOISE texture is clock-seeded random, not reproducible)" : ""),
      );
    }
  }
}

/** What `BKE_texture_get_value` hands a modifier: `tin`, and the colour when there is one. */
export interface TextureValue {
  /** `texres.tin` after `BKE_texture_get_value_ex`. */
  intensity: number;
  /** `texres.trgba[0..2]`: the texture's colour, or `tin` in all three channels. */
  color: [number, number, number];
  /** Whether the texture returned colour (`TEX_RGB`). */
  hasColor: boolean;
}

/**
 * `BKE_texture_get_value` — the value the Displace (and Wave / Warp)
 * modifiers read. If the texture returned colour, `tin` is **replaced** by the
 * plain average `(1/3) * (r + g + b)` (no perceptual weights, "in the context
 * of modifiers"); otherwise the colour is `tin` copied to all three channels.
 */
export function textureValue(
  tex: ProceduralTexture,
  co: readonly [number, number, number] | [number, number, number],
): TextureValue {
  const r = evaluateTexture(tex, co);
  if (r.hasColor) {
    const [cr, cg, cb] = r.color;
    return {
      intensity: f(f(1 / 3) * f(f(cr + cg) + cb)),
      color: [cr, cg, cb],
      hasColor: true,
    };
  }
  return { intensity: r.intensity, color: [r.intensity, r.intensity, r.intensity], hasColor: false };
}

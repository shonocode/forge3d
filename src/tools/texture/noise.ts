/**
 * Blender's legacy procedural noise — `BLI_noise_*` — ported to TypeScript.
 *
 * Source: `source/blender/blenlib/intern/noise_c.cc` at tag **v5.1.1**
 * (not `noise.cc`, which holds the node-system noise). These are the noises
 * behind the old `bpy.types.Texture` family (Clouds, Wood, Marble, Stucci,
 * Musgrave, Voronoi, Distorted Noise) and therefore behind the Displace /
 * Wave / Warp modifiers when they are driven by such a texture.
 *
 * ## Arithmetic
 *
 * Blender computes all of this in `float`. Every operation below is rounded
 * with `Math.fround` in C's evaluation order (left to right, no FMA — Blender
 * builds with `-ffp-contract=off`). Integer hashing is done in 32-bit two's
 * complement exactly as the C does (`&`, `Math.imul`, `>>> 0`).
 *
 * `sinf`/`cosf`/`atan2f`/`powf` are taken as `fround(Math.*(x))`, i.e. the
 * correctly rounded float of the double result. The platform C libraries are
 * not guaranteed to be correctly rounded, so those four can differ from a
 * given Blender build by 1 ulp on rare inputs. `sqrtf` and `floorf` are exact.
 *
 * ## Tables
 *
 * The permutation / gradient / feature-point tables live in
 * `noise-tables.ts`, generated from the C source. `g_perlin_data_ub` is `char`
 * in C; Blender compiles with `-funsigned-char` (`/J` on MSVC) on every
 * platform, so it is read as unsigned.
 *
 * ## Noise basis
 *
 * The `noisebasis` integers are Blender's DNA values (`TEX_BLENDER = 0` …
 * `TEX_VORONOI_CRACKLE = 8`, `TEX_CELLNOISE = 14`); anything else falls back to
 * Blender Original, as the C `switch` does. {@link NOISE_BASIS} maps the RNA
 * enum names to them.
 *
 * Pure and headless.
 */

import { HASH, HASHPNTF, HASHVECTF, PERLIN_UB, PERLIN_V3 } from "./noise-tables";

const f = Math.fround;

/** A 3-argument noise function (`float (*)(float, float, float)` in C). */
export type NoiseFn = (x: number, y: number, z: number) => number;

/** RNA `noise_basis` identifiers → DNA `noisebasis` values (`DNA_texture_types.h`). */
export const NOISE_BASIS = {
  BLENDER_ORIGINAL: 0,
  ORIGINAL_PERLIN: 1,
  IMPROVED_PERLIN: 2,
  VORONOI_F1: 3,
  VORONOI_F2: 4,
  VORONOI_F3: 5,
  VORONOI_F4: 6,
  VORONOI_F2_F1: 7,
  VORONOI_CRACKLE: 8,
  CELL_NOISE: 14,
} as const;
/** An RNA `noise_basis` identifier. */
export type NoiseBasis = keyof typeof NOISE_BASIS;

/** RNA `distance_metric` identifiers → DNA `vn_distm` values. */
export const DISTANCE_METRIC = {
  DISTANCE: 0,
  DISTANCE_SQUARED: 1,
  MANHATTAN: 2,
  CHEBYCHEV: 3,
  MINKOVSKY_HALF: 4,
  MINKOVSKY_FOUR: 5,
  MINKOVSKY: 6,
} as const;
/** An RNA `distance_metric` identifier. */
export type DistanceMetric = keyof typeof DISTANCE_METRIC;

const hashAt = (i: number): number => HASH[i]!;

// ── Improved Perlin (new) ─────────────────────────────────────────────────

/** `lerp(t, a, b)` = `a + t * (b - a)` in float. */
function lerp(t: number, a: number, b: number): number {
  return f(a + f(t * f(b - a)));
}

/** `npfade(t)` = `t * t * t * (t * (t * 6 - 15) + 10)`. */
function npfade(t: number): number {
  const t3 = f(f(t * t) * t);
  return f(t3 * f(f(t * f(f(t * 6) - 15)) + 10));
}

/** `grad(hash, x, y, z)` — 12 gradient directions from the low 4 bits. */
function grad(hashVal: number, x: number, y: number, z: number): number {
  const h = hashVal & 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return f(((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v));
}

/**
 * `newPerlin` — Ken Perlin's improved noise, using Blender's `hash` table as
 * the permutation. Signed, roughly [-1, 1].
 */
export function newPerlin(x: number, y: number, z: number): number {
  x = f(x);
  y = f(y);
  z = f(z);
  let u = Math.floor(x);
  let v = Math.floor(y);
  let w = Math.floor(z);
  const X = u & 255;
  const Y = v & 255;
  const Z = w & 255;
  x = f(x - u);
  y = f(y - v);
  z = f(z - w);
  u = npfade(x);
  v = npfade(y);
  w = npfade(z);
  const A = hashAt(X) + Y;
  const AA = hashAt(A) + Z;
  const AB = hashAt(A + 1) + Z;
  const B = hashAt(X + 1) + Y;
  const BA = hashAt(B) + Z;
  const BB = hashAt(B + 1) + Z;
  const x1 = f(x - 1);
  const y1 = f(y - 1);
  const z1 = f(z - 1);
  return lerp(
    w,
    lerp(
      v,
      lerp(u, grad(hashAt(AA), x, y, z), grad(hashAt(BA), x1, y, z)),
      lerp(u, grad(hashAt(AB), x, y1, z), grad(hashAt(BB), x1, y1, z)),
    ),
    lerp(
      v,
      lerp(u, grad(hashAt(AA + 1), x, y, z1), grad(hashAt(BA + 1), x1, y, z1)),
      lerp(u, grad(hashAt(AB + 1), x, y1, z1), grad(hashAt(BB + 1), x1, y1, z1)),
    ),
  );
}

/** `newPerlinU` — `0.5 + 0.5 * newPerlin`, the unsigned form. */
export function newPerlinU(x: number, y: number, z: number): number {
  return f(0.5 + f(0.5 * newPerlin(x, y, z)));
}

// ── Blender original ──────────────────────────────────────────────────────

/**
 * `orgBlenderNoise` — Blender's original gradient noise, clamped to [0, 1].
 * (What `BLI_noise_hnoise` evaluates after scaling.)
 */
export function orgBlenderNoise(x: number, y: number, z: number): number {
  x = f(x);
  y = f(y);
  z = f(z);
  const fx = Math.floor(x);
  const fy = Math.floor(y);
  const fz = Math.floor(z);
  const ox = f(x - fx);
  const oy = f(y - fy);
  const oz = f(z - fz);
  const ix = fx | 0;
  const iy = fy | 0;
  const iz = fz | 0;
  const jx = f(ox - 1);
  const jy = f(oy - 1);
  const jz = f(oz - 1);

  let cn1 = f(ox * ox);
  let cn2 = f(oy * oy);
  let cn3 = f(oz * oz);
  let cn4 = f(jx * jx);
  let cn5 = f(jy * jy);
  let cn6 = f(jz * jz);
  cn1 = f(f(1 - f(3 * cn1)) + f(f(2 * cn1) * ox));
  cn2 = f(f(1 - f(3 * cn2)) + f(f(2 * cn2) * oy));
  cn3 = f(f(1 - f(3 * cn3)) + f(f(2 * cn3) * oz));
  cn4 = f(f(1 - f(3 * cn4)) - f(f(2 * cn4) * jx));
  cn5 = f(f(1 - f(3 * cn5)) - f(f(2 * cn5) * jy));
  cn6 = f(f(1 - f(3 * cn6)) - f(f(2 * cn6) * jz));

  const b00 = hashAt(hashAt(ix & 255) + (iy & 255));
  const b10 = hashAt(hashAt((ix + 1) & 255) + (iy & 255));
  const b01 = hashAt(hashAt(ix & 255) + ((iy + 1) & 255));
  const b11 = hashAt(hashAt((ix + 1) & 255) + ((iy + 1) & 255));
  const b20 = iz & 255;
  const b21 = (iz + 1) & 255;

  let n = 0.5;
  const corner = (i: number, hi: number, a: number, b: number, c: number): void => {
    const h = 3 * hi;
    const d = f(f(f(HASHVECTF[h]! * a) + f(HASHVECTF[h + 1]! * b)) + f(HASHVECTF[h + 2]! * c));
    n = f(n + f(i * d));
  };
  corner(f(f(cn1 * cn2) * cn3), hashAt(b20 + b00), ox, oy, oz);
  corner(f(f(cn1 * cn2) * cn6), hashAt(b21 + b00), ox, oy, jz);
  corner(f(f(cn1 * cn5) * cn3), hashAt(b20 + b01), ox, jy, oz);
  corner(f(f(cn1 * cn5) * cn6), hashAt(b21 + b01), ox, jy, jz);
  corner(f(f(cn4 * cn2) * cn3), hashAt(b20 + b10), jx, oy, oz);
  corner(f(f(cn4 * cn2) * cn6), hashAt(b21 + b10), jx, oy, jz);
  corner(f(f(cn4 * cn5) * cn3), hashAt(b20 + b11), jx, jy, oz);
  corner(f(f(cn4 * cn5) * cn6), hashAt(b21 + b11), jx, jy, jz);

  if (n < 0) n = 0;
  else if (n > 1) n = 1;
  return n;
}

/** `orgBlenderNoiseS` — `2 * orgBlenderNoise - 1`, the signed form. */
export function orgBlenderNoiseS(x: number, y: number, z: number): number {
  return f(f(2 * orgBlenderNoise(x, y, z)) - 1);
}

/** `BLI_noise_hnoise` — `orgBlenderNoise((1 + p) / noisesize)`; 0 when `noisesize` is 0. */
export function hnoise(noisesize: number, x: number, y: number, z: number): number {
  noisesize = f(noisesize);
  if (noisesize === 0) return 0;
  return orgBlenderNoise(
    f(f(1 + f(x)) / noisesize),
    f(f(1 + f(y)) / noisesize),
    f(f(1 + f(z)) / noisesize),
  );
}

/** `BLI_noise_turbulence` — `nr` extra octaves of {@link hnoise}, normalised. */
export function turbulence(noisesize: number, x: number, y: number, z: number, nr: number): number {
  noisesize = f(noisesize);
  let d = 0.5;
  let div = 1;
  let s = hnoise(noisesize, x, y, z);
  while (nr > 0) {
    s = f(s + f(d * hnoise(f(noisesize * d), x, y, z)));
    div = f(div + d);
    d = f(d * 0.5);
    nr--;
  }
  return f(s / div);
}

// ── Original Perlin ───────────────────────────────────────────────────────

/** `noise3_perlin` — Perlin's reference noise (`1.5 * …`), signed. */
function noise3Perlin(v0: number, v1: number, v2: number): number {
  const setup = (val: number): [number, number, number, number] => {
    const t = f(val + 10000);
    const b0 = Math.trunc(t) & 255;
    const b1 = (b0 + 1) & 255;
    const r0 = f(t - Math.floor(t));
    const r1 = f(r0 - 1);
    return [b0, b1, r0, r1];
  };
  const [bx0, bx1, rx0, rx1] = setup(f(v0));
  const [by0, by1, ry0, ry1] = setup(f(v1));
  const [bz0, bz1, rz0, rz1] = setup(f(v2));

  const i = PERLIN_UB[bx0]!;
  const j = PERLIN_UB[bx1]!;
  const b00 = PERLIN_UB[i + by0]!;
  const b10 = PERLIN_UB[j + by0]!;
  const b01 = PERLIN_UB[i + by1]!;
  const b11 = PERLIN_UB[j + by1]!;

  const valueAt = (q: number, rx: number, ry: number, rz: number): number => {
    const k = 3 * q;
    return f(f(f(rx * PERLIN_V3[k]!) + f(ry * PERLIN_V3[k + 1]!)) + f(rz * PERLIN_V3[k + 2]!));
  };
  const surve = (t: number): number => f(f(t * t) * f(3 - f(2 * t)));

  const sx = surve(rx0);
  const sy = surve(ry0);
  const sz = surve(rz0);

  let u = valueAt(b00 + bz0, rx0, ry0, rz0);
  let v = valueAt(b10 + bz0, rx1, ry0, rz0);
  let a = lerp(sx, u, v);
  u = valueAt(b01 + bz0, rx0, ry1, rz0);
  v = valueAt(b11 + bz0, rx1, ry1, rz0);
  let b = lerp(sx, u, v);
  const c = lerp(sy, a, b);

  u = valueAt(b00 + bz1, rx0, ry0, rz1);
  v = valueAt(b10 + bz1, rx1, ry0, rz1);
  a = lerp(sx, u, v);
  u = valueAt(b01 + bz1, rx0, ry1, rz1);
  v = valueAt(b11 + bz1, rx1, ry1, rz1);
  b = lerp(sx, u, v);
  const d = lerp(sy, a, b);

  return f(1.5 * lerp(sz, c, d));
}

/** `orgPerlinNoise` — signed original Perlin noise. */
export function orgPerlinNoise(x: number, y: number, z: number): number {
  return noise3Perlin(x, y, z);
}

/** `orgPerlinNoiseU` — `0.5 + 0.5 * orgPerlinNoise`. */
export function orgPerlinNoiseU(x: number, y: number, z: number): number {
  return f(0.5 + f(0.5 * noise3Perlin(x, y, z)));
}

/** `BLI_noise_hnoisep` — `noise3_perlin(p / noisesize)`. */
export function hnoisep(noisesize: number, x: number, y: number, z: number): number {
  noisesize = f(noisesize);
  return noise3Perlin(f(f(x) / noisesize), f(f(y) / noisesize), f(f(z) / noisesize));
}

// ── Voronoi / Worley ──────────────────────────────────────────────────────

type DistFn = (x: number, y: number, z: number, e: number) => number;

const distSquared: DistFn = (x, y, z) => f(f(f(x * x) + f(y * y)) + f(z * z));
const distReal: DistFn = (x, y, z) => f(Math.sqrt(distSquared(x, y, z, 0)));
const distManhattan: DistFn = (x, y, z) => f(f(Math.abs(x) + Math.abs(y)) + Math.abs(z));
const distChebychev: DistFn = (x, y, z) => {
  x = Math.abs(x);
  y = Math.abs(y);
  z = Math.abs(z);
  const t = x > y ? x : y;
  return z > t ? z : t;
};
const distMinkovskyH: DistFn = (x, y, z) => {
  const d = f(
    f(f(Math.sqrt(Math.abs(x))) + f(Math.sqrt(Math.abs(y)))) + f(Math.sqrt(Math.abs(z))),
  );
  return f(d * d);
};
const distMinkovsky4: DistFn = (x, y, z) => {
  x = f(x * x);
  y = f(y * y);
  z = f(z * z);
  return f(Math.sqrt(f(Math.sqrt(distSquared(x, y, z, 0)))));
};
const powf = (a: number, b: number): number => f(Math.pow(a, b));
const distMinkovsky: DistFn = (x, y, z, e) =>
  powf(
    f(f(powf(Math.abs(x), e) + powf(Math.abs(y), e)) + powf(Math.abs(z), e)),
    f(1 / e),
  );

/** Result of {@link voronoi}: `da` distances and `pa` feature points of the 4 nearest cells. */
export interface VoronoiResult {
  /** Distances F1..F4, ascending. */
  da: [number, number, number, number];
  /** The four feature points, flattened `[x0, y0, z0, x1, …, z3]`. */
  pa: number[];
}

/**
 * `BLI_noise_voronoi` — the 4 nearest feature points among the 27 cells around
 * `(x, y, z)`, under distance metric `dtype` (DNA `vn_distm`; unknown values
 * use the real distance) with Minkowski exponent `me`.
 *
 * Ties keep the earlier cell (strict `<`), in the C loop order x, y, z.
 * Slots that never receive a point keep `1e10f` and, in `pa`, `NaN` (the C
 * leaves them uninitialised; with 27 candidates all four are always filled).
 */
export function voronoi(
  x: number,
  y: number,
  z: number,
  me: number,
  dtype: number,
): VoronoiResult {
  x = f(x);
  y = f(y);
  z = f(z);
  me = f(me);
  let distfunc: DistFn;
  switch (dtype) {
    case 1: distfunc = distSquared; break;
    case 2: distfunc = distManhattan; break;
    case 3: distfunc = distChebychev; break;
    case 4: distfunc = distMinkovskyH; break;
    case 5: distfunc = distMinkovsky4; break;
    case 6: distfunc = distMinkovsky; break;
    default: distfunc = distReal; break;
  }
  const xi = Math.floor(x) | 0;
  const yi = Math.floor(y) | 0;
  const zi = Math.floor(z) | 0;
  const BIG = f(1e10);
  const da: [number, number, number, number] = [BIG, BIG, BIG, BIG];
  const pa: number[] = new Array<number>(12).fill(NaN);
  for (let xx = xi - 1; xx <= xi + 1; xx++) {
    for (let yy = yi - 1; yy <= yi + 1; yy++) {
      for (let zz = zi - 1; zz <= zi + 1; zz++) {
        // HASHPNT(x, y, z)
        const h = 3 * hashAt((hashAt((hashAt(zz & 255) + yy) & 255) + xx) & 255);
        const px = f(HASHPNTF[h]! + xx);
        const py = f(HASHPNTF[h + 1]! + yy);
        const pz = f(HASHPNTF[h + 2]! + zz);
        const d = distfunc(f(x - px), f(y - py), f(z - pz), me);
        if (d < da[0]) {
          da[3] = da[2]; da[2] = da[1]; da[1] = da[0]; da[0] = d;
          pa[9] = pa[6]!; pa[10] = pa[7]!; pa[11] = pa[8]!;
          pa[6] = pa[3]!; pa[7] = pa[4]!; pa[8] = pa[5]!;
          pa[3] = pa[0]!; pa[4] = pa[1]!; pa[5] = pa[2]!;
          pa[0] = px; pa[1] = py; pa[2] = pz;
        } else if (d < da[1]) {
          da[3] = da[2]; da[2] = da[1]; da[1] = d;
          pa[9] = pa[6]!; pa[10] = pa[7]!; pa[11] = pa[8]!;
          pa[6] = pa[3]!; pa[7] = pa[4]!; pa[8] = pa[5]!;
          pa[3] = px; pa[4] = py; pa[5] = pz;
        } else if (d < da[2]) {
          da[3] = da[2]; da[2] = d;
          pa[9] = pa[6]!; pa[10] = pa[7]!; pa[11] = pa[8]!;
          pa[6] = px; pa[7] = py; pa[8] = pz;
        } else if (d < da[3]) {
          da[3] = d;
          pa[9] = px; pa[10] = py; pa[11] = pz;
        }
      }
    }
  }
  return { da, pa };
}

/** `voronoi(x, y, z, …, 1, 0)` — the call every noise-basis wrapper makes (real distance). */
const vda = (x: number, y: number, z: number): [number, number, number, number] =>
  voronoi(x, y, z, 1, 0).da;

/** `voronoi_F1` … `voronoi_F4`: distance to the n-th nearest feature point. */
export const voronoiF1: NoiseFn = (x, y, z) => vda(x, y, z)[0];
export const voronoiF2: NoiseFn = (x, y, z) => vda(x, y, z)[1];
export const voronoiF3: NoiseFn = (x, y, z) => vda(x, y, z)[2];
export const voronoiF4: NoiseFn = (x, y, z) => vda(x, y, z)[3];
/** `voronoi_F1F2` — `F2 - F1`. */
export const voronoiF1F2: NoiseFn = (x, y, z) => {
  const da = vda(x, y, z);
  return f(da[1] - da[0]);
};
/** `voronoi_Cr` — crackle, `min(10 * (F2 - F1), 1)`. */
export const voronoiCr: NoiseFn = (x, y, z) => {
  const t = f(10 * voronoiF1F2(x, y, z));
  return t > 1 ? 1 : t;
};
/** `voronoi_F1S` … `voronoi_F4S`, `voronoi_F1F2S`: `2 * F - 1` (used by musgrave). */
export const voronoiF1S: NoiseFn = (x, y, z) => f(f(2 * vda(x, y, z)[0]) - 1);
export const voronoiF2S: NoiseFn = (x, y, z) => f(f(2 * vda(x, y, z)[1]) - 1);
export const voronoiF3S: NoiseFn = (x, y, z) => f(f(2 * vda(x, y, z)[2]) - 1);
export const voronoiF4S: NoiseFn = (x, y, z) => f(f(2 * vda(x, y, z)[3]) - 1);
export const voronoiF1F2S: NoiseFn = (x, y, z) => {
  const da = vda(x, y, z);
  return f(f(2 * f(da[1] - da[0])) - 1);
};
/** `voronoi_CrS` — `2 * crackle - 1`, except the clamped branch returns 1 (as in C). */
export const voronoiCrS: NoiseFn = (x, y, z) => {
  const t = f(10 * voronoiF1F2(x, y, z));
  if (t > 1) return 1;
  return f(f(2 * t) - 1);
};

// ── Cell noise ────────────────────────────────────────────────────────────

const CELL_OFS = f(0.000001);
const CELL_MUL = f(1.00001);

/** The `(p + 0.000001f) * 1.00001f` nudge and `int(floor(...))` both cell functions share. */
function cellIndex(v: number): number {
  return Math.floor(f(f(f(v) + CELL_OFS) * CELL_MUL)) | 0;
}

/** `BLI_cellNoiseU` — one hashed value per unit cell, in [0, 1). */
export function cellNoiseU(x: number, y: number, z: number): number {
  const xi = cellIndex(x);
  const yi = cellIndex(y);
  const zi = cellIndex(z);
  let n = (xi + Math.imul(yi, 1301) + Math.imul(zi, 314159)) >>> 0;
  n = (n ^ (n << 13)) >>> 0;
  const inner = (Math.imul(Math.imul(n, n), 15731) + 789221) >>> 0;
  const r = (Math.imul(n, inner) + 1376312589) >>> 0;
  return f(f(r) / 4294967296);
}

/** `BLI_noise_cell` — `2 * cellNoiseU - 1`. */
export function cellNoise(x: number, y: number, z: number): number {
  return f(f(2 * cellNoiseU(x, y, z)) - 1);
}

/** `BLI_noise_cell_v3` — the cell's feature point from `hashpntf`, used as a colour. */
export function cellNoiseV3(x: number, y: number, z: number): [number, number, number] {
  const xi = cellIndex(x);
  const yi = cellIndex(y);
  const zi = cellIndex(z);
  const h = 3 * hashAt((hashAt((hashAt(zi & 255) + yi) & 255) + xi) & 255);
  return [HASHPNTF[h]!, HASHPNTF[h + 1]!, HASHPNTF[h + 2]!];
}

// ── Noise-basis switches ──────────────────────────────────────────────────

/**
 * The unsigned basis used by `BLI_noise_generic_noise` / `_turbulence`.
 * `offsetOne` is true for Blender Original, which those functions shift by +1
 * "to make return value same as BLI_noise_hnoise".
 */
function unsignedBasis(noisebasis: number): { fn: NoiseFn; offsetOne: boolean } {
  switch (noisebasis) {
    case 1: return { fn: orgPerlinNoiseU, offsetOne: false };
    case 2: return { fn: newPerlinU, offsetOne: false };
    case 3: return { fn: voronoiF1, offsetOne: false };
    case 4: return { fn: voronoiF2, offsetOne: false };
    case 5: return { fn: voronoiF3, offsetOne: false };
    case 6: return { fn: voronoiF4, offsetOne: false };
    case 7: return { fn: voronoiF1F2, offsetOne: false };
    case 8: return { fn: voronoiCr, offsetOne: false };
    case 14: return { fn: cellNoiseU, offsetOne: false };
    default: return { fn: orgBlenderNoise, offsetOne: true };
  }
}

/** The signed basis used by the `BLI_noise_mg_*` (musgrave) functions. */
export function signedBasis(noisebasis: number): NoiseFn {
  switch (noisebasis) {
    case 1: return orgPerlinNoise;
    case 2: return newPerlin;
    case 3: return voronoiF1S;
    case 4: return voronoiF2S;
    case 5: return voronoiF3S;
    case 6: return voronoiF4S;
    case 7: return voronoiF1F2S;
    case 8: return voronoiCrS;
    case 14: return cellNoise;
    default: return orgBlenderNoiseS;
  }
}

/** Shared prologue of generic noise/turbulence: basis, +1 shift, `1 / noisesize` scale. */
function genericSetup(
  noisesize: number,
  x: number,
  y: number,
  z: number,
  noisebasis: number,
): { fn: NoiseFn; x: number; y: number; z: number } {
  const { fn, offsetOne } = unsignedBasis(noisebasis);
  x = f(x);
  y = f(y);
  z = f(z);
  if (offsetOne) {
    x = f(x + 1);
    y = f(y + 1);
    z = f(z + 1);
  }
  noisesize = f(noisesize);
  if (noisesize !== 0) {
    const s = f(1 / noisesize);
    x = f(x * s);
    y = f(y * s);
    z = f(z * s);
  }
  return { fn, x, y, z };
}

/**
 * `BLI_noise_generic_noise` — one octave of the chosen basis at `p / noisesize`.
 * `hard` folds it: `|2n - 1|`.
 */
export function genericNoise(
  noisesize: number,
  x: number,
  y: number,
  z: number,
  hard: boolean,
  noisebasis: number,
): number {
  const s = genericSetup(noisesize, x, y, z, noisebasis);
  const n = s.fn(s.x, s.y, s.z);
  return hard ? f(Math.abs(f(f(2 * n) - 1))) : n;
}

/**
 * `BLI_noise_generic_turbulence` — `oct + 1` octaves (amplitude halves,
 * frequency doubles), normalised by `2^oct / (2^(oct+1) - 1)`.
 */
export function genericTurbulence(
  noisesize: number,
  x: number,
  y: number,
  z: number,
  oct: number,
  hard: boolean,
  noisebasis: number,
): number {
  const s = genericSetup(noisesize, x, y, z, noisebasis);
  let sum = 0;
  let amp = 1;
  let fscale = 1;
  for (let i = 0; i <= oct; i++, amp = f(amp * 0.5), fscale = f(fscale * 2)) {
    let t = s.fn(f(fscale * s.x), f(fscale * s.y), f(fscale * s.z));
    if (hard) t = f(Math.abs(f(f(2 * t) - 1)));
    sum = f(sum + f(t * amp));
  }
  // `float(1 << oct) / float((1 << (oct + 1)) - 1)` with C int wrap-around (oct ≤ 30 in RNA).
  const num = 1 << oct;
  const den = ((1 << (oct + 1)) - 1) | 0;
  return f(sum * f(f(num) / f(den)));
}

// ── Musgrave ──────────────────────────────────────────────────────────────

/** `BLI_noise_mg_fbm` — fractional Brownian motion. */
export function mgFbm(
  x: number,
  y: number,
  z: number,
  H: number,
  lacunarity: number,
  octaves: number,
  noisebasis: number,
): number {
  const fn = signedBasis(noisebasis);
  x = f(x); y = f(y); z = f(z);
  lacunarity = f(lacunarity);
  octaves = f(octaves);
  let value = 0;
  let pwr = 1;
  const pwHL = powf(lacunarity, -f(H));
  const n = Math.trunc(octaves);
  for (let i = 0; i < n; i++) {
    value = f(value + f(fn(x, y, z) * pwr));
    pwr = f(pwr * pwHL);
    x = f(x * lacunarity); y = f(y * lacunarity); z = f(z * lacunarity);
  }
  const rmd = f(octaves - Math.floor(octaves));
  if (rmd !== 0) value = f(value + f(f(rmd * fn(x, y, z)) * pwr));
  return value;
}

/** `BLI_noise_mg_multi_fractal` — product of `(pwr * noise + 1)` over octaves. */
export function mgMultiFractal(
  x: number,
  y: number,
  z: number,
  H: number,
  lacunarity: number,
  octaves: number,
  noisebasis: number,
): number {
  const fn = signedBasis(noisebasis);
  x = f(x); y = f(y); z = f(z);
  lacunarity = f(lacunarity);
  octaves = f(octaves);
  let value = 1;
  let pwr = 1;
  const pwHL = powf(lacunarity, -f(H));
  const n = Math.trunc(octaves);
  for (let i = 0; i < n; i++) {
    value = f(value * f(f(pwr * fn(x, y, z)) + 1));
    pwr = f(pwr * pwHL);
    x = f(x * lacunarity); y = f(y * lacunarity); z = f(z * lacunarity);
  }
  const rmd = f(octaves - Math.floor(octaves));
  if (rmd !== 0) value = f(value * f(f(f(rmd * fn(x, y, z)) * pwr) + 1));
  return value;
}

/** `BLI_noise_mg_hetero_terrain` — heterogeneous terrain. */
export function mgHeteroTerrain(
  x: number,
  y: number,
  z: number,
  H: number,
  lacunarity: number,
  octaves: number,
  offset: number,
  noisebasis: number,
): number {
  const fn = signedBasis(noisebasis);
  x = f(x); y = f(y); z = f(z);
  lacunarity = f(lacunarity);
  octaves = f(octaves);
  offset = f(offset);
  let value = f(offset + fn(x, y, z));
  x = f(x * lacunarity); y = f(y * lacunarity); z = f(z * lacunarity);
  const pwHL = powf(lacunarity, -f(H));
  let pwr = pwHL;
  const n = Math.trunc(octaves);
  for (let i = 1; i < n; i++) {
    const increment = f(f(f(fn(x, y, z) + offset) * pwr) * value);
    value = f(value + increment);
    pwr = f(pwr * pwHL);
    x = f(x * lacunarity); y = f(y * lacunarity); z = f(z * lacunarity);
  }
  const rmd = f(octaves - Math.floor(octaves));
  if (rmd !== 0) {
    const increment = f(f(f(fn(x, y, z) + offset) * pwr) * value);
    value = f(value + f(rmd * increment));
  }
  return value;
}

/** `BLI_noise_mg_hybrid_multi_fractal` — hybrid additive/multiplicative. */
export function mgHybridMultiFractal(
  x: number,
  y: number,
  z: number,
  H: number,
  lacunarity: number,
  octaves: number,
  offset: number,
  gain: number,
  noisebasis: number,
): number {
  const fn = signedBasis(noisebasis);
  x = f(x); y = f(y); z = f(z);
  lacunarity = f(lacunarity);
  octaves = f(octaves);
  offset = f(offset);
  gain = f(gain);
  let result = f(fn(x, y, z) + offset);
  let weight = f(gain * result);
  x = f(x * lacunarity); y = f(y * lacunarity); z = f(z * lacunarity);
  const pwHL = powf(lacunarity, -f(H));
  let pwr = pwHL;
  const n = Math.trunc(octaves);
  const EPS = f(0.001);
  for (let i = 1; weight > EPS && i < n; i++) {
    weight = Math.min(weight, 1);
    const signal = f(f(fn(x, y, z) + offset) * pwr);
    pwr = f(pwr * pwHL);
    result = f(result + f(weight * signal));
    weight = f(weight * f(gain * signal));
    x = f(x * lacunarity); y = f(y * lacunarity); z = f(z * lacunarity);
  }
  const rmd = f(octaves - Math.floor(octaves));
  if (rmd !== 0) result = f(result + f(rmd * f(f(fn(x, y, z) + offset) * pwr)));
  return result;
}

/** `BLI_noise_mg_ridged_multi_fractal` — ridged multifractal (no fractional octave). */
export function mgRidgedMultiFractal(
  x: number,
  y: number,
  z: number,
  H: number,
  lacunarity: number,
  octaves: number,
  offset: number,
  gain: number,
  noisebasis: number,
): number {
  const fn = signedBasis(noisebasis);
  x = f(x); y = f(y); z = f(z);
  lacunarity = f(lacunarity);
  octaves = f(octaves);
  offset = f(offset);
  gain = f(gain);
  const d0 = f(offset - Math.abs(fn(x, y, z)));
  let signal = f(d0 * d0); // powf(d, 2): exactly the rounded square
  let result = signal;
  const pwHL = powf(lacunarity, -f(H));
  let pwr = pwHL;
  const n = Math.trunc(octaves);
  for (let i = 1; i < n; i++) {
    x = f(x * lacunarity); y = f(y * lacunarity); z = f(z * lacunarity);
    let weight = f(signal * gain);
    if (weight > 1) weight = 1;
    else if (weight < 0) weight = 0;
    signal = f(offset - Math.abs(fn(x, y, z)));
    signal = f(signal * signal);
    signal = f(signal * weight);
    result = f(result + f(signal * pwr));
    pwr = f(pwr * pwHL);
  }
  return result;
}

/**
 * `BLI_noise_mg_variable_lacunarity` — distorted noise: basis `nbas2` sampled
 * at `p` displaced by basis `nbas1` (three decorrelated samples) × `distortion`.
 */
export function mgVariableLacunarity(
  x: number,
  y: number,
  z: number,
  distortion: number,
  nbas1: number,
  nbas2: number,
): number {
  const fn1 = signedBasis(nbas1);
  const fn2 = signedBasis(nbas2);
  x = f(x); y = f(y); z = f(z);
  distortion = f(distortion);
  const r0 = f(fn1(f(x + 13.5), f(y + 13.5), f(z + 13.5)) * distortion);
  const r1 = f(fn1(x, y, z) * distortion);
  const r2 = f(fn1(f(x - 13.5), f(y - 13.5), f(z - 13.5)) * distortion);
  return fn2(f(x + r0), f(y + r1), f(z + r2));
}

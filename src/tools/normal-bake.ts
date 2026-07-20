/**
 * High→low normal bake (F-M10) — pure, headless, deterministic.
 *
 * The standard retopo workflow: sculpt detail on a dense "high" mesh, then
 * transfer its surface normals into a tangent-space normal map over the
 * clean low-poly mesh's UV layout.
 *
 * Per covered texel of the low mesh:
 *  1. Interpolate low-poly position, smooth normal and Lengyel tangent
 *     (UV rasterization from bake-common).
 *  2. Cast a cage ray: origin = position + normal · cageDist, direction =
 *     −normal; take the NEAREST high-mesh hit within 2 · cageDist.
 *  3. Interpolate the high mesh's smooth vertex normal at the hit
 *     (barycentric), flip it if it faces away from the low normal (grazing
 *     back-face hits), and express it in the low surface's tangent frame
 *     (T, B = cross(N,T)·w, N).
 *  4. Encode RGB = n · 0.5 + 0.5 (glTF / OpenGL convention, +Y = +V).
 *
 * Misses fall back to the flat normal (128,128,255) so unmatched regions
 * shade like the plain low mesh. Island borders are dilated before
 * encoding, same as the AO bake.
 */

import {
  buildTriGrid,
  computeTangents,
  dilate,
  meshBounds,
  rasterizeUV,
  rayNearestHit,
  smoothVertexNormals,
} from "./bake-common";

export interface NormalBakeOptions {
  /** Output texture size (square). */
  resolution?: number;
  /** Cage offset as a FRACTION of the low mesh bbox diagonal. */
  cageFrac?: number;
  /** Dilation passes for island-border bleed. */
  dilatePasses?: number;
}

export interface NormalBakeResult {
  /** RGBA texels, resolution² × 4. Tangent-space normal, alpha 255. */
  pixels: Uint8ClampedArray;
  resolution: number;
  /** Fraction of covered texels whose cage ray hit the high mesh. */
  hitRatio: number;
}

const DEFAULTS: Required<NormalBakeOptions> = {
  resolution: 256,
  cageFrac: 0.05,
  dilatePasses: 4,
};

export function bakeNormalFromHigh(
  lowPositions: ArrayLike<number>,
  lowIndices: readonly number[],
  lowUVs: ArrayLike<number>,
  highPositions: ArrayLike<number>,
  highIndices: readonly number[],
  opts: NormalBakeOptions = {},
): NormalBakeResult | null {
  const o = { ...DEFAULTS, ...opts };
  const res = o.resolution;
  const numVL = lowPositions.length / 3;
  const numFL = (lowIndices.length / 3) | 0;
  const numVH = highPositions.length / 3;
  if (numFL === 0 || numVL === 0 || lowUVs.length < numVL * 2) return null;
  if (numVH === 0 || highIndices.length === 0) return null;

  const lowBounds = meshBounds(lowPositions);
  const highBounds = meshBounds(highPositions);
  if (!lowBounds || lowBounds.diag < 1e-12 || !highBounds) return null;
  const cageDist = lowBounds.diag * o.cageFrac;

  const lowNormals = smoothVertexNormals(lowPositions, lowIndices, numVL);
  const lowTangents = computeTangents(lowPositions, lowIndices, lowUVs, lowNormals, numVL);
  const highNormals = smoothVertexNormals(highPositions, highIndices, numVH);
  const grid = buildTriGrid(highPositions, highIndices, highBounds.min, highBounds.max);

  const raster = rasterizeUV(lowIndices, lowUVs, res, [
    { data: lowPositions, comps: 3 },
    { data: lowNormals, comps: 3 },
    { data: lowTangents, comps: 4 },
  ]);
  const covered = raster.covered;
  const texPos = raster.out[0]!;
  const texNor = raster.out[1]!;
  const texTan = raster.out[2]!;

  // Tangent-space normal per texel; default = flat (0,0,1).
  const values = new Float32Array(res * res * 3);
  for (let t = 0; t < res * res; t++) values[t * 3 + 2] = 1;

  let coveredCount = 0;
  let hitCount = 0;
  for (let t = 0; t < res * res; t++) {
    if (!covered[t]) continue;
    coveredCount++;

    let nx = texNor[t * 3]!, ny = texNor[t * 3 + 1]!, nz = texNor[t * 3 + 2]!;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;

    // Interpolated tangent, re-orthogonalized against the texel normal.
    let txx = texTan[t * 4]!, txy = texTan[t * 4 + 1]!, txz = texTan[t * 4 + 2]!;
    const w = texTan[t * 4 + 3]! < 0 ? -1 : 1;
    const dTN = txx * nx + txy * ny + txz * nz;
    txx -= nx * dTN; txy -= ny * dTN; txz -= nz * dTN;
    const tl = Math.hypot(txx, txy, txz) || 1;
    txx /= tl; txy /= tl; txz /= tl;
    const bxx = (ny * txz - nz * txy) * w;
    const bxy = (nz * txx - nx * txz) * w;
    const bxz = (nx * txy - ny * txx) * w;

    // Cage ray: from outside the surface, straight down the low normal.
    const ox = texPos[t * 3]! + nx * cageDist;
    const oy = texPos[t * 3 + 1]! + ny * cageDist;
    const oz = texPos[t * 3 + 2]! + nz * cageDist;
    const hit = rayNearestHit(grid, highPositions, highIndices, ox, oy, oz, -nx, -ny, -nz, cageDist * 2);
    if (!hit) continue;
    hitCount++;

    const a = highIndices[hit.face * 3]!, b = highIndices[hit.face * 3 + 1]!, c = highIndices[hit.face * 3 + 2]!;
    let hx = hit.w0 * highNormals[a * 3]! + hit.w1 * highNormals[b * 3]! + hit.w2 * highNormals[c * 3]!;
    let hy = hit.w0 * highNormals[a * 3 + 1]! + hit.w1 * highNormals[b * 3 + 1]! + hit.w2 * highNormals[c * 3 + 1]!;
    let hz = hit.w0 * highNormals[a * 3 + 2]! + hit.w1 * highNormals[b * 3 + 2]! + hit.w2 * highNormals[c * 3 + 2]!;
    const hl = Math.hypot(hx, hy, hz) || 1;
    hx /= hl; hy /= hl; hz /= hl;
    // A grazing ray can catch the far/back surface — flip so the sampled
    // normal stays in the low surface's hemisphere.
    if (hx * nx + hy * ny + hz * nz < 0) { hx = -hx; hy = -hy; hz = -hz; }

    values[t * 3] = hx * txx + hy * txy + hz * txz;
    values[t * 3 + 1] = hx * bxx + hy * bxy + hz * bxz;
    values[t * 3 + 2] = hx * nx + hy * ny + hz * nz;
  }

  if (coveredCount === 0) return null;

  dilate(values, 3, covered, res, o.dilatePasses);

  const pixels = new Uint8ClampedArray(res * res * 4);
  for (let t = 0; t < res * res; t++) {
    // Renormalize after interpolation/dilation before encoding.
    let x = values[t * 3]!, y = values[t * 3 + 1]!, z = values[t * 3 + 2]!;
    const l = Math.hypot(x, y, z) || 1;
    x /= l; y /= l; z /= l;
    pixels[t * 4] = Math.round((x * 0.5 + 0.5) * 255);
    pixels[t * 4 + 1] = Math.round((y * 0.5 + 0.5) * 255);
    pixels[t * 4 + 2] = Math.round((z * 0.5 + 0.5) * 255);
    pixels[t * 4 + 3] = 255;
  }

  return { pixels, resolution: res, hitRatio: coveredCount > 0 ? hitCount / coveredCount : 0 };
}

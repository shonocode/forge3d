/**
 * Ambient Occlusion bake (F-M10) — pure, headless, deterministic.
 *
 * Bakes geometry self-occlusion into a texture over the mesh's UV layout:
 *
 *  1. Rasterize every UV triangle into a texel grid, interpolating 3D
 *     position + smoothed vertex normal per covered texel (barycentric).
 *  2. For each covered texel, cast a deterministic cosine-weighted
 *     hemisphere of rays (golden-ratio spiral — no RNG, so bakes are
 *     reproducible and Vitest-pinned) against the whole mesh.
 *  3. AO = fraction of rays that hit within `maxDistance`; the texel value
 *     is `1 - strength · AO`.
 *  4. Dilate island borders outward so bilinear sampling at UV seams never
 *     bleeds unbaked (black) texels into the surface.
 *
 * Rasterization, the uniform-grid DDA ray casting, and dilation live in
 * `bake-common.ts` (shared with the high→low normal bake). The scene
 * plumbing (RawTexture creation, ambientTexture assignment, undo) lives in
 * the UI layer; this module only speaks typed arrays.
 */

import {
  buildTriGrid,
  dilate,
  meshBounds,
  rasterizeUV,
  rayAnyHit,
  smoothVertexNormals,
} from "./bake-common";

export interface AOBakeOptions {
  /** Output texture size (square). */
  resolution?: number;
  /** Hemisphere rays per texel. */
  samples?: number;
  /** Occlusion ray range as a FRACTION of the mesh bbox diagonal. */
  maxDistanceFrac?: number;
  /** Darkening strength 0–1 (1 = fully black in closed corners). */
  strength?: number;
  /** Dilation passes for island-border bleed. */
  dilatePasses?: number;
}

export interface AOBakeResult {
  /** RGBA texels, resolution² × 4. Grayscale AO in RGB, alpha 255. */
  pixels: Uint8ClampedArray;
  resolution: number;
  /** Fraction of texels covered by UV islands before dilation. */
  coverage: number;
}

const DEFAULTS: Required<AOBakeOptions> = {
  resolution: 256,
  samples: 16,
  maxDistanceFrac: 0.25,
  strength: 1,
  dilatePasses: 4,
};

export function bakeAO(
  positions: ArrayLike<number>,
  indices: readonly number[],
  uvs: ArrayLike<number>,
  opts: AOBakeOptions = {},
): AOBakeResult | null {
  const o = { ...DEFAULTS, ...opts };
  const res = o.resolution;
  const numF = (indices.length / 3) | 0;
  const numV = positions.length / 3;
  if (numF === 0 || numV === 0 || uvs.length < numV * 2) return null;

  const bounds = meshBounds(positions);
  if (!bounds || bounds.diag < 1e-12) return null;
  const maxDist = bounds.diag * o.maxDistanceFrac;
  const bias = bounds.diag * 1e-3;

  const normals = smoothVertexNormals(positions, indices, numV);
  const grid = buildTriGrid(positions, indices, bounds.min, bounds.max);

  const raster = rasterizeUV(indices, uvs, res, [
    { data: positions, comps: 3 },
    { data: normals, comps: 3 },
  ]);
  const covered = raster.covered;
  const texPos = raster.out[0]!;
  const texNor = raster.out[1]!;

  // ── Hemisphere sampling (deterministic golden-ratio spiral) ──
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  const sampleDirs: number[] = [];
  for (let s = 0; s < o.samples; s++) {
    const u = (s + 0.5) / o.samples;
    const r = Math.sqrt(u);
    const phi = s * GOLDEN;
    // Cosine-weighted local dir (z up).
    sampleDirs.push(r * Math.cos(phi), r * Math.sin(phi), Math.sqrt(Math.max(0, 1 - u)));
  }

  const values = new Float32Array(res * res).fill(1);
  let coveredCount = 0;
  for (let t = 0; t < res * res; t++) {
    if (!covered[t]) continue;
    coveredCount++;
    let nx = texNor[t * 3]!, ny = texNor[t * 3 + 1]!, nz = texNor[t * 3 + 2]!;
    const nlen = Math.hypot(nx, ny, nz) || 1;
    nx /= nlen; ny /= nlen; nz /= nlen;
    const [txx, txy, txz, bxx, bxy, bxz] = tangentFrame(nx, ny, nz);
    const ox = texPos[t * 3]! + nx * bias;
    const oy = texPos[t * 3 + 1]! + ny * bias;
    const oz = texPos[t * 3 + 2]! + nz * bias;

    let hits = 0;
    for (let s = 0; s < o.samples; s++) {
      const lx = sampleDirs[s * 3]!, ly = sampleDirs[s * 3 + 1]!, lz = sampleDirs[s * 3 + 2]!;
      const dx = lx * txx + ly * bxx + lz * nx;
      const dy = lx * txy + ly * bxy + lz * ny;
      const dz = lx * txz + ly * bxz + lz * nz;
      if (rayAnyHit(grid, positions, indices, ox, oy, oz, dx, dy, dz, maxDist)) hits++;
    }
    values[t] = 1 - o.strength * (hits / o.samples);
  }

  dilate(values, 1, covered, res, o.dilatePasses);

  const pixels = new Uint8ClampedArray(res * res * 4);
  for (let t = 0; t < res * res; t++) {
    const g = Math.round(values[t]! * 255);
    pixels[t * 4] = g;
    pixels[t * 4 + 1] = g;
    pixels[t * 4 + 2] = g;
    pixels[t * 4 + 3] = 255;
  }

  return { pixels, resolution: res, coverage: coveredCount / (res * res) };
}

/** Arbitrary orthonormal (tangent, bitangent) pair for a unit normal. */
function tangentFrame(nx: number, ny: number, nz: number): [number, number, number, number, number, number] {
  // Pick the world axis least aligned with n for stability.
  const hx = Math.abs(nx) < 0.9 ? 1 : 0;
  const hy = hx === 1 ? 0 : 1;
  let tx = hy * nz - 0 * ny;
  let ty = 0 * nx - hx * nz;
  let tz = hx * ny - hy * nx;
  const tl = Math.hypot(tx, ty, tz) || 1;
  tx /= tl; ty /= tl; tz /= tl;
  const bx = ny * tz - nz * ty;
  const by = nz * tx - nx * tz;
  const bz = nx * ty - ny * tx;
  return [tx, ty, tz, bx, by, bz];
}

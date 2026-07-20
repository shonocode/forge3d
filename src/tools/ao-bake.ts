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
 * Ray casting is accelerated with a uniform grid traversed by 3D DDA
 * (Amanatides & Woo) — brute force over 1M rays × 5k tris would be far too
 * slow on the main thread.
 *
 * The scene plumbing (RawTexture creation, ambientTexture assignment, undo)
 * lives in the UI layer; this module only speaks typed arrays.
 */

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

  // Mesh bbox diagonal — scales the ray range and the surface bias.
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let v = 0; v < numV; v++) {
    const x = positions[v * 3]!, y = positions[v * 3 + 1]!, z = positions[v * 3 + 2]!;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
  if (diag < 1e-12) return null;
  const maxDist = diag * o.maxDistanceFrac;
  const bias = diag * 1e-3;

  const normals = smoothVertexNormals(positions, indices, numV);
  const grid = buildTriGrid(positions, indices, [minX, minY, minZ], [maxX, maxY, maxZ]);

  // ── UV rasterization: per-texel interpolated position + normal ──
  const covered = new Uint8Array(res * res);
  const texPos = new Float32Array(res * res * 3);
  const texNor = new Float32Array(res * res * 3);

  for (let f = 0; f < numF; f++) {
    const a = indices[f * 3]!, b = indices[f * 3 + 1]!, c = indices[f * 3 + 2]!;
    // Texel-space UV corners (texel centers sit at +0.5).
    const ax = uvs[a * 2]! * res, ay = uvs[a * 2 + 1]! * res;
    const bx = uvs[b * 2]! * res, by = uvs[b * 2 + 1]! * res;
    const cx = uvs[c * 2]! * res, cy = uvs[c * 2 + 1]! * res;
    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(area) < 1e-12) continue;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const x1 = Math.min(res - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const y1 = Math.min(res - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const px = tx + 0.5, py = ty + 0.5;
        // Barycentric weights of the texel center.
        const w0 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / area;
        const w1 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const t = ty * res + tx;
        covered[t] = 1;
        for (let k = 0; k < 3; k++) {
          texPos[t * 3 + k] =
            w0 * positions[a * 3 + k]! + w1 * positions[b * 3 + k]! + w2 * positions[c * 3 + k]!;
          texNor[t * 3 + k] =
            w0 * normals[a * 3 + k]! + w1 * normals[b * 3 + k]! + w2 * normals[c * 3 + k]!;
        }
      }
    }
  }

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
    // Tangent frame around the normal.
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
      if (rayOccluded(grid, positions, indices, ox, oy, oz, dx, dy, dz, maxDist)) hits++;
    }
    values[t] = 1 - o.strength * (hits / o.samples);
  }

  // ── Dilation: fill uncovered texels from covered neighbors ──
  const cov = covered.slice();
  for (let pass = 0; pass < o.dilatePasses; pass++) {
    const nextCov = cov.slice();
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const t = y * res + x;
        if (cov[t]) continue;
        let sum = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || xx >= res || yy < 0 || yy >= res) continue;
            const tt = yy * res + xx;
            if (cov[tt]) { sum += values[tt]!; n++; }
          }
        }
        if (n > 0) { values[t] = sum / n; nextCov[t] = 1; }
      }
    }
    cov.set(nextCov);
  }

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

// ── Geometry helpers ───────────────────────────────────────────────────────

/** Area-weighted smooth vertex normals. */
function smoothVertexNormals(
  positions: ArrayLike<number>,
  indices: readonly number[],
  numV: number,
): Float32Array {
  const n = new Float32Array(numV * 3);
  const numF = (indices.length / 3) | 0;
  for (let f = 0; f < numF; f++) {
    const a = indices[f * 3]!, b = indices[f * 3 + 1]!, c = indices[f * 3 + 2]!;
    const ux = positions[b * 3]! - positions[a * 3]!;
    const uy = positions[b * 3 + 1]! - positions[a * 3 + 1]!;
    const uz = positions[b * 3 + 2]! - positions[a * 3 + 2]!;
    const vx = positions[c * 3]! - positions[a * 3]!;
    const vy = positions[c * 3 + 1]! - positions[a * 3 + 1]!;
    const vz = positions[c * 3 + 2]! - positions[a * 3 + 2]!;
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    for (const v of [a, b, c]) {
      n[v * 3] = n[v * 3]! + cx;
      n[v * 3 + 1] = n[v * 3 + 1]! + cy;
      n[v * 3 + 2] = n[v * 3 + 2]! + cz;
    }
  }
  return n;
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

// ── Uniform grid + DDA ray casting ─────────────────────────────────────────

interface TriGrid {
  nx: number; ny: number; nz: number;
  minX: number; minY: number; minZ: number;
  cellX: number; cellY: number; cellZ: number;
  cells: Array<number[] | undefined>;
}

const GRID_RES = 24;

function buildTriGrid(
  positions: ArrayLike<number>,
  indices: readonly number[],
  min: [number, number, number],
  max: [number, number, number],
): TriGrid {
  // Slightly inflate so boundary geometry lands inside the grid.
  const pad = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) * 1e-4 + 1e-9;
  const minX = min[0] - pad, minY = min[1] - pad, minZ = min[2] - pad;
  const maxXp = max[0] + pad, maxYp = max[1] + pad, maxZp = max[2] + pad;
  const nx = GRID_RES, ny = GRID_RES, nz = GRID_RES;
  const cellX = (maxXp - minX) / nx;
  const cellY = (maxYp - minY) / ny;
  const cellZ = (maxZp - minZ) / nz;
  const cells: Array<number[] | undefined> = new Array(nx * ny * nz);

  const numF = (indices.length / 3) | 0;
  for (let f = 0; f < numF; f++) {
    const a = indices[f * 3]!, b = indices[f * 3 + 1]!, c = indices[f * 3 + 2]!;
    let tminX = Infinity, tminY = Infinity, tminZ = Infinity;
    let tmaxX = -Infinity, tmaxY = -Infinity, tmaxZ = -Infinity;
    for (const v of [a, b, c]) {
      const x = positions[v * 3]!, y = positions[v * 3 + 1]!, z = positions[v * 3 + 2]!;
      if (x < tminX) tminX = x; if (x > tmaxX) tmaxX = x;
      if (y < tminY) tminY = y; if (y > tmaxY) tmaxY = y;
      if (z < tminZ) tminZ = z; if (z > tmaxZ) tmaxZ = z;
    }
    const ix0 = clampCell((tminX - minX) / cellX, nx), ix1 = clampCell((tmaxX - minX) / cellX, nx);
    const iy0 = clampCell((tminY - minY) / cellY, ny), iy1 = clampCell((tmaxY - minY) / cellY, ny);
    const iz0 = clampCell((tminZ - minZ) / cellZ, nz), iz1 = clampCell((tmaxZ - minZ) / cellZ, nz);
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          const ci = (iz * ny + iy) * nx + ix;
          (cells[ci] ??= []).push(f);
        }
      }
    }
  }
  return { nx, ny, nz, minX, minY, minZ, cellX, cellY, cellZ, cells };
}

function clampCell(v: number, n: number): number {
  return Math.max(0, Math.min(n - 1, Math.floor(v)));
}

/** Any-hit ray query via 3D DDA over the uniform grid (Amanatides & Woo). */
function rayOccluded(
  grid: TriGrid,
  positions: ArrayLike<number>,
  indices: readonly number[],
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  tMax: number,
): boolean {
  // Current cell (origin is always inside the grid — it's on the mesh).
  let ix = clampCell((ox - grid.minX) / grid.cellX, grid.nx);
  let iy = clampCell((oy - grid.minY) / grid.cellY, grid.ny);
  let iz = clampCell((oz - grid.minZ) / grid.cellZ, grid.nz);

  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  const nextBound = (i: number, step: number, min: number, cell: number, o: number): number =>
    step > 0 ? min + (i + 1) * cell - o : step < 0 ? o - (min + i * cell) : Infinity;
  let tMaxX = stepX !== 0 ? nextBound(ix, stepX, grid.minX, grid.cellX, ox) / Math.abs(dx) : Infinity;
  let tMaxY = stepY !== 0 ? nextBound(iy, stepY, grid.minY, grid.cellY, oy) / Math.abs(dy) : Infinity;
  let tMaxZ = stepZ !== 0 ? nextBound(iz, stepZ, grid.minZ, grid.cellZ, oz) / Math.abs(dz) : Infinity;
  const tDeltaX = stepX !== 0 ? grid.cellX / Math.abs(dx) : Infinity;
  const tDeltaY = stepY !== 0 ? grid.cellY / Math.abs(dy) : Infinity;
  const tDeltaZ = stepZ !== 0 ? grid.cellZ / Math.abs(dz) : Infinity;

  for (let guard = 0; guard < grid.nx + grid.ny + grid.nz + 3; guard++) {
    const cell = grid.cells[(iz * grid.ny + iy) * grid.nx + ix];
    if (cell) {
      for (const f of cell) {
        const t = rayTriangle(positions, indices, f, ox, oy, oz, dx, dy, dz);
        if (t !== null && t > 0 && t < tMax) return true;
      }
    }
    // Advance to the next cell; stop when the ray exits the range or grid.
    const tNext = Math.min(tMaxX, tMaxY, tMaxZ);
    if (tNext > tMax) return false;
    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
      ix += stepX; tMaxX += tDeltaX;
      if (ix < 0 || ix >= grid.nx) return false;
    } else if (tMaxY <= tMaxZ) {
      iy += stepY; tMaxY += tDeltaY;
      if (iy < 0 || iy >= grid.ny) return false;
    } else {
      iz += stepZ; tMaxZ += tDeltaZ;
      if (iz < 0 || iz >= grid.nz) return false;
    }
  }
  return false;
}

/** Möller–Trumbore, double-sided. Returns t or null. */
function rayTriangle(
  positions: ArrayLike<number>,
  indices: readonly number[],
  f: number,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
): number | null {
  const a = indices[f * 3]!, b = indices[f * 3 + 1]!, c = indices[f * 3 + 2]!;
  const ax = positions[a * 3]!, ay = positions[a * 3 + 1]!, az = positions[a * 3 + 2]!;
  const e1x = positions[b * 3]! - ax, e1y = positions[b * 3 + 1]! - ay, e1z = positions[b * 3 + 2]! - az;
  const e2x = positions[c * 3]! - ax, e2y = positions[c * 3 + 1]! - ay, e2z = positions[c * 3 + 2]! - az;
  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  const tx = ox - ax, ty = oy - ay, tz = oz - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return null;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return null;
  return (e2x * qx + e2y * qy + e2z * qz) * inv;
}

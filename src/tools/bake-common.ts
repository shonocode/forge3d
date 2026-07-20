/**
 * Shared geometry infrastructure for texture bakers (F-M10) — pure, headless.
 *
 * Used by `ao-bake.ts` (ambient occlusion) and `normal-bake.ts` (high→low
 * normal transfer):
 *  - UV-space rasterization of arbitrary per-vertex attributes
 *  - area-weighted smooth vertex normals, Lengyel per-vertex tangents
 *  - uniform triangle grid + 3D DDA traversal (Amanatides & Woo) with
 *    any-hit and nearest-hit queries (Möller–Trumbore, double-sided)
 *  - island-border dilation for seam-safe sampling
 */

// ── UV rasterization ───────────────────────────────────────────────────────

export interface RasterAttr {
  /** Per-vertex data, `comps` floats per vertex. */
  data: ArrayLike<number>;
  comps: number;
}

export interface RasterResult {
  /** 1 where a texel is covered by a UV triangle. */
  covered: Uint8Array;
  /** Interpolated per-texel attributes, parallel to the input list. */
  out: Float32Array[];
}

/**
 * Rasterize every UV triangle into a `res`×`res` texel grid, interpolating
 * the given per-vertex attributes barycentrically at each covered texel
 * center. Later triangles overwrite earlier ones on overlap.
 */
export function rasterizeUV(
  indices: readonly number[],
  uvs: ArrayLike<number>,
  res: number,
  attrs: readonly RasterAttr[],
): RasterResult {
  const covered = new Uint8Array(res * res);
  const out = attrs.map((a) => new Float32Array(res * res * a.comps));
  const numF = (indices.length / 3) | 0;

  for (let f = 0; f < numF; f++) {
    const a = indices[f * 3]!, b = indices[f * 3 + 1]!, c = indices[f * 3 + 2]!;
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
        const w0 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / area;
        const w1 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const t = ty * res + tx;
        covered[t] = 1;
        for (let ai = 0; ai < attrs.length; ai++) {
          const { data, comps } = attrs[ai]!;
          const dst = out[ai]!;
          for (let k = 0; k < comps; k++) {
            dst[t * comps + k] =
              w0 * (data[a * comps + k] ?? 0) +
              w1 * (data[b * comps + k] ?? 0) +
              w2 * (data[c * comps + k] ?? 0);
          }
        }
      }
    }
  }
  return { covered, out };
}

/**
 * Fill uncovered texels from the average of covered 8-neighbors, `passes`
 * times — prevents bilinear sampling at UV island borders from bleeding
 * unbaked texels into the surface.
 */
export function dilate(
  values: Float32Array,
  comps: number,
  covered: Uint8Array,
  res: number,
  passes: number,
): void {
  const cov = covered.slice();
  for (let pass = 0; pass < passes; pass++) {
    const nextCov = cov.slice();
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const t = y * res + x;
        if (cov[t]) continue;
        let n = 0;
        const sum = new Array<number>(comps).fill(0);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || xx >= res || yy < 0 || yy >= res) continue;
            const tt = yy * res + xx;
            if (!cov[tt]) continue;
            for (let k = 0; k < comps; k++) sum[k]! += values[tt * comps + k]!;
            n++;
          }
        }
        if (n > 0) {
          for (let k = 0; k < comps; k++) values[t * comps + k] = sum[k]! / n;
          nextCov[t] = 1;
        }
      }
    }
    cov.set(nextCov);
  }
}

// ── Vertex attributes ──────────────────────────────────────────────────────

/** Area-weighted smooth vertex normals (unnormalized — callers normalize). */
export function smoothVertexNormals(
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

/**
 * Per-vertex tangents from UV derivatives (Lengyel's method): vec4 per
 * vertex, xyz = tangent orthogonalized against the smooth normal, w = ±1
 * handedness so `bitangent = cross(N, T) · w` matches the +V direction.
 */
export function computeTangents(
  positions: ArrayLike<number>,
  indices: readonly number[],
  uvs: ArrayLike<number>,
  normals: Float32Array,
  numV: number,
): Float32Array {
  const tan = new Float32Array(numV * 3);
  const bit = new Float32Array(numV * 3);
  const numF = (indices.length / 3) | 0;
  for (let f = 0; f < numF; f++) {
    const a = indices[f * 3]!, b = indices[f * 3 + 1]!, c = indices[f * 3 + 2]!;
    const e1x = positions[b * 3]! - positions[a * 3]!;
    const e1y = positions[b * 3 + 1]! - positions[a * 3 + 1]!;
    const e1z = positions[b * 3 + 2]! - positions[a * 3 + 2]!;
    const e2x = positions[c * 3]! - positions[a * 3]!;
    const e2y = positions[c * 3 + 1]! - positions[a * 3 + 1]!;
    const e2z = positions[c * 3 + 2]! - positions[a * 3 + 2]!;
    const du1 = uvs[b * 2]! - uvs[a * 2]!;
    const dv1 = uvs[b * 2 + 1]! - uvs[a * 2 + 1]!;
    const du2 = uvs[c * 2]! - uvs[a * 2]!;
    const dv2 = uvs[c * 2 + 1]! - uvs[a * 2 + 1]!;
    const det = du1 * dv2 - du2 * dv1;
    if (Math.abs(det) < 1e-12) continue;
    const r = 1 / det;
    const sx = (dv2 * e1x - dv1 * e2x) * r;
    const sy = (dv2 * e1y - dv1 * e2y) * r;
    const sz = (dv2 * e1z - dv1 * e2z) * r;
    const tx = (du1 * e2x - du2 * e1x) * r;
    const ty = (du1 * e2y - du2 * e1y) * r;
    const tz = (du1 * e2z - du2 * e1z) * r;
    for (const v of [a, b, c]) {
      tan[v * 3] = tan[v * 3]! + sx;
      tan[v * 3 + 1] = tan[v * 3 + 1]! + sy;
      tan[v * 3 + 2] = tan[v * 3 + 2]! + sz;
      bit[v * 3] = bit[v * 3]! + tx;
      bit[v * 3 + 1] = bit[v * 3 + 1]! + ty;
      bit[v * 3 + 2] = bit[v * 3 + 2]! + tz;
    }
  }

  const out = new Float32Array(numV * 4);
  for (let v = 0; v < numV; v++) {
    let nx = normals[v * 3]!, ny = normals[v * 3 + 1]!, nz = normals[v * 3 + 2]!;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    let txx = tan[v * 3]!, txy = tan[v * 3 + 1]!, txz = tan[v * 3 + 2]!;
    // Gram–Schmidt against the normal.
    const d = txx * nx + txy * ny + txz * nz;
    txx -= nx * d; txy -= ny * d; txz -= nz * d;
    const tl = Math.hypot(txx, txy, txz);
    if (tl < 1e-9) {
      // Degenerate UVs at this vert — fabricate any tangent ⟂ n.
      const hx = Math.abs(nx) < 0.9 ? 1 : 0;
      const hy = hx === 1 ? 0 : 1;
      txx = hy * nz; txy = -hx * nz; txz = hx * ny - hy * nx;
      const l2 = Math.hypot(txx, txy, txz) || 1;
      txx /= l2; txy /= l2; txz /= l2;
    } else {
      txx /= tl; txy /= tl; txz /= tl;
    }
    // Handedness: does cross(N, T) point along the accumulated bitangent?
    const cxx = ny * txz - nz * txy;
    const cxy = nz * txx - nx * txz;
    const cxz = nx * txy - ny * txx;
    const w = cxx * bit[v * 3]! + cxy * bit[v * 3 + 1]! + cxz * bit[v * 3 + 2]! < 0 ? -1 : 1;
    out[v * 4] = txx;
    out[v * 4 + 1] = txy;
    out[v * 4 + 2] = txz;
    out[v * 4 + 3] = w;
  }
  return out;
}

// ── Uniform grid + DDA ray casting ─────────────────────────────────────────

export interface TriGrid {
  nx: number; ny: number; nz: number;
  minX: number; minY: number; minZ: number;
  cellX: number; cellY: number; cellZ: number;
  cells: Array<number[] | undefined>;
}

const GRID_RES = 24;

export function buildTriGrid(
  positions: ArrayLike<number>,
  indices: readonly number[],
  min: [number, number, number],
  max: [number, number, number],
): TriGrid {
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

export interface RayHit {
  t: number;
  face: number;
  /** Barycentric weights of the hit on (v0, v1, v2). */
  w0: number;
  w1: number;
  w2: number;
}

/**
 * DDA traversal core. `nearest` = false returns on the first hit inside
 * `tMax` (occlusion query); `nearest` = true keeps the closest hit and can
 * terminate early once the best t precedes the next cell boundary.
 *
 * The ray origin may sit outside the grid (cage rays) — it is advanced to
 * the grid entry point first; a ray that misses the grid box entirely
 * returns null.
 */
function traverse(
  grid: TriGrid,
  positions: ArrayLike<number>,
  indices: readonly number[],
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  tMax: number,
  nearest: boolean,
): RayHit | null {
  // Clip the ray to the grid AABB (slab test) so DDA can start inside.
  let tEnter = 0;
  const maxX = grid.minX + grid.nx * grid.cellX;
  const maxY = grid.minY + grid.ny * grid.cellY;
  const maxZ = grid.minZ + grid.nz * grid.cellZ;
  {
    let t0 = 0, t1 = tMax;
    for (const [o, d, lo, hi] of [
      [ox, dx, grid.minX, maxX],
      [oy, dy, grid.minY, maxY],
      [oz, dz, grid.minZ, maxZ],
    ] as const) {
      if (Math.abs(d) < 1e-15) {
        if (o < lo || o > hi) return null;
        continue;
      }
      let ta = (lo - o) / d;
      let tb = (hi - o) / d;
      if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) return null;
    }
    tEnter = Math.max(0, t0);
  }
  const ex = ox + dx * (tEnter + 1e-9);
  const ey = oy + dy * (tEnter + 1e-9);
  const ez = oz + dz * (tEnter + 1e-9);

  let ix = clampCell((ex - grid.minX) / grid.cellX, grid.nx);
  let iy = clampCell((ey - grid.minY) / grid.cellY, grid.ny);
  let iz = clampCell((ez - grid.minZ) / grid.cellZ, grid.nz);

  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  const nextBound = (i: number, step: number, min: number, cell: number, o: number): number =>
    step > 0 ? min + (i + 1) * cell - o : step < 0 ? o - (min + i * cell) : Infinity;
  let tMaxX = stepX !== 0 ? tEnter + nextBound(ix, stepX, grid.minX, grid.cellX, ex) / Math.abs(dx) : Infinity;
  let tMaxY = stepY !== 0 ? tEnter + nextBound(iy, stepY, grid.minY, grid.cellY, ey) / Math.abs(dy) : Infinity;
  let tMaxZ = stepZ !== 0 ? tEnter + nextBound(iz, stepZ, grid.minZ, grid.cellZ, ez) / Math.abs(dz) : Infinity;
  const tDeltaX = stepX !== 0 ? grid.cellX / Math.abs(dx) : Infinity;
  const tDeltaY = stepY !== 0 ? grid.cellY / Math.abs(dy) : Infinity;
  const tDeltaZ = stepZ !== 0 ? grid.cellZ / Math.abs(dz) : Infinity;

  let best: RayHit | null = null;
  for (let guard = 0; guard < grid.nx + grid.ny + grid.nz + 3; guard++) {
    const cell = grid.cells[(iz * grid.ny + iy) * grid.nx + ix];
    if (cell) {
      for (const f of cell) {
        const hit = rayTriangle(positions, indices, f, ox, oy, oz, dx, dy, dz);
        if (hit && hit.t > 0 && hit.t < tMax) {
          if (!nearest) return hit;
          if (!best || hit.t < best.t) best = hit;
        }
      }
    }
    const tNext = Math.min(tMaxX, tMaxY, tMaxZ);
    // Nearest-hit can stop once the best hit precedes every remaining cell.
    if (best && best.t <= tNext) return best;
    if (tNext > tMax) return best;
    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
      ix += stepX; tMaxX += tDeltaX;
      if (ix < 0 || ix >= grid.nx) return best;
    } else if (tMaxY <= tMaxZ) {
      iy += stepY; tMaxY += tDeltaY;
      if (iy < 0 || iy >= grid.ny) return best;
    } else {
      iz += stepZ; tMaxZ += tDeltaZ;
      if (iz < 0 || iz >= grid.nz) return best;
    }
  }
  return best;
}

/** Any-hit occlusion query. */
export function rayAnyHit(
  grid: TriGrid,
  positions: ArrayLike<number>,
  indices: readonly number[],
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  tMax: number,
): boolean {
  return traverse(grid, positions, indices, ox, oy, oz, dx, dy, dz, tMax, false) !== null;
}

/** Closest-hit query (cage rays for the normal bake). */
export function rayNearestHit(
  grid: TriGrid,
  positions: ArrayLike<number>,
  indices: readonly number[],
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  tMax: number,
): RayHit | null {
  return traverse(grid, positions, indices, ox, oy, oz, dx, dy, dz, tMax, true);
}

/** Möller–Trumbore, double-sided. Returns the hit with barycentrics, or null. */
export function rayTriangle(
  positions: ArrayLike<number>,
  indices: readonly number[],
  f: number,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
): RayHit | null {
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
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return { t, face: f, w0: 1 - u - v, w1: u, w2: v };
}

/** Mesh bounding box + diagonal. Returns null for empty input. */
export function meshBounds(
  positions: ArrayLike<number>,
): { min: [number, number, number]; max: [number, number, number]; diag: number } | null {
  const numV = positions.length / 3;
  if (numV === 0) return null;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let v = 0; v < numV; v++) {
    const x = positions[v * 3]!, y = positions[v * 3 + 1]!, z = positions[v * 3 + 2]!;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ], diag };
}

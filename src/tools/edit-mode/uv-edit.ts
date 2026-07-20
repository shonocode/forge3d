/**
 * 2D UV editing primitives (F-M9) — pure, headless, Vitest-pinned.
 *
 * The UV editor UI (`ui/uv-editor.ts`) works directly on a mesh's UV buffer
 * (`VertexBuffer.UVKind`), not on the half-edge EditMesh: UVs are a per-vertex
 * attribute of the *rendered* geometry, which after unwrap already has its
 * verts split per island. Everything here therefore speaks plain
 * `positions / uvs / indices` arrays.
 *
 * Contents:
 *  - `computeUVIslands`  — connected components over shared vertices
 *  - `uvBounds` / island pivot helper
 *  - `translateUVs` / `rotateUVs` / `scaleUVs` — in-place vertex-set transforms
 *  - `faceAtUVPoint`     — point-in-triangle pick in UV space
 *  - `computeFaceStretch` — per-face L2 texture stretch (1 = uniform)
 *  - `stretchToColor`    — heat ramp for the stretch overlay
 */

export interface UVIslands {
  /** Island index per vertex; -1 for verts not referenced by any face. */
  islandOfVert: Int32Array;
  /** Vertex index lists, one per island. */
  islands: number[][];
  /** Face index lists, one per island (parallel to `islands`). */
  islandFaces: number[][];
}

/**
 * Group vertices into UV islands = connected components of the
 * vertex-sharing graph. Because unwrap splits verts along island borders,
 * two faces share a vertex index iff they belong to the same island.
 */
export function computeUVIslands(indices: readonly number[], vertexCount: number): UVIslands {
  // Union-find over vertices.
  const parent = new Int32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r]! !== r) r = parent[r]!;
    // Path compression.
    let c = x;
    while (parent[c]! !== r) {
      const next = parent[c]!;
      parent[c] = r;
      c = next;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  const numF = (indices.length / 3) | 0;
  for (let f = 0; f < numF; f++) {
    const a = indices[f * 3]!;
    const b = indices[f * 3 + 1]!;
    const c = indices[f * 3 + 2]!;
    union(a, b);
    union(b, c);
  }

  const islandOfVert = new Int32Array(vertexCount).fill(-1);
  const rootToIsland = new Map<number, number>();
  const islands: number[][] = [];
  const islandFaces: number[][] = [];

  // Only verts referenced by faces get an island.
  const referenced = new Uint8Array(vertexCount);
  for (let i = 0; i < indices.length; i++) referenced[indices[i]!] = 1;

  for (let v = 0; v < vertexCount; v++) {
    if (!referenced[v]) continue;
    const root = find(v);
    let isl = rootToIsland.get(root);
    if (isl === undefined) {
      isl = islands.length;
      rootToIsland.set(root, isl);
      islands.push([]);
      islandFaces.push([]);
    }
    islandOfVert[v] = isl;
    islands[isl]!.push(v);
  }
  for (let f = 0; f < numF; f++) {
    const isl = islandOfVert[indices[f * 3]!]!;
    if (isl >= 0) islandFaces[isl]!.push(f);
  }

  return { islandOfVert, islands, islandFaces };
}

export interface UVBounds {
  minU: number;
  minV: number;
  maxU: number;
  maxV: number;
}

/** Bounding box of a vertex set in UV space. Empty set → zeros. */
export function uvBounds(uvs: ArrayLike<number>, verts: readonly number[]): UVBounds {
  if (verts.length === 0) return { minU: 0, minV: 0, maxU: 0, maxV: 0 };
  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
  for (const v of verts) {
    const u = uvs[v * 2]!;
    const w = uvs[v * 2 + 1]!;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (w < minV) minV = w;
    if (w > maxV) maxV = w;
  }
  return { minU, minV, maxU, maxV };
}

/** In-place translation of a vertex set's UVs. */
export function translateUVs(uvs: Float32Array, verts: readonly number[], du: number, dv: number): void {
  for (const v of verts) {
    uvs[v * 2] = uvs[v * 2]! + du;
    uvs[v * 2 + 1] = uvs[v * 2 + 1]! + dv;
  }
}

/** In-place CCW rotation (radians) of a vertex set's UVs around a pivot. */
export function rotateUVs(
  uvs: Float32Array,
  verts: readonly number[],
  angle: number,
  pivotU: number,
  pivotV: number,
): void {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  for (const v of verts) {
    const du = uvs[v * 2]! - pivotU;
    const dv = uvs[v * 2 + 1]! - pivotV;
    uvs[v * 2] = pivotU + du * c - dv * s;
    uvs[v * 2 + 1] = pivotV + du * s + dv * c;
  }
}

/** In-place uniform scale of a vertex set's UVs around a pivot. */
export function scaleUVs(
  uvs: Float32Array,
  verts: readonly number[],
  factor: number,
  pivotU: number,
  pivotV: number,
): void {
  for (const v of verts) {
    uvs[v * 2] = pivotU + (uvs[v * 2]! - pivotU) * factor;
    uvs[v * 2 + 1] = pivotV + (uvs[v * 2 + 1]! - pivotV) * factor;
  }
}

/** In-place mirror of a vertex set's UVs across the pivot line perpendicular to `axis`. */
export function flipUVs(
  uvs: Float32Array,
  verts: readonly number[],
  axis: "u" | "v",
  pivotU: number,
  pivotV: number,
): void {
  for (const v of verts) {
    if (axis === "u") uvs[v * 2] = 2 * pivotU - uvs[v * 2]!;
    else uvs[v * 2 + 1] = 2 * pivotV - uvs[v * 2 + 1]!;
  }
}

/**
 * Weld a vertex set to its UV centroid (all verts get the same UV).
 * Positions in 3D are untouched — this only stitches the texture lookup,
 * e.g. to close a visible seam between islands. Returns the centroid.
 */
export function weldUVs(uvs: Float32Array, verts: readonly number[]): [number, number] {
  if (verts.length === 0) return [0, 0];
  let su = 0;
  let sv = 0;
  for (const v of verts) {
    su += uvs[v * 2]!;
    sv += uvs[v * 2 + 1]!;
  }
  const cu = su / verts.length;
  const cv = sv / verts.length;
  for (const v of verts) {
    uvs[v * 2] = cu;
    uvs[v * 2 + 1] = cv;
  }
  return [cu, cv];
}

/**
 * Align a vertex set on one axis: every vert gets the mean U (axis "u") or
 * mean V (axis "v"), straightening the run into a vertical / horizontal
 * line. Returns the aligned coordinate.
 */
export function alignUVs(uvs: Float32Array, verts: readonly number[], axis: "u" | "v"): number {
  if (verts.length === 0) return 0;
  const off = axis === "u" ? 0 : 1;
  let sum = 0;
  for (const v of verts) sum += uvs[v * 2 + off]!;
  const mean = sum / verts.length;
  for (const v of verts) uvs[v * 2 + off] = mean;
  return mean;
}

/**
 * Topmost face whose UV triangle contains point (u, v), or -1.
 * Iterates in face order; with non-overlapping islands there is at most one
 * hit anyway. Barycentric sign test, tolerant of either winding.
 */
export function faceAtUVPoint(uvs: ArrayLike<number>, indices: readonly number[], u: number, v: number): number {
  const numF = (indices.length / 3) | 0;
  for (let f = 0; f < numF; f++) {
    const a = indices[f * 3]!;
    const b = indices[f * 3 + 1]!;
    const c = indices[f * 3 + 2]!;
    const ax = uvs[a * 2]!, ay = uvs[a * 2 + 1]!;
    const bx = uvs[b * 2]!, by = uvs[b * 2 + 1]!;
    const cx = uvs[c * 2]!, cy = uvs[c * 2 + 1]!;
    const d1 = (u - bx) * (ay - by) - (ax - bx) * (v - by);
    const d2 = (u - cx) * (by - cy) - (bx - cx) * (v - cy);
    const d3 = (u - ax) * (cy - ay) - (cx - ax) * (v - ay);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    if (!(hasNeg && hasPos)) return f;
  }
  return -1;
}

/** Cap applied to degenerate / infinitely stretched faces. */
export const STRETCH_MAX = 8;

/**
 * Per-face L2 texture stretch (Sander et al. 2001), normalized so that a
 * globally uniform mapping scores exactly 1 on every face.
 *
 * For each triangle we form the UV→3D Jacobian J (3×2) and take the singular
 * values σmax ≥ σmin of the mapping; L2 = √((σmax² + σmin²) / 2). Because
 * packing applies an arbitrary global scale, all values are divided by the
 * area-derived global scale √(Σarea3D / ΣareaUV) — so 1 means "same texel
 * density as the mesh average, no shear", larger means stretched/sheared.
 * Faces with a degenerate UV footprint score `STRETCH_MAX`.
 *
 * Returns one value per face; an all-degenerate input returns all 1s (no
 * usable density reference).
 */
export function computeFaceStretch(
  positions: ArrayLike<number>,
  uvs: ArrayLike<number>,
  indices: readonly number[],
): Float32Array {
  const numF = (indices.length / 3) | 0;
  const out = new Float32Array(numF).fill(1);

  let totalArea3D = 0;
  let totalAreaUV = 0;
  // First pass: raw per-face σ² pair, plus areas for the global scale.
  const sig = new Float64Array(numF * 2).fill(-1); // [σmax², σmin²] or -1 = degenerate
  for (let f = 0; f < numF; f++) {
    const ia = indices[f * 3]!, ib = indices[f * 3 + 1]!, ic = indices[f * 3 + 2]!;
    // UV edges.
    const u1 = uvs[ib * 2]! - uvs[ia * 2]!;
    const v1 = uvs[ib * 2 + 1]! - uvs[ia * 2 + 1]!;
    const u2 = uvs[ic * 2]! - uvs[ia * 2]!;
    const v2 = uvs[ic * 2 + 1]! - uvs[ia * 2 + 1]!;
    // 3D edges.
    const e1x = positions[ib * 3]! - positions[ia * 3]!;
    const e1y = positions[ib * 3 + 1]! - positions[ia * 3 + 1]!;
    const e1z = positions[ib * 3 + 2]! - positions[ia * 3 + 2]!;
    const e2x = positions[ic * 3]! - positions[ia * 3]!;
    const e2y = positions[ic * 3 + 1]! - positions[ia * 3 + 1]!;
    const e2z = positions[ic * 3 + 2]! - positions[ia * 3 + 2]!;

    const detUV = u1 * v2 - u2 * v1;
    // 3D area (×2) via cross product magnitude.
    const cx = e1y * e2z - e1z * e2y;
    const cy = e1z * e2x - e1x * e2z;
    const cz = e1x * e2y - e1y * e2x;
    const area3D2 = Math.sqrt(cx * cx + cy * cy + cz * cz);
    totalArea3D += area3D2 / 2;
    totalAreaUV += Math.abs(detUV) / 2;

    if (Math.abs(detUV) < 1e-12) continue; // degenerate — flagged by sig=-1

    // Partial derivatives of the UV→3D map: Ss = ∂P/∂u, St = ∂P/∂v.
    const inv = 1 / detUV;
    const ssx = (e1x * v2 - e2x * v1) * inv;
    const ssy = (e1y * v2 - e2y * v1) * inv;
    const ssz = (e1z * v2 - e2z * v1) * inv;
    const stx = (e2x * u1 - e1x * u2) * inv;
    const sty = (e2y * u1 - e1y * u2) * inv;
    const stz = (e2z * u1 - e1z * u2) * inv;

    const a = ssx * ssx + ssy * ssy + ssz * ssz; // Ss·Ss
    const b = ssx * stx + ssy * sty + ssz * stz; // Ss·St
    const c = stx * stx + sty * sty + stz * stz; // St·St
    // Eigenvalues of [[a,b],[b,c]] = σ².
    const tr = a + c;
    const disc = Math.sqrt(Math.max(0, (a - c) * (a - c) + 4 * b * b));
    sig[f * 2] = (tr + disc) / 2;
    sig[f * 2 + 1] = Math.max(0, (tr - disc) / 2);
  }

  if (totalAreaUV < 1e-12 || totalArea3D < 1e-12) return out; // no reference density

  const globalScaleSq = totalArea3D / totalAreaUV; // (3D units per UV unit)²
  for (let f = 0; f < numF; f++) {
    const smax = sig[f * 2]!;
    if (smax < 0) {
      out[f] = STRETCH_MAX;
      continue;
    }
    const smin = sig[f * 2 + 1]!;
    const l2 = Math.sqrt((smax + smin) / 2 / globalScaleSq);
    // Under-scaled faces (l2 < 1) waste texels just like over-scaled ones
    // stretch them — fold both sides onto the ≥1 axis for the heat ramp.
    const sym = l2 >= 1 ? l2 : 1 / Math.max(l2, 1 / STRETCH_MAX);
    out[f] = Math.min(sym, STRETCH_MAX);
  }
  return out;
}

/**
 * Heat ramp for the stretch overlay: 1 → blue, ~2 → green, ≥3.5 → red.
 * Returns [r, g, b] each 0–255.
 */
export function stretchToColor(value: number): [number, number, number] {
  // Normalize 1..3.5 → 0..1.
  const t = Math.min(1, Math.max(0, (value - 1) / 2.5));
  // Blue (0.0) → green (0.5) → red (1.0), simple two-segment lerp.
  if (t < 0.5) {
    const k = t * 2;
    return [Math.round(40 * (1 - k) + 40 * k), Math.round(90 * (1 - k) + 200 * k), Math.round(220 * (1 - k) + 90 * k)];
  }
  const k = (t - 0.5) * 2;
  return [Math.round(40 * (1 - k) + 230 * k), Math.round(200 * (1 - k) + 60 * k), Math.round(90 * (1 - k) + 50 * k)];
}

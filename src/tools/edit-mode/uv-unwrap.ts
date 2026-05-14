import { canonicalEdge, edgeEnd, edgeOrigin, faceVertices, isSeam, type EditMesh } from "./half-edge";

/**
 * Smart UV Project — Blender-style.
 *
 * Algorithm:
 *  1. Cluster faces by walking face adjacency via half-edges. A walk stops
 *     when the next edge is a seam (user-marked) or when the next face's
 *     normal deviates from the cluster's average normal beyond `angleLimit`.
 *  2. For each cluster, choose 2 orthogonal tangent axes perpendicular to the
 *     cluster's average normal. Project each face's verts onto these → 2D
 *     UV island.
 *  3. Pack islands into the 0–1 UV box with a simple grid layout (rows ×
 *     cols of square cells, each island scaled to fit its cell while
 *     preserving aspect ratio).
 *
 * Output: a `UnwrapResult` containing the rebuilt geometry with one vertex
 * per (originalVertex, cluster) pair — so verts on cluster boundaries are
 * duplicated, each duplicate carrying that cluster's UV. The caller writes
 * this back to the Babylon mesh and rebuilds the EditMesh half-edges.
 *
 * V1 limitations:
 *  - Skin weights / morph targets are **lost** (vertex buffer is rebuilt).
 *    Callers must guard against running this on rigged meshes or accept the
 *    reset.
 *  - Packing is greedy grid, not rect-pack. Sparse islands waste UV space.
 */

export interface UnwrapResult {
  positions: Float32Array;
  indices: number[];
  uvs: Float32Array;
}

export interface UnwrapOptions {
  /** Max angle (degrees) between a face's normal and its cluster's avg normal
   *  before the face starts a new cluster. Blender default: 66°. */
  angleLimit: number;
  /** UV padding between islands, in 0–1 space. */
  islandMargin: number;
}

const DEFAULT_OPTIONS: UnwrapOptions = { angleLimit: 66, islandMargin: 0.02 };

export function smartUVProject(em: EditMesh, opts: Partial<UnwrapOptions> = {}): UnwrapResult {
  const options: UnwrapOptions = { ...DEFAULT_OPTIONS, ...opts };
  const cosThreshold = Math.cos((options.angleLimit * Math.PI) / 180);

  // 1. Cluster faces.
  const clusters = clusterFaces(em, cosThreshold);

  // 2. Project each cluster to 2D.
  type Island = {
    faces: number[];
    /** Per-face-corner UVs as a Map(faceId -> [u0,v0, u1,v1, u2,v2]). */
    faceUVs: Map<number, [number, number, number, number, number, number]>;
    bbox: { minU: number; minV: number; maxU: number; maxV: number };
  };
  const islands: Island[] = clusters.map((c) => projectCluster(em, c));

  // 3. Pack islands.
  packIslands(islands, options.islandMargin);

  // 4. Assemble rebuilt geometry. For each face, emit 3 fresh vertices (per-
  //    cluster duplication is implicit in this approach — verts shared
  //    within a cluster get the same UV / position, but we still emit them
  //    once per face for simplicity and let weldVerticesWithinCluster
  //    optionally collapse them later).
  //
  //    For Phase 7 we ship the simpler "split per face" form: every face
  //    contributes 3 unique new vertices. This is suboptimal storage-wise
  //    (cube goes from 8 verts to 36) but keeps the algorithm bulletproof.
  //    Cluster-internal welding can come in Phase 7.5.
  return assembleSplit(em, islands);
}

// ── Clustering ─────────────────────────────────────────────────────────────

function clusterFaces(em: EditMesh, cosThreshold: number): number[][] {
  const visited = new Uint8Array(em.faces.length);
  const clusters: number[][] = [];

  for (let seed = 0; seed < em.faces.length; seed++) {
    if (visited[seed]) continue;
    const cluster: number[] = [];
    const queue: number[] = [seed];
    visited[seed] = 1;
    const seedNormal = faceNormal(em, seed);
    let avgNormal: [number, number, number] = [seedNormal[0], seedNormal[1], seedNormal[2]];

    while (queue.length > 0) {
      const cur = queue.pop()!;
      cluster.push(cur);
      const h0 = em.faces[cur]!.he;
      const h1 = em.halfEdges[h0]!.next;
      const h2 = em.halfEdges[h1]!.next;
      for (const h of [h0, h1, h2]) {
        const twin = em.halfEdges[h]!.twin;
        if (twin < 0) continue;
        const neighbor = em.halfEdges[twin]!.face;
        if (visited[neighbor]) continue;
        // Seams force a cluster boundary regardless of coplanarity.
        if (isSeam(em, canonicalEdge(em, h))) continue;
        const n = faceNormal(em, neighbor);
        const dot = n[0] * avgNormal[0] + n[1] * avgNormal[1] + n[2] * avgNormal[2];
        if (dot < cosThreshold) continue;
        visited[neighbor] = 1;
        queue.push(neighbor);
        // Update running average normal so the cluster grows in a coherent
        // direction. Cheap incremental mean — good enough for projection.
        const k = cluster.length;
        avgNormal = [
          (avgNormal[0] * k + n[0]) / (k + 1),
          (avgNormal[1] * k + n[1]) / (k + 1),
          (avgNormal[2] * k + n[2]) / (k + 1),
        ];
        const len = Math.sqrt(avgNormal[0] ** 2 + avgNormal[1] ** 2 + avgNormal[2] ** 2);
        if (len > 1e-9) avgNormal = [avgNormal[0] / len, avgNormal[1] / len, avgNormal[2] / len];
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

// ── Per-cluster projection ─────────────────────────────────────────────────

function projectCluster(em: EditMesh, faces: number[]): {
  faces: number[];
  faceUVs: Map<number, [number, number, number, number, number, number]>;
  bbox: { minU: number; minV: number; maxU: number; maxV: number };
} {
  // Average normal of the cluster.
  let nx = 0, ny = 0, nz = 0;
  for (const f of faces) {
    const n = faceNormal(em, f);
    nx += n[0]; ny += n[1]; nz += n[2];
  }
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  nx /= len; ny /= len; nz /= len;

  // Build orthonormal (tangent, bitangent, normal) basis. Use the world-axis
  // most perpendicular to N for stability.
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  const helper: [number, number, number] = ax < ay && ax < az ? [1, 0, 0] : ay < az ? [0, 1, 0] : [0, 0, 1];
  // tangent = normalize(cross(helper, n))
  let tx = helper[1] * nz - helper[2] * ny;
  let ty = helper[2] * nx - helper[0] * nz;
  let tz = helper[0] * ny - helper[1] * nx;
  const tlen = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
  tx /= tlen; ty /= tlen; tz /= tlen;
  // bitangent = cross(n, t)
  const bx = ny * tz - nz * ty;
  const by = nz * tx - nx * tz;
  const bz = nx * ty - ny * tx;

  const faceUVs = new Map<number, [number, number, number, number, number, number]>();
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;

  for (const f of faces) {
    const verts = faceVertices(em, f);
    const uvs: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const v = verts[i]!;
      const x = em.positions[v * 3]!;
      const y = em.positions[v * 3 + 1]!;
      const z = em.positions[v * 3 + 2]!;
      const u = x * tx + y * ty + z * tz;
      const w = x * bx + y * by + z * bz;
      uvs[i * 2] = u;
      uvs[i * 2 + 1] = w;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (w < minV) minV = w;
      if (w > maxV) maxV = w;
    }
    faceUVs.set(f, uvs);
  }

  return { faces, faceUVs, bbox: { minU, minV, maxU, maxV } };
}

// ── Packing ────────────────────────────────────────────────────────────────

function packIslands(
  islands: Array<{
    faces: number[];
    faceUVs: Map<number, [number, number, number, number, number, number]>;
    bbox: { minU: number; minV: number; maxU: number; maxV: number };
  }>,
  margin: number,
): void {
  if (islands.length === 0) return;
  const cols = Math.ceil(Math.sqrt(islands.length));
  const rows = Math.ceil(islands.length / cols);
  const cellW = 1 / cols;
  const cellH = 1 / rows;
  const innerW = cellW - margin;
  const innerH = cellH - margin;

  for (let i = 0; i < islands.length; i++) {
    const island = islands[i]!;
    const { minU, minV, maxU, maxV } = island.bbox;
    const w = maxU - minU || 1e-6;
    const h = maxV - minV || 1e-6;
    // Uniform scale to fit within the cell while preserving aspect ratio.
    const scale = Math.min(innerW / w, innerH / h);
    const col = i % cols;
    const row = Math.floor(i / cols);
    // Center within the cell.
    const offsetU = col * cellW + (cellW - w * scale) / 2;
    const offsetV = row * cellH + (cellH - h * scale) / 2;

    for (const uvs of island.faceUVs.values()) {
      for (let k = 0; k < 3; k++) {
        uvs[k * 2] = (uvs[k * 2]! - minU) * scale + offsetU;
        uvs[k * 2 + 1] = (uvs[k * 2 + 1]! - minV) * scale + offsetV;
      }
    }
  }
}

// ── Assemble output (split-per-face form) ──────────────────────────────────

function assembleSplit(
  em: EditMesh,
  islands: Array<{
    faces: number[];
    faceUVs: Map<number, [number, number, number, number, number, number]>;
    bbox: { minU: number; minV: number; maxU: number; maxV: number };
  }>,
): UnwrapResult {
  const positions: number[] = [];
  const indices: number[] = [];
  const uvs: number[] = [];

  for (const island of islands) {
    for (const f of island.faces) {
      const verts = faceVertices(em, f);
      const fUV = island.faceUVs.get(f)!;
      const base = positions.length / 3;
      for (let i = 0; i < 3; i++) {
        const v = verts[i]!;
        positions.push(em.positions[v * 3]!, em.positions[v * 3 + 1]!, em.positions[v * 3 + 2]!);
        uvs.push(fUV[i * 2]!, fUV[i * 2 + 1]!);
      }
      indices.push(base, base + 1, base + 2);
    }
  }

  return {
    positions: new Float32Array(positions),
    indices,
    uvs: new Float32Array(uvs),
  };
}

// ── Utils ──────────────────────────────────────────────────────────────────

function faceNormal(em: EditMesh, f: number): [number, number, number] {
  const [a, b, c] = faceVertices(em, f);
  const ax = em.positions[a * 3]!, ay = em.positions[a * 3 + 1]!, az = em.positions[a * 3 + 2]!;
  const bx = em.positions[b * 3]!, by = em.positions[b * 3 + 1]!, bz = em.positions[b * 3 + 2]!;
  const cx = em.positions[c * 3]!, cy = em.positions[c * 3 + 1]!, cz = em.positions[c * 3 + 2]!;
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len > 1e-9) { nx /= len; ny /= len; nz /= len; }
  return [nx, ny, nz];
}

// ── Seam editing (public surface) ──────────────────────────────────────────

/** Toggle the seam flag for every selected edge. */
export function toggleSeams(em: EditMesh, selectedEdges: ReadonlySet<number>): void {
  for (const he of selectedEdges) {
    const a = edgeOrigin(em, he);
    const b = edgeEnd(em, he);
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    if (em.seams.has(key)) em.seams.delete(key);
    else em.seams.add(key);
  }
}

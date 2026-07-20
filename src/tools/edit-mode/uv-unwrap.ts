import { canonicalEdge, edgeEnd, edgeOrigin, faceHalfEdges, facePolyNormal, faceVerts, fanTriangulate, isSeam, type EditMesh } from "./half-edge";
import { packRects, type PackRect } from "./uv-pack";

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
 *  3. Pack islands into the 0–1 UV box (shelf rect-pack, uv-pack.ts).
 *
 * Output: a `UnwrapResult` containing the rebuilt geometry with one vertex
 * per (originalVertex, cluster) pair — so verts on cluster boundaries are
 * duplicated, each duplicate carrying that cluster's UV. The caller writes
 * this back to the Babylon mesh (via the fan-triangulated `indices`) and
 * rebuilds the EditMesh from `polys` — quads / n-gons survive the unwrap.
 *
 * V1 limitations:
 *  - Morph targets are **lost** (vertex buffer is rebuilt). Callers must guard
 *    against running this on morphed meshes or accept the reset. Skin weights
 *    survive: `sourceVerts` maps each rebuilt vertex to its original vertex so
 *    the caller can carry the weight buffers across.
 *  - Islands are shelf-packed (F-M9), and cluster-internal vertices are welded
 *    so a cube unwraps to ~14 verts, not 36 (split-per-face).
 */

export interface UnwrapResult {
  positions: Float32Array;
  /** Fan-triangulated render indices (what Babylon consumes). */
  indices: number[];
  uvs: Float32Array;
  /** Rebuilt polygon list — same faces as the input, remapped vert ids. */
  polys: number[][];
  /** Original vertex index each rebuilt vertex was split from (per-vertex attribute carry-over). */
  sourceVerts: number[];
}

export interface UnwrapOptions {
  /** Max angle (degrees) between a face's normal and its cluster's avg normal
   *  before the face starts a new cluster. Blender default: 66°. */
  angleLimit: number;
  /** UV padding between islands, in 0–1 space. */
  islandMargin: number;
}

const DEFAULT_OPTIONS: UnwrapOptions = { angleLimit: 66, islandMargin: 0.02 };

/** Per-island projection data. `faceUVs` holds 2 floats per face corner. */
type Island = {
  faces: number[];
  faceUVs: Map<number, number[]>;
  bbox: { minU: number; minV: number; maxU: number; maxV: number };
};

export function smartUVProject(em: EditMesh, opts: Partial<UnwrapOptions> = {}): UnwrapResult {
  const options: UnwrapOptions = { ...DEFAULT_OPTIONS, ...opts };
  const cosThreshold = Math.cos((options.angleLimit * Math.PI) / 180);

  // 1. Cluster faces.
  const clusters = clusterFaces(em, cosThreshold);

  // 2. Project each cluster to 2D.
  const islands: Island[] = clusters.map((c) => projectCluster(em, c));

  // 3. Pack islands (shelf rect-pack — see uv-pack.ts).
  packIslands(islands, options.islandMargin);

  // 4. Assemble rebuilt geometry, welding vertices within each cluster: a
  //    vertex shared by several faces of the SAME island collapses to one
  //    output vertex (it has a single UV there), while vertices on a cluster
  //    boundary are still duplicated per-cluster (each carries its island's
  //    UV). Cube: 8 → 14 verts instead of split-per-face's 36.
  return assembleWelded(em, islands);
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
    const seedNormal = facePolyNormal(em, seed);
    let avgNormal: [number, number, number] = [seedNormal[0], seedNormal[1], seedNormal[2]];

    while (queue.length > 0) {
      const cur = queue.pop()!;
      cluster.push(cur);
      for (const h of faceHalfEdges(em, cur)) {
        const twin = em.halfEdges[h]!.twin;
        if (twin < 0) continue;
        const neighbor = em.halfEdges[twin]!.face;
        if (visited[neighbor]) continue;
        // Seams force a cluster boundary regardless of coplanarity.
        if (isSeam(em, canonicalEdge(em, h))) continue;
        const n = facePolyNormal(em, neighbor);
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

function projectCluster(em: EditMesh, faces: number[]): Island {
  // Average normal of the cluster.
  let nx = 0, ny = 0, nz = 0;
  for (const f of faces) {
    const n = facePolyNormal(em, f);
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

  const faceUVs = new Map<number, number[]>();
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;

  for (const f of faces) {
    const verts = faceVerts(em, f);
    const uvs: number[] = new Array(verts.length * 2);
    for (let i = 0; i < verts.length; i++) {
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

function packIslands(islands: Island[], margin: number): void {
  if (islands.length === 0) return;

  // Shelf rect-pack (uv-pack.ts): one shared scale keeps texel density
  // consistent across islands, and aspect ratios are preserved.
  const rects: PackRect[] = islands.map((isl) => ({
    w: (isl.bbox.maxU - isl.bbox.minU) || 1e-6,
    h: (isl.bbox.maxV - isl.bbox.minV) || 1e-6,
  }));
  const { placements } = packRects(rects, margin);

  for (let i = 0; i < islands.length; i++) {
    const island = islands[i]!;
    const { minU, minV } = island.bbox;
    const { offsetU, offsetV, scale } = placements[i]!;
    for (const uvs of island.faceUVs.values()) {
      for (let k = 0; k < uvs.length / 2; k++) {
        uvs[k * 2] = (uvs[k * 2]! - minU) * scale + offsetU;
        uvs[k * 2 + 1] = (uvs[k * 2 + 1]! - minV) * scale + offsetV;
      }
    }
  }
}

// ── Assemble output (cluster-welded form) ──────────────────────────────────

function assembleWelded(em: EditMesh, islands: Island[]): UnwrapResult {
  const positions: number[] = [];
  const indices: number[] = [];
  const uvs: number[] = [];
  const polys: number[][] = [];
  const sourceVerts: number[] = [];

  for (const island of islands) {
    // Weld within a cluster: a source vertex shared by several faces of this
    // island resolves to one output vertex. Keyed by (island, sourceVert) —
    // the island scope keeps boundary verts split between clusters, so each
    // side keeps its own UV. UVs of a vertex are identical across the
    // island's faces here (planar projection), so no seam is lost.
    const weld = new Map<number, number>();
    for (const f of island.faces) {
      const verts = faceVerts(em, f);
      const fUV = island.faceUVs.get(f)!;
      const poly: number[] = [];
      for (let i = 0; i < verts.length; i++) {
        const v = verts[i]!;
        let out = weld.get(v);
        if (out === undefined) {
          out = positions.length / 3;
          weld.set(v, out);
          positions.push(em.positions[v * 3]!, em.positions[v * 3 + 1]!, em.positions[v * 3 + 2]!);
          uvs.push(fUV[i * 2]!, fUV[i * 2 + 1]!);
          sourceVerts.push(v);
        }
        poly.push(out);
      }
      polys.push(poly);
      indices.push(...fanTriangulate(poly));
    }
  }

  return {
    positions: new Float32Array(positions),
    indices,
    uvs: new Float32Array(uvs),
    polys,
    sourceVerts,
  };
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

/**
 * Toggle the Catmull-Clark crease flag for every selected edge. If ANY selected
 * edge is uncreased, all get set to `weight` (so a mixed selection becomes fully
 * creased); otherwise all are cleared. Returns the resulting count for status.
 */
export function toggleCreases(em: EditMesh, selectedEdges: ReadonlySet<number>, weight: number): void {
  let anyUncreased = false;
  const keys: string[] = [];
  for (const he of selectedEdges) {
    const a = edgeOrigin(em, he);
    const b = edgeEnd(em, he);
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    keys.push(key);
    if ((em.creases.get(key) ?? 0) <= 0) anyUncreased = true;
  }
  for (const key of keys) {
    if (anyUncreased) em.creases.set(key, weight);
    else em.creases.delete(key);
  }
}

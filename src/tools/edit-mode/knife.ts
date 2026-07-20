/**
 * Knife V2 (F-M8) — real freehand cut, pure and headless.
 *
 * The interactive layer (edit-mode/index.ts) turns a screen-drawn line into a
 * cutting plane (camera eye + the two pick rays span it) and an `accept`
 * predicate that limits the cut to the drawn segment's screen extent. This
 * module does the geometry: split every mesh edge that crosses the plane and
 * re-triangulate the affected faces.
 *
 * Semantics match Blender's knife with "cut through" ON: the plane slices
 * front and back faces alike (there is no occlusion test).
 *
 * Guarantees:
 *  - Cut points on shared edges are computed once (keyed by vertex pair), so
 *    adjacent faces stay stitched — a watertight input stays watertight.
 *  - Winding of every output triangle matches its source face.
 *  - Topology-only change: existing vertices keep their indices, new verts
 *    are appended (so the caller's attribute transfer can interpolate UVs /
 *    weights for them).
 */

export interface PlaneCutResult {
  positions: Float32Array;
  indices: number[];
  /** Indices of the vertices created on cut edges. */
  newVerts: Set<number>;
}

/**
 * Cut the triangle soup with the plane (point, normal).
 *
 * `accept` (optional) is called with each candidate cut point; returning
 * false skips splitting that edge — the interactive knife passes a predicate
 * that keeps the cut inside the drawn screen segment. Faces with only some
 * of their crossings accepted still re-triangulate cleanly (1-cut case).
 *
 * Returns null when no edge was cut.
 */
export function planeCut(
  positions: Float32Array,
  indices: readonly number[],
  planePoint: readonly [number, number, number],
  planeNormal: readonly [number, number, number],
  accept?: (x: number, y: number, z: number) => boolean,
): PlaneCutResult | null {
  const numV = positions.length / 3;

  // Normalize the plane normal; bail on degenerate input.
  let [nx, ny, nz] = planeNormal;
  const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (nlen < 1e-12) return null;
  nx /= nlen; ny /= nlen; nz /= nlen;
  const [px, py, pz] = planePoint;

  // Signed distance per vertex + epsilon relative to the mesh extent, so
  // verts sitting on the plane don't produce sliver triangles.
  let maxAbs = 1e-6;
  const dist = new Float64Array(numV);
  for (let v = 0; v < numV; v++) {
    const d =
      (positions[v * 3]! - px) * nx +
      (positions[v * 3 + 1]! - py) * ny +
      (positions[v * 3 + 2]! - pz) * nz;
    dist[v] = d;
    const a = Math.abs(d);
    if (a > maxAbs) maxAbs = a;
  }
  const eps = maxAbs * 1e-6;
  const side = (v: number): number => (dist[v]! > eps ? 1 : dist[v]! < -eps ? -1 : 0);

  // Lazily create one cut vertex per crossed (undirected) edge.
  const outPositions: number[] = Array.from(positions);
  const cutOfEdge = new Map<string, number>();
  const newVerts = new Set<number>();
  const cutVertex = (a: number, b: number): number => {
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    const existing = cutOfEdge.get(key);
    if (existing !== undefined) return existing;
    if (side(a) * side(b) !== -1) {
      cutOfEdge.set(key, -1);
      return -1;
    }
    const da = dist[a]!;
    const db = dist[b]!;
    const t = da / (da - db);
    const x = positions[a * 3]! + (positions[b * 3]! - positions[a * 3]!) * t;
    const y = positions[a * 3 + 1]! + (positions[b * 3 + 1]! - positions[a * 3 + 1]!) * t;
    const z = positions[a * 3 + 2]! + (positions[b * 3 + 2]! - positions[a * 3 + 2]!) * t;
    if (accept && !accept(x, y, z)) {
      cutOfEdge.set(key, -1);
      return -1;
    }
    const idx = outPositions.length / 3;
    outPositions.push(x, y, z);
    cutOfEdge.set(key, idx);
    newVerts.add(idx);
    return idx;
  };

  const outIndices: number[] = [];
  const numF = (indices.length / 3) | 0;
  for (let f = 0; f < numF; f++) {
    const v0 = indices[f * 3]!;
    const v1 = indices[f * 3 + 1]!;
    const v2 = indices[f * 3 + 2]!;
    // Cut vertex per face edge (E0 = v0-v1, E1 = v1-v2, E2 = v2-v0), -1 = none.
    const m0 = cutVertex(v0, v1);
    const m1 = cutVertex(v1, v2);
    const m2 = cutVertex(v2, v0);
    const cuts = (m0 >= 0 ? 1 : 0) + (m1 >= 0 ? 1 : 0) + (m2 >= 0 ? 1 : 0);

    if (cuts === 0) {
      outIndices.push(v0, v1, v2);
    } else if (cuts === 1) {
      // Split edge (vi, vj) at m; vk is the opposite vertex.
      const [vi, vj, vk, m] =
        m0 >= 0 ? [v0, v1, v2, m0] : m1 >= 0 ? [v1, v2, v0, m1] : [v2, v0, v1, m2];
      outIndices.push(vi, m, vk);
      outIndices.push(m, vj, vk);
    } else if (cuts === 2) {
      // The two cut edges share one vertex s: tri (mPrev, s, mNext) + quad.
      if (m0 >= 0 && m1 >= 0) {
        outIndices.push(m0, v1, m1);
        outIndices.push(v0, m0, m1);
        outIndices.push(v0, m1, v2);
      } else if (m1 >= 0 && m2 >= 0) {
        outIndices.push(m1, v2, m2);
        outIndices.push(v1, m1, m2);
        outIndices.push(v1, m2, v0);
      } else {
        outIndices.push(m2, v0, m0);
        outIndices.push(m0, v1, v2);
        outIndices.push(m0, v2, m2);
      }
    } else {
      // A plane cannot strictly cross all three edges of a triangle — this
      // would need contradictory vertex sides. Keep the face untouched.
      outIndices.push(v0, v1, v2);
    }
  }

  if (newVerts.size === 0) return null;
  return { positions: new Float32Array(outPositions), indices: outIndices, newVerts };
}

/**
 * Build the cutting plane from two viewport rays (eye rays through the two
 * endpoints of the drawn screen line). Works for perspective (shared origin)
 * and orthographic (parallel directions) cameras alike, by spanning the
 * plane over three points: A = origin1, B = origin1 + dir1·f,
 * C = origin2 + dir2·f.
 *
 * Returns null when the rays are (near-)collinear.
 */
export function planeFromRays(
  origin1: readonly [number, number, number],
  dir1: readonly [number, number, number],
  origin2: readonly [number, number, number],
  dir2: readonly [number, number, number],
  f = 1,
): { point: [number, number, number]; normal: [number, number, number] } | null {
  const bx = dir1[0] * f, by = dir1[1] * f, bz = dir1[2] * f;
  const cx = origin2[0] - origin1[0] + dir2[0] * f;
  const cy = origin2[1] - origin1[1] + dir2[1] * f;
  const cz = origin2[2] - origin1[2] + dir2[2] * f;
  const nx = by * cz - bz * cy;
  const ny = bz * cx - bx * cz;
  const nz = bx * cy - by * cx;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len < 1e-12) return null;
  return {
    point: [origin1[0], origin1[1], origin1[2]],
    normal: [nx / len, ny / len, nz / len],
  };
}

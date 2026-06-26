/**
 * Dyntopo — adaptive topology refinement for sculpting.
 *
 * Pure and headless-testable: operates on plain position/index arrays and
 * returns new geometry plus a `parents` map so the caller can interpolate any
 * per-vertex attribute (normals, UVs, mask) through the topology change.
 *
 * Strategy: edge-split subdivision. Within the brush radius, any triangle edge
 * longer than `detail` is split at its midpoint. Midpoints are shared via a
 * global edge map, so adjacent triangles stay watertight (no T-junctions). Each
 * triangle is then re-triangulated by how many of its three edges were split
 * (1 → 2 tris, 2 → 3 tris, 3 → 4 tris). One refinement level per call; repeated
 * strokes refine progressively. Subdivide-only — edge collapse / decimation is a
 * roadmap F-M3 follow-up.
 */

export interface RefineResult {
  positions: Float32Array;
  indices: Uint32Array;
  /**
   * Parent vertex pair for each NEW vertex. Entry `i` describes the vertex whose
   * index is `originalVertexCount + i`; both parents are original vertices, so an
   * attribute can be reconstructed by averaging the parents (see {@link remapAttribute}).
   */
  parents: Array<[number, number]>;
  /** True when at least one edge was split (geometry differs from the input). */
  changed: boolean;
}

/**
 * Subdivide triangles whose edges exceed `detail` and lie within `radius` of any
 * of the given brush centers. Pure: inputs are never mutated.
 *
 * @param positions Flat xyz vertex positions (length = 3 * vertexCount).
 * @param indices Flat triangle indices (length = 3 * triangleCount).
 * @param centers Brush centers in the same space as `positions` (symmetry expands this).
 * @param radius Brush radius; an edge is eligible only if an endpoint is within radius of a center.
 * @param detail Target edge length; edges shorter than this are left alone.
 */
export function refineWithinRadii(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  centers: ReadonlyArray<readonly [number, number, number]>,
  radius: number,
  detail: number,
): RefineResult {
  const origVertCount = positions.length / 3;
  const detail2 = detail * detail;
  const r2 = radius * radius;

  const pos: number[] = Array.from(positions);
  const midCache = new Map<number, number>(); // edge key -> midpoint vertex index
  const parents: Array<[number, number]> = [];

  const vertInRadius = (vi: number): boolean => {
    const x = pos[vi * 3]!;
    const y = pos[vi * 3 + 1]!;
    const z = pos[vi * 3 + 2]!;
    for (const c of centers) {
      const dx = x - c[0];
      const dy = y - c[1];
      const dz = z - c[2];
      if (dx * dx + dy * dy + dz * dz <= r2) return true;
    }
    return false;
  };

  // a, b are always original vertices (< origVertCount), so this key is unique.
  const edgeKey = (a: number, b: number) =>
    a < b ? a * origVertCount + b : b * origVertCount + a;

  const getMid = (a: number, b: number): number => {
    const key = edgeKey(a, b);
    const cached = midCache.get(key);
    if (cached !== undefined) return cached;
    const m = pos.length / 3;
    pos.push(
      (pos[a * 3]! + pos[b * 3]!) / 2,
      (pos[a * 3 + 1]! + pos[b * 3 + 1]!) / 2,
      (pos[a * 3 + 2]! + pos[b * 3 + 2]!) / 2,
    );
    midCache.set(key, m);
    parents.push([a, b]);
    return m;
  };

  const shouldSplit = (a: number, b: number): boolean => {
    const dx = pos[a * 3]! - pos[b * 3]!;
    const dy = pos[a * 3 + 1]! - pos[b * 3 + 1]!;
    const dz = pos[a * 3 + 2]! - pos[b * 3 + 2]!;
    if (dx * dx + dy * dy + dz * dz <= detail2) return false;
    return vertInRadius(a) || vertInRadius(b);
  };

  const out: number[] = [];
  let changed = false;

  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]!;
    const b = indices[t + 1]!;
    const c = indices[t + 2]!;
    const sab = shouldSplit(a, b);
    const sbc = shouldSplit(b, c);
    const sca = shouldSplit(c, a);
    const count = (sab ? 1 : 0) + (sbc ? 1 : 0) + (sca ? 1 : 0);

    if (count === 0) {
      out.push(a, b, c);
      continue;
    }
    changed = true;
    const mab = sab ? getMid(a, b) : -1;
    const mbc = sbc ? getMid(b, c) : -1;
    const mca = sca ? getMid(c, a) : -1;

    if (count === 3) {
      // Standard 1-to-4 split. Winding preserved (CCW).
      out.push(a, mab, mca, mab, b, mbc, mca, mbc, c, mab, mbc, mca);
    } else if (count === 1) {
      if (sab) out.push(a, mab, c, mab, b, c);
      else if (sbc) out.push(b, mbc, a, mbc, c, a);
      else out.push(c, mca, b, mca, a, b);
    } else {
      // count === 2: cut the corner shared by the two split edges, then split
      // the remaining quad. Winding preserved (derived in dyntopo.test.ts).
      if (!sab) {
        // split bc, ca → shared corner c
        out.push(mca, mbc, c, a, b, mbc, a, mbc, mca);
      } else if (!sbc) {
        // split ab, ca → shared corner a
        out.push(a, mab, mca, mab, b, c, mab, c, mca);
      } else {
        // split ab, bc → shared corner b
        out.push(mab, b, mbc, a, mab, mbc, a, mbc, c);
      }
    }
  }

  return {
    positions: new Float32Array(pos),
    indices: new Uint32Array(out),
    parents,
    changed,
  };
}

/**
 * Rebuild a per-vertex attribute array after refinement. Original vertices keep
 * their values; each new vertex receives the average of its two parents.
 *
 * @param old Original attribute, packed `comps` components per vertex.
 * @param parents The {@link RefineResult.parents} map.
 * @param comps Components per vertex (1 for mask, 2 for UV, 3 for position).
 */
export function remapAttribute(
  old: ArrayLike<number>,
  parents: ReadonlyArray<readonly [number, number]>,
  comps: number,
): Float32Array {
  const origCount = old.length / comps;
  const out = new Float32Array((origCount + parents.length) * comps);
  for (let i = 0; i < old.length; i++) out[i] = old[i]!;
  for (let i = 0; i < parents.length; i++) {
    const pa = parents[i]![0];
    const pb = parents[i]![1];
    const dst = (origCount + i) * comps;
    for (let k = 0; k < comps; k++) {
      out[dst + k] = (old[pa * comps + k]! + old[pb * comps + k]!) / 2;
    }
  }
  return out;
}

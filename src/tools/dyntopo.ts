/**
 * Dyntopo — adaptive topology refinement for sculpting.
 *
 * Pure and headless-testable: operates on plain position/index arrays and
 * returns new geometry plus a source map so the caller can interpolate any
 * per-vertex attribute (normals, UVs, mask) through the topology change.
 *
 * Two complementary passes, both scoped to the brush radius:
 *
 *  - **Subdivide** ({@link refineWithinRadii}): any edge longer than `detail`
 *    is split at its midpoint. Midpoints are shared via a global edge map, so
 *    adjacent triangles stay watertight (no T-junctions). Each triangle is
 *    re-triangulated by how many of its three edges were split (1 → 2 tris,
 *    2 → 3 tris, 3 → 4 tris).
 *  - **Collapse** ({@link collapseWithinRadii}): any edge shorter than
 *    `detail · COLLAPSE_FACTOR` merges to its midpoint, so smoothed-out or
 *    compressed regions coarsen back instead of accumulating density forever.
 *    Per pass only an INDEPENDENT edge set collapses (no shared endpoints) and
 *    the classic link condition guards against non-manifold pinches.
 *
 * One level per call in each direction; repeated strokes refine/coarsen
 * progressively toward the `detail` target — true adaptive topology.
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

// ── Edge collapse (decimation) ─────────────────────────────────────────────

/** Edges shorter than `detail · COLLAPSE_FACTOR` are collapse candidates. */
export const COLLAPSE_FACTOR = 0.4;

export interface CollapseResult {
  positions: Float32Array;
  indices: Uint32Array;
  /**
   * For each OUTPUT vertex: its source pair `[pa, pb]` in the INPUT vertex
   * numbering. Untouched vertices have `pa === pb`; a collapse survivor lists
   * the two merged endpoints (its attributes = their average — see
   * {@link remapAttributeBySources}). Empty when `changed` is false.
   */
  sources: Array<[number, number]>;
  /** True when at least one edge collapsed (geometry differs from the input). */
  changed: boolean;
}

/**
 * Collapse edges shorter than `detail · COLLAPSE_FACTOR` that lie within
 * `radius` of any brush center. Pure: inputs are never mutated.
 *
 * Safety per pass:
 *  - Only an INDEPENDENT edge set collapses (endpoints used at most once), so
 *    chains of tiny edges shrink progressively instead of telescoping to a
 *    point in one dab.
 *  - The classic link condition (common vertex neighbors of the endpoints ==
 *    2 for interior edges / 1 for boundary edges) rejects collapses that would
 *    pinch the surface non-manifold.
 *  - Edges with >2 incident faces (already non-manifold) are left alone.
 *
 * The survivor vertex moves to the edge midpoint; triangles that degenerate
 * are dropped and the vertex buffer is compacted (ascending input order, so
 * the mapping is deterministic).
 */
export function collapseWithinRadii(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  centers: ReadonlyArray<readonly [number, number, number]>,
  radius: number,
  detail: number,
): CollapseResult {
  const n = positions.length / 3;
  const thresh2 = detail * COLLAPSE_FACTOR * (detail * COLLAPSE_FACTOR);
  const r2 = radius * radius;

  const vertInRadius = (vi: number): boolean => {
    const x = positions[vi * 3]!;
    const y = positions[vi * 3 + 1]!;
    const z = positions[vi * 3 + 2]!;
    for (const c of centers) {
      const dx = x - c[0];
      const dy = y - c[1];
      const dz = z - c[2];
      if (dx * dx + dy * dy + dz * dz <= r2) return true;
    }
    return false;
  };

  // Adjacency + incident-face count per undirected edge.
  const key = (a: number, b: number): number => (a < b ? a * n + b : b * n + a);
  const nbr: Array<Set<number>> = Array.from({ length: n }, () => new Set<number>());
  const edgeFaces = new Map<number, number>();
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]!, b = indices[t + 1]!, c = indices[t + 2]!;
    for (const [u, v] of [[a, b], [b, c], [c, a]] as const) {
      nbr[u]!.add(v);
      nbr[v]!.add(u);
      const k = key(u, v);
      edgeFaces.set(k, (edgeFaces.get(k) ?? 0) + 1);
    }
  }

  // Greedy independent selection in deterministic (triangle-order) edge order.
  const used = new Uint8Array(n);
  const partner = new Int32Array(n).fill(-1); // survivor a → removed b
  const target = new Int32Array(n).fill(-1);  // removed b → survivor a
  const seen = new Set<number>();
  let any = false;

  for (let t = 0; t < indices.length; t += 3) {
    const a0 = indices[t]!, b0 = indices[t + 1]!, c0 = indices[t + 2]!;
    for (const [a, b] of [[a0, b0], [b0, c0], [c0, a0]] as const) {
      const k = key(a, b);
      if (seen.has(k)) continue;
      seen.add(k);
      const fc = edgeFaces.get(k)!;
      if (fc > 2) continue; // non-manifold edge — leave alone
      const dx = positions[a * 3]! - positions[b * 3]!;
      const dy = positions[a * 3 + 1]! - positions[b * 3 + 1]!;
      const dz = positions[a * 3 + 2]! - positions[b * 3 + 2]!;
      if (dx * dx + dy * dy + dz * dz >= thresh2) continue;
      if (!vertInRadius(a) && !vertInRadius(b)) continue;
      if (used[a] || used[b]) continue;
      // Link condition: interior edge → exactly 2 common neighbors, boundary → 1.
      let common = 0;
      for (const v of nbr[a]!) if (nbr[b]!.has(v)) common++;
      if (common !== (fc === 2 ? 2 : 1)) continue;
      used[a] = used[b] = 1;
      partner[a] = b;
      target[b] = a;
      any = true;
    }
  }

  if (!any) {
    return {
      positions: Float32Array.from(positions as ArrayLike<number>),
      indices: Uint32Array.from(indices as ArrayLike<number>),
      sources: [],
      changed: false,
    };
  }

  // Survivors move to the edge midpoint.
  const pos = Float32Array.from(positions as ArrayLike<number>);
  for (let a = 0; a < n; a++) {
    const b = partner[a]!;
    if (b < 0) continue;
    pos[a * 3] = (pos[a * 3]! + positions[b * 3]!) / 2;
    pos[a * 3 + 1] = (pos[a * 3 + 1]! + positions[b * 3 + 1]!) / 2;
    pos[a * 3 + 2] = (pos[a * 3 + 2]! + positions[b * 3 + 2]!) / 2;
  }

  // Remap removed → survivor, drop degenerate faces.
  const mapped = (v: number): number => (target[v]! >= 0 ? target[v]! : v);
  const keptTris: number[] = [];
  for (let t = 0; t < indices.length; t += 3) {
    const a = mapped(indices[t]!);
    const b = mapped(indices[t + 1]!);
    const c = mapped(indices[t + 2]!);
    if (a === b || b === c || c === a) continue;
    keptTris.push(a, b, c);
  }

  // Compact to referenced vertices (ascending input order = deterministic).
  const oldToNew = new Int32Array(n).fill(-1);
  const referenced: number[] = [];
  for (const v of keptTris) {
    if (oldToNew[v]! < 0) {
      oldToNew[v] = 0; // mark; numbered in the ordered pass below
      referenced.push(v);
    }
  }
  referenced.sort((p, q) => p - q);
  const outPos = new Float32Array(referenced.length * 3);
  const sources: Array<[number, number]> = new Array(referenced.length);
  for (let i = 0; i < referenced.length; i++) {
    const o = referenced[i]!;
    oldToNew[o] = i;
    outPos[i * 3] = pos[o * 3]!;
    outPos[i * 3 + 1] = pos[o * 3 + 1]!;
    outPos[i * 3 + 2] = pos[o * 3 + 2]!;
    const b = partner[o]!;
    sources[i] = b >= 0 ? [o, b] : [o, o];
  }
  const outIdx = new Uint32Array(keptTris.length);
  for (let i = 0; i < keptTris.length; i++) outIdx[i] = oldToNew[keptTris[i]!]!;

  return { positions: outPos, indices: outIdx, sources, changed: true };
}

/**
 * Rebuild a per-vertex attribute array after a collapse. Each output vertex
 * takes the average of its {@link CollapseResult.sources} pair (identical
 * pair = value passes through verbatim).
 */
export function remapAttributeBySources(
  old: ArrayLike<number>,
  sources: ReadonlyArray<readonly [number, number]>,
  comps: number,
): Float32Array {
  const out = new Float32Array(sources.length * comps);
  for (let i = 0; i < sources.length; i++) {
    const [pa, pb] = sources[i]!;
    for (let k = 0; k < comps; k++) {
      out[i * comps + k] = (old[pa * comps + k]! + old[pb * comps + k]!) / 2;
    }
  }
  return out;
}

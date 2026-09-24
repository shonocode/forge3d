/**
 * Catmull-Clark subdivision surface (half-edge V2), with semi-sharp creases.
 *
 * Pure and headless — operates on a positions buffer + polygon list (the same
 * representation `toPolygons` / `rebuildPolygons` use), so the Edit Mode
 * wrapper just feeds `em` through and rebuilds. Every subdivision level turns
 * each n-gon into n quads and smooths the surface toward the limit surface,
 * which is why quad half-edge V2 is the prerequisite: the result is all-quad
 * and only stays clean if the mesh can actually hold quads.
 *
 * Base rules (standard Catmull-Clark, with the cubic-B-spline boundary rule so
 * open meshes keep their silhouette instead of shrinking):
 *
 *  - **Face point** F_f  = centroid of face f's vertices.
 *  - **Edge point**  E_e = interior edge: mean of its 2 endpoints and the 2
 *                          adjacent face points. Boundary edge: edge midpoint.
 *  - **Vertex point** for an interior vertex of valence n:
 *        V' = (Q + 2R + (n-3)P) / n
 *      Q = mean of incident face points, R = mean of incident edge MIDPOINTS,
 *      P = the original position.
 *    For a boundary vertex: V' = (6P + b1 + b2) / 8.
 *  - **New faces**: face f = [v0…vn-1] (CCW) emits one quad per corner vi:
 *        [ V'(vi), E(vi,vi+1), F_f, E(vi-1,vi) ]  (verified CCW).
 *
 * Creases (DeRose et al. 1998, blended semi-sharp): a per-edge sharpness
 * σ ≥ 0 (0 = smooth, ≥ 1 = fully sharp this level, fractional = blend). A
 * boundary edge behaves like σ = ∞.
 *
 *  - **Sharp edge point** = edge midpoint; blended with the smooth edge point
 *    by min(σ, 1).
 *  - **Vertex point** = lerp(smoothPos, creasePos, min(σ̄, 1)), where σ̄ is the
 *    mean sharpness of the vertex's crease edges and creasePos depends on how
 *    many crease/boundary edges meet the vertex:
 *      ≤1 crease → smoothPos (a lone crease is a "dart", stays smooth),
 *       2 creases → (6P + n1 + n2)/8 using the two sharpest crease neighbors,
 *      ≥3 creases → P (corner, pinned).
 *  - **Propagation**: each crease edge's two child edges inherit σ−1 (dropped
 *    once it reaches 0), so a σ of 2 stays sharp for two levels then relaxes.
 *
 * Non-manifold edges (>2 faces) are treated as boundaries for the edge point
 * (midpoint) — a safe degeneration that keeps the operator total.
 */

export interface SubdivResult {
  positions: Float32Array;
  polys: number[][];
  /** Propagated crease map keyed by child-edge "min_max" vertex ids. */
  creases: Map<string, number>;
  /**
   * Per face corner UVs, when UVs were given — `uvs[f][i]` is corner `i` of
   * output face `f`, the same shape `MeshData.uvs` has.
   */
  uvs?: number[][][];
}

/**
 * Two corners at one vertex hold the same UV value when they are this close —
 * Blender's `STD_UV_CONNECT_LIMIT`, which its subdivision converter uses to
 * decide which corners share a face-varying value.
 */
const UV_CONNECT_LIMIT = 0.0001;

/**
 * One level of **face-varying** Catmull-Clark on a UV layer — what Blender's
 * Subdivision Surface does with UVs under its default UV Smooth, "Keep
 * Boundaries" (OpenSubdiv's `FVAR_LINEAR_BOUNDARIES`):
 *
 * - corners at a vertex share a UV value when their UVs are within
 *   `UV_CONNECT_LIMIT`; an edge is **continuous** in UV when both faces on it
 *   share the values at both ends — otherwise it is a UV boundary (a seam or
 *   the mesh's own boundary);
 * - on UV boundaries interpolation is **linear**: a boundary edge's point is
 *   its midpoint and a boundary value does not move;
 * - everywhere else the UVs are smoothed by the same Catmull-Clark rules as
 *   the positions: face point = mean, edge point = (a + b + two face points)
 *   / 4, value point = (Q + 2R + (n − 3)S) / n.
 *
 * Output corners follow `subdivideOnce`'s quads, `[V(vi), E(vi,vi+1), F, E(vi-1,vi)]`.
 */
function subdivideUVOnce(polys: number[][], uvs: number[][][]): number[][][] {
  const F = polys.length;
  // ── face-varying values: corners at one vertex with (nearly) equal UVs ────
  const values: number[][] = [];
  const valueAt = new Map<number, number[]>(); // vertex → its value ids
  const cid: number[][] = polys.map((p, f) =>
    p.map((v, i) => {
      const uv = uvs[f]![i]!;
      const ids = valueAt.get(v) ?? [];
      for (const id of ids) {
        const w = values[id]!;
        if (Math.abs(w[0]! - uv[0]!) < UV_CONNECT_LIMIT && Math.abs(w[1]! - uv[1]!) < UV_CONNECT_LIMIT) return id;
      }
      values.push([uv[0]!, uv[1]!]);
      ids.push(values.length - 1);
      valueAt.set(v, ids);
      return values.length - 1;
    }),
  );
  // ── which edge uses are continuous in UV ─────────────────────────────────
  const uses = new Map<string, Array<[number, number]>>(); // edge → [face, corner]
  polys.forEach((p, f) =>
    p.forEach((v, i) => {
      const k = edgeKey(v, p[(i + 1) % p.length]!);
      const l = uses.get(k) ?? [];
      l.push([f, i]);
      uses.set(k, l);
    }),
  );
  const next = (f: number, i: number): number => (i + 1) % polys[f]!.length;
  const continuous = (f: number, i: number): [number, number] | null => {
    const l = uses.get(edgeKey(polys[f]![i]!, polys[f]![next(f, i)]!))!;
    if (l.length !== 2) return null;
    const [g, j] = l[0]![0] === f && l[0]![1] === i ? l[1]! : l[0]!;
    // The other face runs the edge the other way round.
    return cid[g]![j] === cid[f]![next(f, i)] && cid[g]![next(g, j)] === cid[f]![i] ? [g, j] : null;
  };
  const boundaryValue = new Uint8Array(values.length);
  polys.forEach((p, f) =>
    p.forEach((_, i) => {
      if (!continuous(f, i)) {
        boundaryValue[cid[f]![i]!] = 1;
        boundaryValue[cid[f]![next(f, i)]!] = 1;
      }
    }),
  );
  const facePoint = polys.map((p, f) => {
    let u = 0, w = 0;
    for (let i = 0; i < p.length; i++) {
      u += values[cid[f]![i]!]![0]!;
      w += values[cid[f]![i]!]![1]!;
    }
    return [u / p.length, w / p.length];
  });
  const edgePoint = (f: number, i: number): number[] => {
    const a = values[cid[f]![i]!]!;
    const b = values[cid[f]![next(f, i)]!]!;
    const o = continuous(f, i);
    if (!o) return [(a[0]! + b[0]!) / 2, (a[1]! + b[1]!) / 2];
    const fa = facePoint[f]!, fb = facePoint[o[0]]!;
    return [(a[0]! + b[0]! + fa[0]! + fb[0]!) / 4, (a[1]! + b[1]! + fa[1]! + fb[1]!) / 4];
  };
  // ── value points ─────────────────────────────────────────────────────────
  const around: Array<Array<[number, number]>> = values.map(() => []);
  polys.forEach((p, f) => p.forEach((_, i) => around[cid[f]![i]!]!.push([f, i])));
  const valuePoint = values.map((s, id) => {
    if (boundaryValue[id]) return [s[0]!, s[1]!];
    const corners = around[id]!;
    const n = corners.length;
    let qu = 0, qv = 0, ru = 0, rv = 0;
    for (const [f, i] of corners) {
      qu += facePoint[f]![0]!;
      qv += facePoint[f]![1]!;
      // Each face contributes its outgoing edge; round an interior value the
      // outgoing edges are exactly the incident edges, each once.
      const b = values[cid[f]![next(f, i)]!]!;
      ru += (s[0]! + b[0]!) / 2;
      rv += (s[1]! + b[1]!) / 2;
    }
    return [(qu / n + (2 * ru) / n + (n - 3) * s[0]!) / n, (qv / n + (2 * rv) / n + (n - 3) * s[1]!) / n];
  });
  const out: number[][][] = [];
  for (let f = 0; f < F; f++) {
    const nn = polys[f]!.length;
    for (let i = 0; i < nn; i++) {
      const prev = (i - 1 + nn) % nn;
      out.push([valuePoint[cid[f]![i]!]!, edgePoint(f, i), facePoint[f]!, edgePoint(f, prev)]);
    }
  }
  return out;
}

const SHARP = Infinity;

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

function parseKey(k: string): [number, number] {
  const us = k.indexOf("_");
  return [Number(k.slice(0, us)), Number(k.slice(us + 1))];
}

/** One Catmull-Clark step. `creases` maps edge keys to sharpness (σ ≥ 0). */
function subdivideOnce(
  positions: Float32Array,
  polys: number[][],
  creases: Map<string, number>,
): SubdivResult {
  const V = positions.length / 3;
  const F = polys.length;

  // ── Face points ────────────────────────────────────────────────────────
  const facePoint = new Float32Array(F * 3);
  for (let f = 0; f < F; f++) {
    const poly = polys[f]!;
    let cx = 0, cy = 0, cz = 0;
    for (const v of poly) {
      cx += positions[v * 3]!;
      cy += positions[v * 3 + 1]!;
      cz += positions[v * 3 + 2]!;
    }
    const n = poly.length;
    facePoint[f * 3] = cx / n;
    facePoint[f * 3 + 1] = cy / n;
    facePoint[f * 3 + 2] = cz / n;
  }

  // ── Edge adjacency (undirected edge → incident face ids) ─────────────────
  const edgeFaces = new Map<string, number[]>();
  for (let f = 0; f < F; f++) {
    const poly = polys[f]!;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      const k = edgeKey(a, b);
      let l = edgeFaces.get(k);
      if (!l) { l = []; edgeFaces.set(k, l); }
      l.push(f);
    }
  }

  // Effective sharpness of an edge: boundary / non-manifold ⇒ ∞ (fully sharp),
  // otherwise its stored crease value (default 0 = smooth).
  const sharpnessOf = (k: string, faces: number[]): number =>
    faces.length === 2 ? (creases.get(k) ?? 0) : SHARP;

  // ── New buffer layout: [original verts | face points | edge points] ──────
  const newPos: number[] = new Array(V * 3);
  const facePointIndex = new Array<number>(F);
  const edgePointIndex = new Map<string, number>();
  let cursor = V;
  for (let f = 0; f < F; f++) {
    facePointIndex[f] = cursor++;
    newPos.push(facePoint[f * 3]!, facePoint[f * 3 + 1]!, facePoint[f * 3 + 2]!);
  }
  for (const [k, faces] of edgeFaces) {
    const [a, b] = parseKey(k);
    const mx = (positions[a * 3]! + positions[b * 3]!) / 2;
    const my = (positions[a * 3 + 1]! + positions[b * 3 + 1]!) / 2;
    const mz = (positions[a * 3 + 2]! + positions[b * 3 + 2]!) / 2;
    let ex: number, ey: number, ez: number;
    const s = sharpnessOf(k, faces);
    if (faces.length === 2 && s < 1) {
      const f0 = faces[0]!, f1 = faces[1]!;
      const sx = (positions[a * 3]! + positions[b * 3]! + facePoint[f0 * 3]! + facePoint[f1 * 3]!) / 4;
      const sy = (positions[a * 3 + 1]! + positions[b * 3 + 1]! + facePoint[f0 * 3 + 1]! + facePoint[f1 * 3 + 1]!) / 4;
      const sz = (positions[a * 3 + 2]! + positions[b * 3 + 2]! + facePoint[f0 * 3 + 2]! + facePoint[f1 * 3 + 2]!) / 4;
      if (s <= 0) {
        ex = sx; ey = sy; ez = sz;
      } else {
        // Blend smooth ↔ sharp (midpoint) by σ.
        ex = sx + (mx - sx) * s;
        ey = sy + (my - sy) * s;
        ez = sz + (mz - sz) * s;
      }
    } else {
      // Fully sharp (crease σ ≥ 1) or boundary: midpoint.
      ex = mx; ey = my; ez = mz;
    }
    edgePointIndex.set(k, cursor++);
    newPos.push(ex, ey, ez);
  }

  // ── Per-vertex incidence ─────────────────────────────────────────────────
  const incidentFaces: number[][] = Array.from({ length: V }, () => []);
  for (let f = 0; f < F; f++) {
    for (const v of polys[f]!) incidentFaces[v]!.push(f);
  }
  const incidentEdges: string[][] = Array.from({ length: V }, () => []);
  for (const k of edgeFaces.keys()) {
    const [a, b] = parseKey(k);
    incidentEdges[a]!.push(k);
    incidentEdges[b]!.push(k);
  }

  // ── Vertex points ────────────────────────────────────────────────────────
  for (let v = 0; v < V; v++) {
    const Px = positions[v * 3]!, Py = positions[v * 3 + 1]!, Pz = positions[v * 3 + 2]!;
    const faces = incidentFaces[v]!;
    const edges = incidentEdges[v]!;
    const n = faces.length;

    // Smooth position (interior Catmull-Clark rule over available faces/edges).
    let smoothX: number, smoothY: number, smoothZ: number;
    if (n === 0) {
      smoothX = Px; smoothY = Py; smoothZ = Pz;
    } else {
      let qx = 0, qy = 0, qz = 0;
      for (const f of faces) {
        qx += facePoint[f * 3]!; qy += facePoint[f * 3 + 1]!; qz += facePoint[f * 3 + 2]!;
      }
      qx /= n; qy /= n; qz /= n;
      let rx = 0, ry = 0, rz = 0;
      for (const k of edges) {
        const [a, b] = parseKey(k);
        rx += (positions[a * 3]! + positions[b * 3]!) / 2;
        ry += (positions[a * 3 + 1]! + positions[b * 3 + 1]!) / 2;
        rz += (positions[a * 3 + 2]! + positions[b * 3 + 2]!) / 2;
      }
      const m = edges.length;
      rx /= m; ry /= m; rz /= m;
      smoothX = (qx + 2 * rx + (n - 3) * Px) / n;
      smoothY = (qy + 2 * ry + (n - 3) * Py) / n;
      smoothZ = (qz + 2 * rz + (n - 3) * Pz) / n;
    }

    // Crease / boundary handling: collect the vertex's sharp edges.
    let creaseCount = 0;
    let sharpnessSum = 0;
    const creaseNbrs: Array<{ nbr: number; s: number }> = [];
    for (const k of edges) {
      const s = sharpnessOf(k, edgeFaces.get(k)!);
      if (s > 0) {
        creaseCount++;
        sharpnessSum += Math.min(s, 1);
        const [a, b] = parseKey(k);
        creaseNbrs.push({ nbr: a === v ? b : a, s });
      }
    }

    if (creaseCount === 0) {
      newPos[v * 3] = smoothX;
      newPos[v * 3 + 1] = smoothY;
      newPos[v * 3 + 2] = smoothZ;
      continue;
    }

    // Crease position by number of incident sharp edges.
    let sharpX: number, sharpY: number, sharpZ: number;
    if (creaseCount <= 1) {
      // Dart — a lone crease doesn't pin the vertex.
      sharpX = smoothX; sharpY = smoothY; sharpZ = smoothZ;
    } else if (creaseCount === 2) {
      // (6P + n1 + n2) / 8 using the two sharpest crease neighbors.
      creaseNbrs.sort((p, q) => q.s - p.s);
      const n1 = creaseNbrs[0]!.nbr, n2 = creaseNbrs[1]!.nbr;
      sharpX = (6 * Px + positions[n1 * 3]! + positions[n2 * 3]!) / 8;
      sharpY = (6 * Py + positions[n1 * 3 + 1]! + positions[n2 * 3 + 1]!) / 8;
      sharpZ = (6 * Pz + positions[n1 * 3 + 2]! + positions[n2 * 3 + 2]!) / 8;
    } else {
      // Corner — pinned.
      sharpX = Px; sharpY = Py; sharpZ = Pz;
    }

    const blend = Math.min(1, sharpnessSum / creaseCount);
    newPos[v * 3] = smoothX + (sharpX - smoothX) * blend;
    newPos[v * 3 + 1] = smoothY + (sharpY - smoothY) * blend;
    newPos[v * 3 + 2] = smoothZ + (sharpZ - smoothZ) * blend;
  }

  // ── New faces: n quads per original face ─────────────────────────────────
  const newPolys: number[][] = [];
  for (let f = 0; f < F; f++) {
    const poly = polys[f]!;
    const Ff = facePointIndex[f]!;
    const nn = poly.length;
    for (let i = 0; i < nn; i++) {
      const vi = poly[i]!;
      const vNext = poly[(i + 1) % nn]!;
      const vPrev = poly[(i - 1 + nn) % nn]!;
      const eNext = edgePointIndex.get(edgeKey(vi, vNext))!;
      const ePrev = edgePointIndex.get(edgeKey(vPrev, vi))!;
      newPolys.push([vi, eNext, Ff, ePrev]);
    }
  }

  // ── Propagate finite creases to child edges (σ − 1). ─────────────────────
  const newCreases = new Map<string, number>();
  for (const [k, s] of creases) {
    if (!Number.isFinite(s) || s <= 0) continue;
    const faces = edgeFaces.get(k);
    if (!faces || faces.length !== 2) continue; // stale key or boundary
    const childS = s - 1;
    if (childS <= 0) continue;
    const [a, b] = parseKey(k);
    const ep = edgePointIndex.get(k)!;
    newCreases.set(edgeKey(a, ep), childS);
    newCreases.set(edgeKey(ep, b), childS);
  }

  return { positions: Float32Array.from(newPos), polys: newPolys, creases: newCreases };
}

/**
 * Apply `level` (≥1) Catmull-Clark subdivision steps. Level 0 returns a copy.
 * `creases` (optional) maps edge keys ("min_max" of vertex ids) to sharpness.
 * `uvs` (optional, per face corner) are subdivided with them as Blender's
 * Subdivision Surface does under its default UV Smooth, "Keep Boundaries" —
 * see `subdivideUVOnce`.
 */
export function catmullClark(
  positions: Float32Array,
  polys: number[][],
  level = 1,
  creases?: Map<string, number>,
  uvs?: number[][][],
): SubdivResult {
  let result: SubdivResult = {
    positions: Float32Array.from(positions),
    polys: polys.map((p) => p.slice()),
    creases: new Map(creases ?? []),
    ...(uvs ? { uvs: uvs.map((f) => f.map((c) => [...c])) } : {}),
  };
  for (let l = 0; l < level; l++) {
    const nextUV = result.uvs ? subdivideUVOnce(result.polys, result.uvs) : undefined;
    result = subdivideOnce(result.positions, result.polys, result.creases);
    if (nextUV) result.uvs = nextUV;
  }
  return result;
}

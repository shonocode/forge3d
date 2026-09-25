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
function subdivideUVOnce(
  polys: number[][],
  uvs: number[][][],
  mode: UVSmooth = "PRESERVE_BOUNDARIES",
  preserveCorners = false,
): number[][][] {
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
  const around: Array<Array<[number, number]>> = values.map(() => []);
  polys.forEach((p, f) => p.forEach((_, i) => around[cid[f]![i]!]!.push([f, i])));
  const linear = mode === "NONE";
  // The corners (face, corner) whose outgoing / incoming edge is a UV
  // boundary, per value — the span's two ends.
  const outBound: Array<Array<[number, number]>> = values.map(() => []);
  const inBound: Array<Array<[number, number]>> = values.map(() => []);
  const prevOf = (f: number, i: number): number => (i + polys[f]!.length - 1) % polys[f]!.length;
  polys.forEach((p, f) =>
    p.forEach((_, i) => {
      if (!continuous(f, i)) {
        outBound[cid[f]![i]!]!.push([f, i]);
        inBound[cid[f]![next(f, i)]!]!.push([f, next(f, i)]);
      }
    }),
  );
  // How a value moves (OpenSubdiv `FVarLevel::completeTopologyFromFaceValues`):
  // "smooth" by the interior rule, "crease" along its two boundary edges,
  // "sharp" where it is.
  const meshEdgeUse = new Map<string, number>();
  polys.forEach((p) => p.forEach((v, i) => {
    const k = edgeKey(v, p[(i + 1) % p.length]!);
    meshEdgeUse.set(k, (meshEdgeUse.get(k) ?? 0) + 1);
  }));
  const vertexFaces = new Map<number, number>();
  polys.forEach((p) => p.forEach((v) => vertexFaces.set(v, (vertexFaces.get(v) ?? 0) + 1)));
  const vertexOf = values.map(() => -1);
  polys.forEach((p, f) => p.forEach((v, i) => (vertexOf[cid[f]![i]!] = v)));
  // The vertices on the mesh's own boundary, from the edge counts once
  // (found by review: a scan of every face per vertex was O(V·F)).
  const meshBoundaryVertex = new Set<number>();
  for (const [k, n] of meshEdgeUse)
    if (n === 1) for (const v of parseKey(k)) meshBoundaryVertex.add(v);
  const isMeshBoundary = (v: number): boolean => meshBoundaryVertex.has(v);
  const linearBoundaries = mode === "PRESERVE_BOUNDARIES";
  const dependent = mode === "PRESERVE_CORNERS_AND_JUNCTIONS" || mode === "PRESERVE_CORNERS_JUNCTIONS_AND_CONCAVE";
  const sharpenBothIfOneCorner = mode === "PRESERVE_CORNERS_JUNCTIONS_AND_CONCAVE";
  const sharpenDarts = sharpenBothIfOneCorner || linearBoundaries;
  const fvarCornersAreSharp = mode !== "SMOOTH_ALL";
  const kind = values.map((_, id): "smooth" | "crease" | "sharp" => {
    if (linear) return "sharp";
    const v = vertexOf[id]!;
    const nValues = valueAt.get(v)!.length;
    const meshBoundary = isMeshBoundary(v);
    const bounded = outBound[id]!.length + inBound[id]!.length > 0;
    const span = around[id]!.length;
    // Not a mismatch: the value follows the vertex's own rules — interior
    // smooth, a boundary a crease, a one-face corner sharp unless both the
    // geometry and the UVs smooth it.
    const mismatch = nValues > 1 || bounded;
    if (!mismatch || (!bounded && !meshBoundary)) {
      if (!meshBoundary) return "smooth";
      if (vertexFaces.get(v) === 1 && (preserveCorners || fvarCornersAreSharp)) return "sharp";
      return "crease";
    }
    if (linearBoundaries) return "sharp";
    let allSharp = (dependent && nValues > 2) || (sharpenDarts && nValues === 1 && !meshBoundary);
    if (!allSharp && sharpenBothIfOneCorner && nValues === 2)
      allSharp = valueAt.get(v)!.some((other) => around[other]!.length === 1);
    if (allSharp || (span === 1 && fvarCornersAreSharp)) return "sharp";
    // Under PRESERVE_CORNERS the geometric corner is itself infinitely sharp
    // (OpenSubdiv's `vTag._infSharp`), which makes every value there sharp —
    // `allCornersAreSharp` in `FVarLevel::completeTopologyFromFaceValues`.
    if (vertexFaces.get(v) === 1 && preserveCorners) return "sharp";
    // A dart — one value round an interior vertex, a seam ending here — is a
    // crease too, between the seam's far values on its two sides (measured on
    // `cubeUV`; OpenSubdiv tags it by its discontinuous edge).
    return "crease";
  });
  const boundaryValue = new Uint8Array(values.length);
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
    const o = linear ? null : continuous(f, i);
    if (!o) return [(a[0]! + b[0]!) / 2, (a[1]! + b[1]!) / 2];
    const fa = facePoint[f]!, fb = facePoint[o[0]]!;
    return [(a[0]! + b[0]! + fa[0]! + fb[0]!) / 4, (a[1]! + b[1]! + fa[1]! + fb[1]!) / 4];
  };
  // ── value points ─────────────────────────────────────────────────────────
  const valuePoint = values.map((s, id) => {
    void boundaryValue;
    const k = kind[id]!;
    if (k === "sharp") return [s[0]!, s[1]!];
    if (k === "crease") {
      // (prev + 6 S + next) / 8 along the span's two boundary edges.
      const [fo, io] = outBound[id]![0]!;
      const [fi, ii] = inBound[id]![0]!;
      const a = values[cid[fo]![next(fo, io)]!]!;
      const b = values[cid[fi]![prevOf(fi, ii)]!]!;
      return [(a[0]! + 6 * s[0]! + b[0]!) / 8, (a[1]! + 6 * s[1]! + b[1]!) / 8];
    }
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
  preserveCorners = false,
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

    // `boundary_smooth = PRESERVE_CORNERS` (OpenSubdiv's
    // VTX_BOUNDARY_EDGE_AND_CORNER): a vertex with one face is a corner and
    // does not move.
    if (preserveCorners && n === 1) {
      newPos[v * 3] = Px;
      newPos[v * 3 + 1] = Py;
      newPos[v * 3 + 2] = Pz;
      continue;
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

/** Blender's Subdivision Surface settings beyond the level (compat-backlog B1). */
export interface CatmullClarkOptions {
  /**
   * `use_limit_surface` — on by default in Blender's modifier, off here so
   * the function stays plain recursive refinement. With it on, every vertex
   * is put on the limit surface as Blender's OpenSubdiv evaluator puts it:
   * the Catmull-Clark limit mask, (n²V + 4ΣE + ΣF) / (n(n + 5)) inside and
   * (P + 4V + Q) / 6 on a boundary (measured exact, `probe-subsurf-limit.py`).
   *
   * One exception, read from OpenSubdiv's Gregory end caps: under
   * `boundarySmooth: "ALL"` a boundary vertex with one face is a smooth
   * corner, and Blender puts it where `quality` rounds of refinement put it
   * — not on the limit, which it only approaches as `quality` grows.
   *
   * Refused rather than approximated: `level > quality` (those vertices
   * fall inside Gregory patches, whose surface is not the limit near an
   * extraordinary vertex), creases (not measured), and UVs (the face-varying
   * limit is not ported).
   */
  limitSurface?: boolean;
  /** `quality` — the adaptive refinement level of Blender's evaluator, default 3. */
  quality?: number;
  /**
   * `boundary_smooth`: `"ALL"` (default) smooths every boundary vertex;
   * `"PRESERVE_CORNERS"` keeps a vertex with one face where it is.
   */
  boundarySmooth?: "ALL" | "PRESERVE_CORNERS";
  /**
   * `uv_smooth` — how the UVs are subdivided (OpenSubdiv's face-varying
   * linear interpolation): `"PRESERVE_BOUNDARIES"` (default; linear along
   * seams and the boundary), `"NONE"` (linear everywhere), `"SMOOTH_ALL"`,
   * and the three `"PRESERVE_CORNERS…"`, which smooth along seams but pin the
   * corners, the junctions of three or more islands, and the concave corners.
   */
  uvSmooth?: UVSmooth;
}

/** Blender's `uv_smooth` values. */
export type UVSmooth =
  | "NONE"
  | "PRESERVE_CORNERS"
  | "PRESERVE_CORNERS_AND_JUNCTIONS"
  | "PRESERVE_CORNERS_JUNCTIONS_AND_CONCAVE"
  | "PRESERVE_BOUNDARIES"
  | "SMOOTH_ALL";

/**
 * Apply `level` (≥1) Catmull-Clark subdivision steps. Level 0 returns a copy.
 * `creases` (optional) maps edge keys ("min_max" of vertex ids) to sharpness.
 * `uvs` (optional, per face corner) are subdivided with them as Blender's
 * Subdivision Surface does under its default UV Smooth, "Keep Boundaries" —
 * see `subdivideUVOnce`. `options` are the modifier's other settings — see
 * {@link CatmullClarkOptions}.
 */
export function catmullClark(
  positions: Float32Array,
  polys: number[][],
  level = 1,
  creases?: Map<string, number>,
  uvs?: number[][][],
  options: CatmullClarkOptions = {},
): SubdivResult {
  const preserveCorners = options.boundarySmooth === "PRESERVE_CORNERS";
  const quality = options.quality ?? 3;
  if (options.limitSurface && level > 0) {
    if (level > quality)
      throw new Error(
        `catmullClark: limitSurface at level ${level} > quality ${quality} is not ported — ` +
          `Blender evaluates those vertices inside Gregory patches.`,
      );
    if (creases && [...creases.values()].some((s) => s > 0))
      throw new Error("catmullClark: limitSurface with creases is not measured, so it is refused.");
    if (uvs) throw new Error("catmullClark: limitSurface with UVs (the face-varying limit) is not ported.");
  }
  let result: SubdivResult = {
    positions: Float32Array.from(positions),
    polys: polys.map((p) => p.slice()),
    creases: new Map(creases ?? []),
    ...(uvs ? { uvs: uvs.map((f) => f.map((c) => [...c])) } : {}),
  };
  for (let l = 0; l < level; l++) {
    const nextUV = result.uvs
      ? subdivideUVOnce(result.polys, result.uvs, options.uvSmooth ?? "PRESERVE_BOUNDARIES", preserveCorners)
      : undefined;
    result = subdivideOnce(result.positions, result.polys, result.creases, preserveCorners);
    if (nextUV) result.uvs = nextUV;
  }
  if (options.limitSurface && level > 0)
    result.positions = limitPositions(positions, polys, result.positions, result.polys, preserveCorners, quality);
  return result;
}

/**
 * The refined vertices pushed onto the limit surface — see
 * {@link CatmullClarkOptions.limitSurface}. `coarse` / `coarsePolys` are the
 * input, for the smooth corners (which keep their input indices).
 */
function limitPositions(
  coarse: Float32Array,
  coarsePolys: number[][],
  P: Float32Array,
  polys: number[][],
  preserveCorners: boolean,
  quality: number,
): Float32Array {
  const V = P.length / 3;
  const faceCount = new Int32Array(V);
  const edgeUse = new Map<string, number>();
  const nbrs: Set<number>[] = Array.from({ length: V }, () => new Set());
  const diag: number[][] = Array.from({ length: V }, () => []);
  for (const p of polys)
    p.forEach((v, i) => {
      faceCount[v]!++;
      const next = p[(i + 1) % p.length]!;
      const k = edgeKey(v, next);
      edgeUse.set(k, (edgeUse.get(k) ?? 0) + 1);
      nbrs[v]!.add(next);
      nbrs[v]!.add(p[(i + p.length - 1) % p.length]!);
      diag[v]!.push(p[(i + 2) % p.length]!);
    });
  const out = Float32Array.from(P);
  const at = (v: number, k: number): number => P[v * 3 + k]!;
  for (let v = 0; v < V; v++) {
    if (faceCount[v] === 0) continue;
    const boundary = [...nbrs[v]!].filter((w) => edgeUse.get(edgeKey(v, w)) === 1);
    if (boundary.length === 0) {
      const n = nbrs[v]!.size;
      for (let k = 0; k < 3; k++) {
        let e = 0;
        for (const w of nbrs[v]!) e += at(w, k);
        let f = 0;
        for (const w of diag[v]!) f += at(w, k);
        out[v * 3 + k] = (n * n * at(v, k) + 4 * e + f) / (n * (n + 5));
      }
    } else if (boundary.length === 2 && faceCount[v] === 1) {
      if (preserveCorners) continue;
      // A smooth corner: where `quality` rounds of the boundary rule put the
      // input's corner (its boundary neighbours become edge midpoints).
      const corner = coarseCorner(coarse, coarsePolys, v);
      if (!corner) continue;
      for (let k = 0; k < 3; k++) {
        let x = corner.v[k]!;
        let a = corner.a[k]!;
        let b = corner.b[k]!;
        for (let q = 0; q < quality; q++) {
          const nx = (a + 6 * x + b) / 8;
          a = (a + x) / 2;
          b = (b + x) / 2;
          x = nx;
        }
        out[v * 3 + k] = x;
      }
    } else if (boundary.length === 2) {
      const [a, b] = boundary as [number, number];
      for (let k = 0; k < 3; k++) out[v * 3 + k] = (at(a, k) + 4 * at(v, k) + at(b, k)) / 6;
    } else {
      // One boundary edge, or three and more: a non-manifold vertex, whose
      // limit OpenSubdiv takes from its own sharpening rules — not measured,
      // so refused rather than left on the refined surface (found by review).
      throw new Error(
        `catmullClark: limitSurface at a non-manifold vertex (${boundary.length} boundary edges) is not measured.`,
      );
    }
  }
  return out;
}

/** The input corner at vertex `v` (a vertex with one face) and its two neighbours in that face. */
function coarseCorner(
  coarse: Float32Array,
  coarsePolys: number[][],
  v: number,
): { v: number[]; a: number[]; b: number[] } | null {
  const pos = (i: number): number[] => [coarse[i * 3]!, coarse[i * 3 + 1]!, coarse[i * 3 + 2]!];
  for (const p of coarsePolys) {
    const i = p.indexOf(v);
    if (i < 0) continue;
    return { v: pos(v), a: pos(p[(i + p.length - 1) % p.length]!), b: pos(p[(i + 1) % p.length]!) };
  }
  return null;
}

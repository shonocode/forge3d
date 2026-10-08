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
import { evaluatePatches, type FVarTag, type PatchParam } from "./subdiv-patches";

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
  /** One step's edge points: the vertex made at each parent edge ("min_max"), for carrying edge and vertex layers. */
  edgePoints?: Map<string, number>;
  /** Propagated vertex sharpness (OpenSubdiv's, σ − 1 a level), by vertex — only where it is still above 0. */
  vertexSharpness?: Map<number, number>;
}

/**
 * Two corners at one vertex hold the same UV value when they are this close —
 * Blender's `STD_UV_CONNECT_LIMIT`, which its subdivision converter uses to
 * decide which corners share a face-varying value.
 */
const UV_CONNECT_LIMIT = 0.0001;

/**
 * The face-varying values of a UV layer: corners at one vertex share a value
 * when their UVs are within `UV_CONNECT_LIMIT` and their faces are wound the
 * same way in UV (Blender's converter calls `BKE_mesh_uv_vert_map_create`
 * with `use_winding`, the sign of `cross_poly_v2`). `cid[f][i]` is corner `i`
 * of face `f`'s value, `valueAt` a vertex's values, `vertexOf` a value's vertex.
 */
function faceVaryingValues(
  polys: number[][],
  uvs: number[][][],
  given?: number[][],
): { values: number[][]; valueAt: Map<number, number[]>; cid: number[][]; vertexOf: number[] } {
  const values: number[][] = [];
  const valueAt = new Map<number, number[]>();
  const vertexOf: number[] = [];
  if (given) {
    // Below the cage the values come down from the level above (`childValueIds`), as OpenSubdiv's do.
    given.forEach((row, f) =>
      row.forEach((id, i) => {
        if (values[id]) return;
        values[id] = [uvs[f]![i]![0]!, uvs[f]![i]![1]!];
        vertexOf[id] = polys[f]![i]!;
        (valueAt.get(polys[f]![i]!) ?? valueAt.set(polys[f]![i]!, []).get(polys[f]![i]!)!).push(id);
      }),
    );
    return { values, valueAt, cid: given, vertexOf };
  }
  const windingOf: boolean[] = [];
  // `cross_poly_v2` (BLI_math_geom): Σ (cur.x − prev.x)(cur.y + prev.y).
  const winding = uvs.map((c) => {
    let cross = 0;
    for (let i = 0; i < c.length; i++) {
      const prev = c[(i + c.length - 1) % c.length]!;
      cross += (c[i]![0]! - prev[0]!) * (c[i]![1]! + prev[1]!);
    }
    return cross < 0;
  });
  const cid: number[][] = polys.map((p, f) =>
    p.map((v, i) => {
      const uv = uvs[f]![i]!;
      const ids = valueAt.get(v) ?? [];
      for (const id of ids) {
        const w = values[id]!;
        if (
          Math.abs(w[0]! - uv[0]!) < UV_CONNECT_LIMIT &&
          Math.abs(w[1]! - uv[1]!) < UV_CONNECT_LIMIT &&
          windingOf[id] === winding[f]
        )
          return id;
      }
      values.push([uv[0]!, uv[1]!]);
      windingOf.push(winding[f]!);
      vertexOf.push(v);
      ids.push(values.length - 1);
      valueAt.set(v, ids);
      return values.length - 1;
    }),
  );
  return { values, valueAt, cid, vertexOf };
}

/**
 * The child corners' values after one step, in `subdivideOnce`'s corner order: a vertex keeps its values, a face
 * makes one, an edge one if it is continuous in UV and one per side if it is a seam. Blender groups the corners into
 * values once, on the cage (by distance and winding); OpenSubdiv refines that topology — grouping the refined UVs
 * again would join a seam's two sides wherever they meet (mirrored islands) or split them where a face degenerates.
 */
function childValueIds(
  polys: number[][],
  cid: number[][],
  nValues: number,
  continuous: (f: number, i: number) => boolean,
): number[][] {
  let next = nValues;
  const faceId = polys.map(() => next++);
  const edgeIds = new Map<string, number>();
  const eid = (f: number, i: number): number => {
    const p = polys[f]!;
    const key = continuous(f, i) ? `e${edgeKey(p[i]!, p[(i + 1) % p.length]!)}` : `s${f},${i}`;
    let id = edgeIds.get(key);
    if (id === undefined) edgeIds.set(key, (id = next++));
    return id;
  };
  const out: number[][] = [];
  polys.forEach((p, f) => {
    for (let i = 0; i < p.length; i++) out.push([cid[f]![i]!, eid(f, i), faceId[f]!, eid(f, (i + p.length - 1) % p.length)]);
  });
  return out;
}

/** The faces of `value` round its vertex, walked across the edges the value shares (any polygon size). */
function valueFan(
  vpolys: number[][],
  half: Map<string, number>,
  f: number,
  value: number,
): { faces: number[]; open: boolean } {
  const at = (g: number, d: number): number => {
    const p = vpolys[g]!;
    return p[(p.indexOf(value) + d + p.length) % p.length]!;
  };
  let first = f;
  let open = false;
  for (let guard = 0; ; guard++) {
    const g = half.get(`${at(first, 1)},${value}`);
    if (g === undefined) {
      open = true;
      break;
    }
    if (g === f) break;
    first = g;
    if (guard > vpolys.length) throw new Error("catmullClark: a face-varying ring does not close.");
  }
  if (!open) first = f;
  const faces: number[] = [];
  for (let g: number | undefined = first; g !== undefined; ) {
    faces.push(g);
    g = half.get(`${value},${at(g, -1)}`);
    if (g === first) break;
    if (faces.length > vpolys.length) throw new Error("catmullClark: a face-varying ring does not close.");
  }
  return { faces, open };
}

/** Directed value edge a→b → its face, for `valueFan`. */
function valueHalfEdges(vpolys: number[][]): Map<string, number> {
  const half = new Map<string, number>();
  vpolys.forEach((p, f) => p.forEach((a, i) => half.set(`${a},${p[(i + 1) % p.length]}`, f)));
  return half;
}

/**
 * Whether a value's corners fall into more than one fan round its vertex (`gatherValueSpans`' disjoint span: a seam
 * ending on the boundary, one pinched shut inside, a UV bowtie).
 */
function hasDisjointValue(cid: number[][]): boolean {
  // Fans are only walked where every directed value edge has one face; elsewhere (a non-manifold edge) the plain path stays.
  let directed = 0;
  for (const row of cid) directed += row.length;
  const half = valueHalfEdges(cid);
  if (half.size !== directed) return false;
  const count = new Map<number, number>();
  for (const row of cid) for (const id of row) count.set(id, (count.get(id) ?? 0) + 1);
  const seen = new Set<number>();
  for (let f = 0; f < cid.length; f++)
    for (const id of cid[f]!) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (valueFan(cid, half, f, id).faces.length !== count.get(id)) return true;
    }
  return false;
}

/** A base value's tags from `FVarLevel::completeTopologyFromFaceValues` (`kind` "dep" is semi-sharp by dependence). */
interface BaseValueTag {
  kind: "sharp" | "crease" | "semi" | "dep";
  infSharpEdges: boolean;
  infIrregular: boolean;
  xordinary: boolean;
  /** A disjoint value (`_nonManifold`): a corner, whose patches take a sharp span on each side. */
  nonManifold?: boolean;
}

/**
 * The tags OpenSubdiv gives the face-varying values of the cage that do not
 * follow their vertex (`FVarLevel::completeTopologyFromFaceValues` and
 * `gatherValueSpans`), by value id. `sharpness` is the edge sharpness and
 * `vertexSharpness` the vertex sharpness OpenSubdiv was handed.
 */
function baseFaceVaryingTags(
  polys: number[][],
  fv: { valueAt: Map<number, number[]>; cid: number[][] },
  sharpness: Map<string, number>,
  vertexSharpness: Map<number, number> | undefined,
  mode: UVSmooth,
  preserveCorners: boolean,
): Map<number, BaseValueTag> {
  const linearBoundaries = mode === "PRESERVE_BOUNDARIES";
  const dependent = mode === "PRESERVE_CORNERS_AND_JUNCTIONS" || mode === "PRESERVE_CORNERS_JUNCTIONS_AND_CONCAVE";
  const sharpenBothIfOneCorner = mode === "PRESERVE_CORNERS_JUNCTIONS_AND_CONCAVE";
  const sharpenDarts = sharpenBothIfOneCorner || linearBoundaries;
  const fvarCornersAreSharp = mode !== "SMOOTH_ALL";
  const makeSmoothCornersSharp = !preserveCorners && fvarCornersAreSharp;
  const edgeUse = new Map<string, number>();
  const vertexFaces = new Map<number, number[]>();
  const vertexEdges = new Map<number, Set<string>>();
  polys.forEach((p, f) =>
    p.forEach((v, i) => {
      const k = edgeKey(v, p[(i + 1) % p.length]!);
      edgeUse.set(k, (edgeUse.get(k) ?? 0) + 1);
      (vertexFaces.get(v) ?? vertexFaces.set(v, []).get(v)!).push(f);
      for (const w of [v, p[(i + 1) % p.length]!]) (vertexEdges.get(w) ?? vertexEdges.set(w, new Set()).get(w)!).add(k);
    }),
  );
  const half = valueHalfEdges(fv.cid);
  const out = new Map<number, BaseValueTag>();
  for (const [v, ids] of fv.valueAt) {
    if ([...vertexEdges.get(v)!].some((k) => edgeUse.get(k)! > 2))
      throw new Error("catmullClark: limitSurface with UVs at a non-manifold vertex is not measured.");
    const vBoundary = [...vertexEdges.get(v)!].some((k) => edgeUse.get(k) === 1);
    const faces = vertexFaces.get(v)!;
    const topologicalCorner = faces.length === 1 && vertexEdges.get(v)!.size === 2;
    // Each value's span: its faces, whether it is cut at a seam, and the sharp edges inside it.
    const spans = ids.map((id) => {
      const f = faces.find((g) => fv.cid[g]!.includes(id) && polys[g]![fv.cid[g]!.indexOf(id)] === v)!;
      const fan = valueFan(fv.cid, half, f, id);
      const all = faces.filter((g) => fv.cid[g]![polys[g]!.indexOf(v)] === id).length;
      // `gatherValueSpans` counts a seam inside the value's faces (`_disctsEdgeCount`): they are disjoint.
      const disjoint = fan.faces.length !== all;
      let inf = 0;
      let semi = 0;
      const inner = fan.open ? fan.faces.length - 1 : fan.faces.length;
      for (let j = 0; j < inner; j++) {
        const g = fan.faces[j]!;
        const p = polys[g]!;
        const s = sharpness.get(edgeKey(v, p[(p.indexOf(v) + p.length - 1) % p.length]!)) ?? 0;
        if (s === Infinity) inf++;
        else if (s > 0) semi++;
      }
      // An end of the fan on an interior edge is a seam.
      let seam = false;
      if (fan.open) {
        const a = polys[fan.faces[0]!]!;
        const b = polys[fan.faces[fan.faces.length - 1]!]!;
        const k0 = edgeKey(v, a[(a.indexOf(v) + 1) % a.length]!);
        const k1 = edgeKey(v, b[(b.indexOf(v) + b.length - 1) % b.length]!);
        seam = edgeUse.get(k0) === 2 || edgeUse.get(k1) === 2;
      }
      return { id, size: fan.faces.length, inf, semi, seam, disjoint };
    });
    const mismatch =
      ids.length > 1 || spans.some((sp) => sp.seam) || (linearBoundaries && vBoundary) || (makeSmoothCornersSharp && topologicalCorner);
    if (!mismatch) continue;
    const vS = vertexSharpness?.get(v) ?? 0;
    const vInfSharp = vS === Infinity || (preserveCorners && topologicalCorner);
    const vSemiSharp = vS > 0 && vS !== Infinity;
    let allSharp = linearBoundaries || vInfSharp || (dependent && ids.length > 2) || (sharpenDarts && ids.length === 1 && !vBoundary);
    let hasDependent = false;
    if (!allSharp && dependent && ids.length === 2) {
      allSharp = spans[0]!.inf > 0 || spans[1]!.inf > 0 || spans[0]!.disjoint || spans[1]!.disjoint;
      if (sharpenBothIfOneCorner) allSharp ||= spans[0]!.size === 1 || spans[1]!.size === 1;
      hasDependent = spans[0]!.semi > 0 !== spans[1]!.semi > 0;
    }
    for (const sp of spans) {
      if (sp.disjoint) {
        // `_nonManifold`: the tags cleared, so a corner.
        out.set(sp.id, { kind: "sharp", infSharpEdges: false, infIrregular: false, xordinary: false, nonManifold: true });
        continue;
      }
      const isInfSharp = allSharp || sp.inf > 0 || (sp.size === 1 && fvarCornersAreSharp);
      const xordinary = sp.size === 1 ? !isInfSharp : sp.size !== 2;
      out.set(sp.id, {
        kind: isInfSharp ? "sharp" : sp.semi > 0 || vSemiSharp ? "semi" : hasDependent ? "dep" : "crease",
        infSharpEdges: sp.inf > 0,
        infIrregular: sp.inf > 0 ? sp.size - sp.inf > 1 : isInfSharp ? sp.size > 1 : xordinary,
        xordinary,
      });
    }
  }
  return out;
}

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
  sharpness?: Map<string, number>,
  vertexSharpness?: Map<number, number>,
  carry?: { state?: Map<string, FVarState>; cid?: number[][] },
): number[][][] {
  if (
    mode !== "NONE" &&
    ([...(sharpness?.values() ?? [])].some((x) => x > 0) ||
      vertexSharpness?.size ||
      hasDisjointValue(faceVaryingValues(polys, uvs, carry?.cid).cid))
  )
    return subdivideUVOnceCreased(polys, uvs, mode, preserveCorners, sharpness!, vertexSharpness, carry);
  if (carry) carry.state = undefined;
  const F = polys.length;
  const { values, valueAt, cid } = faceVaryingValues(polys, uvs, carry?.cid);
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
  if (carry) carry.cid = childValueIds(polys, cid, values.length, (f, i) => continuous(f, i) !== null);
  return out;
}

const SHARP = Infinity;

/** Blender's `crease_edge` (0..1) as OpenSubdiv's sharpness: `10 · crease²`, and 10 and up is infinite (`Crease::IsInfinite`). */
const osdSharpness = (c: number): number => {
  const s = Math.fround(Math.fround(Math.fround(c) * Math.fround(c)) * 10);
  return s >= 10 ? Infinity : s;
};

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

function parseKey(k: string): [number, number] {
  const us = k.indexOf("_");
  return [Number(k.slice(0, us)), Number(k.slice(us + 1))];
}

/**
 * One Catmull-Clark step. `creases` maps edge keys to sharpness (σ ≥ 0);
 * `vertexSharpness` (optional) is OpenSubdiv's vertex sharpness, which makes
 * a vertex a corner while it lasts.
 */
export function subdivideOnce(
  positions: Float32Array,
  polys: number[][],
  creases: Map<string, number>,
  preserveCorners = false,
  vertexSharpness?: Map<number, number>,
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
  const newVertexSharpness = new Map<number, number>();
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
    // OpenSubdiv's vertex rule (`Scheme::ComputeVertexVertexMask`): the rule is Smooth / Dart / Crease / Corner by the number of
    // sharp edges (0 / 1 / 2 / more) — Corner whenever the vertex itself is sharp — for the parent's sharpness and for the child's
    // (σ − 1, ≤ 0 ⇒ 0, ∞ stays). When the two differ the position is the mix of the parent's rule and the child's, weighted by
    // the mean parent sharpness of the edges (and the vertex) that decay to 0 (`ComputeFractionalWeightAtVertex`, clamped to 1).
    const decay = (s: number): number => (s === Infinity ? s : s > 1 ? s - 1 : 0);
    const vertexS = vertexSharpness?.get(v) ?? 0;
    const childVertexS = decay(vertexS);
    if (childVertexS > 0) newVertexSharpness.set(v, childVertexS);
    let creaseCount = 0;
    let childCount = 0;
    let transitionSum = vertexS > 0 && childVertexS <= 0 ? vertexS : 0;
    let transitionCount = vertexS > 0 && childVertexS <= 0 ? 1 : 0;
    const creaseNbrs: number[] = [];
    const childCreaseNbrs: number[] = [];
    for (const k of edges) {
      const s = sharpnessOf(k, edgeFaces.get(k)!);
      if (s <= 0) continue;
      const [a, b] = parseKey(k);
      const nbr = a === v ? b : a;
      creaseCount++;
      creaseNbrs.push(nbr);
      if (decay(s) > 0) {
        childCount++;
        childCreaseNbrs.push(nbr);
      } else {
        transitionSum += s;
        transitionCount++;
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

    if (creaseCount === 0 && vertexS <= 0) {
      newPos[v * 3] = smoothX;
      newPos[v * 3 + 1] = smoothY;
      newPos[v * 3 + 2] = smoothZ;
      continue;
    }

    // The position a rule gives: Smooth / Dart → the smooth mask; Crease → (6P + n1 + n2) / 8; Corner → P.
    const ruleAt = (rule: number, nbrs: number[], k: number): number => {
      if (rule <= 1) return k === 0 ? smoothX : k === 1 ? smoothY : smoothZ;
      const p = k === 0 ? Px : k === 1 ? Py : Pz;
      if (rule === 2) return (6 * p + positions[nbrs[0]! * 3 + k]! + positions[nbrs[1]! * 3 + k]!) / 8;
      return p;
    };
    const ruleOf = (vs: number, count: number): number => (vs > 0 || count > 2 ? 3 : count);
    const parentRule = ruleOf(vertexS, creaseCount);
    const childRule = ruleOf(childVertexS, childCount);
    const same = parentRule === childRule;
    const weight = same || transitionCount === 0 ? 0 : Math.min(1, transitionSum / transitionCount);
    for (let k = 0; k < 3; k++) {
      const parent = ruleAt(parentRule, creaseNbrs, k);
      const child = same ? parent : ruleAt(childRule, childCreaseNbrs, k);
      newPos[v * 3 + k] = weight * parent + (1 - weight) * child;
    }
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
    if (!(s > 0)) continue;
    const faces = edgeFaces.get(k);
    if (!faces || faces.length !== 2) continue; // stale key or boundary
    const childS = s === Infinity ? s : s - 1;
    if (childS <= 0) continue;
    const [a, b] = parseKey(k);
    const ep = edgePointIndex.get(k)!;
    newCreases.set(edgeKey(a, ep), childS);
    newCreases.set(edgeKey(ep, b), childS);
  }

  return {
    positions: Float32Array.from(newPos),
    polys: newPolys,
    creases: newCreases,
    edgePoints: edgePointIndex,
    ...(newVertexSharpness.size ? { vertexSharpness: newVertexSharpness } : {}),
  };
}

/**
 * The vertex sharpness Blender hands OpenSubdiv for a cage
 * (`topology_refiner_factory.cc`, `assignComponentTags`): the vertex crease as a sharpness (`10 · crease²`), and a vertex
 * with exactly two edges adds the smaller of their two sharpnesses, capped at 10 (infinite) — a boundary edge's crease
 * counts here, though OpenSubdiv makes the edge itself infinitely sharp.
 */
function blenderVertexSharpness(
  polys: number[][],
  sharpness: Map<string, number>,
  vertexCreases?: Map<number, number>,
): Map<number, number> {
  const edgesOf = new Map<number, Set<string>>();
  for (const p of polys)
    p.forEach((a, i) => {
      const k = edgeKey(a, p[(i + 1) % p.length]!);
      for (const v of [a, p[(i + 1) % p.length]!]) {
        let set = edgesOf.get(v);
        if (!set) edgesOf.set(v, (set = new Set()));
        set.add(k);
      }
    });
  const out = new Map<number, number>();
  for (const [v, edges] of edgesOf) {
    const c = vertexCreases?.get(v) ?? 0;
    let s = c > 0 ? Math.min(osdSharpness(c), 10) : 0;
    if (edges.size === 2) {
      const [e0, e1] = [...edges].map((k) => Math.min(sharpness.get(k) ?? 0, 10)) as [number, number];
      s = Math.min(Math.fround(s + Math.min(e0, e1)), 10);
    }
    if (s > 0) out.set(v, s >= 10 ? Infinity : s);
  }
  return out;
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
   * One exception, read from OpenSubdiv's patch builder: under
   * `boundarySmooth: "ALL"` a boundary vertex with one face is a smooth
   * corner, which OpenSubdiv sharpens, and Blender puts it where `quality`
   * rounds of refinement put it — not on the limit, which it only
   * approaches as `quality` grows.
   *
   * Above `quality` the vertices fall inside the patches of the
   * level-`quality` mesh — B-splines on its regular faces, Gregory patches on
   * the faces at an extraordinary vertex, which are not the limit there —
   * and are evaluated on them as Blender does (`subdiv-patches.ts`, C28).
   * With creases every level is evaluated so: the patches know only the
   * infinitely sharp edges, so a finite sharpness still left at `quality`
   * is smoothed over.
   *
   * UVs go on OpenSubdiv's face-varying patches, built on the UV topology
   * (`faceVaryingLimit`); refused rather than approximated: a UV value whose
   * faces are disjoint (a seam ending on the boundary, a T-shaped slit, a UV
   * bowtie — OpenSubdiv sharpens those as non-manifold).
   */
  limitSurface?: boolean;
  /** `quality` — the adaptive refinement level of Blender's evaluator, default 3. */
  quality?: number;
  /**
   * `creases` are Blender's `crease_edge` (0..1), as every operator here that writes a crease writes it: the Subdivision Surface
   * modifier hands OpenSubdiv a sharpness of `10 · crease²` (`crease_to_sharpness`). Off (default), `creases` is read as the
   * sharpness itself — what the editor's Subdivide keeps and propagates level by level.
   */
  blenderCreases?: boolean;
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
  /**
   * Vertices OpenSubdiv is told are infinitely sharp (`isInfiniteSharpVertex`) — corners, whatever their edges. Blender's
   * modifier names the vertices of its wire edges (`subdiv_converter_mesh.cc`); {@link subsurfModifier} passes them.
   */
  infiniteSharpVertices?: Iterable<number>;
  /** Blender's vertex creases (`crease_vert`, 0..1), read with `blenderCreases` as OpenSubdiv's vertex sharpness. */
  vertexCreases?: Map<number, number>;
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
    if (quality < 1) throw new Error(`catmullClark: quality ${quality} — Blender's is 1 to 10.`);
  }
  let result: SubdivResult = {
    positions: Float32Array.from(positions),
    polys: polys.map((p) => p.slice()),
    creases: new Map(
      [...(creases ?? [])].map(([k, c]): [string, number] => [k, options.blenderCreases ? osdSharpness(c) : c]),
    ),
    ...(uvs ? { uvs: uvs.map((f) => f.map((c) => [...c])) } : {}),
  };
  if (options.blenderCreases || options.infiniteSharpVertices) {
    const vs = options.blenderCreases
      ? blenderVertexSharpness(result.polys, result.creases, options.vertexCreases)
      : new Map<number, number>();
    // `assignComponentTags`: an infinitely sharp vertex skips the two-edge rule.
    for (const v of options.infiniteSharpVertices ?? []) vs.set(v, Infinity);
    if (vs.size) result.vertexSharpness = vs;
  }
  // Above `quality`, or wherever a crease is, the vertices are evaluated on the patches of the `quality` mesh
  // (`subdiv-patches.ts`): each face remembers the face of that mesh it lies in and its corners' (u, v) there.
  const creased = [...result.creases.values()].some((s) => s > 0) || !!result.vertexSharpness;
  const uvOnPatches = !!options.limitSurface && level > 0 && !!uvs;
  const onPatches = !!options.limitSurface && level > 0 && (level > quality || creased || uvOnPatches);
  const uvMode = options.uvSmooth ?? "PRESERVE_BOUNDARIES";
  const uvCarry: { state?: Map<string, FVarState>; cid?: number[][] } = {};
  let isolatedCid: number[][] | undefined;
  // The cage's face-varying values and their tags, and each face's face of the cage (for the tags of the values there).
  const cage = uvOnPatches ? faceVaryingValues(result.polys, result.uvs!) : undefined;
  const cageTags =
    cage && uvMode !== "NONE"
      ? baseFaceVaryingTags(result.polys, cage, result.creases, result.vertexSharpness, uvMode, preserveCorners)
      : undefined;
  const cageVertices = positions.length / 3;
  let cageFace: number[] = result.polys.map((_, f) => f);
  const childCageFaces = (parentPolys: number[][], parentCage: number[]): number[] =>
    parentPolys.flatMap((p, f) => p.map(() => parentCage[f]!));
  const unitSquare = (): [number, number][] => [[0, 0], [1, 0], [1, 1], [0, 1]];
  let isolated: SubdivResult | undefined;
  let descend: [number, number][][] | undefined;
  let ancestor: number[] = [];
  let cornerUV: [number, number][][] = [];
  for (let l = 0; l < level; l++) {
    const nextUV = result.uvs
      ? subdivideUVOnce(result.polys, result.uvs, uvMode, preserveCorners, result.creases, result.vertexSharpness, uvCarry)
      : undefined;
    const parentPolys = result.polys;
    result = subdivideOnce(result.positions, result.polys, result.creases, preserveCorners, result.vertexSharpness);
    if (nextUV) result.uvs = nextUV;
    if (!onPatches) continue;
    if (l < quality) cageFace = childCageFaces(parentPolys, cageFace);
    if (l + 1 === quality) {
      isolated = result;
      isolatedCid = uvCarry.cid;
      ancestor = result.polys.map((_, f) => f);
      cornerUV = result.polys.map(unitSquare);
    } else if (l + 1 > quality) {
      const mid = (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const nextAncestor: number[] = [];
      const nextUVs: [number, number][][] = [];
      parentPolys.forEach((p, f) => {
        const c = cornerUV[f]!;
        const centre: [number, number] = [(c[0]![0] + c[1]![0] + c[2]![0] + c[3]![0]) / 4, (c[0]![1] + c[1]![1] + c[2]![1] + c[3]![1]) / 4];
        for (let i = 0; i < p.length; i++) {
          nextAncestor.push(ancestor[f]!);
          nextUVs.push([c[i]!, mid(c[i]!, c[(i + 1) % 4]!), centre, mid(c[(i + 3) % 4]!, c[i]!)]);
        }
      });
      ancestor = nextAncestor;
      cornerUV = nextUVs;
    }
  }
  if (onPatches && !isolated) {
    // Below `quality`: refine on to it; the vertices keep their indices and are corners of its faces.
    let iso = result;
    // Each output face corner's face at `quality`: the corner's child, then that child's first child, level by level.
    descend = result.polys.map((p, f) => p.map((_, i) => [f, i] as [number, number]));
    for (let l = level; l < quality; l++) {
      const start: number[] = [];
      let n = 0;
      for (const p of iso.polys) {
        start.push(n);
        n += p.length;
      }
      descend = descend.map((row) => row.map(([f, i]): [number, number] => [start[f]! + i, 0]));
      const nextUV = iso.uvs
        ? subdivideUVOnce(iso.polys, iso.uvs, uvMode, preserveCorners, iso.creases, iso.vertexSharpness, uvCarry)
        : undefined;
      cageFace = childCageFaces(iso.polys, cageFace);
      iso = subdivideOnce(iso.positions, iso.polys, iso.creases, preserveCorners, iso.vertexSharpness);
      if (nextUV) iso.uvs = nextUV;
    }
    isolated = iso;
    isolatedCid = uvCarry.cid;
    ancestor = iso.polys.map((_, f) => f);
    cornerUV = iso.polys.map(unitSquare);
  }
  if (onPatches && isolated) {
    const count = result.positions.length / 3;
    const params: (PatchParam | undefined)[] = new Array(count);
    const fine = level >= quality ? result.polys : isolated.polys;
    fine.forEach((p, f) =>
      p.forEach((v, i) => {
        if (v < count) params[v] ??= { face: ancestor[f]!, u: cornerUV[f]![i]![0], v: cornerUV[f]![i]![1] };
      }),
    );
    const out = evaluatePatches(
      isolated.positions,
      isolated.polys,
      params.map((p) => p ?? { face: -1, u: 0, v: 0 }),
      isolated.creases,
      preserveCorners,
      isolated.vertexSharpness,
    );
    // A vertex no face uses keeps its refined position. (A loop, not `forEach`: the array is sparse, and `forEach`
    // skips exactly the holes this is for.)
    for (let v = 0; v < count; v++) if (!params[v]) out.set(result.positions.subarray(v * 3, v * 3 + 3), v * 3);
    result.positions = out;
    if (uvOnPatches && isolated.uvs) {
      // Every output corner on its own face's face-varying patch.
      const corner = (f: number, i: number): PatchParam =>
        descend
          ? { face: descend[f]![i]![0], u: 0, v: 0 }
          : { face: ancestor[f]!, u: cornerUV[f]![i]![0], v: cornerUV[f]![i]![1] };
      result.uvs = faceVaryingLimit(
        isolated,
        result.polys.map((p, f) => p.map((_, i) => corner(f, i))),
        uvMode,
        preserveCorners,
        cage!,
        cageTags,
        cageFace,
        polys,
        cageVertices,
        isolatedCid,
      );
    }
  } else if (options.limitSurface && level > 0)
    result.positions = limitPositions(positions, polys, result.positions, result.polys, preserveCorners, quality);
  return result;
}

/**
 * `subdivideUVOnce` on a creased cage (compat-backlog C28): OpenSubdiv refines
 * the face-varying values with the vertex's own sharpness
 * (`PrimvarRefiner::interpFVarFromVerts` / `interpFVarFromEdges`). A value
 * that follows its vertex takes the vertex's rule — Smooth / Dart / Crease /
 * Corner, mixed by the fractional weight as the sharpness runs out — and an
 * edge that is continuous in UV the edge's; a value on a seam is a corner
 * (stays), a crease (along its span's two boundary edges), or semi-sharp: a
 * corner while an edge inside its span (or its vertex) stays sharp, then the
 * crease mixed with the corner by the fractional weight.
 */
function subdivideUVOnceCreased(
  polys: number[][],
  uvs: number[][][],
  mode: UVSmooth,
  preserveCorners: boolean,
  sharpness: Map<string, number>,
  vertexSharpness: Map<number, number> | undefined,
  carry?: { state?: Map<string, FVarState>; cid?: number[][] },
): number[][][] {
  const fv = faceVaryingValues(polys, uvs, carry?.cid);
  const { values, valueAt, cid, vertexOf } = fv;
  // The tags: carried from the level above (`FVarRefinement::propagateValueTags` and
  // `reclassifySemisharpValues`), or the cage's own.
  const tags = new Map<number, FVarState>();
  const fresh = baseFaceVaryingTags(polys, fv, sharpness, vertexSharpness, mode, preserveCorners);
  cid.forEach((row, f) => row.forEach((id, i) => {
    if (tags.has(id)) return;
    const carried = carry?.state?.get(`${f},${i}`);
    if (carried) tags.set(id, carried);
  }));
  for (const [id, t] of fresh)
    if (!tags.has(id)) tags.set(id, { kind: t.kind === "dep" ? "semi" : t.kind, dep: t.kind === "dep" });
  const decay = (x: number): number => (x === Infinity ? x : x > 1 ? x - 1 : 0);
  const edgeUse = new Map<string, number>();
  polys.forEach((p) => p.forEach((v, i) => {
    const k = edgeKey(v, p[(i + 1) % p.length]!);
    edgeUse.set(k, (edgeUse.get(k) ?? 0) + 1);
  }));
  const sharpOf = (k: string): number => (edgeUse.get(k) === 1 ? Infinity : (sharpness.get(k) ?? 0));
  const half = valueHalfEdges(cid);
  const at = (f: number, i: number, d: number): number => polys[f]![(i + d + polys[f]!.length) % polys[f]!.length]!;
  const around: Array<Array<[number, number]>> = values.map(() => []);
  cid.forEach((row, f) => row.forEach((id, i) => around[id]!.push([f, i])));
  const facePoint = polys.map((p, f) => {
    let u = 0, w = 0;
    for (let i = 0; i < p.length; i++) {
      u += values[cid[f]![i]!]![0]!;
      w += values[cid[f]![i]!]![1]!;
    }
    return [u / p.length, w / p.length];
  });
  // Across an edge continuous in UV: the other face's corner, as `subdivideUVOnce`'s `continuous`.
  const across = (f: number, i: number): number | undefined => {
    const a = cid[f]![i]!;
    const b = cid[f]![(i + 1) % polys[f]!.length]!;
    return half.get(`${b},${a}`);
  };
  const lerp = (x: number[], y: number[], t: number): number[] => [x[0]! + (y[0]! - x[0]!) * t, x[1]! + (y[1]! - x[1]!) * t];
  const edgePoint = (f: number, i: number): number[] => {
    const a = values[cid[f]![i]!]!;
    const b = values[cid[f]![(i + 1) % polys[f]!.length]!]!;
    const mid = [(a[0]! + b[0]!) / 2, (a[1]! + b[1]!) / 2];
    const g = across(f, i);
    if (g === undefined) return mid;
    const sm = [(a[0]! + b[0]! + facePoint[f]![0]! + facePoint[g]![0]!) / 4, (a[1]! + b[1]! + facePoint[f]![1]! + facePoint[g]![1]!) / 4];
    const sh = sharpOf(edgeKey(at(f, i, 0), at(f, i, 1)));
    return sh <= 0 ? sm : sh < 1 ? lerp(sm, mid, sh) : mid;
  };
  // The span of a value: its faces in order and the edges inside it (vertex index of the far end).
  const spanOf = (id: number): { faces: number[]; open: boolean; inner: number[] } => {
    const [f0] = around[id]![0]!;
    const fan = valueFan(cid, half, f0, id);
    const v = vertexOf[id]!;
    const inner: number[] = [];
    const count = fan.open ? fan.faces.length - 1 : fan.faces.length;
    for (let j = 0; j < count; j++) {
      const p = polys[fan.faces[j]!]!;
      inner.push(p[(p.indexOf(v) + p.length - 1) % p.length]!);
    }
    return { ...fan, inner };
  };
  /** `ComputeFractionalWeightAtVertex` over a value's span. */
  const fractional = (id: number): number => {
    const v = vertexOf[id]!;
    const vs = vertexSharpness?.get(v) ?? 0;
    let sum = 0;
    let n = 0;
    if (vs > 0 && decay(vs) <= 0) {
      sum += vs;
      n++;
    }
    for (const w of spanOf(id).inner) {
      const x = sharpOf(edgeKey(v, w));
      if (x > 0 && x <= 1) {
        sum += x;
        n++;
      }
    }
    return n === 0 ? 0 : Math.min(1, sum / n);
  };
  // `reclassifySemisharpValues`: the child's tags. A value stays semi-sharp while its vertex is still sharp; with no
  // semi-sharp edge left at the vertex every value becomes a crease; otherwise a value (not dependent) stays semi-sharp
  // while an edge inside its span is, and a dependent value stops depending once its partner is no longer semi-sharp.
  const childFinite = (v: number, w: number): boolean => {
    const x = decay(sharpOf(edgeKey(v, w)));
    return x > 0 && x !== Infinity;
  };
  const vertexEnds = new Map<number, Set<number>>();
  polys.forEach((p) => p.forEach((v, i) => {
    const set = vertexEnds.get(v) ?? vertexEnds.set(v, new Set()).get(v)!;
    set.add(p[(i + 1) % p.length]!).add(p[(i + p.length - 1) % p.length]!);
  }));
  const childTags = new Map<number, FVarState>();
  for (const [v, ids] of valueAt) {
    if (!ids.some((id) => tags.get(id)?.kind === "semi")) {
      for (const id of ids) if (tags.has(id)) childTags.set(id, tags.get(id)!);
      continue;
    }
    const next = ids.map((id) => ({ ...tags.get(id)! }));
    const vs = decay(vertexSharpness?.get(v) ?? 0);
    if (vs <= 0) {
      const semiEdges = [...vertexEnds.get(v)!].some((w) => childFinite(v, w));
      next.forEach((t, j) => {
        if (t.kind !== "semi") return;
        if (!semiEdges || (!t.dep && !spanOf(ids[j]!).inner.some((w) => childFinite(v, w)))) {
          t.kind = "crease";
          t.dep = false;
        }
      });
      const dependent = mode === "PRESERVE_CORNERS_AND_JUNCTIONS" || mode === "PRESERVE_CORNERS_JUNCTIONS_AND_CONCAVE";
      if (semiEdges && dependent && next.length === 2) {
        if (next[0]!.dep && next[1]!.kind !== "semi") next[0]!.dep = false;
        else if (next[1]!.dep && next[0]!.kind !== "semi") next[1]!.dep = false;
      }
    }
    ids.forEach((id, j) => childTags.set(id, next[j]!));
  }
  const creaseRule = (id: number): number[] => {
    // (prev + 6 S + next) / 8 between the far ends of the span's two boundary edges.
    const span = spanOf(id);
    const first = span.faces[0]!;
    const last = span.faces[span.faces.length - 1]!;
    const fi = polys[first]!.indexOf(vertexOf[id]!);
    const li = polys[last]!.indexOf(vertexOf[id]!);
    const a = values[cid[first]![(fi + 1) % polys[first]!.length]!]!;
    const b = values[cid[last]![(li + polys[last]!.length - 1) % polys[last]!.length]!]!;
    const s0 = values[id]!;
    return [(a[0]! + 6 * s0[0]! + b[0]!) / 8, (a[1]! + 6 * s0[1]! + b[1]!) / 8];
  };
  const valuePoint = values.map((s0, id) => {
    const tag = tags.get(id);
    if (tag) {
      // A corner (sharp, or semi-sharp while it lasts) stays; a crease takes the crease rule; a semi-sharp value
      // becoming a crease mixes the two by the fractional weight — its partner's when it was dependent.
      const child = childTags.get(id)!;
      if (child.kind !== "crease") return [s0[0]!, s0[1]!];
      if (tag.kind !== "semi") return creaseRule(id);
      const partner = tag.dep ? valueAt.get(vertexOf[id]!)!.find((o) => o !== id) : id;
      return lerp(creaseRule(id), s0, fractional(partner ?? id));
    }
    // A value that follows its vertex: the vertex's own rule, as `subdivideOnce` gives the positions.
    const v = vertexOf[id]!;
    const corners = around[id]!;
    const ends = new Map<number, number[]>();
    for (const [f, i] of corners) {
      ends.set(at(f, i, 1), values[cid[f]![(i + 1) % polys[f]!.length]!]!);
      ends.set(at(f, i, -1), values[cid[f]![(i + polys[f]!.length - 1) % polys[f]!.length]!]!);
    }
    const n = corners.length;
    let qu = 0, qv = 0;
    for (const [f] of corners) {
      qu += facePoint[f]![0]!;
      qv += facePoint[f]![1]!;
    }
    let ru = 0, rv = 0;
    for (const e of ends.values()) {
      ru += (s0[0]! + e[0]!) / 2;
      rv += (s0[1]! + e[1]!) / 2;
    }
    const m = ends.size;
    const smooth = [(qu / n + (2 * ru) / m + (n - 3) * s0[0]!) / n, (qv / n + (2 * rv) / m + (n - 3) * s0[1]!) / n];
    const vs = vertexSharpness?.get(v) ?? 0;
    const cvs = decay(vs);
    let creaseCount = 0, childCount = 0, tSum = vs > 0 && cvs <= 0 ? vs : 0, tCount = vs > 0 && cvs <= 0 ? 1 : 0;
    const nbrs: number[][] = [];
    const childNbrs: number[][] = [];
    for (const [w, e] of ends) {
      const x = sharpOf(edgeKey(v, w));
      if (x <= 0) continue;
      creaseCount++;
      nbrs.push(e);
      if (decay(x) > 0) {
        childCount++;
        childNbrs.push(e);
      } else {
        tSum += x;
        tCount++;
      }
    }
    if (preserveCorners && n === 1) return [s0[0]!, s0[1]!];
    if (creaseCount === 0 && vs <= 0) return smooth;
    const ruleOf = (x: number, c: number): number => (x > 0 || c > 2 ? 3 : c);
    const ruleAt = (rule: number, ns: number[][]): number[] =>
      rule <= 1 ? smooth : rule === 2 ? [(6 * s0[0]! + ns[0]![0]! + ns[1]![0]!) / 8, (6 * s0[1]! + ns[0]![1]! + ns[1]![1]!) / 8] : [s0[0]!, s0[1]!];
    const pr = ruleOf(vs, creaseCount);
    const cr = ruleOf(cvs, childCount);
    if (pr === cr) return ruleAt(pr, nbrs);
    const wgt = tCount === 0 ? 0 : Math.min(1, tSum / tCount);
    return lerp(ruleAt(cr, childNbrs), ruleAt(pr, nbrs), wgt);
  });
  const out: number[][][] = [];
  polys.forEach((p, f) => {
    for (let i = 0; i < p.length; i++)
      out.push([valuePoint[cid[f]![i]!]!, edgePoint(f, i), facePoint[f]!, edgePoint(f, (i + p.length - 1) % p.length)]);
  });
  if (carry) {
    // The child corners' tags: a vertex's values carry theirs, a value made on a seam is a corner under linear
    // boundaries and a crease otherwise (`propagateValueTags`).
    const state = new Map<string, FVarState>();
    const linearBoundaries = mode === "PRESERVE_BOUNDARIES";
    let start = 0;
    polys.forEach((p, f) => {
      for (let i = 0; i < p.length; i++) {
        const t = childTags.get(cid[f]![i]!);
        if (t) state.set(`${start + i},0`, t);
        const seam = across(f, i) === undefined && (edgeUse.get(edgeKey(at(f, i, 0), at(f, i, 1))) === 2 || linearBoundaries);
        if (seam) {
          const made: FVarState = { kind: linearBoundaries ? "sharp" : "crease", dep: false };
          state.set(`${start + i},1`, made);
          state.set(`${start + ((i + 1) % p.length)},3`, made);
        }
      }
      start += p.length;
    });
    carry.state = state;
    carry.cid = childValueIds(polys, cid, values.length, (f, i) => across(f, i) !== undefined);
  }
  return out;
}

/** A face-varying value's tags as they pass from level to level (`FVarLevel::ValueTag`, the part refinement reads). */
interface FVarState {
  kind: "sharp" | "crease" | "semi";
  dep: boolean;
}

/**
 * The UVs on OpenSubdiv's face-varying patches (compat-backlog C28), one per
 * output corner. `isolated` is the `quality` mesh with its UVs; the values
 * that do not follow their vertex take the cage's tags (vertices below
 * `cageVertices` keep their numbers, `cageFace` names each `quality` face's
 * face of the cage) or, made on a seam during refinement, a corner's
 * (linear boundaries) or a crease's.
 */
function faceVaryingLimit(
  isolated: SubdivResult,
  corners: PatchParam[][],
  mode: UVSmooth,
  preserveCorners: boolean,
  cage: { cid: number[][] },
  cageTags: Map<number, BaseValueTag> | undefined,
  cageFace: number[],
  cagePolys: number[][],
  cageVertices: number[] | number,
  isolatedCid?: number[][],
): number[][][] {
  const polys = isolated.polys;
  const fv = faceVaryingValues(polys, isolated.uvs!, isolatedCid);
  if (mode === "NONE") {
    // FVAR_LINEAR_ALL: bilinear patches on the `quality` faces.
    return corners.map((row) =>
      row.map(({ face, u, v }) => {
        const c = fv.cid[face]!.map((id) => fv.values[id]!);
        const w = [(1 - u) * (1 - v), u * (1 - v), u * v, (1 - u) * v];
        return [0, 1].map((k) => c.reduce((acc, x, j) => acc + x[k]! * w[j]!, 0));
      }),
    );
  }
  const V0 = typeof cageVertices === "number" ? cageVertices : cageVertices.length;
  const linearBoundaries = mode === "PRESERVE_BOUNDARIES";
  const sharp = isolated.creases;
  const vS = isolated.vertexSharpness ?? new Map<number, number>();
  const edgeUse = new Map<string, number>();
  polys.forEach((p) => p.forEach((v, i) => {
    const k = edgeKey(v, p[(i + 1) % 4]!);
    edgeUse.set(k, (edgeUse.get(k) ?? 0) + 1);
  }));
  const boundaryVertex = new Set<number>();
  for (const [k, n] of edgeUse) if (n === 1) for (const v of parseKey(k)) boundaryVertex.add(v);
  const half = valueHalfEdges(fv.cid);
  const firstCorner = new Map<number, [number, number]>();
  fv.cid.forEach((row, f) => row.forEach((id, i) => {
    if (!firstCorner.has(id)) firstCorner.set(id, [f, i]);
  }));
  // A semi-sharp value stays so while its vertex or an edge inside its span is still sharp.
  const stillSemi = (id: number): boolean => {
    const v = fv.vertexOf[id]!;
    if ((vS.get(v) ?? 0) > 0) return true;
    const [f] = firstCorner.get(id)!;
    const fan = valueFan(fv.cid, half, f, id);
    const inner = fan.open ? fan.faces.length - 1 : fan.faces.length;
    for (let j = 0; j < inner; j++) {
      const p = polys[fan.faces[j]!]!;
      const s = sharp.get(edgeKey(v, p[(p.indexOf(v) + 3) % 4]!)) ?? 0;
      if (s > 0 && s !== Infinity) return true;
    }
    return false;
  };
  const baseTagOf = (id: number): BaseValueTag | undefined => {
    const [f, i] = firstCorner.get(id)!;
    const c = cageFace[f]!;
    return cageTags?.get(cage.cid[c]![cagePolys[c]!.indexOf(polys[f]![i]!)]!);
  };
  // The cage's values (and their descendants) by their tags; values made on a seam a corner's or a crease's.
  const kinds = new Map<number, { kind: BaseValueTag["kind"]; base: BaseValueTag }>();
  const tags = new Map<number, FVarTag>();
  fv.values.forEach((_, id) => {
    const v = fv.vertexOf[id]!;
    if (v < V0) {
      const base = baseTagOf(id);
      if (!base) return;
      kinds.set(id, { kind: base.kind === "semi" && !stillSemi(id) ? "crease" : base.kind, base });
      return;
    }
    const mismatch = fv.valueAt.get(v)!.length > 1 || (linearBoundaries && boundaryVertex.has(v));
    if (!mismatch) return;
    tags.set(id, { crease: !linearBoundaries, semiSharp: false, infSharpEdges: false, infIrregular: false, xordinary: false });
  });
  // A value semi-sharp by dependence stays so while a value it depends on is semi-sharp.
  for (const [id, { kind, base }] of kinds) {
    let k = kind;
    if (k === "dep")
      k = fv.valueAt.get(fv.vertexOf[id]!)!.some((o) => o !== id && kinds.get(o)?.kind === "semi") ? "semi" : "crease";
    tags.set(id, {
      crease: k === "crease",
      semiSharp: k === "semi",
      infSharpEdges: base.infSharpEdges,
      infIrregular: base.infIrregular,
      xordinary: base.xordinary,
      ...(base.nonManifold ? { nonManifold: true } : {}),
    });
  }
  const P = new Float32Array(fv.values.length * 3);
  fv.values.forEach((uv, id) => P.set([uv[0]!, uv[1]!, 0], id * 3));
  const valueSharpness = new Map<string, number>();
  fv.cid.forEach((row, f) => row.forEach((a, i) => {
    const b = row[(i + 1) % 4]!;
    const s = sharp.get(edgeKey(polys[f]![i]!, polys[f]![(i + 1) % 4]!));
    if (s) valueSharpness.set(edgeKey(a, b), s);
  }));
  const valueVertexSharpness = new Map<number, number>();
  fv.vertexOf.forEach((v, id) => {
    const s = vS.get(v);
    if (s) valueVertexSharpness.set(id, s);
  });
  const flat = corners.flat();
  const out = evaluatePatches(P, fv.cid, flat, valueSharpness, preserveCorners, valueVertexSharpness, tags);
  let k = 0;
  return corners.map((row) => row.map(() => {
    const uv = [out[k * 3]!, out[k * 3 + 1]!];
    k++;
    return uv;
  }));
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

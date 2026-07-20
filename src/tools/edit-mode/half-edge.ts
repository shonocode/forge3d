import type { Mesh } from "@babylonjs/core/Meshes/mesh";

/**
 * Index-based Half-Edge data structure for Edit Mode operators.
 *
 * V2 (quad / n-gon): faces are arbitrary polygons — each face is a cycle of
 * ≥3 half-edges linked by `next`. Babylon renders triangles only, so the
 * render index buffer is always derived by fan-triangulating every face
 * ({@link triangulateFaces}); `EditMesh.triToFace` maps each render triangle
 * back to its owning logical face (used by face picking). The polygon
 * structure itself survives outside Edit Mode via `mesh.metadata.forge3dPolys`
 * (written on every topology commit, validated against the index buffer on
 * the next Edit Mode entry — see build.ts).
 *
 * The design doc (`EDIT-MODE-DESIGN.md` §3.1) describes object-ref
 * half-edges; we use indices instead because TypeScript array-of-objects is
 * faster to mutate and easier to serialize for undo snapshots.
 */
export interface HalfEdge {
  /** Origin vertex index. */
  v: number;
  /** Next half-edge index within the same face (CCW). */
  next: number;
  /** Pair half-edge on the adjacent face, or -1 if this edge is a boundary. */
  twin: number;
  /** Owning face index. */
  face: number;
}

export interface EditFace {
  /** Any one half-edge belonging to this face. */
  he: number;
}

export interface EditVertex {
  /** Any one half-edge whose origin is this vertex, or -1 if isolated. */
  he: number;
}

export interface EditMesh {
  /** Source Babylon mesh — positions are written back here on commit. */
  source: Mesh;
  vertices: EditVertex[];
  faces: EditFace[];
  halfEdges: HalfEdge[];
  /** Local-space positions, length = vertices.length * 3, mutable. */
  positions: Float32Array;
  /**
   * Edges marked as UV seams. Keyed by `seamKey(v1, v2)` = "min_max" of the
   * two vertex indices, NOT by half-edge index — this lets seams survive
   * topology rebuilds (extrude / bevel / etc.) as long as the endpoint
   * vertex IDs stay valid. Unwrap uses these to break face clusters.
   */
  seams: Set<string>;
  /**
   * Edge sharpness for Catmull-Clark creases. Keyed by `seamKey(v1, v2)`
   * (same vertex-pair scheme as `seams`), value = σ ≥ 0 (0 / absent = smooth,
   * ≥ 1 = fully sharp). Only Subdivide reads these; other operators leave them
   * alone (a stale key simply matches no current edge and is ignored).
   */
  creases: Map<string, number>;
  /**
   * Render-triangle → logical-face map for the CURRENT source index buffer.
   * Kept in sync by build (entry) and commitTopology (every topology op) so
   * `scene.pick().faceId` can be resolved to a polygon face.
   */
  triToFace: number[];
}

/** Cycle guard for face walks — no sane face has more sides than this. */
const MAX_FACE_ARITY = 4096;

/** Build a stable, direction-agnostic key for an edge between two vertices. */
export function seamKey(v1: number, v2: number): string {
  return v1 < v2 ? `${v1}_${v2}` : `${v2}_${v1}`;
}

/** True iff the given (canonical) half-edge is currently marked as a seam. */
export function isSeam(em: EditMesh, he: number): boolean {
  const a = edgeOrigin(em, he);
  const b = edgeEnd(em, he);
  return em.seams.has(seamKey(a, b));
}

/** Crease sharpness (σ) of the given half-edge's edge — 0 when not creased. */
export function creaseOf(em: EditMesh, he: number): number {
  const a = edgeOrigin(em, he);
  const b = edgeEnd(em, he);
  return em.creases.get(seamKey(a, b)) ?? 0;
}

/** Half-edge representing the edge from `vertex(he)` to `vertex(next)`. */
export function edgeOrigin(em: EditMesh, he: number): number {
  return em.halfEdges[he]!.v;
}

export function edgeEnd(em: EditMesh, he: number): number {
  const h = em.halfEdges[he]!;
  return em.halfEdges[h.next]!.v;
}

/**
 * Canonical half-edge index for an edge. Each undirected edge corresponds to
 * two half-edges (or one, on a boundary); we treat the smaller-indexed one as
 * the "edge id" so the same edge has a stable identifier regardless of which
 * face we touched it from.
 */
export function canonicalEdge(em: EditMesh, he: number): number {
  const twin = em.halfEdges[he]!.twin;
  if (twin < 0) return he;
  return he < twin ? he : twin;
}

/** Iterate every unique edge exactly once. */
export function forEachEdge(em: EditMesh, cb: (he: number) => void): void {
  for (let i = 0; i < em.halfEdges.length; i++) {
    const twin = em.halfEdges[i]!.twin;
    if (twin < 0 || i < twin) cb(i);
  }
}

/** All half-edges of face `f`, in CCW cycle order starting at `faces[f].he`. */
export function faceHalfEdges(em: EditMesh, f: number): number[] {
  const out: number[] = [];
  const h0 = em.faces[f]!.he;
  let h = h0;
  let guard = 0;
  do {
    out.push(h);
    h = em.halfEdges[h]!.next;
  } while (h !== h0 && ++guard < MAX_FACE_ARITY);
  return out;
}

/** All vertex indices of face `f` in CCW order (variable arity — V2). */
export function faceVerts(em: EditMesh, f: number): number[] {
  return faceHalfEdges(em, f).map((h) => em.halfEdges[h]!.v);
}

/** Number of sides of face `f`. */
export function faceVertexCount(em: EditMesh, f: number): number {
  return faceHalfEdges(em, f).length;
}

/** True iff any face has more than 3 sides. */
export function hasNonTriFaces(em: EditMesh): boolean {
  for (let f = 0; f < em.faces.length; f++) {
    if (faceVertexCount(em, f) !== 3) return true;
  }
  return false;
}

/**
 * The FIRST THREE vertex indices of a face (CCW order).
 *
 * Triangle-only legacy helper — correct solely for 3-sided faces. Polygon-
 * aware code must use {@link faceVerts}. Retained for the tri-specific
 * operators (Flip Diagonal, bevel fan math) and their tests.
 */
export function faceVertices(em: EditMesh, f: number): [number, number, number] {
  const h0 = em.faces[f]!.he;
  const he0 = em.halfEdges[h0]!;
  const he1 = em.halfEdges[he0.next]!;
  return [he0.v, he1.v, em.halfEdges[he1.next]!.v];
}

/**
 * Face normal via Newell's method — robust for arbitrary (even slightly
 * non-planar) polygons, and identical to the cross-product normal for
 * triangles. Returns a normalized vector (zero vector for degenerate faces).
 */
export function facePolyNormal(em: EditMesh, f: number): [number, number, number] {
  const verts = faceVerts(em, f);
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i]!;
    const b = verts[(i + 1) % verts.length]!;
    const ax = em.positions[a * 3]!, ay = em.positions[a * 3 + 1]!, az = em.positions[a * 3 + 2]!;
    const bx = em.positions[b * 3]!, by = em.positions[b * 3 + 1]!, bz = em.positions[b * 3 + 2]!;
    nx += (ay - by) * (az + bz);
    ny += (az - bz) * (ax + bx);
    nz += (ax - bx) * (ay + by);
  }
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len > 1e-9) { nx /= len; ny /= len; nz /= len; }
  return [nx, ny, nz];
}

/** Set the world-local position of a vertex (used by gizmo drag). */
export function setVertexPosition(em: EditMesh, v: number, x: number, y: number, z: number): void {
  em.positions[v * 3] = x;
  em.positions[v * 3 + 1] = y;
  em.positions[v * 3 + 2] = z;
}

export function getVertexPosition(em: EditMesh, v: number, out: [number, number, number]): void {
  out[0] = em.positions[v * 3]!;
  out[1] = em.positions[v * 3 + 1]!;
  out[2] = em.positions[v * 3 + 2]!;
}

/**
 * Replace `em`'s geometry with the supplied positions + polygon list and
 * rebuild every half-edge from scratch. Used by topology-changing operators
 * (Extrude, Delete, …) — for small meshes (<10k faces) the rebuild cost
 * (O(F)) is dominated by the operator's own work.
 *
 * Each polygon is a CCW cycle of ≥3 vertex indices. `em.source` is left
 * unchanged; callers commit to Babylon separately via `commitTopology`.
 */
export function rebuildPolygons(em: EditMesh, positions: Float32Array, polys: number[][]): void {
  const numV = positions.length / 3;
  let totalHE = 0;
  for (const p of polys) totalHE += p.length;

  em.positions = positions;
  em.vertices = new Array(numV);
  for (let i = 0; i < numV; i++) em.vertices[i] = { he: -1 };
  em.faces = new Array(polys.length);
  em.halfEdges = new Array(totalHE);

  const edgeMap = new Map<number, number>();
  const key = (a: number, b: number): number => (a < b ? a * numV + b : b * numV + a);

  let base = 0;
  for (let f = 0; f < polys.length; f++) {
    const poly = polys[f]!;
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % n]!;
      em.halfEdges[base + i] = { v: a, next: base + ((i + 1) % n), twin: -1, face: f };
      if (em.vertices[a]!.he < 0) em.vertices[a]!.he = base + i;
      pairTwin(edgeMap, em, key(a, b), base + i);
    }
    em.faces[f] = { he: base };
    base += n;
  }
}

/**
 * Triangle-list convenience wrapper over {@link rebuildPolygons}. Kept for
 * the tri-producing paths (Knife plane cut, unwrap fallbacks, tests).
 */
export function rebuildHalfEdges(em: EditMesh, positions: Float32Array, indices: number[]): void {
  const polys: number[][] = new Array(indices.length / 3);
  for (let f = 0; f < polys.length; f++) {
    polys[f] = [indices[f * 3]!, indices[f * 3 + 1]!, indices[f * 3 + 2]!];
  }
  rebuildPolygons(em, positions, polys);
}

function pairTwin(edgeMap: Map<number, number>, em: EditMesh, k: number, heIdx: number): void {
  const existing = edgeMap.get(k);
  if (existing === undefined) {
    edgeMap.set(k, heIdx);
  } else {
    em.halfEdges[existing]!.twin = heIdx;
    em.halfEdges[heIdx]!.twin = existing;
  }
}

/** Read back the current polygon list (one CCW vertex cycle per face). */
export function toPolygons(em: EditMesh): number[][] {
  const out: number[][] = new Array(em.faces.length);
  for (let f = 0; f < em.faces.length; f++) out[f] = faceVerts(em, f);
  return out;
}

/**
 * Fan-triangulate every face for rendering: polygon (v0…vn₋₁) emits
 * (v0, vᵢ, vᵢ₊₁) for i = 1…n-2. Triangle faces pass through unchanged, so a
 * tri-only mesh round-trips exactly. `triToFace[t]` is the owning face of
 * output triangle `t`.
 */
export function triangulateFaces(em: EditMesh): { indices: number[]; triToFace: number[] } {
  const indices: number[] = [];
  const triToFace: number[] = [];
  for (let f = 0; f < em.faces.length; f++) {
    const verts = faceVerts(em, f);
    for (let i = 1; i + 1 < verts.length; i++) {
      indices.push(verts[0]!, verts[i]!, verts[i + 1]!);
      triToFace.push(f);
    }
  }
  return { indices, triToFace };
}

/**
 * Fan-triangulate a single polygon (standalone list form) — shared by
 * operators that need render triangles without an EditMesh.
 */
export function fanTriangulate(poly: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i + 1 < poly.length; i++) out.push(poly[0]!, poly[i]!, poly[i + 1]!);
  return out;
}

/** Read back the current triangle index list (fan-triangulated for n-gons). */
export function toIndexArray(em: EditMesh): number[] {
  return triangulateFaces(em).indices;
}

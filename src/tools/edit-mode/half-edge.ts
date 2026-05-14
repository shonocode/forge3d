import type { Mesh } from "@babylonjs/core/Meshes/mesh";

/**
 * Index-based Half-Edge data structure for Edit Mode operators.
 *
 * Triangle-only for V1. All faces have exactly 3 half-edges. The design doc
 * (`EDIT-MODE-DESIGN.md` §3.1) describes object-ref half-edges; we use indices
 * instead because TypeScript array-of-objects is faster to mutate and easier
 * to serialize for undo snapshots.
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

/** Return the three vertex indices of a triangle face (CCW order). */
export function faceVertices(em: EditMesh, f: number): [number, number, number] {
  const h0 = em.faces[f]!.he;
  const he0 = em.halfEdges[h0]!;
  const he1 = em.halfEdges[he0.next]!;
  return [he0.v, he1.v, em.halfEdges[he1.next]!.v];
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
 * Replace `em`'s geometry with the supplied positions + triangle index list
 * and rebuild every half-edge from scratch. Used by topology-changing
 * operators (Extrude, Delete, …) — for small meshes (<10k tris) the rebuild
 * cost (O(F)) is dominated by the operator's own work.
 *
 * `em.source` is left unchanged; callers commit to Babylon separately via
 * `commitTopology`.
 */
export function rebuildHalfEdges(em: EditMesh, positions: Float32Array, indices: number[]): void {
  const numV = positions.length / 3;
  const numF = indices.length / 3;

  em.positions = positions;
  em.vertices = new Array(numV);
  for (let i = 0; i < numV; i++) em.vertices[i] = { he: -1 };
  em.faces = new Array(numF);
  em.halfEdges = new Array(numF * 3);

  const edgeMap = new Map<number, number>();
  const key = (a: number, b: number): number => (a < b ? a * numV + b : b * numV + a);

  for (let f = 0; f < numF; f++) {
    const a = indices[f * 3]!;
    const b = indices[f * 3 + 1]!;
    const c = indices[f * 3 + 2]!;
    const i0 = f * 3;
    const i1 = f * 3 + 1;
    const i2 = f * 3 + 2;

    em.halfEdges[i0] = { v: a, next: i1, twin: -1, face: f };
    em.halfEdges[i1] = { v: b, next: i2, twin: -1, face: f };
    em.halfEdges[i2] = { v: c, next: i0, twin: -1, face: f };
    em.faces[f] = { he: i0 };

    if (em.vertices[a]!.he < 0) em.vertices[a]!.he = i0;
    if (em.vertices[b]!.he < 0) em.vertices[b]!.he = i1;
    if (em.vertices[c]!.he < 0) em.vertices[c]!.he = i2;

    pairTwin(edgeMap, em, key(a, b), i0);
    pairTwin(edgeMap, em, key(b, c), i1);
    pairTwin(edgeMap, em, key(c, a), i2);
  }
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

/** Read back the current triangle index list. Each face contributes 3 indices in CCW order. */
export function toIndexArray(em: EditMesh): number[] {
  const out: number[] = new Array(em.faces.length * 3);
  for (let f = 0; f < em.faces.length; f++) {
    const h0 = em.faces[f]!.he;
    const he0 = em.halfEdges[h0]!;
    const he1 = em.halfEdges[he0.next]!;
    out[f * 3] = he0.v;
    out[f * 3 + 1] = he1.v;
    out[f * 3 + 2] = em.halfEdges[he1.next]!.v;
  }
  return out;
}

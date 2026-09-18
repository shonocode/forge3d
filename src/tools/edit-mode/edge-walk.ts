/**
 * Edge loops and edge rings — "the ring around the top", from code.
 *
 * The face selectors in `tools/select.ts` turn a description into a set of
 * faces. Bevel, bridge and loop cut take **edges**, and until now there was
 * nothing that said "the loop around the rim": `brazier/brazier.ts` collected
 * its rim by comparing Y coordinates, which only works on a shape that happens
 * to have exactly one ring at that height.
 *
 * Neither walk is a `bmesh.ops` operator — in Blender they are editor walkers
 * (`mesh.select_edge_loop_multi` / `select_edge_ring_multi`), which is why the
 * API matrix could not have found them. The rules below were **measured**
 * against Blender 5.1.1 rather than read off the source, one shape per
 * question; `tools/modeling/parity/compare-edge-walk.ts` runs the same
 * measurements and is the regression test for them.
 *
 * ```
 *   loop   ─┬───┬───┬───┬─      ring    │   │   │   │
 *           │   │   │   │               ├───┼───┼───┤
 *                                       │   │   │   │
 *   through the vertices          across the faces
 * ```
 *
 * **A loop goes through vertices, a ring goes across faces.** The names are
 * worth getting right once: `loopCut` walks a *ring* (it crosses the faces the
 * new edge loop will be cut into) and used to call that walk `findEdgeLoop`,
 * which is the opposite word.
 *
 * Pure and headless — no scene, no selection state. Edges are identified by
 * their canonical half-edge index, which is what `canonicalEdge` returns and
 * what every operator here takes.
 */
import {
  canonicalEdge,
  edgeEnd,
  edgeOrigin,
  faceHalfEdges,
  facePolyNormal,
  faceVertexCount,
  type EditMesh,
} from "./half-edge";

/** Cycle guard. Every walk is bounded by the edge count; this is the backstop. */
const GUARD = 1 << 16;

// ── the disk around a vertex ───────────────────────────────────────────────

/**
 * Every edge touching `v`, in rotational order, plus whether the fan closes.
 *
 * `closed` is the interesting half. A vertex with four edges and an **open**
 * fan — the corner of a hole — looks like an ordinary valence-4 vertex to a
 * count, and Blender's loop stops there while it crosses the closed kind
 * (measured on `in-holeGrid.obj`, which exists for exactly this question).
 *
 * A boundary edge has one half-edge, so at the vertex it points *into* there
 * is no outgoing half-edge to find it by; the backward sweep picks it up as
 * the one incoming half-edge without a twin.
 */
export function edgesAtVertex(em: EditMesh, v: number): { edges: number[]; closed: boolean } {
  const start = em.vertices[v]?.he ?? -1;
  if (start < 0) return { edges: [], closed: false };
  return fanFrom(em, start);
}

/** The fan around a vertex, walked from one of its outgoing half-edges. */
function fanFrom(em: EditMesh, start: number): { edges: number[]; closed: boolean } {
  const outgoing: number[] = [start];
  let closed = false;
  let h = start;
  let guard = 0;

  // Forward: cross the face on one side, over and over.
  while (guard++ < GUARD) {
    const t = em.halfEdges[h]!.twin;
    if (t < 0) break;
    const next = em.halfEdges[t]!.next;
    if (next === start) {
      closed = true;
      break;
    }
    outgoing.push(next);
    h = next;
  }

  let incomingBoundary = -1;
  if (!closed) {
    h = start;
    while (guard++ < GUARD) {
      const prev = prevHalfEdge(em, h);
      const t = em.halfEdges[prev]!.twin;
      if (t < 0) {
        // `prev` ends at `v` and has no twin: the far side of the open fan.
        incomingBoundary = prev;
        break;
      }
      h = t;
      outgoing.unshift(h);
    }
  }

  const edges = outgoing.map((he) => canonicalEdge(em, he));
  if (incomingBoundary >= 0) edges.unshift(canonicalEdge(em, incomingBoundary));
  return { edges, closed };
}

/** Predecessor of `he` in its face cycle (the half-edge whose `next` is `he`). */
function prevHalfEdge(em: EditMesh, he: number): number {
  let h = he;
  let guard = 0;
  while (em.halfEdges[h]!.next !== he && guard++ < GUARD) h = em.halfEdges[h]!.next;
  return h;
}

/** An outgoing half-edge at `v` belonging to `he`'s face — a start for the fan. */
function outgoingAt(em: EditMesh, he: number, v: number): number {
  if (edgeOrigin(em, he) === v) return he;
  const twin = em.halfEdges[he]!.twin;
  if (twin >= 0 && edgeOrigin(em, twin) === v) return twin;
  // Boundary edge pointing into `v`: the next half-edge of its face leaves `v`.
  return em.halfEdges[he]!.next;
}

function isBoundaryEdge(em: EditMesh, edge: number): boolean {
  return em.halfEdges[edge]!.twin < 0;
}

function otherVert(em: EditMesh, edge: number, v: number): number {
  const a = edgeOrigin(em, edge);
  return a === v ? edgeEnd(em, edge) : a;
}

// ── edge loop ──────────────────────────────────────────────────────────────

/**
 * The edge loop through `seedEdge` — the ring of edges continuing straight on
 * through each vertex.
 *
 * Blender 5.1.1's rule, measured. It is three rules, and the third one is the
 * reason this could not have been written from the shape of the problem:
 *
 *  - **Interior edge with an n-gon on exactly one side** — a lathe's pole cap,
 *    a face left by `dissolveLimit` — is an *n-gon hub*: the loop is that
 *    face's perimeter, walked only through vertices with exactly three edges.
 *    A cap ring is all valence-3, so it comes back whole; a hexagon sitting in
 *    a quad grid stops where the grid's valence-4 vertices start. An n-gon on
 *    *both* sides has no hub and falls through to the next rule.
 *  - **Interior edge otherwise.** Step through a vertex only when it has
 *    exactly four edges *and* its fan is closed. Four-and-open — the corner of
 *    a hole — stops, and so does every other valence. The next edge is the one
 *    opposite in the fan, which is the one sharing no face with the current.
 *  - **Boundary edge.** Follow the boundary. Step through a vertex with
 *    exactly two boundary edges, as long as it has more than two edges in
 *    total *or* the one face there has more than four sides. A quad's corner
 *    stops; a hexagon's does not, and that is arity and not angle — a quad
 *    with a 174° corner stops too, a hexagon with a 20° spike does not.
 *
 * All three are arity-blind about triangles: an octahedron's vertices are
 * valence 4 and its loops run through triangles, and Blender's do too.
 *
 * Not measured, so stopped rather than guessed: a vertex with three or more
 * boundary edges (a pinch).
 *
 * @param seedEdge any half-edge of the edge to start from
 * @returns the loop as canonical edge ids, including the seed
 */
export function selectEdgeLoop(em: EditMesh, seedEdge: number): Set<number> {
  const seed = canonicalEdge(em, seedEdge);
  const hub = hubFaceOf(em, seed);
  const out = new Set<number>([seed]);

  for (const startVert of [edgeOrigin(em, seed), edgeEnd(em, seed)]) {
    let edge = seed;
    let vert = startVert;
    let guard = 0;
    while (guard++ < GUARD) {
      const next = hub >= 0 ? nextHubEdge(em, hub, edge, vert) : nextLoopEdge(em, edge, vert);
      if (next < 0 || out.has(next)) break;
      out.add(next);
      vert = otherVert(em, next, vert);
      edge = next;
    }
  }
  return out;
}

/**
 * The face carrying an n-gon loop, or -1.
 *
 * Exactly one side has to be an n-gon: with two there is no reason to prefer
 * either perimeter, and Blender picks neither (measured on two hexagons
 * sharing an edge — the loop comes back as the seed alone).
 */
function hubFaceOf(em: EditMesh, edge: number): number {
  const twin = em.halfEdges[edge]!.twin;
  if (twin < 0) return -1; // a boundary edge walks the boundary instead
  const f1 = em.halfEdges[edge]!.face;
  const f2 = em.halfEdges[twin]!.face;
  const big1 = faceVertexCount(em, f1) > 4;
  const big2 = faceVertexCount(em, f2) > 4;
  if (big1 === big2) return -1;
  return big1 ? f1 : f2;
}

/** The hub face's other edge at `vert`, while the perimeter is unbranched. */
function nextHubEdge(em: EditMesh, hub: number, edge: number, vert: number): number {
  if (fanFrom(em, outgoingAt(em, edge, vert)).edges.length !== 3) return -1;
  for (const h of faceHalfEdges(em, hub)) {
    const e = canonicalEdge(em, h);
    if (e === edge) continue;
    if (edgeOrigin(em, h) === vert || edgeEnd(em, h) === vert) return e;
  }
  return -1;
}

/** The next loop edge leaving `edge` through `vert`, or -1 where the rule stops. */
function nextLoopEdge(em: EditMesh, edge: number, vert: number): number {
  const fan = fanFrom(em, outgoingAt(em, edge, vert));

  if (isBoundaryEdge(em, edge)) {
    // Along the boundary: the other boundary edge at this vertex.
    const boundary = fan.edges.filter((e) => isBoundaryEdge(em, e));
    if (boundary.length !== 2) return -1;
    // A corner with nothing behind it stops — unless the face it corners is an
    // n-gon, whose perimeter is a loop in its own right.
    if (fan.edges.length <= 2 && faceVertexCount(em, em.halfEdges[edge]!.face) <= 4) return -1;
    return boundary[0] === edge ? boundary[1]! : boundary[0]!;
  }

  if (!fan.closed || fan.edges.length !== 4) return -1;
  const at = fan.edges.indexOf(edge);
  if (at < 0) return -1;
  return fan.edges[(at + 2) % 4]!;
}

// ── edge ring ──────────────────────────────────────────────────────────────

export interface EdgeRingOptions {
  /**
   * Treat a near-coplanar pair of triangles as one quad and keep walking.
   *
   * Off by default, because Blender's ring select stops at a triangle
   * (measured: one edge back from an octahedron). `loopCut` turns it **on** —
   * it has to cut through triangulated cages, and the V1 rule that an implicit
   * quad is two triangles whose normals agree within 45° is what makes that
   * work. Nothing else should want it.
   */
  throughTrianglePairs?: boolean;
}

/**
 * The edge ring through `seedEdge` — the edges reached by crossing face after
 * face, each time leaving through the side opposite the one entered.
 *
 * Only a quad has an opposite side, so the ring stops at triangles and n-gons
 * (and at a boundary, where there is no next face). This is the walk `loopCut`
 * needs: the faces a ring crosses are the faces the new loop is cut into.
 *
 * @param seedEdge any half-edge of the edge to start from
 */
export function selectEdgeRing(em: EditMesh, seedEdge: number, options: EdgeRingOptions = {}): Set<number> {
  return new Set(walkEdgeRing(em, seedEdge, options).edges);
}

/**
 * The ring as an ordered walk rather than a set — `loopCut` cuts each pair of
 * consecutive edges and needs to know which pairs are consecutive, and whether
 * the ring closes.
 *
 * Order is CCW when the ring is closed, and walk order (one end to the other)
 * when it is open. A degenerate seed comes back as `[seedEdge]`.
 */
export function walkEdgeRing(
  em: EditMesh,
  seedEdge: number,
  options: EdgeRingOptions = {},
): { edges: number[]; closed: boolean } {
  const seed = canonicalEdge(em, seedEdge);
  const twin = em.halfEdges[seed]!.twin;
  const forward = walkRingDirection(em, seed, em.halfEdges[seed]!.face, options);
  if (forward.closed) return forward;

  // A boundary edge has one face, and the ring goes through it: Blender's ring
  // from the edge of a hole crosses the faces behind it like any other.
  if (twin < 0) return forward;

  const backward = walkRingDirection(em, seed, em.halfEdges[twin]!.face, options);
  return { edges: [...backward.edges.slice(1).reverse(), ...forward.edges], closed: false };
}

function walkRingDirection(
  em: EditMesh,
  seedEdge: number,
  firstFace: number,
  options: EdgeRingOptions,
): { edges: number[]; closed: boolean } {
  const edges: number[] = [seedEdge];
  const visited = new Set<number>([seedEdge]);
  let cur = seedEdge;
  let cross = firstFace;
  let guard = 0;

  while (guard++ < GUARD) {
    const step = nextRingEdge(em, cur, cross, options);
    if (!step) return { edges, closed: false };
    if (step.nextEdge === seedEdge) return { edges, closed: true };
    if (visited.has(step.nextEdge)) return { edges, closed: false };
    visited.add(step.nextEdge);
    edges.push(step.nextEdge);
    cur = step.nextEdge;
    cross = step.nextFace;
  }
  return { edges, closed: false };
}

/**
 * Cross `crossFace` from canonical edge `cur` and come out the other side.
 *
 * Quad → the opposite edge, two steps around the cycle. Triangle → only with
 * `throughTrianglePairs`, and then the V1 implicit quad: the most coplanar
 * triangle neighbour, exiting through its edge that touches neither end of
 * `cur`. Any other arity stops the walk.
 *
 * `nextFace` is the face to cross next — the one on the far side of the edge
 * we just reached — or -1 when that edge is on the boundary and the walk ends
 * with it.
 */
function nextRingEdge(
  em: EditMesh,
  cur: number,
  crossFace: number,
  options: EdgeRingOptions,
): { nextEdge: number; nextFace: number } | null {
  if (crossFace < 0) return null;
  const outHEs = faceHalfEdges(em, crossFace);

  if (outHEs.length === 4) {
    const curHE = outHEs.find((h) => canonicalEdge(em, h) === cur);
    if (curHE === undefined) return null;
    const exitHE = em.halfEdges[em.halfEdges[curHE]!.next]!.next;
    return { nextEdge: canonicalEdge(em, exitHE), nextFace: acrossFrom(em, exitHE, crossFace) };
  }
  if (outHEs.length !== 3 || !options.throughTrianglePairs) return null;
  const outgoingFace = crossFace;

  // Triangle: pick the diagonal candidate among the 2 edges not on `cur`.
  const outNormal = facePolyNormal(em, outgoingFace);
  const COPLANAR_THRESHOLD = 0.7; // cos(45°) — coarse but covers cube faces (1.0) and rejects orthogonal neighbors (0.0).

  let bestDiagonalHE = -1;
  let bestDot = COPLANAR_THRESHOLD;
  for (const h of outHEs) {
    if (canonicalEdge(em, h) === cur) continue;
    const t = em.halfEdges[h]!.twin;
    if (t < 0) continue;
    const neighbor = em.halfEdges[t]!.face;
    if (faceVertexCount(em, neighbor) !== 3) continue;
    const neighborNormal = facePolyNormal(em, neighbor);
    const dot =
      outNormal[0] * neighborNormal[0] + outNormal[1] * neighborNormal[1] + outNormal[2] * neighborNormal[2];
    if (dot > bestDot) {
      bestDot = dot;
      bestDiagonalHE = h;
    }
  }
  if (bestDiagonalHE < 0) return null;

  const partnerFace = em.halfEdges[em.halfEdges[bestDiagonalHE]!.twin]!.face;

  // Find the partner's edge that doesn't share a vertex with `cur`.
  const a = edgeOrigin(em, cur);
  const b = edgeEnd(em, cur);
  for (const ph of faceHalfEdges(em, partnerFace)) {
    const pa = em.halfEdges[ph]!.v;
    const pb = em.halfEdges[em.halfEdges[ph]!.next]!.v;
    if (pa !== a && pa !== b && pb !== a && pb !== b) {
      return { nextEdge: canonicalEdge(em, ph), nextFace: acrossFrom(em, ph, partnerFace) };
    }
  }
  return null;
}

/** The face on the other side of half-edge `he` from `face`, or -1. */
function acrossFrom(em: EditMesh, he: number, face: number): number {
  const twin = em.halfEdges[he]!.twin;
  const f1 = em.halfEdges[he]!.face;
  if (f1 !== face) return f1;
  return twin < 0 ? -1 : em.halfEdges[twin]!.face;
}

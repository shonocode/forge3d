import { canonicalEdge, edgeEnd, edgeOrigin, faceHalfEdges, facePolyNormal, faceVertexCount, faceVerts, faceVertices, forEachEdge, rebuildPolygons, seamKey, toPolygons, type EditMesh } from "./half-edge";
import { catmullClark } from "./subdivide";

/**
 * Topology operators. Each operator mutates `em` in place (rebuilds positions,
 * polygons, and half-edges) and returns the **new selection set** so the caller
 * can update `state.editSelection.indices`.
 *
 * V2 (quad / n-gon): operators work on the polygon list (`toPolygons` /
 * `rebuildPolygons`), so pass-through faces keep their arity and the
 * geometry-producing operators emit REAL quads (extrude skirts, inset skirts,
 * bevel chamfers, edge fins, bridge bands, quad loop cuts). Operators whose
 * math is inherently triangle-based (bevel fan splitting, Flip Diagonal,
 * implicit-quad loop cut walking) keep their triangle requirement and skip /
 * reject n-gon neighborhoods explicitly.
 *
 * Why rebuild instead of incremental mutation? For forge3d's mesh sizes
 * (~hundreds to a few thousand faces) the O(F) rebuild dominated by the
 * operator's own work is fast enough, and it sidesteps a whole class of
 * stale-twin / stale-next bugs that production half-edge libraries spend most
 * of their complexity defending against (see Blender BMesh).
 */

/**
 * Delete the selected faces. Vertices and edges that become orphaned by the
 * removal are left in place — Blender calls this "Faces Only". A follow-up
 * Phase 3.5 pass can add "Faces + Edges + Verts" if isolated geometry becomes
 * a real nuisance.
 *
 * Returns an empty set: the selection target is gone.
 */
export function deleteFaces(em: EditMesh, selectedFaces: ReadonlySet<number>): Set<number> {
  if (selectedFaces.size === 0) return new Set();

  const polys = toPolygons(em);
  const kept: number[][] = [];
  for (let f = 0; f < polys.length; f++) {
    if (!selectedFaces.has(f)) kept.push(polys[f]!);
  }
  rebuildPolygons(em, em.positions, kept);
  return new Set();
}

/**
 * Extrude the selected face set.
 *
 * Algorithm:
 *  1. Find the boundary of the selection — half-edges whose face is selected
 *     but whose twin's face is not (or twin is missing).
 *  2. Every vertex incident to a selected face is duplicated (even interior
 *     verts) so the selection becomes a fully-disconnected "cap" that can
 *     slide freely without dragging the rest of the mesh.
 *  3. Rewrite selected faces' polygons to use the duplicates (arity kept).
 *  4. For each boundary edge a→b (CCW inside the selected face), emit ONE
 *     skirt quad (a, b, b', a') so the mesh stays closed.
 *  5. Unselected faces are emitted unchanged.
 *
 * Returns the new face IDs for the extruded cap so the gizmo immediately picks
 * up the just-created geometry.
 */
export function extrudeFaces(em: EditMesh, selectedFaces: ReadonlySet<number>): Set<number> {
  if (selectedFaces.size === 0) return new Set();

  const polys = toPolygons(em);
  const numOldV = em.vertices.length;

  // 1. Collect vertices that appear in any selected face — these all get
  //    duplicated. (Even interior verts: see the cap-disconnection note above.)
  const dupSource = new Set<number>();
  for (const f of selectedFaces) {
    for (const v of polys[f]!) dupSource.add(v);
  }

  // 2. Allocate duplicates: dupMap[oldVertId] = newVertId (or -1 if not duplicated).
  const dupMap = new Int32Array(numOldV);
  dupMap.fill(-1);
  const newPositions: number[] = Array.from(em.positions);
  let nextV = numOldV;
  for (const v of dupSource) {
    dupMap[v] = nextV++;
    newPositions.push(
      em.positions[v * 3]!,
      em.positions[v * 3 + 1]!,
      em.positions[v * 3 + 2]!,
    );
  }

  // 3. Emit order: unselected faces, skirt quads, then the duplicated caps —
  //    tracking the cap start yields the new selection ids.
  const newPolys: number[][] = [];
  for (let f = 0; f < polys.length; f++) {
    if (!selectedFaces.has(f)) newPolys.push(polys[f]!);
  }

  // 4. Skirt quads: walk every half-edge of every selected face, emit a quad
  //    on boundary edges (twin missing or twin's face not selected).
  for (const f of selectedFaces) {
    for (const h of faceHalfEdges(em, f)) {
      const he = em.halfEdges[h]!;
      const twin = he.twin;
      const isBoundary = twin < 0 || !selectedFaces.has(em.halfEdges[twin]!.face);
      if (!isBoundary) continue;
      const a = he.v;
      const b = em.halfEdges[he.next]!.v;
      // Outward-facing quad (a, b on the unselected side; dups on the cap).
      newPolys.push([a, b, dupMap[b]!, dupMap[a]!]);
    }
  }

  // 5. Caps with duplicate refs — these become the new selection.
  const newSelStart = newPolys.length;
  for (const f of selectedFaces) {
    newPolys.push(polys[f]!.map((v) => dupMap[v]!));
  }
  const newSelEnd = newPolys.length;

  rebuildPolygons(em, new Float32Array(newPositions), newPolys);

  const newSel = new Set<number>();
  for (let i = newSelStart; i < newSelEnd; i++) newSel.add(i);
  return newSel;
}

/**
 * Delete all faces incident to any vertex in `selectedVerts`. The vertex's
 * Half-Edge entry is left in place — orphan verts are visible as floating
 * dots, mirroring Blender's "Vertices" delete which leaves stray verts when
 * `Delete Loose` isn't run after.
 *
 * V1 simplification: we do not remove the vertex from the position buffer.
 * Removing it would force every face index above the deleted vert to shift,
 * which is doable but adds remapping logic without a clear V1 payoff.
 */
export function deleteFacesByVertices(em: EditMesh, selectedVerts: ReadonlySet<number>): Set<number> {
  if (selectedVerts.size === 0) return new Set();
  const facesToDrop = new Set<number>();
  for (let f = 0; f < em.faces.length; f++) {
    for (const v of faceVerts(em, f)) {
      if (selectedVerts.has(v)) { facesToDrop.add(f); break; }
    }
  }
  return deleteFaces(em, facesToDrop);
}

/** Delete the (up to two) faces adjacent to each selected edge. */
export function deleteFacesByEdges(em: EditMesh, selectedEdges: ReadonlySet<number>): Set<number> {
  if (selectedEdges.size === 0) return new Set();
  const facesToDrop = new Set<number>();
  for (const he of selectedEdges) {
    facesToDrop.add(em.halfEdges[he]!.face);
    const twin = em.halfEdges[he]!.twin;
    if (twin >= 0) facesToDrop.add(em.halfEdges[twin]!.face);
  }
  return deleteFaces(em, facesToDrop);
}

/**
 * Inset each selected face individually (Blender's "Individual Faces" inset).
 *
 * For each face (any arity), duplicate its vertices, move each duplicate
 * toward the face centroid by `amount` (0 = no inset, 1 = collapse to
 * centroid), and stitch a skirt of quads connecting the original boundary to
 * the new smaller face. The inner cap keeps the face's arity.
 *
 * "Individual" rather than "Region" mode because individual handles arbitrary
 * face selections (including disconnected, L-shaped, or wrap-around groups)
 * with a single uniform algorithm. Region inset would need average-plane
 * projection and a boundary walk — saved for Phase 4.5.
 *
 * Returns the new face IDs (the inner shrunk faces), so the gizmo lands on
 * the inset cap and the next press of E extrudes those — the canonical
 * "boss / button" workflow.
 */
export function insetFaces(em: EditMesh, selectedFaces: ReadonlySet<number>, amount: number): Set<number> {
  if (selectedFaces.size === 0 || amount <= 0) return new Set(selectedFaces);

  const polys = toPolygons(em);
  const newPositions: number[] = Array.from(em.positions);
  let nextV = em.vertices.length;

  // Faces emit in this order: unselected (unchanged), skirts, inner caps.
  const newPolys: number[][] = [];
  for (let f = 0; f < polys.length; f++) {
    if (!selectedFaces.has(f)) newPolys.push(polys[f]!);
  }

  // Per-face: compute centroid, allocate duplicates, remember cap rings.
  type CapInfo = { orig: number[]; dups: number[] };
  const caps: CapInfo[] = [];

  for (const f of selectedFaces) {
    const verts = polys[f]!;
    let gx = 0, gy = 0, gz = 0;
    for (const v of verts) {
      gx += em.positions[v * 3]!;
      gy += em.positions[v * 3 + 1]!;
      gz += em.positions[v * 3 + 2]!;
    }
    gx /= verts.length; gy /= verts.length; gz /= verts.length;

    const t = amount;
    const dups = verts.map((v) => {
      const x = em.positions[v * 3]!, y = em.positions[v * 3 + 1]!, z = em.positions[v * 3 + 2]!;
      const d = nextV++;
      newPositions.push(x + (gx - x) * t, y + (gy - y) * t, z + (gz - z) * t);
      return d;
    });
    caps.push({ orig: verts, dups });
  }

  // Skirts: each original edge vᵢ→vᵢ₊₁ becomes a (vᵢ, vᵢ₊₁, dupᵢ₊₁, dupᵢ) quad.
  // The face's original normal direction is preserved (CCW from outside).
  for (const { orig, dups } of caps) {
    for (let i = 0; i < orig.length; i++) {
      const j = (i + 1) % orig.length;
      newPolys.push([orig[i]!, orig[j]!, dups[j]!, dups[i]!]);
    }
  }

  // Caps (inner shrunk faces) — become the new selection.
  const capStart = newPolys.length;
  for (const { dups } of caps) newPolys.push(dups);
  const capEnd = newPolys.length;

  rebuildPolygons(em, new Float32Array(newPositions), newPolys);

  const newSel = new Set<number>();
  for (let i = capStart; i < capEnd; i++) newSel.add(i);
  return newSel;
}

/**
 * Bevel selected edges by splitting each endpoint's vertex fan and stitching
 * a chamfer quad + per-endpoint corner tri caps.
 *
 * The full algorithm — what V1 punted on:
 *
 *  For each beveled edge e = (a, b) with F1 (face holding e) and F2 (face
 *  holding twin), the vertex a is replaced by two new vertices a1 (positioned
 *  along edge a-x where x is F1's off-edge vertex) and a2 (along edge a-y, y
 *  in F2). Same for b. The fan around a is then sliced into two arcs by
 *  TWO splits:
 *
 *    1. The bevel-edge split (between F1 and F2 — these are always adjacent
 *       in the fan since they share edge a-b)
 *    2. An IMPLICIT split — diametrically opposite to the bevel edge in the
 *       fan cycle. The two faces straddling this split share an off-axis
 *       vertex `capX`; a tri cap (a1, a2, capX) seals the gap.
 *
 *  Faces in the "F1 arc" of the fan get their `a` reference remapped to a1;
 *  faces in the "F2 arc" get a2. The arcs are chosen by halving the
 *  intermediates between F1 and F2 going around the long way.
 *
 *  Chamfer winding is CCW-from-outside = (a1, a2, b2, b1) — emitted as a REAL
 *  quad in V2 — giving the four border edges:
 *    a1→a2 (left, at vertex a)   pairs with cap-a's a2→a1
 *    a2→b2 (bottom, F2-side)     pairs with F2's b2→a2
 *    b2→b1 (right, at vertex b)  pairs with cap-b's b1→b2
 *    b1→a1 (top, F1-side)        pairs with F1's a1→b1
 *
 *  Corner cap windings differ at the two endpoints because the chamfer's
 *  border at a (a1→a2, downward) needs the opposite (a2→a1) in the cap, while
 *  at b (b2→b1, upward) the cap needs b1→b2.
 *
 * V2 restrictions (kept):
 *  - At most 1 selected bevel edge per vertex. Two bevels meeting at one
 *    vertex would split the fan into 4+ arcs and chain multiple cap polygons
 *    together (Blender's "branch" case). That's mechanically possible but
 *    materially more code; deferred to V3.
 *  - Fan must be closed (no boundary in the fan around a beveled vertex).
 *  - The two faces holding the bevel edge (F1 / F2) must be triangles — the
 *    slide-toward-third-vertex math is triangle-specific. Edges whose F1/F2
 *    is a quad / n-gon are skipped (reported via `outInfo.skipped`). Other
 *    faces in the fans may be any arity (their corner refs are just remapped).
 */
export function bevelEdges(
  em: EditMesh,
  selectedEdges: ReadonlySet<number>,
  width: number,
  outInfo?: { skipped: number },
): Set<number> {
  if (selectedEdges.size === 0 || width <= 0) return new Set(selectedEdges);

  // Canonicalize selection (always work with min(he, twin)).
  const all = new Set<number>();
  for (const he of selectedEdges) {
    const t = em.halfEdges[he]!.twin;
    if (t < 0) continue; // boundary bevel edge — skip (no F2 to chamfer against)
    all.add(he < t ? he : t);
  }
  if (all.size === 0) return new Set();

  // Drop edges whose holding faces aren't triangles (see V2 restrictions).
  const triOk = new Set<number>();
  for (const he of all) {
    const f1 = em.halfEdges[he]!.face;
    const f2 = em.halfEdges[em.halfEdges[he]!.twin]!.face;
    if (faceVertexCount(em, f1) === 3 && faceVertexCount(em, f2) === 3) triOk.add(he);
  }

  // V2 isolation constraint: each endpoint vertex may host at most one bevel.
  // Selecting a whole edge loop (the most common bevel gesture) violates this
  // for every vertex, and the old all-or-nothing guard silently no-opped.
  // Instead keep a greedy maximal subset with disjoint endpoints and bevel
  // that — an alternating half of a loop — and report how many were skipped
  // so the caller can tell the user to repeat for the rest.
  const usedVerts = new Set<number>();
  const canonical = new Set<number>();
  for (const he of triOk) {
    const a = edgeOrigin(em, he);
    const b = edgeEnd(em, he);
    if (usedVerts.has(a) || usedVerts.has(b)) continue;
    usedVerts.add(a);
    usedVerts.add(b);
    canonical.add(he);
  }
  if (outInfo) outInfo.skipped = all.size - canonical.size;
  if (canonical.size === 0) return new Set();

  const t01 = Math.max(0.001, Math.min(0.49, width));

  type FanInfo = {
    role: "origin" | "destination";
    v1Pos: [number, number, number];
    v2Pos: [number, number, number];
    v1Idx: number;
    v2Idx: number;
    arcF1: Set<number>;
    arcF2: Set<number>;
    capX: number; // -1 when the fan has no intermediates (size = 2)
  };

  const vertInfo = new Map<number, FanInfo>();
  const bevels: Array<{ a: number; b: number; f1: number; f2: number }> = [];

  for (const he of canonical) {
    const a = edgeOrigin(em, he);
    const b = edgeEnd(em, he);
    const twin = em.halfEdges[he]!.twin;
    const f1 = em.halfEdges[he]!.face;
    const f2 = em.halfEdges[twin]!.face;
    const x = thirdVertex(em, f1, a, b);
    const y = thirdVertex(em, f2, a, b);
    if (x < 0 || y < 0) return new Set();

    const infoA = computeFanInfo(em, a, f1, f2, x, y, t01, "origin");
    const infoB = computeFanInfo(em, b, f1, f2, x, y, t01, "destination");
    if (!infoA || !infoB) return new Set();

    vertInfo.set(a, infoA);
    vertInfo.set(b, infoB);
    bevels.push({ a, b, f1, f2 });
  }

  // Allocate new vertex indices and append positions.
  const newPositions: number[] = Array.from(em.positions);
  let nextV = em.vertices.length;
  for (const info of vertInfo.values()) {
    info.v1Idx = nextV++;
    newPositions.push(info.v1Pos[0], info.v1Pos[1], info.v1Pos[2]);
    info.v2Idx = nextV++;
    newPositions.push(info.v2Pos[0], info.v2Pos[1], info.v2Pos[2]);
  }

  // Remap every face's vertices according to the per-vertex arc assignment.
  const remap = (v: number, f: number): number => {
    const info = vertInfo.get(v);
    if (!info) return v;
    if (info.arcF1.has(f)) return info.v1Idx;
    if (info.arcF2.has(f)) return info.v2Idx;
    return v; // face not in either arc — leave it (shouldn't happen)
  };

  const polys = toPolygons(em);
  const newPolys: number[][] = [];
  for (let f = 0; f < polys.length; f++) {
    newPolys.push(polys[f]!.map((v) => remap(v, f)));
  }

  // Emit chamfer quads (these are the new selection).
  const chamferStart = newPolys.length;
  for (const { a, b } of bevels) {
    const ia = vertInfo.get(a)!;
    const ib = vertInfo.get(b)!;
    // CCW from outside: one real quad (a1, a2, b2, b1).
    newPolys.push([ia.v1Idx, ia.v2Idx, ib.v2Idx, ib.v1Idx]);
  }
  const chamferEnd = newPolys.length;

  // Emit corner caps. Winding differs by endpoint role:
  //   origin (vertex a):      cap CCW = (v2, v1, capX)
  //   destination (vertex b): cap CCW = (v1, v2, capX)
  for (const info of vertInfo.values()) {
    if (info.capX < 0) continue;
    if (info.role === "origin") {
      newPolys.push([info.v2Idx, info.v1Idx, info.capX]);
    } else {
      newPolys.push([info.v1Idx, info.v2Idx, info.capX]);
    }
  }

  rebuildPolygons(em, new Float32Array(newPositions), newPolys);

  const newSel = new Set<number>();
  for (let i = chamferStart; i < chamferEnd; i++) newSel.add(i);
  return newSel;
}

// ── Bevel helpers ──────────────────────────────────────────────────────────

/**
 * Compute fan info for a vertex `v` belonging to a bevel with F1/F2.
 * Returns null if the fan is open (boundary) or otherwise unsupported.
 *
 * Fan walking: CCW around `v` via `twin.next`. F1 and F2 are always adjacent
 * in the fan (they share the bevel edge), so exactly one of the two CCW arcs
 * (F1→F2 or F2→F1) is empty. The non-empty arc gets halved to place the
 * implicit split.
 */
function computeFanInfo(
  em: EditMesh,
  v: number,
  f1: number,
  f2: number,
  x: number,
  y: number,
  w: number,
  role: "origin" | "destination",
): { role: "origin" | "destination"; v1Pos: [number, number, number]; v2Pos: [number, number, number]; v1Idx: number; v2Idx: number; arcF1: Set<number>; arcF2: Set<number>; capX: number } | null {
  const walk = walkFanFull(em, v, f1);
  if (!walk) return null;
  const { fan, closed } = walk;
  const f1idx = fan.indexOf(f1);
  const f2idx = fan.indexOf(f2);
  if (f1idx < 0 || f2idx < 0) return null;

  const v1Pos = lerpPos(em, v, x, w);
  const v2Pos = lerpPos(em, v, y, w);
  const arcF1 = new Set<number>([f1]);
  const arcF2 = new Set<number>([f2]);
  let capX = -1;

  if (!closed) {
    // Open fan: v lies on the mesh boundary. F1 and F2 must be adjacent
    // (they share the bevel edge); the fan splits at the bevel edge into two
    // contiguous arcs that each terminate at a mesh boundary. No implicit
    // split — boundaries already seal the open ends.
    if (Math.abs(f1idx - f2idx) !== 1) return null;
    if (f1idx < f2idx) {
      for (let i = 0; i <= f1idx; i++) arcF1.add(fan[i]!);
      for (let i = f2idx; i < fan.length; i++) arcF2.add(fan[i]!);
    } else {
      for (let i = 0; i <= f2idx; i++) arcF2.add(fan[i]!);
      for (let i = f1idx; i < fan.length; i++) arcF1.add(fan[i]!);
    }
    return { role, v1Pos, v2Pos, v1Idx: -1, v2Idx: -1, arcF1, arcF2, capX };
  }

  // Closed fan: F1 sits at index 0 (we started the CCW walk from it).
  // ccwArcA: intermediates strictly between F1 and F2 (CCW from F1).
  // ccwArcB: intermediates strictly between F2 and F1 (CCW from F2).
  const ccwArcA = fan.slice(1, f2idx);
  const ccwArcB = fan.slice(f2idx + 1);

  if (ccwArcA.length === 0 && ccwArcB.length === 0) {
    // Fan size 2 — fully closed but with no intermediates. No cap.
    return { role, v1Pos, v2Pos, v1Idx: -1, v2Idx: -1, arcF1, arcF2, capX };
  }

  let intermediates: number[];
  let firstHalfArc: Set<number>;
  let secondHalfArc: Set<number>;
  let bracketLeft: number;
  let bracketRight: number;

  if (ccwArcA.length > 0 && ccwArcB.length === 0) {
    intermediates = ccwArcA;
    firstHalfArc = arcF1;
    secondHalfArc = arcF2;
    bracketLeft = f1;
    bracketRight = f2;
  } else if (ccwArcB.length > 0 && ccwArcA.length === 0) {
    intermediates = ccwArcB;
    firstHalfArc = arcF2;
    secondHalfArc = arcF1;
    bracketLeft = f2;
    bracketRight = f1;
  } else {
    return null;
  }

  const half = Math.floor(intermediates.length / 2);
  for (let i = 0; i < half; i++) firstHalfArc.add(intermediates[i]!);
  for (let i = half; i < intermediates.length; i++) secondHalfArc.add(intermediates[i]!);

  const left = half > 0 ? intermediates[half - 1]! : bracketLeft;
  const right = half < intermediates.length ? intermediates[half]! : bracketRight;
  capX = sharedNonVertex(em, left, right, v);

  if (capX < 0) return null;
  return { role, v1Pos, v2Pos, v1Idx: -1, v2Idx: -1, arcF1, arcF2, capX };
}

/**
 * Walk the fan around vertex `v` starting from `startFace`. Returns the fan
 * in CCW order with a flag indicating whether the fan is a closed cycle.
 *
 * For closed fans, the walk goes CCW only — the cycle returns to startFace.
 * For open fans (v on a mesh boundary), the walk goes CCW AND CW separately;
 * the results are concatenated as `[…cw.reverse(), startFace, …ccw]` so the
 * full open fan is presented in CCW order.
 */
function walkFanFull(em: EditMesh, v: number, startFace: number): { fan: number[]; closed: boolean } | null {
  const start = findOutgoing(em, v, startFace);
  if (start < 0) return null;

  const ccw: number[] = [];
  let cur = start;
  let guard = 0;
  let closed = false;
  while (guard++ < 1024) {
    const tw = em.halfEdges[cur]!.twin;
    if (tw < 0) break;
    const nextOutgoing = em.halfEdges[tw]!.next;
    const nextFace = em.halfEdges[nextOutgoing]!.face;
    if (nextFace === startFace) { closed = true; break; }
    ccw.push(nextFace);
    cur = nextOutgoing;
  }

  if (closed) {
    return { fan: [startFace, ...ccw], closed: true };
  }

  // Open fan — finish the other direction.
  const cw: number[] = [];
  cur = start;
  guard = 0;
  while (guard++ < 1024) {
    // Predecessor half-edge of `cur` within its face (arity-agnostic walk).
    const prevInFace = prevHalfEdge(em, cur);
    const tw = em.halfEdges[prevInFace]!.twin;
    if (tw < 0) break;
    cw.push(em.halfEdges[tw]!.face);
    cur = tw;
  }

  return { fan: [...cw.reverse(), startFace, ...ccw], closed: false };
}

/** Predecessor of `he` in its face cycle (the half-edge whose `next` is `he`). */
function prevHalfEdge(em: EditMesh, he: number): number {
  let h = he;
  let guard = 0;
  while (em.halfEdges[h]!.next !== he && guard++ < 4096) h = em.halfEdges[h]!.next;
  return h;
}

/** Find the half-edge in `face` whose origin is `v`. */
function findOutgoing(em: EditMesh, v: number, face: number): number {
  for (const h of faceHalfEdges(em, face)) {
    if (em.halfEdges[h]!.v === v) return h;
  }
  return -1;
}

function thirdVertex(em: EditMesh, f: number, a: number, b: number): number {
  const [v0, v1, v2] = faceVertices(em, f);
  for (const v of [v0, v1, v2]) if (v !== a && v !== b) return v;
  return -1;
}

function sharedNonVertex(em: EditMesh, fA: number, fB: number, excluding: number): number {
  const setA = new Set(faceVerts(em, fA));
  for (const v of faceVerts(em, fB)) {
    if (setA.has(v) && v !== excluding) return v;
  }
  return -1;
}

function lerpPos(em: EditMesh, from: number, to: number, t: number): [number, number, number] {
  const fx = em.positions[from * 3]!, fy = em.positions[from * 3 + 1]!, fz = em.positions[from * 3 + 2]!;
  const tx = em.positions[to * 3]!, ty = em.positions[to * 3 + 1]!, tz = em.positions[to * 3 + 2]!;
  return [fx + (tx - fx) * t, fy + (ty - fy) * t, fz + (tz - fz) * t];
}

// ── Loop Cut ───────────────────────────────────────────────────────────────

/**
 * Cut an edge loop starting from `seedEdge`.
 *
 * V2 walking rules, per face entered through an edge:
 *  - REAL quad → exit through the opposite edge; the quad is later cut into
 *    two quads by the midpoint-to-midpoint edge (quad flow preserved).
 *  - Triangle → treat the pair of near-coplanar triangles as an implicit quad
 *    (V1 behavior): exit through the partner's off-diagonal edge and
 *    re-triangulate the pair around the cut (4 tris).
 *  - Any other arity (n-gon ≥5) → the loop stops there.
 *
 * Faces adjacent to loop edges but not crossed by the loop get their edge
 * midpoints stitched in: triangles use the classic 1-edge / 2-edge / 3-edge
 * splits, n-gons keep a single polygon with the midpoints inserted into the
 * cycle (no T-vertices either way).
 *
 * Returns the set of new midpoint vertex IDs (caller flips selection mode to
 * "vertex" so the user can immediately drag the new ring with the gizmo).
 *
 * Limitations (kept from V1):
 *   - Coplanarity threshold for the tri-pair walk is fixed (cos ≥ 0.7 ≈ 45°).
 *     Sharp creases break loop continuity, which is usually correct intent.
 *   - If two consecutive loop edges happen to live in the same triangle (a
 *     degenerate quad), that tri is split into 3 instead of re-triangulated
 *     as a real quad.
 */
export function loopCut(em: EditMesh, seedEdge: number): Set<number> {
  const twin = em.halfEdges[seedEdge]?.twin ?? -1;
  if (twin < 0) return new Set(); // boundary — no loop possible

  const seedCanonical = canonicalEdge(em, seedEdge);
  const loop = findEdgeLoop(em, seedCanonical);
  if (loop.length === 0) return new Set();

  // Insert one midpoint per loop edge.
  const newPositions: number[] = Array.from(em.positions);
  let nextV = em.vertices.length;
  const midpointOf = new Map<number, number>(); // canonical edge → midpoint vert id
  const midOfPair = new Map<string, number>();  // "vMin_vMax" → midpoint vert id
  for (const e of loop) {
    const a = edgeOrigin(em, e);
    const b = edgeEnd(em, e);
    const mid = nextV++;
    const [mx, my, mz] = lerpPos(em, a, b, 0.5);
    newPositions.push(mx, my, mz);
    midpointOf.set(e, mid);
    midOfPair.set(seamKey(a, b), mid);
  }

  // Group consecutive loop edges into crossings. Each pair (loop[i],
  // loop[i+1]) either lies on one polygon face (poly crossing) or straddles
  // two coplanar triangles (implicit-quad crossing).
  type PolyCut = { kind: "poly"; f: number; eEntry: number; eExit: number };
  type TriPairCut = { kind: "tripair"; f1: number; f2: number; eEntry: number; eExit: number };
  const crossByFace = new Map<number, PolyCut | TriPairCut>();
  for (let i = 0; i < loop.length; i++) {
    const e1 = loop[i]!;
    const e2 = loop[(i + 1) % loop.length]!;
    // Stop at the wrap-around if loop is open (i.e., the last "next" doesn't
    // come back to the seed). For closed loops this still works because both
    // e1 and e2 are real loop edges sharing a face.
    if (e1 === e2) continue;
    const shared = sharedFaceBetweenEdges(em, e1, e2);
    if (shared < 0 || crossByFace.has(shared)) continue;
    if (faceVertexCount(em, shared) > 3) {
      crossByFace.set(shared, { kind: "poly", f: shared, eEntry: e1, eExit: e2 });
      continue;
    }
    const partner = quadPartnerOfFaceCrossing(em, shared, e1, e2);
    if (partner < 0 || faceVertexCount(em, partner) !== 3) continue;
    if (crossByFace.has(partner)) continue;
    const cut: TriPairCut = { kind: "tripair", f1: shared, f2: partner, eEntry: e1, eExit: e2 };
    crossByFace.set(shared, cut);
    crossByFace.set(partner, cut);
  }

  // Emit the new polygon list.
  const newPolys: number[][] = [];
  for (let f = 0; f < em.faces.length; f++) {
    const cross = crossByFace.get(f);
    if (cross && cross.kind === "tripair") {
      if (f === cross.f1) emitQuadCut(em, cross, midpointOf, newPolys);
      continue; // f2 handled together with f1
    }

    const verts = faceVerts(em, f);
    // Augmented cycle: original corners with loop midpoints inserted after
    // the origin of each split edge.
    const aug: number[] = [];
    let midCount = 0;
    for (let i = 0; i < verts.length; i++) {
      aug.push(verts[i]!);
      const mid = midOfPair.get(seamKey(verts[i]!, verts[(i + 1) % verts.length]!));
      if (mid !== undefined) { aug.push(mid); midCount++; }
    }

    if (midCount === 0) {
      newPolys.push(verts); // untouched face
      continue;
    }

    if (cross && cross.kind === "poly") {
      // Cut the augmented cycle at the entry/exit midpoints → two polygons.
      // A crossed quad yields two quads (quad flow preserved).
      const mE = midpointOf.get(cross.eEntry)!;
      const mX = midpointOf.get(cross.eExit)!;
      const iE = aug.indexOf(mE);
      const iX = aug.indexOf(mX);
      if (iE >= 0 && iX >= 0 && iE !== iX) {
        const p1 = cycleSlice(aug, iE, iX);
        const p2 = cycleSlice(aug, iX, iE);
        if (p1.length >= 3 && p2.length >= 3) {
          newPolys.push(p1, p2);
          continue;
        }
      }
      // Inconsistent crossing — fall through to the generic handling below.
    }

    if (verts.length === 3) {
      emitTriSplits(em, f, midpointOf, newPolys);
    } else {
      // n-gon touched by the loop but not crossed: keep one polygon with the
      // midpoints stitched into its cycle so neighbors stay watertight.
      newPolys.push(aug);
    }
  }

  rebuildPolygons(em, new Float32Array(newPositions), newPolys);
  return new Set(midpointOf.values());
}

/** Inclusive cyclic slice aug[from..to] (wrapping). */
function cycleSlice(aug: readonly number[], from: number, to: number): number[] {
  const out: number[] = [];
  for (let k = from; ; k = (k + 1) % aug.length) {
    out.push(aug[k]!);
    if (k === to) break;
  }
  return out;
}

/**
 * Walk the edge loop in both directions from `seedEdge`. Returns loop edges
 * in CCW order if closed; in walk order otherwise. Returns just `[seedEdge]`
 * if both directions fail to extend (degenerate seed).
 */
function findEdgeLoop(em: EditMesh, seedEdge: number): number[] {
  const forward = walkLoopDirection(em, seedEdge, em.halfEdges[seedEdge]!.face);
  const backward = walkLoopDirection(em, seedEdge, em.halfEdges[em.halfEdges[seedEdge]!.twin]!.face);

  // Forward stops when revisits seedEdge (closed) or hits boundary (open).
  if (forward.closed) return forward.edges;
  // Open chain: combine backward (reversed, dropping the seed) + forward.
  const back = backward.edges.slice(1).reverse();
  return [...back, ...forward.edges];
}

function walkLoopDirection(em: EditMesh, seedEdge: number, startIncomingFace: number): { edges: number[]; closed: boolean } {
  const edges: number[] = [seedEdge];
  const visited = new Set<number>([seedEdge]);
  let cur = seedEdge;
  let incoming = startIncomingFace;
  let guard = 0;
  while (guard++ < 4096) {
    const step = nextLoopEdge(em, cur, incoming);
    if (!step) return { edges, closed: false };
    if (step.nextEdge === seedEdge) return { edges, closed: true };
    if (visited.has(step.nextEdge)) return { edges, closed: false };
    visited.add(step.nextEdge);
    edges.push(step.nextEdge);
    cur = step.nextEdge;
    incoming = step.partnerFace;
  }
  return { edges, closed: false };
}

/**
 * From canonical edge `cur` entered via `incomingFace`, find the next edge in
 * the loop.
 *
 * Outgoing face = the OTHER face adjacent to `cur`:
 *  - Quad → the opposite edge of the quad (2 steps around the cycle);
 *    `partnerFace` is the quad itself.
 *  - Triangle → V1 implicit-quad rule: pick the tri's "quad partner" — the
 *    neighbor across the edge whose face normal is most coplanar — and exit
 *    through the partner's edge not touching `cur`.
 *  - Other arity → null (loop stops).
 */
function nextLoopEdge(em: EditMesh, cur: number, incomingFace: number): { nextEdge: number; partnerFace: number } | null {
  const twin = em.halfEdges[cur]!.twin;
  if (twin < 0) return null;
  const f1 = em.halfEdges[cur]!.face;
  const f2 = em.halfEdges[twin]!.face;
  const outgoingFace = f1 === incomingFace ? f2 : f1;

  const outHEs = faceHalfEdges(em, outgoingFace);

  if (outHEs.length === 4) {
    // Real quad: exit through the opposite edge.
    const curHE = outHEs.find((h) => canonicalEdge(em, h) === cur);
    if (curHE === undefined) return null;
    const exitHE = em.halfEdges[em.halfEdges[curHE]!.next]!.next;
    return { nextEdge: canonicalEdge(em, exitHE), partnerFace: outgoingFace };
  }
  if (outHEs.length !== 3) return null; // n-gon ≥5 — stop the loop

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
    const dot = dot3(outNormal, neighborNormal);
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
      return { nextEdge: canonicalEdge(em, ph), partnerFace };
    }
  }
  return null;
}

function sharedFaceBetweenEdges(em: EditMesh, e1: number, e2: number): number {
  const e1Faces = new Set<number>();
  const t1 = em.halfEdges[e1]!.twin;
  e1Faces.add(em.halfEdges[e1]!.face);
  if (t1 >= 0) e1Faces.add(em.halfEdges[t1]!.face);
  const e2Faces: number[] = [em.halfEdges[e2]!.face];
  const t2 = em.halfEdges[e2]!.twin;
  if (t2 >= 0) e2Faces.push(em.halfEdges[t2]!.face);
  for (const f of e2Faces) if (e1Faces.has(f)) return f;
  return -1;
}

/**
 * Given `entryFace` (a triangle containing `e1`), return its quad partner =
 * the most coplanar TRIANGLE neighbor NOT adjacent to e1/e2 (the diagonal
 * partner).
 */
function quadPartnerOfFaceCrossing(em: EditMesh, entryFace: number, e1: number, e2: number): number {
  const myNormal = facePolyNormal(em, entryFace);
  let best = -1;
  let bestDot = 0.7;
  for (const h of faceHalfEdges(em, entryFace)) {
    const can = canonicalEdge(em, h);
    if (can === e1 || can === e2) continue;
    const t = em.halfEdges[h]!.twin;
    if (t < 0) continue;
    const neighbor = em.halfEdges[t]!.face;
    if (faceVertexCount(em, neighbor) !== 3) continue;
    const nNormal = facePolyNormal(em, neighbor);
    const dot = dot3(myNormal, nNormal);
    if (dot > bestDot) {
      bestDot = dot;
      best = neighbor;
    }
  }
  return best;
}

/**
 * Re-triangulate one implicit quad (two coplanar tris) into 4 tris with a cut
 * edge running from the midpoint of `eEntry` to the midpoint of `eExit`.
 *
 * The implicit quad has 4 verts: 2 on eEntry (a, b), 1 in entryFace not on
 * either loop edge, 1 in partnerFace likewise. Corner pairing (which eExit
 * endpoint sits next to a vs b in the quad cycle) is read from partnerFace's
 * CCW order. Triangulation: split along the cut edge mEntry-mExit, then
 * triangulate each half:
 *   Half 1 (a side): (a, mEntry, mExit) + (a, mExit, cornerA)
 *   Half 2 (b side): (mEntry, b, cornerB) + (mEntry, cornerB, mExit)
 */
function emitQuadCut(em: EditMesh, qc: { f1: number; f2: number; eEntry: number; eExit: number }, midpointOf: Map<number, number>, out: number[][]): void {
  const mEntry = midpointOf.get(qc.eEntry)!;
  const mExit = midpointOf.get(qc.eExit)!;
  const a = edgeOrigin(em, qc.eEntry);
  const b = edgeEnd(em, qc.eEntry);
  const eExitV0 = edgeOrigin(em, qc.eExit);
  const eExitV1 = edgeEnd(em, qc.eExit);

  // Determine cornerA, cornerB by checking partnerFace's CCW order — the
  // vertex coming AFTER b in the quad cycle = cornerB; before a = cornerA.
  let cornerA = -1, cornerB = -1;
  for (const ph of faceHalfEdges(em, qc.f2)) {
    const ov = em.halfEdges[ph]!.v;
    const ev = em.halfEdges[em.halfEdges[ph]!.next]!.v;
    if ((ov === eExitV0 && ev === eExitV1) || (ov === eExitV1 && ev === eExitV0)) {
      // This half-edge IS eExit (in partnerFace's CCW order). The half-edge
      // after it ends at partnerFace's remaining vertex, which is `a` or `b`.
      const after = em.halfEdges[ph]!.next;
      const afterEndVert = em.halfEdges[em.halfEdges[after]!.next]!.v;
      if (afterEndVert === a) { cornerA = ev; cornerB = ov; }
      else if (afterEndVert === b) { cornerB = ov; cornerA = ev; }
      break;
    }
  }
  if (cornerA < 0 || cornerB < 0) {
    // Fallback: arbitrarily assign; visually wrong but topologically valid.
    cornerA = eExitV0; cornerB = eExitV1;
  }

  out.push([a, mEntry, mExit]);
  out.push([a, mExit, cornerA]);
  out.push([mEntry, b, cornerB]);
  out.push([mEntry, cornerB, mExit]);
}

/** Split one triangle face according to how many of its edges carry loop midpoints. */
function emitTriSplits(em: EditMesh, f: number, midpointOf: Map<number, number>, out: number[][]): void {
  const [h0, h1, h2] = faceHalfEdges(em, f) as [number, number, number];
  const subdivHE: number[] = [];
  for (const h of [h0, h1, h2]) {
    if (midpointOf.has(canonicalEdge(em, h))) subdivHE.push(h);
  }
  if (subdivHE.length === 0) {
    out.push([em.halfEdges[h0]!.v, em.halfEdges[h1]!.v, em.halfEdges[h2]!.v]);
  } else if (subdivHE.length === 1) {
    emitTriSplit1(em, subdivHE[0]!, midpointOf, out);
  } else if (subdivHE.length === 2) {
    emitTriSplit2(em, h0, h1, h2, subdivHE, midpointOf, out);
  } else {
    emitTriSplit3(em, h0, h1, h2, midpointOf, out);
  }
}

/** 1 selected edge in a tri — fan to off-edge vertex. */
function emitTriSplit1(em: EditMesh, subdivHE: number, midpointOf: Map<number, number>, out: number[][]): void {
  const mid = midpointOf.get(canonicalEdge(em, subdivHE))!;
  const a = em.halfEdges[subdivHE]!.v;
  const nxt = em.halfEdges[subdivHE]!.next;
  const b = em.halfEdges[nxt]!.v;
  const c = em.halfEdges[em.halfEdges[nxt]!.next]!.v;
  out.push([a, mid, c]);
  out.push([mid, b, c]);
}

/** 2 selected edges in a tri — split into 3 tris with a midpoint-to-midpoint cut. */
function emitTriSplit2(em: EditMesh, h0: number, h1: number, h2: number, subdivHE: number[], midpointOf: Map<number, number>, out: number[][]): void {
  // Identify the un-subdivided edge: this anchors the "third vertex" position.
  const subdivSet = new Set(subdivHE);
  const otherHE = [h0, h1, h2].find((h) => !subdivSet.has(h));
  if (otherHE === undefined) return;
  // tri = (v[h0], v[h1], v[h2]) CCW. The non-subdivided edge has its two
  // endpoints "untouched"; the third vertex is the one OPPOSITE to it,
  // through which both subdivided edges pass.
  const u = em.halfEdges[otherHE]!.v;
  const v = em.halfEdges[em.halfEdges[otherHE]!.next]!.v;
  const allV = [em.halfEdges[h0]!.v, em.halfEdges[h1]!.v, em.halfEdges[h2]!.v];
  const w = allV.find((x) => x !== u && x !== v)!;

  // Midpoints: M_uw on edge u-w, M_vw on edge v-w.
  let mUW = -1, mVW = -1;
  for (const h of subdivHE) {
    const va = em.halfEdges[h]!.v;
    const vb = em.halfEdges[em.halfEdges[h]!.next]!.v;
    const can = canonicalEdge(em, h);
    if ((va === u && vb === w) || (va === w && vb === u)) mUW = midpointOf.get(can)!;
    if ((va === v && vb === w) || (va === w && vb === v)) mVW = midpointOf.get(can)!;
  }
  if (mUW < 0 || mVW < 0) return;

  // CCW tris:
  //   (u, v, mVW)   — bottom (the un-subdivided base + cut endpoint at v's side)
  //   (u, mVW, mUW) — the "cut triangle" interior
  //   (mUW, mVW, w) — the cap at vertex w
  out.push([u, v, mVW]);
  out.push([u, mVW, mUW]);
  out.push([mUW, mVW, w]);
}

/** 3 selected edges in a tri — classic 1→4 subdivision. */
function emitTriSplit3(em: EditMesh, h0: number, h1: number, h2: number, midpointOf: Map<number, number>, out: number[][]): void {
  const a = em.halfEdges[h0]!.v;
  const b = em.halfEdges[h1]!.v;
  const c = em.halfEdges[h2]!.v;
  const mAB = midpointOf.get(canonicalEdge(em, h0))!;
  const mBC = midpointOf.get(canonicalEdge(em, h1))!;
  const mCA = midpointOf.get(canonicalEdge(em, h2))!;
  out.push([a, mAB, mCA]);
  out.push([mAB, b, mBC]);
  out.push([mBC, c, mCA]);
  out.push([mAB, mBC, mCA]);
}

function dot3(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

// ── Edge Extrude ───────────────────────────────────────────────────────────

/**
 * Extrude selected edges into "fin" quads.
 *
 * For each selected edge a-b, duplicates both endpoints (a → a', b → b') and
 * emits ONE fin quad (a, a', b', b) attached to the edge from the F1-side, so
 * the fin's twin half-edge (b→a) pairs cleanly with F1's a→b.
 *
 * Vertex dedup: when two selected edges share a vertex, the shared vertex's
 * duplicate is allocated once. Selecting an edge loop and extruding produces
 * a connected manifold "skirt" of fins.
 *
 * Behavior by edge type:
 *  - Boundary edge: fin seals the boundary on one side (F1's side); the fin's
 *    outer perimeter becomes the new boundary.
 *  - Interior edge: results in a non-manifold edge (3 faces). Acceptable for
 *    silhouette / fin geometry — same as Blender's behavior. The fin's
 *    half-edge wins the twin slot via the rebuild's last-write-wins.
 *
 * Returns the fin face IDs as the new selection (caller flips mode to "face"
 * so the gizmo lands on the fins for the inevitable "now drag them" step).
 */
export function extrudeEdges(em: EditMesh, selectedEdges: ReadonlySet<number>): Set<number> {
  if (selectedEdges.size === 0) return new Set();

  // Canonicalize. Boundary edges (twin = -1) are kept as-is — they're valid
  // extrude targets and using `he` directly (since min(he, -1) would be -1).
  const canonical = new Set<number>();
  for (const he of selectedEdges) {
    const t = em.halfEdges[he]!.twin;
    if (t < 0) canonical.add(he);
    else canonical.add(he < t ? he : t);
  }
  if (canonical.size === 0) return new Set();

  const newPositions: number[] = Array.from(em.positions);
  let nextV = em.vertices.length;
  const vertDup = new Map<number, number>();
  const dupOrCreate = (v: number): number => {
    let d = vertDup.get(v);
    if (d === undefined) {
      d = nextV++;
      vertDup.set(v, d);
      newPositions.push(em.positions[v * 3]!, em.positions[v * 3 + 1]!, em.positions[v * 3 + 2]!);
    }
    return d;
  };

  const newPolys = toPolygons(em);
  const finStart = newPolys.length;
  for (const he of canonical) {
    const a = edgeOrigin(em, he);
    const b = edgeEnd(em, he);
    const aDup = dupOrCreate(a);
    const bDup = dupOrCreate(b);
    // Fin quad — CCW from the fin's outside, with the b→a edge pairing as
    // twin to F1's existing a→b.
    newPolys.push([a, aDup, bDup, b]);
  }
  const finEnd = newPolys.length;

  rebuildPolygons(em, new Float32Array(newPositions), newPolys);

  const newSel = new Set<number>();
  for (let i = finStart; i < finEnd; i++) newSel.add(i);
  return newSel;
}

// ── Flip Diagonal (two selected vertices, tri-only) ────────────────────────

/**
 * Connect 2 selected vertices with a new edge — handles only the "adjacent
 * tri" case where the verts are the two "off-edge" vertices of two TRIANGLES
 * sharing an edge. The operation is then a diagonal flip: the shared edge a-b
 * is replaced by v1-v2. Quad / n-gon faces are skipped (quads have no
 * diagonal to flip — use Quads to Tris first if you need one).
 *
 * Returns the (unchanged) input vert set so the user's selection persists
 * across the operation; the new edge is visible in the edge overlay since
 * the topology rebuild repopulates the line buffer.
 */
export function knife(em: EditMesh, selectedVerts: ReadonlySet<number>): Set<number> {
  if (selectedVerts.size !== 2) return new Set();
  const [v1, v2] = [...selectedVerts];
  if (v1 === undefined || v2 === undefined) return new Set();

  // Search triangles containing v1; for each, check whether its edges' twin
  // faces contain v2.
  for (let f = 0; f < em.faces.length; f++) {
    if (faceVertexCount(em, f) !== 3) continue;
    const verts = faceVertices(em, f);
    if (!verts.includes(v1) || verts.includes(v2)) continue;

    for (const h of faceHalfEdges(em, f)) {
      const va = em.halfEdges[h]!.v;
      const vb = em.halfEdges[em.halfEdges[h]!.next]!.v;
      // Find the edge OPPOSITE v1 in this tri (the one not touching v1).
      if (va === v1 || vb === v1) continue;
      const tw = em.halfEdges[h]!.twin;
      if (tw < 0) continue;
      const neighborFace = em.halfEdges[tw]!.face;
      if (faceVertexCount(em, neighborFace) !== 3) continue;
      if (!faceVertices(em, neighborFace).includes(v2)) continue;
      return flipDiagonal(em, h, v1, v2);
    }
  }
  return new Set();
}

/**
 * Flip the diagonal `edgeHE` (in face f1) so that the two tris (f1, f2)
 * sharing this edge get re-triangulated with the c-d diagonal instead, where
 * c = f1's 3rd vertex, d = f2's 3rd vertex.
 *
 * Winding worked out from a 2D example (quad ABCD with diagonal A-C →
 * diagonal B-D):
 *   T1' = (b, c, d), T2' = (c, a, d).
 *
 * (Both new tris keep outward normals pairing correctly with the surrounding
 * mesh's twins.)
 */
function flipDiagonal(em: EditMesh, edgeHE: number, v1: number, v2: number): Set<number> {
  const a = em.halfEdges[edgeHE]!.v;
  const eNext = em.halfEdges[edgeHE]!.next;
  const b = em.halfEdges[eNext]!.v;
  const c = em.halfEdges[em.halfEdges[eNext]!.next]!.v;

  const twin = em.halfEdges[edgeHE]!.twin;
  const tNext = em.halfEdges[twin]!.next;
  const d = em.halfEdges[em.halfEdges[tNext]!.next]!.v;

  // Sanity: {c, d} must be {v1, v2}.
  if (!((c === v1 && d === v2) || (c === v2 && d === v1))) return new Set();

  const f1 = em.halfEdges[edgeHE]!.face;
  const f2 = em.halfEdges[twin]!.face;

  const polys = toPolygons(em);
  const newPolys: number[][] = [];
  for (let f = 0; f < polys.length; f++) {
    if (f === f1) newPolys.push([b, c, d]);
    else if (f === f2) newPolys.push([c, a, d]);
    else newPolys.push(polys[f]!);
  }

  rebuildPolygons(em, em.positions, newPolys);
  return new Set([v1, v2]);
}

// ── Edge Slide (F-M8) ──────────────────────────────────────────────────────

/**
 * Slide the selected edge loop along its adjacent "rail" edges — Blender's
 * Edge Slide, the essential follow-up to Loop Cut ("place the new ring where
 * I actually want it").
 *
 * `t` ∈ [-1, 1]: the sign picks the side, the magnitude is the interpolation
 * factor toward that side's rail neighbor (1 = all the way onto it). Sides
 * are derived per loop component from a consistent walk order (tangent ×
 * vertex normal), so one invocation slides the whole loop coherently even
 * around curved surfaces.
 *
 * Topology is unchanged — only positions move. A vertex with no rail on the
 * requested side (mesh border, pole) stays put. Rail choice per side is the
 * neighbor whose edge is most perpendicular to the loop tangent, which
 * filters out the diagonal neighbors triangulated quads introduce. (On real
 * quads there are no diagonals, so the rails are simply the ring edges.)
 *
 * Returns the (canonicalized) input edge set — still valid, nothing rebuilt.
 */
export function edgeSlide(em: EditMesh, selectedEdges: ReadonlySet<number>, t: number): Set<number> {
  const canonical = new Set<number>();
  for (const he of selectedEdges) canonical.add(canonicalEdge(em, he));
  if (canonical.size === 0 || t === 0) return canonical;

  const P = em.positions;

  // Loop vertex set + adjacency INSIDE the loop.
  const loopVerts = new Set<number>();
  const loopAdj = new Map<number, number[]>();
  const addAdj = (a: number, b: number): void => {
    let l = loopAdj.get(a);
    if (!l) { l = []; loopAdj.set(a, l); }
    if (!l.includes(b)) l.push(b);
  };
  for (const he of canonical) {
    const a = edgeOrigin(em, he);
    const b = edgeEnd(em, he);
    loopVerts.add(a);
    loopVerts.add(b);
    addAdj(a, b);
    addAdj(b, a);
  }

  // Full neighbor map (unique undirected edges).
  const neighbors = new Map<number, Set<number>>();
  const nbOf = (v: number): Set<number> => {
    let s = neighbors.get(v);
    if (!s) { s = new Set(); neighbors.set(v, s); }
    return s;
  };
  for (let i = 0; i < em.halfEdges.length; i++) {
    const tw = em.halfEdges[i]!.twin;
    if (tw >= 0 && i > tw) continue;
    const a = edgeOrigin(em, i);
    const b = edgeEnd(em, i);
    nbOf(a).add(b);
    nbOf(b).add(a);
  }

  // Accumulated vertex normals (loop verts only) from incident face normals.
  // Newell's method — area-weighted like the V1 cross products, n-gon safe.
  const vn = new Map<number, [number, number, number]>();
  for (let f = 0; f < em.faces.length; f++) {
    const fv = faceVerts(em, f);
    let touches = false;
    for (const v of fv) { if (loopVerts.has(v)) { touches = true; break; } }
    if (!touches) continue;
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < fv.length; i++) {
      const a = fv[i]!;
      const b = fv[(i + 1) % fv.length]!;
      const ax = P[a * 3]!, ay = P[a * 3 + 1]!, az = P[a * 3 + 2]!;
      const bx = P[b * 3]!, by = P[b * 3 + 1]!, bz = P[b * 3 + 2]!;
      nx += (ay - by) * (az + bz);
      ny += (az - bz) * (ax + bx);
      nz += (ax - bx) * (ay + by);
    }
    for (const v of fv) {
      if (!loopVerts.has(v)) continue;
      const acc = vn.get(v) ?? [0, 0, 0];
      acc[0] += nx; acc[1] += ny; acc[2] += nz;
      vn.set(v, acc);
    }
  }

  const newPos = new Float32Array(P);
  const factor = Math.min(1, Math.abs(t));

  // Walk each connected loop component so tangents share one orientation.
  const visited = new Set<number>();
  for (const seed of loopVerts) {
    if (visited.has(seed)) continue;

    // Gather the component, then order it from an endpoint (or anywhere on
    // a cycle) by walking unvisited loop neighbors.
    const comp: number[] = [];
    const stack = [seed];
    visited.add(seed);
    while (stack.length) {
      const v = stack.pop()!;
      comp.push(v);
      for (const u of loopAdj.get(v) ?? []) {
        if (!visited.has(u)) { visited.add(u); stack.push(u); }
      }
    }
    const start = comp.find((v) => (loopAdj.get(v) ?? []).length === 1) ?? comp[0]!;
    const order: number[] = [start];
    const inOrder = new Set([start]);
    let cur = start;
    for (;;) {
      const nxt = (loopAdj.get(cur) ?? []).find((u) => !inOrder.has(u));
      if (nxt === undefined) break;
      order.push(nxt);
      inOrder.add(nxt);
      cur = nxt;
    }
    const isCycle =
      order.length > 2 && (loopAdj.get(order[order.length - 1]!) ?? []).includes(start);

    for (let i = 0; i < order.length; i++) {
      const v = order[i]!;
      const prev = i > 0 ? order[i - 1]! : isCycle ? order[order.length - 1]! : v;
      const next = i < order.length - 1 ? order[i + 1]! : isCycle ? order[0]! : v;

      // Loop tangent at v (walk-oriented so the whole component agrees).
      let tx = P[next * 3]! - P[prev * 3]!;
      let ty = P[next * 3 + 1]! - P[prev * 3 + 1]!;
      let tz = P[next * 3 + 2]! - P[prev * 3 + 2]!;
      const tl = Math.hypot(tx, ty, tz);
      if (tl < 1e-12) continue;
      tx /= tl; ty /= tl; tz /= tl;

      const n = vn.get(v);
      if (!n) continue;
      const nl = Math.hypot(n[0], n[1], n[2]);
      if (nl < 1e-12) continue;

      // Side axis = tangent × normal (in-surface, perpendicular to the loop).
      let sx = ty * (n[2] / nl) - tz * (n[1] / nl);
      let sy = tz * (n[0] / nl) - tx * (n[2] / nl);
      let sz = tx * (n[1] / nl) - ty * (n[0] / nl);
      const sl = Math.hypot(sx, sy, sz);
      if (sl < 1e-12) continue;
      sx /= sl; sy /= sl; sz /= sl;

      // Rails: off-loop neighbors, most-perpendicular one per side.
      let railPos = -1, railPosDot = Infinity;
      let railNeg = -1, railNegDot = Infinity;
      for (const u of nbOf(v)) {
        if (loopVerts.has(u)) continue;
        let dx = P[u * 3]! - P[v * 3]!;
        let dy = P[u * 3 + 1]! - P[v * 3 + 1]!;
        let dz = P[u * 3 + 2]! - P[v * 3 + 2]!;
        const dl = Math.hypot(dx, dy, dz);
        if (dl < 1e-12) continue;
        dx /= dl; dy /= dl; dz /= dl;
        const alongLoop = Math.abs(dx * tx + dy * ty + dz * tz);
        const side = dx * sx + dy * sy + dz * sz;
        if (side > 1e-6) {
          if (alongLoop < railPosDot) { railPosDot = alongLoop; railPos = u; }
        } else if (side < -1e-6) {
          if (alongLoop < railNegDot) { railNegDot = alongLoop; railNeg = u; }
        }
      }

      const target = t > 0 ? railPos : railNeg;
      if (target < 0) continue;
      newPos[v * 3] = P[v * 3]! + (P[target * 3]! - P[v * 3]!) * factor;
      newPos[v * 3 + 1] = P[v * 3 + 1]! + (P[target * 3 + 1]! - P[v * 3 + 1]!) * factor;
      newPos[v * 3 + 2] = P[v * 3 + 2]! + (P[target * 3 + 2]! - P[v * 3 + 2]!) * factor;
    }
  }

  em.positions.set(newPos);
  return canonical;
}

// ── Merge / Collapse (F-M8) ────────────────────────────────────────────────

/**
 * Merge vertex clusters: each cluster's members become ONE vertex at the
 * cluster centroid. Faces whose cycle collapses below 3 unique verts are
 * dropped; a quad losing one edge to the merge degrades to a triangle
 * (consecutive duplicate corners are collapsed). The vertex buffer is
 * compacted (unreferenced verts removed), and seam keys are remapped across
 * the compaction.
 *
 * Returns the merged vertices' NEW (compacted) indices.
 */
function mergeClusters(em: EditMesh, clusters: number[][]): Set<number> {
  const P = em.positions;
  const remap = new Map<number, number>();
  const targets: number[] = [];

  for (const cluster of clusters) {
    if (cluster.length < 2) continue;
    const target = Math.min(...cluster);
    targets.push(target);
    let cx = 0, cy = 0, cz = 0;
    for (const v of cluster) {
      cx += P[v * 3]!;
      cy += P[v * 3 + 1]!;
      cz += P[v * 3 + 2]!;
    }
    for (const v of cluster) remap.set(v, target);
    P[target * 3] = cx / cluster.length;
    P[target * 3 + 1] = cy / cluster.length;
    P[target * 3 + 2] = cz / cluster.length;
  }
  if (targets.length === 0) return new Set();

  const mapped = (v: number): number => remap.get(v) ?? v;

  // Rewrite faces: collapse consecutive duplicate corners, drop faces that
  // degenerate (<3 unique verts) or fold onto themselves (repeated corner).
  const keptPolys: number[][] = [];
  const polys = toPolygons(em);
  for (const poly of polys) {
    const mappedPoly = poly.map(mapped);
    const dedup: number[] = [];
    for (const v of mappedPoly) {
      if (dedup.length === 0 || dedup[dedup.length - 1] !== v) dedup.push(v);
    }
    while (dedup.length > 1 && dedup[0] === dedup[dedup.length - 1]) dedup.pop();
    if (dedup.length < 3) continue;
    if (new Set(dedup).size !== dedup.length) continue; // bowtie — drop
    keptPolys.push(dedup);
  }

  // Compact the vertex buffer to referenced verts only.
  const oldToNew = new Map<number, number>();
  const newPositions: number[] = [];
  const idxOf = (v: number): number => {
    let nv = oldToNew.get(v);
    if (nv === undefined) {
      nv = newPositions.length / 3;
      oldToNew.set(v, nv);
      newPositions.push(P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!);
    }
    return nv;
  };
  const newPolys = keptPolys.map((poly) => poly.map(idxOf));

  // Seams follow the merge + compaction; edges collapsed to a point vanish.
  const newSeams = new Set<string>();
  for (const key of em.seams) {
    const [a, b] = key.split("_").map(Number);
    const na = oldToNew.get(mapped(a!));
    const nb = oldToNew.get(mapped(b!));
    if (na !== undefined && nb !== undefined && na !== nb) newSeams.add(seamKey(na, nb));
  }

  rebuildPolygons(em, Float32Array.from(newPositions), newPolys);
  em.seams = newSeams;

  const out = new Set<number>();
  for (const tgt of targets) {
    const nv = oldToNew.get(tgt);
    if (nv !== undefined) out.add(nv);
  }
  return out;
}

/**
 * Merge every selected vertex into one point at their centroid — Blender's
 * "Merge At Center". Needs ≥2 selected verts. Returns the merged vertex's
 * new index (∅ when the merge produced no usable geometry).
 */
export function mergeAtCenter(em: EditMesh, selectedVerts: ReadonlySet<number>): Set<number> {
  if (selectedVerts.size < 2) return new Set();
  return mergeClusters(em, [[...selectedVerts]]);
}

/**
 * Collapse each selected edge to its midpoint (Blender's Edge Collapse).
 * Edges sharing endpoints collapse together — union-find groups them into
 * clusters first, so collapsing a connected run of edges yields one vertex.
 */
export function collapseEdges(em: EditMesh, selectedEdges: ReadonlySet<number>): Set<number> {
  if (selectedEdges.size === 0) return new Set();

  const parent = new Map<number, number>();
  const find = (v: number): number => {
    let r = v;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(v, r);
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const heRaw of selectedEdges) {
    const he = canonicalEdge(em, heRaw);
    const a = edgeOrigin(em, he);
    const b = edgeEnd(em, he);
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    union(a, b);
  }

  const byRoot = new Map<number, number[]>();
  for (const v of parent.keys()) {
    const r = find(v);
    let l = byRoot.get(r);
    if (!l) { l = []; byRoot.set(r, l); }
    l.push(v);
  }
  return mergeClusters(em, [...byRoot.values()]);
}

// ── Bridge Edge Loops (F-M8) ───────────────────────────────────────────────

/**
 * Connect two boundary edge loops with a band of REAL quads — Blender's
 * Bridge Edge Loops, V1 scope:
 *
 * - Both loops must be **boundary** loops (every selected edge has no twin);
 *   bridging interior loops would need face deletion first.
 * - The selection must split into exactly 2 connected loops with the SAME
 *   vertex count, both cycles or both open paths.
 *
 * Winding: each new quad traverses the A-side boundary edge reversed and the
 * B loop in reverse walk order, so every new face pairs manifold-cleanly
 * with the existing faces (and B's reversal also gives the geometrically
 * right pairing for two openings that face each other, e.g. tube ends). For
 * cycles, the rotation offset minimizing the first vertex pair's distance is
 * chosen so the band doesn't twist.
 *
 * Returns the new face ids (∅ on any precondition failure).
 */
export function bridgeEdgeLoops(em: EditMesh, selectedEdges: ReadonlySet<number>): Set<number> {
  // Directed boundary edges a→b straight from the half-edges.
  const dirEdges: Array<[number, number]> = [];
  for (const heRaw of selectedEdges) {
    const he = canonicalEdge(em, heRaw);
    if (em.halfEdges[he]!.twin >= 0) return new Set(); // interior edge — unsupported
    dirEdges.push([edgeOrigin(em, he), edgeEnd(em, he)]);
  }
  if (dirEdges.length < 2) return new Set();

  // Split into connected components (union-find on endpoints).
  const parent = new Map<number, number>();
  const find = (v: number): number => {
    let r = v;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(v, r);
    return r;
  };
  for (const [a, b] of dirEdges) {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map<number, Array<[number, number]>>();
  for (const e of dirEdges) {
    const r = find(e[0]);
    let l = groups.get(r);
    if (!l) { l = []; groups.set(r, l); }
    l.push(e);
  }
  if (groups.size !== 2) return new Set();

  /** Order a group's directed edges into a vertex walk. Null when branched. */
  const orderLoop = (edges: Array<[number, number]>): { verts: number[]; cycle: boolean } | null => {
    const next = new Map<number, number>();
    const hasIn = new Set<number>();
    for (const [a, b] of edges) {
      if (next.has(a)) return null; // branching — not a simple loop
      next.set(a, b);
      hasIn.add(b);
    }
    let start = -1;
    for (const a of next.keys()) {
      if (!hasIn.has(a)) { start = a; break; }
    }
    const cycle = start === -1;
    if (cycle) start = next.keys().next().value!;
    const verts: number[] = [start];
    let cur = start;
    for (let guard = 0; guard <= edges.length; guard++) {
      const nxt = next.get(cur);
      if (nxt === undefined) break;
      if (nxt === start) return { verts, cycle: true };
      verts.push(nxt);
      cur = nxt;
    }
    if (cycle) return null; // never closed — branched cycle
    return verts.length === edges.length + 1 ? { verts, cycle: false } : null;
  };

  const [gA, gB] = [...groups.values()];
  const A = orderLoop(gA!);
  const B = orderLoop(gB!);
  if (!A || !B || A.cycle !== B.cycle || A.verts.length !== B.verts.length) return new Set();

  const n = A.verts.length;
  const P = em.positions;
  const bRev = [...B.verts].reverse();

  // Cycle: rotate B so its first paired vertex is nearest A's first.
  let off = 0;
  if (A.cycle) {
    const a0 = A.verts[0]!;
    let best = Infinity;
    for (let k = 0; k < n; k++) {
      const b = bRev[k]!;
      const dx = P[a0 * 3]! - P[b * 3]!;
      const dy = P[a0 * 3 + 1]! - P[b * 3 + 1]!;
      const dz = P[a0 * 3 + 2]! - P[b * 3 + 2]!;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < best) { best = d; off = k; }
    }
  }

  const newPolys = toPolygons(em);
  const faceStart = newPolys.length;
  const quads = A.cycle ? n : n - 1;
  for (let i = 0; i < quads; i++) {
    const a0 = A.verts[i]!;
    const a1 = A.verts[(i + 1) % n]!;
    const b0 = bRev[(off + i) % n]!;
    const b1 = bRev[(off + i + 1) % n]!;
    // Quad (a1, a0, b0, b1): crosses A's boundary edge reversed (a1→a0) and
    // B's boundary edge reversed (b0→b1 in reverse walk) — both manifold.
    newPolys.push([a1, a0, b0, b1]);
  }

  rebuildPolygons(em, em.positions, newPolys);
  const out = new Set<number>();
  for (let f = faceStart; f < newPolys.length; f++) out.add(f);
  return out;
}

// ── Vertex Slide (F-M8) ────────────────────────────────────────────────────

/**
 * Slide `mover` along its shared edge with `anchor` — Blender's Vertex Slide
 * (Shift+V) adapted to the slider workflow: select the anchor first, the vert
 * to move second, then apply.
 *
 * `t` ∈ [-1, 1]: positive interpolates `mover` toward `anchor` (1 = onto it),
 * negative extrapolates away from `anchor` along the same edge line. Topology
 * is unchanged — only `mover`'s position is written.
 *
 * Returns `{mover}` on success, empty set when the two verts don't share an
 * edge (nothing written).
 */
export function vertexSlide(em: EditMesh, anchor: number, mover: number, t: number): Set<number> {
  if (anchor === mover) return new Set();
  let adjacent = false;
  for (let i = 0; i < em.halfEdges.length && !adjacent; i++) {
    const a = edgeOrigin(em, i);
    const b = edgeEnd(em, i);
    adjacent = (a === anchor && b === mover) || (a === mover && b === anchor);
  }
  if (!adjacent) return new Set();

  const P = em.positions;
  const f = Math.max(-1, Math.min(1, t));
  P[mover * 3] = P[mover * 3]! + (P[anchor * 3]! - P[mover * 3]!) * f;
  P[mover * 3 + 1] = P[mover * 3 + 1]! + (P[anchor * 3 + 1]! - P[mover * 3 + 1]!) * f;
  P[mover * 3 + 2] = P[mover * 3 + 2]! + (P[anchor * 3 + 2]! - P[mover * 3 + 2]!) * f;
  return new Set([mover]);
}

// ── Tris to Quads / Quads to Tris (half-edge V2) ───────────────────────────

/**
 * Join adjacent triangle pairs into quads — Blender's Tris to Quads.
 *
 * Candidate = every interior edge whose two faces are both triangles (and
 * inside `selectedFaces` when given). A pair qualifies when the face normals
 * agree within `maxAngleDeg` AND the resulting quad is convex. Candidates are
 * greedily merged **best shape first**: primary key = corner-angle deviation
 * from 90° (rectangles win), tie-break = normal alignment. On a uniformly
 * triangulated grid every cell diagonal scores 0 error while the cross-cell
 * "diamond" pairs score high, so the grid merges into clean axis-aligned
 * quads instead of a zigzag (pre-shape-scoring behavior depended on edge
 * iteration order). Each triangle is used at most once.
 *
 * Quad winding: for shared edge a→b (in tri1) with off-edge verts x (tri1)
 * and y (tri2), the merged CCW cycle is (b, x, a, y) — both source windings
 * are preserved.
 *
 * Returns the new quad face ids (∅ when nothing merged).
 */
export function trisToQuads(
  em: EditMesh,
  selectedFaces: ReadonlySet<number> | null,
  maxAngleDeg = 40,
): Set<number> {
  const cosLimit = Math.cos((maxAngleDeg * Math.PI) / 180);
  const inScope = (f: number): boolean =>
    faceVertexCount(em, f) === 3 && (!selectedFaces || selectedFaces.has(f));

  type Cand = { f1: number; f2: number; err: number; dot: number; quad: number[] };
  const cands: Cand[] = [];
  forEachEdge(em, (he) => {
    const t = em.halfEdges[he]!.twin;
    if (t < 0) return;
    const f1 = em.halfEdges[he]!.face;
    const f2 = em.halfEdges[t]!.face;
    if (!inScope(f1) || !inScope(f2)) return;
    const n1 = facePolyNormal(em, f1);
    const n2 = facePolyNormal(em, f2);
    const dot = dot3(n1, n2);
    if (dot < cosLimit) return;
    const a = edgeOrigin(em, he);
    const b = edgeEnd(em, he);
    const x = thirdVertex(em, f1, a, b);
    const y = thirdVertex(em, f2, a, b);
    if (x < 0 || y < 0 || x === y) return;
    const quad = [b, x, a, y];
    if (!isConvexQuad(em.positions, quad)) return;
    cands.push({ f1, f2, err: quadAngleError(em.positions, quad), dot, quad });
  });
  if (cands.length === 0) return new Set();
  cands.sort((p, q) => (p.err - q.err) || (q.dot - p.dot));

  const used = new Set<number>();
  const merged: number[][] = [];
  for (const c of cands) {
    if (used.has(c.f1) || used.has(c.f2)) continue;
    used.add(c.f1);
    used.add(c.f2);
    merged.push(c.quad);
  }
  if (merged.length === 0) return new Set();

  const polys = toPolygons(em);
  const newPolys: number[][] = [];
  for (let f = 0; f < polys.length; f++) {
    if (!used.has(f)) newPolys.push(polys[f]!);
  }
  const quadStart = newPolys.length;
  for (const quad of merged) newPolys.push(quad);
  rebuildPolygons(em, em.positions, newPolys);

  const out = new Set<number>();
  for (let f = quadStart; f < newPolys.length; f++) out.add(f);
  return out;
}

/**
 * Shape-quality metric for a candidate quad: total corner-angle deviation
 * from 90° (radians). 0 = perfect rectangle; a "diamond" pairing across two
 * grid cells scores ~π/3 per corner. Degenerate corners count as worst-case.
 */
function quadAngleError(P: Float32Array, quad: readonly number[]): number {
  let err = 0;
  for (let i = 0; i < 4; i++) {
    const p0 = quad[(i + 3) % 4]!;
    const p1 = quad[i]!;
    const p2 = quad[(i + 1) % 4]!;
    const ux = P[p0 * 3]! - P[p1 * 3]!;
    const uy = P[p0 * 3 + 1]! - P[p1 * 3 + 1]!;
    const uz = P[p0 * 3 + 2]! - P[p1 * 3 + 2]!;
    const vx = P[p2 * 3]! - P[p1 * 3]!;
    const vy = P[p2 * 3 + 1]! - P[p1 * 3 + 1]!;
    const vz = P[p2 * 3 + 2]! - P[p1 * 3 + 2]!;
    const lu = Math.hypot(ux, uy, uz);
    const lv = Math.hypot(vx, vy, vz);
    if (lu < 1e-12 || lv < 1e-12) { err += Math.PI / 2; continue; }
    const cos = Math.max(-1, Math.min(1, (ux * vx + uy * vy + uz * vz) / (lu * lv)));
    err += Math.abs(Math.acos(cos) - Math.PI / 2);
  }
  return err;
}

/** Convexity test: every corner turn agrees with the quad's Newell normal. */
function isConvexQuad(P: Float32Array, quad: readonly number[]): boolean {
  // Newell normal over the 4 corners.
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i]!;
    const b = quad[(i + 1) % 4]!;
    const ax = P[a * 3]!, ay = P[a * 3 + 1]!, az = P[a * 3 + 2]!;
    const bx = P[b * 3]!, by = P[b * 3 + 1]!, bz = P[b * 3 + 2]!;
    nx += (ay - by) * (az + bz);
    ny += (az - bz) * (ax + bx);
    nz += (ax - bx) * (ay + by);
  }
  const nlen = Math.hypot(nx, ny, nz);
  if (nlen < 1e-12) return false;

  for (let i = 0; i < 4; i++) {
    const p0 = quad[i]!;
    const p1 = quad[(i + 1) % 4]!;
    const p2 = quad[(i + 2) % 4]!;
    const e1x = P[p1 * 3]! - P[p0 * 3]!;
    const e1y = P[p1 * 3 + 1]! - P[p0 * 3 + 1]!;
    const e1z = P[p1 * 3 + 2]! - P[p0 * 3 + 2]!;
    const e2x = P[p2 * 3]! - P[p1 * 3]!;
    const e2y = P[p2 * 3 + 1]! - P[p1 * 3 + 1]!;
    const e2z = P[p2 * 3 + 2]! - P[p1 * 3 + 2]!;
    const cx = e1y * e2z - e1z * e2y;
    const cy = e1z * e2x - e1x * e2z;
    const cz = e1x * e2y - e1y * e2x;
    const d = cx * nx + cy * ny + cz * nz;
    const scale = Math.hypot(e1x, e1y, e1z) * Math.hypot(e2x, e2y, e2z) * nlen;
    if (d <= scale * 1e-6) return false; // reflex or degenerate corner
  }
  return true;
}

/**
 * Catmull-Clark subdivision surface — smooth `level` (≥1) steps over the WHOLE
 * mesh (the operator is global by nature: every face turns into n quads and
 * the surface relaxes toward the limit surface, so a partial selection would
 * leave T-vertices at the boundary). Delegates the math to
 * {@link catmullClark}; here we just rebuild `em` and return an empty
 * selection (component ids are all fresh — the caller clears the selection).
 *
 * Original vertices keep their indices (0…V-1) so their UVs / skin weights are
 * carried verbatim by commitTopology; the new face/edge points sample the old
 * surface via barycentric transfer. Morph targets can't survive the vertex-
 * count change — the caller must guard.
 */
export function subdivideCatmullClark(em: EditMesh, level: number): Set<number> {
  if (level < 1) return new Set();
  const result = catmullClark(em.positions, toPolygons(em), level, em.creases);
  rebuildPolygons(em, result.positions, result.polys);
  // Carry the propagated (σ−1) creases onto the subdivided edges. Seams are
  // dropped — their vertex-pair keys no longer name real edges after the split.
  em.creases = result.creases;
  return new Set();
}

/**
 * Fan-triangulate the selected quad / n-gon faces (whole mesh when
 * `selectedFaces` is null) — Blender's Triangulate Faces. Triangle faces are
 * left untouched. Returns the new triangle face ids (∅ when nothing had to
 * be triangulated).
 */
export function quadsToTris(em: EditMesh, selectedFaces: ReadonlySet<number> | null): Set<number> {
  const polys = toPolygons(em);
  const targetSet = new Set<number>();
  for (let f = 0; f < polys.length; f++) {
    if (polys[f]!.length > 3 && (!selectedFaces || selectedFaces.has(f))) targetSet.add(f);
  }
  if (targetSet.size === 0) return new Set();

  const newPolys: number[][] = [];
  for (let f = 0; f < polys.length; f++) {
    if (!targetSet.has(f)) newPolys.push(polys[f]!);
  }
  const triStart = newPolys.length;
  for (const f of targetSet) {
    const p = polys[f]!;
    for (let i = 1; i + 1 < p.length; i++) newPolys.push([p[0]!, p[i]!, p[i + 1]!]);
  }
  rebuildPolygons(em, em.positions, newPolys);

  const out = new Set<number>();
  for (let f = triStart; f < newPolys.length; f++) out.add(f);
  return out;
}

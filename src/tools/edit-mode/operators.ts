import { canonicalEdge, edgeEnd, edgeOrigin, faceVertices, rebuildHalfEdges, toIndexArray, type EditMesh } from "./half-edge";

/**
 * Topology operators. Each operator mutates `em` in place (rebuilds positions,
 * indices, and half-edges) and returns the **new selection set** so the caller
 * can update `state.editSelection.indices`.
 *
 * Why rebuild instead of incremental mutation? For forge3d's mesh sizes
 * (~hundreds to a few thousand triangles) the O(F) rebuild dominated by the
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

  const oldIndices = toIndexArray(em);
  const newIndices: number[] = [];
  for (let f = 0; f < em.faces.length; f++) {
    if (selectedFaces.has(f)) continue;
    newIndices.push(oldIndices[f * 3]!, oldIndices[f * 3 + 1]!, oldIndices[f * 3 + 2]!);
  }
  rebuildHalfEdges(em, em.positions, newIndices);
  return new Set();
}

/**
 * Extrude the selected face set.
 *
 * Algorithm:
 *  1. Find the boundary of the selection — half-edges whose face is selected
 *     but whose twin's face is not (or twin is missing).
 *  2. For every vertex incident to at least one selected face AND at least one
 *     non-selected face (or a boundary), duplicate it. Interior vertices
 *     (all incident faces selected) are also duplicated so the selection
 *     becomes a fully-disconnected "cap" that can slide freely without
 *     dragging the rest of the mesh.
 *  3. Rewrite selected faces' indices to use the duplicates.
 *  4. For each boundary edge a→b (CCW inside the selected face), emit two
 *     skirt triangles connecting (a, b, b', a') so the mesh stays closed.
 *  5. Unselected faces are emitted unchanged.
 *
 * The new selection = the indices of the duplicated faces in the rebuilt mesh
 * (their order follows the original selected-face order, appended after all
 * the unchanged faces — see emit order below).
 *
 * Returns the new face IDs for the extruded cap so the gizmo immediately picks
 * up the just-created geometry.
 */
export function extrudeFaces(em: EditMesh, selectedFaces: ReadonlySet<number>): Set<number> {
  if (selectedFaces.size === 0) return new Set();

  const oldIndices = toIndexArray(em);
  const numOldV = em.vertices.length;

  // 1. Collect vertices that appear in any selected face — these all get
  //    duplicated. (Even interior verts: see the cap-disconnection note above.)
  const dupSource = new Set<number>();
  for (const f of selectedFaces) {
    const [a, b, c] = faceVertices(em, f);
    dupSource.add(a); dupSource.add(b); dupSource.add(c);
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

  // 3. Build the new index list:
  //    - Unselected faces first (positions in result = original face order minus selected)
  //    - Skirt triangles next
  //    - Selected faces (now pointing at the duplicates) last
  //    Tracking the selected-face start lets us return their new IDs as the
  //    new selection.
  const newIndices: number[] = [];

  for (let f = 0; f < em.faces.length; f++) {
    if (selectedFaces.has(f)) continue;
    newIndices.push(oldIndices[f * 3]!, oldIndices[f * 3 + 1]!, oldIndices[f * 3 + 2]!);
  }

  // 4. Skirt edges: walk every half-edge of every selected face, emit a quad
  //    on boundary edges (twin missing or twin's face not selected).
  for (const f of selectedFaces) {
    const h0 = em.faces[f]!.he;
    const h1 = em.halfEdges[h0]!.next;
    const h2 = em.halfEdges[h1]!.next;
    for (const h of [h0, h1, h2]) {
      const he = em.halfEdges[h]!;
      const twin = he.twin;
      const isBoundary = twin < 0 || !selectedFaces.has(em.halfEdges[twin]!.face);
      if (!isBoundary) continue;
      const a = he.v;
      const b = em.halfEdges[he.next]!.v;
      const aDup = dupMap[a]!;
      const bDup = dupMap[b]!;
      // Outward-facing quad (a, b on the unselected side; aDup, bDup on the cap):
      //   tri1: a, b, bDup
      //   tri2: a, bDup, aDup
      newIndices.push(a, b, bDup);
      newIndices.push(a, bDup, aDup);
    }
  }

  // 5. Selected faces with duplicate refs — these become the new selection.
  const newSelStart = newIndices.length / 3;
  for (const f of selectedFaces) {
    const [a, b, c] = faceVertices(em, f);
    newIndices.push(dupMap[a]!, dupMap[b]!, dupMap[c]!);
  }
  const newSelEnd = newIndices.length / 3;

  rebuildHalfEdges(em, new Float32Array(newPositions), newIndices);

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
    const [a, b, c] = faceVertices(em, f);
    if (selectedVerts.has(a) || selectedVerts.has(b) || selectedVerts.has(c)) {
      facesToDrop.add(f);
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
 * For each face, duplicate its three vertices, move each duplicate toward the
 * face centroid by `amount` (0 = no inset, 1 = collapse to centroid), and
 * stitch a skirt of three quads connecting the original boundary to the new
 * smaller face.
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

  const oldIndices = toIndexArray(em);
  const newPositions: number[] = Array.from(em.positions);
  let nextV = em.vertices.length;

  // Faces emit in this order: unselected (unchanged), skirts, inner caps.
  const newIndices: number[] = [];
  for (let f = 0; f < em.faces.length; f++) {
    if (selectedFaces.has(f)) continue;
    newIndices.push(oldIndices[f * 3]!, oldIndices[f * 3 + 1]!, oldIndices[f * 3 + 2]!);
  }

  // Per-face: compute centroid, allocate three duplicates, emit skirt + cap.
  type CapInfo = { a: number; b: number; c: number; aDup: number; bDup: number; cDup: number };
  const caps: CapInfo[] = [];

  for (const f of selectedFaces) {
    const [a, b, c] = faceVertices(em, f);
    const ax = em.positions[a * 3]!, ay = em.positions[a * 3 + 1]!, az = em.positions[a * 3 + 2]!;
    const bx = em.positions[b * 3]!, by = em.positions[b * 3 + 1]!, bz = em.positions[b * 3 + 2]!;
    const cx = em.positions[c * 3]!, cy = em.positions[c * 3 + 1]!, cz = em.positions[c * 3 + 2]!;
    const gx = (ax + bx + cx) / 3;
    const gy = (ay + by + cy) / 3;
    const gz = (az + bz + cz) / 3;

    const t = amount;
    const aDup = nextV++;
    newPositions.push(ax + (gx - ax) * t, ay + (gy - ay) * t, az + (gz - az) * t);
    const bDup = nextV++;
    newPositions.push(bx + (gx - bx) * t, by + (gy - by) * t, bz + (gz - bz) * t);
    const cDup = nextV++;
    newPositions.push(cx + (gx - cx) * t, cy + (gy - cy) * t, cz + (gz - cz) * t);

    caps.push({ a, b, c, aDup, bDup, cDup });
  }

  // Skirts: each original edge a→b becomes a (a, b, bDup, aDup) quad.
  // The face's original normal direction is preserved (CCW from outside).
  for (const { a, b, c, aDup, bDup, cDup } of caps) {
    newIndices.push(a, b, bDup, a, bDup, aDup);
    newIndices.push(b, c, cDup, b, cDup, bDup);
    newIndices.push(c, a, aDup, c, aDup, cDup);
  }

  // Caps (inner shrunk faces) — become the new selection.
  const capStart = newIndices.length / 3;
  for (const { aDup, bDup, cDup } of caps) {
    newIndices.push(aDup, bDup, cDup);
  }
  const capEnd = newIndices.length / 3;

  rebuildHalfEdges(em, new Float32Array(newPositions), newIndices);

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
 *  Chamfer winding is CCW-from-outside = (a1, a2, b2, b1), giving the four
 *  border edges:
 *    a1→a2 (left, at vertex a)   pairs with cap-a's a2→a1
 *    a2→b2 (bottom, F2-side)     pairs with F2's b2→a2
 *    b2→b1 (right, at vertex b)  pairs with cap-b's b1→b2
 *    b1→a1 (top, F1-side)        pairs with F1's a1→b1
 *
 *  Corner cap windings differ at the two endpoints because the chamfer's
 *  border at a (a1→a2, downward) needs the opposite (a2→a1) in the cap, while
 *  at b (b2→b1, upward) the cap needs b1→b2.
 *
 * V2 restriction (kept):
 *  - At most 1 selected bevel edge per vertex. Two bevels meeting at one
 *    vertex would split the fan into 4+ arcs and chain multiple cap polygons
 *    together (Blender's "branch" case). That's mechanically possible but
 *    materially more code; deferred to V3.
 *  - Fan must be closed (no boundary in the fan around a beveled vertex).
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

  // V2 isolation constraint: each endpoint vertex may host at most one bevel.
  // Selecting a whole edge loop (the most common bevel gesture) violates this
  // for every vertex, and the old all-or-nothing guard silently no-opped.
  // Instead keep a greedy maximal subset with disjoint endpoints and bevel
  // that — an alternating half of a loop — and report how many were skipped
  // so the caller can tell the user to repeat for the rest.
  const usedVerts = new Set<number>();
  const canonical = new Set<number>();
  for (const he of all) {
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

  const newIndices: number[] = [];
  for (let f = 0; f < em.faces.length; f++) {
    const [vA, vB, vC] = faceVertices(em, f);
    newIndices.push(remap(vA, f), remap(vB, f), remap(vC, f));
  }

  // Emit chamfer quads (these are the new selection).
  const chamferStart = newIndices.length / 3;
  for (const { a, b } of bevels) {
    const ia = vertInfo.get(a)!;
    const ib = vertInfo.get(b)!;
    // CCW from outside: (a1, a2, b2, b1) → tris (a1, a2, b2) + (a1, b2, b1)
    newIndices.push(ia.v1Idx, ia.v2Idx, ib.v2Idx);
    newIndices.push(ia.v1Idx, ib.v2Idx, ib.v1Idx);
  }
  const chamferEnd = newIndices.length / 3;

  // Emit corner caps. Winding differs by endpoint role:
  //   origin (vertex a):      cap CCW = (v2, v1, capX)
  //   destination (vertex b): cap CCW = (v1, v2, capX)
  for (const info of vertInfo.values()) {
    if (info.capX < 0) continue;
    if (info.role === "origin") {
      newIndices.push(info.v2Idx, info.v1Idx, info.capX);
    } else {
      newIndices.push(info.v1Idx, info.v2Idx, info.capX);
    }
  }

  rebuildHalfEdges(em, new Float32Array(newPositions), newIndices);

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
    // Predecessor half-edge in a triangle: cur.next.next.
    const prevInFace = em.halfEdges[em.halfEdges[cur]!.next]!.next;
    const tw = em.halfEdges[prevInFace]!.twin;
    if (tw < 0) break;
    cw.push(em.halfEdges[tw]!.face);
    cur = tw;
  }

  return { fan: [...cw.reverse(), startFace, ...ccw], closed: false };
}

/** Find the half-edge in `face` whose origin is `v`. */
function findOutgoing(em: EditMesh, v: number, face: number): number {
  const h0 = em.faces[face]!.he;
  const h1 = em.halfEdges[h0]!.next;
  const h2 = em.halfEdges[h1]!.next;
  for (const h of [h0, h1, h2]) {
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
  const setA = new Set(faceVertices(em, fA));
  for (const v of faceVertices(em, fB)) {
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
 * Cut an edge loop starting from `seedEdge`. The loop is walked by treating
 * each pair of adjacent triangles whose face normals are near-coplanar as an
 * implicit quad — the loop traverses each implicit quad by entering on one
 * side edge and exiting on the opposite side edge.
 *
 * Algorithm:
 *   1. Walk from `seedEdge` in both directions via `nextLoopEdge`, accreting
 *      a list of loop edges. Stops on revisit (closed loop) or boundary
 *      (open chain).
 *   2. Insert one midpoint vertex per loop edge.
 *   3. For every implicit quad crossed by two consecutive loop edges,
 *      re-triangulate the quad with the cut edge midpoint→midpoint replacing
 *      the original triangulation diagonal.
 *   4. For triangles outside any traversed quad (e.g., when the loop hits a
 *      boundary mid-walk), fall back to per-tri midpoint splitting.
 *
 * Returns the set of new midpoint vertex IDs (caller flips selection mode to
 * "vertex" so the user can immediately drag the new ring with the gizmo).
 *
 * V1 limitations:
 *   - Coplanarity threshold is fixed (cos ≥ 0.7 ≈ 45°). Sharp creases break
 *     loop continuity, which is usually correct intent.
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
  for (const e of loop) {
    const a = edgeOrigin(em, e);
    const b = edgeEnd(em, e);
    const mid = nextV++;
    const [mx, my, mz] = lerpPos(em, a, b, 0.5);
    newPositions.push(mx, my, mz);
    midpointOf.set(e, mid);
  }

  // Group consecutive loop edges into "quad crossings": each pair (loop[i],
  // loop[i+1]) sits in one implicit quad. We need to know which two faces
  // form that quad so we can re-triangulate them together.
  type QuadCut = { f1: number; f2: number; eEntry: number; eExit: number };
  const quadCuts: QuadCut[] = [];
  const facesInQuads = new Set<number>();
  for (let i = 0; i < loop.length; i++) {
    const e1 = loop[i]!;
    const e2 = loop[(i + 1) % loop.length]!;
    // Stop at the wrap-around if loop is open (i.e., the last "next" doesn't
    // come back to the seed). For closed loops this still works because both
    // e1 and e2 are real loop edges sharing a quad.
    const shared = sharedFaceBetweenEdges(em, e1, e2);
    if (shared < 0) continue;
    const partner = quadPartnerOfFaceCrossing(em, shared, e1, e2);
    if (partner < 0) continue;
    if (facesInQuads.has(shared) || facesInQuads.has(partner)) continue;
    facesInQuads.add(shared);
    facesInQuads.add(partner);
    quadCuts.push({ f1: shared, f2: partner, eEntry: e1, eExit: e2 });
  }

  // Emit new index list.
  const newIndices: number[] = [];

  // 1. Pass-through: faces not in any traversed quad, not subdivided.
  // 2. Per-tri midpoint subdivide: faces with a loop edge but no quad
  //    partner (boundary / non-coplanar fall-through).
  // 3. Per-quad retriangulation: paired faces fully covered by quadCuts.
  const quadByFace = new Map<number, QuadCut>();
  for (const qc of quadCuts) {
    quadByFace.set(qc.f1, qc);
    quadByFace.set(qc.f2, qc);
  }

  for (let f = 0; f < em.faces.length; f++) {
    const qc = quadByFace.get(f);
    if (qc && f === qc.f1) {
      emitQuadCut(em, qc, midpointOf, newIndices);
      continue;
    }
    if (qc && f === qc.f2) continue; // handled with f1

    // Otherwise: per-tri subdivision based on this face's loop edges.
    const h0 = em.faces[f]!.he;
    const h1 = em.halfEdges[h0]!.next;
    const h2 = em.halfEdges[h1]!.next;
    const faceHEs = [h0, h1, h2];
    const subdivHE: number[] = [];
    for (const h of faceHEs) {
      const can = canonicalEdge(em, h);
      if (midpointOf.has(can)) subdivHE.push(h);
    }
    if (subdivHE.length === 0) {
      // untouched face
      newIndices.push(em.halfEdges[h0]!.v, em.halfEdges[h1]!.v, em.halfEdges[h2]!.v);
    } else if (subdivHE.length === 1) {
      // 1 selected edge → 2 tris fanning to off-edge vertex
      emitTriSplit1(em, subdivHE[0]!, midpointOf, newIndices);
    } else if (subdivHE.length === 2) {
      // 2 selected edges → 3 tris with a cut between the 2 midpoints
      emitTriSplit2(em, h0, h1, h2, subdivHE, midpointOf, newIndices);
    } else {
      // 3 selected edges → 4 tris (classic 1→4 subdivision)
      emitTriSplit3(em, h0, h1, h2, midpointOf, newIndices);
    }
  }

  rebuildHalfEdges(em, new Float32Array(newPositions), newIndices);
  return new Set(midpointOf.values());
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
 * the loop by:
 *   1. Determining the outgoing face (the OTHER tri adjacent to `cur`).
 *   2. Picking outgoing's "quad partner" — the neighbor across the edge whose
 *      face normal is most coplanar with outgoing's.
 *   3. Identifying the side of the implicit quad that's opposite to `cur`
 *      (i.e., the edge of the partner that's between the two non-`cur` verts
 *      of the quad).
 *
 * Returns null when there's no quad partner (coplanarity below threshold or
 * boundary).
 */
function nextLoopEdge(em: EditMesh, cur: number, incomingFace: number): { nextEdge: number; partnerFace: number } | null {
  const twin = em.halfEdges[cur]!.twin;
  if (twin < 0) return null;
  const f1 = em.halfEdges[cur]!.face;
  const f2 = em.halfEdges[twin]!.face;
  const outgoingFace = f1 === incomingFace ? f2 : f1;

  // Outgoing face's 3 half-edges; the diagonal candidate is one of the 2 not on `cur`.
  const oh0 = em.faces[outgoingFace]!.he;
  const oh1 = em.halfEdges[oh0]!.next;
  const oh2 = em.halfEdges[oh1]!.next;
  const outNormal = faceNormal(em, outgoingFace);
  const COPLANAR_THRESHOLD = 0.7; // cos(45°) — coarse but covers cube faces (1.0) and rejects orthogonal neighbors (0.0).

  let bestDiagonalHE = -1;
  let bestDot = COPLANAR_THRESHOLD;
  for (const h of [oh0, oh1, oh2]) {
    if (canonicalEdge(em, h) === cur) continue;
    const t = em.halfEdges[h]!.twin;
    if (t < 0) continue;
    const neighbor = em.halfEdges[t]!.face;
    const neighborNormal = faceNormal(em, neighbor);
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
  const ph0 = em.faces[partnerFace]!.he;
  const ph1 = em.halfEdges[ph0]!.next;
  const ph2 = em.halfEdges[ph1]!.next;
  for (const ph of [ph0, ph1, ph2]) {
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
 * Given `entryFace` (which contains both `e1` and a "diagonal" we crossed
 * during loop walking), return its quad partner = the most coplanar neighbor
 * NOT adjacent to e1 (the diagonal partner).
 */
function quadPartnerOfFaceCrossing(em: EditMesh, entryFace: number, e1: number, e2: number): number {
  // The partner is the face adjacent to entryFace whose shared edge is the
  // implicit-quad's diagonal (not e1, not e2 if e2 happens to be in entryFace).
  // Look up entryFace's 3 half-edges. For each non-(e1 or e2) edge, check the
  // neighbor's normal vs entryFace's normal — pick most coplanar.
  const h0 = em.faces[entryFace]!.he;
  const h1 = em.halfEdges[h0]!.next;
  const h2 = em.halfEdges[h1]!.next;
  const myNormal = faceNormal(em, entryFace);
  let best = -1;
  let bestDot = 0.7;
  for (const h of [h0, h1, h2]) {
    const can = canonicalEdge(em, h);
    if (can === e1 || can === e2) continue;
    const t = em.halfEdges[h]!.twin;
    if (t < 0) continue;
    const neighbor = em.halfEdges[t]!.face;
    const nNormal = faceNormal(em, neighbor);
    const dot = dot3(myNormal, nNormal);
    if (dot > bestDot) {
      bestDot = dot;
      best = neighbor;
    }
  }
  return best;
}

/**
 * Re-triangulate one implicit quad into 4 tris with a cut edge running from
 * the midpoint of `eEntry` to the midpoint of `eExit`.
 *
 * The implicit quad has 4 verts: 2 on eEntry (a, b), 1 in entryFace not in
 * either loop edge (c), 1 in partnerFace not in either loop edge (d). The
 * cyclic order is a → b → (b's neighbor on eExit) → (a's neighbor on eExit)
 * → a.
 */
function emitQuadCut(em: EditMesh, qc: { f1: number; f2: number; eEntry: number; eExit: number }, midpointOf: Map<number, number>, out: number[]): void {
  const mEntry = midpointOf.get(qc.eEntry)!;
  const mExit = midpointOf.get(qc.eExit)!;
  // eEntry has verts (a, b); eExit has verts (c, d). We need to know which
  // of (c, d) sits next to a, vs next to b, in the implicit quad's cycle.
  // The quad's cyclic order is determined by entryFace's CCW.
  const a = edgeOrigin(em, qc.eEntry);
  const b = edgeEnd(em, qc.eEntry);
  const eExitV0 = edgeOrigin(em, qc.eExit);
  const eExitV1 = edgeEnd(em, qc.eExit);

  // Identify which of eExitV0/eExitV1 is "next to a" in the quad cycle.
  // Walk around entryFace from a's outgoing-on-eEntry. The 3rd vertex of
  // entryFace (call it x) is adjacent to a and b. partnerFace's 3rd vertex
  // (y) is the other endpoint of eExit. We need to figure out which of (x,y)
  // pair gets paired with which of (eExitV0, eExitV1).
  //
  // The implicit quad's cyclic CCW order (from entryFace's view): a → b → ?
  // → ? → a. After b comes b's neighbor in entryFace, which is x or jumps
  // into partnerFace via the diagonal.
  //
  // Easier: collect the 4 distinct verts of the quad and order them by
  // adjacency in the entry/partner CCW.

  // The 4 corners are: a, b, plus the off-edge verts of entryFace and
  // partnerFace. The cyclic order around the quad is: a → b (via entryFace's
  // a→b edge) → next-CCW-vert-of-partner-after-b → next-CCW-vert-of-partner
  // after that → back to a.

  // Triangulate as 4 tris using the midpoints. The simplest pattern that
  // preserves CCW winding: split the quad into 4 corner sub-tris around the
  // cut edge. Two of those are in entryFace's region, two in partnerFace's.
  //
  //   a --- mEntry --- b
  //   |       |        |
  //   |       |        |
  //   ?  --- mExit --- ?
  //
  // The 4 tris depend on which "?" is adjacent to a (call it cornerA) vs to
  // b (cornerB). Cyclic CCW around the quad: a → b → cornerB → cornerA → a.
  // Tris:
  //   T1 = (a, mEntry, mExit) — upper-left, but we need mExit-cornerA pairing.
  // Actually safer: each "corner triangle" uses 3 corner verts.
  //   T1 = (a, mEntry, cornerA)
  //   T2 = (mEntry, b, cornerB)
  //   T3 = (cornerB, mExit, mEntry)
  //   T4 = (cornerA, mExit, cornerB) -- wait, that's mixing sides.
  // Let me just pick a triangulation that works: split the quad along the cut
  // edge mEntry-mExit into two halves, then triangulate each half.
  //   Half 1 (a side): a, mEntry, mExit, cornerA — triangulate (a, mEntry, mExit) + (a, mExit, cornerA)
  //   Half 2 (b side): mEntry, b, cornerB, mExit — triangulate (mEntry, b, cornerB) + (mEntry, cornerB, mExit)

  // Determine cornerA, cornerB by checking partnerFace's CCW order — the
  // vertex coming AFTER b in the quad cycle = cornerB; before a = cornerA.
  // Use the partnerFace half-edges to find this.

  let cornerA = -1, cornerB = -1;
  // Look in partnerFace for the half-edge whose origin is one of {eExitV0, eExitV1} and whose end is also in eExit.
  const ph0 = em.faces[qc.f2]!.he;
  const ph1 = em.halfEdges[ph0]!.next;
  const ph2 = em.halfEdges[ph1]!.next;
  for (const ph of [ph0, ph1, ph2]) {
    const ov = em.halfEdges[ph]!.v;
    const ev = em.halfEdges[em.halfEdges[ph]!.next]!.v;
    if ((ov === eExitV0 && ev === eExitV1) || (ov === eExitV1 && ev === eExitV0)) {
      // This half-edge IS eExit (in partnerFace's CCW order).
      // After eExit comes a half-edge ending at... the 3rd vertex of partnerFace,
      // which is one of {a, b}.
      const after = em.halfEdges[ph]!.next;
      const afterEndVert = em.halfEdges[em.halfEdges[after]!.next]!.v;
      // afterEndVert is the partnerFace's 3rd vert. It should equal `a` or `b`.
      // ov → ev → afterEndVert → ov. If afterEndVert == a, then ev is next to a
      // in the cycle (so ev = cornerA, ov = cornerB). If afterEndVert == b,
      // then ov is next to b (cornerB = ov, cornerA = ev).
      if (afterEndVert === a) { cornerA = ev; cornerB = ov; }
      else if (afterEndVert === b) { cornerB = ov; cornerA = ev; }
      break;
    }
  }
  if (cornerA < 0 || cornerB < 0) {
    // Fallback: arbitrarily assign; visually wrong but topologically valid.
    cornerA = eExitV0; cornerB = eExitV1;
  }

  // Emit 4 tris.
  out.push(a, mEntry, mExit);
  out.push(a, mExit, cornerA);
  out.push(mEntry, b, cornerB);
  out.push(mEntry, cornerB, mExit);
}

/** 1 selected edge in a tri — fan to off-edge vertex. */
function emitTriSplit1(em: EditMesh, subdivHE: number, midpointOf: Map<number, number>, out: number[]): void {
  const mid = midpointOf.get(canonicalEdge(em, subdivHE))!;
  const a = em.halfEdges[subdivHE]!.v;
  const nxt = em.halfEdges[subdivHE]!.next;
  const b = em.halfEdges[nxt]!.v;
  const c = em.halfEdges[em.halfEdges[nxt]!.next]!.v;
  out.push(a, mid, c);
  out.push(mid, b, c);
}

/** 2 selected edges in a tri — split into 3 tris with a midpoint-to-midpoint cut. */
function emitTriSplit2(em: EditMesh, h0: number, h1: number, h2: number, subdivHE: number[], midpointOf: Map<number, number>, out: number[]): void {
  // Identify the un-subdivided edge: this anchors the "third vertex" position.
  const subdivSet = new Set(subdivHE);
  const otherHE = [h0, h1, h2].find((h) => !subdivSet.has(h));
  if (otherHE === undefined) return;
  // tri = (v[h0], v[h1], v[h2]) CCW. The non-subdivided edge has its two
  // endpoints "untouched"; the third vertex is the one OPPOSITE to it,
  // through which both subdivided edges pass.
  // Let other = (u, v). Third vertex = w (the one not in `other`).
  // Subdivided edges: (u, w) and (v, w) — or some rotation. Each has a midpoint.
  const u = em.halfEdges[otherHE]!.v;
  const v = em.halfEdges[em.halfEdges[otherHE]!.next]!.v;
  // Third vertex
  const allV = [em.halfEdges[h0]!.v, em.halfEdges[h1]!.v, em.halfEdges[h2]!.v];
  const w = allV.find((x) => x !== u && x !== v)!;

  // Midpoints: M_uw on edge u-w, M_vw on edge v-w.
  // Find which subdiv half-edges correspond.
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
  out.push(u, v, mVW);
  out.push(u, mVW, mUW);
  out.push(mUW, mVW, w);
}

/** 3 selected edges in a tri — classic 1→4 subdivision. */
function emitTriSplit3(em: EditMesh, h0: number, h1: number, h2: number, midpointOf: Map<number, number>, out: number[]): void {
  const a = em.halfEdges[h0]!.v;
  const b = em.halfEdges[h1]!.v;
  const c = em.halfEdges[h2]!.v;
  const mAB = midpointOf.get(canonicalEdge(em, h0))!;
  const mBC = midpointOf.get(canonicalEdge(em, h1))!;
  const mCA = midpointOf.get(canonicalEdge(em, h2))!;
  out.push(a, mAB, mCA);
  out.push(mAB, b, mBC);
  out.push(mBC, c, mCA);
  out.push(mAB, mBC, mCA);
}

function faceNormal(em: EditMesh, f: number): [number, number, number] {
  const [a, b, c] = faceVertices(em, f);
  const ax = em.positions[a * 3]!, ay = em.positions[a * 3 + 1]!, az = em.positions[a * 3 + 2]!;
  const bx = em.positions[b * 3]!, by = em.positions[b * 3 + 1]!, bz = em.positions[b * 3 + 2]!;
  const cx = em.positions[c * 3]!, cy = em.positions[c * 3 + 1]!, cz = em.positions[c * 3 + 2]!;
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len > 1e-9) { nx /= len; ny /= len; nz /= len; }
  return [nx, ny, nz];
}

function dot3(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

// ── Edge Extrude ───────────────────────────────────────────────────────────

/**
 * Extrude selected edges into "fin" quads.
 *
 * For each selected edge a-b, duplicates both endpoints (a → a', b → b') and
 * emits a fin quad (a, aDup, bDup, b) — 2 tris attached to the edge from the
 * F1-side, so the fin's twin half-edge (b→a) pairs cleanly with F1's a→b.
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
 *    half-edge wins the twin slot via rebuildHalfEdges' last-write-wins.
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

  const newIndices = toIndexArray(em);
  const finStart = newIndices.length / 3;
  for (const he of canonical) {
    const a = edgeOrigin(em, he);
    const b = edgeEnd(em, he);
    const aDup = dupOrCreate(a);
    const bDup = dupOrCreate(b);
    // Fin tris — CCW from the fin's outside, with the b→a edge in tri 2
    // pairing as twin to F1's existing a→b.
    newIndices.push(a, aDup, bDup);
    newIndices.push(a, bDup, b);
  }
  const finEnd = newIndices.length / 3;

  rebuildHalfEdges(em, new Float32Array(newPositions), newIndices);

  const newSel = new Set<number>();
  for (let i = finStart; i < finEnd; i++) newSel.add(i);
  return newSel;
}

// ── Knife V1 (Edge Flip via two selected vertices) ─────────────────────────

/**
 * Connect 2 selected vertices with a new edge — V1 implementation handles
 * only the "adjacent tri" case where the verts are the two "off-edge"
 * vertices of two triangles sharing an edge. The operation is then a
 * diagonal flip: the shared edge a-b is replaced by v1-v2.
 *
 * For verts separated by >1 triangle (the general free-hand Knife), V1
 * returns empty — implementing it requires line-segment intersection with
 * mesh edges + face triangulation, scoped for Knife V2.
 *
 * Returns the (unchanged) input vert set so the user's selection persists
 * across the operation; the new edge is visible in the edge overlay since
 * the topology rebuild repopulates the line buffer.
 */
export function knife(em: EditMesh, selectedVerts: ReadonlySet<number>): Set<number> {
  if (selectedVerts.size !== 2) return new Set();
  const [v1, v2] = [...selectedVerts];
  if (v1 === undefined || v2 === undefined) return new Set();

  // Search faces containing v1; for each, check whether its 3 edges' twin
  // faces contain v2.
  for (let f = 0; f < em.faces.length; f++) {
    const verts = faceVertices(em, f);
    if (!verts.includes(v1) || verts.includes(v2)) continue;

    const h0 = em.faces[f]!.he;
    const h1 = em.halfEdges[h0]!.next;
    const h2 = em.halfEdges[h1]!.next;
    for (const h of [h0, h1, h2]) {
      const va = em.halfEdges[h]!.v;
      const vb = em.halfEdges[em.halfEdges[h]!.next]!.v;
      // Find the edge OPPOSITE v1 in this tri (the one not touching v1).
      if (va === v1 || vb === v1) continue;
      const tw = em.halfEdges[h]!.twin;
      if (tw < 0) continue;
      const neighborFace = em.halfEdges[tw]!.face;
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
 * (See operators.ts source comments — both new tris keep outward normals
 * pairing correctly with the surrounding mesh's twins.)
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

  const newIndices: number[] = [];
  for (let f = 0; f < em.faces.length; f++) {
    if (f === f1) {
      newIndices.push(b, c, d);
    } else if (f === f2) {
      newIndices.push(c, a, d);
    } else {
      const [va, vb, vc] = faceVertices(em, f);
      newIndices.push(va, vb, vc);
    }
  }

  rebuildHalfEdges(em, em.positions, newIndices);
  return new Set([v1, v2]);
}

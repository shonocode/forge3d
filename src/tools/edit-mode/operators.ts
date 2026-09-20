import { canonicalEdge, edgeEnd, edgeOrigin, faceHalfEdges, facePolyNormal, faceVertexCount, faceVerts, faceVertices, forEachEdge, rebuildPolygons, seamKey, toPolygons, type EditMesh } from "./half-edge";
import { catmullClark } from "./subdivide";
import { walkEdgeRing } from "./edge-walk";

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
 * **`amount` is not Blender's `thickness`.** It is a fraction of the way to the
 * centroid — the right knob under a mouse, where dragging further insets more,
 * and the wrong one for code working from dimensions: on a 440 x 660 door, one
 * fraction gives a 24mm stile and a 36mm rail. Blender has no equivalent; its
 * `inset_individual(thickness=)` is a distance. Two functions cover that:
 *
 * - {@link insetFacesByWidth} is `inset_individual` with `use_even_offset` on —
 *   a constant border width all the way round, which is what millwork does.
 * - {@link insetRegion} is `inset_region`, the mode where a selection insets as
 *   one patch instead of face by face.
 *
 * "Individual" here means the same as Blender's: every selected face gets its
 * own ring and its own cap, so two faces that touch come back with a seam
 * between them. That is the opposite of the industry default — the Inset tool
 * is region mode unless you press I twice — so reach for {@link insetRegion}
 * unless separate insets are what you meant.
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
 *
 * Blender: `bmesh.ops.bevel(geom=, offset=, offset_type='PERCENT', segments=1,
 * affect='EDGES')`. `offset` is in the same units as Blender's, measured the
 * same way — `tools/modeling/parity/compare-bevel.ts` ran all four
 * `offset_type` conventions against this and PERCENT was the match at 1.02mm
 * where the next-closest was 9.8mm.
 *
 * The parameter used to be called `width` and used to be a fraction (0.15
 * rather than 15). That was the worst of both: Blender has an `offset_type`
 * literally named `WIDTH` meaning something else entirely (the absolute width
 * of the chamfer face), so the old name pointed a reader at the wrong
 * convention *and* the number did not transfer.
 */
export interface BevelOptions {
  /**
   * Blender's `offset`, in the units `offsetType` selects. For PERCENT that is
   * a percentage of each adjacent edge, clamped to 0.1..49.
   */
  offset: number;
  /**
   * `'PERCENT'` (the default) measures `offset` as a percentage of each
   * adjacent edge; `'OFFSET'` measures it as a distance in model units.
   * `'WIDTH'` and `'DEPTH'` are named so their absence is a named failure
   * rather than a silently different chamfer.
   *
   * On a unit cube the two implemented modes describe the same chamfer —
   * 25% of a 1.0 edge is 0.25 — and Blender agrees at every vertex except a
   * branch one, where its PERCENT path applies no offset at all and leaves the
   * original vertex in place. See {@link bevelEdges} on branches.
   */
  offsetType?: "PERCENT" | "OFFSET" | "WIDTH" | "DEPTH";
  /**
   * How many faces across the chamfer. Blender's `segments`, default 1.
   *
   * Each beveled vertex splits into `segments + 1` rail vertices and the
   * chamfer becomes that many quads — measured on a cube, where one edge
   * beveled with n segments gives 8 + 2n vertices and 6 + n faces.
   */
  segments?: number;
  /**
   * The shape of the chamfer in cross-section, 0..1. Blender's `profile`,
   * default 0.5.
   *
   * It selects a superellipse. In coordinates measured from the *outer* corner
   * of the chamfer's bounding square, the curve is `s^r + t^r = 1` with
   *
   *     r = 2 * ln(0.5) / ln(profile)
   *
   * which was derived rather than assumed: the midpoint of the chamfer sits at
   * `sqrt(profile)` along both diagonals, measured at nineteen values of
   * `profile` and exact at every one. So 0.25 is a straight chamfer (r = 1),
   * **0.5 is a circular fillet** (r = 2), below 0.25 it bulges outward and
   * above 0.5 it hugs the original corner.
   */
  profile?: number;
}

/**
 * Points along the superellipse `s^r + t^r = 1`, spaced at **equal chords**.
 *
 * Equal chords, not equal arc length. The two coincide for a circle (r = 2,
 * `profile` 0.5) and for a straight line (r = 1, `profile` 0.25), and differ
 * everywhere else — which is why the first implementation spaced by arc length
 * and matched Blender on every case anyone had measured. `profile` 0.75 with 8
 * segments is 0.42 mm out that way and 0.0007 mm out this way, against a
 * tolerance of 0.01 mm.
 *
 * The rule was read off Blender rather than inferred: a cube beveled at
 * `profile` 0.75, `segments` 8 comes back with eight chords of 0.223165,
 * 0.223163, 0.223164, 0.223162, 0.223162, 0.223164, 0.223163, 0.223165 — equal
 * to a part in 10^5, which no arc-length spacing of that curve produces.
 *
 * The superellipse is defined in coordinates measured from the **outer** corner
 * of the square the two slide directions span, so it is built there and
 * converted at the end. Building it in corner coordinates instead gives the
 * right endpoints and wrong everything between them, which is exactly what
 * happened first: segments=1 matched Blender and segments=2 did not.
 */
function profileCurve(r: number, segments: number): Array<[number, number]> {
  if (segments <= 1) return [[1, 0], [0, 1]];

  /** The curve at parameter `u` — `u` is the outer-corner coordinate `s`. */
  const at = (u: number): [number, number] => [
    1 - u,
    1 - Math.pow(Math.max(0, 1 - Math.pow(u, r)), 1 / r),
  ];
  const START = at(0);
  const END = at(1);
  const dist = (p: [number, number], q: [number, number]): number =>
    Math.hypot(p[0] - q[0], p[1] - q[1]);

  /** Walk chords of length `len` from the start, stopping one short. */
  const walk = (len: number): Array<[number, number]> => {
    const pts: Array<[number, number]> = [START];
    let u = 0;
    // One chord short of the full count: the last point is the far end, which
    // is known exactly, and solving for it would only re-derive it badly.
    for (let k = 0; k < segments - 1; k++) {
      const from = pts[k]!;
      // Distance from `from` grows with `u` along this arc, so bisect on it.
      let lo = u;
      let hi = 1;
      for (let it = 0; it < 60; it++) {
        const mid = (lo + hi) / 2;
        if (dist(from, at(mid)) < len) lo = mid;
        else hi = mid;
      }
      u = (lo + hi) / 2;
      pts.push(at(u));
    }
    return pts;
  };

  // Solve for the chord that makes the leftover exactly one more of itself.
  // `leftover(len) - len` falls as `len` rises — the walk gets further along,
  // so less is left — which is what makes a bisection valid here. The earlier
  // form asked whether the walk *landed* on the end instead, and that is true
  // for every `len` at or above the answer: it converged on the top of the
  // bracket and came back with a rail whose last chord was 0.0007 long and
  // whose two halves were not mirror images.
  const gap = (len: number): number => dist(walk(len)[segments - 1]!, END) - len;
  let lo = 0;
  let hi = dist(START, END); // one chord straight across — certainly too long
  for (let it = 0; it < 100; it++) {
    const mid = (lo + hi) / 2;
    if (gap(mid) > 0) lo = mid;
    else hi = mid;
  }
  const out = walk((lo + hi) / 2);
  out.push(END);
  return out;
}

export function bevelEdges(
  em: EditMesh,
  selectedEdges: ReadonlySet<number>,
  opts: BevelOptions,
  outInfo?: { skipped: number },
): Set<number> {
  const offsetType = opts.offsetType ?? "PERCENT";
  if (offsetType !== "PERCENT" && offsetType !== "OFFSET")
    throw new Error(
      `bevelEdges: offsetType '${offsetType}' is not implemented — only 'PERCENT' ` +
        `and 'OFFSET'. Blender's ${offsetType} measures the chamfer differently, so ` +
        `silently treating it as one of these would produce a wrong-sized bevel.`,
    );
  const segments = Math.max(1, Math.floor(opts.segments ?? 1));
  const profile = Math.min(0.999, Math.max(0.001, opts.profile ?? 0.5));

  // PERCENT arrives as 0..49 and becomes a fraction; OFFSET is already a
  // distance and passes through. Both reach `computeFanInfo` as one number
  // plus the mode, because how far along an edge to go is the only thing that
  // differs between them.
  const amount = offsetType === "PERCENT" ? opts.offset / 100 : opts.offset;
  if (selectedEdges.size === 0 || amount <= 0) return new Set(selectedEdges);

  // Canonicalize selection (always work with min(he, twin)).
  const all = new Set<number>();
  for (const he of selectedEdges) {
    const t = em.halfEdges[he]!.twin;
    if (t < 0) continue; // boundary bevel edge — skip (no F2 to chamfer against)
    all.add(he < t ? he : t);
  }
  // Asked to bevel, and able to bevel none of it. Returning an empty set here
  // reads to a caller exactly like "there was nothing to do", which is how a
  // rim comes back unbeveled with no error and the next step runs on it.
  if (all.size === 0)
    throw new Error(
      `bevelEdges: all ${selectedEdges.size} selected edge(s) are on a boundary, ` +
        `so there is no second face to chamfer against. Nothing was beveled.`,
    );

  // At most one bevel edge per vertex: two meeting at a vertex would split its
  // fan into four or more arcs and chain several corner polygons together —
  // Blender's "branch" case, and still deferred.
  const used = new Set<number>();
  const canonical = new Set<number>();
  for (const he of all) {
    const a = edgeOrigin(em, he);
    const b = edgeEnd(em, he);
    if (used.has(a) || used.has(b)) continue;
    used.add(a);
    used.add(b);
    canonical.add(he);
  }
  // How many selected edges meet at each vertex. One is the ordinary case;
  // two is what asking for a loop looks like from the inside; three or more is
  // Blender's full vertex mesh and has not been measured.
  const degreeOf = new Map<number, number[]>();
  for (const he of all) {
    for (const v of [edgeOrigin(em, he), edgeEnd(em, he)]) {
      const list = degreeOf.get(v);
      if (list) list.push(he);
      else degreeOf.set(v, [he]);
    }
  }
  let maxDegree = 0;
  for (const list of degreeOf.values()) maxDegree = Math.max(maxDegree, list.length);
  if (maxDegree >= 3)
    throw new Error(
      `bevelEdges: a vertex has ${maxDegree} selected edges at it. Two is handled ` +
        `— that is what a loop of edges is — but three or more is Blender's full ` +
        `vertex mesh, which has not been measured, so it is refused not guessed.`,
    );
  // Whether the branch path can take this selection is not known until its
  // vertices have been looked at, so the decision waits for the build below.
  // Falling back matters: before branches existed the operator beveled a
  // greedy non-adjacent subset, and a shape the branch path has not been
  // measured on should still get that rather than nothing.
  let branching = maxDegree >= 2;

  const reach =
    offsetType === "PERCENT"
      ? ({ kind: "PERCENT", amount: Math.max(0.001, Math.min(0.49, amount)) } as const)
      : ({ kind: "OFFSET", amount } as const);
  const r = (2 * Math.log(0.5)) / Math.log(profile);
  const curve = profileCurve(r, segments);

  type FanInfo = FanInfoOut;

  const vertInfo = new Map<number, FanInfo>();
  const bevels: Array<{ a: number; b: number; f1: number; f2: number; he: number }> = [];

  /**
   * What appears at a vertex where two selected edges meet.
   *
   * One rule covers this and the ordinary case both: **a new vertex on every
   * edge at the vertex that is not selected, and one in every face whose two
   * edges at the vertex are both selected.** Measured on three configurations
   * (a cube corner at valence 3, a bipyramid equator vertex at valence 4, and
   * the same at two segments); the counts come out 2, 2 and 3.
   *
   * There is no corner polygon: with two selected edges the ring of new
   * vertices has two members and degenerates, which is the same reason the
   * ordinary case's cap vanishes at a cube corner.
   */
  interface BranchMesh {
    /** New vertex per unselected edge, keyed by the far vertex. */
    slide: Map<number, number>;
    /** New vertex per face with two selected edges at this vertex. */
    corner: Map<number, number>;
    /** Per selected edge, the rail read from its f1 side to its f2 side. */
    rail: Map<number, number[]>;
    /** The far vertices of the selected edges here. */
    bevelled: Set<number>;
    faces: number[];
    edges: number[];
  }
  /** A shape the branch path has not been measured on. Falls back, not fatal. */
  class Unmeasured extends Error {}
  const branchInfo = new Map<number, BranchMesh>();
  const branchPos: Array<[number, number, number]> = [];
  const claim = (p: [number, number, number]): number => {
    branchPos.push(p);
    return -branchPos.length; // negative placeholder, resolved after allocation
  };

  try {
  for (const [v, hes] of degreeOf) {
    if (!branching || hes.length < 2) continue;
    const fe = fanEdges(em, v, em.halfEdges[hes[0]!]!.face);
    if (!fe)
      throw new Unmeasured(
        `bevelEdges: the fan at vertex ${v} is open or non-manifold. Two selected ` +
          `edges meeting there needs a closed fan.`,
      );
    const bevelled = new Set<number>(
      hes.map((he) => (edgeOrigin(em, he) === v ? edgeEnd(em, he) : edgeOrigin(em, he))),
    );
    const vx = em.positions[v * 3]!;
    const vy = em.positions[v * 3 + 1]!;
    const vz = em.positions[v * 3 + 2]!;
    const lenTo = (to: number): number =>
      Math.hypot(
        em.positions[to * 3]! - vx,
        em.positions[to * 3 + 1]! - vy,
        em.positions[to * 3 + 2]! - vz,
      );
    // OFFSET is already a distance. PERCENT is not, and Blender's PERCENT path
    // puts *no* offset at all at a branch vertex — measured on a cube, where
    // the original corner survives and the two chamfers pinch to it. That is a
    // defect rather than a definition (the two conventions agree at every
    // other vertex of the same run), so this takes the mean adjacent edge and
    // carries on rather than reproducing it.
    let dist = reach.amount;
    if (reach.kind === "PERCENT") {
      let sum = 0;
      for (const nb of fe.edges) sum += lenTo(nb);
      dist = (reach.amount * sum) / Math.max(1, fe.edges.length);
    }

    const unitTo = (to: number): [number, number, number] => {
      const l = lenTo(to) || 1;
      return [
        (em.positions[to * 3]! - vx) / l,
        (em.positions[to * 3 + 1]! - vy) / l,
        (em.positions[to * 3 + 2]! - vz) / l,
      ];
    };
    /** sin of the angle at `v` between the edges to `a` and to `b`. */
    const sineBetween = (a: number, b: number): number => {
      const ua = unitTo(a);
      const ub = unitTo(b);
      const c = Math.max(-1, Math.min(1, ua[0] * ub[0] + ua[1] * ub[1] + ua[2] * ub[2]));
      return Math.sqrt(Math.max(1e-12, 1 - c * c));
    };

    const n = fe.faces.length;
    const slide = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      const nb = fe.edges[i]!;
      if (bevelled.has(nb) || slide.has(nb)) continue;
      // This edge receives a rail end when the face on either side of it also
      // holds a selected edge — which, at a branch vertex, is every one of
      // them in the shapes measured so far. A rail end is placed at the
      // *perpendicular* distance from the selected edge, so the walk along
      // this one is divided by the sine of the angle between them; the same
      // conversion the ordinary path already makes. Without it the bipyramid
      // came out 1.2 mm away with the topology already correct.
      const before = fe.edges[(i + n - 1) % n]!;
      const after = fe.edges[(i + 1) % n]!;
      const sines: number[] = [];
      if (bevelled.has(before)) sines.push(sineBetween(nb, before));
      if (bevelled.has(after)) sines.push(sineBetween(nb, after));
      if (sines.length === 2 && Math.abs(sines[0]! - sines[1]!) > 1e-6)
        throw new Unmeasured(
          `bevelEdges: the two selected edges either side of vertex ${v} meet edge ` +
            `${nb} at different angles, so one new vertex cannot sit at the offset ` +
            `from both. That shape has not been measured.`,
        );
      const t = sines.length > 0 ? dist / sines[0]! : dist;
      const u = unitTo(nb);
      slide.set(nb, claim([vx + u[0] * t, vy + u[1] * t, vz + u[2] * t]));
    }

    const corner = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      const ePrev = fe.edges[(i + n - 1) % n]!;
      const eNext = fe.edges[i]!;
      if (bevelled.has(ePrev) && bevelled.has(eNext))
        corner.set(fe.faces[i]!, claim(faceCorner(em, v, ePrev, eNext, dist)));
    }

    /** The point a selected edge's rail ends on, inside face `f`. */
    const endIn = (f: number, nb: number): number => {
      const i = fe.faces.indexOf(f);
      const ePrev = fe.edges[(i + n - 1) % n]!;
      const eNext = fe.edges[i]!;
      const other = ePrev === nb ? eNext : ePrev;
      const c = corner.get(f);
      if (bevelled.has(other)) {
        if (c === undefined) throw new Error(`bevelEdges: no corner for face ${f} at ${v}`);
        return c;
      }
      const sIdx = slide.get(other);
      if (sIdx === undefined) throw new Error(`bevelEdges: no slide for ${other} at ${v}`);
      return sIdx;
    };

    // The two selected edges cut the fan into two arcs, so both of them end on
    // the same two points — and the rail *between* those points therefore
    // belongs to the vertex rather than to either edge. Blender writes one set
    // of interior points and lets both chamfers use it.
    //
    // Building them per edge instead put a second vertex at the same position:
    // the surface came out identical to six digits and the parity run still
    // said DIFFERENT TOPOLOGY, 15 vertices against 14. A duplicate vertex is
    // invisible in every measure except the count.
    const endsOf = new Map<number, [number, number]>();
    for (const he of hes) {
      const nb = edgeOrigin(em, he) === v ? edgeEnd(em, he) : edgeOrigin(em, he);
      endsOf.set(he, [
        endIn(em.halfEdges[he]!.face, nb),
        endIn(em.halfEdges[em.halfEdges[he]!.twin]!.face, nb),
      ]);
    }
    const [first, second] = endsOf.get(hes[0]!)!;
    for (const [he, pair] of endsOf) {
      const ok = (pair[0] === first && pair[1] === second) || (pair[0] === second && pair[1] === first);
      if (!ok)
        throw new Unmeasured(
          `bevelEdges: the two selected edges at vertex ${v} do not share a pair of ` +
            `rail ends (edge ${he}). That shape has not been measured.`,
        );
    }
    const pf = branchPos[-first - 1]!;
    const ps = branchPos[-second - 1]!;
    const interior = curve.slice(1, curve.length - 1).map(([sc, tc]) =>
      claim([
        vx + (pf[0] - vx) * sc + (ps[0] - vx) * tc,
        vy + (pf[1] - vy) * sc + (ps[1] - vy) * tc,
        vz + (pf[2] - vz) * sc + (ps[2] - vz) * tc,
      ]),
    );
    const rail = new Map<number, number[]>();
    for (const [he, pair] of endsOf) {
      rail.set(
        he,
        pair[0] === first
          ? [pair[0], ...interior, pair[1]]
          : [pair[0], ...[...interior].reverse(), pair[1]],
      );
    }
    branchInfo.set(v, { slide, corner, rail, bevelled, faces: fe.faces, edges: fe.edges });
  }
  } catch (e) {
    if (!(e instanceof Unmeasured)) throw e;
    // Not a shape the branch path knows. Put everything back and let the
    // greedy subset take it, loudly, exactly as it did before branches
    // existed. "Not measured" and "broken" are different, and only the first
    // one falls back.
    branching = false;
    branchInfo.clear();
    branchPos.length = 0;
  }

  if (branching) {
    canonical.clear();
    for (const he of all) canonical.add(he);
  }
  const skipped = all.size - canonical.size;
  if (outInfo) outInfo.skipped = skipped;
  // The editor opts into a partial result by passing `outInfo` and showing the
  // count; a caller that does not look at it gets a named failure instead of a
  // mesh that is half beveled and says nothing. Measured on a revolved rim
  // before branches worked: 12 of 24 edges silently dropped.
  if (skipped > 0 && !outInfo)
    throw new Error(
      `bevelEdges: ${skipped} of ${all.size} selected edges meet another selected ` +
        `edge at a vertex, in a configuration the branch case has not been measured ` +
        `on, so only a non-adjacent subset was beveled. Pass the third argument ` +
        `\`{ skipped: 0 }\` to accept the partial result and read how many were dropped.`,
    );
  if (canonical.size === 0)
    throw new Error(`bevelEdges: every selected edge was dropped. Nothing was beveled.`);

  for (const he of canonical) {
    const a = edgeOrigin(em, he);
    const b = edgeEnd(em, he);
    const twin = em.halfEdges[he]!.twin;
    const f1 = em.halfEdges[he]!.face;
    const f2 = em.halfEdges[twin]!.face;

    // Where each end slides to, per face. For a triangle this is the third
    // vertex, which is what this used to require; for any other arity it is
    // simply the neighbour along that face that is not the other end. Lifting
    // the restriction was that one line — a cube could not be beveled at all
    // before it, because every edge of one is held by quads.
    const ax = slideTarget(em, f1, a, b);
    const ay = slideTarget(em, f2, a, b);
    const bx = slideTarget(em, f1, b, a);
    const by = slideTarget(em, f2, b, a);
    if (ax < 0 || ay < 0 || bx < 0 || by < 0)
      throw new Error(
        `bevelEdges: edge ${a}-${b} has a face that does not give it a slide ` +
          `direction — the face may be degenerate or wound inconsistently.`,
      );

    // A vertex where two selected edges meet is already described by
    // `branchInfo`; the ordinary path assumes exactly one and would walk the
    // fan as though the second edge were not selected.
    const infoA = branchInfo.has(a)
      ? null
      : computeFanInfo(em, a, f1, f2, ax, ay, b, reach, "origin", curve);
    const infoB = branchInfo.has(b)
      ? null
      : computeFanInfo(em, b, f1, f2, bx, by, a, reach, "destination", curve);
    if ((!infoA && !branchInfo.has(a)) || (!infoB && !branchInfo.has(b)))
      throw new Error(
        `bevelEdges: the vertex fan at ${!infoA ? a : b} is not one this operator ` +
          `handles — it is non-manifold, or the two faces holding edge ${a}-${b} are ` +
          `not adjacent in it. Nothing was beveled.`,
      );

    if (infoA) vertInfo.set(a, infoA);
    if (infoB) vertInfo.set(b, infoB);
    bevels.push({ a, b, f1, f2, he });
  }

  // Allocate new vertex indices and append positions.
  const newPositions: number[] = Array.from(em.positions);
  let nextV = em.vertices.length;
  for (const info of vertInfo.values()) {
    info.railIdx = info.railPos.map((p) => {
      const idx = nextV++;
      newPositions.push(p[0], p[1], p[2]);
      return idx;
    });
    // The two rail ends *are* the new vertices on F1's and F2's other edges,
    // so they go into the same map as the interior ones. Every non-beveled
    // edge at the vertex then has exactly one new vertex, and a face around
    // it never has to know which kind it is looking at.
    info.slideIdx.set(info.xNeighbour, info.railIdx[0]!);
    info.slideIdx.set(info.yNeighbour, info.railIdx[info.railIdx.length - 1]!);
    for (const [nb, q] of info.slidePos) {
      const idx = nextV++;
      newPositions.push(q[0], q[1], q[2]);
      info.slideIdx.set(nb, idx);
    }
  }
  // The branch vertices' positions were collected as negative placeholders
  // while they were being worked out, so that adding them could not disturb
  // the ordinary path's numbering. They become real indices here.
  const branchBase = nextV;
  for (const q of branchPos) {
    newPositions.push(q[0], q[1], q[2]);
    nextV++;
  }
  const real = (placeholder: number): number => branchBase + (-placeholder - 1);

  const polys = toPolygons(em);
  const newPolys: number[][] = [];
  for (let f = 0; f < polys.length; f++) {
    const poly = polys[f]!;
    const grown: number[] = [];
    poly.forEach((v, i) => {
      const bm = branchInfo.get(v);
      if (bm) {
        // The face's own two edges at `v` decide this entirely: two selected
        // edges give the single corner vertex, one gives the slide on the
        // other (which is also that selected edge's rail end in this face),
        // and none gives both slides.
        const prev = poly[(i + poly.length - 1) % poly.length]!;
        const next = poly[(i + 1) % poly.length]!;
        const bp = bm.bevelled.has(prev);
        const bn = bm.bevelled.has(next);
        if (bp && bn) grown.push(real(bm.corner.get(f)!));
        else if (bp) grown.push(real(bm.slide.get(next)!));
        else if (bn) grown.push(real(bm.slide.get(prev)!));
        else grown.push(real(bm.slide.get(prev)!), real(bm.slide.get(next)!));
        return;
      }
      const info = vertInfo.get(v);
      if (!info) {
        grown.push(v);
        return;
      }
      const last = info.railIdx.length - 1;
      if (f === info.f1) grown.push(info.railIdx[0]!);
      else if (f === info.f2) grown.push(info.railIdx[last]!);
      else if (info.absorb === f) {
        // Nothing but this one face sits between F1 and F2, so there is no
        // corner polygon to hold the rail's interior points and they live
        // here instead. Measured on a cube, where the third face at the
        // vertex goes from a quad to a (4 + segments)-gon.
        const run = absorbOrder(em, f, v, info) ? info.railIdx : [...info.railIdx].reverse();
        grown.push(...run);
      } else {
        // An intermediate face: the vertex becomes the two new vertices on
        // this face's own two edges, so a triangle becomes a quad. Measured
        // on the octahedron, where Blender turns (-Y, +X, +Z) into
        // (-Y, slide(-Y), slide(+Z), +Z).
        const prev = poly[(i + poly.length - 1) % poly.length]!;
        const next = poly[(i + 1) % poly.length]!;
        const a = info.slideIdx.get(prev);
        const b = info.slideIdx.get(next);
        if (a !== undefined && b !== undefined) grown.push(a, b);
        // Open fans keep the pre-2026-09-18 behaviour: there is no closed
        // ring to build a corner from, and no measurement of what Blender
        // does at a boundary, so the arcs still take one rail end each.
        else if (info.arcF1.has(f)) grown.push(info.railIdx[0]!);
        else if (info.arcF2.has(f)) grown.push(info.railIdx[last]!);
        else grown.push(v);
      }
    });
    newPolys.push(grown);
  }

  // Chamfer: `segments` quads spanning the two rail runs.
  const chamferStart = newPolys.length;
  const railAt = (v: number, he: number): number[] => {
    const bm = branchInfo.get(v);
    if (bm) return bm.rail.get(he)!.map(real);
    return vertInfo.get(v)!.railIdx;
  };
  for (const { a, b, he } of bevels) {
    const ra = railAt(a, he);
    const rb = railAt(b, he);
    for (let k = 0; k < segments; k++)
      newPolys.push([ra[k]!, ra[k + 1]!, rb[k + 1]!, rb[k]!]);
  }
  const chamferEnd = newPolys.length;

  // The corner. Blender closes it with the whole ring of new vertices — the
  // rail, then the interior slides walked back the other way — and emits that
  // ring as a single polygon: a triangle at a valence-4 vertex, a pentagon at
  // a valence-6 one, a hexagon once `segments` is 2.
  //
  // The one exception is measured rather than reasoned: at a valence-4 vertex
  // with more than one segment, Blender fans the ring from the single interior
  // slide instead of emitting it whole. It does not do that at valence 6.
  for (const info of vertInfo.values()) {
    if (info.absorb >= 0 || info.ringNeighbours.length === 0) continue;
    const orient = (ring: number[]): number[] =>
      info.role === "origin" ? [...ring].reverse() : ring;
    if (info.ringNeighbours.length === 1 && segments > 1) {
      const x = info.slideIdx.get(info.ringNeighbours[0]!)!;
      for (let k = 0; k < segments; k++)
        newPolys.push(orient([info.railIdx[k]!, info.railIdx[k + 1]!, x]));
    } else {
      newPolys.push(
        orient([
          ...info.railIdx,
          ...[...info.ringNeighbours].reverse().map((nb) => info.slideIdx.get(nb)!),
        ]),
      );
    }
  }

  // The beveled vertices themselves are gone — every face that used one now
  // uses a rail instead. Compacting says so: Blender reports a cube's single
  // beveled edge as 8 verts becoming 10, not 12 with two unreferenced, and an
  // orphan would travel all the way into the glTF.
  const referenced = new Set<number>();
  for (const poly of newPolys) for (const v of poly) referenced.add(v);
  const remap = new Int32Array(newPositions.length / 3).fill(-1);
  const kept: number[] = [];
  for (let v = 0; v < newPositions.length / 3; v++) {
    if (!referenced.has(v)) continue;
    remap[v] = kept.length / 3;
    kept.push(newPositions[v * 3]!, newPositions[v * 3 + 1]!, newPositions[v * 3 + 2]!);
  }

  rebuildPolygons(
    em,
    new Float32Array(kept),
    newPolys.map((poly) => poly.map((v) => remap[v]!)),
  );

  const newSel = new Set<number>();
  for (let i = chamferStart; i < chamferEnd; i++) newSel.add(i);
  return newSel;
}

/**
 * The vertex `a` slides toward along face `f`: its neighbour in `f` that is
 * not `b`.
 *
 * For a triangle this is the third vertex, which is all the old
 * implementation could handle. For a quad or an n-gon it is still exactly one
 * vertex, which is why the triangle restriction turned out to be a property of
 * the helper rather than of the algorithm.
 */
function slideTarget(em: EditMesh, f: number, a: number, b: number): number {
  const verts = faceVerts(em, f);
  const i = verts.indexOf(a);
  if (i < 0) return -1;
  const prev = verts[(i + verts.length - 1) % verts.length]!;
  const next = verts[(i + 1) % verts.length]!;
  if (next !== b) return next;
  if (prev !== b) return prev;
  return -1;
}

/**
 * True when face `f`'s rail run should read forward (rail 0 first).
 *
 * The run has to enter the face from the side F1 is on, or the polygon crosses
 * itself. `arcF1`'s side is the one whose shared edge at `v` leads to F1.
 */
function absorbOrder(em: EditMesh, f: number, v: number, info: { arcF1: Set<number> }): boolean {
  const verts = faceVerts(em, f);
  const i = verts.indexOf(v);
  if (i < 0) return true;
  const prev = verts[(i + verts.length - 1) % verts.length]!;
  // The face sharing edge (prev, v) with `f`: if that is in arcF1, the run
  // enters from rail 0.
  for (let he = 0; he < em.halfEdges.length; he++) {
    const h = em.halfEdges[he]!;
    if (h.face !== f) continue;
    if (h.v !== prev || em.halfEdges[h.next]!.v !== v) continue;
    if (h.twin < 0) return true;
    return info.arcF1.has(em.halfEdges[h.twin]!.face);
  }
  return true;
}

// ── Bevel helpers ──────────────────────────────────────────────────────────

/** What {@link computeFanInfo} hands back for one end of a beveled edge. */
interface FanInfoOut {
  role: "origin" | "destination";
  railPos: Array<[number, number, number]>;
  railIdx: number[];
  arcF1: Set<number>;
  arcF2: Set<number>;
  absorb: number;
  /** The two faces holding the beveled edge. */
  f1: number;
  f2: number;
  /** F1's face-mate of the vertex — the edge rail 0 slides along. */
  xNeighbour: number;
  /** F2's, for the far end of the rail. */
  yNeighbour: number;
  /**
   * The interior edges at the vertex, named by their far vertex, in fan order
   * from F1's side to F2's. One per face boundary between the intermediates,
   * so `intermediates - 1` of them, and empty when a single face absorbs.
   */
  ringNeighbours: number[];
  /** A new vertex per interior edge, before indices are handed out. */
  slidePos: Map<number, [number, number, number]>;
  /** Every non-beveled edge at the vertex -> its new vertex. Rail ends included. */
  slideIdx: Map<number, number>;
}

/**
 * The ordered edges around a closed vertex fan, named by their far vertex.
 *
 * `walkFanFull` gives the faces; the edge between two consecutive ones is the
 * vertex they share other than `v`. For a closed fan of n faces there are n
 * such edges, and they are what the bevel cares about: every one of them
 * either carries a beveled edge or receives a new vertex.
 */
function fanEdges(em: EditMesh, v: number, startFace: number): { faces: number[]; edges: number[] } | null {
  const walk = walkFanFull(em, v, startFace);
  if (!walk || !walk.closed) return null;
  const faces = walk.fan;
  const edges: number[] = [];
  for (let i = 0; i < faces.length; i++) {
    const nb = sharedNonVertex(em, faces[i]!, faces[(i + 1) % faces.length]!, v);
    if (nb < 0) return null;
    edges.push(nb);
  }
  return { faces, edges };
}

/**
 * Where two beveled edges meeting in one face put their shared corner.
 *
 * Each of them wants a line in the face at `dist` from itself; the corner is
 * where those two lines cross. On the bisector that is `dist / sin(half the
 * angle between them)` from the vertex, which is why a sharp corner pushes the
 * point a long way in and a flat one barely moves it.
 *
 * Measured on a cube with two adjacent top edges beveled by 0.25: the two
 * edges meet at 90 degrees, so the point sits 0.3536 along the diagonal and
 * lands on (0.25, -0.25, 0.5) — exactly what Blender wrote.
 */
function faceCorner(
  em: EditMesh,
  v: number,
  n1: number,
  n2: number,
  dist: number,
): [number, number, number] {
  const vx = em.positions[v * 3]!;
  const vy = em.positions[v * 3 + 1]!;
  const vz = em.positions[v * 3 + 2]!;
  const dir = (to: number): [number, number, number] => {
    const d: [number, number, number] = [
      em.positions[to * 3]! - vx,
      em.positions[to * 3 + 1]! - vy,
      em.positions[to * 3 + 2]! - vz,
    ];
    const l = Math.hypot(d[0], d[1], d[2]) || 1;
    return [d[0] / l, d[1] / l, d[2] / l];
  };
  const u1 = dir(n1);
  const u2 = dir(n2);
  const bx = u1[0] + u2[0];
  const by = u1[1] + u2[1];
  const bz = u1[2] + u2[2];
  const bl = Math.hypot(bx, by, bz);
  // Straight through: the two edges are opposite, there is no corner to find
  // and the bisector is undefined. Fall back to the offset along one of them,
  // which is what a flat corner means.
  if (bl < 1e-9) return [vx + u1[0] * dist, vy + u1[1] * dist, vz + u1[2] * dist];
  const cosFull = Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1] + u1[2] * u2[2]));
  const sinHalf = Math.sqrt(Math.max(1e-12, (1 - cosFull) / 2));
  const t = dist / sinHalf;
  return [vx + (bx / bl) * t, vy + (by / bl) * t, vz + (bz / bl) * t];
}

/**
 * Compute fan info for a vertex `v` belonging to a bevel with F1/F2.
 * Returns null if the fan is unsupported.
 *
 * Fan walking: CCW around `v` via `twin.next`. F1 and F2 are always adjacent
 * in the fan (they share the bevel edge), so exactly one of the two CCW arcs
 * (F1→F2 or F2→F1) is empty.
 *
 * What happens to that arc is the one place forge3d and Blender part company,
 * and it depends on how many faces are in it:
 *
 *  - **exactly one** — the usual case, and every vertex of a box. That face
 *    absorbs the whole rail run and no corner polygon is added, which is what
 *    Blender does: measured on a cube, where the third face at the vertex goes
 *    from a quad to a `(4 + segments)`-gon and the face count rises by exactly
 *    the number of chamfer quads.
 *  - **two or more** — every interior edge gets a new vertex of its own, each
 *    intermediate face takes the two that sit on its own edges (a triangle
 *    becomes a quad), and the ring of new vertices closes the corner.
 *
 * Those are not two rules but one: a new vertex on every edge at `v` that is
 * not the beveled one, and a corner polygon of all of them. With a single
 * intermediate there are only two such edges, the ring degenerates to a
 * 2-gon and vanishes, and "absorb" is what that looks like from outside.
 *
 * Measured on an octahedron (valence 4) and a hexagonal bipyramid (valence 6,
 * and valence 4 at the other end of the same edge), at 1 and 2 segments. The
 * interior slides sit at the same *distance* along their edges as the rail,
 * not the same fraction: the bipyramid's equator vertex has a 0.2 edge and a
 * 0.32 one, and Blender put both new vertices 0.05 from it.
 */
function computeFanInfo(
  em: EditMesh,
  v: number,
  f1: number,
  f2: number,
  x: number,
  y: number,
  /** The beveled edge's other end, which OFFSET measures perpendicular to. */
  other: number,
  reach: { kind: "PERCENT" | "OFFSET"; amount: number },
  role: "origin" | "destination",
  curve: ReadonlyArray<readonly [number, number]>,
): FanInfoOut | null {
  const walk = walkFanFull(em, v, f1);
  if (!walk) return null;
  const { fan, closed } = walk;
  const f1idx = fan.indexOf(f1);
  const f2idx = fan.indexOf(f2);
  if (f1idx < 0 || f2idx < 0) return null;

  const vx = em.positions[v * 3]!;
  const vy = em.positions[v * 3 + 1]!;
  const vz = em.positions[v * 3 + 2]!;
  const edgeLen = (to: number): number =>
    Math.hypot(
      em.positions[to * 3]! - vx,
      em.positions[to * 3 + 1]! - vy,
      em.positions[to * 3 + 2]! - vz,
    );
  const lenX = edgeLen(x);
  const lenY = edgeLen(y);
  // PERCENT walks the same *fraction* of each of the two edges, so on edges of
  // different lengths it lands at different distances; OFFSET walks the same
  // distance along both. The interior slides then take a distance either way —
  // measured, see the note above.
  //
  // In OFFSET the amount is *not* a distance along the adjacent edge: Blender
  // measures it perpendicular to the beveled edge, so the walk along an edge
  // meeting it at an angle has to be divided by the sine of that angle.
  // Measured on the bipyramid, where the two differ by a factor of 1.053 and
  // the direction is identical. The interior slides, in the same run, sit at
  // the amount *along* their own edges — the two kinds of new vertex do not
  // use the same measure, which is not something the names suggest.
  const unit = (to: number): [number, number, number] => {
    const d: [number, number, number] = [
      em.positions[to * 3]! - vx,
      em.positions[to * 3 + 1]! - vy,
      em.positions[to * 3 + 2]! - vz,
    ];
    const l = Math.hypot(d[0], d[1], d[2]) || 1;
    return [d[0] / l, d[1] / l, d[2] / l];
  };
  const alongBevel = unit(other);
  const sineTo = (to: number): number => {
    const u = unit(to);
    const c = u[0] * alongBevel[0] + u[1] * alongBevel[1] + u[2] * alongBevel[2];
    return Math.sqrt(Math.max(1e-12, 1 - c * c));
  };
  const along = (len: number, to: number): number =>
    reach.kind === "PERCENT"
      ? reach.amount
      : len > 1e-12
        ? reach.amount / (len * sineTo(to))
        : 0;
  const dist = reach.kind === "PERCENT" ? (reach.amount * (lenX + lenY)) / 2 : reach.amount;

  // The rail run, laid out on the profile curve in the corner's own plane.
  // `curve` is in coordinates measured from the outer corner of the square the
  // two slide directions span, so (1,0) is the F1 rail end and (0,1) the F2 one.
  const p0 = lerpPos(em, v, x, along(lenX, x));
  const p1 = lerpPos(em, v, y, along(lenY, y));
  const railPos: Array<[number, number, number]> = curve.map(([s, t]) => [
    vx + (p0[0] - vx) * s + (p1[0] - vx) * t,
    vy + (p0[1] - vy) * s + (p1[1] - vy) * t,
    vz + (p0[2] - vz) * s + (p1[2] - vz) * t,
  ]);

  const arcF1 = new Set<number>([f1]);
  const arcF2 = new Set<number>([f2]);
  let absorb = -1;
  const ringNeighbours: number[] = [];
  const slidePos = new Map<number, [number, number, number]>();
  const slideIdx = new Map<number, number>();
  const base = {
    role,
    railPos,
    railIdx: [] as number[],
    arcF1,
    arcF2,
    absorb,
    f1,
    f2,
    xNeighbour: x,
    yNeighbour: y,
    ringNeighbours,
    slidePos,
    slideIdx,
  };
  // How far along an edge a new vertex goes. `w` is a proportion of F1's and
  // F2's own edges, so it has to become a distance before it can be applied to
  // an interior edge of a different length — see the note on the bipyramid
  // above. When the two differ their mean is used, which is not measured:
  // every case so far has had them equal.
  const slideAlong = (from: number, to: number): [number, number, number] => {
    const len = Math.hypot(
      em.positions[to * 3]! - em.positions[from * 3]!,
      em.positions[to * 3 + 1]! - em.positions[from * 3 + 1]!,
      em.positions[to * 3 + 2]! - em.positions[from * 3 + 2]!,
    );
    return lerpPos(em, from, to, len > 1e-12 ? dist / len : 0);
  };

  if (!closed) {
    // Open fan: v lies on the mesh boundary. The fan splits at the bevel edge
    // into two contiguous arcs that each terminate at a boundary, so there is
    // no gap to seal.
    if (Math.abs(f1idx - f2idx) !== 1) return null;
    if (f1idx < f2idx) {
      for (let i = 0; i <= f1idx; i++) arcF1.add(fan[i]!);
      for (let i = f2idx; i < fan.length; i++) arcF2.add(fan[i]!);
    } else {
      for (let i = 0; i <= f2idx; i++) arcF2.add(fan[i]!);
      for (let i = f1idx; i < fan.length; i++) arcF1.add(fan[i]!);
    }
    return base;
  }

  // Closed fan: F1 sits at index 0 (the CCW walk started from it).
  const ccwArcA = fan.slice(1, f2idx);
  const ccwArcB = fan.slice(f2idx + 1);

  if (ccwArcA.length === 0 && ccwArcB.length === 0) {
    // Fan of two: nothing between F1 and F2, so nothing to absorb or close.
    return base;
  }

  // The intermediates, ordered from F1's side to F2's. Only one of the two
  // CCW arcs can be non-empty, because F1 and F2 share the beveled edge.
  let intermediates: number[];
  if (ccwArcA.length > 0 && ccwArcB.length === 0) intermediates = ccwArcA;
  else if (ccwArcB.length > 0 && ccwArcA.length === 0) intermediates = [...ccwArcB].reverse();
  else return null;

  if (intermediates.length === 1) {
    base.absorb = intermediates[0]!;
    return base;
  }

  for (let i = 0; i + 1 < intermediates.length; i++) {
    const nb = sharedNonVertex(em, intermediates[i]!, intermediates[i + 1]!, v);
    if (nb < 0) return null;
    ringNeighbours.push(nb);
    slidePos.set(nb, slideAlong(v, nb));
  }
  return base;
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
  // A loop cut walks the *ring* — the faces the new loop will be cut into —
  // and the triangle-pair rule below is what lets it cross a triangulated
  // cage. `selectEdgeRing` without that option is Blender's ring select.
  const loop = walkEdgeRing(em, seedCanonical, { throughTrianglePairs: true }).edges;
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

// ── Rotate Edges / Flip Diagonal (tri-only) ────────────────────────────────

/**
 * Rotate the shared edge of two adjacent triangles — Blender's
 * `bmesh.ops.rotate_edges(edges=)`, "Rotate Edge" in the Edge menu.
 *
 * The edge a-b held by triangles (a, b, c) and (b, a, d) is replaced by c-d,
 * re-triangulating the quad they cover along its other diagonal. Edges whose
 * two faces are not both triangles are skipped: a quad has no diagonal to
 * rotate, so run `quadsToTris` first if that is what you meant.
 *
 * Takes half-edge indices, canonicalised internally, and returns the faces it
 * re-triangulated — the same contract as the other operators here.
 *
 * Blender's `use_ccw` is not implemented. With two triangles there is only one
 * other diagonal, so the direction only decides which of the two resulting
 * triangles is listed first, which nothing downstream here reads.
 *
 * > This used to be exported as `knife`, which was wrong twice over: Blender's
 * > Knife is the interactive cut tool (forge3d's is `planeCut` in `knife.ts`),
 * > and the operation is a diagonal flip, not a cut. The editor's own label
 * > said "Flip Diagonal" while the library said `knife`.
 */
export function rotateEdges(em: EditMesh, selectedEdges: ReadonlySet<number>): Set<number> {
  // Resolve every target to a vertex pair BEFORE touching anything: each flip
  // rebuilds the polygon list, which invalidates half-edge indices.
  const pairs: Array<[number, number]> = [];
  for (const he of selectedEdges) {
    const h = em.halfEdges[he];
    if (!h || h.twin < 0) continue;
    const a = h.v;
    const b = em.halfEdges[h.next]!.v;
    pairs.push(a < b ? [a, b] : [b, a]);
  }

  const touched = new Set<number>();
  for (const [a, b] of pairs) {
    // Re-find the edge: an earlier flip in this batch may have removed it.
    let found = -1;
    for (let he = 0; he < em.halfEdges.length && found < 0; he++) {
      const h = em.halfEdges[he]!;
      if (h.twin < 0) continue;
      const x = h.v;
      const y = em.halfEdges[h.next]!.v;
      if ((x === a && y === b) || (x === b && y === a)) found = he;
    }
    if (found < 0) continue;

    const f1 = em.halfEdges[found]!.face;
    const f2 = em.halfEdges[em.halfEdges[found]!.twin]!.face;
    if (faceVertexCount(em, f1) !== 3 || faceVertexCount(em, f2) !== 3) continue;

    // The two off-edge verts are what the flip connects.
    const c = faceVertices(em, f1).find((v) => v !== a && v !== b);
    const d = faceVertices(em, f2).find((v) => v !== a && v !== b);
    if (c === undefined || d === undefined || c === d) continue;

    if (flipDiagonal(em, found, c, d).size > 0) {
      touched.add(f1);
      touched.add(f2);
    }
  }
  return touched;
}

/**
 * Rotate an edge picked out by the two vertices it will connect — the editor's
 * entry point, where the user has a vertex selection rather than an edge one.
 *
 * Handles only the "adjacent tri" case: the two verts must be the off-edge
 * vertices of two triangles sharing an edge. Returns the (unchanged) input
 * vert set so the user's selection survives the operation; the new edge shows
 * up because the topology rebuild repopulates the line buffer.
 *
 * Not part of the public library API — `rotateEdges` is, and takes edges the
 * way Blender's `rotate_edges` does.
 */
export function flipDiagonalByVerts(em: EditMesh, selectedVerts: ReadonlySet<number>): Set<number> {
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
 * Merge vertex clusters: each cluster's members become ONE vertex, at the
 * cluster centroid unless `where` names a point for it — `collapseEdges` does,
 * because Blender puts an edge collapse at the mean of the edge midpoints
 * rather than at the mean of the vertices, and those differ whenever the run is
 * unevenly spaced. `where` is indexed by cluster, and a missing or undefined
 * entry means the centroid. Faces whose cycle collapses below 3 unique verts are
 * dropped; a quad losing one edge to the merge degrades to a triangle
 * (consecutive duplicate corners are collapsed). The vertex buffer is
 * compacted (unreferenced verts removed), and seam keys are remapped across
 * the compaction.
 *
 * Returns the merged vertices' NEW (compacted) indices.
 */
function mergeClusters(
  em: EditMesh,
  clusters: number[][],
  where?: ReadonlyArray<readonly [number, number, number] | undefined>,
): Set<number> {
  const P = em.positions;
  const remap = new Map<number, number>();
  const targets: number[] = [];

  for (let c = 0; c < clusters.length; c++) {
    const cluster = clusters[c]!;
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
    const at = where?.[c] ?? [cx / cluster.length, cy / cluster.length, cz / cluster.length];
    P[target * 3] = at[0];
    P[target * 3 + 1] = at[1];
    P[target * 3 + 2] = at[2];
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
 * Merge named vertices onto named targets — Blender's
 * `bmesh.ops.weld_verts(targetmap=)`.
 *
 * The key moves **onto** the target and the target does not move. That is what
 * separates this from {@link mergeAtCenter}, which puts the result at the
 * centroid, and from {@link collapseEdges}, which puts it at the mean of the
 * edge midpoints. All three merge; they differ only in where the survivor ends
 * up, and picking the wrong one is a silent few-millimetre error.
 *
 * A chain is followed to its end: given `a → b` and `b → c`, both `a` and `b`
 * land on `c`. A cycle has no terminal and is refused rather than resolved
 * arbitrarily — Blender's own behaviour there is undefined, so guessing would
 * be inventing a rule and calling it compatibility.
 *
 * Returns the survivors' new (compacted) indices.
 */
export function weldVerts(em: EditMesh, targetmap: ReadonlyMap<number, number>): Set<number> {
  if (targetmap.size === 0) return new Set();

  /** Follow `v` through the map until it names a vertex that is not a key. */
  const terminal = (v: number): number => {
    let cur = v;
    for (let hops = 0; hops <= targetmap.size; hops++) {
      const next = targetmap.get(cur);
      // `next === cur` is a vertex welded to itself — a no-op, not a cycle.
      // Without this it spins to the hop limit and throws, and the `end === key`
      // guard below that is meant to drop it never runs.
      if (next === undefined || next === cur) return cur;
      cur = next;
    }
    throw new Error(
      `weldVerts: the targetmap cycles at vertex ${v} — there is no vertex for ` +
        `the merge to land on, and picking one would be inventing a rule.`,
    );
  };

  const byTarget = new Map<number, Set<number>>();
  for (const key of targetmap.keys()) {
    const end = terminal(key);
    if (end === key) continue;
    let group = byTarget.get(end);
    if (!group) {
      group = new Set([end]);
      byTarget.set(end, group);
    }
    group.add(key);
  }
  if (byTarget.size === 0) return new Set();

  const targets = [...byTarget.keys()];
  const P = em.positions;
  return mergeClusters(
    em,
    targets.map((t) => [...byTarget.get(t)!]),
    // The target keeps its place; only the keys move.
    targets.map((t) => [P[t * 3]!, P[t * 3 + 1]!, P[t * 3 + 2]!] as const),
  );
}

/**
 * Collapse each selected edge to its midpoint (Blender's Edge Collapse).
 * Edges sharing endpoints collapse together — union-find groups them into
 * clusters first, so collapsing a connected run of edges yields one vertex.
 *
 * ## Where the merged vertex lands
 *
 * At the **mean of the selected edges' midpoints**, which is not the same as
 * the mean of the vertices unless the run is evenly spaced. Measured against
 * `bmesh.ops.collapse` on four uneven chains:
 *
 * | vertices at x       | Blender | midpoint mean | vertex centroid |
 * |---------------------|---------|---------------|-----------------|
 * | 0, 1, 3             | 1.2500  | 1.2500        | 1.3333          |
 * | 0, 1, 5             | 1.7500  | 1.7500        | 2.0000          |
 * | 0, 1, 3, 7          | 2.5000  | 2.5000        | 2.7500          |
 * | 0, .25, .5, 4, 4.25 | 1.71875 | 1.71875       | 1.8000          |
 *
 * Effectively each vertex is weighted by how many selected edges touch it, so
 * the ends of a run count once and the interior twice. The vertex centroid
 * shipped here first and agreed on a cube — where the top face's four edges are
 * symmetric and every rule gives the centre — and was 1.7 mm out on a curved
 * cage. {@link mergeAtCenter} keeps the plain centroid, because Blender's
 * "Merge At Center" really is that.
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

  // The midpoint of each selected edge, kept so the merge point can be their
  // mean rather than the cluster's centroid.
  const P = em.positions;
  const midpoints: Array<[number, number, number]> = [];
  const ofEdge: number[] = [];
  for (const heRaw of selectedEdges) {
    const he = canonicalEdge(em, heRaw);
    const a = edgeOrigin(em, he);
    const b = edgeEnd(em, he);
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    union(a, b);
    midpoints.push([
      (P[a * 3]! + P[b * 3]!) / 2,
      (P[a * 3 + 1]! + P[b * 3 + 1]!) / 2,
      (P[a * 3 + 2]! + P[b * 3 + 2]!) / 2,
    ]);
    ofEdge.push(a);
  }

  const byRoot = new Map<number, number[]>();
  for (const v of parent.keys()) {
    const r = find(v);
    let l = byRoot.get(r);
    if (!l) { l = []; byRoot.set(r, l); }
    l.push(v);
  }

  const roots = [...byRoot.keys()];
  const sums = new Map<number, [number, number, number, number]>();
  for (let i = 0; i < midpoints.length; i++) {
    const r = find(ofEdge[i]!);
    const s = sums.get(r) ?? [0, 0, 0, 0];
    s[0] += midpoints[i]![0];
    s[1] += midpoints[i]![1];
    s[2] += midpoints[i]![2];
    s[3] += 1;
    sums.set(r, s);
  }
  const where = roots.map((r) => {
    const s = sums.get(r);
    return s ? ([s[0] / s[3], s[1] / s[3], s[2] / s[3]] as const) : undefined;
  });

  return mergeClusters(em, roots.map((r) => byRoot.get(r)!), where);
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
  // A face that already exists is not created again — bmesh refuses to, and
  // the case it protects against is not exotic: bridge the two rims of a tube
  // and every quad of the band lands exactly on a quad of the wall. Without
  // this, that comes back as a double-walled tube (24 faces where 12 are
  // copies), which renders, measures and subdivides like a tube right up
  // until something z-fights or a weld halves it.
  const existing = new Set(newPolys.map((p) => [...p].sort((x, y) => x - y).join(",")));
  const quads = A.cycle ? n : n - 1;
  for (let i = 0; i < quads; i++) {
    const a0 = A.verts[i]!;
    const a1 = A.verts[(i + 1) % n]!;
    const b0 = bRev[(off + i) % n]!;
    const b1 = bRev[(off + i + 1) % n]!;
    // Quad (a1, a0, b0, b1): crosses A's boundary edge reversed (a1→a0) and
    // B's boundary edge reversed (b0→b1 in reverse walk) — both manifold.
    const quad = [a1, a0, b0, b1];
    if (existing.has([...quad].sort((x, y) => x - y).join(","))) continue;
    newPolys.push(quad);
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
  maxShapeAngleDeg = 40,
): Set<number> {
  const cosLimit = Math.cos((maxAngleDeg * Math.PI) / 180);
  const shapeLimit = (maxShapeAngleDeg * Math.PI) / 180;
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
    if (worstCornerDeviation(em.positions, quad) > shapeLimit) return;
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
/**
 * How far the worst corner of a quad is from a right angle, in radians.
 *
 * The rejection test, where {@link quadAngleError} (the sum over all four) is
 * only the ranking. Two triangles can meet in a perfectly flat plane and still
 * make a sliver, and a sliver quad is worse than the two triangles it replaced.
 */
function worstCornerDeviation(P: Float32Array, quad: readonly number[]): number {
  let worst = 0;
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
    if (lu < 1e-12 || lv < 1e-12) return Math.PI;
    const cos = Math.max(-1, Math.min(1, (ux * vx + uy * vy + uz * vz) / (lu * lv)));
    worst = Math.max(worst, Math.abs(Math.acos(cos) - Math.PI / 2));
  }
  return worst;
}

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

/** Options for {@link insetRegion}, named as `bmesh.ops.inset_region` names them. */
export interface InsetRegionOptions {
  /**
   * How far the border moves in, along each border vertex's angle bisector.
   *
   * **Not a perpendicular distance** unless {@link useEvenOffset} is on — a
   * right-angled corner inset by 0.2 ends up 0.2/sqrt(2) = 0.1414 from each of
   * its edges. Measured against Blender 5.1.1, whose default this is.
   */
  thickness: number;
  /** Push the inset region along its normal afterwards. Moves the whole region. */
  depth?: number;
  /**
   * Inset the part of the border that is also the **mesh's** boundary.
   *
   * **Defaults to false**, which is `bmesh.ops.inset_region`'s default and the
   * opposite of what the Inset tool in Blender's UI does. On an open surface
   * where every border edge is a mesh boundary, leaving it off means the
   * operation does nothing at all — measured, and the kind of silence worth
   * knowing about before it looks like a bug.
   */
  useBoundary?: boolean;
  /**
   * Measure `thickness` perpendicular to each border edge instead of along the
   * bisector, so a mitred frame has one width all the way round.
   *
   * This is what {@link insetFacesByWidth} already does per face.
   */
  useEvenOffset?: boolean;
  /** Not implemented — passing true throws rather than insetting differently. */
  useRelativeOffset?: boolean;
  /** Not implemented — passing true throws. */
  useOutset?: boolean;
}

/**
 * Inset a face selection as **one region**: only the border of the selection
 * moves in, and faces inside it keep the edges they share.
 *
 * Blender's `bmesh.ops.inset_region(faces=, thickness=, depth=, use_boundary=,
 * use_even_offset=)`, and the mode the Inset tool uses unless you press I
 * twice.
 *
 * This is the one that was missing. {@link insetFaces} and
 * {@link insetFacesByWidth} are both *individual* mode — every selected face
 * gets its own ring and its own cap, so two faces that touch come back as two
 * separate insets with a seam between them. Insetting the four faces at the
 * top of a limb that way gives four stubs instead of one socket, and the
 * industry default being the other way round makes it a trap rather than a
 * preference.
 *
 * Topology, measured against Blender on a cube's top face: the border vertices
 * stay where they are (the faces outside the region still need them), a new
 * ring is created inside, the region's faces are re-pointed at the new ring,
 * and one quad per border edge bridges the two. 8 verts and 6 faces become 12
 * and 10.
 *
 * Returns the re-pointed region faces, so insets chain the way extrudes do.
 */
export function insetRegion(
  em: EditMesh,
  selectedFaces: ReadonlySet<number>,
  opts: InsetRegionOptions,
): Set<number> {
  if (opts.useRelativeOffset)
    throw new Error(
      "insetRegion: useRelativeOffset is not implemented. Blender scales the " +
        "thickness by the adjacent edge lengths; silently ignoring the flag " +
        "would inset by the wrong amount rather than fail.",
    );
  if (opts.useOutset)
    throw new Error("insetRegion: useOutset is not implemented — this only insets inward.");

  const depth = opts.depth ?? 0;
  if (selectedFaces.size === 0) return new Set(selectedFaces);
  if (opts.thickness <= 0 && depth === 0) return new Set(selectedFaces);

  const polys = toPolygons(em);
  const P = em.positions;

  /** Unit Newell normal for a polygon. */
  const normalOf = (poly: readonly number[]): [number, number, number] => {
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]! * 3;
      const b = poly[(i + 1) % poly.length]! * 3;
      nx += (P[a + 1]! - P[b + 1]!) * (P[a + 2]! + P[b + 2]!);
      ny += (P[a + 2]! - P[b + 2]!) * (P[a]! + P[b]!);
      nz += (P[a]! - P[b]!) * (P[a + 1]! + P[b + 1]!);
    }
    const len = Math.hypot(nx, ny, nz);
    return len < 1e-20 ? [0, 0, 0] : [nx / len, ny / len, nz / len];
  };

  // An edge used by exactly one *selected* face is on the region's border. One
  // used by exactly one face overall is on the mesh's boundary as well, and
  // those are the ones `useBoundary` decides about.
  const selUse = new Map<string, number>();
  const allUse = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string): void => {
    m.set(k, (m.get(k) ?? 0) + 1);
  };
  for (let f = 0; f < polys.length; f++) {
    const poly = polys[f]!;
    for (let i = 0; i < poly.length; i++) {
      const k = seamKey(poly[i]!, poly[(i + 1) % poly.length]!);
      bump(allUse, k);
      if (selectedFaces.has(f)) bump(selUse, k);
    }
  }

  const borderKeys = new Set<string>();
  const insetKeys = new Set<string>();
  for (const [k, n] of selUse) {
    if (n !== 1) continue;
    borderKeys.add(k);
    if (allUse.get(k) === 1 && !opts.useBoundary) continue; // mesh boundary, left alone
    insetKeys.add(k);
  }

  const borderVerts = new Set<number>();
  const dupVerts = new Set<number>();
  for (const k of borderKeys) for (const s of k.split("_")) borderVerts.add(Number(s));
  for (const k of insetKeys) for (const s of k.split("_")) dupVerts.add(Number(s));

  // Per vertex: the inward perpendiculars of its border edges, and the region's
  // normal there. `cross(faceNormal, edgeDirection)` points into the face
  // because the winding runs counter-clockwise about the normal.
  const perps = new Map<number, [number, number, number][]>();
  const normals = new Map<number, [number, number, number]>();
  const regionVerts = new Set<number>();

  for (const f of selectedFaces) {
    const poly = polys[f]!;
    const n = normalOf(poly);
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      regionVerts.add(a);

      const prev = normals.get(a) ?? [0, 0, 0];
      normals.set(a, [prev[0] + n[0], prev[1] + n[1], prev[2] + n[2]]);

      if (!insetKeys.has(seamKey(a, b))) continue;
      const e = unit3([P[b * 3]! - P[a * 3]!, P[b * 3 + 1]! - P[a * 3 + 1]!, P[b * 3 + 2]! - P[a * 3 + 2]!]);
      const m = unit3(cross3(n, e));
      for (const v of [a, b]) {
        const list = perps.get(v);
        if (list) list.push(m);
        else perps.set(v, [m]);
      }
    }
  }

  const newPositions: number[] = Array.from(P);
  let nextV = em.vertices.length;
  const dup = new Map<number, number>();

  for (const v of [...dupVerts].sort((x, y) => x - y)) {
    const ms = perps.get(v) ?? [];
    const n = unit3(normals.get(v) ?? [0, 0, 0]);
    let bx = 0;
    let by = 0;
    let bz = 0;
    for (const m of ms) {
      bx += m[0];
      by += m[1];
      bz += m[2];
    }
    const b = unit3([bx, by, bz]);
    // 1 / cos(half angle), clamped — a near-spike corner would run away.
    const cosHalf = ms.length > 0 ? b[0] * ms[0]![0] + b[1] * ms[0]![1] + b[2] * ms[0]![2] : 1;
    const reach = opts.useEvenOffset ? opts.thickness / Math.max(0.2, cosHalf) : opts.thickness;

    dup.set(v, nextV++);
    newPositions.push(
      P[v * 3]! + b[0] * reach + n[0] * depth,
      P[v * 3 + 1]! + b[1] * reach + n[1] * depth,
      P[v * 3 + 2]! + b[2] * reach + n[2] * depth,
    );
  }

  // `depth` moves the whole region, so the vertices inside it travel too —
  // measured on a 2x2 grid, whose middle vertex moves with the rest.
  if (depth !== 0) {
    for (const v of regionVerts) {
      if (borderVerts.has(v)) continue;
      const n = unit3(normals.get(v) ?? [0, 0, 0]);
      newPositions[v * 3] = newPositions[v * 3]! + n[0] * depth;
      newPositions[v * 3 + 1] = newPositions[v * 3 + 1]! + n[1] * depth;
      newPositions[v * 3 + 2] = newPositions[v * 3 + 2]! + n[2] * depth;
    }
  }

  // Emit unselected, then skirts, then the caps — so the caps are contiguous
  // at the end and the returned set is a range.
  const newPolys: number[][] = [];
  for (let f = 0; f < polys.length; f++) if (!selectedFaces.has(f)) newPolys.push(polys[f]!);

  for (const f of selectedFaces) {
    const poly = polys[f]!;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      if (!insetKeys.has(seamKey(a, b))) continue;
      newPolys.push([a, b, dup.get(b)!, dup.get(a)!]);
    }
  }

  const capStart = newPolys.length;
  for (const f of selectedFaces) newPolys.push(polys[f]!.map((v) => dup.get(v) ?? v));
  const capEnd = newPolys.length;

  rebuildPolygons(em, new Float32Array(newPositions), newPolys);

  const newSel = new Set<number>();
  for (let i = capStart; i < capEnd; i++) newSel.add(i);
  return newSel;
}

const unit3 = (v: readonly [number, number, number]): [number, number, number] => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l < 1e-12 ? [0, 0, 0] : [v[0] / l, v[1] / l, v[2] / l];
};

const cross3 = (
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): [number, number, number] => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

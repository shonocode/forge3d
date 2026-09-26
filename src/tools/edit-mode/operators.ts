import { orphanedEdges } from "./wire";
import { interpWeightsPoly } from "./interp";
import { canonicalEdge, edgeEnd, edgeOrigin, faceHalfEdges, facePolyNormal, faceVertexCount, faceVerts, faceVertices, forEachEdge, rebuildPolygons, seamKey, toPolygons, type EditMesh, type ExplicitFace, type VertexOrigin } from "./half-edge";
import { catmullClark } from "./subdivide";
import { selectEdgeRing } from "./edge-walk";
import { carryEdgeFlags, subdivideEdges, type SubdivideFalloff } from "./refine";
import { edgeringInterpolate, edgeringPlan, type EdgeringInterpolation } from "./edgering-interp";
import { bevelMesh } from "../bevel/bevel";
import type { MeshData } from "../../lib/mesh";

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
  // The edges of the deleted faces that nothing else uses stay, with no face
  // on them — `context='FACES_ONLY'`, which is what this operator's JSDoc
  // already claimed to match. It did not until 2026-09-22, and **nothing could
  // see that**: distance, area, volume, `facing` and both counts are computed
  // from polygons. `body` was 0 against Blender's 80.
  em.wireEdges = [...(em.wireEdges ?? []), ...orphanedEdges(polys, kept)];
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
 *
 * `opts.wallsFrom`: where a wall's corners come from. `"lower"` (default) is
 * `bmesh.ops.extrude_face_region` handed the faces alone — the
 * lower-numbered of the region face and the face across. `"outside"` is the
 * UI's Extrude Region and Extrude Repeat, which pass the edges too and delete
 * the originals first, so a wall copies the face across (the region face
 * where there is none) — `extrude-repeat-layers`.
 */
export function extrudeFaces(
  em: EditMesh,
  selectedFaces: ReadonlySet<number>,
  opts: { wallsFrom?: "lower" | "outside" } = {},
): Set<number> {
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
  //
  //    The per-corner layers, Blender's way for `extrude_face_region` given
  //    the faces (`bmo_extrude_face_region_exec`): a cap is a copy of its
  //    face, corners and material. A skirt quad copies both corners at each
  //    end — the original vertex and its duplicate — and its material from
  //    one of the old faces on its edge (`bm_extrude_copy_face_loop_attributes`
  //    takes the loop after the new one in the edge's radial cycle). Given
  //    faces alone the originals are still there when the wall is made, so
  //    the edge has the region face and the face across; the new loop goes in
  //    after the edge's current loop, which is the last face built on it, so
  //    the loop after it is the **first**: the lower-numbered of the two. On
  //    the mesh's rim only the region face is there. (The UI's Extrude Region
  //    passes the edges too, deletes the originals first, and so always copies
  //    the face across — not what this answers.) A duplicate vertex copies
  //    its source's vertex data.
  const newPolys: number[][] = [];
  const stated: Array<ExplicitFace | undefined> = [];
  for (let f = 0; f < polys.length; f++) {
    if (!selectedFaces.has(f)) {
      newPolys.push(polys[f]!);
      stated.push(undefined);
    }
  }
  const origins = new Map<number, VertexOrigin>();
  for (const v of dupSource) origins.set(dupMap[v]!, { from: [v], w: [1] });


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
      const across = twin < 0 ? f : em.halfEdges[twin]!.face;
      const o = opts.wallsFrom === "outside" ? across : Math.min(f, across);
      const ca: [number, number, number][] = [[o, polys[o]!.indexOf(a), 1]];
      const cb: [number, number, number][] = [[o, polys[o]!.indexOf(b), 1]];
      stated.push({ corners: [ca, cb, cb, ca], material: o });
    }
  }

  // 5. Caps with duplicate refs — these become the new selection.
  const newSelStart = newPolys.length;
  for (const f of selectedFaces) {
    newPolys.push(polys[f]!.map((v) => dupMap[v]!));
    stated.push({ corners: polys[f]!.map((_, i) => [[f, i, 1] as const]), material: f });
  }
  const newSelEnd = newPolys.length;

  rebuildPolygons(em, new Float32Array(newPositions), newPolys, { origins, faces: stated });
  // The region's **interior** edges are left with no face on them: the new cap
  // is built on duplicated vertices and the skirt only takes up the boundary.
  // Measured — extruding a 4x4 grid leaves 24, which is exactly its interior
  // edge count, and Blender leaves the same 24.
  em.wireEdges = [...(em.wireEdges ?? []), ...orphanedEdges(polys, newPolys)];

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
/** Options for {@link insetFaces} beyond the fraction. */
export interface InsetFacesOptions {
  /**
   * The inner ring's positions per face (flat xyz, in the face's corner
   * order), instead of the fraction toward the centroid —
   * `insetFacesByWidth` works them out.
   */
  inner?: ReadonlyMap<number, readonly number[]>;
  /**
   * Blender's `use_interpolate` (off in `bmesh.ops.inset_individual`, on in
   * the UI's Inset): the inner face's corner data and its vertices' data are
   * re-interpolated over the old face's shape at the new positions — mean
   * value weights in the face's plane (`BM_face_interp_from_face_ex`), vertex
   * groups mixed by the same weights — and each rim quad's inner corners take
   * the interpolated values.
   */
  interpolate?: boolean;
}

export function insetFaces(
  em: EditMesh,
  selectedFaces: ReadonlySet<number>,
  amount: number,
  opts: InsetFacesOptions = {},
): Set<number> {
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
  type CapInfo = { orig: number[]; dups: number[]; face: number; weights: number[][] };
  const caps: CapInfo[] = [];
  const origins = new Map<number, VertexOrigin>();

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
    const given = opts.inner?.get(f);
    // The old face's plane, for interpolating over it.
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i]! * 3;
      const b = verts[(i + 1) % verts.length]! * 3;
      const P = em.positions;
      nx += (P[a + 1]! - P[b + 1]!) * (P[a + 2]! + P[b + 2]!);
      ny += (P[a + 2]! - P[b + 2]!) * (P[a]! + P[b]!);
      nz += (P[a]! - P[b]!) * (P[a + 1]! + P[b + 1]!);
    }
    const nl = Math.hypot(nx, ny, nz) || 1;
    const normal: [number, number, number] = [nx / nl, ny / nl, nz / nl];
    const weights: number[][] = [];
    const dups = verts.map((v, i) => {
      const x = em.positions[v * 3]!, y = em.positions[v * 3 + 1]!, z = em.positions[v * 3 + 2]!;
      const d = nextV++;
      const p: [number, number, number] = given
        ? [given[i * 3]!, given[i * 3 + 1]!, given[i * 3 + 2]!]
        : [x + (gx - x) * t, y + (gy - y) * t, z + (gz - z) * t];
      newPositions.push(p[0], p[1], p[2]);
      if (opts.interpolate) {
        const w = interpWeightsPoly(em.positions, verts, normal, p);
        weights.push(w);
        origins.set(d, { from: verts, w });
      } else origins.set(d, { from: [v], w: [1] });
      return d;
    });
    caps.push({ orig: verts, dups, face: f, weights });
  }

  // The per-corner layers as `bmo_face_inset_individual` sets them with
  // `use_interpolate` off (the op's default): the inner face is the old face,
  // corners and all, and each rim quad — made with the face as its example —
  // copies the face's corner at each end to both the outer vertex and the
  // inner one. (`use_interpolate`, the UI's default, re-interpolates the inner
  // face over the old one's shape — not ported, compat-backlog C12.)
  const stated: Array<ExplicitFace | undefined> = newPolys.map(() => undefined);

  // Skirts: each original edge vᵢ→vᵢ₊₁ becomes a (vᵢ, vᵢ₊₁, dupᵢ₊₁, dupᵢ) quad.
  // The face's original normal direction is preserved (CCW from outside).
  // An inner corner: the old corner, or with `interpolate` its mix.
  const innerCorner = (c: CapInfo, i: number): [number, number, number][] =>
    opts.interpolate ? c.weights[i]!.map((w, k) => [c.face, k, w] as [number, number, number]) : [[c.face, i, 1]];
  for (const c of caps) {
    const { orig, dups, face } = c;
    for (let i = 0; i < orig.length; i++) {
      const j = (i + 1) % orig.length;
      newPolys.push([orig[i]!, orig[j]!, dups[j]!, dups[i]!]);
      const ci: [number, number, number][] = [[face, i, 1]];
      const cj: [number, number, number][] = [[face, j, 1]];
      stated.push({ corners: [ci, cj, innerCorner(c, j), innerCorner(c, i)], material: face });
    }
  }

  // Caps (inner shrunk faces) — become the new selection.
  const capStart = newPolys.length;
  for (const c of caps) {
    newPolys.push(c.dups);
    stated.push({ corners: c.dups.map((_, i) => innerCorner(c, i)), material: c.face });
  }
  const capEnd = newPolys.length;

  rebuildPolygons(em, new Float32Array(newPositions), newPolys, { origins, faces: stated });

  const newSel = new Set<number>();
  for (let i = capStart; i < capEnd; i++) newSel.add(i);
  return newSel;
}

/**
 * Options for {@link bevelEdges}: `bmesh.ops.bevel`'s, in its units.
 *
 * Blender: `bmesh.ops.bevel(geom=, offset=, offset_type=, segments=, profile=,
 * affect='EDGES', clamp_overlap=False)`. `offset` is in the same units as
 * Blender's, measured the same way.
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
   * a percentage of each adjacent edge.
   */
  offset: number;
  /**
   * `'PERCENT'` (the default) measures `offset` as a percentage of each
   * adjacent edge; `'OFFSET'` as the distance from the edge to each new one,
   * `'WIDTH'` as the chamfer face's own width, `'DEPTH'` as how far the
   * chamfer sits in from the original corner — Blender's four.
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
 * Bevel the selected edges — `bmesh.ops.bevel` with `clamp_overlap` and
 * `loop_slide` off, through the port of `bmesh_bevel.cc` ({@link bevelMesh}).
 *
 * Until 2026-09-26 this was its own implementation, built by measurement and
 * exact on what it accepted: at most two beveled edges at a vertex, PERCENT
 * and OFFSET, and no layers. The port takes any vertex (a box's corner
 * included) and all five offset types, matches this operator's parity rows
 * (`bevel`, `bevel-seg*`, `bevel-profile-*`) to 0.0000 mm, and carries UVs,
 * colours, vertex groups and materials by Blender's rules (compat-backlog
 * A8) — so the two were made one: this reads the edit mesh out, bevels it,
 * and writes it back.
 *
 * An edge on a boundary has no second face to chamfer against; it is left
 * alone and counted in `outInfo.skipped`. Throws when that is every edge.
 *
 * The vertices are renumbered (the beveled ones go, as in Blender). Creases,
 * seams and sharp edges between vertices the bevel left alone are renumbered
 * with them; on the edges it rebuilt they are dropped, and so are custom
 * normals (compat-backlog C17 has Blender's rules for those).
 *
 * @returns The new chamfer faces, by face index.
 */
export function bevelEdges(
  em: EditMesh,
  selectedEdges: ReadonlySet<number>,
  opts: BevelOptions,
  outInfo?: { skipped: number },
): Set<number> {
  const offsetType = opts.offsetType ?? "PERCENT";
  const segments = Math.max(1, Math.floor(opts.segments ?? 1));
  const profile = Math.min(1, Math.max(0, opts.profile ?? 0.5));
  if (selectedEdges.size === 0 || opts.offset <= 0) return new Set(selectedEdges);

  const pairs: Array<[number, number]> = [];
  const seen = new Set<number>();
  let skipped = 0;
  for (const he of selectedEdges) {
    const t = em.halfEdges[he]!.twin;
    if (t < 0) {
      skipped++;
      continue;
    }
    const c = he < t ? he : t;
    if (seen.has(c)) continue;
    seen.add(c);
    pairs.push([edgeOrigin(em, c), edgeEnd(em, c)]);
  }
  if (outInfo) outInfo.skipped = skipped;
  // Asked to bevel, and able to bevel none of it. Returning an empty set here
  // reads to a caller exactly like "there was nothing to do", which is how a
  // rim comes back unbeveled with no error and the next step runs on it.
  if (pairs.length === 0)
    throw new Error(
      `bevelEdges: all ${selectedEdges.size} selected edge(s) are on a boundary, ` +
        `so there is no second face to chamfer against. Nothing was beveled.`,
    );

  const data: MeshData = { positions: em.positions, polys: toPolygons(em) };
  if (em.loopUVs?.length) data.uvs = em.loopUVs;
  if (em.loopColors?.length) data.colors = em.loopColors;
  if (em.faceMaterials?.length) data.materials = em.faceMaterials;
  if (em.vertexGroups?.size) data.groups = em.vertexGroups;
  if (em.wireEdges?.length) data.edges = em.wireEdges;
  const { mesh: out, faceKind, origVert } = bevelMesh(data, {
    offset: opts.offset,
    offsetType,
    segments,
    profile,
    edges: pairs,
    clampOverlap: false,
    loopSlide: false,
  });

  const sharp = em.sharpEdges;
  rebuildPolygons(em, new Float32Array(out.positions), out.polys);
  delete em.loopUVs;
  delete em.loopColors;
  delete em.faceMaterials;
  delete em.vertexGroups;
  delete em.loopNormals;
  delete em.sharpEdges;
  if (out.uvs) em.loopUVs = out.uvs;
  if (out.colors) em.loopColors = out.colors;
  if (out.materials) em.faceMaterials = out.materials;
  if (out.groups) em.vertexGroups = out.groups;
  em.wireEdges = (out.edges ?? []).map((e) => [...e]);
  // The edge flags are keyed by vertex pairs: carry the ones whose two
  // vertices survive, under their new numbers (found by review — clearing
  // them all lost every seam and crease on the mesh to a bevel elsewhere).
  const newOf = new Map<number, number>();
  origVert.forEach((o, n) => o >= 0 && newOf.set(o, n));
  const rekey = (k: string): string | null => {
    const [a, b] = k.split("_").map(Number);
    const x = newOf.get(a!);
    const y = newOf.get(b!);
    return x === undefined || y === undefined ? null : seamKey(x, y);
  };
  const seams = new Set<string>();
  for (const k of em.seams) {
    const n = rekey(k);
    if (n) seams.add(n);
  }
  em.seams = seams;
  const creases = new Map<string, number>();
  for (const [k, w] of em.creases) {
    const n = rekey(k);
    if (n) creases.set(n, w);
  }
  em.creases = creases;
  if (sharp) {
    em.sharpEdges = new Set();
    for (const k of sharp) {
      const n = rekey(k);
      if (n) em.sharpEdges.add(n);
    }
  }

  const chamfer = new Set<number>();
  faceKind.forEach((k, f) => k === "edge" && chamfer.add(f));
  return chamfer;
}

function thirdVertex(em: EditMesh, f: number, a: number, b: number): number {
  const [v0, v1, v2] = faceVertices(em, f);
  for (const v of [v0, v1, v2]) if (v !== a && v !== b) return v;
  return -1;
}



// ── Loop Cut ───────────────────────────────────────────────────────────────

/** Loop Cut's settings. The defaults are the operator's. */
export interface LoopCutOptions {
  /** New loops. Blender's `number_cuts`, default 1, at least 1. */
  cuts?: number;
  /**
   * Bow the new loops out along the ends' normals, as Subdivide's `smooth`
   * does. Blender's `smoothness`, default 0 (the loops lie on the edges).
   */
  smoothness?: number;
  /** How the bow fades toward the ring's ends. Blender's `falloff`, default `INVERSE_SQUARE`. */
  falloff?: SubdivideFalloff;
}

/**
 * Loop Cut (`bpy.ops.mesh.loopcut`, `editors/mesh/editmesh_loopcut.cc`):
 * the edge ring through `seedEdge`, then `BM_mesh_esubdivide` over it with
 * grid fill, `SUBD_CORNER_PATH` and even smoothing.
 *
 * The ring is Blender's ring select (`BMW_EDGERING` with
 * `BMW_DELIMIT_EDGE_RING_NGONS`) — `selectEdgeRing`: it crosses quads only
 * and stops at a triangle, an n-gon or the boundary. The faces at its ends
 * get the new vertices on one edge and grow (a triangle becomes a quad). A
 * seed with no quad on it is cut alone.
 *
 * Every crossed quad splits into `cuts + 1` quads. Layers follow
 * `subdivideEdges`: each new vertex is `BM_edge_split` — UVs, colours and
 * weights interpolated along its edge — and each piece of a quad keeps its
 * corners (`loop-cut*` parity rows).
 *
 * The edge slide that follows in the UI (`TRANSFORM_OT_edge_slide`, the
 * macro's second half) is not part of this; the loops sit where the cut put
 * them.
 *
 * Returns the new vertices.
 */
export function loopCut(em: EditMesh, seedEdge: number, opts: LoopCutOptions = {}): Set<number> {
  if (!em.halfEdges[seedEdge]) return new Set();
  const ring = selectEdgeRing(em, seedEdge);
  const before = em.vertices.length;
  subdivideEdges(em, ring, {
    cuts: Math.max(1, Math.floor(opts.cuts ?? 1)),
    smooth: opts.smoothness ?? 0,
    smoothFalloff: opts.falloff ?? "INVERSE_SQUARE",
    useSmoothEven: true,
    useGridFill: true,
    cornerType: "PATH",
  });
  const made = new Set<number>();
  for (let v = before; v < em.vertices.length; v++) made.add(v);
  return made;
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

  // The per-corner layers as `bmo_extrude_edge_only_exec` sets them: the
  // fin copies both corners at each end, and its material, from one face on
  // the edge (`bm_extrude_copy_face_loop_attributes` reads the loop after the
  // new one in the radial cycle, which is the face built first on the edge —
  // the lower-numbered); a wire edge has none and the corners are 0.
  const newPolys = toPolygons(em);
  const oldPolys = newPolys.map((p) => [...p]);
  const stated: Array<ExplicitFace | undefined> = newPolys.map(() => undefined);
  const finStart = newPolys.length;
  for (const he of canonical) {
    const a = edgeOrigin(em, he);
    const b = edgeEnd(em, he);
    const aDup = dupOrCreate(a);
    const bDup = dupOrCreate(b);
    // Fin quad — CCW from the fin's outside, with the b→a edge pairing as
    // twin to F1's existing a→b.
    newPolys.push([a, aDup, bDup, b]);
    const h = em.halfEdges[he]!;
    const o = h.twin < 0 ? h.face : Math.min(h.face, em.halfEdges[h.twin]!.face);
    const ca: [number, number, number][] = [[o, oldPolys[o]!.indexOf(a), 1]];
    const cb: [number, number, number][] = [[o, oldPolys[o]!.indexOf(b), 1]];
    stated.push({ corners: [ca, ca, cb, cb], material: o });
  }
  const finEnd = newPolys.length;
  const origins = new Map<number, VertexOrigin>();
  for (const [v, d] of vertDup) origins.set(d, { from: [v], w: [1] });

  rebuildPolygons(em, new Float32Array(newPositions), newPolys, { origins, faces: stated });

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

  rebuildPolygons(em, em.positions, newPolys, { joins: true });
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
  //
  // Each kept corner is the loop `remdoubles_createface` keeps: of a run of
  // corners that merge into one vertex, the **last** — the one whose edge
  // to the next corner does not collapse — with its corner data. A face
  // keeps its material; the survivor keeps its own vertex data.
  const keptPolys: number[][] = [];
  const stated: ExplicitFace[] = [];
  const polys = toPolygons(em);
  polys.forEach((poly, g) => {
    const n = poly.length;
    const dedup: number[] = [];
    const corners: number[] = [];
    for (let i = 0; i < n; i++) {
      const v = mapped(poly[i]!);
      if (v === mapped(poly[(i + 1) % n]!)) continue; // the edge onward collapses
      dedup.push(v);
      corners.push(i);
    }
    if (dedup.length < 3) return;
    if (new Set(dedup).size !== dedup.length) return; // bowtie — drop
    keptPolys.push(dedup);
    stated.push({ corners: corners.map((i) => [[g, i, 1] as const]), material: g });
  });

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

  // Seams, creases and sharp edges follow the merge + compaction; edges
  // collapsed to a point vanish.
  const moveKey = (key: string): string | null => {
    const [a, b] = key.split("_").map(Number);
    const na = oldToNew.get(mapped(a!));
    const nb = oldToNew.get(mapped(b!));
    return na !== undefined && nb !== undefined && na !== nb ? seamKey(na, nb) : null;
  };
  const newSeams = new Set<string>();
  for (const key of em.seams) {
    const k = moveKey(key);
    if (k) newSeams.add(k);
  }
  const newCreases = new Map<string, number>();
  for (const [key, w] of em.creases) {
    const k = moveKey(key);
    if (k && !newCreases.has(k)) newCreases.set(k, w);
  }
  const newSharp = em.sharpEdges ? new Set<string>() : undefined;
  for (const key of em.sharpEdges ?? []) {
    const k = moveKey(key);
    if (k) newSharp!.add(k);
  }

  // The layers in two steps: the faces on the old numbering (corners as
  // chosen above), then the renumbering, which moves nothing but indices.
  rebuildPolygons(em, P, keptPolys, { faces: stated });
  const vertexMap = new Int32Array(em.vertices.length).fill(-1);
  for (const [o, nv] of oldToNew) vertexMap[o] = nv;
  rebuildPolygons(em, Float32Array.from(newPositions), newPolys, { sameCorners: true, vertexMap });
  em.seams = newSeams;
  em.creases = newCreases;
  if (newSharp) em.sharpEdges = newSharp;

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
 *
 * Layers (compat-backlog A6): a rebuilt face keeps, of each run of corners
 * that merge, the last one's corner data (remdoubles_createface), and its
 * material. The survivor — whose vertex data (groups) is kept — is the
 * lowest-numbered vertex of the run; Blender's is e->v1 of the run's first
 * edge in its own edge order, which this does not have. Not matched.
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
  const faceOfEdge = new Map<string, number>(); // "a,b" → the face on a→b
  for (const heRaw of selectedEdges) {
    const he = canonicalEdge(em, heRaw);
    if (em.halfEdges[he]!.twin >= 0) return new Set(); // interior edge — unsupported
    const a = edgeOrigin(em, he);
    const b = edgeEnd(em, he);
    dirEdges.push([a, b]);
    faceOfEdge.set(`${a},${b}`, em.halfEdges[he]!.face);
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
  // Each corner copies the corner of the rim face on its side of the band —
  // `bm_vert_loop_pair` on the loop's edge — and the face takes the A side's
  // material (`f_example`). Which loop is Blender's "a" follows its loop
  // order (`BM_mesh_edgeloops_calc_order`); not matched, here it is A.
  const stated: Array<ExplicitFace | undefined> = newPolys.map(() => undefined);
  const cornerOf = (face: number, v: number): [number, number, number][] => [[face, newPolys[face]!.indexOf(v), 1]];
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
    const fA = faceOfEdge.get(`${a0},${a1}`)!;
    const fB = faceOfEdge.get(`${b1},${b0}`)!;
    stated.push({ corners: [cornerOf(fA, a1), cornerOf(fA, a0), cornerOf(fB, b0), cornerOf(fB, b1)], material: fA });
  }

  rebuildPolygons(em, em.positions, newPolys, { faces: stated });
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
  rebuildPolygons(em, em.positions, newPolys, { joins: true });

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
 * The layers are carried as Blender's Subdivision Surface carries them
 * (`subdiv-edit-layers`): UVs smoothed face-varying under its default UV
 * Smooth, "Keep Boundaries" (see `catmullClark`); vertex groups and colours
 * interpolated linearly — a face point is the mean of its face, an edge
 * point the mean of its two ends, an old vertex keeps its own — and each
 * child face takes its parent's material. Custom normals are dropped.
 * Morph targets can't survive the vertex-count change — the caller must
 * guard.
 */
export function subdivideCatmullClark(em: EditMesh, level: number): Set<number> {
  if (level < 1) return new Set();
  const polys0 = toPolygons(em);
  const uvs = em.loopUVs?.length === polys0.length ? em.loopUVs : undefined;
  const result = catmullClark(em.positions, polys0, level, em.creases, uvs);

  // Replay the levels' bookkeeping — `subdivideOnce` numbers the new
  // vertices [old | face points | edge points in first-met order], and gives
  // face f its corners' quads in a row — to carry the linear layers.
  let polys = polys0;
  let parent = polys0.map((_, f) => f);
  let colors = em.loopColors?.length === polys0.length ? em.loopColors.map((f) => f.map((c) => [...c])) : undefined;
  let groups = em.vertexGroups ? new Map([...em.vertexGroups].map(([k, g]) => [k, new Map(g)])) : undefined;
  let V = em.positions.length / 3;
  for (let l = 0; l < level; l++) {
    const F = polys.length;
    const facePoint = (f: number): number => V + f;
    const edgePoint = new Map<string, number>();
    const edgeEnds: [number, number][] = [];
    const edgeFace: number[] = []; // the first face with the edge
    polys.forEach((p, f) => {
      for (let i = 0; i < p.length; i++) {
        const k = seamKey(p[i]!, p[(i + 1) % p.length]!);
        if (!edgePoint.has(k)) {
          edgePoint.set(k, V + F + edgeEnds.length);
          edgeEnds.push([p[i]!, p[(i + 1) % p.length]!]);
          edgeFace.push(f);
        }
      }
    });
    if (groups) {
      // Equal weights, and a member where any source is a member — a weight
      // of 0 included (measured, `subdiv-edit-layers`: Blender's subdivision
      // keeps a 0 membership that the bmesh interpolation would skip).
      const mix = (from: readonly number[], g: Map<number, number>): number | undefined => {
        let member = false;
        let sum = 0;
        for (const u of from) {
          const x = g.get(u);
          if (x !== undefined) {
            member = true;
            sum += x / from.length;
          }
        }
        return member ? Math.min(sum, 1) : undefined;
      };
      for (const g of groups.values()) {
        const add: [number, number][] = [];
        polys.forEach((p, f) => {
          const w = mix(p, g);
          if (w !== undefined) add.push([facePoint(f), w]);
        });
        // An edge point is interpolated over the first face with the edge,
        // the face's other corners at weight 0 — which still makes it a
        // member wherever one of them is (measured, as above).
        edgeEnds.forEach((e, i) => {
          if (!polys[edgeFace[i]!]!.some((u) => g.has(u))) return;
          add.push([V + F + i, Math.min(e.reduce((s, u) => s + (g.get(u) ?? 0) / 2, 0), 1)]);
        });
        for (const [v, w] of add) g.set(v, w);
      }
    }
    const nextPolys: number[][] = [];
    const nextParent: number[] = [];
    const nextColors: number[][][] = [];
    polys.forEach((p, f) => {
      const n = p.length;
      const mean = (idx: readonly number[]): number[] => {
        const c = colors![f]!;
        return c[0]!.map((_, j) => idx.reduce((s, i) => s + c[i]![j]!, 0) / idx.length);
      };
      for (let i = 0; i < n; i++) {
        const next = (i + 1) % n;
        const prev = (i - 1 + n) % n;
        nextPolys.push([
          p[i]!,
          edgePoint.get(seamKey(p[i]!, p[next]!))!,
          facePoint(f),
          edgePoint.get(seamKey(p[prev]!, p[i]!))!,
        ]);
        nextParent.push(parent[f]!);
        if (colors) nextColors.push([[...colors[f]![i]!], mean([i, next]), mean(p.map((_, k) => k)), mean([prev, i])]);
      }
    });
    V += F + edgeEnds.length;
    polys = nextPolys;
    parent = nextParent;
    if (colors) colors = nextColors;
  }

  const materials = em.faceMaterials?.length === polys0.length ? parent.map((f) => em.faceMaterials![f]!) : undefined;
  // Laid down after the rebuild: every face is new, so it would drop them all.
  em.loopUVs = undefined;
  em.loopColors = undefined;
  em.loopNormals = undefined;
  em.faceMaterials = undefined;
  em.vertexGroups = undefined;
  rebuildPolygons(em, result.positions, result.polys);
  if (result.uvs) em.loopUVs = result.uvs;
  if (colors) em.loopColors = colors;
  if (materials) em.faceMaterials = materials;
  if (groups) em.vertexGroups = groups;
  // Carry the propagated (σ−1) creases onto the subdivided edges. Seams are
  // dropped — their vertex-pair keys no longer name real edges after the split.
  em.creases = result.creases;
  return new Set();
}

/**
 * Fan-triangulate the selected quad / n-gon faces (whole mesh when
 * `selectedFaces` is null), from each face's first corner. Triangle faces
 * are left untouched.
 *
 * **Not Blender's Triangulate Faces.** Ctrl+T defaults to BEAUTY for quads
 * and n-gons; a fan matches it only for quads with `quad_method=FIXED`. For
 * Blender's answer use `triangulate` (`BM_face_triangulate`, every quad
 * and n-gon method). Returns the new triangle face ids (∅ when nothing had to
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
  rebuildPolygons(em, em.positions, newPolys, {});

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
  /**
   * Push the inset region along its normal afterwards. Moves every vertex of
   * the region, border included even when nothing was inset there. The new
   * ring goes along the sum of its inset edges' faces; every other vertex
   * along its ordinary vertex normal from before the inset — Blender's
   * `bmo_inset.cc`, and 0.0000 mm on curved cages since 2026-09-25.
   */
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

  /**
   * A face's normal as `BM_face_normal_update` makes it: a triangle's cross
   * product, a quad's **diagonals** crossed, Newell's for the rest. On a bent
   * quad the diagonals and Newell disagree, which is where `depth` drifted.
   */
  const normalOf = (poly: readonly number[]): [number, number, number] => {
    if (poly.length === 3 || poly.length === 4) {
      const c = (i: number): [number, number, number] => [P[poly[i]! * 3]!, P[poly[i]! * 3 + 1]!, P[poly[i]! * 3 + 2]!];
      const d = (a: [number, number, number], b: [number, number, number]): [number, number, number] => [
        a[0] - b[0],
        a[1] - b[1],
        a[2] - b[2],
      ];
      const n =
        poly.length === 3 ? cross3(d(c(0), c(1)), d(c(1), c(2))) : cross3(d(c(0), c(2)), d(c(1), c(3)));
      const len = Math.hypot(n[0], n[1], n[2]);
      return len < 1e-20 ? [0, 0, 0] : [n[0] / len, n[1] / len, n[2] / len];
    }
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
  // Which way `depth` pushes, as Blender's inset does it: a vertex on the new
  // ring goes along the sum of the faces **of its inset edges** (one per edge,
  // unweighted), and every other vertex of the region along its ordinary
  // vertex normal from before the inset — all faces round it, weighted by
  // corner angle.
  const ringNormals = new Map<number, [number, number, number]>();
  const regionVerts = new Set<number>();

  for (const f of selectedFaces) {
    const poly = polys[f]!;
    const n = normalOf(poly);
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      regionVerts.add(a);

      if (!insetKeys.has(seamKey(a, b))) continue;
      const e = unit3([P[b * 3]! - P[a * 3]!, P[b * 3 + 1]! - P[a * 3 + 1]!, P[b * 3 + 2]! - P[a * 3 + 2]!]);
      const m = unit3(cross3(n, e));
      for (const v of [a, b]) {
        const list = perps.get(v);
        if (list) list.push(m);
        else perps.set(v, [m]);
        const prev = ringNormals.get(v) ?? [0, 0, 0];
        ringNormals.set(v, [prev[0] + n[0], prev[1] + n[1], prev[2] + n[2]]);
      }
    }
  }

  /** `BM_vert_normal_update`: corner-angle-weighted, over every face at `v`. */
  const vertNormal = (v: number): [number, number, number] => {
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (const poly of polys) {
      const i = poly.indexOf(v);
      if (i < 0) continue;
      const k = poly.length;
      const q = poly[(i + k - 1) % k]!;
      const r = poly[(i + 1) % k]!;
      const e1 = unit3([P[q * 3]! - P[v * 3]!, P[q * 3 + 1]! - P[v * 3 + 1]!, P[q * 3 + 2]! - P[v * 3 + 2]!]);
      const e2 = unit3([P[r * 3]! - P[v * 3]!, P[r * 3 + 1]! - P[v * 3 + 1]!, P[r * 3 + 2]! - P[v * 3 + 2]!]);
      const w = Math.acos(Math.max(-1, Math.min(1, e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2])));
      const n = normalOf(poly);
      sx += n[0] * w;
      sy += n[1] * w;
      sz += n[2] * w;
    }
    return unit3([sx, sy, sz]);
  };

  const newPositions: number[] = Array.from(P);
  let nextV = em.vertices.length;
  const dup = new Map<number, number>();

  for (const v of [...dupVerts].sort((x, y) => x - y)) {
    const ms = perps.get(v) ?? [];
    const n = unit3(ringNormals.get(v) ?? [0, 0, 0]);
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
  // measured on a 2x2 grid, whose middle vertex moves with the rest. So does
  // a border vertex that was not duplicated (a mesh-boundary edge left alone
  // by `useBoundary: false`): it is still a corner of the region's faces.
  if (depth !== 0) {
    const moves = [...regionVerts].filter((v) => !dup.has(v)).map((v) => [v, vertNormal(v)] as const);
    for (const [v, n] of moves) {
      newPositions[v * 3] = newPositions[v * 3]! + n[0] * depth;
      newPositions[v * 3 + 1] = newPositions[v * 3 + 1]! + n[1] * depth;
      newPositions[v * 3 + 2] = newPositions[v * 3 + 2]! + n[2] * depth;
    }
  }

  // Emit unselected, then skirts, then the caps — so the caps are contiguous
  // at the end and the returned set is a range.
  //
  // The per-corner layers as `bmo_inset_region_exec` sets them with
  // `use_interpolate` off (the op's default): each region face keeps its
  // corners on the moved vertices, and each rim quad — made with the region
  // face on its edge as example — copies that face's corner at each end to
  // both the inner vertex and the outer one. A duplicate copies its vertex
  // data. (`use_interpolate` is not ported, compat-backlog C12.)
  const newPolys: number[][] = [];
  const stated: Array<ExplicitFace | undefined> = [];
  for (let f = 0; f < polys.length; f++)
    if (!selectedFaces.has(f)) {
      newPolys.push(polys[f]!);
      stated.push(undefined);
    }

  for (const f of selectedFaces) {
    const poly = polys[f]!;
    for (let i = 0; i < poly.length; i++) {
      const j = (i + 1) % poly.length;
      const a = poly[i]!;
      const b = poly[j]!;
      if (!insetKeys.has(seamKey(a, b))) continue;
      newPolys.push([a, b, dup.get(b)!, dup.get(a)!]);
      const ci: [number, number, number][] = [[f, i, 1]];
      const cj: [number, number, number][] = [[f, j, 1]];
      stated.push({ corners: [ci, cj, cj, ci], material: f });
    }
  }

  const capStart = newPolys.length;
  for (const f of selectedFaces) {
    newPolys.push(polys[f]!.map((v) => dup.get(v) ?? v));
    stated.push({ corners: polys[f]!.map((_, i) => [[f, i, 1] as const]), material: f });
  }
  const capEnd = newPolys.length;
  const origins = new Map<number, VertexOrigin>();
  for (const [v, d] of dup) origins.set(d, { from: [v], w: [1] });

  rebuildPolygons(em, new Float32Array(newPositions), newPolys, { origins, faces: stated });

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

// ── Winding / discrete extrude / connecting verts ──────────────────────────

/**
 * Reverse the winding of the selected faces — Blender's
 * `bmesh.ops.reverse_faces(faces=)`.
 *
 * Flips which side is the outside, one face at a time and without asking
 * whether the result is consistent with its neighbours. {@link recalcFaceNormals}
 * is the one that makes a whole shell agree; this is the manual override for
 * when that guessed wrong, and for building a deliberately inward-facing shell.
 *
 * Nothing is added or removed, so vertex indices, creases and seams all carry
 * through. Returns the faces it turned.
 */
export function reverseFaces(em: EditMesh, selectedFaces: ReadonlySet<number>): Set<number> {
  if (selectedFaces.size === 0) return new Set();

  const polys = toPolygons(em);
  const out = polys.map((poly, f) => (selectedFaces.has(f) ? [...poly].reverse() : poly));
  rebuildPolygons(em, em.positions, out, {});
  return new Set(selectedFaces);
}

/**
 * Extrude every selected face on its **own**, not as one region — Blender's
 * `bmesh.ops.extrude_discrete_faces(faces=)`.
 *
 * The difference from {@link extrudeFaces} is what happens where two selected
 * faces touch. The region form shares the duplicated vertices along that seam,
 * so the two caps stay joined and no wall is built between them. This form
 * gives each face its own copies, so every face grows a complete skirt and the
 * pair comes back as two separate boxes standing side by side.
 *
 * Like every extrude here, it **moves nothing** — the cap lands exactly on the
 * face it came from. Translating the returned faces is the second half.
 *
 * Returns the new caps.
 */
export function extrudeDiscreteFaces(
  em: EditMesh,
  selectedFaces: ReadonlySet<number>,
): Set<number> {
  if (selectedFaces.size === 0) return new Set();

  const polys = toPolygons(em);
  const newPositions: number[] = Array.from(em.positions);
  let nextV = em.vertices.length;

  // The per-corner layers as `bmo_extrude_discrete_faces_exec` sets them:
  // the cap is a copy of its face (`BM_face_copy`), and each wall made with
  // the face as its example copies the face's corner at each end to both the
  // original vertex and its duplicate. A duplicate copies its vertex data.
  const newPolys: number[][] = [];
  const stated: Array<ExplicitFace | undefined> = [];
  const origins = new Map<number, VertexOrigin>();
  for (let f = 0; f < polys.length; f++) {
    if (!selectedFaces.has(f)) {
      newPolys.push(polys[f]!);
      stated.push(undefined);
    }
  }

  // Skirts first, caps after, so the cap ids are the tail of the list.
  const caps: number[][] = [];
  const capFaces: number[] = [];
  for (const f of selectedFaces) {
    const poly = polys[f]!;
    // Fresh duplicates per face — this is the whole difference from the
    // region form, where a shared vertex is duplicated once.
    const dup = poly.map((v) => {
      const d = nextV++;
      newPositions.push(em.positions[v * 3]!, em.positions[v * 3 + 1]!, em.positions[v * 3 + 2]!);
      origins.set(d, { from: [v], w: [1] });
      return d;
    });
    // Every edge is a boundary when the face is its own region.
    for (let i = 0; i < poly.length; i++) {
      const j = (i + 1) % poly.length;
      newPolys.push([poly[i]!, poly[j]!, dup[j]!, dup[i]!]);
      const ci: [number, number, number][] = [[f, i, 1]];
      const cj: [number, number, number][] = [[f, j, 1]];
      stated.push({ corners: [ci, cj, cj, ci], material: f });
    }
    caps.push(dup);
    capFaces.push(f);
  }

  const capStart = newPolys.length;
  caps.forEach((cap, k) => {
    newPolys.push(cap);
    const f = capFaces[k]!;
    stated.push({ corners: polys[f]!.map((_, i) => [[f, i, 1] as const]), material: f });
  });

  rebuildPolygons(em, new Float32Array(newPositions), newPolys, { origins, faces: stated });

  const out = new Set<number>();
  for (let i = capStart; i < newPolys.length; i++) out.add(i);
  return out;
}

/**
 * Cut a face in two by joining two of its vertices — Blender's
 * `bmesh.ops.connect_vert_pair(verts=)`.
 *
 * The two vertices have to share a face and must not already be neighbours in
 * it: adjacent corners are joined by an edge already, and asking for that edge
 * again would be asking for a zero-width face.
 *
 * **Scope: one face.** Blender's version will route a path across several
 * faces when the pair does not share one, and that is a different (and much
 * larger) operation — a path search with tie-breaks nobody here has measured.
 * A pair with no common face is refused rather than approximated, so the
 * caller finds out instead of receiving a mesh that quietly did nothing.
 *
 * Returns the two faces the original became.
 */
export function connectVertPair(em: EditMesh, a: number, b: number): Set<number> {
  if (a === b) throw new Error(`connectVertPair: ${a} and ${b} are the same vertex`);

  const polys = toPolygons(em);
  let target = -1;
  let ia = -1;
  let ib = -1;
  for (let f = 0; f < polys.length; f++) {
    const poly = polys[f]!;
    const pa = poly.indexOf(a);
    const pb = poly.indexOf(b);
    if (pa < 0 || pb < 0) continue;
    const gap = Math.abs(pa - pb);
    if (gap === 1 || gap === poly.length - 1) continue; // already an edge
    target = f;
    ia = pa;
    ib = pb;
    break;
  }
  if (target < 0)
    throw new Error(
      `connectVertPair: ${a} and ${b} share no face they could be cut apart in — ` +
        `either they are not on one face, or they are already joined by an edge. ` +
        `Routing a cut across several faces is Blender's behaviour and is not ` +
        `implemented here.`,
    );

  const poly = polys[target]!;
  const lo = Math.min(ia, ib);
  const hi = Math.max(ia, ib);
  // Both halves keep the parent's direction, so both keep its winding.
  const first = poly.slice(lo, hi + 1);
  const second = [...poly.slice(hi), ...poly.slice(0, lo + 1)];

  const out: number[][] = [];
  for (let f = 0; f < polys.length; f++) if (f !== target) out.push(polys[f]!);
  const start = out.length;
  out.push(first, second);

  rebuildPolygons(em, em.positions, out, {});
  return new Set([start, start + 1]);
}

// ── Split Edges (rip) ──────────────────────────────────────────────────────

/**
 * Tear the mesh apart along the selected edges — Blender's
 * `bmesh.ops.split_edges(edges=)`.
 *
 * Every selected interior edge becomes two boundary edges, one for each face
 * that held it, and the faces stop sharing vertices there. What makes this more
 * than duplicating endpoints is deciding **how many copies each vertex needs**:
 * a vertex where four quads meet and two opposite edges are cut splits into two
 * vertices, one per pair of faces that are still joined; a vertex where only one
 * cut edge arrives does not split at all, because the faces around it are still
 * reachable from each other the long way.
 *
 * So the rule is a connectivity question asked per vertex: group the faces
 * around it into runs joined by edges that were **not** cut, and give every run
 * after the first its own copy. That is what `use_verts` means in Blender's UI
 * as "Rip", and it is why ripping one edge out of the middle of a grid does not
 * detach anything — the ring around each endpoint is still connected.
 *
 * Positions are copied, so the two sides start coincident. Moving one of them
 * is the second half, the same split of responsibilities the extrudes have.
 *
 * Returns the vertices that gained a copy (their **new** indices).
 */
export function splitEdges(em: EditMesh, selectedEdges: ReadonlySet<number>): Set<number> {
  if (selectedEdges.size === 0) return new Set();

  const polys = toPolygons(em);

  /** The undirected edges being cut. */
  const cut = new Set<string>();
  for (const heRaw of selectedEdges) {
    const he = em.halfEdges[heRaw];
    if (!he) continue;
    cut.add(seamKey(edgeOrigin(em, heRaw), edgeEnd(em, heRaw)));
  }
  if (cut.size === 0) return new Set();

  /** Which faces use each vertex, and through which of its two edges there. */
  const facesAt = new Map<number, number[]>();
  for (let f = 0; f < polys.length; f++) {
    for (const v of polys[f]!) {
      const list = facesAt.get(v);
      if (list) list.push(f);
      else facesAt.set(v, [f]);
    }
  }

  const newPositions: number[] = Array.from(em.positions);
  let nextV = em.vertices.length;
  /** face -> (oldVert -> the copy that face should use). */
  const rename = new Map<number, Map<number, number>>();
  const added = new Set<number>();

  for (const [v, faces] of facesAt) {
    if (faces.length < 2) continue;

    // Two faces at this vertex stay together when they share an edge that
    // runs through it and was not cut.
    const parent = new Map<number, number>(faces.map((f) => [f, f]));
    const find = (x: number): number => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r)!;
      return r;
    };
    let joinedAny = false;
    for (const f of faces) {
      const poly = polys[f]!;
      const i = poly.indexOf(v);
      for (const other of [poly[(i + 1) % poly.length]!, poly[(i - 1 + poly.length) % poly.length]!]) {
        if (cut.has(seamKey(v, other))) continue;
        // The other face on this uncut edge, if any.
        for (const g of faces) {
          if (g === f) continue;
          const gp = polys[g]!;
          const gi = gp.indexOf(v);
          const gn = [gp[(gi + 1) % gp.length]!, gp[(gi - 1 + gp.length) % gp.length]!];
          if (!gn.includes(other)) continue;
          const rf = find(f);
          const rg = find(g);
          if (rf !== rg) {
            parent.set(rf, rg);
            joinedAny = true;
          }
        }
      }
    }
    void joinedAny;

    const runs = new Map<number, number[]>();
    for (const f of faces) {
      const r = find(f);
      const list = runs.get(r);
      if (list) list.push(f);
      else runs.set(r, [f]);
    }
    if (runs.size < 2) continue; // still one piece — nothing to tear here

    // The first run keeps the original index so unrelated geometry is untouched.
    let first = true;
    for (const [, group] of runs) {
      if (first) {
        first = false;
        continue;
      }
      const copy = nextV++;
      newPositions.push(em.positions[v * 3]!, em.positions[v * 3 + 1]!, em.positions[v * 3 + 2]!);
      added.add(copy);
      for (const f of group) {
        let map = rename.get(f);
        if (!map) {
          map = new Map();
          rename.set(f, map);
        }
        map.set(v, copy);
      }
    }
  }

  if (added.size === 0) return new Set();

  const out = polys.map((poly, f) => {
    const map = rename.get(f);
    return map ? poly.map((v) => map.get(v) ?? v) : poly;
  });
  // Faces keep their corners on the torn copies; a copy keeps its vertex's
  // data (`bmesh_kernel_unglue_region_make_vert` copies the vertex).
  const stated = polys.map((poly, f) =>
    rename.has(f) ? { corners: poly.map((_, i) => [[f, i, 1] as const]), material: f } : undefined,
  );
  const origins = new Map<number, VertexOrigin>();
  for (const [, map] of rename) for (const [v, c] of map) origins.set(c, { from: [v], w: [1] });
  rebuildPolygons(em, new Float32Array(newPositions), out, { origins, faces: stated });
  return added;
}

// ── Offset Edge Loops ──────────────────────────────────────────────────────

/**
 * Put a parallel loop either side of the selected one — Blender's
 * `bmesh.ops.offset_edgeloops(edges=)`, the Ctrl+Shift+R of the UI.
 *
 * **Nothing moves.** Both new loops land exactly on the one they flank, so the
 * strips between them have no width and the mesh's area does not change. That
 * is the operator, not an omission: the editor slides them afterwards, and
 * `edgeSlide` is the second half here. Measured on a 4×4 grid with the middle
 * loop selected — 25 vertices and 16 faces become **35 and 24, of which 8 have
 * zero area**, and every x coordinate in the mesh is where it was.
 *
 * The faces on each side of the loop are re-attached to that side's copy, so
 * the original loop ends up sandwiched between the two new strips.
 *
 * Refuses a selection whose adjacent faces do not fall into exactly two sides —
 * a loop that does not separate what is around it has no "either side" to
 * offset into, and guessing would produce a mesh nobody asked for.
 *
 * Returns the vertices it added.
 */
export function offsetEdgeLoops(em: EditMesh, selectedEdges: ReadonlySet<number>): Set<number> {
  if (selectedEdges.size === 0) return new Set();

  const polys = toPolygons(em);

  const loopEdges = new Set<string>();
  const loopVerts = new Set<number>();
  for (const heRaw of selectedEdges) {
    if (!em.halfEdges[heRaw]) continue;
    const a = edgeOrigin(em, heRaw);
    const b = edgeEnd(em, heRaw);
    loopEdges.add(seamKey(a, b));
    loopVerts.add(a);
    loopVerts.add(b);
  }
  if (loopEdges.size === 0) return new Set();

  // Faces touching the loop through one of its edges — the ones that will be
  // pushed onto a copy. A face merely touching a loop *vertex* is not one of
  // them; it stays where it is.
  const adjacent: number[] = [];
  for (let f = 0; f < polys.length; f++) {
    const poly = polys[f]!;
    for (let i = 0; i < poly.length; i++) {
      if (loopEdges.has(seamKey(poly[i]!, poly[(i + 1) % poly.length]!))) {
        adjacent.push(f);
        break;
      }
    }
  }

  // Two of those faces are on the same side when they share an edge that is
  // not part of the loop. On a grid that walks each column; across the loop
  // there is no such edge, which is what makes the two sides two groups.
  const parent = new Map<number, number>(adjacent.map((f) => [f, f]));
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  for (const f of adjacent) {
    for (const g of adjacent) {
      if (g <= f) continue;
      const pf = polys[f]!;
      const pg = new Set<string>();
      const gp = polys[g]!;
      for (let i = 0; i < gp.length; i++) pg.add(seamKey(gp[i]!, gp[(i + 1) % gp.length]!));
      for (let i = 0; i < pf.length; i++) {
        const key = seamKey(pf[i]!, pf[(i + 1) % pf.length]!);
        if (loopEdges.has(key) || !pg.has(key)) continue;
        const rf = find(f);
        const rg = find(g);
        if (rf !== rg) parent.set(rf, rg);
        break;
      }
    }
  }

  const sides = new Map<number, number[]>();
  for (const f of adjacent) {
    const r = find(f);
    const list = sides.get(r);
    if (list) list.push(f);
    else sides.set(r, [f]);
  }
  if (sides.size !== 2)
    throw new Error(
      `offsetEdgeLoops: the selected edges have ${sides.size} side(s) of faces on ` +
        `them, not 2 — a loop that does not separate what is around it has no ` +
        `"either side" to offset into.`,
    );

  const newPositions: number[] = Array.from(em.positions);
  let nextV = em.vertices.length;
  const added = new Set<number>();
  const out = polys.map((p) => [...p]);
  const strips: number[][] = [];
  // The per-corner layers: Blender splits each side edge at factor 1 — the
  // new vertex sits on the loop vertex and interpolates to its corner — and
  // splits the strip off the face on that side, which copies. So a strip's
  // corners are that face's corners at `a` and `b`, a moved face keeps its
  // own, and a copy keeps its vertex's data.
  const stated: Array<ExplicitFace | undefined> = polys.map(() => undefined);
  const stripStated: ExplicitFace[] = [];
  const origins = new Map<number, VertexOrigin>();

  for (const [, faces] of sides) {
    const copy = new Map<number, number>();
    for (const v of loopVerts) {
      const c = nextV++;
      newPositions.push(em.positions[v * 3]!, em.positions[v * 3 + 1]!, em.positions[v * 3 + 2]!);
      copy.set(v, c);
      added.add(c);
      origins.set(c, { from: [v], w: [1] });
    }
    for (const f of faces) {
      out[f] = out[f]!.map((v) => copy.get(v) ?? v);
      stated[f] = { corners: polys[f]!.map((_, i) => [[f, i, 1] as const]), material: f };
    }

    // A strip per loop edge, flat against it. Wound from the copied side so
    // it pairs cleanly with the face that moved.
    for (const key of loopEdges) {
      const [a, b] = key.split("_").map(Number) as [number, number];
      strips.push([a, b, copy.get(b)!, copy.get(a)!]);
      const g = faces.find((x) => polys[x]!.includes(a) && polys[x]!.includes(b))!;
      const ca: [number, number, number][] = [[g, polys[g]!.indexOf(a), 1]];
      const cb: [number, number, number][] = [[g, polys[g]!.indexOf(b), 1]];
      stripStated.push({ corners: [ca, cb, cb, ca], material: g });
    }
  }

  out.push(...strips);
  stated.push(...stripStated);
  rebuildPolygons(em, new Float32Array(newPositions), out, { origins, faces: stated });
  return added;
}

// ── Duplicate / Split / degenerate cleanup ─────────────────────────────────

/**
 * Add a free-standing copy of the selected faces — Blender's
 * `bmesh.ops.duplicate(geom=)`.
 *
 * The copy shares **nothing** with the original: every corner is duplicated
 * even where the two would otherwise sit on the same vertex. Measured on a 2×2
 * grid with one face duplicated — 9 vertices and 4 faces become 13 and 5, and
 * the area goes from 1.0 to 1.25, the extra being the new face laid exactly on
 * the old one.
 *
 * Nothing moves, so the copy starts coincident with what it came from. Moving
 * it is the second half, the same split the extrudes have.
 *
 * Returns the new faces.
 */
export function duplicateFaces(em: EditMesh, selectedFaces: ReadonlySet<number>): Set<number> {
  if (selectedFaces.size === 0) return new Set();

  const polys = toPolygons(em);
  const newPositions: number[] = Array.from(em.positions);
  let nextV = em.vertices.length;
  const copyOf = new Map<number, number>();
  const copy = (v: number): number => {
    let c = copyOf.get(v);
    if (c === undefined) {
      c = nextV++;
      copyOf.set(v, c);
      newPositions.push(em.positions[v * 3]!, em.positions[v * 3 + 1]!, em.positions[v * 3 + 2]!);
    }
    return c;
  };

  const out = polys.map((p) => [...p]);
  const start = out.length;
  // A copy is a copy: corners, material and vertex data (`bmo_duplicate`).
  const stated: Array<ExplicitFace | undefined> = out.map(() => undefined);
  for (const f of selectedFaces) {
    out.push(polys[f]!.map(copy));
    stated.push({ corners: polys[f]!.map((_, i) => [[f, i, 1] as const]), material: f });
  }
  const origins = new Map<number, VertexOrigin>();
  for (const [v, c] of copyOf) origins.set(c, { from: [v], w: [1] });

  rebuildPolygons(em, new Float32Array(newPositions), out, { origins, faces: stated });
  const made = new Set<number>();
  for (let i = start; i < out.length; i++) made.add(i);
  return made;
}

/**
 * Tear the selected faces free of everything around them — Blender's
 * `bmesh.ops.split(geom=)`.
 *
 * Where {@link duplicateFaces} adds a copy and leaves the original attached,
 * this detaches what is already there: the face count does not change and the
 * area does not change, only the sharing does. Measured on a 2×2 grid with the
 * corner face split — 9 vertices become **12**, because that face's outer
 * corner is its own already and the other three were shared.
 *
 * The same question {@link splitEdges} asks, along a face selection's border
 * rather than along named edges.
 *
 * Returns the vertices that gained a copy.
 */
export function splitFaces(em: EditMesh, selectedFaces: ReadonlySet<number>): Set<number> {
  if (selectedFaces.size === 0) return new Set();

  const polys = toPolygons(em);
  const inside = new Set<number>();
  const outside = new Set<number>();
  for (let f = 0; f < polys.length; f++)
    for (const v of polys[f]!) (selectedFaces.has(f) ? inside : outside).add(v);

  const newPositions: number[] = Array.from(em.positions);
  let nextV = em.vertices.length;
  const copyOf = new Map<number, number>();
  for (const v of inside) {
    if (!outside.has(v)) continue; // only this side uses it — nothing to tear
    const c = nextV++;
    copyOf.set(v, c);
    newPositions.push(em.positions[v * 3]!, em.positions[v * 3 + 1]!, em.positions[v * 3 + 2]!);
  }
  if (copyOf.size === 0) return new Set();

  const out = polys.map((poly, f) =>
    selectedFaces.has(f) ? poly.map((v) => copyOf.get(v) ?? v) : [...poly],
  );
  // The torn faces keep their corners and material; a torn vertex copies its
  // data (`bmo_split` duplicates, then deletes the originals).
  const stated = polys.map((poly, f) =>
    selectedFaces.has(f) ? { corners: poly.map((_, i) => [[f, i, 1] as const]), material: f } : undefined,
  );
  const origins = new Map<number, VertexOrigin>();
  for (const [v, c] of copyOf) origins.set(c, { from: [v], w: [1] });
  rebuildPolygons(em, new Float32Array(newPositions), out, { origins, faces: stated });
  return new Set(copyOf.values());
}

/**
 * Which vertices sit on top of which — Blender's
 * `bmesh.ops.find_doubles(verts=, dist=)`.
 *
 * **Reports; does not weld.** That is the whole difference from `weldMesh`
 * (which is `remove_doubles`): this hands back the targetmap and lets the
 * caller decide, and that targetmap is exactly what {@link weldVerts} takes.
 * Splitting the two halves is what lets a pipeline look at what would be
 * merged before merging it.
 *
 * Each vertex is mapped to the **lowest-numbered** vertex within `dist` of it;
 * a vertex that is itself the lowest of its cluster is left out of the map.
 *
 * Every pair is compared, so the cost grows with the square of the vertex
 * count — fine for a cage, and the wrong tool for a scanned mesh. `weldMesh`
 * is the one that buckets by distance and scales, at the price of deciding the
 * merge for you.
 */
export function findDoubles(em: EditMesh, dist: number): Map<number, number> {
  const out = new Map<number, number>();
  const P = em.positions;
  const n = em.vertices.length;
  const d2 = dist * dist;
  for (let v = 0; v < n; v++) {
    for (let u = 0; u < v; u++) {
      if (out.has(u)) continue; // already claimed — keep the cluster's lowest
      const dx = P[v * 3]! - P[u * 3]!;
      const dy = P[v * 3 + 1]! - P[u * 3 + 1]!;
      const dz = P[v * 3 + 2]! - P[u * 3 + 2]!;
      if (dx * dx + dy * dy + dz * dz <= d2) {
        out.set(v, u);
        break;
      }
    }
  }
  return out;
}

/**
 * Collapse edges shorter than `dist` — Blender's
 * `bmesh.ops.dissolve_degenerate(dist=, edges=)`.
 *
 * The cleanup for geometry that came out of an operator with a zero-width
 * feature in it: a bevel clamped to nothing, an inset that met itself, two
 * vertices dragged onto each other. Measured on a 2×2 grid with one vertex
 * moved onto its neighbour — 9 vertices become 8 and two of the quads come
 * back as triangles, with the area unchanged.
 *
 * Unlike `weldMesh` this is not a distance weld over the whole mesh: only
 * vertices joined by a **short edge** merge, so two surfaces lying against
 * each other are left alone.
 */
export function dissolveDegenerate(em: EditMesh, dist: number): Set<number> {
  const P = em.positions;
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };

  let any = false;
  forEachEdge(em, (he) => {
    const a = edgeOrigin(em, he);
    const b = edgeEnd(em, he);
    const dx = P[a * 3]! - P[b * 3]!;
    const dy = P[a * 3 + 1]! - P[b * 3 + 1]!;
    const dz = P[a * 3 + 2]! - P[b * 3 + 2]!;
    if (Math.hypot(dx, dy, dz) > dist) return;
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
    any = true;
  });
  if (!any) return new Set();

  const byRoot = new Map<number, number[]>();
  for (const v of parent.keys()) {
    const r = find(v);
    const list = byRoot.get(r);
    if (list) list.push(v);
    else byRoot.set(r, [v]);
  }
  const clusters: number[][] = [];
  for (const list of byRoot.values()) if (list.length > 1) clusters.push(list);
  if (clusters.length === 0) return new Set();
  return mergeClusters(em, clusters);
}

/**
 * Turn each selected quad's corner list by one — Blender's
 * `bmesh.ops.flip_quad_tessellation(faces=)`.
 *
 * **No geometry moves and no vertex is added.** What changes is which diagonal
 * a quad implicitly splits along, because a fan triangulation starts at the
 * face's first corner: `[a, b, c, d]` cuts a-c and `[b, c, d, a]` cuts b-d. On
 * a quad that is not flat those are two different surfaces, which is why the
 * operator exists at all — and why `quadsToTris` and this one have to agree
 * about where a face starts.
 *
 * Measured: Blender turns the list rather than reversing it, so the winding
 * and the normal are untouched.
 *
 * **Quads only** (`f->len == 4` in `bmo_flip_quad_tessellation_exec`). Until
 * 2026-09-25 this turned n-gons too, and an n-gon's BEAUTY triangulation
 * depends on where it starts: `arm`'s two hexagon caps came out split
 * differently from Blender's, which only a face-set comparison could see
 * (compat-backlog A5).
 */
export function flipQuadTessellation(em: EditMesh, selectedFaces: ReadonlySet<number>): Set<number> {
  if (selectedFaces.size === 0) return new Set();
  const polys = toPolygons(em);
  const out = polys.map((poly, f) =>
    selectedFaces.has(f) && poly.length === 4 ? [...poly.slice(1), poly[0]!] : [...poly],
  );
  rebuildPolygons(em, em.positions, out, {});
  return new Set(selectedFaces);
}

// ── Non-planar faces, edge rings ───────────────────────────────────────────

// The search below runs in **float32, in the C's order**, because on a quad
// that is what decides it. Both candidates leave two triangles, each exactly
// planar, so both errors are zero in exact arithmetic and Blender compares
// two float32 roundings of zero with `<` — `v1`-`v3` wins where its noise
// comes out smaller. Until 2026-09-25 forge3d kept `v0`-`v2` on every tie
// (a decision recorded then as "not worth imitating"); the owner reversed it,
// and `probe-nonplanar6.py` had already shown the float32 arithmetic
// reproduces Blender's picks.
const f32np = Math.fround;

/** `dot_v3v3` in float: `(a0·b0 + a1·b1) + a2·b2`. */
function dotNp(a: readonly number[], b: readonly number[]): number {
  return f32np(f32np(f32np(a[0]! * b[0]!) + f32np(a[1]! * b[1]!)) + f32np(a[2]! * b[2]!));
}

/** `normalize_v3`: times `1 / length`; returns the length, 0 when degenerate. */
function normalizeNp(n: number[]): number {
  const d = dotNp(n, n);
  if (!(d > 1.0e-35)) {
    n[0] = n[1] = n[2] = 0;
    return 0;
  }
  const len = f32np(Math.sqrt(d));
  const s = f32np(1 / len);
  n[0] = f32np(n[0]! * s);
  n[1] = f32np(n[1]! * s);
  n[2] = f32np(n[2]! * s);
  return len;
}

const coNp = (P: Float32Array, v: number): number[] => [P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!];

/**
 * Newell's normal of one stretch of a face's corners — Blender's
 * `BM_face_calc_normal_subset`, including the detail that decides the quad
 * case: the sum starts from the **last** corner of the stretch, so the
 * sub-polygon is closed and a three-corner stretch gets its triangle's exact
 * plane normal.
 *
 * @returns the unit normal, or `null` if the stretch is degenerate — which
 *   disqualifies the pair, as `!= 0.0f` does there
 */
function subsetNormal(P: Float32Array, cycle: readonly number[]): number[] | null {
  const n = [0, 0, 0];
  let prev = coNp(P, cycle[cycle.length - 1]!);
  for (const v of cycle) {
    const cur = coNp(P, v);
    // `add_newell_cross_v3_v3v3`
    n[0] = f32np(n[0]! + f32np(f32np(prev[1]! - cur[1]!) * f32np(prev[2]! + cur[2]!)));
    n[1] = f32np(n[1]! + f32np(f32np(prev[2]! - cur[2]!) * f32np(prev[0]! + cur[0]!)));
    n[2] = f32np(n[2]! + f32np(f32np(prev[0]! - cur[0]!) * f32np(prev[1]! + cur[1]!)));
    prev = cur;
  }
  return normalizeNp(n) !== 0 ? n : null;
}

/**
 * How far one stretch of corners departs from its own plane: the total
 * absolute change in height around it, the height being `dot(no, v)` —
 * Blender's `bm_face_subset_calc_planar` (its `dot_m3_v3_row_z` of the
 * `axis_dominant_v3_to_m3` matrix is the normal's own dot product).
 */
function subsetPlanarError(P: Float32Array, cycle: readonly number[], no: readonly number[]): number {
  let delta = 0;
  let prev = dotNp(no, coNp(P, cycle[cycle.length - 1]!));
  for (const v of cycle) {
    const cur = dotNp(no, coNp(P, v));
    delta = f32np(delta + Math.abs(f32np(cur - prev)));
    prev = cur;
  }
  return delta;
}

/** `BM_face_normal_update`: a triangle's cross, a quad's diagonals, Newell beyond. */
function faceNormalNp(P: Float32Array, face: readonly number[]): number[] {
  const sub = (a: number[], b: number[]): number[] => [f32np(a[0]! - b[0]!), f32np(a[1]! - b[1]!), f32np(a[2]! - b[2]!)];
  const cross = (a: number[], b: number[]): number[] => [
    f32np(f32np(a[1]! * b[2]!) - f32np(a[2]! * b[1]!)),
    f32np(f32np(a[2]! * b[0]!) - f32np(a[0]! * b[2]!)),
    f32np(f32np(a[0]! * b[1]!) - f32np(a[1]! * b[0]!)),
  ];
  const c = face.map((v) => coNp(P, v));
  let n: number[];
  if (face.length === 3) n = cross(sub(c[0]!, c[1]!), sub(c[1]!, c[2]!));
  else if (face.length === 4) n = cross(sub(c[0]!, c[2]!), sub(c[1]!, c[3]!));
  else return subsetNormal(P, face) ?? [0, 0, 0];
  normalizeNp(n);
  return n;
}

/**
 * Is the face convex in its own projection? `axis_dominant_v3_to_m3` then
 * `is_poly_convex_v2`, in float — the first thing `BM_face_splits_check_legal`
 * asks, and on a convex face every cut is legal.
 */
function isConvexNp(P: Float32Array, face: readonly number[], no: readonly number[]): boolean {
  // `ortho_basis_v3v3_v3`
  let n1: number[];
  let n2: number[];
  const f = f32np(f32np(no[0]! * no[0]!) + f32np(no[1]! * no[1]!));
  if (f > 1.1920929e-7) {
    const d = f32np(1 / f32np(Math.sqrt(f)));
    n1 = [f32np(no[1]! * d), f32np(-no[0]! * d), 0];
    n2 = [f32np(-no[2]! * n1[1]!), f32np(no[2]! * n1[0]!), f32np(f32np(no[0]! * n1[1]!) - f32np(no[1]! * n1[0]!))];
  } else {
    n1 = [no[2]! < 0 ? -1 : 1, 0, 0];
    n2 = [0, 1, 0];
  }
  const pv = face.map((v) => {
    const c = coNp(P, v);
    return [dotNp(n1, c), dotNp(n2, c)];
  });
  const n = pv.length;
  let flag = 0;
  let prevCo = pv[n - 1]!;
  let dirPrev = [f32np(pv[n - 2]![0]! - prevCo[0]!), f32np(pv[n - 2]![1]! - prevCo[1]!)];
  for (let a = 0; a < n; a++) {
    const cur = pv[a]!;
    const dirCur = [f32np(prevCo[0]! - cur[0]!), f32np(prevCo[1]! - cur[1]!)];
    const cr = f32np(f32np(dirPrev[0]! * dirCur[1]!) - f32np(dirPrev[1]! * dirCur[0]!));
    if (cr < 0) flag |= 1;
    else if (cr > 0) flag |= 2;
    if (flag === 3) return false;
    dirPrev = dirCur;
    prevCo = cur;
  }
  return true;
}

/**
 * Would this cut leave the face? True when the diagonal crosses one of the
 * face's own edges, or when its midpoint falls outside, in the projection
 * along the face's normal.
 *
 * Stands in for Blender's `BM_face_splits_check_legal`, which the search
 * consults **before** accepting a pair — so an illegal best cut hands the row
 * to the runner-up rather than being taken. On a convex face nothing is
 * rejected; it matters for the concave n-gons `dissolveLimit` leaves behind,
 * where the cheapest pair can lie outside the outline entirely.
 */
function nonplanarCutLeavesFace(
  P: Float32Array,
  face: readonly number[],
  ia: number,
  ib: number,
  no: readonly [number, number, number],
): boolean {
  const n = face.length;
  const up: [number, number, number] = Math.abs(no[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const d = up[0] * no[0] + up[1] * no[1] + up[2] * no[2];
  let ax = up[0] - no[0] * d;
  let ay = up[1] - no[1] * d;
  let az = up[2] - no[2] * d;
  const alen = Math.hypot(ax, ay, az);
  if (!(alen > 1e-30)) return false;
  ax /= alen;
  ay /= alen;
  az /= alen;
  const bx = no[1] * az - no[2] * ay;
  const by = no[2] * ax - no[0] * az;
  const bz = no[0] * ay - no[1] * ax;
  const flat = face.map((v) => {
    const o = v * 3;
    return [P[o]! * ax + P[o + 1]! * ay + P[o + 2]! * az, P[o]! * bx + P[o + 1]! * by + P[o + 2]! * bz] as [number, number];
  });

  const side = (o: [number, number], a: [number, number], b: [number, number]): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const p0 = flat[ia]!;
  const p1 = flat[ib]!;
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    if (k === ia || k === ib || j === ia || j === ib) continue;
    const q0 = flat[k]!;
    const q1 = flat[j]!;
    if (side(p0, p1, q0) * side(p0, p1, q1) < 0 && side(q0, q1, p0) * side(q0, q1, p1) < 0) return true;
  }

  const mx = (p0[0] + p1[0]) / 2;
  const my = (p0[1] + p1[1]) / 2;
  let crossings = 0;
  for (let k = 0; k < n; k++) {
    const q0 = flat[k]!;
    const q1 = flat[(k + 1) % n]!;
    if (q0[1] > my !== q1[1] > my) {
      const t = (my - q0[1]) / (q1[1] - q0[1]);
      if (q0[0] + t * (q1[0] - q0[0]) > mx) crossings++;
    }
  }
  return crossings % 2 === 0;
}

/**
 * The cut Blender's search would take through one face, or `null` for none.
 *
 * `bm_face_split_find`: every pair of non-adjacent corners, scored by how
 * non-planar the two halves it would leave are, the smallest total winning
 * by a strict float32 `<` — so an exact tie keeps the pair reached first.
 * `cos` is the angle between those halves' normals, which the caller
 * compares against the limit.
 *
 * Legality (`BM_face_splits_check_legal`) is asked only of a pair that would
 * win, and an illegal one is simply passed over. On a convex face every cut
 * is legal, decided exactly as Blender does; a concave face falls back to
 * forge3d's own inside-the-outline test, which is where this is not a port.
 */
function nonplanarBestCut(
  P: Float32Array,
  face: readonly number[],
): { ia: number; ib: number; cos: number } | null {
  const n = face.length;
  const whole = faceNormalNp(P, face);
  let convex: boolean | null = null;
  let errBest = 3.4028234663852886e38;
  let best: { ia: number; ib: number; cos: number } | null = null;
  for (let ia = 0; ia < n; ia++) {
    for (let ib = ia + 2; ib < n; ib++) {
      if (ia === 0 && ib === n - 1) continue; // adjacent around the wrap
      const a: number[] = [];
      for (let k = ia; k <= ib; k++) a.push(face[k]!);
      const b: number[] = [];
      for (let k = ib; k <= ia + n; k++) b.push(face[k % n]!);
      const noA = subsetNormal(P, a);
      if (!noA) continue;
      const noB = subsetNormal(P, b);
      if (!noB) continue;
      const err = f32np(subsetPlanarError(P, a, noA) + subsetPlanarError(P, b, noB));
      if (!(err < errBest)) continue;
      convex ??= isConvexNp(P, face, whole);
      if (!convex && nonplanarCutLeavesFace(P, face, ia, ib, whole as [number, number, number])) continue;
      errBest = err;
      best = { ia, ib, cos: dotNp(noA, noB) };
    }
  }
  return best;
}

/**
 * Split one face as far as the limit asks, depth first.
 *
 * Blender pushes both halves back onto a stack and keeps going while they have
 * more than three corners, so one call can cut an n-gon several times — and
 * can stop early, leaving a quad whole because *its* two halves are within the
 * limit even though the face it came from was not.
 */
function splitNonplanarFace(
  P: Float32Array,
  face: readonly number[],
  limitCos: number,
  into: number[][],
): void {
  if (face.length <= 3) {
    into.push([...face]);
    return;
  }
  const cut = nonplanarBestCut(P, face);
  if (!cut || !(cut.cos < limitCos)) {
    into.push([...face]);
    return;
  }
  const n = face.length;
  const a: number[] = [];
  for (let k = cut.ia; k <= cut.ib; k++) a.push(face[k]!);
  const b: number[] = [];
  for (let k = cut.ib; k <= cut.ia + n; k++) b.push(face[k % n]!);
  splitNonplanarFace(P, a, limitCos, into);
  splitNonplanarFace(P, b, limitCos, into);
}

/**
 * Split the faces that are not flat — Blender's
 * `bmesh.ops.connect_verts_nonplanar(faces=, angle_limit=)`.
 *
 * A quad whose four corners do not lie in one plane has no single surface: it
 * is two triangles, and **which two depends on the diagonal**, so every
 * consumer that triangulates it is free to pick a different answer. Splitting
 * it here settles that once, in the file, instead of leaving it to the
 * renderer and the exporter to disagree about.
 *
 * The rule, read off `bmo_connect_nonplanar.cc` rather than guessed: for every
 * pair of non-adjacent corners, measure how far each of the two halves that
 * pair would leave departs from its own plane, and take the pair whose two
 * errors add to the least. Cut it only if the angle between those halves'
 * normals exceeds `angleLimit` (radians) — so the limit is about the fold the
 * cut would reveal, not about how far a corner sits off the face's average
 * plane. Then repeat on both halves.
 *
 * **On a quad the geometry cannot decide — float32 does.** Both candidates
 * leave two triangles, each exactly planar, so both errors are zero in exact
 * arithmetic; Blender's float32 rounding of those zeros picks the winner, and
 * on a bent 4×4 sheet that is `v1`-`v3` on 6 of 16 quads with no geometric
 * reason. It is imitated (since 2026-09-25, the owner's call): the search
 * runs in float32 in the C's order and matches Blender quad for quad on five
 * bent sheets (`connect-nonplanar` parity row). A quad whose projection is
 * not convex is left whole when no cut is legal, as Blender leaves it.
 *
 * Returns the faces it produced — both halves of every face that was cut.
 */
export function connectVertsNonplanar(
  em: EditMesh,
  selectedFaces: ReadonlySet<number>,
  angleLimit: number,
): Set<number> {
  if (selectedFaces.size === 0) return new Set();

  const polys = toPolygons(em);
  const P = em.positions;
  const limitCos = Math.fround(Math.cos(Math.fround(angleLimit))); // `cosf(angle_limit)`
  const out: number[][] = [];
  const made = new Set<number>();

  for (let f = 0; f < polys.length; f++) {
    const poly = polys[f]!;
    if (!selectedFaces.has(f) || poly.length < 4) {
      out.push([...poly]);
      continue;
    }
    const pieces: number[][] = [];
    splitNonplanarFace(P, poly, limitCos, pieces);
    if (pieces.length === 1) {
      out.push(pieces[0]!);
      continue;
    }
    for (const piece of pieces) {
      made.add(out.length);
      out.push(piece);
    }
  }

  if (made.size === 0) return new Set();
  rebuildPolygons(em, em.positions, out, {});
  return made;
}

/** `subdivide_edgering`'s shape options. The defaults are `bmesh.ops`'s — the cuts stay on the edges. */
export interface SubdivideEdgeringOptions {
  /** `interp_mode`. Default `LINEAR`; Bridge Edge Loops and Subdivide Edge-Ring in the UI use `PATH`. */
  interpolation?: EdgeringInterpolation;
  /** `smooth`: how far the splines reach. Default 0 (the UI's is 1). */
  smooth?: number;
  /** `profile_shape`. Default `SMOOTH`. */
  profileShape?: SubdivideFalloff;
  /** `profile_shape_factor`: how much the middle loops shrink (−) or swell (+). Default 0. */
  profileShapeFactor?: number;
}

/**
 * Cut across the faces a ring of edges runs through — Blender's
 * `bmesh.ops.subdivide_edgering(edges=, cuts=, interp_mode=, smooth=,
 * profile_shape=, profile_shape_factor=)`, `bmo_subdivide_edgering.cc`.
 *
 * The many-ring form of `loopCut`. Given the edges that run *along* a tube,
 * every quad they cross is cut `cuts` times perpendicular to them, so an
 * eight-sided tube three bands tall comes back six bands tall — measured, 32
 * vertices and 24 faces become 56 and 48 at `cuts` 1.
 *
 * **Scope: quads crossed by exactly two of the selected edges, opposite each
 * other, and triangles with two** (the fan a bridge between loops of
 * different lengths makes — the cuts step towards the corner the two share,
 * `bm_face_slice`). A face with one ring edge, or with more than four sides,
 * is not crossed: its ring edges gain the cuts and it grows, as Blender's
 * `BM_edge_split` leaves it — that is where an open ring ends. Only the
 * edges joining a pair of rim loops that the ring joins at every vertex are
 * cut (every such edge, selected or not); no such pair throws, where Blender
 * cancels with an error and changes nothing. Each piece of a cut edge keeps
 * its crease, seam and sharp flag. A quad with
 * two **adjacent** ring edges (or three, or four) is refused: Blender slices
 * it from its first rim edge, which is not a ring's cut. `subdivideEdges` is
 * the operator for cutting edges without deciding what the faces should
 * become.
 *
 * Then the new vertices move (`bm_edgering_pair_interpolate`,
 * `edgering-interp.ts`): each pair of rim loops — the edges of the cut
 * faces that are not in the ring — is joined by a spline between their
 * centres (`PATH`) or one per edge (`SURFACE`), and a profile can shrink
 * or swell the loops in between. `LINEAR` with no profile leaves them on the
 * edges. `subdivide-edgering*` parity rows.
 *
 * Returns the faces it produced.
 */
export function subdivideEdgering(
  em: EditMesh,
  selectedEdges: ReadonlySet<number>,
  cuts: number,
  opts: SubdivideEdgeringOptions = {},
): Set<number> {
  const n = Math.max(0, Math.floor(cuts));
  if (n === 0 || selectedEdges.size === 0) return new Set();

  const chosen = new Set<string>();
  for (const heRaw of selectedEdges) {
    if (!em.halfEdges[heRaw]) continue;
    chosen.add(seamKey(edgeOrigin(em, heRaw), edgeEnd(em, heRaw)));
  }

  const polys = toPolygons(em);
  const P = em.positions;
  // The rim loops and their pairs, before anything is cut; Blender's errors.
  const plan = edgeringPlan(P, polys, chosen);
  const positions: number[] = Array.from(P);
  let nextV = em.vertices.length;
  // Where each cut sits, for the UV / colour layers (`BM_edge_split`).
  const origins = new Map<number, VertexOrigin>();
  // One run of cut vertices per undirected edge, shared by both its faces.
  const cutsOn = new Map<string, number[]>();
  const cutRun = (a: number, b: number): number[] => {
    const key = seamKey(a, b);
    const found = cutsOn.get(key);
    if (found) return a < b ? found : [...found].reverse();
    const made: number[] = [];
    for (let k = 1; k <= n; k++) {
      const t = k / (n + 1);
      const lo = a < b ? a : b;
      const hi = a < b ? b : a;
      origins.set(nextV, { from: [lo, hi], w: [1 - t, t] });
      made.push(nextV++);
      positions.push(
        P[lo * 3]! + (P[hi * 3]! - P[lo * 3]!) * t,
        P[lo * 3 + 1]! + (P[hi * 3 + 1]! - P[lo * 3 + 1]!) * t,
        P[lo * 3 + 2]! + (P[hi * 3 + 2]! - P[lo * 3 + 2]!) * t,
      );
    }
    cutsOn.set(key, made);
    // BM_edge_split copies the edge's crease, seam and sharp flag to each piece.
    carryEdgeFlags(em, a < b ? a : b, a < b ? b : a, made);
    return a < b ? made : [...made].reverse();
  };

  const out: number[][] = [];
  const made = new Set<number>();
  for (let f = 0; f < polys.length; f++) {
    const poly = polys[f]!;
    const hits: number[] = [];
    for (let i = 0; i < poly.length; i++)
      if (plan.cut.has(seamKey(poly[i]!, poly[(i + 1) % poly.length]!))) hits.push(i);

    if (hits.length === 0) {
      out.push([...poly]);
      continue;
    }
    if (!plan.faceOut.has(f)) {
      // Not a face the ring crosses (Blender's FACE_OUT wants four sides or
      // fewer and two ring edges): its cut edges are split and it grows.
      const grown: number[] = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i]!;
        const b = poly[(i + 1) % poly.length]!;
        grown.push(a);
        if (hits.includes(i)) grown.push(...cutRun(a, b));
      }
      made.add(out.length);
      out.push(grown);
      continue;
    }
    if (poly.length === 3 && hits.length === 2) {
      // Two ring edges meet at a corner: the rim is the third edge, p–q, and
      // the cuts step from it towards the corner r.
      const rimAt = [0, 1, 2].find((i) => !hits.includes(i))!;
      const p = poly[rimAt]!;
      const q = poly[(rimAt + 1) % 3]!;
      const rr = poly[(rimAt + 2) % 3]!;
      const alongP = [p, ...cutRun(p, rr)];
      const alongQ = [q, ...cutRun(q, rr)];
      for (let k = 0; k < n; k++) {
        made.add(out.length);
        out.push([alongP[k]!, alongQ[k]!, alongQ[k + 1]!, alongP[k + 1]!]);
      }
      made.add(out.length);
      out.push([alongP[n]!, alongQ[n]!, rr]);
      continue;
    }
    const opposite =
      poly.length === 4 && hits.length === 2 && Math.abs(hits[0]! - hits[1]!) === 2;
    if (!opposite)
      throw new Error(
        `subdivideEdgering: a ${poly.length}-sided face has ${hits.length} selected ` +
          `edge(s) on it, not two opposite ones — that is not a ring, and cutting ` +
          `it anywhere would be a guess.`,
      );

    // The quad reads a, b, c, d with the selected edges a-b and c-d. Cut runs
    // go along each, and the new faces stack between them.
    const i0 = hits[0]!;
    const a = poly[i0]!;
    const b = poly[(i0 + 1) % 4]!;
    const c = poly[(i0 + 2) % 4]!;
    const d = poly[(i0 + 3) % 4]!;
    const along1 = [a, ...cutRun(a, b), b];
    const along2 = [d, ...cutRun(d, c), c];
    for (let k = 0; k < along1.length - 1; k++) {
      made.add(out.length);
      out.push([along1[k]!, along1[k + 1]!, along2[k + 1]!, along2[k]!]);
    }
  }

  edgeringInterpolate(positions, plan, cutRun, n, {
    interpolation: opts.interpolation ?? "LINEAR",
    smooth: opts.smooth ?? 0,
    profileShape: opts.profileShape ?? "SMOOTH",
    profileShapeFactor: opts.profileShapeFactor ?? 0,
  });
  rebuildPolygons(em, new Float32Array(positions), out, { origins });
  return made;
}

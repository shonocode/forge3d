/**
 * Taking geometry away — Blender's dissolve family.
 *
 * Dissolving is not deleting. Deleting a face leaves a hole; dissolving it
 * merges it into its neighbours and leaves the surface intact. It is how a
 * generated mesh gets back down to the faces that carry shape, and the reason
 * `weldMesh` was never enough: welding moves vertices together, dissolving
 * removes the edges that stopped two faces being one.
 *
 * All three are measured against Blender 5.1.1 — see
 * `tools/modeling/parity/README.md`.
 *
 * Pure and headless — Vitest-pinned.
 */
import { rebuildPolygons, seamKey, toPolygons, type EditMesh } from "./half-edge";
import { meshFromData, meshToData } from "../../lib/mesh";
import { connectVertsPolys } from "./connect-pair";
import type { V3 } from "../blender-math";
import { dissolveLimitMesh, type DissolveDelimit } from "../dissolve-limit";

/** Shared by the three: what came out, for callers that want to assert on it. */
export interface DissolveReport {
  /** Faces that were merged away (before minus after, within the selection). */
  merged: number;
  /** Vertices removed because they were left with two edges. */
  vertsRemoved: number;
  /**
   * Regions whose border was not a single closed loop — a ring of faces around
   * a hole, or a selection pinched at a vertex. Left untouched: merging them
   * would need a polygon with a hole in it, which this representation has no
   * way to hold.
   */
  skipped: number;
}

const blank = (): DissolveReport => ({ merged: 0, vertsRemoved: 0, skipped: 0 });

/**
 * Walk a set of directed edges into one cycle.
 *
 * Returns null when they do not form exactly one — which is the honest answer
 * for a ring of faces round a hole, and the case the caller has to skip rather
 * than mangle.
 */
function walkLoop(directed: Array<[number, number]>): number[] | null {
  if (directed.length < 3) return null;
  const next = new Map<number, number>();
  for (const [a, b] of directed) {
    if (next.has(a)) return null; // a vertex leaving twice: pinched, not a loop
    next.set(a, b);
  }
  const start = directed[0]![0];
  const loop: number[] = [start];
  let cur = next.get(start)!;
  while (cur !== start) {
    if (cur === undefined || loop.length > directed.length) return null;
    loop.push(cur);
    cur = next.get(cur)!;
  }
  return loop.length === directed.length ? loop : null;
}

/**
 * Merge each connected group of faces into one polygon.
 *
 * `groups` maps a face index to the group it belongs to; faces with no entry
 * are passed through. This is the engine under all three public functions —
 * dissolving edges and dissolving by angle both come down to deciding which
 * faces belong together, and then this.
 */
function mergeGroups(
  em: EditMesh,
  groups: Map<number, number>,
  useVerts: boolean,
  report: DissolveReport,
): void {
  const polys = toPolygons(em);
  const byGroup = new Map<number, number[]>();
  for (const [face, g] of groups) {
    const list = byGroup.get(g);
    if (list) list.push(face);
    else byGroup.set(g, [face]);
  }

  const newPolys: number[][] = [];
  const consumed = new Set<number>();
  /** Endpoints of the edges that were dissolved — what `useVerts` acts on. */
  const interior = new Set<number>();

  for (const [, faces] of byGroup) {
    if (faces.length < 2) continue;

    // Edges used once inside the group are its border; the rest are internal
    // and are what dissolving removes.
    const uses = new Map<string, number>();
    for (const f of faces) {
      const poly = polys[f]!;
      for (let i = 0; i < poly.length; i++)
        uses.set(
          seamKey(poly[i]!, poly[(i + 1) % poly.length]!),
          (uses.get(seamKey(poly[i]!, poly[(i + 1) % poly.length]!)) ?? 0) + 1,
        );
    }

    const border: Array<[number, number]> = [];
    for (const f of faces) {
      const poly = polys[f]!;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i]!;
        const b = poly[(i + 1) % poly.length]!;
        if (uses.get(seamKey(a, b)) === 1) border.push([a, b]);
      }
    }

    const loop = walkLoop(border);
    if (!loop) {
      report.skipped++;
      continue;
    }

    for (const f of faces) consumed.add(f);
    report.merged += faces.length - 1;
    newPolys.push(loop);

    for (const [key, n] of uses) {
      if (n < 2) continue; // border, not dissolved
      const [a, b] = key.split("_");
      interior.add(Number(a));
      interior.add(Number(b));
    }
  }

  if (newPolys.length === 0 && consumed.size === 0) return;

  const out: number[][] = [];
  for (let f = 0; f < polys.length; f++) if (!consumed.has(f)) out.push(polys[f]!);
  for (const poly of newPolys) out.push(poly);

  // `useVerts`: the endpoints of the edges that were dissolved go too.
  //
  // Not "every vertex left with two edges" — that was the first guess and it
  // is wrong in a way the tests caught: once a region has merged into a single
  // polygon, *every* one of its vertices has two edges, so that rule removes
  // the whole outline. Blender's rule is narrower and the measurement says so
  // exactly: a 2x1 grid loses the two vertices that were on its internal edge
  // and keeps its four corners, and a 3x1 grid loses four.
  //
  // Nor is it a collinearity test. The bent pair dissolved at 0.6 rad loses its
  // fold vertices even though they are not in line with anything.
  if (useVerts && interior.size > 0) {
    // Of those, the ones now sitting on exactly two edges: a vertex the
    // surface runs straight through, holding nothing together.
    //
    // The first version also required the vertex to belong to a single face,
    // on the theory that removing a shared one would leave a T-junction. It
    // does not — two edges means two faces at most, and both lose the vertex
    // together. The guard cost 20 vertices on the 150-vertex body cage, which
    // is how it was caught.
    const edgesAt = new Map<number, Set<string>>();
    for (const poly of out)
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i]!;
        const b = poly[(i + 1) % poly.length]!;
        const key = seamKey(a, b);
        for (const v of [a, b]) {
          const set = edgesAt.get(v);
          if (set) set.add(key);
          else edgesAt.set(v, new Set([key]));
        }
      }

    const drop = new Set<number>();
    for (const v of interior) if (edgesAt.get(v)?.size === 2) drop.add(v);

    if (drop.size > 0) {
      // The per-corner layers go through the same three steps: the join
      // (each corner from the face that owned its outgoing edge, as
      // `BM_faces_join` keeps it), the dropped corners, then the renumbering.
      rebuildPolygons(em, em.positions, out.map((p) => [...p]), { joins: true });
      for (let i = 0; i < out.length; i++) {
        const trimmed = out[i]!.filter((v) => !drop.has(v));
        if (trimmed.length >= 3) out[i] = trimmed;
      }
      rebuildPolygons(em, em.positions, out.map((p) => [...p]), {});
      report.vertsRemoved = drop.size;

      // Compact, so a dissolved vertex is gone rather than orphaned. Blender
      // reports 8 verts becoming 4 on a 3x1 grid, not 8 with four unreferenced
      // — and an orphan would travel all the way into the glTF.
      const used = new Set<number>();
      for (const poly of out) for (const v of poly) used.add(v);
      const remap = new Int32Array(em.positions.length / 3).fill(-1);
      const kept: number[] = [];
      for (let v = 0; v < em.positions.length / 3; v++) {
        if (!used.has(v)) continue;
        remap[v] = kept.length / 3;
        kept.push(em.positions[v * 3]!, em.positions[v * 3 + 1]!, em.positions[v * 3 + 2]!);
      }
      rebuildPolygons(
        em,
        new Float32Array(kept),
        out.map((poly) => poly.map((v) => remap[v]!)),
        { sameCorners: true, vertexMap: remap },
      );
      return;
    }
  }

  rebuildPolygons(em, em.positions, out, { joins: true });
}

/**
 * Merge the selected faces into one polygon per connected group — Blender's
 * `bmesh.ops.dissolve_faces(faces=, use_verts=)`.
 *
 * The shared edges go, the outline stays. Two quads side by side become one
 * hexagon; with `useVerts` the two straight vertices left on the outline go
 * too and it becomes a quad. Both numbers are measured.
 *
 * A group whose border is not a single closed loop — faces ringing a hole — is
 * left alone and counted in `report.skipped`, because the result would be a
 * polygon with a hole and {@link MeshData} has nowhere to put one.
 */
export function dissolveFaces(
  em: EditMesh,
  selectedFaces: ReadonlySet<number>,
  opts: { useVerts?: boolean } = {},
  report: DissolveReport = blank(),
): DissolveReport {
  if (selectedFaces.size < 2) return report;

  // Group the selection by adjacency: faces that touch are merged together,
  // faces that merely happen to be selected are not.
  const polys = toPolygons(em);
  const byEdge = new Map<string, number[]>();
  for (const f of selectedFaces) {
    const poly = polys[f]!;
    for (let i = 0; i < poly.length; i++) {
      const k = seamKey(poly[i]!, poly[(i + 1) % poly.length]!);
      const list = byEdge.get(k);
      if (list) list.push(f);
      else byEdge.set(k, [f]);
    }
  }

  const groups = new Map<number, number>();
  let nextGroup = 0;
  for (const seed of selectedFaces) {
    if (groups.has(seed)) continue;
    const g = nextGroup++;
    const queue = [seed];
    groups.set(seed, g);
    while (queue.length > 0) {
      const f = queue.pop()!;
      const poly = polys[f]!;
      for (let i = 0; i < poly.length; i++) {
        const k = seamKey(poly[i]!, poly[(i + 1) % poly.length]!);
        for (const other of byEdge.get(k) ?? []) {
          if (groups.has(other)) continue;
          groups.set(other, g);
          queue.push(other);
        }
      }
    }
  }

  mergeGroups(em, groups, opts.useVerts ?? false, report);
  return report;
}

/**
 * Remove the selected edges, merging the faces they separated — Blender's
 * `bmesh.ops.dissolve_edges(edges=, use_verts=)`.
 *
 * Takes half-edge indices. An edge on the mesh boundary has only one face and
 * nothing to merge, so it is ignored rather than deleted — dissolving is not
 * deleting, and `deleteFacesByEdges` is the operator that removes geometry.
 *
 * ## With `useVerts`, this is also Blender's `delete_edgeloop`
 *
 * `bpy.ops.mesh.delete_edgeloop(use_face_split=False)` and
 * `bmesh.ops.dissolve_edges(use_verts=True)` return **the same faces** on
 * every arrangement measured: a grid's middle column, a grid's middle row, a
 * cylinder's closed ring, half a column, and one edge on its own
 * (`tools/modeling/parity/probe-delete-edgeloop2.py`). The `delete-edgeloop`
 * parity row drives the `bpy.ops` side against this function and agrees to
 * 0.0000 mm on a flat sheet and a bent one.
 *
 * The API matrix had `delete_edgeloop` down as missing. It was here under
 * another name — the third time that has happened, after
 * `face_split_by_edges`'s "structurally impossible" and `DECIMATE`'s Planar
 * mode turning out to be `dissolveLimit`.
 *
 * **`use_face_split=True` is the one difference, and only off a loop.** With
 * it on, a selection that is *not* a loop — half a grid column — comes back as
 * three triangles where this gives one five-gon. On an actual loop the two
 * settings are identical, measured both ways.
 */
export function dissolveEdges(
  em: EditMesh,
  selectedEdges: ReadonlySet<number>,
  opts: { useVerts?: boolean } = {},
  report: DissolveReport = blank(),
): DissolveReport {
  const groups = new Map<number, number>();
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    parent.set(ra, rb);
  };

  let any = false;
  for (const he of selectedEdges) {
    const h = em.halfEdges[he];
    if (!h || h.twin < 0) continue; // boundary: nothing on the other side
    const f1 = h.face;
    const f2 = em.halfEdges[h.twin]!.face;
    if (f1 === f2) continue;
    if (parent.get(f1) === undefined) parent.set(f1, f1);
    if (parent.get(f2) === undefined) parent.set(f2, f2);
    union(f1, f2);
    any = true;
  }
  if (!any) return report;

  for (const f of parent.keys()) groups.set(f, find(f));
  mergeGroups(em, groups, opts.useVerts ?? false, report);
  return report;
}

/** Options for {@link dissolveLimit}. */
export interface DissolveLimitOptions {
  /**
   * Blender's `angle_limit`, in **radians** (clamped to π/2). Faces whose
   * normals are less than this apart are joined, and vertices whose edges
   * turn by less are removed.
   *
   * Strictly less: measured, a limit of exactly 0 leaves a perfectly flat grid
   * alone, and 0.01 merges it into one quad.
   */
  angleLimit: number;
  /**
   * `delimit` — edges that are never dissolved. Default none, as
   * `bmesh.ops.dissolve_limit`; Blender's Limited Dissolve in the editor and
   * the Decimate modifier default to `["normal"]`.
   */
  delimit?: Iterable<DissolveDelimit>;
  /** `use_dissolve_boundaries`: remove every input vertex left between two edges. */
  useDissolveBoundaries?: boolean;
  /** The input vertices (default all). */
  verts?: Iterable<number>;
  /** The input edges as vertex pairs (default all). */
  edges?: Iterable<readonly [number, number]>;
}

/**
 * Dissolve every edge flat enough not to be carrying shape — Blender's
 * `bmesh.ops.dissolve_limit(angle_limit=)`, "Limited Dissolve", and the
 * Decimate modifier's Planar mode. The procedure is Blender's
 * `BM_mesh_decimate_dissolve_ex`, see {@link dissolveLimitMesh}: faces joined
 * across their flattest edge first, one at a time, then the vertices left
 * between two edges.
 *
 * This is the one that earns its keep on generated geometry: a room built from
 * boxes and lathes arrives with thousands of coplanar quads that exist because
 * of how it was made, not because of what it looks like.
 *
 * Unlike the other dissolves here, vertices that end up on nothing are
 * removed and the rest renumbered, as Blender does — the mesh is rebuilt.
 */
export function dissolveLimit(
  em: EditMesh,
  opts: DissolveLimitOptions,
  report: DissolveReport = blank(),
): DissolveReport {
  const faces = em.faces.length;
  const verts = em.vertices.length;
  const out = dissolveLimitMesh(meshToData(em), opts);
  const source = em.source;
  Object.assign(em, meshFromData(out), { source });
  report.merged += faces - em.faces.length;
  report.vertsRemoved += verts - em.vertices.length;
  return report;
}

/**
 * Remove vertices and merge the faces that met at them — Blender's
 * `bmesh.ops.dissolve_verts(verts=)`.
 *
 * The third of the set. {@link dissolveEdges} takes an edge away and joins the
 * two faces either side; this takes a **corner** away and joins everything that
 * met there, so a vertex with four quads around it comes back as one face with
 * the corner gone.
 *
 * A vertex whose faces do not close into a single ring — one on an open
 * boundary, or where the walk cannot be ordered — is counted in
 * `report.skipped` rather than half-dissolved. That is the same contract
 * {@link dissolveFaces} has, and it exists because a partial dissolve leaves a
 * mesh that looks plausible and is not what was asked for.
 */
export function dissolveVerts(
  em: EditMesh,
  selectedVerts: ReadonlySet<number>,
  report: DissolveReport = blank(),
): DissolveReport {
  if (selectedVerts.size === 0) return report;

  const polys = toPolygons(em);
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };

  // Every face touching a selected vertex joins that vertex's group. A face
  // touching two selected vertices bridges their groups, which is what makes
  // dissolving a run of vertices produce one face rather than several.
  let any = false;
  // A selected vertex with exactly two edges is an edge pair (`BM_vert_is_edge_pair`): no face is joined across it, but the final cleanup
  // merges its two edges, which takes the vertex out of every face on it — a grid corner turns a quad into a triangle (compat-backlog C73).
  {
    const neighbours = new Map<number, Set<number>>();
    for (const poly of polys)
      poly.forEach((v, i) => {
        if (!neighbours.has(v)) neighbours.set(v, new Set());
        neighbours.get(v)!.add(poly[(i + 1) % poly.length]!);
        neighbours.get(v)!.add(poly[(i + poly.length - 1) % poly.length]!);
      });
    for (const v of selectedVerts) if (neighbours.get(v)?.size === 2) any = true;
  }
  for (let f = 0; f < polys.length; f++) {
    const poly = polys[f]!;
    let anchor = -1;
    for (const v of poly) {
      if (!selectedVerts.has(v)) continue;
      if (anchor < 0) {
        anchor = f;
        if (parent.get(f) === undefined) parent.set(f, f);
      }
      // Tie every face at this vertex together.
      for (let g = 0; g < polys.length; g++) {
        if (g === f || !polys[g]!.includes(v)) continue;
        if (parent.get(g) === undefined) parent.set(g, g);
        const rf = find(f);
        const rg = find(g);
        if (rf !== rg) parent.set(rf, rg);
        any = true;
      }
    }
  }
  if (!any) return report;

  const groups = new Map<number, number>();
  for (const f of parent.keys()) groups.set(f, find(f));
  const slots = em.faceMaterials?.length === polys.length ? joinedSlots(polys, selectedVerts, em.faceMaterials) : null;
  mergeGroups(em, groups, false, report);

  // Merging alone is not the operation. Two things are left, and both were
  // found by measurement rather than reasoning:
  //
  // 1. **A selected vertex on the merged border survives the merge.** Only a
  //    fully surrounded one drops out of the boundary loop. Dissolving every
  //    vertex of a 4×4 grid left forge3d with one 16-sided face where Blender
  //    is left with nothing at all — the border vertices were selected too,
  //    and asking for them to go means they go.
  //
  // 2. **The loop that is left can be a face that already exists.** Dissolving
  //    a cube's top four corners merges the top and the four sides, and the
  //    border of that region is the bottom rim — which is the bottom face,
  //    already there. Emitting it gave two coincident quads, area 2.0 against
  //    Blender's 1.0, and **the distance check could not see it**: sampling a
  //    doubled surface gives the same points. Only the area column said so.
  //    Same rule bmesh follows everywhere, and the same one `bridgeEdgeLoops`
  //    needed when it was building tubes with two walls.
  const after = toPolygons(em);
  const seen = new Set<string>();
  const kept: number[][] = [];
  for (const poly of after) {
    const trimmed = poly.filter((v) => !selectedVerts.has(v));
    if (trimmed.length < 3) continue;
    const key = [...trimmed].sort((a, b) => a - b).join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(trimmed);
  }
  rebuildPolygons(em, em.positions, kept, {});
  // The joined faces' slots, as Blender's pairwise joins leave them.
  if (slots && em.faceMaterials?.length === kept.length) {
    const byEdge = new Map<string, number>();
    polys.forEach((p, f) => {
      for (let i = 0; i < p.length; i++) {
        const a = p[i]!;
        const b = p[(i + 1) % p.length]!;
        byEdge.set(`${a}_${b}`, f);
      }
    });
    kept.forEach((p, k) => {
      for (let i = 0; i < p.length; i++) {
        const f = byEdge.get(`${p[i]}_${p[(i + 1) % p.length]}`);
        const s = f !== undefined ? slots.get(f) : undefined;
        if (s !== undefined) {
          em.faceMaterials![k] = s;
          break;
        }
      }
    });
  }

  // Orphaned vertices stay, like every other dissolve here — Blender drops
  // them, and matching that would shift every index above the hole and reach
  // into selection, undo and skin weights. Measured as 8 against 4 on a cube.
  return report;
}

/**
 * Cut faces apart by joining the selected vertices inside them — Blender's
 * `bmesh.ops.connect_verts(verts=)` (`bmo_connect_verts_exec`, ported in {@link connectVertsPolys}).
 *
 * In each face of more than three corners the selected corners are taken in the order they come, **except the ones inside a run**:
 * a corner whose two neighbours are both selected is skipped, so three in a row join their two ends and the middle one is left
 * (compat-backlog C55). Consecutive corners are cut between unless they are neighbours already or the cut was made by an earlier face
 * (`EDGE_OUT`), and the last is joined back to the first. `checkDegenerate` (Blender's slot, default false as `bmesh.ops` leaves it)
 * asks `BM_face_splits_check_legal` of each cut instead of the angle test that picks the face a cut belongs to.
 *
 * Returns the faces it produced.
 */
export function connectVerts(em: EditMesh, selectedVerts: ReadonlySet<number>, options: { checkDegenerate?: boolean } = {}): Set<number> {
  if (selectedVerts.size < 2) return new Set();
  const polys = toPolygons(em).map((p) => [...p]);
  const P: V3[] = [];
  for (let i = 0; i < em.positions.length / 3; i++) P.push([em.positions[i * 3]!, em.positions[i * 3 + 1]!, em.positions[i * 3 + 2]!]);
  const { made } = connectVertsPolys(P, polys, selectedVerts, options.checkDegenerate ?? false);
  if (made.size === 0) return new Set();
  rebuildPolygons(em, em.positions, polys, {});
  return made;
}

/**
 * The slot each dissolved vertex's merged face ends with, keyed by every
 * input face in it — what `bmo_dissolve_verts` leaves: for each vertex in
 * index order, each of its edges in disk order (the order `mesh_calc_edges`
 * made them) with two faces is joined (`BM_faces_join_pair`), and the join
 * keeps `faces[0]`'s slot — `e->l`'s face, the newest on the edge; the joined
 * face is newer than all. A vertex with just two edges is not joined.
 * Measured on a pole's fan (`dissolve-verts-uv`, `bodyMats`), where the
 * first corner's face was the wrong answer.
 */
function joinedSlots(
  polys: readonly (readonly number[])[],
  selected: ReadonlySet<number>,
  materials: readonly number[],
): Map<number, number> {
  // Edges in creation order: per face, (last, first) then on.
  const order = new Map<string, number>();
  const edgeFaces = new Map<string, number[]>();
  polys.forEach((p, f) => {
    for (let i = 0; i < p.length; i++) {
      const a = p[(i - 1 + p.length) % p.length]!;
      const b = p[i]!;
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (!order.has(k)) order.set(k, order.size);
      (edgeFaces.get(k) ?? edgeFaces.set(k, []).get(k)!).push(f);
    }
  });
  // Current face of each input face (a union-find), its age and slot.
  const cur = polys.map((_, f) => f);
  const top = (f: number): number => {
    while (cur[f] !== f) f = cur[f]!;
    return f;
  };
  const age = polys.map((_, f) => f);
  const slot = [...materials];
  let clock = polys.length;
  for (const v of [...selected].sort((a, b) => a - b)) {
    const edges = [...order.keys()].filter((k) => k.split("_").map(Number).includes(v));
    if (edges.length === 2) continue; // `VERT_MARK_PAIR`
    edges.sort((x, y) => order.get(x)! - order.get(y)!);
    for (const k of edges) {
      const fs = edgeFaces.get(k)!;
      if (fs.length !== 2) continue;
      const a = top(fs[0]!);
      const b = top(fs[1]!);
      if (a === b) continue;
      const newest = age[a]! > age[b]! ? a : b;
      const other = newest === a ? b : a;
      cur[other] = newest;
      age[newest] = clock++;
    }
  }
  const out = new Map<number, number>();
  polys.forEach((_, f) => {
    const t = top(f);
    if (t !== f || age[t]! >= polys.length) out.set(f, slot[t]!);
  });
  return out;
}

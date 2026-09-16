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
      for (let i = 0; i < out.length; i++) {
        const trimmed = out[i]!.filter((v) => !drop.has(v));
        if (trimmed.length >= 3) out[i] = trimmed;
      }
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
      );
      return;
    }
  }

  rebuildPolygons(em, em.positions, out);
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
   * Blender's `angle_limit`, in **radians**. An edge whose two faces meet at
   * less than this is dissolved.
   *
   * Strictly less: measured, a limit of exactly 0 leaves a perfectly flat grid
   * alone, and 0.01 merges it into one quad.
   */
  angleLimit: number;
}

/**
 * Dissolve every edge flat enough not to be carrying shape — Blender's
 * `bmesh.ops.dissolve_limit(angle_limit=)`, "Limited Dissolve".
 *
 * This is the one that earns its keep on generated geometry: a room built from
 * boxes and lathes arrives with thousands of coplanar quads that exist because
 * of how it was made, not because of what it looks like. Limited dissolve
 * removes exactly those and leaves every edge that turns a corner.
 *
 * Vertices left with two edges go too, matching Blender — measured on a 3x1
 * grid, which comes back as a single quad rather than a 8-vertex one.
 */
export function dissolveLimit(
  em: EditMesh,
  opts: DissolveLimitOptions,
  report: DissolveReport = blank(),
): DissolveReport {
  const polys = toPolygons(em);
  const P = em.positions;

  const normals: Array<[number, number, number]> = polys.map((poly) => {
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
  });

  const flat = new Set<number>();
  for (let he = 0; he < em.halfEdges.length; he++) {
    const h = em.halfEdges[he]!;
    if (h.twin < 0 || h.twin < he) continue; // each edge once
    const n1 = normals[h.face]!;
    const n2 = normals[em.halfEdges[h.twin]!.face]!;
    const dot = Math.max(-1, Math.min(1, n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2]));
    if (Math.acos(dot) < opts.angleLimit) flat.add(he);
  }

  return dissolveEdges(em, flat, { useVerts: true }, report);
}

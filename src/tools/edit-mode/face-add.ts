/**
 * Making one face out of a set of vertices — Blender's **F** key
 * (`mesh.edge_face_add`).
 *
 * The rest of `refine.ts`'s fills take a *loop* and close it. This takes an
 * unordered set and works the ring out, which is the part a build script
 * cannot do for itself: it knows which vertices it wants joined, not which
 * order they go round in.
 *
 * Pure and headless.
 *
 * ## The rules
 *
 * Measured off Blender 5.1.1 with `tools/modeling/parity/probe-face-add.py`:
 *
 * - **It refuses when the face already exists.** Selecting the four corners of
 *   a quad that is already there returns `CANCELLED` and changes nothing.
 * - **Two vertices make a wire edge**, not a face, and nothing at all when
 *   they already share an edge.
 *
 * Ported from `bmo_contextual_create_exec`'s last resort, "Fill Vertex Cloud"
 * (`bmo_create.cc`), which is what F reaches with vertices and no edges:
 *
 * - **The ring** is `BM_verts_sort_radial_plane`: ascending signed angle about
 *   a normal, measured from a tangent vertex. The normal is
 *   `BM_verts_calc_normal_from_cloud_ex` — the vertex furthest from the
 *   centroid, the one furthest from that one's line, and the cross of the two
 *   diagonals to their opposites (as of Blender 5.1.1 — `main` has since added
 *   a Newell refinement; see `cloudNormal`). Three vertices: a triangle normal.
 * - **The winding** is `BM_face_create_ngon_verts(calc_winding)`: each of the
 *   ring's edges that already has a face votes by the direction of its newest
 *   face (`e->l`); the face is reversed when more run the ring's way than
 *   against it. With no votes it keeps the ring's order.
 *
 * **The free-standing face was refused as unreadable** after seven
 * measurements, and four of them sets picked off a grid, where "the Newell
 * normal in index order" is degenerate. It is not the Newell normal in index
 * order. And on a grid the cloud normal's choices are **ties** (equal
 * distances from the centroid) that Blender breaks in float32 and in C's
 * evaluation order; so this part is computed the same way (`f32` below), the
 * same lesson as `SKIN`'s frames. The three corners `[0, 2, 6]` of a grid tie
 * exactly in double and come out facing the other way.
 */
import {
  rebuildPolygons,
  toPolygons,
  type EditMesh,
  type ExplicitFace,
} from "./half-edge";
import { addFaces } from "./refine";

// ── float32, in C's evaluation order ───────────────────────────────────────
// Blender does this in `float` with no fused multiply-add, and on a grid the
// choices below are ties that only its rounding breaks. Every operation is
// rounded where C would round it; the helpers mirror BLI's one for one.

type V3 = [number, number, number];
const f32 = Math.fround;

const at3 = (P: Float32Array, v: number): V3 => [P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!];
/** `sub_v3_v3v3` */
const subF = (a: V3, b: V3): V3 => [f32(a[0] - b[0]), f32(a[1] - b[1]), f32(a[2] - b[2])];
/** `dot_v3v3`: left to right. */
const dotF = (a: V3, b: V3): number =>
  f32(f32(f32(a[0] * b[0]) + f32(a[1] * b[1])) + f32(a[2] * b[2]));
/** `cross_v3_v3v3` */
const crossF = (a: V3, b: V3): V3 => [
  f32(f32(a[1] * b[2]) - f32(a[2] * b[1])),
  f32(f32(a[2] * b[0]) - f32(a[0] * b[2])),
  f32(f32(a[0] * b[1]) - f32(a[1] * b[0])),
];
/** `normalize_v3_v3_length`: multiplies by `1 / len`, zero below 1e-35. */
function normalizeF(a: V3): [V3, number] {
  const d = dotF(a, a);
  if (!(d > 1.0e-35)) return [[0, 0, 0], 0];
  const len = f32(Math.sqrt(d));
  const k = f32(1 / len);
  return [[f32(a[0] * k), f32(a[1] * k), f32(a[2] * k)], len];
}
/** `project_plane_normalized_v3_v3v3`: `p + v * -dot(p, v)`. */
function projectPlaneF(p: V3, v: V3): V3 {
  const mul = -dotF(p, v);
  return [f32(p[0] + f32(v[0] * mul)), f32(p[1] + f32(v[1] * mul)), f32(p[2] + f32(v[2] * mul))];
}
/** `len_v3` */
const lenF = (a: V3): number => f32(Math.sqrt(dotF(a, a)));
/** `safe_asinf` */
const safeAsin = (x: number): number =>
  f32(Math.abs(x) <= 1 ? Math.asin(x) : Math.sign(x) * (Math.PI / 2));
/** `angle_normalized_v3v3` */
function angleNormalizedF(a: V3, b: V3): number {
  if (dotF(a, b) >= 0) {
    return f32(2 * safeAsin(f32(lenF(subF(b, a)) / 2)));
  }
  const len = lenF(subF([-b[0], -b[1], -b[2]], a));
  return f32(f32(Math.PI) - f32(2 * safeAsin(f32(len / 2))));
}
/** `angle_signed_on_axis_v3v3_v3`: in [0, 2π), counter-clockwise about `axis`. */
function angleSignedOnAxisF(v1: V3, v2: V3, axis: V3): number {
  const p1 = projectPlaneF(v1, axis);
  const p2 = projectPlaneF(v2, axis);
  let angle = angleNormalizedF(normalizeF(p1)[0], normalizeF(p2)[0]);
  if (dotF(crossF(p2, p1), axis) < 0) angle = f32(f32(Math.PI * 2) - angle);
  return angle;
}

/**
 * `BM_verts_calc_normal_from_cloud_ex`: the normal of an unordered set, and
 * which of the set is the tangent the ring is measured from.
 */
function cloudNormal(P: Float32Array, varr: readonly number[]): { normal: V3; center: V3; tangent: number } {
  const n = varr.length;
  const inv = f32(1 / n);
  const center: V3 = [0, 0, 0];
  for (const v of varr) {
    const co = at3(P, v);
    for (let k = 0; k < 3; k++) center[k] = f32(center[k]! + f32(co[k]! * inv));
  }

  // `!(d <= max)`: the first of equals wins.
  let a = 0;
  let max = -1;
  for (let i = 0; i < n; i++) {
    const d = dotF(subF(center, at3(P, varr[i]!)), subF(center, at3(P, varr[i]!)));
    if (!(d <= max)) {
      a = i;
      max = d;
    }
  }
  const coA = at3(P, varr[a]!);
  const dirA = normalizeF(subF(coA, center))[0];

  let b = -1;
  let dirB: V3 = [0, 0, 0];
  max = -1;
  for (let i = 0; i < n; i++) {
    if (i === a) continue;
    const t = projectPlaneF(subF(at3(P, varr[i]!), center), dirA);
    const d = dotF(t, t);
    if (!(d <= max)) {
      b = i;
      max = d;
      dirB = t;
    }
  }
  const coB = at3(P, varr[b]!);

  let normal: V3;
  const tangent = a;
  if (n <= 3) {
    // `normal_tri_v3(center, co_a, co_b)`
    normal = normalizeF(crossF(subF(center, coA), subF(coA, coB)))[0];
  } else {
    dirB = normalizeF(dirB)[0];
    // Opposites: the smallest dot with each direction — of the raw
    // coordinate, not of its offset from the centre, exactly as Blender has it.
    const FLT_MAX = 3.4028234663852886e38;
    let aOpp = -1;
    let bOpp = -1;
    let aMin = FLT_MAX;
    let bMin = FLT_MAX;
    for (let i = 0; i < n; i++) {
      const co = at3(P, varr[i]!);
      if (i !== a) {
        const d = dotF(dirA, co);
        if (d < aMin) {
          aMin = d;
          aOpp = i;
        }
      }
      if (i !== b) {
        const d = dotF(dirB, co);
        if (d < bMin) {
          bMin = d;
          bOpp = i;
        }
      }
    }
    // `normal_quad_v3(co_a, co_b, co_a_opposite, co_b_opposite)`. Blender's
    // `main` goes on to refine this with a Newell sum round the vertices in
    // angular order and to re-pick the tangent; **5.1.1 does not**, and the
    // parity row on `body` and `arm` — non-planar clouds, where the two differ
    // — agrees with 5.1.1. Revisit on a Blender upgrade.
    normal = normalizeF(crossF(subF(coA, at3(P, varr[aOpp]!)), subF(coB, at3(P, varr[bOpp]!))))[0];
  }
  return { normal, center, tangent };
}

/**
 * The ring through a set of vertices, in the order Blender's F key puts them —
 * `BM_verts_sort_radial_plane` over the set in ascending index order:
 * ascending signed angle about the cloud normal, starting from its tangent
 * vertex. The face {@link edgeFaceAdd} makes follows this order unless the
 * faces it touches say to reverse it.
 *
 * Angular order is not the outline: a genuinely non-convex set does not come
 * back as the polygon a person would draw, in Blender either.
 *
 * Throws when the selection is collinear, which has no ring at all.
 */
export function ringOf(positions: Float32Array, verts: ReadonlySet<number>): number[] {
  const varr = [...verts].sort((a, b) => a - b);

  // Blender goes ahead and makes a degenerate face here; forge3d refuses.
  let area = 0;
  const o = at3(positions, varr[0]!);
  for (let i = 1; i < varr.length; i++)
    for (let j = i + 1; j < varr.length; j++) {
      const x = crossF(subF(at3(positions, varr[i]!), o), subF(at3(positions, varr[j]!), o));
      area = Math.max(area, dotF(x, x));
    }
  if (area <= 1e-24)
    throw new Error(
      "edgeFaceAdd: the selected vertices are collinear (or coincident), so " +
        "there is no ring through them and no face to make.",
    );

  const { normal, center, tangent } = cloudNormal(positions, varr);
  const far = subF(at3(positions, varr[tangent]!), center);
  const angle = varr.map((v) => angleSignedOnAxisF(far, subF(at3(positions, v), center), normal));
  return varr
    .map((v, i) => [v, angle[i]!] as const)
    .sort((x, y) => x[1] - y[1])
    .map(([v]) => v);
}


interface Extension {
  /** The vertices round the loop the selection grows to, in order. */
  ring: number[];
  /** The loop's edges that already exist and have no face, as `[a, b]` as the wire list holds them. */
  loose: number[][];
}

/**
 * `edbm_add_edge_face_exec__tricky_extend_sel`: the loop the selection grows to, or null when it does not apply.
 * Applies to one selected vertex, and to two joined by an edge (which is then the one selected edge).
 */
function extendSelection(polys: number[][], wire: number[][], verts: ReadonlySet<number>): Extension | null {
  if (verts.size > 2) return null;
  const key = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const faces = new Map<string, number[]>();
  const at = new Map<number, string[]>();
  const ends = new Map<string, [number, number]>();
  const note = (a: number, b: number, f: number): void => {
    const k = key(a, b);
    if (!faces.has(k)) {
      faces.set(k, []);
      ends.set(k, [a, b]);
      for (const v of [a, b]) {
        if (!at.has(v)) at.set(v, []);
        at.get(v)!.push(k);
      }
    }
    if (f >= 0) faces.get(k)!.push(f);
  };
  polys.forEach((poly, f) => poly.forEach((a, i) => note(a, poly[(i + 1) % poly.length]!, f)));
  for (const [a, b] of wire) note(a!, b!, -1);

  const isWire = (k: string): boolean => faces.get(k)!.length === 0;
  const isBoundary = (k: string): boolean => faces.get(k)!.length === 1;
  const shareFace = (x: string, y: string): boolean => faces.get(x)!.some((f) => faces.get(y)!.includes(f));
  const other = (k: string, v: number): number => (ends.get(k)![0] === v ? ends.get(k)![1] : ends.get(k)![0]);
  /** `vert_edge_lookup`: the edges at `v` but `skip` that pass `test`. */
  const lookup = (v: number, skip: string | null, test: (k: string) => boolean): string[] =>
    (at.get(v) ?? []).filter((k) => k !== skip && test(k));
  const loose = (keys: string[]): number[][] =>
    keys.filter(isWire).map((k) => wire.find(([a, b]) => key(a!, b!) === k)!.slice());

  if (verts.size === 1) {
    const v = [...verts][0]!;
    const wires = lookup(v, null, isWire);
    const bounds = lookup(v, null, isBoundary);
    const pair =
      wires.length === 2 && !shareFace(wires[0]!, wires[1]!)
        ? wires
        : bounds.length === 2 && !shareFace(bounds[0]!, bounds[1]!)
          ? bounds
          : null;
    if (!pair) return null;
    const [a, b] = [other(pair[0]!, v), other(pair[1]!, v)];
    const closing = faces.has(key(a, b)) ? [key(a, b)] : [];
    return { ring: [a, v, b], loose: loose([...pair, ...closing]) };
  }

  const [a, b] = [...verts] as [number, number];
  const e = key(a, b);
  if (!faces.has(e)) return null; // two vertices with no edge between them make that edge, not a face
  // The two ends try (wire, wire), (wire, boundary), (boundary, wire), (boundary, boundary), in that order.
  for (const [t1, t2] of [
    [isWire, isWire],
    [isWire, isBoundary],
    [isBoundary, isWire],
    [isBoundary, isBoundary],
  ] as const) {
    const p1 = lookup(a, e, t1);
    const p2 = lookup(b, e, t2);
    if (p1.length === 1 && p2.length === 1 && !shareFace(e, p1[0]!) && !shareFace(e, p2[0]!)) {
      const [a2, b2] = [other(p1[0]!, a), other(p2[0]!, b)];
      const closing = a2 !== b2 && faces.has(key(a2, b2)) ? [key(a2, b2)] : [];
      return { ring: a2 === b2 ? [a, b, a2] : [a2, a, b, b2], loose: loose([e, p1[0]!, p2[0]!, ...closing]) };
    }
  }
  return null;
}

/**
 * The order `BM_mesh_edgenet` gives a face made only of loose edges (`edgenet_fill`; compat-backlog C77): which way round, and from which
 * vertex. `selected` are those edges as the wire list holds them — the order of Blender's edge array, and each edge's two ends as it
 * stores them. `edgenet_prepare` first closes an open path with one more edge, from the far end of the first edge to the far end of the last.
 * The walk then starts at the first edge, both ends at once, ends where the two sides meet, and reads the face off the `prev` links.
 *
 * Null when the walk is not the plain one (a loop that is not a single cycle, or a vertex with edges besides the loop's, which Blender
 * searches level by level and may price differently).
 */
function edgenetOrder(selected: number[][], wire: number[][], polys: number[][]): number[] | null {
  if (selected.length < 2) return null;
  // Mesh order: the wire list's.
  const order = (e: number[]): number => wire.findIndex((w) => (w[0] === e[0] && w[1] === e[1]) || (w[0] === e[1] && w[1] === e[0]));
  const edges = selected.map((e) => [e[0]!, e[1]!]).sort((x, y) => order(x) - order(y));

  const degree = new Map<number, number>();
  for (const [a, b] of edges) for (const v of [a!, b!]) degree.set(v, (degree.get(v) ?? 0) + 1);
  // `edgenet_prepare`: close a path with one more edge, (far end of the first, far end of the last), walked from the first end found.
  const ends = [...degree].filter(([, d]) => d === 1).map(([v]) => v);
  if (ends.length === 2) {
    const first = edges.find((e) => degree.get(e[0]!) === 1 || degree.get(e[1]!) === 1)!;
    const walk: number[][] = [first];
    const seen = new Set([first]);
    let cur = first;
    for (;;) {
      let next: number[] | undefined;
      for (const v of [cur[0]!, cur[1]!]) {
        next = edges.find((e) => !seen.has(e) && (e[0] === v || e[1] === v));
        if (next) break;
      }
      if (!next) break;
      seen.add(next);
      walk.push(next);
      cur = next;
    }
    if (walk.length !== edges.length || walk.length < 2) return null;
    const farOf = (e: number[], neighbour: number[]): number => (neighbour.includes(e[0]!) ? e[1]! : e[0]!);
    edges.push([farOf(walk[0]!, walk[1]!), farOf(walk[walk.length - 1]!, walk[walk.length - 2]!)]);
  } else if (ends.length !== 0) return null;
  for (const d of new Set(edges.flat())) if ((degree.get(d) ?? 0) > 2) return null;

  // How many edges meet at each vertex of the mesh — the walk's shortcut asks.
  const meshEdges = new Set<string>();
  for (const poly of polys) poly.forEach((a, i) => meshEdges.add(`${Math.min(a, poly[(i + 1) % poly.length]!)}_${Math.max(a, poly[(i + 1) % poly.length]!)}`));
  for (const [a, b] of wire) meshEdges.add(`${Math.min(a!, b!)}_${Math.max(a!, b!)}`);
  const total = new Map<number, number>();
  for (const k of meshEdges) for (const v of k.split("_").map(Number)) total.set(v, (total.get(v) ?? 0) + 1);
  const made = edges.length - selected.length;
  if (made) for (const v of edges[edges.length - 1]!) total.set(v!, (total.get(v!) ?? 0) + 1);

  // `bm_edgenet_path_calc` from the first edge: v1 on one side (pass 1), v2 on the other (pass -1), v2 popped first.
  interface Info { pass: number; prev: number }
  const info = new Map<number, Info>();
  const vn = (v: number): Info => {
    let i = info.get(v);
    if (!i) info.set(v, (i = { pass: 0, prev: -1 }));
    return i;
  };
  const [v1, v2] = edges[0]!;
  Object.assign(vn(v1!), { pass: 1, prev: v2! });
  Object.assign(vn(v2!), { pass: -1, prev: v1! });
  interface Node { v: number; next: Node | null }
  let lsPrev: Node | null = { v: v2!, next: { v: v1!, next: null } };
  let lsNext: Node | null = null;
  const at = (v: number): number[][] => edges.filter((e) => e[0] === v || e[1] === v);

  /** `bm_edgenet_path_step`, with its walk along a single way on. */
  const step = (start: number): number[] | null => {
    let cur = start;
    for (;;) {
      const here = vn(cur);
      let tot = 0;
      let added = 0;
      for (const e of at(cur)) {
        const next = e[0] === cur ? e[1]! : e[0]!;
        if (next === here.prev) continue;
        const there = vn(next);
        if (here.pass !== there.pass) {
          if (here.pass === -there.pass) return e;
          there.pass = here.pass;
          there.prev = cur;
          lsNext = { v: next, next: lsNext };
          added++;
        }
        tot++;
      }
      // The edges of the mesh the loop does not use count too.
      tot += (total.get(cur) ?? 0) - 1 - at(cur).filter((e) => (e[0] === cur ? e[1] : e[0]) !== here.prev).length;
      if (added === 1 && tot === 1) {
        cur = lsNext!.v;
        lsNext = lsNext!.next;
        continue;
      }
      return null;
    }
  };

  let foundEdge: number[] | null = null;
  let cost = 0;
  for (let again = true; again && !foundEdge; ) {
    again = false;
    while (lsPrev && !foundEdge) {
      const v: number = lsPrev.v;
      lsPrev = lsPrev.next;
      const before: Node | null = lsNext;
      foundEdge = step(v);
      if (!foundEdge && lsNext !== before) again = true;
    }
    if (foundEdge) break;
    cost++;
    lsPrev = lsNext;
    lsNext = null;
  }
  // A path that took more than the first level is searched again from every edge for a shorter one — not ported.
  if (!foundEdge || cost > 0) return null;
  // `path_from_pass(e_found->v1)` reversed, then `path_from_pass(e_found->v2)` on the front of it.
  const half = (v: number): number[] => {
    const out: number[] = [];
    const p = vn(v).pass;
    let cur = v;
    do {
      out.unshift(cur);
      cur = vn(cur).prev;
    } while (cur >= 0 && vn(cur).pass === p);
    return out;
  };
  const path = half(foundEdge[0]!).reverse();
  for (const v of half(foundEdge[1]!).reverse()) path.unshift(v);
  return path;
}

/**
 * Make one face from a set of vertices — Blender's F key.
 *
 * ```ts
 * const em = meshFromData({ positions, polys });
 * edgeFaceAdd(em, new Set([4, 5, 6, 7]));   // lid on an open box
 * ```
 *
 * Returns the index of the face it made, or `null` when a face with exactly
 * those vertices was already there — which is what Blender does, and is why
 * the return is not a `Set` like the operators that touch several faces.
 *
 * With exactly **two** vertices it adds a wire edge instead and returns null —
 * no face was made. It refuses when those two already have an edge between
 * them, measured: Blender returns `CANCELLED` and changes nothing.
 *
 * **One vertex, or two joined by an edge, can make a face too** — the selection is extended first
 * (`edbm_add_edge_face_exec__tricky_extend_sel`, compat-backlog C77). One vertex with exactly two
 * boundary edges (or exactly two wire edges), which share no face, is joined with the far ends of
 * both: a triangle. One edge whose two ends each have exactly one other wire or boundary edge —
 * none of them sharing a face with it — is joined with the far ends of those: a quad (a triangle
 * when the far ends are the same vertex). Anything else with one vertex does nothing, and with two
 * joined vertices is refused as before. The face runs round those edges in order, not by the
 * angle sort a loose vertex set gets. Blender also votes the new face's smooth flag from the
 * selected edges' faces; this mesh does not carry per-face shading, so that is not modelled.
 *
 * Throws on an empty selection and on a collinear selection of three or more.
 *
 * The winding follows the faces the new one touches, and with none it is the
 * ring's own order — see the module note.
 */
export function edgeFaceAdd(em: EditMesh, verts: ReadonlySet<number>): number | null {
  if (verts.size < 1)
    throw new Error("edgeFaceAdd: no vertices. Blender needs two to make an edge and three to make a face.");

  const polys = toPolygons(em);

  // `tricky_extend_sel`: the selection grows to the edges around it, and what the face is made from is then that
  // closed edge loop — `edgenet_prepare` adds the one edge that is missing — not a bare vertex cloud.
  const extended = extendSelection(polys, em.wireEdges ?? [], verts);
  if (extended) verts = new Set(extended.ring);
  else if (verts.size === 1) return null; // `contextual_create` with a lone vertex: nothing, cancelled

  // Two vertices make a wire edge, and **only when there is not already an
  // edge between them** — measured: two adjacent corners of a grid come back
  // `CANCELLED` and the mesh is untouched, two opposite ones come back with a
  // new loose edge. Returns null because no face was made, which is also what
  // `bmesh.ops.contextual_create` reports (its `faces` list comes back empty).
  if (verts.size === 2) {
    const [a, b] = [...verts];
    const key = (x: number, y: number): string => (x < y ? `${x}_${y}` : `${y}_${x}`);
    const want = key(a!, b!);
    for (const poly of polys)
      for (let i = 0; i < poly.length; i++)
        if (key(poly[i]!, poly[(i + 1) % poly.length]!) === want) return null;
    for (const e of em.wireEdges ?? []) if (key(e[0]!, e[1]!) === want) return null;
    em.wireEdges = [...(em.wireEdges ?? []), [a!, b!]];
    return null;
  }
  for (const poly of polys)
    if (poly.length === verts.size && poly.every((v) => verts.has(v))) return null;

  const ring = extended ? extended.ring : ringOf(em.positions, verts);

  // `BM_face_create_ngon_verts(calc_winding)`: each ring edge that already has
  // a face votes by the direction of its **newest** face (`e->l` — the radial
  // cycle is appended in face order, so the highest-numbered face on the edge).
  // Running the same way as that face is a vote to reverse.
  const newest = new Map<string, [number, number]>();
  for (const poly of polys)
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      newest.set(a < b ? `${a}_${b}` : `${b}_${a}`, [a, b]);
    }
  let keep = 0;
  let flip = 0;
  for (let i = 0; i < ring.length; i++) {
    const prev = ring[(i + ring.length - 1) % ring.length]!;
    const cur = ring[i]!;
    const face = newest.get(prev < cur ? `${prev}_${cur}` : `${cur}_${prev}`);
    if (!face) continue;
    if (face[0] === prev) flip++;
    else keep++;
  }
  // The face starts where `BM_face_create_ngon` is handed it: at the ring's
  // last vertex then its first, or reversed, at its first then its last.
  let face =
    keep < flip
      ? [ring[0]!, ...ring.slice(1).reverse()]
      : [ring[ring.length - 1]!, ...ring.slice(0, -1)];
  // No neighbour to go by: `edgenet_fill` takes the face as `BM_mesh_edgenet`'s walk over the loose edges gave it.
  if (extended && keep === 0 && flip === 0) face = edgenetOrder(extended.loose, em.wireEdges ?? [], polys) ?? face;

  // The layers follow the path F takes in `contextual_create`. When the
  // ring's edges are all there it is `edgenet_fill`, whose face copies from
  // the faces around it (`face_attribute_fill`, material included). Otherwise
  // it is the vertex-cloud fill: slot 0, and each ring edge that already has
  // a face copies that face's two corners, the first write winning, starting
  // at the face's first corner (`BM_face_copy_shared` — the other face on the
  // edge is `radial_next`, which is the oldest). Not matched: a ring with
  // only some of its edges, where Blender's `edgenet_prepare` may close it;
  // and on the edge-net path, which corner the copy starts from — Blender's
  // face starts where `BM_mesh_edgenet`'s walk put it, so 1 or 2 corners take
  // the other neighbour's value (`edge-face-add-layers`, "different").
  const edges = new Set<string>();
  const oldest = new Map<string, number>();
  polys.forEach((poly, f) => {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      edges.add(k);
      if (!oldest.has(k)) oldest.set(k, f);
    }
  });
  for (const e of em.wireEdges ?? []) edges.add(e[0]! < e[1]! ? `${e[0]}_${e[1]}` : `${e[1]}_${e[0]}`);
  const n = face.length;
  const keyOf = (i: number): string => {
    const a = face[i]!;
    const b = face[(i + 1) % n]!;
    return a < b ? `${a}_${b}` : `${b}_${a}`;
  };
  const closed = extended !== null || face.every((_, i) => edges.has(keyOf(i)));

  polys.push(face);
  // A wire edge the face now runs along is an ordinary edge from here on.
  if (em.wireEdges?.length) {
    const used = new Set<string>();
    for (let i = 0; i < n; i++) used.add(keyOf(i));
    const rest = em.wireEdges.filter(([a, b]) => !used.has(a! < b! ? `${a}_${b}` : `${b}_${a}`));
    if (rest.length !== em.wireEdges.length) em.wireEdges = rest;
  }
  if (closed) {
    addFaces(em, em.positions, polys, polys.length - 1, true);
    return polys.length - 1;
  }
  const corners: [number, number, number][][] = face.map(() => []);
  for (let i = 0; i < n; i++) {
    const f = oldest.get(keyOf(i));
    if (f === undefined) continue;
    for (const j of [i, (i + 1) % n])
      if (corners[j]!.length === 0) corners[j] = [[f, polys[f]!.indexOf(face[j]!), 1]];
  }
  const stated: Array<ExplicitFace | undefined> = polys.map(() => undefined);
  stated[polys.length - 1] = { corners, material: -1 };
  rebuildPolygons(em, em.positions, polys, { faces: stated });
  return polys.length - 1;
}

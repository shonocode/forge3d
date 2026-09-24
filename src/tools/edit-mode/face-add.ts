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
} from "./half-edge";

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
 * Throws on fewer than two vertices and on a collinear selection of three or
 * more.
 *
 * The winding follows the faces the new one touches, and with none it is the
 * ring's own order — see the module note.
 */
export function edgeFaceAdd(em: EditMesh, verts: ReadonlySet<number>): number | null {
  if (verts.size < 2)
    throw new Error(
      `edgeFaceAdd: ${verts.size} vertices. Blender needs two to make an edge ` +
        `and three to make a face.`,
    );

  const polys = toPolygons(em);

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

  const ring = ringOf(em.positions, verts);

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
  const face =
    keep < flip
      ? [ring[0]!, ...ring.slice(1).reverse()]
      : [ring[ring.length - 1]!, ...ring.slice(0, -1)];

  polys.push(face);
  rebuildPolygons(em, em.positions, polys);
  return polys.length - 1;
}

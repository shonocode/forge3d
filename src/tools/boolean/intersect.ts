/**
 * Cut a mesh where it passes through itself — Blender's `bpy.ops.mesh.intersect`
 * with the exact solver. ADR-012's first stage.
 *
 * ## How, and where it departs from Blender's code
 *
 * Blender (`blenlib/intern/mesh_intersect.cc`) takes the edit mesh's
 * tessellation, intersects every overlapping triangle pair exactly, then runs
 * an **exact constrained Delaunay triangulation** (`delaunay_2d.cc`, 3416
 * lines) inside each triangle to cut it along its intersection segments, and
 * finally merges the triangles of each original polygon back into polygons
 * (`merge_tris_for_face` in `mesh_boolean.cc`).
 *
 * Ported as it is: the tessellation (the quad rule, and `BLI_polyfill_calc`
 * in float32 for larger polygons — `polyfill.ts`), the exact triangle–triangle
 * test (`tri-tri.ts`), the rule that the same exact point is the same vertex,
 * and the merge — longest dissolvable edge first, refusing any dissolve that
 * would leave an invalid BMesh face.
 *
 * Not ported: `delaunay_2d.cc`. Each triangle is cut by an **exact 2D planar
 * arrangement** of its boundary and segments, and that arrangement is handed
 * to `cdt.ts`, which reaches the same constrained Delaunay triangulation by
 * flips (unique unless four points are cocircular). The triangulation
 * matters: it mostly dissolves away, but where the pieces cannot become one
 * polygon, its edges are what is left.
 *
 * ## Measured
 *
 * `probe-intersect.py`: two unit cubes in one mesh, the second moved
 * `(0.5, 0.3, 0.2)`: 12 faces in, **18 out** — the six faces the other cube
 * passes through each become a hexagon and a quad. `separate_mode = 'NONE'`
 * keeps everything welded, so the cut edges are each shared by four faces.
 *
 * The parity row `intersect`, six cases, agrees down to the vertex set of
 * every face. Three rules were found by the row rather than the cubes:
 *
 * - **Self mode intersects the two halves of the same face with each other**
 *   (`nshapes == 1` has no pair filter). A bent quad's halves meet in their
 *   diagonal, which therefore comes out as an intersection edge and is never
 *   dissolved — a cut across a bent quad leaves four faces, not two. An uncut
 *   bent quad still comes back whole (the "quad recovery"); **an uncut bent
 *   n-gon of five or more comes back triangulated**, since recovery covers
 *   only quads (`bentHex`: a hexagon → 4 triangles).
 * - **A hole** — a loop of cuts inside one face (`slabPin`) — leaves a ring
 *   that cannot be one polygon. Blender splits it into two faces by the last
 *   Delaunay edges the longest-first merge could not remove.
 * - The n-gon split is `BLI_polyfill_calc`'s, not a fan: it decides which
 *   triangles the uncut hexagon comes back as.
 *
 * ## Not yet
 *
 * - `separate_mode` `ALL` / `CUT` — post-processing on top of this.
 * - Ties: cocircular points in the Delaunay step and equal edge lengths in
 *   the merge order are decided by the algorithm in Blender and may be
 *   decided otherwise here.
 */
import type { MeshData } from "../../lib/mesh";
import {
  add,
  cmp,
  div,
  mul,
  neg,
  q3Dot,
  sign,
  sub,
  type Q,
  type Q3,
} from "./exact";
import { constrainedDelaunay } from "./cdt";
import { tessellateNgon } from "./polyfill";
import { evertFromDoubles, evertFromExact, intersectTriTri, makeTri, type ETri, type EVert } from "./tri-tri";

export interface IntersectOptions {
  /**
   * Blender's `mode`. `"self"` (Blender's `SELECT`) cuts every face against
   * every other. `"twoSets"` (`SELECT_UNSELECT`) only cuts faces in `set`
   * against faces outside it.
   */
  mode?: "self" | "twoSets";
  /** The faces on one side, for `"twoSets"`. */
  set?: ReadonlySet<number>;
  /**
   * Blender's `separate_mode`. `"none"` (the default) keeps everything
   * welded. `"all"` splits every intersection edge, so each piece comes
   * apart (`BM_mesh_edgesplit` on the edges the cut created). `"cut"`, in
   * `"twoSets"` mode, only detaches the faces from `set` from the rest
   * (`BM_mesh_separate_faces`); in `"self"` mode Blender treats it as
   * `"all"`, and so does this.
   */
  separate?: "none" | "all" | "cut";
}

export type IntersectResult = MeshData;

// ── exact 2D ────────────────────────────────────────────────────────────────

type Q2 = readonly [Q, Q];

const orient2d = (a: Q2, b: Q2, c: Q2): -1 | 0 | 1 =>
  sign(sub(mul(sub(b[0], a[0]), sub(c[1], a[1])), mul(sub(b[1], a[1]), sub(c[0], a[0]))));

const qkey = (x: Q): string => `${x.n}/${x.d}`;
const key2 = (p: Q2): string => `${qkey(p[0])},${qkey(p[1])}`;
const key3 = (p: Q3): string => `${qkey(p[0])},${qkey(p[1])},${qkey(p[2])}`;

/** Is `p` on the closed segment `a`–`b`? Exact. */
function onSegment(p: Q2, a: Q2, b: Q2): boolean {
  if (orient2d(a, b, p) !== 0) return false;
  const inRange = (i: 0 | 1): boolean => {
    const lo = cmp(a[i], b[i]) <= 0 ? a[i] : b[i];
    const hi = lo === a[i] ? b[i] : a[i];
    return cmp(lo, p[i]) <= 0 && cmp(p[i], hi) <= 0;
  };
  return inRange(0) && inRange(1);
}

/** Where two non-parallel segments cross, if they do (endpoints included). */
function crossing(a: Q2, b: Q2, c: Q2, d: Q2): Q2 | null {
  const o1 = orient2d(a, b, c);
  const o2 = orient2d(a, b, d);
  const o3 = orient2d(c, d, a);
  const o4 = orient2d(c, d, b);
  if (o1 === 0 && o2 === 0) return null; // collinear: handled by onSegment
  if (o1 * o2 > 0 || o3 * o4 > 0) return null;
  // a + t (b − a), t = cross(c − a, d − c) / cross(b − a, d − c)
  const rx = sub(b[0], a[0]), ry = sub(b[1], a[1]);
  const sx = sub(d[0], c[0]), sy = sub(d[1], c[1]);
  const den = sub(mul(rx, sy), mul(ry, sx));
  if (sign(den) === 0) return null;
  const t = div(sub(mul(sub(c[0], a[0]), sy), mul(sub(c[1], a[1]), sx)), den);
  return [add(a[0], mul(rx, t)), add(a[1], mul(ry, t))];
}

/** Parameter of `p` along `a`–`b`, for ordering points on one segment. */
function along(p: Q2, a: Q2, b: Q2): Q {
  const dx = sub(b[0], a[0]);
  return sign(dx) !== 0 ? div(sub(p[0], a[0]), dx) : div(sub(p[1], a[1]), sub(b[1], a[1]));
}

/** Edge kinds, as a bit set: what an edge of the arrangement *is*. */
export const ORIG = 1; // an edge of the input polygon
export const DIAG = 2; // a diagonal added by triangulating the polygon
export const CUT = 4; // an intersection segment lies along it

/**
 * `get_cdt_edge_orig`'s `is_intersect`: a segment lies along the edge **and
 * no original edge does** — an original edge wins. That matters in self
 * mode, where two faces sharing an edge intersect exactly along it: the
 * edge stays an original edge, not a cut, and `separate_mode='ALL'` must
 * not split it.
 */
const isIntersectKind = (kind: number): boolean => (kind & CUT) !== 0 && (kind & ORIG) === 0;

interface Seg {
  a: Q2;
  b: Q2;
  kind: number;
}

/**
 * The planar arrangement of `segs`: every point, and every edge once each
 * segment is split at every crossing and every point lying on it. Collinear
 * overlaps collapse to one edge carrying both kinds. Everything exact.
 */
function arrangement(
  segs: Seg[],
  extraPoints: Q2[],
): { edges: { u: string; v: string; kind: number }[]; points: Map<string, Q2> } {
  const points = new Map<string, Q2>();
  const addPoint = (p: Q2): void => {
    const k = key2(p);
    if (!points.has(k)) points.set(k, p);
  };
  for (const s of segs) {
    addPoint(s.a);
    addPoint(s.b);
  }
  for (const p of extraPoints) addPoint(p);
  for (let i = 0; i < segs.length; i++)
    for (let j = i + 1; j < segs.length; j++) {
      const x = crossing(segs[i]!.a, segs[i]!.b, segs[j]!.a, segs[j]!.b);
      if (x) addPoint(x);
    }

  // Split every segment at every point on it; merge duplicates.
  const edges = new Map<string, { u: string; v: string; kind: number }>();
  const all = [...points.values()];
  for (const s of segs) {
    const on = all.filter((p) => onSegment(p, s.a, s.b));
    on.sort((p, r) => cmp(along(p, s.a, s.b), along(r, s.a, s.b)));
    for (let i = 0; i + 1 < on.length; i++) {
      const u = key2(on[i]!);
      const v = key2(on[i + 1]!);
      if (u === v) continue;
      const k = u < v ? `${u}|${v}` : `${v}|${u}`;
      const e = edges.get(k);
      if (e) e.kind |= s.kind;
      else edges.set(k, { u, v, kind: s.kind });
    }
  }
  return { edges: [...edges.values()], points };
}

// ── projection ─────────────────────────────────────────────────────────────

/** The axis to drop: the largest normal component, compared exactly. */
function projectionAxis(n: Q3): 0 | 1 | 2 {
  const abs = n.map((c) => (sign(c) < 0 ? neg(c) : c));
  let axis: 0 | 1 | 2 = 0;
  if (cmp(abs[1]!, abs[axis]!) > 0) axis = 1;
  if (cmp(abs[2]!, abs[axis]!) > 0) axis = 2;
  return axis;
}

const project = (p: Q3, axis: 0 | 1 | 2): Q2 =>
  axis === 0 ? [p[1], p[2]] : axis === 1 ? [p[0], p[2]] : [p[0], p[1]];

/** Put the dropped coordinate back by solving the triangle's plane exactly. */
function unproject(p: Q2, axis: 0 | 1 | 2, n: Q3, d: Q): Q3 {
  // n · x = d; solve for x[axis].
  const [i, j] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
  const rest = add(mul(n[i]!, p[0]), mul(n[j]!, p[1]));
  const x = div(sub(d, rest), n[axis]!);
  const out: Q[] = [];
  out[axis] = x;
  out[i] = p[0];
  out[j] = p[1];
  return out as unknown as Q3;
}

// ── the stage ───────────────────────────────────────────────────────────────

interface Tri {
  t: ETri;
  ids: [number, number, number];
  face: number;
  /** Per edge i (ids[i] → ids[i+1]): ORIG or DIAG. */
  edgeKind: [number, number, number];
}

/**
 * Blender's quad rule: `(0,1,2) + (0,2,3)`, unless `is_quad_flip_first_third`
 * — the two cross products about the 0–2 diagonal agree — in which case
 * `(0,1,3) + (1,2,3)`. Larger polygons: `BLI_polyfill_calc`, as the edit mesh has them.
 */
function triangulate(poly: number[], P: Float32Array): [number[], number[]][] {
  if (poly.length === 3) return [[poly, [ORIG, ORIG, ORIG]]];
  if (poly.length === 4) {
    const at = (i: number): number[] => [P[poly[i]! * 3]!, P[poly[i]! * 3 + 1]!, P[poly[i]! * 3 + 2]!];
    const [v1, v2, v3, v4] = [at(0), at(1), at(2), at(3)];
    const d12 = v2.map((c, k) => c - v1[k]!);
    const d13 = v3.map((c, k) => c - v1[k]!);
    const d14 = v4.map((c, k) => c - v1[k]!);
    const cr = (a: number[], b: number[]): number[] => [
      a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!,
    ];
    const ca = cr(d12, d13);
    const cb = cr(d14, d13);
    if (ca[0]! * cb[0]! + ca[1]! * cb[1]! + ca[2]! * cb[2]! > 0)
      return [
        [[poly[0]!, poly[1]!, poly[3]!], [ORIG, DIAG, ORIG]],
        [[poly[1]!, poly[2]!, poly[3]!], [ORIG, ORIG, DIAG]],
      ];
    return [
      [[poly[0]!, poly[1]!, poly[2]!], [ORIG, ORIG, DIAG]],
      [[poly[0]!, poly[2]!, poly[3]!], [DIAG, ORIG, ORIG]],
    ];
  }
  // Five or more: Blender's edit-mesh tessellation, `polyfill.ts`. An edge
  // between successive corners is original, any other a diagonal.
  const m = poly.length;
  const orig = (i: number, j: number): number => ((i + 1) % m === j || (j + 1) % m === i ? ORIG : DIAG);
  return tessellateNgon(poly, P).map(([i, j, k]) => [
    [poly[i]!, poly[j]!, poly[k]!],
    [orig(i, j), orig(j, k), orig(k, i)],
  ]);
}

/**
 * Cut the mesh along where its faces pass through each other.
 *
 * ```ts
 * intersect(mesh);                                         // every face against every other
 * intersect(mesh, { mode: "twoSets", set: new Set([6, 7, 8, 9, 10, 11]) });
 * ```
 */
export function intersect(data: MeshData, options: IntersectOptions = {}): IntersectResult {
  const mode = options.mode ?? "self";
  const { verts, pieces } = subdivide(data, mode === "twoSets" ? options.set! : null);
  const merged = mergePieces(pieces, data, verts);

  // A face with exactly the vertex set of an earlier one is the same face:
  // BMesh cannot hold two, and Blender's output has one. This is where the
  // coplanar overlap of two cubes goes — both cubes produce the shared piece,
  // and it appears once (measured: 16 faces, not 20).
  const setKey = (p: readonly number[]): string => [...p].sort((a, b) => a - b).join(",");
  const seen = new Set<string>();
  const faces = merged.filter((f) => {
    const k = setKey(f.vert);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  // `separate_mode`. Which edges come apart: for "all", those
  // `apply_mesh_output_to_bmesh` tagged — each face it **creates** writes its
  // edges' intersection flags, the last write winning; a face identical to
  // one already there (an input face left uncut, or a duplicate) is reused
  // and writes nothing. For "cut", the edges between faces from `set` and
  // faces from outside it.
  const separate = options.separate === "cut" && mode === "self" ? "all" : (options.separate ?? "none");
  let polys = faces.map((f) => f.vert);
  if (separate !== "none") {
    const ek = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);
    const split = new Set<string>();
    if (separate === "all") {
      const exists = new Set(data.polys.map(setKey));
      const tag = new Map<string, boolean>();
      for (const f of merged) {
        const k = setKey(f.vert);
        if (exists.has(k)) continue;
        exists.add(k);
        f.vert.forEach((v, i) => tag.set(ek(v, f.vert[(i + 1) % f.vert.length]!), f.isect[i]!));
      }
      for (const [k, on] of tag) if (on) split.add(k);
    } else {
      const sides = new Map<string, number>();
      faces.forEach((f) => {
        const bit = options.set!.has(f.face) ? 1 : 2;
        f.vert.forEach((v, i) => {
          const k = ek(v, f.vert[(i + 1) % f.vert.length]!);
          sides.set(k, (sides.get(k) ?? 0) | bit);
        });
      });
      for (const [k, s] of sides) if (s === 3) split.add(k);
    }
    polys = splitAlongEdges(polys, split, verts, (f) =>
      separate === "all" ? f : options.set!.has(faces[f]!.face) ? 1 : 0,
    );
  }

  return toMeshData(polys, verts);
}

/** The subdivided triangles of a mesh, and the vertices they use (inputs first). */
export interface Subdivided {
  verts: EVert[];
  /** Every piece of every input triangle, wound like its input face. */
  pieces: Piece[];
}

/**
 * Stage 1 up to the triangles: tessellate, intersect every pair that may
 * (all pairs, or with `set` only pairs across it — Blender's `nshapes == 2`),
 * and cut each triangle by the constrained Delaunay triangulation of its
 * arrangement. This is Blender's `trimesh_nary_intersect`; the boolean
 * (`boolean.ts`) classifies these same triangles.
 */
export function subdivide(data: MeshData, set: ReadonlySet<number> | null): Subdivided {
  const P = data.positions;

  // Vertices: the input's, then every new exact point, deduplicated exactly.
  const verts: EVert[] = [];
  const byKey = new Map<string, number>();
  const vertexOf = (e: Q3): number => {
    const k = key3(e);
    let id = byKey.get(k);
    if (id === undefined) {
      id = verts.length;
      verts.push(evertFromExact(e));
      byKey.set(k, id);
    }
    return id;
  };
  for (let i = 0; i * 3 < P.length; i++) {
    const v = evertFromDoubles(P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!);
    const k = key3(v.exact);
    if (!byKey.has(k)) byKey.set(k, verts.length);
    verts.push(v);
  }

  const tris: Tri[] = [];
  data.polys.forEach((poly, f) => {
    for (const [ids, kinds] of triangulate(poly, P)) {
      const t = makeTri(verts[ids[0]!]!, verts[ids[1]!]!, verts[ids[2]!]!);
      if (t.nExact.every((c) => sign(c) === 0)) continue; // degenerate
      tris.push({ t, ids: [ids[0]!, ids[1]!, ids[2]!], face: f, edgeKind: [kinds[0]!, kinds[1]!, kinds[2]!] });
    }
  });

  // Bounding boxes, padded; only a filter, so generous padding is safe.
  const boxes = tris.map(({ t }) => {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const v of t.v)
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k]!, v.co[k]!);
        hi[k] = Math.max(hi[k]!, v.co[k]!);
      }
    const pad = 1e-9 * (1 + Math.max(...hi.map(Math.abs), ...lo.map(Math.abs)));
    return { lo: lo.map((c) => c - pad), hi: hi.map((c) => c + pad) };
  });

  // Per triangle: the 3D segments cutting it, points on it, coplanar partners.
  const cuts: { segs: [Q3, Q3][]; pts: Q3[]; coplanar: number[] }[] = tris.map(() => ({
    segs: [],
    pts: [],
    coplanar: [],
  }));
  for (let i = 0; i < tris.length; i++)
    for (let j = i + 1; j < tris.length; j++) {
      const A = tris[i]!;
      const B = tris[j]!;
      if (set && set.has(A.face) === set.has(B.face)) continue;
      const a = boxes[i]!;
      const b = boxes[j]!;
      if (a.lo.some((c, k) => c > b.hi[k]!) || b.lo.some((c, k) => c > a.hi[k]!)) continue;
      const r = intersectTriTri(A.t, B.t);
      if (A.face === B.face) {
        // Blender's self mode (`nshapes == 1`) tests every pair, **the two
        // halves of one face included**. Where the face is not exactly planar
        // they meet in their shared diagonal, which then enters the CDT as a
        // non-face edge and comes out `is_intersect` (`get_cdt_edge_orig`) —
        // so it is never dissolved, and a cut crossing it keeps its vertex
        // there. Measured on the kurimanju cage, whose quads are all bent.
        // A planar face's halves are coplanar and add nothing.
        if (r.kind === "segment") {
          cuts[i]!.segs.push([r.p1, r.p2]);
          cuts[j]!.segs.push([r.p1, r.p2]);
        }
        continue;
      }
      if (r.kind === "segment") {
        cuts[i]!.segs.push([r.p1, r.p2]);
        cuts[j]!.segs.push([r.p1, r.p2]);
      } else if (r.kind === "point") {
        cuts[i]!.pts.push(r.p);
        cuts[j]!.pts.push(r.p);
      } else if (r.kind === "coplanar") {
        cuts[i]!.coplanar.push(j);
        cuts[j]!.coplanar.push(i);
      }
    }

  // Cut each triangle: the constrained Delaunay triangulation of its
  // arrangement, every arrangement edge a constraint — Blender's per-triangle
  // CDT (`cdt.ts` says why this road reaches the same one). Each triangle
  // keeps, per edge, the arrangement edge's kind, or 0 for an edge the CDT
  // added (dissolvable, like a diagonal).
  const pieces: Piece[] = [];
  tris.forEach((T, ti) => {
    const c = cuts[ti]!;
    const t = T.t;
    const n = t.nExact;
    const d = q3Dot(n, t.v[0].exact);
    const axis = projectionAxis(n);
    const known = new Map<string, Q3>(); // 2D key → exact 3D
    const p2 = (p: Q3): Q2 => {
      const q = project(p, axis);
      known.set(key2(q), p);
      return q;
    };
    const tv = t.v.map((v) => p2(v.exact)) as unknown as [Q2, Q2, Q2];
    // Keep the triangle's own orientation counter-clockwise in 2D.
    const flip = orient2d(tv[0], tv[1], tv[2]) < 0;

    const segs: Seg[] = [];
    for (let e = 0; e < 3; e++) segs.push({ a: tv[e]!, b: tv[(e + 1) % 3]!, kind: T.edgeKind[e]! });
    for (const [a, b] of c.segs) segs.push({ a: p2(a), b: p2(b), kind: CUT });
    // Coplanar partners: their edges, clipped to this triangle, cut it too.
    // In Blender they are face edges of the cluster's CDT, so they carry the
    // partner's original edge — kept, but **not** intersection edges — and
    // its triangulation diagonals carry none and stay dissolvable
    // (`get_cdt_edge_orig`). Marking the diagonals as cuts split a shared
    // cube top into 5-gons and triangles where Blender has two quads.
    for (const j of c.coplanar) {
      const o = tris[j]!.t.v.map((v) => p2(v.exact));
      for (let e = 0; e < 3; e++) {
        const clipped = clipToTriangle(o[e]!, o[(e + 1) % 3]!, tv, flip);
        const kind = tris[j]!.edgeKind[e] === DIAG ? DIAG : ORIG;
        if (clipped) segs.push({ a: clipped[0], b: clipped[1], kind });
      }
    }
    const { edges, points } = arrangement(segs, c.pts.map(p2));

    // The outer triangle first, counter-clockwise in 2D, as `cdt.ts` wants.
    const outer = (flip ? [tv[0], tv[2], tv[1]] : [tv[0], tv[1], tv[2]]).map(key2);
    const keys = [...outer, ...[...points.keys()].filter((k) => !outer.includes(k))];
    const index = new Map(keys.map((k, i) => [k, i]));
    const kindOf = new Map<string, number>();
    const constraints: [number, number][] = edges.map((e) => {
      const a = index.get(e.u)!;
      const b = index.get(e.v)!;
      kindOf.set(`${a},${b}`, e.kind);
      kindOf.set(`${b},${a}`, e.kind);
      return [a, b];
    });
    const gid = keys.map((k) => vertexOf(known.get(k) ?? unproject(points.get(k)!, axis, n, d)));
    for (const tri of constrainedDelaunay(keys.map((k) => points.get(k)!), constraints)) {
      // Counter-clockwise here is the input's winding unless the projection
      // mirrored the triangle.
      const loop = flip ? [tri[0], tri[2], tri[1]] : tri;
      pieces.push({
        face: T.face,
        ids: loop.map((i) => gid[i]!),
        kinds: loop.map((i, j) => kindOf.get(`${i},${loop[(j + 1) % 3]}`) ?? 0),
      });
    }
  });

  return { verts, pieces };
}

/**
 * Merge each input face's triangles back into polygons (`merge_tris_for_face`),
 * then drop the new vertices left in the middle of straight edges
 * (`dissolve_verts`). Faces come out in input-face order.
 */
export function mergePieces(pieces: Piece[], data: MeshData, verts: EVert[]): OutFace[] {
  const out: OutFace[] = [];
  const byFace = new Map<number, Piece[]>();
  for (const p of pieces) (byFace.get(p.face) ?? byFace.set(p.face, []).get(p.face)!).push(p);
  for (const [face, list] of [...byFace].sort((a, b) => a[0] - b[0]))
    for (const m of mergeTrisForFace(list, data.polys[face]!, verts)) out.push({ ...m, face });
  return dissolveVerts(out, verts, data.positions.length / 3);
}

/**
 * Polygons over `verts` → `MeshData`, keeping only the vertices some polygon
 * uses, in their order — what `apply_mesh_output_to_bmesh` keeps. Input
 * vertices keep their relative order, so an input vertex that survives is
 * still found where it was relative to the others.
 */
export function toMeshData(polys: number[][], verts: EVert[]): MeshData {
  const used = new Set<number>(polys.flat());
  const remap = new Map<number, number>();
  const kept: EVert[] = [];
  verts.forEach((v, i) => {
    if (used.has(i)) {
      remap.set(i, kept.length);
      kept.push(v);
    }
  });
  const positions = new Float32Array(kept.length * 3);
  kept.forEach((v, i) => {
    positions[i * 3] = v.co[0];
    positions[i * 3 + 1] = v.co[1];
    positions[i * 3 + 2] = v.co[2];
  });
  return { positions, polys: polys.map((p) => p.map((v) => remap.get(v)!)) };
}

/** A merged polygon, with per edge (vert[i] → vert[i+1]) whether it is an intersection edge. */
export interface Merged {
  vert: number[];
  isect: boolean[];
}

/** …and the input face it came from. */
export interface OutFace extends Merged {
  face: number;
}

export interface Piece {
  face: number;
  ids: number[];
  /** Per edge i (ids[i] → ids[i+1]): the arrangement kind, 0 if the CDT added it. */
  kinds: number[];
}

/** `populate_plane(false)` for a triangle: `(v0 − v2) × (v1 − v2)`, in doubles. */
function triNormal(ids: number[], verts: EVert[]): number[] {
  const [a, b, c] = ids.map((i) => verts[i]!.co);
  const u = [0, 1, 2].map((k) => a![k]! - c![k]!);
  const w = [0, 1, 2].map((k) => b![k]! - c![k]!);
  return [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
}

const dot3 = (a: number[], b: number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

function cyclicEqual(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  return a.some((_, s) => a.every((v, i) => v === b[(i + s) % b.length]));
}

interface MergeEdge {
  v1: number;
  v2: number;
  lenSquared: number;
  left: number;
  right: number;
  orig: boolean;
  isIntersect: boolean;
  dissolvable: boolean;
}

interface MergeFace {
  vert: number[];
  edge: number[];
  mergeTo: number;
}

/**
 * `merge_tris_for_face` (`mesh_boolean.cc`), ported as it is: the quad
 * recovery; then, once for the first triangle's normal and once for its
 * reverse, dissolve the dissolvable edges **longest first**, skipping any
 * whose removal would leave an invalid BMesh face (`dissolve_leaves_valid_bmesh`).
 *
 * The greedy order is what decides the answer where the pieces cannot all
 * become one polygon — a ring around a hole ends as two faces, split by the
 * shortest edges that were left (`slabPin`, measured).
 */
function mergeTrisForFace(list: Piece[], poly: readonly number[], verts: EVert[]): Merged[] {
  if (list.length <= 1) return list.map((p) => ({ vert: p.ids, isect: p.kinds.map(isIntersectKind) }));
  const n0 = triNormal(list[0]!.ids, verts);
  const n1 = triNormal(list[1]!.ids, verts);
  if (list.length === 2 && dot3(n0, n1) > 0 && poly.length === 4) {
    // "Is this a case where quad with one diagonal remained unchanged?"
    const [t1, t2] = list as [Piece, Piece];
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        if (t1.ids[(i + 1) % 3] !== t2.ids[j] || t1.ids[i] !== t2.ids[(j + 1) % 3]) continue;
        if (t1.kinds[i]! & ORIG) continue;
        const tryface = [t1.ids[(i + 1) % 3]!, t1.ids[(i + 2) % 3]!, t1.ids[i]!, t2.ids[(j + 2) % 3]!];
        if (cyclicEqual(tryface, poly)) return [{ vert: [...poly], isect: poly.map(() => false) }];
      }
  }

  const out: Merged[] = [];
  for (const norm of [n0, n0.map((c) => -c)]) {
    const faces: MergeFace[] = [];
    const edges: MergeEdge[] = [];
    const edgeMap = new Map<string, number>();
    for (const tri of list) {
      if (dot3(norm, triNormal(tri.ids, verts)) <= 0) continue;
      const f = faces.length;
      faces.push({ vert: [...tri.ids], edge: [], mergeTo: -1 });
      for (let i = 0; i < 3; i++) {
        const a = tri.ids[i]!;
        const b = tri.ids[(i + 1) % 3]!;
        const kind = tri.kinds[i]!;
        const v1 = Math.min(a, b);
        const v2 = Math.max(a, b);
        let idx = edgeMap.get(`${v1},${v2}`);
        if (idx === undefined) {
          const p = verts[v1]!.co;
          const q = verts[v2]!.co;
          const orig = (kind & ORIG) !== 0;
          const isIntersect = isIntersectKind(kind);
          idx = edges.length;
          edges.push({
            v1,
            v2,
            lenSquared: (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2,
            left: -1,
            right: -1,
            orig,
            isIntersect,
            dissolvable: !orig && !isIntersect,
          });
          edgeMap.set(`${v1},${v2}`, idx);
        }
        const me = edges[idx]!;
        if (me.dissolvable && kind & ORIG) {
          me.dissolvable = false;
          me.orig = true;
        }
        if (me.dissolvable && isIntersectKind(kind)) {
          me.dissolvable = false;
          me.isIntersect = true;
        }
        // Left or right depending on the edge's orientation; a side already
        // taken means the triangulation was not manifold here — keep the edge.
        if (me.v1 === a) {
          if (me.left !== -1) me.dissolvable = false;
          else me.left = f;
        } else if (me.right !== -1) me.dissolvable = false;
        else me.right = f;
        faces[f]!.edge.push(idx);
      }
    }
    doDissolve(faces, edges);
    for (const mf of faces)
      if (mf.mergeTo === -1) out.push({ vert: mf.vert, isect: mf.edge.map((e) => edges[e]!.isIntersect) });
  }
  return out;
}

/** `do_dissolve`: longest first. JavaScript's sort is stable; Blender's is not — only ties differ. */
function doDissolve(faces: MergeFace[], edges: MergeEdge[]): void {
  const order = edges
    .map((_, i) => i)
    .filter((i) => edges[i]!.dissolvable)
    .sort((a, b) => edges[b]!.lenSquared - edges[a]!.lenSquared);
  for (const meIndex of order) {
    const me = edges[meIndex]!;
    if (me.left === -1 || me.right === -1) continue;
    const L = faces[me.left]!;
    const R = faces[me.right]!;
    if (!dissolveLeavesValidBmesh(edges, me, meIndex, L, R)) continue;
    spliceFaces(edges, me, meIndex, L, R);
  }
}

/**
 * `dissolve_leaves_valid_bmesh`: not if another edge of the left face has
 * the right face on its right (two boundary parts), and not if the two faces
 * share a vertex other than the edge's ends (a repeated vertex).
 */
function dissolveLeavesValidBmesh(edges: MergeEdge[], me: MergeEdge, meIndex: number, L: MergeFace, R: MergeFace): boolean {
  const aStart = L.edge.indexOf(meIndex);
  const alen = L.vert.length;
  for (let k = (aStart + 1) % alen; k !== aStart; k = (k + 1) % alen)
    if (edges[L.edge[k]!]!.right === me.right) return false;
  for (const av of L.vert) if (av !== me.v1 && av !== me.v2 && R.vert.includes(av)) return false;
  return true;
}

/** `splice_faces`: the right face's other edges replace `me` in the left face. */
function spliceFaces(edges: MergeEdge[], me: MergeEdge, meIndex: number, L: MergeFace, R: MergeFace): void {
  const aStart = L.edge.indexOf(meIndex);
  const bStart = R.edge.indexOf(meIndex);
  const alen = L.vert.length;
  const blen = R.vert.length;
  const sv: number[] = [];
  const se: number[] = [];
  for (let ai = 0; ai < aStart; ai++) {
    sv.push(L.vert[ai]!);
    se.push(L.edge[ai]!);
  }
  let bi = bStart + 1;
  while (bi !== bStart) {
    if (bi >= blen) {
      bi = 0;
      if (bi === bStart) break;
    }
    sv.push(R.vert[bi]!);
    se.push(R.edge[bi]!);
    const e = edges[R.edge[bi]!]!;
    if (R.vert[bi] === e.v1) e.left = me.left;
    else e.right = me.left;
    bi++;
  }
  for (let ai = aStart + 1; ai < alen; ai++) {
    sv.push(L.vert[ai]!);
    se.push(L.edge[ai]!);
  }
  R.mergeTo = me.left;
  L.vert = sv;
  L.edge = se;
  me.left = -1;
  me.right = -1;
}


/**
 * Blender's `find_dissolve_verts` + `dissolve_verts`: drop a vertex that
 * (a) was not in the input, (b) has the **same two neighbours in every face
 * that uses it**, and (c) sits in line with them — `approx_in_line`, in
 * doubles, `|cos − 1| < 1e-4` between `v − u` and `w − v`.
 *
 * These are the points where a cut line was chopped by the *other* face's
 * triangulation diagonal. The diagonal dissolved; the point it left on the
 * straight cut is noise, and Blender's output does not have it (measured:
 * 22 vertices for the two cubes, where keeping them gives more).
 */
function dissolveVerts(polys: OutFace[], verts: EVert[], inputCount: number): OutFace[] {
  const candidate = verts.map((_, i) => i >= inputCount);
  const nbrs = new Map<number, [number, number]>();
  for (const { vert: p } of polys)
    p.forEach((v, i) => {
      if (!candidate[v]) return;
      const next = p[(i + 1) % p.length]!;
      const prev = p[(i - 1 + p.length) % p.length]!;
      const seen = nbrs.get(v);
      if (!seen) nbrs.set(v, [next, prev]);
      else if (!((next === seen[1] && prev === seen[0]) || (next === seen[0] && prev === seen[1])))
        candidate[v] = false;
    });
  const inLine = (a: readonly number[], b: readonly number[], c: readonly number[]): boolean => {
    const v1 = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
    const v2 = [c[0]! - b[0]!, c[1]! - b[1]!, c[2]! - b[2]!];
    const l1 = Math.hypot(v1[0]!, v1[1]!, v1[2]!);
    const l2 = Math.hypot(v2[0]!, v2[1]!, v2[2]!);
    if (l1 === 0 || l2 === 0) return false;
    const cos = (v1[0]! * v2[0]! + v1[1]! * v2[1]! + v1[2]! * v2[2]!) / (l1 * l2);
    return Math.abs(cos - 1) < 1e-4;
  };
  const drop = verts.map((_, v) => {
    if (!candidate[v]) return false;
    const n = nbrs.get(v);
    return n !== undefined && inLine(verts[n[0]]!.co, verts[v]!.co, verts[n[1]]!.co);
  });
  // `erase_face_positions`: a kept corner keeps the flags of the edge leaving it.
  return polys
    .map((f) => {
      const keep = f.vert.map((v) => !drop[v]);
      return { face: f.face, vert: f.vert.filter((_, i) => keep[i]), isect: f.isect.filter((_, i) => keep[i]) };
    })
    .filter((f) => f.vert.length >= 3);
}

/**
 * Split the edges in `split` (keys `min_max`) apart: every vertex on one is
 * copied once per fan of its faces that stays connected — across edges not
 * in `split`, and across split edges between faces of the same `side`. With
 * a side per face that is `BM_mesh_edgesplit` (every face gets its own copy
 * of the edge); with two sides it is `BM_mesh_separate_faces`.
 * New vertices are appended to `verts`.
 */
function splitAlongEdges(
  polys: number[][],
  split: ReadonlySet<string>,
  verts: EVert[],
  side: (face: number) => number,
): number[][] {
  const ek = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const onSplit = new Set<number>();
  for (const k of split) for (const v of k.split("_")) onSplit.add(Number(v));
  // Corners at each such vertex, joined across edges that are not split.
  const corners = new Map<number, [number, number][]>();
  polys.forEach((p, f) =>
    p.forEach((v, i) => {
      if (onSplit.has(v)) (corners.get(v) ?? corners.set(v, []).get(v)!).push([f, i]);
    }),
  );
  const out = polys.map((p) => [...p]);
  for (const [v, list] of corners) {
    const parent = list.map((_, i) => i);
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)));
    const byEdge = new Map<string, number>();
    list.forEach(([f, i], ci) => {
      const p = polys[f]!;
      for (const w of [p[(i + 1) % p.length]!, p[(i - 1 + p.length) % p.length]!]) {
        const k = split.has(ek(v, w)) ? `${ek(v, w)}/${side(f)}` : ek(v, w);
        const other = byEdge.get(k);
        if (other === undefined) byEdge.set(k, ci);
        else parent[find(ci)] = find(other);
      }
    });
    const copyOf = new Map<number, number>();
    list.forEach(([f, i], ci) => {
      const root = find(ci);
      if (root === find(0)) return; // the first fan keeps the vertex
      let id = copyOf.get(root);
      if (id === undefined) {
        id = verts.length;
        verts.push(verts[v]!);
        copyOf.set(root, id);
      }
      out[f]![i] = id;
    });
  }
  return out;
}

/** Clip segment a–b to the triangle `tv` (Cyrus–Beck, exact). */
function clipToTriangle(a: Q2, b: Q2, tv: [Q2, Q2, Q2], flip: boolean): [Q2, Q2] | null {
  let t0: Q = { n: 0n, d: 1n };
  let t1: Q = { n: 1n, d: 1n };
  const dx = sub(b[0], a[0]);
  const dy = sub(b[1], a[1]);
  for (let e = 0; e < 3; e++) {
    const p = tv[e]!;
    const r = tv[(e + 1) % 3]!;
    // Inside means left of p→r (right, if the triangle is clockwise here).
    const ex = sub(r[0], p[0]);
    const ey = sub(r[1], p[1]);
    let num = sub(mul(ex, sub(a[1], p[1])), mul(ey, sub(a[0], p[0]))); // side of a
    let den = sub(mul(ex, dy), mul(ey, dx)); // rate of change along the segment
    if (flip) {
      num = neg(num);
      den = neg(den);
    }
    // Want num + t·den >= 0.
    if (sign(den) === 0) {
      if (sign(num) < 0) return null;
      continue;
    }
    const t = div(neg(num), den);
    if (sign(den) > 0) {
      if (cmp(t, t0) > 0) t0 = t;
    } else if (cmp(t, t1) < 0) t1 = t;
    if (cmp(t0, t1) >= 0) return null;
  }
  const at = (t: Q): Q2 => [add(a[0], mul(dx, t)), add(a[1], mul(dy, t))];
  return [at(t0), at(t1)];
}


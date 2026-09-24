/**
 * Cut a mesh where it passes through itself — Blender's `bpy.ops.mesh.intersect`
 * with the exact solver. ADR-012's first stage.
 *
 * ## How, and where it departs from Blender's code
 *
 * Blender (`blenlib/intern/mesh_intersect.cc`) triangulates every polygon,
 * intersects every overlapping triangle pair exactly, then runs an **exact
 * constrained Delaunay triangulation** (`delaunay_2d.cc`, 3416 lines) inside
 * each triangle to cut it along its intersection segments, and finally
 * dissolves the triangles of each original polygon back into polygons.
 *
 * The Delaunay step is not ported. **Its triangulation does not survive**:
 * the last step dissolves every edge that is neither an original edge nor an
 * intersection edge, so what reaches the output is decided by the vertices and
 * the constrained edges alone, not by which way the interior was triangulated.
 * So each triangle is cut here by an **exact 2D planar arrangement** of its own
 * boundary and its intersection segments, and the pieces of one polygon are
 * merged across the triangulation's diagonals. The same pieces, fewer lines.
 *
 * What is ported as it is: the triangulation of the input polygons (it decides
 * *where* the cuts are on a non-planar quad), the exact triangle–triangle test
 * (`tri-tri.ts`), and the rule that the same exact point is the same vertex.
 *
 * ## Measured (`probe-intersect.py`), exact solver
 *
 * Two unit cubes in one mesh, the second moved `(0.5, 0.3, 0.2)`: 12 faces in,
 * **18 out** — the six faces the other cube passes through each become a
 * hexagon and a quad. `separate_mode = 'NONE'` keeps everything welded, so
 * the cut edges are each shared by four faces.
 *
 * The parity row `intersect` (a cube and a UV sphere, the kurimanju cage with
 * a box through it) agrees down to the vertex set of every face. It first
 * disagreed on one rule the cubes cannot ask: **self mode intersects the two
 * halves of the same face with each other** (`nshapes == 1` has no pair
 * filter). A bent quad's halves meet in their diagonal, which therefore comes
 * out as an intersection edge and is never dissolved — a cut across a bent
 * quad leaves four faces, not two. An uncut bent quad still comes back whole
 * (the "quad recovery" in `merge_tris_for_face`).
 *
 * ## Not yet
 *
 * - `separate_mode` `ALL` / `CUT` — post-processing on top of this.
 * - A piece with a **hole** (a loop of cuts entirely inside one face). Blender's
 *   polygons cannot hold one; this keeps such a polygon triangulated for now
 *   and says so in `holes` on the result.
 * - Non-planar polygons of five or more vertices, whose triangulation here is
 *   a fan where Blender's is `BLI_polyfill_calc`. For planar ones the diagonals
 *   dissolve and it does not matter. For bent ones it does, and more than for
 *   cut placement: by the rule above their diagonals are intersection edges,
 *   and quad recovery covers only quads — so **an uncut bent n-gon should come
 *   out triangulated**. Read from the code, not yet measured.
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
}

export interface IntersectResult extends MeshData {
  /**
   * Original faces whose pieces could not be merged into simple polygons
   * because a cut loop sits entirely inside them (a hole). Their pieces are
   * left as the triangulated arrangement. Empty in every case measured so far.
   */
  holes: number[];
}

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
const ORIG = 1; // an edge of the input polygon
const DIAG = 2; // a diagonal added by triangulating the polygon
const CUT = 4; // an intersection edge, or a coplanar partner's edge

interface Seg {
  a: Q2;
  b: Q2;
  kind: number;
}

/**
 * The bounded faces of the planar arrangement of `segs`, each a CCW list of
 * point keys, with the kind of each of its edges. Everything exact: segments
 * are split at every crossing and every vertex that lies on them, collinear
 * overlaps collapse to one edge carrying both kinds, and faces are traced by
 * sorting each vertex's edges by angle with `orient2d`.
 */
function arrangement(
  segs: Seg[],
  extraPoints: Q2[],
): { faces: { keys: string[]; kinds: number[] }[]; points: Map<string, Q2> } {
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

  // Adjacency, sorted counter-clockwise around each vertex.
  const adj = new Map<string, string[]>();
  const kindOf = new Map<string, number>();
  for (const { u, v, kind } of edges.values()) {
    (adj.get(u) ?? adj.set(u, []).get(u)!).push(v);
    (adj.get(v) ?? adj.set(v, []).get(v)!).push(u);
    kindOf.set(`${u}>${v}`, kind);
    kindOf.set(`${v}>${u}`, kind);
  }
  for (const [c, list] of adj) {
    const o = points.get(c)!;
    const half = (p: Q2): number => {
      const dy = sign(sub(p[1], o[1]));
      const dx = sign(sub(p[0], o[0]));
      return dy > 0 || (dy === 0 && dx > 0) ? 0 : 1;
    };
    list.sort((ka, kb) => {
      const a = points.get(ka)!;
      const b = points.get(kb)!;
      const ha = half(a);
      const hb = half(b);
      if (ha !== hb) return ha - hb;
      return -orient2d(o, a, b); // a before b when b is counter-clockwise of a
    });
  }

  // Trace faces: after u→v, turn to the edge just clockwise of v→u.
  const used = new Set<string>();
  const faces: { keys: string[]; kinds: number[] }[] = [];
  for (const [u0, list] of adj)
    for (const v0 of list) {
      if (used.has(`${u0}>${v0}`)) continue;
      const keys: string[] = [];
      const kinds: number[] = [];
      let u = u0;
      let v = v0;
      for (let guard = 0; guard < 100000; guard++) {
        used.add(`${u}>${v}`);
        keys.push(u);
        kinds.push(kindOf.get(`${u}>${v}`)!);
        const around = adj.get(v)!;
        const i = around.indexOf(u);
        const w = around[(i - 1 + around.length) % around.length]!;
        u = v;
        v = w;
        if (u === u0 && v === v0) break;
      }
      // Keep bounded faces: positive signed area.
      let area2: Q = { n: 0n, d: 1n };
      for (let i = 0; i < keys.length; i++) {
        const a = points.get(keys[i]!)!;
        const b = points.get(keys[(i + 1) % keys.length]!)!;
        area2 = add(area2, sub(mul(a[0], b[1]), mul(a[1], b[0])));
      }
      if (sign(area2) > 0) faces.push({ keys, kinds });
    }
  return { faces, points };
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
 * `(0,1,3) + (1,2,3)`. Larger polygons: a fan (see the note at the top).
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
  const out: [number[], number[]][] = [];
  for (let i = 1; i + 1 < poly.length; i++)
    out.push([
      [poly[0]!, poly[i]!, poly[i + 1]!],
      [i === 1 ? ORIG : DIAG, ORIG, i + 1 === poly.length - 1 ? ORIG : DIAG],
    ]);
  return out;
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
      if (mode === "twoSets" && options.set!.has(A.face) === options.set!.has(B.face)) continue;
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

  // Cut each triangle; keep its pieces as polygons of global vertex ids,
  // with each edge's kind.
  const pieces: { face: number; ids: number[]; kinds: number[] }[] = [];
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
    // Coplanar partners: their edges, clipped to this triangle, cut it too —
    // **except their triangulation diagonals**, which carry no original edge
    // and so stay dissolvable here as they are in Blender (`get_cdt_edge_orig`
    // gives them NO_INDEX). Marking them as cuts split a shared cube top into
    // 5-gons and triangles where Blender has two quads.
    for (const j of c.coplanar) {
      const o = tris[j]!.t.v.map((v) => p2(v.exact));
      for (let e = 0; e < 3; e++) {
        const clipped = clipToTriangle(o[e]!, o[(e + 1) % 3]!, tv, flip);
        const kind = tris[j]!.edgeKind[e] === DIAG ? DIAG : CUT;
        if (clipped) segs.push({ a: clipped[0], b: clipped[1], kind });
      }
    }
    const extra = c.pts.map(p2);

    const { faces, points } = arrangement(segs, extra);
    for (const f of faces) {
      // Every segment lies inside the triangle, so every bounded face is a
      // piece of it. Faces come back counter-clockwise in 2D.
      let ids = f.keys.map((k) => vertexOf(known.get(k) ?? unproject(points.get(k)!, axis, n, d)));
      let kinds = f.kinds;
      if (flip) {
        // The projection mirrored the triangle, so counter-clockwise here is
        // the opposite of the input's winding: reverse. Edge i of the reversed
        // list is edge (m − 2 − i) of the original, walked backwards.
        const m = ids.length;
        ids = [...ids].reverse();
        kinds = ids.map((_, i) => f.kinds[(m - 2 - i + m) % m]!);
      }
      pieces.push({ face: T.face, ids, kinds });
    }
  });

  // Merge each original face's pieces across pure diagonals.
  const out: number[][] = [];
  const holes: number[] = [];
  const byFace = new Map<number, typeof pieces>();
  for (const p of pieces) (byFace.get(p.face) ?? byFace.set(p.face, []).get(p.face)!).push(p);
  for (const [face, list] of [...byFace].sort((a, b) => a[0] - b[0])) {
    // A quad whose two triangles came through uncut is the quad again, even
    // when its diagonal is marked as an intersection above (Blender's "quad
    // recovery" in `merge_tris_for_face`).
    const poly = data.polys[face]!;
    if (
      poly.length === 4 &&
      list.length === 2 &&
      list.every((p) => p.ids.length === 3 && p.ids.every((v) => poly.includes(v)))
    ) {
      out.push([...poly]);
      continue;
    }
    const parent = list.map((_, i) => i);
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)));
    const diagOwner = new Map<string, number>();
    list.forEach((p, pi) =>
      p.ids.forEach((u, i) => {
        if (p.kinds[i] !== DIAG) return;
        const v = p.ids[(i + 1) % p.ids.length]!;
        const k = u < v ? `${u}_${v}` : `${v}_${u}`;
        const other = diagOwner.get(k);
        if (other === undefined) diagOwner.set(k, pi);
        else parent[find(pi)] = find(other);
      }),
    );
    const groups = new Map<number, number[]>();
    list.forEach((_, i) => (groups.get(find(i)) ?? groups.set(find(i), []).get(find(i))!).push(i));
    for (const members of groups.values()) {
      if (members.length === 1) {
        out.push(list[members[0]!]!.ids);
        continue;
      }
      // Boundary: directed edges whose reverse is not also present.
      const directed = new Map<string, [number, number]>();
      for (const m of members) {
        const ids = list[m]!.ids;
        ids.forEach((u, i) => {
          const v = ids[(i + 1) % ids.length]!;
          if (directed.has(`${v}>${u}`)) directed.delete(`${v}>${u}`);
          else directed.set(`${u}>${v}`, [u, v]);
        });
      }
      const next = new Map<number, number>();
      let clean = true;
      for (const [u, v] of directed.values()) {
        if (next.has(u)) clean = false;
        next.set(u, v);
      }
      const start = directed.values().next().value![0];
      const loop: number[] = [start];
      for (let v = next.get(start)!; v !== start && loop.length <= directed.size; v = next.get(v)!) loop.push(v);
      if (!clean || loop.length !== directed.size) {
        // More than one boundary loop: a hole. Keep the pieces as they are.
        holes.push(face);
        for (const m of members) out.push(list[m]!.ids);
        continue;
      }
      out.push(loop);
    }
  }

  // A face with exactly the vertex set of an earlier one is the same face:
  // BMesh cannot hold two, and Blender's output has one. This is where the
  // coplanar overlap of two cubes goes — both cubes produce the shared piece,
  // and it appears once (measured: 16 faces, not 20).
  const seen = new Set<string>();
  const polys = dissolveVerts(out, verts, P.length / 3).filter((p) => {
    const k = [...p].sort((a, b) => a - b).join(",");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Keep every input vertex (in its place, so input indices stay valid) and
  // only the new vertices some face still uses — a dissolved vertex is gone,
  // as it is from Blender's output.
  const inputCount = P.length / 3;
  const used = new Set<number>(polys.flat());
  const remap = new Map<number, number>();
  const kept: EVert[] = [];
  verts.forEach((v, i) => {
    if (i < inputCount || used.has(i)) {
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
  return {
    positions,
    polys: polys.map((p) => p.map((v) => remap.get(v)!)),
    holes: [...new Set(holes)],
  };
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
function dissolveVerts(polys: number[][], verts: EVert[], inputCount: number): number[][] {
  const candidate = verts.map((_, i) => i >= inputCount);
  const nbrs = new Map<number, [number, number]>();
  for (const p of polys)
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
  return polys.map((p) => p.filter((v) => !drop[v])).filter((p) => p.length >= 3);
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


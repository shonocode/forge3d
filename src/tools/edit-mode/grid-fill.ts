/**
 * Grid fill — close a ring of vertices with a grid of quads.
 *
 * Blender's `bpy.ops.mesh.fill_grid()`. **Not `bmesh.ops.grid_fill`**, which
 * returns `faces: []` however it is driven: it wants *two open* edge loops plus
 * two connecting rails, and the "one closed loop" form everybody actually uses
 * lives in the operator wrapper's prepare pass. That split is why this sat in
 * the API matrix for four sessions as "the reference does not move" — the
 * reference moved, the other reference.
 *
 * The rules below were read off `bmo_fill_grid.cc` and
 * `editmesh_tools.cc` (`edbm_fill_grid_prepare`), then checked against the
 * measurements in `tools/modeling/parity/probe-gridfill.py`.
 *
 * ## The topology
 *
 * A closed ring of `L` vertices (`L` even) is cut into four runs: two opposite
 * **sides** of `L/2 - span` edges and two **rails** of `span` edges. The grid
 * is then `(L/2 - span) × span` quads.
 *
 * Where the cut starts is the ring's most corner-like vertex — the one whose
 * `|π - interior angle|` is largest — and `offset` rotates the start from
 * there. Blender uses the *active* vertex when there is one; there is no such
 * thing here, so the corner rule always applies.
 *
 * `span` left unset is Blender's "calculate it": start from `L/4`, then look
 * for a second corner. Every vertex's corner angle is scored with the best
 * corner and the vertex diametrically opposite it **excluded**, and if the best
 * of the rest stands out from the third-from-last by more than `1e-3` radians,
 * its index becomes the span. A ring with no corners — a circle — keeps `L/4`.
 *
 * ## The interior
 *
 * Two schemes, and Blender's default is the second one:
 *
 * - `interpSimple: true` — mean-value coordinates of `(u, v)` inside the
 *   square `{(u,0), (0,v), (u,1), (1,v)}` used as weights on the four boundary
 *   points opposite the interior point. Flat, cheap, and it ignores how the
 *   boundary leaves the plane.
 * - default — for each row, build a triangle frame from the two rails at that
 *   row and its neighbours, and one at each end of the grid; carry the bottom
 *   and top row's points into the row's frame; blend the two by how far up the
 *   row is. This is what makes a filled hole follow the surrounding curvature
 *   instead of cutting the corner.
 *
 * ## Measured
 *
 * Blender 5.1.1, `probe-gridfill.py`. Rectangular rings reconstruct their own
 * grid (a 4×2 ring of 12 gives 15 verts / 8 quads, 4×4 gives 25 / 16, 5×3
 * gives 24 / 15); `span` walks the split (2 → 8 quads, 3 → 9, 4 → 8); a ring
 * of 7 is refused; the two interpolations agree on an evenly spaced rectangle
 * and separate on an uneven one, on a circle, and on a saddle.
 *
 * ## Winding and layers
 *
 * A ring that is the rim of a hole has faces beside it. The grid is wound to
 * agree with them by a vote over the rim's edges (`USE_FLIP_DETECT`), and its
 * corners take their UVs, colours and normals from the rim faces' corners:
 * `bm_grid_fill_array` blends the corners on the two sides (or the four, when
 * both a side and a rail have faces) with the same mean-value weights as the
 * interior points, and each interior vertex mixes the vertex groups of its
 * four boundary points. A new face takes material slot 0 — Blender's operator
 * passes the object's active slot, which a mesh does not have. A wire ring has
 * no rim faces: its faces' corners are zero, as Blender leaves them.
 *
 * Not matched: a grid corner lies on two rim faces and copies the one along
 * the grid's first side, so which face it is follows the layout. Here the
 * layout follows the ring order; on a hole's rim Blender takes it from its
 * edge-loop walk over the edges in index order (`BM_mesh_edgeloops_find`),
 * which a ring order cannot reproduce — 2 of the 4 corners differ
 * (`grid-fill-layers`, kept as "different").
 */
import type { MeshData } from "../../lib/mesh";

/** Below this, in radians, two corner angles count as the same. Blender's. */
const EPS_EVEN = 1e-3;

export interface GridFillOptions {
  /**
   * Edges per rail — the grid is `(L/2 - span) × span` quads. Left out, it is
   * calculated the way Blender calculates it (see above). Clamped to
   * `[1, L/2 - 1]`, as its RNA range and prepare pass do between them.
   */
  span?: number;
  /** Rotate the starting corner this many vertices around the ring. */
  offset?: number;
  /** Use the flat mean-value blend instead of the curvature-following one. */
  interpSimple?: boolean;
}

type Vec3 = [number, number, number];

const at = (P: Float32Array, v: number): Vec3 => [P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

function normalized(a: Vec3): Vec3 {
  const len = length(a);
  return len > 1e-30 ? scale(a, 1 / len) : [0, 0, 0];
}

/** `|π - angle(prev, v, next)|` — how much the ring turns at `v`. */
function cornerAngle(P: Float32Array, prev: number, v: number, next: number): number {
  const a = normalized(sub(at(P, prev), at(P, v)));
  const b = normalized(sub(at(P, next), at(P, v)));
  const angle = Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
  return Math.abs(Math.PI - angle);
}

/**
 * Mean-value weights for `co` inside the quad `v1..v4`, in 2D.
 *
 * Blender's `barycentric_weights_v2_quad`, including its two short circuits:
 * a corner the point sits on takes everything, and a point on an edge splits
 * it between that edge's ends.
 */
function quadWeights(
  v: readonly [number, number][],
  co: readonly [number, number],
): [number, number, number, number] {
  const dirs = v.map((p) => [p[0] - co[0], p[1] - co[1]] as [number, number]);
  const lens = dirs.map((d) => Math.hypot(d[0], d[1]));
  for (let i = 0; i < 4; i++) {
    if (lens[i]! < Number.EPSILON) {
      const w: [number, number, number, number] = [0, 0, 0, 0];
      w[i] = 1;
      return w;
    }
  }
  const areas: number[] = [];
  const dots: number[] = [];
  const lensProd: number[] = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) & 3;
    areas.push(dirs[i]![0] * dirs[j]![1] - dirs[i]![1] * dirs[j]![0]);
    dots.push(dirs[i]![0] * dirs[j]![0] + dirs[i]![1] * dirs[j]![1]);
    lensProd.push(lens[i]! * lens[j]!);
  }
  for (let i = 0; i < 4; i++) {
    if (Math.abs(areas[i]!) < 1e-12 * lensProd[i]! && dots[i]! <= 0) {
      const j = (i + 1) & 3;
      const sum = lens[i]! + lens[j]!;
      const w: [number, number, number, number] = [0, 0, 0, 0];
      w[i] = lens[j]! / sum;
      w[j] = lens[i]! / sum;
      return w;
    }
  }
  const t = areas.map((area, i) => (area !== 0 ? Math.abs((lensProd[i]! - dots[i]!) / area) : 0));
  const w: [number, number, number, number] = [
    (t[3]! + t[0]!) / lens[0]!,
    (t[0]! + t[1]!) / lens[1]!,
    (t[1]! + t[2]!) / lens[2]!,
    (t[2]! + t[3]!) / lens[3]!,
  ];
  const total = w[0] + w[1] + w[2] + w[3];
  if (total !== 0 && Number.isFinite(total)) return [w[0] / total, w[1] / total, w[2] / total, w[3] / total];
  return [0.25, 0.25, 0.25, 0.25];
}

/** Barycentric weights of `co` in the 2D triangle — Blender's `barycentric_weights_v2`. */
function triWeights(
  a: readonly [number, number],
  b: readonly [number, number],
  c: readonly [number, number],
  co: readonly [number, number],
): [number, number, number] {
  const cross2 = (p: readonly [number, number], q: readonly [number, number], r: readonly [number, number]): number =>
    (p[0] - r[0]) * (q[1] - r[1]) - (p[1] - r[1]) * (q[0] - r[0]);
  const w: [number, number, number] = [cross2(b, c, co), cross2(c, a, co), cross2(a, b, co)];
  const total = w[0] + w[1] + w[2];
  if (total !== 0) {
    const out: [number, number, number] = [w[0] / total, w[1] / total, w[2] / total];
    if (out.every((x) => Number.isFinite(x))) return out;
  }
  return [1 / 3, 1 / 3, 1 / 3];
}

/** A right-handed orthonormal frame whose z is `no`. Any will do: the weights
 * below are invariant to rotation in the plane and the height is `dot(no, p)`,
 * which is what Blender's `axis_dominant_v3_to_m3` gives its callers. */
function frame(no: Vec3): [Vec3, Vec3, Vec3] {
  const z = normalized(no);
  const up: Vec3 = Math.abs(z[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const x = normalized(sub(up, scale(z, dot(up, z))));
  return [x, cross(z, x), z];
}

const triArea = (a: Vec3, b: Vec3, c: Vec3): number => length(cross(sub(b, a), sub(c, a))) * 0.5;

/**
 * Carry `pt` from the triangle `src` into the triangle `dst` — Blender's
 * `transform_point_by_tri_v3`. The in-plane part rides on barycentric weights;
 * the out-of-plane part is re-applied along `dst`'s normal, scaled by the
 * square roots of the two areas so it survives a change of size.
 */
function transformPointByTri(pt: Vec3, dst: readonly Vec3[], src: readonly Vec3[]): Vec3 {
  const noDst = normalized(cross(sub(dst[1]!, dst[0]!), sub(dst[2]!, dst[0]!)));
  const noSrc = normalized(cross(sub(src[1]!, src[0]!), sub(src[2]!, src[0]!)));
  const [ax, ay, az] = frame(noSrc);
  const flat = (p: Vec3): [number, number] => [dot(p, ax), dot(p, ay)];
  const height = (p: Vec3): number => dot(p, az);
  const w = triWeights(flat(src[0]!), flat(src[1]!), flat(src[2]!), flat(pt));
  let out = add(add(scale(dst[0]!, w[0]), scale(dst[1]!, w[1])), scale(dst[2]!, w[2]));
  const areaDst = Math.sqrt(triArea(dst[0]!, dst[1]!, dst[2]!));
  const f2 = flat(src[0]!);
  const s1 = flat(src[1]!);
  const s2 = flat(src[2]!);
  const areaSrc = Math.sqrt(Math.abs((s1[0] - f2[0]) * (s2[1] - f2[1]) - (s1[1] - f2[1]) * (s2[0] - f2[0])) * 0.5);
  const zOfs = height(pt) - height(src[0]!);
  if (areaSrc > 0) out = add(out, scale(noDst, (zOfs / areaSrc) * areaDst));
  return out;
}

/** Blender's `quad_edges_to_normal`: the average of two normalized edges. */
function edgesToNormal(a1: Vec3, a2: Vec3, b1: Vec3, b2: Vec3): Vec3 {
  return normalized(add(normalized(sub(a2, a1)), normalized(sub(b2, b1))));
}

/**
 * The triangle frame Blender builds for a row of the grid —
 * `quad_verts_to_barycentric_tri`. Two of its points are the row's own ends;
 * the third is pushed off their midpoint along a normal built from where the
 * row is heading, at a distance equal to the row's width, which is what ties
 * the frame's scale to the geometry.
 */
function rowFrame(
  a: Vec3,
  b: Vec3,
  aNext: Vec3,
  bNext: Vec3,
  aPrev: Vec3 | null,
  bPrev: Vec3 | null,
  flip: boolean,
): [Vec3, Vec3, Vec3] {
  let no = edgesToNormal(a, aNext, b, bNext);
  if (aPrev && bPrev) no = normalized(add(no, edgesToNormal(aPrev, a, bPrev, b)));
  if (flip) no = scale(no, -1);
  no = scale(no, length(sub(a, b)));
  const mid = scale(add(a, b), 0.5);
  return [a, b, add(mid, no)];
}

/**
 * Fill a closed ring of vertices with a grid of quads.
 *
 * ```ts
 * const filled = gridFill(sheet, ringOfTwelve);          // Blender's default
 * const flat = gridFill(sheet, ring, { interpSimple: true, span: 3 });
 * ```
 *
 * `loop` is the ring in order, each vertex once; it is not checked for being a
 * ring of actual edges, because the caller knows where it came from and a
 * position ring is the more useful thing to be able to hand in.
 *
 * Refuses, loudly, rather than filling something else: an odd ring (Blender
 * refuses the same way, and it cannot be a grid), fewer than four vertices, a
 * repeated vertex, and a `span` with no room in the ring.
 *
 * @returns a new mesh with the grid's quads appended, and its interior
 *   vertices appended after the existing ones
 */
export function gridFill(mesh: MeshData, loop: readonly number[], options: GridFillOptions = {}): MeshData {
  const L = loop.length;
  if (L < 4) throw new Error(`gridFill: a ring of ${L} cannot be a grid — four is the minimum`);
  if (L % 2 !== 0)
    throw new Error(
      `gridFill: the ring has ${L} vertices and a grid needs an even number — ` +
        `Blender's fill_grid refuses this too ("a single closed edge loop from which two edge loops can be calculated")`,
    );
  if (new Set(loop).size !== L) throw new Error("gridFill: the ring visits a vertex twice");
  const count = mesh.positions.length / 3;
  for (const v of loop)
    if (!Number.isInteger(v) || v < 0 || v >= count)
      throw new Error(`gridFill: the ring names vertex ${v}, which this mesh does not have`);

  const P = mesh.positions;
  const half = L / 2;

  // Where the grid starts: the most corner-like vertex. Ties go to the lower
  // index — Blender's search keeps the first strictly-greatest, and its own
  // tie-break beyond that is an unstable `qsort`, so a ring with two equally
  // sharp corners is a ring whose grid orientation is not defined by either
  // side. `probe-gridfill.py` has the arrangement.
  let best = 0;
  let bestAngle = -1;
  for (let i = 0; i < L; i++) {
    const a = cornerAngle(P, loop[(i - 1 + L) % L]!, loop[i]!, loop[(i + 1) % L]!);
    if (a > bestAngle) {
      bestAngle = a;
      best = i;
    }
  }
  const offset = (((options.offset ?? 0) % L) + L) % L;
  const start0 = (best + offset) % L;
  const ring = Array.from({ length: L }, (_, i) => loop[(start0 + i) % L]!);

  let span: number;
  if (options.span === undefined) {
    span = Math.floor(L / 4);
    const scored = Array.from({ length: L }, (_, i) =>
      i === 0 || i === half ? 0 : cornerAngle(P, ring[(i - 1 + L) % L]!, ring[i]!, ring[(i + 1) % L]!),
    );
    const order = Array.from({ length: L }, (_, i) => i).sort((a, b) => scored[b]! - scored[a]! || a - b);
    if (scored[order[0]!]! - scored[order[L - 3]!]! > EPS_EVEN) span = order[0]!;
  } else {
    // RNA clamps span to >= 1 before the operator sees it, which is why
    // `span=0` and `span=1` produce the same mesh (measured).
    span = Math.min(Math.max(Math.trunc(options.span), 1), half - 1);
  }

  // The search walks the shorter way round between the two corners.
  let startEdge = 0;
  if (span > half) {
    span = L - span;
    startEdge = half - span;
  }
  span = Math.max(1, Math.min(span, half - 1));

  const sideLen = half - span;
  const xtot = sideLen + 1;
  const ytot = span + 1;

  // The four runs, laid onto the grid's border. The corner correspondence is
  // the one `bm_grid_fill` asserts: side A is row 0, rail B is the last
  // column, side B is the last row, rail A is column 0.
  const gridAt = (x: number, y: number): number => y * xtot + x;
  const grid: (number | null)[] = Array.from({ length: xtot * ytot }, () => null);
  const ringAt = (i: number): number => ring[((i % L) + L) % L]!;
  for (let x = 0; x < xtot; x++) grid[gridAt(x, 0)] = ringAt(startEdge + span + x);
  for (let y = 0; y < ytot; y++) grid[gridAt(xtot - 1, y)] = ringAt(half + startEdge + y);
  for (let x = 0; x < xtot; x++) grid[gridAt(x, ytot - 1)] = ringAt(half + startEdge + span + (xtot - 1 - x));
  for (let y = 0; y < ytot; y++) grid[gridAt(0, y)] = ringAt(startEdge + span - y);

  const positions = Array.from(P);
  let next = count;
  const corner = (x: number, y: number): Vec3 => {
    const v = grid[gridAt(x, y)];
    if (v === null || v === undefined)
      throw new Error(`gridFill: grid hole at ${x},${y} — this is a bug, not an input`);
    return [positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!];
  };

  if (xtot > 2 && ytot > 2) {
    if (options.interpSimple) {
      for (let y = 1; y < ytot - 1; y++) {
        for (let x = 1; x < xtot - 1; x++) {
          const u = x / (xtot - 1);
          const v = y / (ytot - 1);
          const w = quadWeights(
            [
              [u, 0],
              [0, v],
              [u, 1],
              [1, v],
            ],
            [u, v],
          );
          const co = add(
            add(scale(corner(x, 0), w[0]), scale(corner(0, y), w[1])),
            add(scale(corner(x, ytot - 1), w[2]), scale(corner(xtot - 1, y), w[3])),
          );
          grid[gridAt(x, y)] = next++;
          positions.push(co[0], co[1], co[2]);
        }
      }
    } else {
      const triA = rowFrame(corner(0, 0), corner(xtot - 1, 0), corner(0, 1), corner(xtot - 1, 1), null, null, false);
      const triB = rowFrame(
        corner(0, ytot - 1),
        corner(xtot - 1, ytot - 1),
        corner(0, ytot - 2),
        corner(xtot - 1, ytot - 2),
        null,
        null,
        true,
      );
      for (let y = 1; y < ytot - 1; y++) {
        const triT = rowFrame(
          corner(0, y),
          corner(xtot - 1, y),
          corner(0, y + 1),
          corner(xtot - 1, y + 1),
          corner(0, y - 1),
          corner(xtot - 1, y - 1),
          false,
        );
        for (let x = 1; x < xtot - 1; x++) {
          const coA = transformPointByTri(corner(x, 0), triT, triA);
          const coB = transformPointByTri(corner(x, ytot - 1), triT, triB);
          const t = y / (ytot - 1);
          const co = add(scale(coA, 1 - t), scale(coB, t));
          grid[gridAt(x, y)] = next++;
          positions.push(co[0], co[1], co[2]);
        }
      }
    }
  }

  // The faces on the ring's edges: directed edge "a,b" → the first face that
  // walks it, and how many faces use each edge.
  const faceOn = new Map<string, number>();
  const uses = new Map<string, number>();
  mesh.polys.forEach((p, f) => {
    for (let i = 0; i < p.length; i++) {
      const a = p[i]!;
      const b = p[(i + 1) % p.length]!;
      if (!faceOn.has(`${a},${b}`)) faceOn.set(`${a},${b}`, f);
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      uses.set(k, (uses.get(k) ?? 0) + 1);
    }
  });
  const g = (x: number, y: number): number => grid[gridAt(x, y)]!;

  // `USE_FLIP_DETECT`: each rim edge with one face votes by whether that face
  // runs along the side the way the grid's own edge would.
  let votes = 0;
  const vote = (a: number, b: number, dir: number): void => {
    if (uses.get(a < b ? `${a},${b}` : `${b},${a}`) !== 1) return;
    votes += faceOn.has(`${a},${b}`) ? dir : -dir;
  };
  for (let x = 0; x < xtot - 1; x++) {
    vote(g(x, 0), g(x + 1, 0), -1);
    vote(g(x, ytot - 1), g(x + 1, ytot - 1), 1);
  }
  for (let y = 0; y < ytot - 1; y++) {
    vote(g(0, y), g(0, y + 1), 1);
    vote(g(xtot - 1, y), g(xtot - 1, y + 1), -1);
  }
  const flip = votes < 0;

  const polys = mesh.polys.map((p) => [...p]);
  const faceStart = polys.length;
  for (let x = 0; x < xtot - 1; x++) {
    for (let y = 0; y < ytot - 1; y++) {
      polys.push(
        flip
          ? [g(x, y), g(x, y + 1), g(x + 1, y + 1), g(x + 1, y)]
          : [g(x, y), g(x + 1, y), g(x + 1, y + 1), g(x, y + 1)],
      );
    }
  }

  const out: MeshData = { positions: Float32Array.from(positions), polys };
  Object.assign(out, gridLayers(mesh, polys.length - faceStart, grid as number[], xtot, ytot, count, flip, faceOn, uses));
  if (mesh.creases) out.creases = new Map(mesh.creases);
  if (mesh.seams) out.seams = new Set(mesh.seams);
  if (mesh.edges) {
    // The ring's own edges stop being wire once a face uses them.
    const used = new Set<string>();
    for (let i = 0; i < L; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % L]!;
      used.add(`${Math.min(a, b)}_${Math.max(a, b)}`);
    }
    const kept = mesh.edges.filter((e) => !used.has(`${Math.min(e[0]!, e[1]!)}_${Math.max(e[0]!, e[1]!)}`));
    if (kept.length > 0) out.edges = kept.map((e) => [...e]);
  }
  return out;
}

/** A corner of an old face: [face, corner]. */
type CornerRef = readonly [number, number];
type CornerPair = readonly [CornerRef, CornerRef] | null;

/**
 * The layers of the filled mesh — `bm_grid_fill_array`'s interpolation. The
 * old faces and vertices keep theirs; the `added` new faces follow them, in
 * the order `gridFill` made them.
 */
function gridLayers(
  mesh: MeshData,
  added: number,
  grid: readonly number[],
  xtot: number,
  ytot: number,
  oldCount: number,
  flip: boolean,
  faceOn: ReadonlyMap<string, number>,
  uses: ReadonlyMap<string, number>,
): Partial<MeshData> {
  const XY = (x: number, y: number): number => x + y * xtot;
  const weights: [number, number, number, number][] = [];
  for (let y = 0; y < ytot; y++)
    for (let x = 0; x < xtot; x++) {
      const u = x / (xtot - 1);
      const v = y / (ytot - 1);
      weights.push(quadWeights([[u, 0], [0, v], [u, 1], [1, v]], [u, v]));
    }

  // `bm_loop_pair_from_verts`: the corners at a and b of the edge's first
  // face (`e->l`), or none. Of two faces, the lower-numbered one.
  const pair = (a: number, b: number): CornerPair => {
    if (!uses.get(a < b ? `${a},${b}` : `${b},${a}`)) return null;
    const f = Math.min(faceOn.get(`${a},${b}`) ?? Infinity, faceOn.get(`${b},${a}`) ?? Infinity);
    const p = mesh.polys[f]!;
    return [[f, p.indexOf(a)], [f, p.indexOf(b)]];
  };
  // `bm_loop_pair_test_copy`: a side with no faces borrows the opposite
  // side's pair, swapped end for end — as Blender does.
  const both = (pa: CornerPair, pb: CornerPair): [CornerPair, CornerPair] => {
    if (pa && !pb) return [pa, [pa[1], pa[0]]];
    if (pb && !pa) return [[pb[1], pb[0]], pb];
    return [pa, pb];
  };
  const xa: CornerPair[] = [];
  const xb: CornerPair[] = [];
  for (let x = 0; x < xtot - 1; x++)
    [xa[x], xb[x]] = both(
      pair(grid[XY(x, 0)]!, grid[XY(x + 1, 0)]!),
      pair(grid[XY(x, ytot - 1)]!, grid[XY(x + 1, ytot - 1)]!),
    );
  const ya: CornerPair[] = [];
  const yb: CornerPair[] = [];
  for (let y = 0; y < ytot - 1; y++)
    [ya[y], yb[y]] = both(
      pair(grid[XY(0, y)]!, grid[XY(0, y + 1)]!),
      pair(grid[XY(xtot - 1, y)]!, grid[XY(xtot - 1, y + 1)]!),
    );

  // Per new face, per corner in the face's own order: the weighted old
  // corners, or none for a zero value.
  const corners: [CornerRef, number][][][] = [];
  // The polygon's slot for BL, TL, BR, TR — the order Blender fills them in.
  const slot = flip ? [0, 1, 3, 2] : [0, 3, 1, 2];
  for (let x = 0; x < xtot - 1; x++)
    for (let y = 0; y < ytot - 1; y++) {
      const face: [CornerRef, number][][] = [[], [], [], []];
      const bx = xa[x];
      const by = ya[y];
      if (bx || by) {
        let i = 0;
        for (let xs = 0; xs < 2; xs++)
          for (let ys = 0; ys < 2; ys++) {
            let mix: [CornerRef, number][];
            if (bx && by) {
              const w = weights[XY(x + xs, y + ys)]!;
              mix = [[bx[xs]!, w[0]], [by[ys]!, w[1]], [xb[x]![xs]!, w[2]], [yb[y]![ys]!, w[3]]];
            } else if (bx) {
              const t = (y + ys) / (ytot - 1);
              mix = [[bx[xs]!, 1 - t], [xb[x]![xs]!, t]];
            } else {
              const t = (x + xs) / (xtot - 1);
              mix = [[by![ys]!, 1 - t], [yb[y]![ys]!, t]];
            }
            face[slot[i++]!] = mix;
          }
      }
      corners.push(face);
    }

  const layer = (src: number[][][] | undefined): number[][][] | undefined => {
    if (!src || src.length !== mesh.polys.length) return undefined;
    const width = src.find((f) => f.length > 0)?.[0]?.length ?? 2;
    const out = src.map((f) => f.map((cn) => [...cn]));
    for (let k = 0; k < added; k++)
      out.push(
        corners[k]!.map((mix) => {
          const v = new Array<number>(width).fill(0);
          for (const [[f, i], w] of mix) src[f]![i]!.forEach((x, j) => (v[j] = v[j]! + w * x));
          return v;
        }),
      );
    return out;
  };

  const layers: Partial<MeshData> = {};
  const uvs = layer(mesh.uvs);
  if (uvs) layers.uvs = uvs;
  const colors = layer(mesh.colors);
  if (colors) layers.colors = colors;
  const normals = layer(mesh.normals);
  if (normals) layers.normals = normals;
  if (mesh.materials && mesh.materials.length === mesh.polys.length)
    layers.materials = [...mesh.materials, ...new Array<number>(added).fill(0)];
  if (mesh.sharp) layers.sharp = new Set(mesh.sharp);
  if (mesh.groups) {
    // Each interior vertex mixes its four boundary points' groups —
    // `layerInterp_mdeformvert`: a source counts where its weight times the
    // factor is not zero, and the sum is capped at 1.
    const groups = new Map<string, Map<number, number>>();
    for (const [name, gr] of mesh.groups) {
      const ng = new Map(gr);
      for (let y = 1; y < ytot - 1; y++)
        for (let x = 1; x < xtot - 1; x++) {
          const v = grid[XY(x, y)]!;
          if (v < oldCount) continue;
          const w = weights[XY(x, y)]!;
          const from = [grid[XY(x, 0)]!, grid[XY(0, y)]!, grid[XY(x, ytot - 1)]!, grid[XY(xtot - 1, y)]!];
          let member = false;
          let sum = 0;
          from.forEach((u, i) => {
            const val = gr.get(u);
            if (val !== undefined && val * w[i]! !== 0) {
              member = true;
              sum += val * w[i]!;
            }
          });
          if (member) ng.set(v, Math.min(sum, 1));
        }
      groups.set(name, ng);
    }
    layers.groups = groups;
  }
  return layers;
}

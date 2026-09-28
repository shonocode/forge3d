/**
 * Grid Fill as Blender's operator does it — `MESH_OT_fill_grid`
 * (`editors/mesh/editmesh_tools.cc`) over `bmesh.ops.grid_fill`
 * (`bmesh/operators/bmo_fill_grid.cc`), 5.1.1, ported on `bmesh-lite`.
 *
 * Three routes, chosen by the selection as the operator chooses:
 *
 * - **One closed loop** of selected edges (even length): the prepare pass
 *   (`edbm_fill_grid_prepare`) starts at the sharpest corner, moves `offset`
 *   along, works out `span` from the next corner when it is not given, and
 *   leaves only the two sides tagged — the other two runs become the rails.
 * - **Two open loops**: they go to `grid_fill` as they are; its rails are the
 *   shortest chains of wire or boundary edges joining the loops' ends
 *   (`BM_mesh_edgeloops_find_path`), first to first and last to last, else
 *   crosswise with the second loop turned round. Loops or rails of different
 *   lengths are padded with zero-length edges (`BM_edgeloop_expand`), filled,
 *   and the padding collapsed again (`BM_edge_collapse`) — which is where the
 *   triangles in such a fill come from.
 * - **Faces**: the selection is split off as an island
 *   (`edbm_fill_grid_split_join_init`), its rim is filled — so the grid's
 *   corners are read from the faces being replaced, not from the ones round
 *   the hole — the island is deleted, the grid turned round, and the rim
 *   welded back.
 *
 * Every walk is Blender's: the loops are found in the order of their first
 * edge in the mesh and built from that edge's `v2` outward
 * (`BM_mesh_edgeloops_find`), which decides which side is the grid's first
 * row and which way it runs — and so, on a hole, which rim face a grid corner
 * copies. Interior points use the same frames as `gridFill`
 * (`quad_verts_to_barycentric_tri`, or the mean-value blend with
 * `interpSimple`); faces are wound to agree with the rim (`USE_FLIP_DETECT`)
 * and take material slot 0 (the operator passes the object's active slot).
 */
import type { MeshData } from "../lib/mesh";
import { f } from "./blender-math";
import {
  diskEdges,
  edgeExists,
  edgeloopsFind,
  edgeloopsFindPath,
  edgeKill,
  faceCreate,
  faceCreateVerts,
  faceKill,
  faceLoops,
  isBoundary,
  joinVertKillEdge,
  liveEdges,
  liveFaces,
  loopReverse,
  otherVert,
  radialLoops,
  splitEdgeMakeVert,
  vertCreate,
  vertKill,
  vertSplice,
  edgeSplice,
  type BE,
  type BF,
  type BL,
  type BM,
  type BV,
} from "./bmesh-lite";
import {
  blankLoop,
  copyEdgeData,
  copyLD,
  copyLoop,
  edgeLike,
  interpLoop,
  interpVert,
  load,
  saveMesh,
  vertLike,
  type Carry,
} from "./bmesh-carry";
import { quadWeights, rowFrame, transformPointByTri, type Vec3 } from "./edit-mode/grid-fill";

export interface FillGridOptions {
  /** The selected edges, as vertex pairs: one closed loop, or two open ones. */
  edges?: Iterable<readonly [number, number]>;
  /**
   * The selected faces (face select mode): the selection's rim is refilled
   * with a grid, reading its corners from these faces. Their edges count as
   * selected.
   */
  faces?: Iterable<number>;
  /** Edges per rail for a single closed loop. Left out, it is calculated. Clamped to `[1, L/2 - 1]`. */
  span?: number;
  /** For a single closed loop: move the starting corner this many vertices along. */
  offset?: number;
  /** The flat mean-value blend instead of the curvature-following one (`use_interp_simple`). */
  interpSimple?: boolean;
}

/** Below this, in radians, two corner angles count as the same (`eps_even`). */
const EPS_EVEN = 1e-3;

/**
 * Fill a grid the way Blender's Grid Fill (`bpy.ops.mesh.fill_grid`) does —
 * see the module comment for the three routes. Throws where the operator
 * reports an error and changes nothing.
 */
export function fillGrid(mesh: MeshData, opts: FillGridOptions = {}): MeshData {
  const { bm, c, byInput } = load(mesh);
  const vAt = (i: number): BV => {
    const v = bm.verts[i];
    if (!v) throw new Error(`fillGrid: no vertex ${i}`);
    return v;
  };
  const sel = new Set<BE>();
  const selV = new Set<BV>();
  for (const [a, b] of opts.edges ?? []) {
    const e = edgeExists(vAt(a), vAt(b));
    if (!e) throw new Error(`fillGrid: ${a}–${b} is not an edge`);
    sel.add(e);
    selV.add(e.v1);
    selV.add(e.v2);
  }
  const selF = new Set<BF>();
  for (const i of opts.faces ?? []) {
    const x = byInput.get(i);
    if (!x) throw new Error(`fillGrid: no face ${i}`);
    selF.add(x);
    for (const l of faceLoops(x)) {
      sel.add(l.e!);
      selV.add(l.v);
    }
  }
  if (sel.size === 0) return mesh;
  // Selecting every edge of a face selects the face (the selection flush), and
  // any selected face sends the operator down the face route.
  for (const x of liveFaces(bm)) if (!selF.has(x) && faceLoops(x).every((l) => sel.has(l.e!))) selF.add(x);

  let island: Island | null = null;
  let fillEdges = sel;
  if (selF.size > 0) {
    island = splitIsland(bm, c, selV, sel, selF);
    fillEdges = island.edges;
  }

  const tagged = prepare(bm, fillEdges, opts.offset ?? 0, opts.span);
  const made = gridFillOp(bm, c, tagged, !!opts.interpSimple, !!mesh.groups);

  if (island) joinIsland(bm, c, island, made);
  return saveMesh(bm, c, mesh).mesh;
}

// ── the operator's prepare pass ────────────────────────────────────────────

/** `|π − angle|` at `v` between its two tagged edges (`edbm_fill_grid_vert_tag_angle`). */
function tagAngle(v: BV, tag: Set<BE>): number {
  const pair: BV[] = [];
  for (const e of diskEdges(v)) if (tag.has(e)) pair.push(otherVert(e, v));
  const a: Vec3 = [pair[0]!.co[0]! - v.co[0]!, pair[0]!.co[1]! - v.co[1]!, pair[0]!.co[2]! - v.co[2]!];
  const b: Vec3 = [pair[1]!.co[0]! - v.co[0]!, pair[1]!.co[1]! - v.co[1]!, pair[1]!.co[2]! - v.co[2]!];
  const la = Math.hypot(...a);
  const lb = Math.hypot(...b);
  const d = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb);
  return Math.abs(Math.PI - Math.acos(Math.max(-1, Math.min(1, d))));
}

/** `edbm_fill_grid_prepare`: the edges `grid_fill` is handed. */
function prepare(bm: BM, sel: Set<BE>, offset0: number, span0: number | undefined): Set<BE> {
  const loops = edgeloopsFind(bm, (e) => sel.has(e));
  if (loops.length !== 1) return sel;
  const el = loops[0]!;
  const verts = el.verts;
  const L = verts.length;
  const edgesOf = (vs: BV[]): BE[] => {
    const out: BE[] = [];
    for (let i = 0; i + 1 < vs.length; i++) out.push(edgeExists(vs[i]!, vs[i + 1]!)!);
    if (el.closed) out.push(edgeExists(vs[L - 1]!, vs[0]!)!);
    return out;
  };
  let edges = edgesOf(verts);
  const tag = new Set(edges);
  const spanCalc = span0 === undefined;
  let span = spanCalc ? Math.floor(L / 4) : Math.min(Math.max(1, Math.trunc(span0)), Math.floor(L / 2) - 1);
  const offset = ((offset0 % L) + L) % L;

  if (L % 2 === 0 && el.closed) {
    let best = 0;
    let bestAngle = -1;
    verts.forEach((v, i) => {
      const a = tagAngle(v, tag);
      if (a > bestAngle) {
        bestAngle = a;
        best = i;
      }
    });
    let ring = [...verts.slice(best), ...verts.slice(0, best)];
    if (offset !== 0) ring = [...ring.slice(offset), ...ring.slice(0, offset)];
    edges = edgesOf(ring);
    if (spanCalc) {
      const scored = ring.map((v, i) => ({ i, a: i === 0 || i === L / 2 ? 0 : tagAngle(v, tag) }));
      scored.sort((p, q) => q.a - p.a || p.i - q.i);
      if (scored[0]!.a - scored[L - 3]!.a > EPS_EVEN) span = scored[0]!.i;
    }
    let start = 0;
    if (span > L / 2) {
      span = L - span;
      start = L / 2 - span;
    }
    for (let i = start; i < start + span; i++) {
      tag.delete(edges[i]!);
      tag.delete(edges[L / 2 + i]!);
    }
  }
  return tag;
}

// ── bmesh.ops.grid_fill ────────────────────────────────────────────────────

/** `BLI_FOREACH_SPARSE_RANGE(src, dst, i)`. */
function* sparseRange(src: number, dst: number): Generator<number> {
  const src2 = src * 2;
  const dst2 = dst * 2;
  let error = dst2 - src;
  let i = 0;
  for (;;) {
    const delta = Math.floor(error / dst2);
    i -= delta;
    if (!(i < src)) return;
    yield i;
    error -= delta * dst2 + src2;
  }
}

/**
 * `BM_edge_split(e, v, &e_split, 0)`: a zero-length edge at `v`. The new
 * vertex takes `v`'s data, and each face's new corner the corner at `v`
 * (`BM_data_interp_face_vert_edge` at factor 0).
 */
function splitAt(bm: BM, c: Carry, e: BE, v: BV): { v: BV; e: BE } {
  const vOther = otherVert(e, v);
  const r = splitEdgeMakeVert(bm, v, e);
  copyEdgeData(c, e, r.e);
  c.vd.set(r.v, interpVertPair(c, v, vOther));
  for (const [made] of r.made) {
    // The corner at `v` in this face: before or after the new one.
    const lV = made.prev.v === v ? made.prev : made.next;
    c.ld.set(made, copyLD(c.ld.get(lV)));
  }
  return r;
}
const interpVertPair = (c: Carry, v: BV, vOther: BV) =>
  interpVert([c.vd.get(v) ?? new Map(), c.vd.get(vOther) ?? new Map()], [1, 0]);

/** `BM_edgeloop_expand(…, split = true)` on an open loop. */
function expand(bm: BM, c: Carry, el: BV[], target: number, splits: BE[]): void {
  let swap = true;
  /** `EDGE_SPLIT(node_copy, node_other)`: the copy at `at` becomes the split vertex. */
  const split = (at: number, other: BV): void => {
    const cur = el[at]!;
    const e = edgeExists(cur, other)!;
    const r = splitAt(bm, c, e, swap ? cur : other);
    splits.push(r.e);
    el[at] = r.v;
  };
  const addOne = (i: number): number => {
    // Returns the index of the next original node.
    if (i + 1 < el.length) {
      el.splice(i + 1, 0, el[i]!);
      split(i + 1, el[i + 2]!);
      swap = !swap;
      return i + 2;
    }
    el.splice(i, 0, el[i]!);
    split(i, el[i - 1]!);
    swap = !swap;
    return i + 2;
  };
  while (el.length * 2 < target) {
    let i = 0;
    while (i < el.length) i = addOne(i);
    swap = !swap;
  }
  if (el.length < target) {
    let i = 0;
    let iterPrev = 0;
    for (const iter of [...sparseRange(el.length, target - el.length)]) {
      while (iterPrev < iter) {
        i++;
        iterPrev++;
      }
      // `node_curr` moves on to the next original, which `iter_prev` counts.
      i = addOne(i);
      iterPrev++;
    }
  }
}

type Pair = [BL, BL] | null;

/** `bm_loop_pair_from_verts`: the corners at `a` and `b` of the edge's first face, or none. */
function pairFromVerts(a: BV, b: BV): Pair {
  const e = edgeExists(a, b)!;
  if (!e.l) return null;
  return e.l.v === a ? [e.l, e.l.next] : [e.l.next, e.l];
}
/** `bm_loop_pair_test_copy`. */
function pairTestCopy(pa: Pair, pb: Pair): [Pair, Pair] {
  if (pa && !pb) return [pa, [pa[1], pa[0]]];
  if (pb && !pa) return [[pb[1], pb[0]], pb];
  return [pa, pb];
}

/** `bmo_grid_fill_exec`: returns the faces made (`faces.out`). */
function gridFillOp(bm: BM, c: Carry, tagged: Set<BE>, interpSimple: boolean, hasGroups: boolean): BF[] {
  const loops = edgeloopsFind(bm, (e) => tagged.has(e));
  if (loops.length !== 2)
    throw new Error(
      "fillGrid: Select two edge loops or a single closed edge loop from which two edge loops can be calculated",
    );
  const [la, lb] = loops as [(typeof loops)[0], (typeof loops)[0]];
  if (la.closed || lb.closed) throw new Error("fillGrid: Closed loops unsupported");
  const a = [...la.verts];
  let b = [...lb.verts];

  const hidden = new Set<BE>();
  for (const vs of [a, b]) for (let i = 1; i < vs.length; i++) {
    const e = edgeExists(vs[i]!, vs[i - 1]!);
    if (e) hidden.add(e);
  }
  const railTest = (e: BE): boolean => !hidden.has(e) && (!e.l || isBoundary(e));
  let ra = edgeloopsFindPath(bm, railTest, a[0]!, b[0]!);
  let rb = ra ? edgeloopsFindPath(bm, railTest, a[a.length - 1]!, b[b.length - 1]!) : null;
  if (!ra || !rb) {
    ra = edgeloopsFindPath(bm, railTest, a[0]!, b[b.length - 1]!);
    rb = ra ? edgeloopsFindPath(bm, railTest, a[a.length - 1]!, b[0]!) : null;
    if (ra && rb) b = b.reverse();
    else throw new Error("fillGrid: Loops are not connected by wire/boundary edges");
  }
  const inA = new Set(ra.length <= rb.length ? ra : rb);
  for (const v of ra.length <= rb.length ? rb : ra)
    if (inA.has(v)) throw new Error("fillGrid: Connecting edge loops overlap");

  const splits: BE[] = [];
  const pairs: [BV[], BV[]][] = [
    [a, b],
    [ra, rb],
  ];
  for (const [p, q] of pairs) {
    if (p.length < q.length) expand(bm, c, p, q.length, splits);
    else if (q.length < p.length) expand(bm, c, q, p.length, splits);
  }

  const made = gridFill(bm, c, a, b, ra, rb, interpSimple, hasGroups);

  for (const e of splits) if (e.v1 && bm.edges.items[e.slot] === e) joinVertKillEdge(bm, e, e.v2);
  return made.filter((x) => !!x.first);
}

/** `bm_grid_fill` + `bm_grid_fill_array`. */
function gridFill(
  bm: BM,
  c: Carry,
  a: BV[],
  b: BV[],
  ra: BV[],
  rb: BV[],
  interpSimple: boolean,
  hasGroups: boolean,
): BF[] {
  const xtot = a.length;
  const ytot = ra.length;
  const XY = (x: number, y: number): number => x + y * xtot;
  const grid: (BV | null)[] = new Array(xtot * ytot).fill(null);
  a.forEach((v, i) => (grid[i] = v));
  b.forEach((v, i) => (grid[ytot * xtot + (i - xtot)] = v));
  ra.forEach((v, i) => (grid[xtot * i] = v));
  rb.forEach((v, i) => (grid[xtot * i + (xtot - 1)] = v));

  // `USE_FLIP_DETECT`.
  let votes = 0;
  ([
    [a, -1],
    [b, 1],
    [ra, 1],
    [rb, -1],
  ] as const).forEach(([lst, dir]) => {
    for (let i = 0; i + 1 < lst.length; i++) {
      const e = edgeExists(lst[i]!, lst[i + 1]!);
      if (e && isBoundary(e)) votes += e.l!.v === lst[i] ? dir : -dir;
    }
  });
  const flip = votes < 0;

  const useLoopInterp = c.has.uv || c.has.col;
  const weights: [number, number, number, number][] = [];
  for (let y = 0; y < ytot; y++)
    for (let x = 0; x < xtot; x++) {
      const u = f(f(1 / f(xtot - 1)) * f(x));
      const v = f(f(1 / f(ytot - 1)) * f(y));
      weights.push(quadWeights([[u, 0], [0, v], [u, 1], [1, v]], [u, v]));
    }

  const xa: Pair[] = [];
  const xb: Pair[] = [];
  const ya: Pair[] = [];
  const yb: Pair[] = [];
  if (useLoopInterp) {
    for (let x = 0; x < xtot - 1; x++)
      [xa[x], xb[x]] = pairTestCopy(
        pairFromVerts(grid[XY(x, 0)]!, grid[XY(x + 1, 0)]!),
        pairFromVerts(grid[XY(x, ytot - 1)]!, grid[XY(x + 1, ytot - 1)]!),
      );
    for (let y = 0; y < ytot - 1; y++)
      [ya[y], yb[y]] = pairTestCopy(
        pairFromVerts(grid[XY(0, y)]!, grid[XY(0, y + 1)]!),
        pairFromVerts(grid[XY(xtot - 1, y)]!, grid[XY(xtot - 1, y + 1)]!),
      );
  }

  const co = (v: BV): Vec3 => [v.co[0]!, v.co[1]!, v.co[2]!];
  const at = (x: number, y: number): Vec3 => co(grid[XY(x, y)]!);
  if (xtot > 2 && ytot > 2) {
    const triA = rowFrame(at(0, 0), at(xtot - 1, 0), at(0, 1), at(xtot - 1, 1), null, null, false);
    const triB = rowFrame(at(0, ytot - 1), at(xtot - 1, ytot - 1), at(0, ytot - 2), at(xtot - 1, ytot - 2), null, null, true);
    for (let y = 1; y < ytot - 1; y++) {
      const triT = rowFrame(at(0, y), at(xtot - 1, y), at(0, y + 1), at(xtot - 1, y + 1), at(0, y - 1), at(xtot - 1, y - 1), false);
      for (let x = 1; x < xtot - 1; x++) {
        let p: Vec3;
        if (!interpSimple) {
          const pa = transformPointByTri(at(x, 0), triT, triA);
          const pb = transformPointByTri(at(x, ytot - 1), triT, triB);
          const t = f(y / f(ytot - 1));
          p = [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t];
        } else {
          const w = weights[XY(x, y)]!;
          const src = [at(x, 0), at(0, y), at(x, ytot - 1), at(xtot - 1, y)];
          p = [0, 0, 0];
          src.forEach((s, k) => {
            for (let j = 0; j < 3; j++) p[j] = p[j]! + s[j]! * w[k]!;
          });
        }
        const v = vertCreate(bm, p);
        c.vd.set(
          v,
          hasGroups
            ? interpVert(
                [grid[XY(x, 0)]!, grid[XY(0, y)]!, grid[XY(x, ytot - 1)]!, grid[XY(xtot - 1, y)]!].map(
                  (g) => c.vd.get(g) ?? new Map(),
                ),
                weights[XY(x, y)]!,
              )
            : new Map(),
        );
        grid[XY(x, y)] = v;
      }
    }
  }

  const made: BF[] = [];
  for (let x = 0; x < xtot - 1; x++)
    for (let y = 0; y < ytot - 1; y++) {
      const g = (i: number, j: number): BV => grid[XY(i, j)]!;
      const quad = flip
        ? [g(x, y), g(x, y + 1), g(x + 1, y + 1), g(x + 1, y)]
        : [g(x + 1, y), g(x + 1, y + 1), g(x, y + 1), g(x, y)];
      const fc = faceCreateVerts(bm, quad, null);
      for (const l of faceLoops(fc)) c.ld.set(l, blankLoop(c));
      made.push(fc);
      if (!useLoopInterp || !(xa[x] || ya[y])) continue;
      const mode = xa[x] && ya[y] ? "B" : xa[x] ? "X" : "Y";
      fc.no = [...(mode === "Y" ? ya[y]! : xa[x]!)[0].f.no];
      const ls = faceLoops(fc);
      const lq: BL[] = flip ? [ls[0]!, ls[1]!, ls[3]!, ls[2]!] : [ls[3]!, ls[2]!, ls[0]!, ls[1]!];
      let i = 0;
      for (let xs = 0; xs < 2; xs++)
        for (let ys = 0; ys < 2; ys++) {
          const dst = c.ld.get(lq[i]!)!;
          if (mode === "B") {
            const bound = [xa[x]![xs]!, ya[y]![ys]!, xb[x]![xs]!, yb[y]![ys]!];
            interpLoop(bound.map((l) => c.ld.get(l) ?? {}), weights[XY(x + xs, y + ys)]!, dst);
          } else if (mode === "X") {
            const t = f(f(y + ys) / f(ytot - 1));
            interpLoop([c.ld.get(xa[x]![xs]!) ?? {}, c.ld.get(xb[x]![xs]!) ?? {}], [f(1 - t), t], dst);
          } else {
            const t = f(f(x + xs) / f(xtot - 1));
            interpLoop([c.ld.get(ya[y]![ys]!) ?? {}, c.ld.get(yb[y]![ys]!) ?? {}], [f(1 - t), t], dst);
          }
          i++;
        }
    }
  return made;
}

// ── the face route: split off, fill, join back ─────────────────────────────

interface Island {
  faces: Set<BF>;
  /** The island's rim edges, the ones the fill is handed. */
  edges: Set<BE>;
  /** Hole vertex → island vertex, for the weld at the end. */
  weld: Map<BV, BV>;
}

/**
 * `bmesh.ops.split` over the selection (`bmo_mesh_copy` then a `DEL_FACES`
 * delete of the input), and the switch of the selection from the hole's rim
 * to the island's (`edbm_fill_grid_split_join_init`).
 */
function splitIsland(bm: BM, c: Carry, selV: Set<BV>, selE: Set<BE>, selF: Set<BF>): Island {
  const vmap = new Map<BV, BV>();
  const emap = new Map<BE, BE>();
  const boundary: [BE, BE][] = [];
  const copyVert = (v: BV): void => {
    if (!vmap.has(v)) vmap.set(v, vertLike(c, bm, v));
  };
  const copyEdge = (e: BE): void => {
    if (emap.has(e)) return;
    let rlen = 0;
    for (const l of radialLoops(e)) if (selF.has(l.f)) rlen++;
    const e2 = edgeLike(c, bm, vmap.get(e.v1)!, vmap.get(e.v2)!, e);
    e2.tag = false;
    emap.set(e, e2);
    if (rlen < 2) boundary.push([e, e2]);
  };
  for (const v of [...bm.verts]) if (v && selV.has(v)) copyVert(v);
  for (const e of liveEdges(bm))
    if (selE.has(e)) {
      copyVert(e.v1);
      copyVert(e.v2);
      copyEdge(e);
    }
  const faces = new Set<BF>();
  for (const x of liveFaces(bm)) {
    if (!selF.has(x)) continue;
    const ls = faceLoops(x);
    for (const l of ls) copyVert(l.v);
    for (const l of ls) copyEdge(l.e!);
    const x2 = faceCreate(
      bm,
      ls.map((l) => vmap.get(l.v)!),
      ls.map((l) => emap.get(l.e!)!),
      x,
    );
    faceLoops(x2).forEach((l, k) => copyLoop(c, ls[k]!, l));
    faces.add(x2);
  }

  // `DEL_FACES` over the input: its faces, and its edges and vertices that
  // nothing kept uses.
  const delV = new Set(selV);
  const delE = new Set(selE);
  for (const x of liveFaces(bm))
    if (selF.has(x))
      for (const l of faceLoops(x)) {
        delV.add(l.v);
        delE.add(l.e!);
      }
  for (const x of liveFaces(bm))
    if (!selF.has(x))
      for (const l of faceLoops(x)) {
        delV.delete(l.v);
        delE.delete(l.e!);
      }
  for (const e of liveEdges(bm))
    if (!delE.has(e)) {
      delV.delete(e.v1);
      delV.delete(e.v2);
    }
  for (const x of liveFaces(bm)) if (selF.has(x)) faceKill(bm, x);
  for (const e of liveEdges(bm)) if (delE.has(e)) edgeKill(bm, e);
  for (const v of [...bm.verts]) if (v && delV.has(v) && !v.e) vertKill(bm, v);

  const live = new Set(liveEdges(bm));
  const edges = new Set<BE>();
  const weld = new Map<BV, BV>();
  const vSel = new Set(selV);
  for (const [e, e2] of boundary) {
    edges.add(e2);
    if (!live.has(e)) continue;
    for (const [v, v2] of [
      [e.v1, e2.v1],
      [e.v2, e2.v2],
    ] as const)
      if (vSel.has(v)) {
        vSel.delete(v);
        weld.set(v, v2);
      }
  }
  return { faces, edges, weld };
}

/**
 * `edbm_fill_grid_split_join_finish`: delete the island's faces (and what
 * only they used), turn the grid round — it was filled from the island's
 * side — and weld the hole's rim onto the island's.
 */
function joinIsland(bm: BM, c: Carry, island: Island, made: BF[]): void {
  const delE = new Set<BE>();
  const delV = new Set<BV>();
  for (const x of island.faces)
    for (const l of faceLoops(x)) {
      delE.add(l.e!);
      delV.add(l.v);
    }
  for (const x of liveFaces(bm))
    if (!island.faces.has(x))
      for (const l of faceLoops(x)) {
        delE.delete(l.e!);
        delV.delete(l.v);
      }
  for (const e of liveEdges(bm))
    if (!delE.has(e)) {
      delV.delete(e.v1);
      delV.delete(e.v2);
    }
  for (const x of liveFaces(bm)) if (island.faces.has(x)) faceKill(bm, x);
  for (const e of liveEdges(bm)) if (delE.has(e)) edgeKill(bm, e);
  for (const v of [...bm.verts]) if (v && delV.has(v) && !v.e) vertKill(bm, v);

  for (const x of made)
    if (x.first) {
      loopReverse(x);
      x.no = [-x.no[0]!, -x.no[1]!, -x.no[2]!];
    }

  // `weld_verts`: each hole vertex into its island vertex, and the two copies
  // of each rim edge into one.
  for (const [hole, isl] of island.weld) {
    if (!bm.verts[hole.index] || bm.verts[hole.index] !== hole) continue;
    vertSplice(bm, isl, hole);
    c.vd.delete(hole);
    const seen = new Map<BV, BE>();
    for (const e of diskEdges(isl)) {
      const o = otherVert(e, isl);
      const prev = seen.get(o);
      if (prev) edgeSplice(bm, prev, e);
      else seen.set(o, e);
    }
  }
}

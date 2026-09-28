/**
 * Connecting vertices across faces — Blender's `bmesh.ops.connect_vert_pair`
 * (`bmesh/operators/bmo_connect_pair.cc`), the `connect_verts` it finishes
 * with (`bmo_connect.cc`), and the J key, `MESH_OT_vert_connect_path`
 * (`editors/mesh/editmesh_tools.cc`), all of Blender 5.1.1.
 *
 * The pair search, as the C describes it: build a plane through both
 * vertices that holds their (averaged) normals, walk the surface from the
 * first vertex along that plane — crossing edges, passing through vertices
 * that lie on it — with a heap of partial paths ordered by length, and stop
 * at the first path that reaches the second vertex. Each crossed edge is
 * split where the plane meets it, and `connect_verts` joins the cut points
 * face by face.
 *
 * The walk reads the mesh in BMesh's own iteration orders (`bmesh-lite`), so
 * which of two equally good branches claims an element first is Blender's.
 * Exact ties in the heap are not imitated (`BLI_heapsimple` against the
 * `BLI_heap` port here).
 */
import { meshVertNormals, f, sub, dot, cross, normalizeInPlace, newell, faceNormalCalc, FLT_EPSILON, heapInsert, heapPopMin, type Heap, type V3 } from "../blender-math";
import { bmFromMesh, diskEdges, radialLoops, loopsOfVert, otherVert, type BV, type BE, type BL, type BF } from "../bmesh-lite";
import { rebuildPolygons, seamKey, toPolygons, type EditMesh, type VertexOrigin } from "./half-edge";
import { carryEdgeFlags } from "./refine";

const CONNECT_EPS = f(0.0001);

// ── the path search (bmo_connect_pair.cc) ──────────────────────────────────

type Ele = { kind: "v"; v: BV } | { kind: "e"; e: BE };

interface PathLink {
  next: PathLink | null;
  ele: Ele;
  from: BE | BF | null;
}

interface PathState {
  last: PathLink | null;
  dist: number;
  coPrev: V3;
}

/** A step of the found path: a vertex it passes through, or an edge it cuts at `fac` from `v1`. */
export type PathStep = { kind: "v"; v: number } | { kind: "e"; v1: number; v2: number; fac: number };

interface Ctx {
  axis: V3;
  sep: number;
  touched: Set<BV | BE>;
  heap: Heap<PathState>;
}

const madd = (a: V3, b: V3, t: number): V3 => [f(a[0]! + f(b[0]! * t)), f(a[1]! + f(b[1]! * t)), f(a[2]! + f(b[2]! * t))];
/** `project_plane_normalized_v3_v3v3`: `p - v · dot(p, v)`. */
const projectPlane = (p: V3, v: V3): V3 => madd(p, v, f(-dot(p, v)));
/** `interp_v3_v3v3`. */
const interp = (a: V3, b: V3, t: number): V3 => {
  const s = f(1 - t);
  return [f(f(s * a[0]!) + f(t * b[0]!)), f(f(s * a[1]!) + f(t * b[1]!)), f(f(s * a[2]!) + f(t * b[2]!))];
};
const lenV3 = (a: V3, b: V3): number => {
  const d = sub(a, b);
  return f(Math.sqrt(dot(d, d)));
};

/** `ortho_v3_v3`. */
function ortho(v: V3): V3 {
  const x = Math.abs(v[0]!);
  const y = Math.abs(v[1]!);
  const z = Math.abs(v[2]!);
  const axis = x > y ? (x > z ? 0 : 2) : y > z ? 1 : 2;
  if (axis === 0) return [f(-v[1]! - v[2]!), v[0]!, v[0]!];
  if (axis === 1) return [v[1]!, f(-v[0]! - v[2]!), v[1]!];
  return [v[2]!, v[2]!, f(-v[0]! - v[1]!)];
}

/**
 * `bm_vert_pair_to_matrix`, reduced to the one row the search reads: the
 * plane's normal (`dot_m3_v3_row_x` of the inverted orthonormal basis is the
 * dot with its first axis).
 */
function pairPlaneNormal(a: BV, b: BV): V3 {
  const eps = 1e-8;
  const dir = sub(a.co, b.co);
  normalizeInPlace(dir);
  const na = projectPlane(a.no, dir);
  let nb = projectPlane(b.no, dir);
  // Normals of flipped faces point apart; turn one round before adding.
  if (dot(na, nb) < 0) nb = [f(-nb[0]!), f(-nb[1]!), f(-nb[2]!)];
  let nor: V3 = [f(na[0]! + nb[0]!), f(na[1]! + nb[1]!), f(na[2]! + nb[2]!)];
  normalizeInPlace(nor);
  let tmp = cross(dir, nor);
  if (normalizeInPlace(tmp) < eps) {
    // Vertex normals along the line (a cube's opposite corners): take, at
    // each end, the direction on a face nearest the line, and the better one.
    const best = [a, b].map((v) => {
      let nor2: V3 = [0, 0, 0];
      let cos = -3.4028234663852886e38;
      for (const l of loopsOfVert(v)) {
        const proj = projectPlane(dir, l.f.no);
        if (normalizeInPlace(proj) > eps) {
          const c = dot(proj, dir);
          if (c > cos) {
            cos = c;
            nor2 = proj;
          }
        }
      }
      return { nor: nor2, cos };
    });
    nor = projectPlane(best[best[0]!.cos < best[1]!.cos ? 1 : 0]!.nor, dir);
    tmp = cross(dir, nor);
    if (normalizeInPlace(tmp) < eps) {
      nor = ortho(dir);
      normalizeInPlace(nor);
      tmp = cross(dir, nor);
      normalizeInPlace(tmp);
    }
  }
  return tmp;
}

const side = (c: Ctx, co: V3): number => f(dot(c.axis, co) - c.sep);

function isectPair(c: Ctx, a: V3, b: V3): boolean {
  const da = side(c, a);
  const db = side(c, b);
  const ta = Math.abs(da) < CONNECT_EPS ? 0 : da < 0 ? -1 : 1;
  const tb = Math.abs(db) < CONNECT_EPS ? 0 : db < 0 ? -1 : 1;
  return ta !== 0 && tb !== 0 && ta !== tb;
}
const isectExact = (c: Ctx, co: V3): boolean => Math.abs(side(c, co)) <= CONNECT_EPS;
function pairFac(c: Ctx, a: V3, b: V3): number {
  const da = Math.abs(side(c, a));
  const db = Math.abs(side(c, b));
  const tot = f(da + db);
  return tot > FLT_EPSILON ? f(da / tot) : 0.5;
}

function linkAdd(c: Ctx, s: PathState, ele: Ele, from: BE | BF | null): void {
  c.touched.add(ele.kind === "v" ? ele.v : ele.e);
  const co = ele.kind === "v" ? ele.v.co : interp(ele.e.v1.co, ele.e.v2.co, pairFac(c, ele.e.v1.co, ele.e.v2.co));
  if (from) s.dist = f(s.dist + lenV3(s.coPrev, co));
  s.coPrev = co;
  s.last = { next: s.last, ele, from };
}

/** `state_link_add_test`: the first branch extends the state, every later one is a copy of it as it was. */
function linkAddTest(c: Ctx, s: PathState, orig: PathState, ele: Ele, from: BE | BF): PathState {
  const isNew = orig.last !== s.last;
  if (isNew) s = { last: orig.last, dist: orig.dist, coPrev: orig.coPrev };
  linkAdd(c, s, ele, from);
  if (isNew) heapInsert(c.heap, s.dist, s);
  return s;
}

/** `MinDistDir`: the nearest hit on each side of the first one. */
interface MinDistDir {
  min: [number, number];
  dir: V3 | null;
}
function minDirTest(m: MinDistDir, d: V3, dsq: number): number {
  if (m.dir === null) return 0;
  if (dot(d, m.dir) > 0) {
    if (dsq < m.min[0]) return 0;
  } else if (dsq < m.min[1]) return 1;
  return -1;
}

function stepFaceEdges(c: Ctx, s: PathState, orig: PathState, from: BL, last: BL, m: MinDistDir): PathState {
  const best: (BL | null)[] = [null, null];
  let l = from;
  do {
    if (isectPair(c, l.v.co, l.next.v.co)) {
      const co = interp(l.v.co, l.next.v.co, pairFac(c, l.v.co, l.next.v.co));
      const d = sub(co, orig.coPrev);
      const dsq = dot(d, d);
      const i = minDirTest(m, d, dsq);
      if (i !== -1 && !c.touched.has(l.e!)) {
        if (m.dir === null) m.dir = d;
        m.min[i] = dsq;
        best[i] = l;
      }
    }
  } while ((l = l.next) !== last);
  for (const b of best) if (b) s = linkAddTest(c, s, orig, { kind: "e", e: b.e! }, b.f);
  return s;
}

function stepFaceVerts(c: Ctx, s: PathState, orig: PathState, from: BL, last: BL, m: MinDistDir): PathState {
  const best: (BL | null)[] = [null, null];
  let l = from;
  do {
    if (isectExact(c, l.v.co)) {
      const d = sub(l.v.co, orig.coPrev);
      const dsq = dot(d, d);
      const i = minDirTest(m, d, dsq);
      if (i !== -1 && !c.touched.has(l.v)) {
        if (m.dir === null) m.dir = d;
        m.min[i] = dsq;
        best[i] = l;
      }
    }
  } while ((l = l.next) !== last);
  for (const b of best) if (b) s = linkAddTest(c, s, orig, { kind: "v", v: b.v }, b.f);
  return s;
}

/** `state_step`. True when the state went anywhere. */
function stateStep(c: Ctx, s: PathState): boolean {
  const orig: PathState = { last: s.last, dist: s.dist, coPrev: s.coPrev };
  const { ele, from } = s.last!;
  const newM = (): MinDistDir => ({ min: [3.4028234663852886e38, 3.4028234663852886e38], dir: null });
  if (ele.kind === "e") {
    for (const l of radialLoops(ele.e)) {
      if (l.f === from) continue;
      const m = newM();
      s = stepFaceEdges(c, s, orig, l.next, l, m);
      s = stepFaceVerts(c, s, orig, l.next.next, l, m);
    }
  } else {
    const v = ele.v;
    for (const l of loopsOfVert(v)) {
      if (l.f === from) continue;
      const m = newM();
      s = stepFaceEdges(c, s, orig, l.next, l.prev, m);
      // Neighbours along an edge are the loop below's.
      if (l.f.len > 3) s = stepFaceVerts(c, s, orig, l.next.next, l.prev, m);
    }
    for (const e of diskEdges(v)) {
      const o = otherVert(e, v);
      if (e !== from && isectExact(c, o.co) && !c.touched.has(o)) s = linkAddTest(c, s, orig, { kind: "v", v: o }, e);
    }
  }
  return orig.last !== s.last;
}

/**
 * The path `connect_vert_pair` would cut from `a` to `b`, or `null` when the
 * walk runs out before reaching `b` (Blender then changes nothing).
 * `vertNormals` stands in for the BMesh's vertex normals; the default is the
 * Mesh's (`bm.from_mesh` copies them).
 */
export function findConnectPath(
  polys: readonly (readonly number[])[],
  positions: ArrayLike<number>,
  a: number,
  b: number,
  vertNormals?: readonly V3[],
): PathStep[] | null {
  const P: V3[] = [];
  for (let i = 0; i < positions.length / 3; i++) P.push([f(positions[i * 3]!), f(positions[i * 3 + 1]!), f(positions[i * 3 + 2]!)]);
  const no = vertNormals ?? meshVertNormals(P, polys);
  const bm = bmFromMesh({ positions: Float32Array.from(positions), polys: polys.map((p) => [...p]) } as never, { vertNormals: no.map((n) => [...n]) });
  const va = bm.verts[a]!;
  const vb = bm.verts[b]!;
  const axis = pairPlaneNormal(va, vb);
  const c: Ctx = { axis, sep: dot(axis, va.co), touched: new Set(), heap: { tree: [] } };

  const first: PathState = { last: null, dist: 0, coPrev: [0, 0, 0] };
  linkAdd(c, first, { kind: "v", v: va }, null);
  heapInsert(c.heap, first.dist, first);
  let best: PathState | null = null;
  while (c.heap.tree.length) {
    const s = heapPopMin(c.heap);
    const ele = s.last!.ele;
    if (ele.kind === "v" && ele.v === vb) {
      best = s;
      break;
    }
    if (stateStep(c, s)) heapInsert(c.heap, s.dist, s);
  }
  if (!best) return null;

  const out: PathStep[] = [];
  for (let l = best.last; l; l = l.next) {
    if (l.ele.kind === "v") out.push({ kind: "v", v: l.ele.v.index });
    else {
      const e = l.ele.e;
      out.push({ kind: "e", v1: e.v1.index, v2: e.v2.index, fac: pairFac(c, e.v1.co, e.v2.co) });
    }
  }
  return out;
}

// ── connect_verts (bmo_connect.cc) ─────────────────────────────────────────

const angleSignedPos = (a: [number, number], b: [number, number]): number => {
  const perp = f(f(a[1] * b[0]) - f(a[0] * b[1]));
  const ang = f(Math.atan2(perp, f(f(a[0] * b[0]) + f(a[1] * b[1]))));
  return ang < 0 ? f(ang + Math.PI * 2) : ang;
};
const norm2 = (x: number, y: number): [number, number] => {
  const l = f(Math.sqrt(f(f(x * x) + f(y * y))));
  return l > 0 ? [f(x / l), f(y / l)] : [0, 0];
};

/** `isect_seg_seg_v2 == ISECT_LINE_LINE_CROSS`. */
function segCross(v1: number[], v2: number[], v3: number[], v4: number[]): boolean {
  const div = f(f(f(v2[0]! - v1[0]!) * f(v4[1]! - v3[1]!)) - f(f(v2[1]! - v1[1]!) * f(v4[0]! - v3[0]!)));
  if (div === 0) return false;
  const lambda = f(f(f(f(v1[1]! - v3[1]!) * f(v4[0]! - v3[0]!)) - f(f(v1[0]! - v3[0]!) * f(v4[1]! - v3[1]!))) / div);
  const mu = f(f(f(f(v1[1]! - v3[1]!) * f(v2[0]! - v1[0]!)) - f(f(v1[0]! - v3[0]!) * f(v2[1]! - v1[1]!))) / div);
  if (lambda >= 0 && lambda <= 1 && mu >= 0 && mu <= 1) return !(lambda === 0 || lambda === 1 || mu === 0 || mu === 1);
  return false;
}

/**
 * `BM_face_splits_check_legal`: drop (set to null) the cuts that leave the
 * face in its own projection — a corner whose cut leaves outside its
 * interior angle, a cut crossing one of the face's edges, and the later of
 * two cuts crossing each other. A convex face keeps every cut.
 */
function splitsCheckLegal(P: readonly V3[], face: readonly number[], no: V3, cuts: ([number, number] | null)[]): void {
  // `axis_dominant_v3_to_m3`: `ortho_basis_v3v3_v3`, then the rows as axes.
  let n1: V3;
  let n2: V3;
  const len2 = f(f(no[0]! * no[0]!) + f(no[1]! * no[1]!));
  if (len2 > FLT_EPSILON) {
    const d = f(1 / f(Math.sqrt(len2)));
    n1 = [f(no[1]! * d), f(-no[0]! * d), 0];
    n2 = [f(-no[2]! * n1[1]!), f(no[2]! * n1[0]!), f(f(no[0]! * n1[1]!) - f(no[1]! * n1[0]!))];
  } else {
    n1 = [no[2]! < 0 ? -1 : 1, 0, 0];
    n2 = [0, 1, 0];
  }
  const n = face.length;
  const pv = face.map((v) => [dot(n1, P[v]!), dot(n2, P[v]!)]);
  // `is_poly_convex_v2`
  {
    let flag = 0;
    let prev = pv[n - 1]!;
    let dirPrev = [f(pv[n - 2]![0]! - prev[0]!), f(pv[n - 2]![1]! - prev[1]!)];
    let convex = true;
    for (let i = 0; i < n; i++) {
      const cur = pv[i]!;
      const dirCur = [f(prev[0]! - cur[0]!), f(prev[1]! - cur[1]!)];
      const cr = f(f(dirPrev[0]! * dirCur[1]!) - f(dirPrev[1]! * dirCur[0]!));
      if (cr < 0) flag |= 1;
      else if (cr > 0) flag |= 2;
      if (flag === 3) {
        convex = false;
        break;
      }
      dirPrev = dirCur;
      prev = cur;
    }
    if (convex) return;
  }
  let cx = 0;
  let cy = 0;
  for (const p of pv) {
    cx = f(cx + p[0]!);
    cy = f(cy + p[1]!);
  }
  const inv = f(1 / n);
  cx = f(cx * inv);
  cy = f(cy * inv);
  for (const p of pv) {
    p[0] = f(p[0]! - cx);
    p[1] = f(p[1]! - cy);
  }
  const eq = (a: number[], b: number[]): boolean => a[0] === b[0] && a[1] === b[1];
  const edgeverts = cuts.map((cut) => (cut ? [pv[cut[0]]!, pv[cut[1]]!] : null));

  for (let i = 0; i < cuts.length; i++) {
    const cut = cuts[i];
    if (!cut) continue;
    const co0 = pv[cut[0]]!;
    const co1 = pv[cut[1]]!;
    if (eq(co0, co1)) continue;
    const dir = norm2(f(co1[0]! - co0[0]!), f(co1[1]! - co0[1]!));
    for (const s of [0, 1]) {
      const at = cut[s]!;
      const co = pv[at]!;
      let ip = (at - 1 + n) % n;
      let inx = (at + 1) % n;
      let limit = n - 3;
      while (eq(co, pv[ip]!) && limit-- > 0) ip = (ip - 1 + n) % n;
      limit = n - 3;
      while (eq(co, pv[inx]!) && limit-- > 0) inx = (inx + 1) % n;
      const other: [number, number] = s === 0 ? dir : [f(-dir[0]), f(-dir[1])];
      const dp = norm2(f(pv[ip]![0]! - co[0]!), f(pv[ip]![1]! - co[1]!));
      const dn = norm2(f(pv[inx]![0]! - co[0]!), f(pv[inx]![1]! - co[1]!));
      if (angleSignedPos(dp, other) > angleSignedPos(dp, dn)) {
        cuts[i] = null;
        break;
      }
    }
  }
  const shares = (a: number[][], b: number[][]): boolean => a[0] === b[0] || a[0] === b[1] || a[1] === b[0] || a[1] === b[1];
  for (let i = 0, ip = n - 1; i < n; ip = i++) {
    const fe = [pv[ip]!, pv[i]!];
    for (let j = 0; j < cuts.length; j++)
      if (cuts[j] && !shares(fe, edgeverts[j]!) && segCross(fe[0]!, fe[1]!, edgeverts[j]![0]!, edgeverts[j]![1]!)) cuts[j] = null;
  }
  for (let i = 0; i < cuts.length; i++) {
    if (!cuts[i]) continue;
    for (let j = i + 1; j < cuts.length; j++)
      if (cuts[j] && !shares(edgeverts[i]!, edgeverts[j]!) && segCross(edgeverts[i]![0]!, edgeverts[i]![1]!, edgeverts[j]![0]!, edgeverts[j]![1]!)) {
        cuts[i] = null;
        break;
      }
  }
}

/** `BM_face_calc_normal_subset` from corner `i` to corner `j`, and its length. */
function subsetNormal(P: readonly V3[], face: readonly number[], i: number, j: number): [V3, number] {
  const ring: V3[] = [];
  for (let k = i; ; k = (k + 1) % face.length) {
    ring.push(P[face[k]!]!);
    if (k === j) break;
  }
  // Newell starts from (last, first), which `newell` does too.
  const nrm = newell(ring);
  const len = normalizeInPlace(nrm);
  return [nrm, len];
}

/**
 * `BM_vert_pair_share_face_by_angle(allow_adjacent = false)`: of the faces
 * holding both vertices apart, the one whose two halves are closest to
 * coplanar. Faces are tried in `order`.
 */
function shareFaceByAngle(P: readonly V3[], polys: readonly (readonly number[])[], order: readonly number[], a: number, b: number): number {
  let cur = -1;
  let best = -1;
  let curIa = -1;
  let curIb = -1;
  const splitDot = (fi: number, ia: number, ib: number): number => {
    const [n0, l0] = subsetNormal(P, polys[fi]!, ia, ib);
    if (l0 === 0) return -1;
    const [n1, l1] = subsetNormal(P, polys[fi]!, ib, ia);
    if (l1 === 0) return -1;
    return dot(n0, n1);
  };
  for (const fi of order) {
    const p = polys[fi]!;
    const ia = p.indexOf(a);
    const ib = p.indexOf(b);
    if (ia < 0 || ib < 0) continue;
    const gap = Math.abs(ia - ib);
    if (gap === 1 || gap === p.length - 1) continue;
    if (cur < 0) {
      cur = fi;
      curIa = ia;
      curIb = ib;
      continue;
    }
    if (best === -1) best = splitDot(cur, curIa, curIb);
    const d = splitDot(fi, ia, ib);
    if (d > best) {
      best = d;
      cur = fi;
      curIa = ia;
      curIb = ib;
    }
  }
  return cur;
}

/**
 * `bmo_connect_verts_exec` on polygons: split every face (of more than three
 * corners) between the input vertices in it. Returns the faces made — the
 * pieces of every face that was cut, the piece that keeps the face's slot
 * first — and whether a split failed (Blender's "Could not connect
 * vertices"). A failed face keeps the splits made before the failure and the
 * other faces are still cut, as `bm_face_connect_verts` leaves them.
 *
 * `checkDegenerate` is the slot of that name: true tests each cut with
 * `BM_face_splits_check_legal`, false keeps a cut only in the face
 * `BM_vert_pair_share_face_by_angle` would pick for the pair, trying the
 * faces round the pair's first vertex in `loopOrder` (`BM_LOOPS_OF_VERT`;
 * index order when absent).
 */
export function connectVertsPolys(
  P: readonly V3[],
  polys: number[][],
  input: ReadonlySet<number>,
  checkDegenerate: boolean,
  loopOrder?: (v: number) => readonly number[],
): { made: Set<number>; failed: boolean } {
  // Faces in the order the op pushes them on its stack (input vertices in
  // index order, faces round each), popped last first.
  const facesOf = new Map<number, number[]>();
  polys.forEach((p, fi) => {
    for (const v of p) {
      const l = facesOf.get(v);
      if (!l) facesOf.set(v, [fi]);
      else if (l[l.length - 1] !== fi) l.push(fi);
    }
  });
  const stack: number[] = [];
  const seen = new Set<number>();
  for (const v of [...input].sort((x, y) => x - y))
    for (const fi of facesOf.get(v) ?? [])
      if (!seen.has(fi)) {
        seen.add(fi);
        if (polys[fi]!.length > 3) stack.push(fi);
      }

  const made = new Set<number>();
  let failed = false;
  const created = new Set<string>();
  const normals = polys.map((p) => faceNormalCalc(P, p));

  while (stack.length) {
    const fi = stack.pop()!;
    const face = polys[fi]!;
    const n = face.length;
    const inp = (i: number): boolean => input.has(face[(i + n) % n]!);
    const adjacent = (i: number, j: number): boolean => (i + 1) % n === j || (j + 1) % n === i;
    const cuts: ([number, number] | null)[] = [];
    let first = -1;
    let prev = -1;
    for (let i = 0; i < n; i++) {
      if (!inp(i) || (inp(i - 1) && inp(i + 1))) continue;
      if (prev < 0) {
        first = prev = i;
        continue;
      }
      // An edge this op already made between them (`EDGE_OUT`) is not made twice.
      if (!adjacent(prev, i) && !created.has(seamKey(face[prev]!, face[i]!))) cuts.push([prev, i]);
      prev = i;
    }
    if (cuts.length === 0) continue;
    if (!adjacent(first, prev) && !(cuts[0]![0] === first && cuts[0]![1] === prev)) cuts.push([first, prev]);

    if (checkDegenerate) splitsCheckLegal(P, face, normals[fi]!, cuts);
    else
      for (let i = 0; i < cuts.length; i++) {
        const [x, y] = cuts[i]!;
        const order = loopOrder ? loopOrder(face[x]!) : (facesOf.get(face[x]!) ?? []);
        if (shareFaceByAngle(P, polys, order, face[x]!, face[y]!) !== fi) cuts[i] = null;
      }
    const pairs = cuts.filter((c): c is [number, number] => !!c).map(([x, y]) => [face[x]!, face[y]!] as const);
    if (pairs.length === 0) continue;

    // `BM_face_split` keeps the arc a → b in the face and gives the new face
    // b → a, which the next cut is made in.
    let cur = [...face];
    const pieces: number[][] = [];
    for (const [a, b] of pairs) {
      const ia = cur.indexOf(a);
      const ib = cur.indexOf(b);
      const m = cur.length;
      if (ia < 0 || ib < 0 || (ia + 1) % m === ib || (ib + 1) % m === ia) {
        failed = true;
        break;
      }
      const keep: number[] = [];
      for (let k = ia; ; k = (k + 1) % m) {
        keep.push(cur[k]!);
        if (k === ib) break;
      }
      const next: number[] = [];
      for (let k = ib; ; k = (k + 1) % m) {
        next.push(cur[k]!);
        if (k === ia) break;
      }
      pieces.push(keep);
      created.add(seamKey(a, b));
      cur = next;
    }
    pieces.push(cur);
    if (pieces.length === 1) continue;
    polys[fi] = pieces[0]!;
    made.add(fi);
    for (let k = 1; k < pieces.length; k++) {
      made.add(polys.length);
      normals.push(normals[fi]!);
      polys.push(pieces[k]!);
    }
  }
  return { made, failed };
}

// ── the operators ──────────────────────────────────────────────────────────

const positionsV3 = (em: EditMesh): V3[] => {
  const out: V3[] = [];
  for (let i = 0; i < em.positions.length / 3; i++) out.push([em.positions[i * 3]!, em.positions[i * 3 + 1]!, em.positions[i * 3 + 2]!]);
  return out;
};

/**
 * One `connect_vert_pair` on `em`. Returns the faces made, or an empty set
 * when there is no path (nothing changes).
 *
 * When `connect_verts` fails partway: `"op"` throws before touching the mesh
 * (`bmesh.ops` raises), `"edbm"` does too (the J key restores its backup),
 * and `"path"` keeps what was cut and carries on — `bm_vert_connect_pair`
 * never looks at the error. `"edbm"` and `"path"` carry custom normals as
 * vectors, as the editor does.
 */
function connectPairOnce(em: EditMesh, a: number, b: number, mode: "op" | "edbm" | "path", vertNormals?: readonly V3[]): Set<number> {
  const polys = toPolygons(em).map((p) => [...p]);
  const path = findConnectPath(polys, em.positions, a, b, vertNormals);
  if (!path) return new Set();

  const positions = Array.from(em.positions);
  const origins = new Map<number, VertexOrigin>();
  const splits: [number, number, number][] = [];
  const out = new Set<number>([a, b]);
  for (const step of path) {
    if (step.kind === "v") {
      out.add(step.v);
      continue;
    }
    // `BM_edge_split(e, e->v1, fac)`, into every face on the edge.
    const { v1, v2, fac } = step;
    const nv = positions.length / 3;
    const p1: V3 = [f(positions[v1 * 3]!), f(positions[v1 * 3 + 1]!), f(positions[v1 * 3 + 2]!)];
    const p2: V3 = [f(positions[v2 * 3]!), f(positions[v2 * 3 + 1]!), f(positions[v2 * 3 + 2]!)];
    // `v + (v_other - v) * fac`, as `BM_edge_split` places it.
    positions.push(...madd(p1, sub(p2, p1), fac));
    origins.set(nv, { from: [v1, v2], w: [1 - fac, fac] });
    for (const p of polys)
      for (let i = 0; i < p.length; i++) {
        const j = (i + 1) % p.length;
        if ((p[i] === v1 && p[j] === v2) || (p[i] === v2 && p[j] === v1)) {
          p.splice(i + 1, 0, nv);
          break;
        }
      }
    splits.push([v1, v2, nv]);
    out.add(nv);
  }

  const P: V3[] = [];
  for (let i = 0; i < positions.length / 3; i++) P.push([f(positions[i * 3]!), f(positions[i * 3 + 1]!), f(positions[i * 3 + 2]!)]);
  const { made, failed } = connectVertsPolys(P, polys, out, true);
  if (failed && mode !== "path") throw new Error(`connectVertPair: could not connect vertices ${a} and ${b}`);
  rebuildPolygons(em, Float32Array.from(positions), polys, { origins, normalsAsVectors: mode !== "op" });
  for (const [v1, v2, nv] of splits) carryEdgeFlags(em, v1, v2, [nv]);
  return made;
}

/**
 * Join two vertices with a cut across the faces between them — Blender's
 * `bmesh.ops.connect_vert_pair(verts=[a, b])`.
 *
 * The cut follows the plane through both vertices that holds their normals
 * (averaged after each is laid flat against the line): starting at `a`, the
 * shortest walk along that plane to `b` that crosses edges (splitting each
 * where the plane meets it) and passes through vertices lying on it. Faces
 * are then split between consecutive points, with `connect_verts`'s check
 * that each cut stays inside its face. Two corners of one face are the
 * one-face case of the same search.
 *
 * Returns the faces made — every piece of every face that was cut. An empty
 * set means there is no such walk (the plane leaves the mesh, or a boundary
 * cuts it off); Blender then leaves the mesh as it was, and so does this.
 *
 * The new vertices interpolate UVs, colours and vertex groups along the
 * split edge (`BM_edge_split`), the split edges' halves keep the edge's
 * crease, seam and sharp flag, and the pieces of a face keep its corners and
 * material (`BM_face_split`). Custom normals are dropped when a corner is
 * interpolated: `bmesh.ops` interpolates the two stored angles, which is
 * compat-backlog C29. {@link connectVertPath} carries them, as the editor does.
 */
export function connectVertPair(em: EditMesh, a: number, b: number): Set<number> {
  if (a === b) throw new Error(`connectVertPair: ${a} and ${b} are the same vertex`);
  return connectPairOnce(em, a, b, "op");
}

/**
 * The J key — Blender's `bpy.ops.mesh.vert_connect_path()` on vertices
 * selected in the order given.
 *
 * - **Two vertices** (order ignored, the lower index first): if they share a
 *   face, `connect_verts` joins them there — and only in the face whose two
 *   halves would be closest to coplanar (`check_degenerate` off); if not,
 *   `connect_vert_pair` cuts a path across faces.
 * - **More**: each is joined to the next by `connect_vert_pair`, skipping
 *   pairs already joined by an edge, with every vertex normal as it was
 *   before the first cut (Blender restores them, #154197). If every pair was
 *   already an edge and the path is open — each end has one edge to the
 *   other selected vertices — the ends are joined, closing the loop.
 *
 * Returns whether the mesh changed. Throws when the operator would report
 * "Invalid selection order" (nothing to connect and nothing to close) or,
 * for two vertices, "Could not connect vertices". A vertex on no face — the
 * operator's wire branch, which draws plain edges — is refused: an EditMesh
 * holds no wire edges.
 *
 * Not taken: the selection-history form made of **edges**
 * (`bm_vert_connect_select_history_edge_to_vert_path`).
 */
export function connectVertPath(em: EditMesh, verts: readonly number[]): boolean {
  if (verts.length < 2) throw new Error("connectVertPath: select at least two vertices");
  if (new Set(verts).size !== verts.length) throw new Error("connectVertPath: a vertex is listed twice");
  const polys = toPolygons(em);
  const onFace = new Set<number>();
  for (const p of polys) for (const v of p) onFace.add(v);
  for (const v of verts)
    if (!onFace.has(v)) throw new Error(`connectVertPath: vertex ${v} is on no face (the wire branch is not supported)`);

  const edgeBetween = (a: number, b: number): boolean => {
    for (const p of toPolygons(em))
      for (let i = 0; i < p.length; i++) {
        const j = (i + 1) % p.length;
        if ((p[i] === a && p[j] === b) || (p[i] === b && p[j] === a)) return true;
      }
    return false;
  };

  if (verts.length === 2) {
    const [a, b] = [...verts].sort((x, y) => x - y) as [number, number];
    if (polys.some((p) => p.includes(a) && p.includes(b))) {
      const P = positionsV3(em);
      const work = polys.map((p) => [...p]);
      const bm = bmFromMesh({ positions: em.positions, polys: work } as never);
      const loopOrder = (v: number): number[] => loopsOfVert(bm.verts[v]!).map((l) => l.f.index);
      const { made, failed } = connectVertsPolys(P, work, new Set([a, b]), false, loopOrder);
      if (failed) throw new Error("connectVertPath: could not connect vertices");
      // An existing edge counts as connected (`EDGE_OUT_ADJ`).
      if (made.size === 0) {
        if (edgeBetween(a, b)) return true;
        throw new Error("connectVertPath: could not connect vertices");
      }
      rebuildPolygons(em, em.positions, work, {});
      return true;
    }
    if (connectPairOnce(em, a, b, "edbm").size === 0) throw new Error("connectVertPath: could not connect vertices");
    return true;
  }

  const P = positionsV3(em);
  const orig = meshVertNormals(P.map((p) => p.map(f)), polys);
  let changed = false;
  for (let i = 0; i + 1 < verts.length; i++) {
    const a = verts[i]!;
    const b = verts[i + 1]!;
    if (edgeBetween(a, b)) continue;
    const now = meshVertNormals(positionsV3(em).map((p) => p.map(f)), toPolygons(em));
    now[a] = orig[a]!;
    now[b] = orig[b]!;
    if (connectPairOnce(em, a, b, "path", now).size > 0) changed = true;
  }
  if (changed) return true;

  // Close an open path: each end has exactly one edge to another selected vertex.
  const sel = new Set(verts);
  const selectedEdges = (v: number): number => {
    const seen = new Set<number>();
    for (const p of toPolygons(em))
      for (let i = 0; i < p.length; i++) {
        const j = (i + 1) % p.length;
        if (p[i] === v && sel.has(p[j]!)) seen.add(p[j]!);
        if (p[j] === v && sel.has(p[i]!)) seen.add(p[i]!);
      }
    return seen.size;
  };
  const a = verts[0]!;
  const b = verts[verts.length - 1]!;
  if (selectedEdges(a) === 1 && selectedEdges(b) === 1 && connectPairOnce(em, a, b, "path").size > 0) return true;
  throw new Error("connectVertPath: invalid selection order");
}



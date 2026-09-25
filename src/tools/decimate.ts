/**
 * Decimate ▸ Collapse — Blender's `BM_mesh_decimate_collapse`
 * (`bmesh/tools/bmesh_decimate_collapse.cc`), ported as it is written.
 *
 * Quadric edge collapse (Garland & Heckbert), but the answer is not decided
 * by the metric alone, and this file is long because of that. Blender:
 *
 * 1. **triangulates** first — quads by the "beauty" rule
 *    (`BM_verts_calc_rotate_beauty`), n-gons by polyfill then
 *    `BLI_polyfill_beautify` — and remembers which triangles came from which
 *    face, so it can put them back together at the end;
 * 2. builds a quadric per vertex from each face's **stored** normal. The last
 *    triangle out of each quad keeps **the quad's** normal (its data is
 *    swapped into the quad's slot and `BM_elem_attrs_copy` carried the normal
 *    over; only the other triangles get theirs recomputed) — so a bent quad's
 *    two halves feed different planes, and that is part of the answer;
 * 3. keeps the edges in a binary heap (`BLI_heap`) whose ties are decided by
 *    the order edges were inserted and updated — the order of the mesh's
 *    edges (`mesh_calc_edges`), of the edges around each vertex (the BMesh
 *    disk cycle) and of the loops around it. All of those are rebuilt here,
 *    the same way, from the same operations (`BM_vert_splice`,
 *    `BM_edge_splice`, `BM_edge_kill`);
 * 4. costs flat regions by **topology** instead (`USE_TOPOLOGY_FALLBACK`,
 *    below 1e-12), which reads the vertex normals the Mesh had — angle
 *    weighted with `safe_acos_approx`;
 * 5. joins triangles back into quads where both came from the same face and
 *    the quad is still convex.
 *
 * Coordinates, normals and costs are float32 as Blender's are; the quadrics
 * are double. The arithmetic follows the C expressions' order.
 *
 * Pure and headless.
 *
 * ## What is not ported
 *
 * - **Symmetry** (`use_symmetry`) — a kd-tree pairing of mirrored edges.
 * - **Vertex group weights** — they scale costs per vertex.
 * - Custom normals, creases and sharp edges (compat-backlog C21). UVs,
 *   colours, vertex groups and materials are carried — see
 *   {@link decimateCollapse}.
 */
import type { MeshData } from "../lib/mesh";
import {
  f, FLT_EPSILON, FLT_MAX, sub, dot, cross, lenSq, normalizeInPlace, meshVertNormals,
  heapInsert, heapPopMin, heapRemove, heapUpdate, type V3, type Heap, type HeapNode,
} from "./blender-math";
import { isQuadConvex } from "./triangulate";
import {
  bmFromMesh, liveEdges, liveFaces, diskNext, vertInEdge, otherVert, edgeKill, vertSplice, edgeSplice,
  isBoundary, isManifold, loopPair, loopsOfVert, faceCalcNormal, faceTriangulate, facesJoin, faceKill, faceLoops,
  type BV, type BE, type BL, type BF,
} from "./bmesh-lite";
const COST_INVALID = FLT_MAX;
const TOPOLOGY_FALLBACK_EPS = f(1e-12);
const BOUNDARY_PRESERVE_WEIGHT = 100;
const OPTIMIZE_EPS = 1e-8;

export interface DecimateOptions {
  /**
   * How much of the **triangle** count to keep, 0..1 — Blender's `ratio`.
   * The target is `trunc(triangles × ratio)` in float, as Blender computes it.
   */
  ratio: number;
  /**
   * Leave the result as triangles — Blender's `use_collapse_triangulate`.
   * Default false: triangles that came from the same face are joined back
   * into it where they survived and the quad is convex.
   */
  triangulate?: boolean;
  /**
   * How many hash tables Blender split the mesh's edges into when it built
   * them (`mesh_calc_edges`): 1 below 1000 faces, otherwise
   * `min(8, threads)` rounded down to a power of two — **8** on any machine
   * with 8 or more threads, which is the default. The order of the edges
   * only decides ties, so this matters for meshes with exact symmetries.
   */
  edgeTables?: number;
}

// ── quadrics (BLI_quadric, double) ─────────────────────────────────────────

/** a2, ab, ac, ad, b2, bc, bd, c2, cd, d2 — `Quadric`'s field order. */
type Quadric = Float64Array;
function quadricFromPlane(v: number[]): Quadric {
  return Float64Array.of(
    v[0]! * v[0]!, v[0]! * v[1]!, v[0]! * v[2]!, v[0]! * v[3]!,
    v[1]! * v[1]!, v[1]! * v[2]!, v[1]! * v[3]!,
    v[2]! * v[2]!, v[2]! * v[3]!,
    v[3]! * v[3]!,
  );
}
function quadricAdd(a: Quadric, b: Quadric): void {
  for (let i = 0; i < 10; i++) a[i] = a[i]! + b[i]!;
}
function quadricEvaluate(q: Quadric, v: number[]): number {
  const [a2, ab, ac, ad, b2, bc, bd, c2, cd, d2] = q as unknown as number[];
  const v00 = v[0]! * v[0]!, v01 = v[0]! * v[1]!, v02 = v[0]! * v[2]!;
  const v11 = v[1]! * v[1]!, v12 = v[1]! * v[2]!;
  const v22 = v[2]! * v[2]!;
  return (
    a2! * v00 + ab! * 2 * v01 + ac! * 2 * v02 + ad! * 2 * v[0]! +
    b2! * v11 + bc! * 2 * v12 + bd! * 2 * v[1]! +
    c2! * v22 + cd! * 2 * v[2]! +
    d2!
  );
}
function quadricOptimize(q: Quadric, eps: number): number[] | null {
  const [a2, ab, ac, ad, b2, bc, bd, c2, cd] = q as unknown as number[];
  const det = a2! * (b2! * c2! - bc! * bc!) - ab! * (ab! * c2! - ac! * bc!) + ac! * (ab! * bc! - ac! * b2!);
  if (!(Math.abs(det) > eps)) return null;
  const inv = 1 / det;
  const m00 = (b2! * c2! - bc! * bc!) * inv;
  const m10 = (bc! * ac! - ab! * c2!) * inv;
  const m20 = (ab! * bc! - b2! * ac!) * inv;
  const m01 = (ac! * bc! - ab! * c2!) * inv;
  const m11 = (a2! * c2! - ac! * ac!) * inv;
  const m21 = (ab! * ac! - a2! * bc!) * inv;
  const m02 = (ab! * bc! - ac! * b2!) * inv;
  const m12 = (ac! * ab! - a2! * bc!) * inv;
  const m22 = (a2! * b2! - ab! * ab!) * inv;
  const v0 = ad!, v1 = bd!, v2 = cd!;
  return [
    -(m00 * v0 + m10 * v1 + m20 * v2),
    -(m01 * v0 + m11 * v1 + m21 * v2),
    -(m02 * v0 + m12 * v1 + m22 * v2),
  ];
}

// ── the operator ───────────────────────────────────────────────────────────

/**
 * Collapse edges until `ratio` of the triangles are left, as Blender's
 * Decimate modifier does in Collapse mode.
 *
 * ```ts
 * const lod = decimateCollapse(meshToData(em), { ratio: 0.3 });
 * ```
 *
 * **Layers** (compat-backlog A7): UVs, colours, vertex groups and materials,
 * as the modifier carries them (`decimate-collapse-layers`, `-uv`). Each
 * collapse mixes the edge's two corners by the collapse factor into every
 * corner of the fans round its ends that still equals the corner it starts
 * from (`bm_edge_collapse_loop_customdata` — a UV seam stops it); a colour is
 * a byte and is rounded each time. The kept vertex takes the two ends' groups
 * mixed by the same factor. Custom normals, creases and sharp edges are
 * dropped (compat-backlog C21).
 */
export function decimateCollapse(data: MeshData, opts: DecimateOptions): MeshData {
  const ratio = f(opts.ratio);
  // Nothing to collapse: the mesh as it is, layers and all — copies, so the
  // result shares nothing with the input (found by review).
  const copy = (): MeshData => {
    const out: MeshData = { positions: Float32Array.from(data.positions), polys: data.polys.map((p) => [...p]) };
    const deep = (l: number[][][] | undefined): number[][][] | undefined => l?.map((f) => f.map((x) => [...x]));
    if (data.uvs) out.uvs = deep(data.uvs)!;
    if (data.colors) out.colors = deep(data.colors)!;
    if (data.normals) out.normals = deep(data.normals)!;
    if (data.materials) out.materials = [...data.materials];
    if (data.groups) out.groups = new Map([...data.groups].map(([k, g]) => [k, new Map(g)]));
    if (data.creases) out.creases = new Map(data.creases);
    if (data.seams) out.seams = new Set(data.seams);
    if (data.sharp) out.sharp = new Set(data.sharp);
    if (data.edges) out.edges = data.edges.map((e) => [...e]);
    return out;
  };
  if (ratio === 1 || data.polys.length <= 3) return copy();

  const nv = data.positions.length / 3;
  const P: V3[] = [];
  for (let i = 0; i < nv; i++) P.push([f(data.positions[i * 3]!), f(data.positions[i * 3 + 1]!), f(data.positions[i * 3 + 2]!)]);
  const polys = data.polys.filter((p) => p.length >= 3);
  const vno = meshVertNormals(P, polys);

  // ── BM_mesh_bm_from_me ────────────────────────────────────────────────
  // All the faces are handed over — `bmFromMesh` skips the degenerate ones
  // itself — so a face's and a corner's `src` number the input's.
  const bm = bmFromMesh({ positions: data.positions, polys: data.polys }, { edgeTables: opts.edgeTables, vertNormals: vno });

  // ── the layers ────────────────────────────────────────────────────────
  // Corner data as values a loop's `src` points at: the input's corners
  // first, then one new entry per interpolation — copies (triangulation,
  // joins) hand the number on, and an entry never changes. UVs and colours
  // interpolate; a colour is a byte in Blender and is rounded each time.
  const cornerLayers = [data.uvs, data.colors].map((l) => (l && l.length === data.polys.length ? l : undefined));
  const hasLoopData = cornerLayers.some((l) => l);
  const vals: (number[] | undefined)[][] = [];
  data.polys.forEach((p, fi) => p.forEach((_, k) => vals.push(cornerLayers.map((l) => (l ? [...l[fi]![k]!] : undefined)))));
  const groups = data.groups ? new Map([...data.groups].map(([n, g]) => [n, new Map(g)])) : undefined;
  /** `layerEqual_propfloat2` / `layerEqual_mloopcol`. */
  const equal = (layer: number, a: number[], b: number[]): boolean => {
    let d = 0;
    for (let j = 0; j < a.length; j++) d += layer === 1 ? ((a[j]! - b[j]!) * 255) ** 2 : (a[j]! - b[j]!) ** 2;
    return layer === 1 ? d < 0.001 : d < 0.00001;
  };
  /** `BM_edge_other_loop`. */
  const edgeOtherLoop = (e: BE, l: BL): BL => {
    let o = (l.e === e ? l : l.prev).rn!;
    if (o.v !== l.v) o = o.next;
    return o;
  };
  /** `bm_edge_collapse_loop_customdata`: the fans round both ends take the collapsed corners' mix. */
  const collapseLoopData = (l: BL, vClear: BV, fac: number): void => {
    const manifold = isManifold(l.e!);
    const [lClear, lOther] = l.v === vClear ? [l, l.next] : [l.next, l];
    for (let side = 0; side < 2; side++) {
      const fExit = manifold ? l.rn!.f : null;
      let ePrev = l.e!;
      const lFirst = side === 0 ? lClear : lOther;
      const src = side === 0 ? [vals[lClear.src]!, vals[lOther.src]!] : [vals[lOther.src]!, vals[lClear.src]!];
      const w = side === 0 ? [fac, 1 - fac] : [1 - fac, fac];
      let lIter: BL | null = lFirst;
      for (;;) {
        // `BM_vert_step_fan_loop`
        const eNext: BE | null = lIter!.e === ePrev ? lIter!.prev.e! : lIter!.prev.e === ePrev ? lIter!.e! : null;
        if (!eNext || !isManifold(eNext)) break;
        ePrev = eNext;
        lIter = edgeOtherLoop(eNext, lIter!);
        if (lIter === lFirst || (fExit && lIter.f === fExit)) break;
        const cur = vals[lIter.src]!;
        let changed = false;
        const next = cur.map((x, k) => {
          const a = src[0]![k];
          const b = src[1]![k];
          if (!x || !a || !b || !equal(k, a, x)) return x;
          changed = true;
          const mixed = a.map((v, j) => v * w[0]! + b[j]! * w[1]!);
          return k === 1 ? mixed.map((v) => Math.min(255, Math.max(0, Math.round(v * 255))) / 255) : mixed;
        });
        if (changed) {
          lIter.src = vals.length;
          vals.push(next);
        }
      }
    }
  };
  /**
   * `BM_data_interp_from_verts(v_other, v_clear, v_other, fac)` for the
   * groups. `bm_data_interp_from_elem` does not blend at the ends: at
   * `fac <= 0` the vertex keeps its own data, at `fac >= 1` it takes
   * `v_clear`'s whole — and the collapse factor does leave [0, 1].
   */
  const collapseVertData = (vOther: BV, vClear: BV, fac: number): void => {
    if (fac <= 0) return;
    if (fac >= 1) {
      for (const g of groups?.values() ?? []) {
        const x = g.get(vClear.index);
        if (x === undefined) g.delete(vOther.index);
        else g.set(vOther.index, x);
      }
      return;
    }
    for (const g of groups?.values() ?? []) {
      let member = false;
      let sum = 0;
      for (const [v, w] of [[vOther, 1 - fac], [vClear, fac]] as const) {
        const x = g.get(v.index);
        if (x !== undefined && x * w !== 0) {
          member = true;
          sum += x * w;
        }
      }
      if (member) g.set(vOther.index, Math.min(sum, 1));
      else g.delete(vOther.index);
    }
  };

  // ── bm_decim_triangulate_begin ──────────────────────────────────────────
  let hasCut = false;
  const facesDouble: BF[] = [];
  const faceSlots = bm.faces.items.length;
  for (let s = 0; s < faceSlots; s++) {
    const face = bm.faces.items[s];
    if (!face || face.len <= 3) continue;
    const fIndex = face.index;
    // Decimate asks for beauty on both (`quad_method = ngon_method = 0`).
    const out = faceTriangulate(bm, face, "beauty", "beauty", false);
    facesDouble.unshift(...out.doubles);
    for (const e of out.edges) {
      let l = e.l!;
      do {
        l.index = fIndex;
        hasCut = true;
      } while ((l = l.rn!) !== e.l);
    }
    for (const nf of out.faces) nf.no = faceCalcNormal(nf);
  }
  for (const fd of facesDouble) faceKill(bm, fd);
  liveEdges(bm).forEach((e, i) => (e.index = i));
  liveFaces(bm).forEach((x, i) => (x.index = i));

  // ── quadrics ──────────────────────────────────────────────────────────
  const vq: Quadric[] = bm.verts.map(() => new Float64Array(10));
  for (const face of liveFaces(bm)) {
    const ls = faceLoops(face);
    const c = [0, 0, 0];
    for (const l of ls) for (let k = 0; k < 3; k++) c[k] = f(c[k]! + l.v.co[k]!);
    const inv = f(1 / f(face.len));
    for (let k = 0; k < 3; k++) c[k] = f(c[k]! * inv);
    const plane = [face.no[0]!, face.no[1]!, face.no[2]!, 0];
    plane[3] = -(plane[0]! * c[0]! + plane[1]! * c[1]! + plane[2]! * c[2]!);
    const q = quadricFromPlane(plane);
    for (const l of ls) quadricAdd(vq[l.v.index]!, q);
  }
  for (const e of liveEdges(bm)) {
    if (!isBoundary(e)) continue;
    const ev = sub(e.v2.co, e.v1.co);
    const ep = cross(ev, e.l!.f.no);
    const pd = [ep[0]!, ep[1]!, ep[2]!, 0];
    let d = pd[0]! * pd[0]! + pd[1]! * pd[1]! + pd[2]! * pd[2]!;
    if (d > 1e-35) {
      d = Math.sqrt(d);
      const s = 1 / d;
      for (let k = 0; k < 3; k++) pd[k] = pd[k]! * s;
    } else {
      pd[0] = pd[1] = pd[2] = 0;
      d = 0;
    }
    if (d > FLT_EPSILON) {
      const c = [0, 1, 2].map((k) => f(0.5 * f(e.v1.co[k]! + e.v2.co[k]!)));
      pd[3] = -(pd[0]! * c[0]! + pd[1]! * c[1]! + pd[2]! * c[2]!);
      const q = quadricFromPlane(pd);
      for (let i = 0; i < 10; i++) q[i] = q[i]! * BOUNDARY_PRESERVE_WEIGHT;
      quadricAdd(vq[e.v1.index]!, q);
      quadricAdd(vq[e.v2.index]!, q);
    }
  }

  // ── edge costs ────────────────────────────────────────────────────────
  const heap: Heap<BE> = { tree: [] };
  const table: (HeapNode<BE> | null)[] = [];
  const targetCo = (e: BE): number[] => {
    const q = Float64Array.from(vq[e.v1.index]!);
    quadricAdd(q, vq[e.v2.index]!);
    return quadricOptimize(q, OPTIMIZE_EPS) ?? [0, 1, 2].map((k) => 0.5 * (e.v1.co[k]! + e.v2.co[k]!));
  };
  const costSingle = (e: BE): void => {
    let ok = false;
    if (isBoundary(e)) ok = e.l!.f.len === 3;
    else if (isManifold(e)) ok = e.l!.f.len === 3 && e.l!.rn!.f.len === 3;
    if (!ok) {
      if (table[e.index]) heapRemove(heap, table[e.index]!);
      table[e.index] = null;
      return;
    }
    const co = targetCo(e);
    let cost = f(quadricEvaluate(vq[e.v1.index]!, co) + quadricEvaluate(vq[e.v2.index]!, co));
    cost = Math.abs(cost);
    if (cost < TOPOLOGY_FALLBACK_EPS) {
      const topo = f(f(Math.abs(dot(e.v1.no, e.v2.no))) / Math.min(-lenSq(sub(e.v1.co, e.v2.co)), -FLT_EPSILON));
      cost = f(topo - cost);
    }
    const node = table[e.index];
    if (node) heapUpdate(heap, node, cost, e);
    else table[e.index] = heapInsert(heap, cost, e);
  };
  for (const e of liveEdges(bm)) {
    table[e.index] = null;
    costSingle(e);
  }
  const invalidate = (e: BE): void => {
    table[e.index] = heapInsert(heap, COST_INVALID, e);
  };

  const target = Math.trunc(f(f(bm.totface) * ratio));

  // ── bm_edge_collapse_is_degenerate_topology ───────────────────────────
  const tagEnable = (e: BE, on: boolean): void => {
    e.v1.tag = on;
    e.v2.tag = on;
    if (e.l) {
      e.l.f.tag = on;
      if (e.l !== e.l.rn) e.l.rn!.f.tag = on;
    }
  };
  const tagTest = (e: BE): boolean =>
    e.v1.tag || e.v2.tag || (!!e.l && (e.l.f.tag || (e.l !== e.l.rn && e.l.rn!.f.tag)));
  const manifoldOrBoundary = (l: BL | null): boolean => !!l && l.rn!.rn === l;
  const degenerateTopology = (eFirst: BE): boolean => {
    for (const v of [eFirst.v1, eFirst.v2]) {
      let e = eFirst;
      do {
        if (!manifoldOrBoundary(e.l)) return true;
        tagEnable(e, false);
      } while ((e = diskNext(e, v)) !== eFirst);
    }
    let e = eFirst;
    do tagEnable(e, true);
    while ((e = diskNext(e, eFirst.v1)) !== eFirst);
    const lr = eFirst.l!;
    lr.f.tag = false;
    lr.v.tag = false;
    lr.next.v.tag = false;
    lr.next.next.v.tag = false;
    const lf = lr.rn!;
    if (lr !== lf) {
      lf.f.tag = false;
      lf.v.tag = false;
      lf.next.v.tag = false;
      lf.next.next.v.tag = false;
    }
    e = eFirst;
    do if (tagTest(e)) return true;
    while ((e = diskNext(e, eFirst.v2)) !== eFirst);
    return false;
  };

  const degenerateFlip = (e: BE, co: V3): boolean => {
    for (const v of [e.v1, e.v2])
      for (const l of loopsOfVert(v)) {
        if (l.e === e || l.prev.e === e) continue;
        const cp = l.prev.v.co;
        const cn = l.next.v.co;
        const vo = sub(cp, cn);
        const ce = cross(vo, sub(cp, v.co));
        const cOpt = cross(vo, sub(cp, co));
        if (dot(ce, cOpt) <= f(f(lenSq(ce) + lenSq(cOpt)) * f(0.01))) return true;
      }
    return false;
  };

  /** `bm_edge_collapse`: kills `vClear` into the other end. */
  const edgeCollapse = (eClear: BE, vClear: BV, rOther: number[], fac: number): boolean => {
    const vOther = otherVert(eClear, vClear);
    const sides = (l: BL): [BE, BE] => (vertInEdge(l.prev.e!, vClear) ? [l.prev.e!, l.next.e!] : [l.next.e!, l.prev.e!]);
    if (isManifold(eClear)) {
      const [la, lb] = loopPair(eClear)!;
      const a = sides(la);
      const b = sides(lb);
      if (a[0] === b[0] || a[0] === b[1] || a[1] === b[0] || a[1] === b[1]) return false;
      rOther[0] = a[0].index;
      rOther[1] = b[0].index;
      // before killing, do customdata
      collapseVertData(vOther, vClear, fac);
      if (hasLoopData) {
        collapseLoopData(eClear.l!, vClear, fac);
        collapseLoopData(eClear.l!.rn!, vClear, fac);
      }
      edgeKill(bm, eClear);
      vertSplice(bm, vOther, vClear);
      edgeSplice(bm, a[1], a[0]);
      edgeSplice(bm, b[1], b[0]);
      return true;
    }
    if (isBoundary(eClear)) {
      const a = sides(eClear.l!);
      rOther[0] = a[0].index;
      rOther[1] = -1;
      collapseVertData(vOther, vClear, fac);
      if (hasLoopData) collapseLoopData(eClear.l!, vClear, fac);
      edgeKill(bm, eClear);
      vertSplice(bm, vOther, vClear);
      edgeSplice(bm, a[1], a[0]);
      return true;
    }
    return false;
  };

  const decimEdgeCollapse = (e: BE): boolean => {
    const vOther = e.v1;
    const vOtherIndex = e.v1.index;
    const vClearIndex = e.v2.index;
    const vClearNo = [...e.v2.no];
    if (degenerateTopology(e)) {
      invalidate(e);
      return false;
    }
    const co = targetCo(e).map(f);
    if (degenerateFlip(e, co)) {
      invalidate(e);
      return false;
    }
    let fac: number;
    const near = [0, 1, 2].every((k) => Math.abs(f(e.v1.co[k]! - e.v2.co[k]!)) <= FLT_EPSILON);
    if (!near) {
      const u = sub(e.v2.co, e.v1.co);
      const h = sub(co, e.v1.co);
      const d = lenSq(u);
      fac = d > 0 ? f(dot(u, h) / d) : 0;
    } else fac = 0.5;
    const rOther = [-1, -1];
    if (edgeCollapse(e, e.v2, rOther, fac)) {
      vOther.co = co;
      for (const i of rOther)
        if (i !== -1 && table[i]) {
          heapRemove(heap, table[i]!);
          table[i] = null;
        }
      quadricAdd(vq[vOtherIndex]!, vq[vClearIndex]!);
      const s = f(1 - fac);
      vOther.no = [0, 1, 2].map((k) => f(f(s * vOther.no[k]!) + f(fac * vClearNo[k]!)));
      normalizeInPlace(vOther.no);
      if (vOther.e) {
        let ei = vOther.e;
        const first = ei;
        do costSingle(ei);
        while ((ei = diskNext(ei, vOther)) !== first);
      }
      for (const l of loopsOfVert(vOther)) {
        if (l.f.len !== 3) continue;
        const eOuter = vertInEdge(l.prev.e!, l.v) ? l.next.e! : l.prev.e!;
        costSingle(eOuter);
      }
      return true;
    }
    invalidate(e);
    return false;
  };

  while (bm.totface > target && heap.tree.length && heap.tree[0]!.value !== f(COST_INVALID)) {
    const e = heapPopMin(heap);
    table[e.index] = null;
    decimEdgeCollapse(e);
  }

  // ── bm_decim_triangulate_end ──────────────────────────────────────────
  if (!opts.triangulate && hasCut) {
    const edgesTri: BE[] = [];
    for (const e of liveEdges(bm)) {
      const pair = loopPair(e);
      if (!pair) continue;
      const [la, lb] = pair;
      const ia = la.index;
      if (ia === -1 || lb.index !== ia || la.v === lb.v) continue;
      const canMerge = (l: BL): boolean =>
        l !== l.rn && l === l.rn!.rn && l.v !== l.rn!.v && ia === l.index && ia === l.rn!.index;
      if (la.f.len === 3 && lb.f.len === 3 && !canMerge(la.next) && !canMerge(la.prev) && !canMerge(lb.next) && !canMerge(lb.prev)) {
        const quad = [
          e.v1,
          vertInEdge(e, la.next.v) ? la.prev.v : la.next.v,
          e.v2,
          vertInEdge(e, lb.next.v) ? lb.prev.v : lb.next.v,
        ];
        if (!isQuadConvex(quad[0]!.co, quad[1]!.co, quad[2]!.co, quad[3]!.co)) continue;
      }
      edgesTri.push(e);
    }
    for (const e of edgesTri) {
      const pair = loopPair(e);
      if (!pair) continue;
      facesJoin(bm, [pair[0].f, pair[1].f], false);
      if (!e.l) edgeKill(bm, e);
    }
  }

  // ── back to MeshData ──────────────────────────────────────────────────
  const remap = new Int32Array(nv).fill(-1);
  const positions: number[] = [];
  bm.verts.forEach((v, i) => {
    if (!v) return;
    remap[i] = positions.length / 3;
    positions.push(v.co[0]!, v.co[1]!, v.co[2]!);
  });
  const faces = liveFaces(bm);
  const out: MeshData = {
    positions: Float32Array.from(positions),
    polys: faces.map((x) => faceLoops(x).map((l) => remap[l.v.index]!)),
  };
  // A corner with no source (none is made here, but the default is cheap)
  // holds the layer's default: 0, or white for a colour.
  const read = (k: number): number[][][] | undefined => {
    const layer = cornerLayers[k];
    if (!layer) return undefined;
    const width = layer.find((f) => f.length > 0)?.[0]?.length ?? (k === 1 ? 4 : 2);
    return faces.map((x) =>
      faceLoops(x).map((l) => {
        const v = vals[l.src]?.[k];
        return v ? [...v] : new Array<number>(width).fill(k === 1 ? 1 : 0);
      }),
    );
  };
  const uvs = read(0);
  if (uvs) out.uvs = uvs;
  const colors = read(1);
  if (colors) out.colors = colors;
  if (data.materials && data.materials.length === data.polys.length)
    out.materials = faces.map((x) => (x.src >= 0 ? data.materials![x.src]! : 0));
  if (groups) {
    out.groups = new Map(
      [...groups].map(([n, g]) => [
        n,
        new Map([...g].filter(([v]) => remap[v]! >= 0).map(([v, w]) => [remap[v]!, w] as [number, number])),
      ]),
    );
  }
  return out;
}

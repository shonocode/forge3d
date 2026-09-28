/**
 * Inset — Blender 5.1.1's `bmo_inset.cc`, ported whole on `bmesh-lite`:
 * `bmesh.ops.inset_region` and `bmesh.ops.inset_individual` with every option.
 *
 * The region form is a sequence of BMesh kernel operations, and the answer
 * depends on their order: the border edges are separated in the Mesh's edge
 * order, each border vertex is split into one vertex per fan of faces
 * (`bmesh_kernel_vert_separate`), the new vertex moves along the first two
 * border edges it finds round its disk, and fans with no selected face are
 * glued back together. The rim faces are then made one per border edge and
 * take their corners from the region face across — or, with
 * `use_interpolate`, the region's faces are re-interpolated over their old
 * shape and the rim's outer corners take the old values (merged where the
 * values across the rim edge agreed, `USE_LOOP_CUSTOMDATA_MERGE`).
 *
 * The layers are carried as values, not as references into the input:
 * `bm_loop_customdata_merge` compares UVs and colours as values and merges
 * them layer by layer, so a corner's UV and its colour can come from
 * different places. Custom normals are two angles in Blender
 * (`CD_PROP_INT16_2D`, no interpolation) and are only ever copied.
 *
 * Pure and headless.
 */
import type { MeshData } from "../lib/mesh";
import { f, sub, dot, cross, normalizeInPlace, FLT_EPSILON, type V3 } from "./blender-math";
import {
  diskEdges,
  edgeExists,
  edgeOtherLoop,
  edgeSeparate,
  faceCreateVerts,
  faceLoops,
  isBoundary,
  isManifold,
  liveEdges,
  liveFaces,
  loopOtherVertLoop,
  loopSeparate,
  loopsOfVert,
  otherVert,
  vertSeparate,
  vertSplice,
  type BE,
  type BF,
  type BL,
  type BM,
  type BV,
} from "./bmesh-lite";
import { interpWeightsPoly2 } from "./edit-mode/interp";
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
  type LoopData,
  type VertData,
} from "./bmesh-carry";

function save(bm: BM, c: Carry, data: MeshData, rim: BF[], inner: BF[]): InsetResult {
  const { mesh, at } = saveMesh(bm, c, data);
  return { mesh, rim: rim.map((x) => at.get(x)!), inner: inner.filter((x) => at.has(x)).map((x) => at.get(x)!) };
}

/** Options of `bmesh.ops.inset_region`, in its names; every flag defaults to off, as there. */
export interface InsetRegionMeshOptions {
  /** Blender's `thickness`: how far the border moves in. */
  thickness: number;
  /** Blender's `depth`: how far the region then moves along its normals. Default 0. */
  depth?: number;
  /** Inset the part of the border that is the mesh's own boundary too. */
  useBoundary?: boolean;
  /** Keep the border's width constant (`use_even_offset`); also slides boundary corners along the boundary. */
  useEvenOffset?: boolean;
  /** Scale the width by the lengths of the edges at each corner (`use_relative_offset`). */
  useRelativeOffset?: boolean;
  /** Where two border faces share a vertex across the corner, move along that edge (`use_edge_rail`). */
  useEdgeRail?: boolean;
  /** Re-interpolate the region's corner and vertex data over its old shape (`use_interpolate`). */
  useInterpolate?: boolean;
  /** Inset the faces *around* the given ones instead (`use_outset`); `useBoundary` is then ignored. */
  useOutset?: boolean;
  /** With `useOutset`: faces left alone as well (`faces_exclude`). */
  facesExclude?: Iterable<number>;
}

/** Options of `bmesh.ops.inset_individual`, in its names; every flag defaults to off, as there. */
export interface InsetIndividualMeshOptions {
  thickness: number;
  /** Move each inner face along its own normal. Default 0. */
  depth?: number;
  useEvenOffset?: boolean;
  useRelativeOffset?: boolean;
  useInterpolate?: boolean;
}

/** What an inset returns: the mesh, the faces it made (`faces.out`), and the inset faces themselves. */
export interface InsetResult {
  mesh: MeshData;
  /** The new rim faces — Blender's `faces.out`. */
  rim: number[];
  /** The input faces, where they are now: the inner faces to extrude next. */
  inner: number[];
}

// ── geometry helpers, in float as Blender does them ───────────────────────

const add3 = (a: V3, b: V3): V3 => [f(a[0]! + b[0]!), f(a[1]! + b[1]!), f(a[2]! + b[2]!)];
const scale3 = (a: V3, s: number): V3 => [f(a[0]! * s), f(a[1]! * s), f(a[2]! * s)];
/** `madd_v3_v3fl`: `r += v · s`. */
const madd3 = (r: V3, v: V3, s: number): V3 => [f(r[0]! + f(v[0]! * s)), f(r[1]! + f(v[1]! * s)), f(r[2]! + f(v[2]! * s))];
const len3 = (a: V3, b: V3): number => f(Math.sqrt(dot(sub(a, b), sub(a, b))));
const lenSq3 = (a: V3, b: V3): number => dot(sub(a, b), sub(a, b));
const SMALL_NUMBER = 1e-8;

/** `shell_v3v3_normalized_to_dist`. */
function shellNormalized(a: V3, b: V3): number {
  const c = Math.abs(dot(a, b));
  return c < SMALL_NUMBER ? 1 : f(1 / c);
}
/** `shell_v3v3_mid_normalized_to_dist`. */
function shellMid(a: V3, b: V3): number {
  const ab = add3(a, b);
  const c = normalizeInPlace(ab) !== 0 ? Math.abs(dot(a, ab)) : 0;
  return c < SMALL_NUMBER ? 1 : f(1 / c);
}
/** `BM_edge_calc_face_tangent`: `normalize((l.v − l.next.v) × f.no)`. */
function faceTangent(l: BL): V3 {
  const t = cross(sub(l.v.co, l.next.v.co), l.f.no);
  normalizeInPlace(t);
  return t;
}
const edgeLength = (e: BE): number => len3(e.v1.co, e.v2.co);

/** `angle_v3v3v3` at `l`'s corner (`BM_loop_calc_face_angle`). */
function loopAngle(l: BL): number {
  const a = sub(l.v.co, l.prev.v.co);
  const b = sub(l.v.co, l.next.v.co);
  normalizeInPlace(a);
  normalizeInPlace(b);
  return Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
}
/** `BM_vert_calc_shell_factor`. */
function shellFactor(v: BV): number {
  let shell = 0;
  let angle = 0;
  for (const l of loopsOfVert(v)) {
    const a = loopAngle(l);
    shell += shellNormalized(v.no, l.f.no) * a;
    angle += a;
  }
  return angle !== 0 ? shell / angle : 1;
}

/** `axis_dominant_v3_to_m3` then `mul_v2_m3v3`: a face's plane, in 2D. */
function axisProject(no: V3): (co: V3) => [number, number] {
  const n = no;
  const d2 = f(f(n[0]! * n[0]!) + f(n[1]! * n[1]!));
  let a: V3;
  let b: V3;
  if (d2 > FLT_EPSILON) {
    const d = f(1 / f(Math.sqrt(d2)));
    a = [f(n[1]! * d), f(-n[0]! * d), 0];
    b = [f(-n[2]! * a[1]!), f(n[2]! * a[0]!), f(f(n[0]! * a[1]!) - f(n[1]! * a[0]!))];
  } else {
    a = [n[2]! < 0 ? -1 : 1, 0, 0];
    b = [0, 1, 0];
  }
  return (co) => [dot(a, co), dot(b, co)];
}

/** `InterpFace`: enough of a face to interpolate over its old shape later. */
interface InterpFace {
  f: BF;
  blocksL: LoopData[];
  blocksV: VertData[];
  cos2d: [number, number][];
  project: (co: V3) => [number, number];
}
/** `bm_interp_face_store`: also numbers the face's loops, as the C does. */
function interpFaceStore(c: Carry, fc: BF): InterpFace {
  const project = axisProject(fc.no);
  const loops = faceLoops(fc);
  loops.forEach((l, i) => (l.index = i));
  return {
    f: fc,
    blocksL: loops.map((l) => copyLD(c.ld.get(l))),
    blocksV: loops.map((l) => new Map(c.vd.get(l.v))),
    cos2d: loops.map((l) => project(l.v.co)),
    project,
  };
}
/** `BM_face_interp_from_face_ex(f, f, do_vertex = true, …)`. */
function interpFaceApply(c: Carry, iface: InterpFace): void {
  for (const l of faceLoops(iface.f)) {
    const w = interpWeightsPoly2(iface.cos2d, iface.project(l.v.co));
    const dst = copyLD(c.ld.get(l));
    interpLoop(iface.blocksL, w, dst);
    c.ld.set(l, dst);
    c.vd.set(l.v, interpVert(iface.blocksV, w));
  }
}

// ── inset_individual ───────────────────────────────────────────────────────

/**
 * `bmesh.ops.inset_individual` — every face gets its own rim, whether or not
 * its neighbours are inset too. Each corner moves along the sum of its two
 * edges' in-face tangents, normalised, by `thickness` (with
 * `useEvenOffset`, divided by the cosine of the half angle, so the border is
 * `thickness` wide; with `useRelativeOffset`, times the mean length of the
 * corner's two edges). `depth` moves the face along its normal, scaled the
 * same way by `useRelativeOffset`.
 *
 * The face keeps its corners (it is the same face, moved); the rim quad's
 * outer corners copy the face's corners at each end, and so do its inner
 * corners — or, with `useInterpolate`, the face's corners and vertices are
 * re-interpolated over its old shape and the inner corners copy those.
 */
export function insetIndividualMesh(
  data: MeshData,
  faces: Iterable<number>,
  opts: InsetIndividualMeshOptions,
): InsetResult {
  const { bm, c, byInput } = load(data);
  const thickness = f(opts.thickness);
  const depth = f(opts.depth ?? 0);
  const useEven = !!opts.useEvenOffset;
  const useRel = !!opts.useRelativeOffset;
  const useInterp = !!opts.useInterpolate;
  const input = [...faces].map((i) => byInput.get(i)).filter((x): x is BF => !!x);
  for (const x of liveFaces(bm)) x.tag = false;
  for (const x of input) x.tag = true;
  const rim: BF[] = [];

  for (const fc of input) {
    const loops = faceLoops(fc);
    const n = loops.length;
    const verts: BV[] = [];
    const edgeNors: V3[] = [];
    for (const l of loops) {
      let vOther = l.v;
      const sep = loopSeparate(bm, l);
      for (const [from, made] of sep.eNew) copyEdgeData(c, from, made);
      if (sep.v === vOther) vOther = vertLike(c, bm, l.v);
      else c.vd.set(sep.v, new Map(c.vd.get(vOther)));
      verts.push(vOther);
      edgeNors.push(faceTangent(l));
    }

    loops.forEach((l, i) => {
      const vO = verts[i]!;
      const vON = verts[(i + 1) % n]!;
      if (!edgeExists(vO, vON)) edgeLike(c, bm, vO, vON, l.e!);
      const fNew = faceCreateVerts(bm, [vO, vON, l.next.v, l.v], fc);
      for (const x of faceLoops(fNew)) c.ld.set(x, blankLoop(c));
      rim.push(fNew);
      const lOther = l.rn!;
      copyLoop(c, l.next, lOther.prev);
      copyLoop(c, l, lOther.next.next);
      if (!useInterp) {
        copyLoop(c, l.next, lOther);
        copyLoop(c, l, lOther.next);
      }
    });

    const iface = useInterp ? interpFaceStore(c, fc) : null;

    const coords: V3[] = [];
    let eLenPrev = depth !== 0 ? edgeLength(loops[0]!.prev.e!) : 0;
    loops.forEach((l, i) => {
      const enoPrev = edgeNors[(i ? i : n) - 1]!;
      const enoNext = edgeNors[i]!;
      let tvec = add3(enoPrev, enoNext);
      normalizeInPlace(tvec);
      let co: V3 = [...l.v.co];
      if (useEven) tvec = scale3(tvec, shellMid(enoPrev, enoNext));
      if (useRel) tvec = scale3(tvec, f(f(edgeLength(l.e!) + edgeLength(l.prev.e!)) / 2));
      co = madd3(co, tvec, thickness);
      l.v.no = [...fc.no];
      if (depth !== 0) {
        const eLen = edgeLength(l.e!);
        const fac = f(depth * (useRel ? f(f(eLenPrev + eLen) * 0.5) : 1));
        eLenPrev = eLen;
        co = madd3(co, fc.no, fac);
      }
      coords.push(co);
    });
    loops.forEach((l, i) => (l.v.co = coords[i]!));

    if (iface) {
      interpFaceApply(c, iface);
      for (const l of loops) {
        const lOther = l.rn!;
        copyLoop(c, l.next, lOther);
        copyLoop(c, l, lOther.next);
      }
    }
  }
  return save(bm, c, data, rim, input);
}

// ── inset_region ───────────────────────────────────────────────────────────

interface SplitEdgeInfo {
  no: V3;
  length: number;
  eOld: BE;
  eNew: BE;
  l: BL;
}

/** `bm_edge_is_mixed_face_tag`: the loop of the one tagged face, when there is one and an untagged one too. */
function mixedFaceTag(l: BL | null): BL | null {
  if (!l) return null;
  let tag = 0;
  let untag = 0;
  let lTag: BL | null = null;
  let li = l;
  do {
    if (li.f.tag) {
      if (tag === 1) return null;
      lTag = li;
      tag++;
    } else untag++;
  } while ((li = li.rn!) !== l);
  return tag === 1 && untag >= 1 ? lTag : null;
}

/**
 * `bmesh.ops.inset_region` — the border between the given faces and the rest
 * moves in, and a rim of faces fills the gap. See the module comment for the
 * order of operations; every option is Blender's, defaulting to off as in
 * `bmesh.ops` (the Inset tool in the UI turns `use_boundary`,
 * `use_even_offset` and `use_interpolate` on).
 */
export function insetRegionMesh(data: MeshData, faces: Iterable<number>, opts: InsetRegionMeshOptions): InsetResult {
  const { bm, c, byInput } = load(data);
  const useOutset = !!opts.useOutset;
  const useBoundary = !!opts.useBoundary && !useOutset;
  const useEven = !!opts.useEvenOffset;
  const useEvenBoundary = useEven;
  const useRel = !!opts.useRelativeOffset;
  const useRail = !!opts.useEdgeRail;
  const useInterp = !!opts.useInterpolate;
  const thickness = f(opts.thickness);
  const depth = f(opts.depth ?? 0);
  const hasMathLdata = useInterp && (c.has.uv || c.has.col);

  const input = [...faces].map((i) => byInput.get(i)).filter((x): x is BF => !!x);
  if (!useOutset) {
    for (const x of liveFaces(bm)) x.tag = false;
    for (const x of input) x.tag = true;
  } else {
    for (const x of liveFaces(bm)) x.tag = true;
    for (const x of input) x.tag = false;
    for (const i of opts.facesExclude ?? []) {
      const x = byInput.get(i);
      if (x) x.tag = false;
    }
  }

  // Which edges are split, in the Mesh's edge order. A vertex's tag is set by
  // a split edge and cleared by any later edge that is not — the C's order.
  let n = 0;
  for (const e of liveEdges(bm)) {
    if ((useBoundary && isBoundary(e) && e.l!.f.tag) || mixedFaceTag(e.l)) {
      e.v1.tag = e.v2.tag = true;
      e.tag = true;
      e.index = n++;
    } else {
      e.v1.tag = e.v2.tag = false;
      e.tag = false;
      e.index = -1;
    }
  }
  const info: SplitEdgeInfo[] = [];
  for (const e of liveEdges(bm))
    if (e.index !== -1) info.push({ no: [0, 0, 0], length: edgeLength(e), eOld: e, eNew: e, l: e.l! });

  const ifaces = new Map<BF, InterpFace>();
  info.forEach((es, i) => {
    es.l = mixedFaceTag(es.eOld.l) ?? es.eOld.l!;
    if (!isBoundary(es.eOld)) {
      const eNew = edgeSeparate(bm, es.eOld, es.l)!;
      copyEdgeData(c, es.eOld, eNew);
    }
    es.eNew = es.l.e!;
    es.no = faceTangent(es.l);
    if (es.eNew === es.eOld) es.eOld = edgeLike(c, bm, es.eNew.v1, es.eNew.v2, es.eNew);
    es.eNew.index = i;
    es.eNew.tag = true;
    es.eNew.v1.tag = es.eNew.v2.tag = true;
    if (useInterp)
      for (const v of [es.l.e!.v1, es.l.e!.v2])
        for (const l of loopsOfVert(v)) if (!ifaces.has(l.f)) ifaces.set(l.f, interpFaceStore(c, l.f));
  });

  const vertCoords = new Map<BV, V3>();
  const coordsAdd = (v: BV): void => {
    if (useRail && !vertCoords.has(v)) vertCoords.set(v, [...v.co]);
  };
  const hasTaggedFace = (v: BV): boolean => loopsOfVert(v).some((l) => l.f.tag);

  for (const es of info) {
    for (let j = 0; j < 2; j++) {
      const v = j === 0 ? es.eNew.v1 : es.eNew.v2;
      if (!v.tag) continue;
      v.tag = false;
      const vout = vertSeparate(bm, v);
      for (const x of vout) if (x !== v) c.vd.set(x, new Map(c.vd.get(v)));
      if (vout.length === 1) {
        coordsAdd(vout[0]!);
        continue;
      }
      let vGlue: BV | null = null;
      for (const vSplit of vout) {
        coordsAdd(vSplit);
        let tot = 0;
        const pair: number[] = [];
        for (const e of diskEdges(vSplit))
          if (e.tag && e.l && e.l.f.tag) {
            if (tot < 2) pair[tot] = e.index;
            tot++;
          }
        if (tot !== 0) {
          let tvec: V3;
          if (tot >= 2) {
            const a = info[pair[0]!]!;
            const b = info[pair[1]!]!;
            let isMid = true;
            tvec = add3(a.no, b.no);
            if (useRail && a.l.f !== b.l.f) {
              const oa = loopOtherVertLoop(a.l, vSplit);
              const ob = loopOtherVertLoop(b.l, vSplit);
              if (oa.v === ob.v) {
                const co = vertCoords.get(oa.v) ?? oa.v.co;
                tvec = sub(co, vSplit.co);
                isMid = false;
              }
            }
            normalizeInPlace(tvec);
            if (useEven) {
              if (isMid) tvec = scale3(tvec, shellMid(a.no, b.no));
              else tvec = scale3(tvec, shellNormalized(tvec, lenSq3(tvec, a.no) > lenSq3(tvec, b.no) ? a.no : b.no));
            }
            if (useRel) tvec = scale3(tvec, f(f(a.length + b.length) / 2));
          } else {
            const eNoA = info[pair[0]!]!.no;
            if (useEvenBoundary) {
              // The corner on the mesh boundary slides along the edge that is not split.
              // (The C reads `v_split->e->l`; a wire edge first would crash there.)
              let l = (vSplit.e!.l ?? diskEdges(vSplit).find((e) => e.l)!.l)!;
              if (l.prev.v === vSplit) l = l.prev;
              else if (l.next.v === vSplit) l = l.next;
              const eOther = !l.e!.tag ? l.e! : l.prev.e!;
              tvec = sub(otherVert(eOther, vSplit).co, vSplit.co);
              normalizeInPlace(tvec);
              if (useEven) tvec = scale3(tvec, shellNormalized(eNoA, tvec));
            } else tvec = [...eNoA];
            if (useRel) tvec = scale3(tvec, info[pair[0]!]!.length);
          }
          vSplit.co = madd3(vSplit.co, tvec, thickness);
        }
        // Fans with no selected face are glued back into one vertex.
        if (vout.length > 2 && !hasTaggedFace(vSplit)) {
          if (!vGlue) vGlue = vSplit;
          else if (vGlue !== vSplit) {
            vertSplice(bm, vGlue, vSplit);
            c.vd.delete(vSplit);
            if (useRail) vertCoords.delete(vSplit);
          }
        }
      }
    }
  }

  if (useInterp) for (const iface of [...ifaces.values()].sort((x, y) => x.f.index - y.f.index)) interpFaceApply(c, iface);

  const rim: BF[] = [];
  info.forEach((es) => {
    const eNew = es.eNew;
    const eOld = es.eOld;
    const varr: BV[] = [es.l.next.v, es.l.v];
    if (varr[0] === eNew.v1) {
      if (eOld.v2 !== eNew.v2) varr.push(eOld.v2);
      if (eOld.v1 !== eNew.v1) varr.push(eOld.v1);
    } else {
      if (eOld.v1 !== eNew.v1) varr.push(eOld.v1);
      if (eOld.v2 !== eNew.v2) varr.push(eOld.v2);
    }
    if (varr.length === 2) return;
    const fc = faceCreateVerts(bm, varr, es.l.f);
    for (const x of faceLoops(fc)) c.ld.set(x, blankLoop(c));
    rim.push(fc);

    let lA = fc.first!;
    let lB = lA.next;
    const lAO = edgeOtherLoop(lA.e!, lA);
    const lBO = edgeOtherLoop(lA.e!, lB);
    copyLoop(c, lAO, lA);
    copyLoop(c, lBO, lB);
    lA = lA.next.next;
    lB = lA.next;
    if (useInterp) {
      const iface = ifaces.get(es.l.f)!;
      c.ld.set(lB, copyLD(iface.blocksL[lAO.index]));
      c.ld.set(lA, copyLD(iface.blocksL[lBO.index]));
      if (hasMathLdata) {
        let eConnect = lA.prev.e!;
        if (isManifold(eConnect)) loopMerge(c, lA, edgeOtherLoop(eConnect, lA), lA.prev, edgeOtherLoop(eConnect, lA.prev));
        eConnect = lB.e!;
        if (isManifold(eConnect)) loopMerge(c, lB, edgeOtherLoop(eConnect, lB), lB.next, edgeOtherLoop(eConnect, lB.next));
      }
    } else {
      copyLoop(c, lAO, lB);
      copyLoop(c, lBO, lA);
    }
  });

  if (depth !== 0) {
    for (const es of info) {
      es.eNew.v1.no = [0, 0, 0];
      es.eNew.v2.no = [0, 0, 0];
    }
    for (const es of info) {
      es.eNew.v1.no = add3(es.eNew.v1.no, es.l.f.no);
      es.eNew.v2.no = add3(es.eNew.v2.no, es.l.f.no);
    }
    for (const es of info)
      for (const v of [es.eNew.v1, es.eNew.v2]) if (dot(v.no, v.no) !== 1) normalizeInPlace(v.no);

    for (const v of bm.verts) if (v) v.tag = false;
    for (const fc of input)
      for (const l of faceLoops(fc)) {
        l.v.tag = true;
        l.e!.tag = true;
      }

    const lengths = new VertLengths(bm, info);
    const moved = new Map<BV, V3>();
    for (const v of bm.verts) {
      if (!v || !v.tag) continue;
      const fac = f(
        f(depth * (useRel ? lengths.of(v) : 1)) * (useEvenBoundary ? shellFactor(v) : 1),
      );
      moved.set(v, madd3(v.co, v.no, fac));
    }
    for (const [v, co] of moved) v.co = co;
  }

  return save(bm, c, data, rim, input);
}

/**
 * `bm_edge_info_average_length_with_fallback`: the mean length of a vertex's
 * split edges, or — for a vertex of the region with none — the value spread
 * inward from the border one ring at a time
 * (`bm_edge_info_average_length_fallback`, worked out once, lazily).
 */
class VertLengths {
  private table: Map<BV, { acc: number; count: number }> | null = null;
  private readonly bm: BM;
  private readonly info: SplitEdgeInfo[];
  constructor(bm: BM, info: SplitEdgeInfo[]) {
    this.bm = bm;
    this.info = info;
  }
  private average(v: BV): number {
    let len = 0;
    let tot = 0;
    for (const e of diskEdges(v))
      if (e.index !== -1) {
        len = f(len + this.info[e.index]!.length);
        tot++;
      }
    return tot !== 0 ? f(len / tot) : -1;
  }
  of(v: BV): number {
    const a = this.average(v);
    if (a !== -1) return a;
    if (!this.table) this.table = this.build();
    return this.table.get(v)?.acc ?? 0;
  }
  private build(): Map<BV, { acc: number; count: number }> {
    const t = new Map<BV, { acc: number; count: number }>();
    const get = (v: BV): { acc: number; count: number } => {
      let x = t.get(v);
      if (!x) t.set(v, (x = { acc: 0, count: 0 }));
      return x;
    };
    const stack: BV[] = [];
    for (const e of liveEdges(this.bm)) {
      if (e.index === -1) continue;
      for (const v of [e.v1, e.v2]) {
        if (!v.tag) continue;
        const x = get(v);
        if (x.count === 0) {
          stack.push(v);
          x.count = 1;
          x.acc = this.average(v);
        }
      }
    }
    while (stack.length !== 0) {
      let si = stack.length;
      while (si--) {
        const v = stack[si]!;
        // `STACK_REMOVE`: the last one moves into the gap.
        const last = stack.pop()!;
        if (si < stack.length) stack[si] = last;
        const x = get(v);
        x.acc = f(x.acc / x.count);
        x.count = -1;
        for (const e of diskEdges(v)) {
          if (!e.tag) continue;
          const o = otherVert(e, v);
          if (!o.tag) continue;
          const y = get(o);
          if (y.count >= 0) {
            if (y.count === 0) stack.push(o);
            y.count += 1;
            y.acc = f(y.acc + x.acc);
          }
        }
      }
    }
    return t;
  }
}

/**
 * `bm_loop_customdata_merge` (`USE_LOOP_CUSTOMDATA_MERGE`, #41445), layer by
 * layer for the layers with math (UVs, colours). Ported as it is written: the
 * 0.5 mix goes into `l_b_inner_inset` and the copy that follows overwrites it
 * with `l_a_inner_inset`'s value, so the merged value is `a`'s, not the mean.
 */
function loopMerge(c: Carry, lAOuter: BL, lBOuter: BL, lAInner: BL, lBInner: BL): void {
  const isFlip = lAInner.next === lAOuter;
  const eA = isFlip ? lAInner.prev.e! : lAInner.e!;
  const eB = isFlip ? lBInner.e! : lBInner.prev.e!;
  const lAInset = edgeOtherLoop(eA, lAInner);
  const lBInset = edgeOtherLoop(eB, lBInner);
  if (lAInset.f === lBInset.f) return;

  const layers: Array<{ key: "uv" | "col"; equal: (a: number[], b: number[]) => boolean }> = [];
  if (c.has.uv)
    layers.push({
      key: "uv",
      equal: (a, b) => f(f(f(a[0]! - b[0]!) ** 2) + f(f(a[1]! - b[1]!) ** 2)) < f(0.00001),
    });
  if (c.has.col)
    layers.push({
      key: "col",
      // Bytes: the sum of squared differences under 0.001 means equal bytes.
      equal: (a, b) => a.every((x, k) => Math.round(x * 255) === Math.round(b[k]! * 255)),
    });

  const val = (l: BL, key: "uv" | "col"): number[] | undefined => c.ld.get(l)?.[key];
  const put = (l: BL, key: "uv" | "col", v: number[]): void => {
    const d = c.ld.get(l) ?? {};
    d[key] = [...v];
    c.ld.set(l, d);
  };

  for (const { key, equal } of layers) {
    const ao = val(lAOuter, key);
    const bo = val(lBOuter, key);
    if (!ao || !bo || !equal(ao, bo)) continue;
    const src = val(lAInset, key)!;
    put(lBInset, key, src);
    const shareEdge = isFlip ? lBInset.e === lAInset.prev.e : lAInset.e === lBInset.prev.e;
    if (!shareEdge) {
      const cmpA = val(lBInner, key)!;
      const cmpB = val(lAInner, key)!;
      for (const l of loopsOfVert(lAInset.v)) {
        if (!l.f.tag || l === lAInner || l === lBInner || l === lAInset || l === lBInset) continue;
        const dst = val(l, key);
        if (dst && (equal(dst, cmpA) || equal(dst, cmpB))) put(l, key, src);
      }
    }
    put(lBInner, key, src);
    put(lAInner, key, src);
  }
}

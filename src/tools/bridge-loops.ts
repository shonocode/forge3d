/**
 * Bridge Edge Loops — Blender's `bmesh.ops.bridge_loops` (`bmo_bridge.cc`,
 * with `bmesh_edgeloop.cc` and `BM_mesh_beautify_fill`), ported.
 *
 * `bridgeEdgeLoops` (the edit-mesh operator) takes exactly two loops of the
 * same length. This takes what Blender takes:
 *
 * - **any number of loops.** They are ordered the way Blender orders them —
 *   the loop furthest from the mean centre first, then each time the nearest
 *   remaining one (`BM_mesh_edgeloops_calc_order`) — and each is bridged to the
 *   next. `useCyclic` closes the chain; `usePairs` bridges 1–2, 3–4, …;
 * - **loops of different lengths.** The shorter loop's vertices are repeated
 *   to match (`BM_edgeloop_expand`, spread evenly by
 *   `BLI_FOREACH_SPARSE_RANGE`), which makes a band of quads and fan
 *   triangles; the band is then triangulated and its edges rotated by angle
 *   (`beautify_fill`, method 1) — only ever into an edge that runs from one
 *   loop to the other;
 * - open loops as well as closed ones, and the winding vote that makes the new
 *   faces agree with the faces already attached to the loops.
 *
 * What is not ported: `use_merge` (welding the loops together instead of
 * spanning them) and loop custom data (UVs are dropped).
 *
 * Pure and headless.
 */
import type { MeshData } from "../lib/mesh";
import { f, FLT_MAX, sub, dot, cross, lenSq, normalizeInPlace, type V3 } from "./blender-math";
import {
  bmFromMesh, bmToMesh, liveEdges, liveFaces, diskEdges, otherVert, edgeExists, isBoundary, faceExists,
  faceCreateVerts, faceCalcNormal, faceTriangulate, faceKill, edgeRotateCheck, loopsOfVert,
  type BM, type BV, type BE, type BF,
} from "./bmesh-lite";
import { bmBeautifyFill } from "./beautify-fill";

export interface BridgeLoopsOptions {
  /** Bridge the last loop back to the first (three or more loops). Default false. */
  useCyclic?: boolean;
  /** Bridge loops in pairs — 1–2, 3–4 — instead of as a chain. Default false. */
  usePairs?: boolean;
  /** Rotate the second loop of each closed pair by this many vertices. Default 0. */
  twistOffset?: number;
  /** Hash tables Blender used for the Mesh's edges — see `DecimateOptions.edgeTables`. */
  edgeTables?: number;
}

interface EdgeLoop {
  verts: BV[];
  closed: boolean;
  co: V3;
  no: V3;
}

const EDGELOOP_EPS = f(1e-10);

/** `BM_mesh_edgeloops_find`. */
function findLoops(bm: BM, marked: (e: BE) => boolean): EdgeLoop[] {
  const tagE = new Set<BE>();
  const tagV = new Set<BV>();
  const stack: BE[] = [];
  for (const e of liveEdges(bm))
    if (marked(e)) {
      tagE.add(e);
      tagV.add(e.v1);
      tagV.add(e.v2);
      stack.push(e);
    }
  const build = (el: EdgeLoop, vPrev: BV, v: BV | null, dir: number): boolean => {
    if (!v || !tagV.has(v)) return true;
    const vFirst = v;
    while (v) {
      if (dir === 1) el.verts.unshift(v);
      else el.verts.push(v);
      tagV.delete(v);
      let eNext: BE | null = null;
      let count = 0;
      for (const e of diskEdges(v))
        if (tagE.has(e) && otherVert(e, v) !== vPrev) {
          eNext = e;
          count++;
        }
      let vNext: BV | null = null;
      if (count === 1) {
        vNext = otherVert(eNext!, v);
        tagE.delete(eNext!);
        if (vNext === vFirst) {
          el.closed = true;
          vNext = null;
        }
      } else if (count > 1) return false;
      vPrev = v;
      v = vNext;
    }
    return true;
  };
  const loops: EdgeLoop[] = [];
  for (const e of stack) {
    if (!tagE.has(e)) continue;
    const el: EdgeLoop = { verts: [], closed: false, co: [0, 0, 0], no: [0, 0, 0] };
    if (build(el, e.v1, e.v2, 1) && build(el, e.v2, e.v1, -1) && el.verts.length > 1) loops.push(el);
  }
  return loops;
}

const lenV = (a: V3, b: V3): number => f(Math.sqrt(lenSq(sub(a, b))));

/** `BM_edgeloop_calc_center`: vertices weighted by their two edge lengths. */
function calcCenter(el: EdgeLoop): void {
  const vs = el.verts;
  const n = vs.length;
  const co = [0, 0, 0];
  let totw = 0;
  let iPrev = n - 2;
  let iCurr = n - 1;
  let iNext = 0;
  let wPrev = lenV(vs[iPrev]!.co, vs[iCurr]!.co);
  for (;;) {
    const wCurr = lenV(vs[iCurr]!.co, vs[iNext]!.co);
    const w = f(wCurr + wPrev);
    for (let k = 0; k < 3; k++) co[k] = f(co[k]! + f(vs[iCurr]!.co[k]! * w));
    totw = f(totw + w);
    wPrev = wCurr;
    iPrev = iCurr;
    iCurr = iNext;
    iNext = iNext + 1;
    if (iNext >= n) break;
  }
  if (totw !== 0) {
    const s = f(1 / totw);
    for (let k = 0; k < 3; k++) co[k] = f(co[k]! * s);
  }
  el.co = co;
}
/** `BM_edgeloop_calc_normal`: Newell over the loop. */
function calcNormal(el: EdgeLoop): void {
  const n = [0, 0, 0];
  let prev = el.verts[el.verts.length - 1]!.co;
  for (const v of el.verts) {
    const c = v.co;
    n[0] = f(n[0]! + f(f(prev[1]! - c[1]!) * f(prev[2]! + c[2]!)));
    n[1] = f(n[1]! + f(f(prev[2]! - c[2]!) * f(prev[0]! + c[0]!)));
    n[2] = f(n[2]! + f(f(prev[0]! - c[0]!) * f(prev[1]! + c[1]!)));
    prev = c;
  }
  if (normalizeInPlace(n) < EDGELOOP_EPS) n[2] = 1;
  el.no = n;
}
/** `BM_edgeloop_calc_normal_aligned`. */
function calcNormalAligned(el: EdgeLoop, align: V3): void {
  const n = [0, 0, 0];
  let prev = el.verts[el.verts.length - 1]!.co;
  for (const v of el.verts) {
    const d = sub(v.co, prev);
    const c = cross(align, d);
    const m = cross(d, c);
    for (let k = 0; k < 3; k++) n[k] = f(n[k]! + m[k]!);
    prev = v.co;
  }
  if (normalizeInPlace(n) < EDGELOOP_EPS) n[2] = 1;
  el.no = n;
}
function flip(el: EdgeLoop): void {
  el.no = el.no.map((c) => -c);
  el.verts.reverse();
}
const nextIndex = (el: EdgeLoop, i: number): number | null =>
  i + 1 < el.verts.length ? i + 1 : el.closed ? 0 : null;

/** `BM_mesh_edgeloops_calc_order`. */
function calcOrder(loops: EdgeLoop[], useNormals: boolean): EdgeLoop[] {
  const cent = [0, 0, 0];
  for (const el of loops) for (let k = 0; k < 3; k++) cent[k] = f(cent[k]! + el.co[k]!);
  const inv = f(1 / f(loops.length));
  for (let k = 0; k < 3; k++) cent[k] = f(cent[k]! * inv);
  const rest = [...loops];
  const ordered: EdgeLoop[] = [];
  let best = -1;
  let bestLen = -1;
  rest.forEach((el, i) => {
    const d = lenSq(sub(cent, el.co));
    if (d > bestLen) {
      bestLen = d;
      best = i;
    }
  });
  ordered.push(rest.splice(best, 1)[0]!);
  while (rest.length) {
    const last = ordered[ordered.length - 1]!;
    best = -1;
    bestLen = FLT_MAX;
    rest.forEach((el, i) => {
      let len: number;
      if (useNormals) {
        const d = sub(last.co, el.co);
        len = normalizeInPlace(d);
        len = f(len * f(f(1 - f(Math.abs(dot(d, last.no)))) + f(1 - f(Math.abs(dot(d, el.no))))));
      } else len = lenSq(sub(last.co, el.co));
      if (len < bestLen) {
        bestLen = len;
        best = i;
      }
    });
    ordered.push(rest.splice(best, 1)[0]!);
  }
  return ordered;
}

/** `BM_edgeloop_expand` with `split = false`: repeat vertices until `len` long. */
function expand(el: EdgeLoop, len: number): void {
  while (el.verts.length * 2 < len) el.verts = el.verts.flatMap((v) => [v, v]);
  if (el.verts.length < len) {
    const src = el.verts.length;
    const dst = len - src;
    const dup = new Set<number>();
    // BLI_FOREACH_SPARSE_RANGE(src, dst, i)
    const src2 = src * 2;
    const dst2 = dst * 2;
    let error = dst2 - src;
    let i = 0;
    for (;;) {
      const delta = Math.floor(error / dst2);
      i -= delta;
      if (!(i < src)) break;
      dup.add(i);
      error -= delta * dst2 + src2;
    }
    el.verts = el.verts.flatMap((v, k) => (dup.has(k) ? [v, v] : [v]));
  }
}

/** `bm_bridge_best_rotation`: start B where the summed pair distances are least. */
function bestRotation(a: EdgeLoop, b: EdgeLoop): void {
  const n = b.verts.length;
  let bestLen = FLT_MAX;
  let best = -1;
  for (let s = 0; s < n; s++) {
    let len = 0;
    let ia = 0;
    let ib = s;
    do len = f(len + lenV(a.verts[ia]!.co, b.verts[ib]!.co));
    while (((ib = ib + 1 < n ? ib + 1 : 0), ++ia < a.verts.length && len < bestLen));
    if (len < bestLen) {
      best = s;
      bestLen = len;
    }
  }
  if (best > 0) b.verts = [...b.verts.slice(best), ...b.verts.slice(0, best)];
}

// ── bridge_loop_pair ───────────────────────────────────────────────────────

function bridgeLoopPair(bm: BM, a: EdgeLoop, b: EdgeLoop, twistOffset: number): void {
  const eps = f(0.00001);
  const isClosed = a.closed && b.closed;
  let aLen = a.verts.length;
  let bLen = b.verts.length;
  if (aLen < bLen) {
    [aLen, bLen] = [bLen, aLen];
    [a, b] = [b, a];
  }
  if (aLen !== bLen) {
    for (const x of liveFaces(bm)) x.tag = false;
    for (const e of liveEdges(bm)) e.tag = false;
  }
  const elDir = sub(a.co, b.co);
  if (isClosed) {
    calcNormal(a);
    calcNormal(b);
  } else {
    const dirAOrig = sub(a.verts[0]!.co, a.verts[a.verts.length - 1]!.co);
    const dirBOrig = sub(b.verts[0]!.co, b.verts[b.verts.length - 1]!.co);
    const dirA = cross(cross(dirAOrig, elDir), elDir);
    const dirB = cross(cross(dirBOrig, elDir), elDir);
    const zero = (v: V3): boolean => v[0] === 0 && v[1] === 0 && v[2] === 0;
    const [ta, tb] = !zero(dirA) && !zero(dirB) ? [dirA, dirB] : [dirAOrig, dirBOrig];
    if (dot(ta, tb) < 0) flip(b);
    const no = [...elDir];
    normalizeInPlace(no);
    calcNormalAligned(a, no);
    calcNormalAligned(b, no);
  }
  const dotA = dot(a.no, elDir);
  const dotB = dot(b.no, elDir);
  if (lenSq(elDir) < eps || (Math.abs(dotA) < eps && Math.abs(dotB) < eps)) {
    if (dot(a.no, b.no) < 0) flip(b);
  } else if (dotA < 0 !== dotB < 0) {
    flip(b);
  }

  // use_merge is false: make the faces point the right way.
  {
    const no = [f(a.no[0]! + b.no[0]!), f(a.no[1]! + b.no[1]!), f(a.no[2]! + b.no[2]!)];
    if (dot(no, elDir) < 0) {
      flip(a);
      flip(b);
    }
    if (bm.totface) {
      const votes = [0, 0];
      [a, b].forEach((el, i) => {
        const dir = i === 0 ? 1 : -1;
        el.verts.forEach((v, k) => {
          const kn = nextIndex(el, k);
          if (kn === null) return;
          const e = edgeExists(v, el.verts[kn]!);
          if (e && isBoundary(e)) votes[i]! += e.l!.v === v ? dir : -dir;
        });
      });
      if (votes[0] || votes[1]) {
        const flips = [false, false];
        if (Math.abs(dotA) < eps && votes[0]! < 0) {
          flips[0] = !flips[0];
          votes[0] = -votes[0]!;
        }
        if (Math.abs(dotB) < eps && votes[1]! < 0) {
          flips[1] = !flips[1];
          votes[1] = -votes[1]!;
        }
        if (votes[0]! + votes[1]! < 0) {
          flips[0] = !flips[0];
          flips[1] = !flips[1];
        }
        if (flips[0]) flip(a);
        if (flips[1]) flip(b);
      }
    }
  }

  if (aLen > bLen) {
    b = { ...b, verts: [...b.verts], co: [...b.co], no: [...b.no] };
    expand(b, aLen);
  }
  if (isClosed) {
    bestRotation(a, b);
    if (twistOffset !== 0) {
      const n = b.verts.length;
      const k = ((twistOffset % n) + n) % n;
      b.verts = [...b.verts.slice(k), ...b.verts.slice(0, k)];
    }
  }

  // the band
  /**
   * `bm_vert_loop_pair`: the face corners on the edge v1–v2, or failing that
   * any corner at each vertex. Only the faces matter here — the first one
   * found is the example the new face copies its normal from.
   */
  const vertLoopPair = (v1: BV, v2: BV): [BF | null, BF | null] => {
    const e = edgeExists(v1, v2);
    if (e?.l) return [e.l.f, e.l.f];
    return [loopsOfVert(v1)[0]?.f ?? null, loopsOfVert(v2)[0]?.f ?? null];
  };
  let ia = 0;
  let ib = 0;
  for (;;) {
    let na: number | null;
    let nb: number | null;
    if (isClosed) {
      na = nextIndex(a, ia);
      nb = nextIndex(b, ib);
    } else {
      na = ia + 1 < a.verts.length ? ia + 1 : null;
      nb = ib + 1 < b.verts.length ? ib + 1 : null;
      if (na === null || nb === null) break;
    }
    const vA = a.verts[ia]!;
    const vB = b.verts[ib]!;
    const vANext = a.verts[na!]!;
    const vBNext = b.verts[nb!]!;
    // f_example: l_a's face, else l_b's.
    let [lA, lANext] = vertLoopPair(vA, vANext);
    let lB: BF | null;
    let lBNext: BF | null;
    if (vB !== vBNext) [lB, lBNext] = vertLoopPair(vB, vBNext);
    else lB = lBNext = loopsOfVert(vB)[0]?.f ?? null;
    if (lA && !lANext) lANext = lA;
    if (lANext && !lA) lA = lANext;
    if (lB && !lBNext) lBNext = lB;
    if (lBNext && !lB) lB = lBNext;
    const example = lA ?? lB;
    let face: BF | null = null;
    if (vB !== vBNext) {
      if (!(vB === vANext || vB === vA || vBNext === vANext || vBNext === vA)) {
        const varr = [vB, vBNext, vANext, vA];
        face = faceExists(varr) ?? faceCreateVerts(bm, varr, null);
      }
    } else if (!(vB === vANext || vB === vA)) {
      const varr = [vB, vANext, vA];
      face = faceExists(varr) ?? faceCreateVerts(bm, varr, null);
    }
    if (face) {
      if (example && example !== face) face.no = [...example.no];
      face.tag = true;
    }
    if (na === 0) break;
    ia = na!;
    ib = nb!;
  }

  if (aLen !== bLen) {
    // triangulate faces=%hf
    const tagged = liveFaces(bm).filter((x) => x.tag);
    for (const x of tagged) x.no = faceCalcNormal(x);
    for (const x of liveFaces(bm)) x.tag = false;
    for (const e of liveEdges(bm)) e.tag = false;
    for (const x of tagged) x.tag = true;
    for (let s = 0; s < bm.faces.items.length; s++) {
      const x = bm.faces.items[s];
      if (!x || x.len < 4 || !x.tag) continue;
      const out = faceTriangulate(bm, x, "beauty", "beauty", true);
      for (const d of out.doubles) faceKill(bm, d);
    }
    // tag the two sides so edges only rotate across
    for (const v of a.verts) v.tag = false;
    for (const v of b.verts) v.tag = true;
    // beautify_fill faces=%hf edges=ae use_restrict_tag method=1
    const marked = new Set(liveFaces(bm).filter((x) => x.tag && x.len === 3));
    for (const e of liveEdges(bm)) e.tag = false;
    const edgeArray = liveEdges(bm).filter(
      (e) => edgeRotateCheck(e) && marked.has(e.l!.f) && marked.has(e.l!.rn!.f),
    );
    bmBeautifyFill(bm, edgeArray, { method: "angle", restrictTag: true });
  }
}

/**
 * Bridge the loops formed by `edges` (vertex pairs), as Blender's
 * `bmesh.ops.bridge_loops` does with `use_merge` off.
 *
 * ```ts
 * // every open rim of a mesh, bridged in Blender's order
 * const out = bridgeLoops(mesh, boundaryEdges(mesh));
 * ```
 *
 * Throws when the edges do not make at least two loops (Blender's "Select at
 * least two edge loops"), or an odd number with `usePairs`.
 */
export function bridgeLoops(data: MeshData, edges: readonly (readonly [number, number])[], opts: BridgeLoopsOptions = {}): MeshData {
  const bm = bmFromMesh(data, { edgeTables: opts.edgeTables });
  const want = new Set(edges.map(([a, b]) => (a < b ? `${a},${b}` : `${b},${a}`)));
  const marked = (e: BE): boolean => want.has(e.v1.index < e.v2.index ? `${e.v1.index},${e.v2.index}` : `${e.v2.index},${e.v1.index}`);
  let loops = findLoops(bm, marked);
  for (const el of loops) calcCenter(el);
  if (loops.length < 2) throw new Error("bridgeLoops: select at least two edge loops");
  if (opts.usePairs && loops.length % 2) throw new Error("bridgeLoops: select an even number of loops to bridge pairs");
  if (loops.length > 2) {
    if (opts.usePairs) for (const el of loops) calcNormal(el);
    loops = calcOrder(loops, !!opts.usePairs);
  }
  for (let i = 0; i < loops.length; i++) {
    let next = loops[i + 1];
    if (!next) {
      if (opts.useCyclic && loops.length > 2) next = loops[0]!;
      else break;
    }
    bridgeLoopPair(bm, loops[i]!, next, opts.twistOffset ?? 0);
    if (opts.usePairs) i++;
  }
  return bmToMesh(bm);
}

/**
 * Limited Dissolve — Blender's `bmesh.ops.dissolve_limit` / `MESH_OT_dissolve_limited`
 * and the Decimate modifier's Planar mode, all `BM_mesh_decimate_dissolve_ex`
 * (`bmesh/tools/bmesh_decimate_dissolve.cc`, Blender 5.1.1), ported onto
 * `bmesh-lite` so that the heap sees BMesh's orders.
 */
import type { MeshData } from "../lib/mesh";
import { f, dot, sub, FLT_EPSILON, FLT_MAX, heapInsert, heapRemove, heapUpdate, normalizeInPlace, type Heap, type HeapNode, type V3 } from "./blender-math";
import {
  bmFromMesh,
  bmLayers,
  bmToMesh,
  diskEdges,
  diskNext,
  faceCalcNormal,
  faceLoops,
  facesJoin,
  joinEdgeKillVert,
  liveEdges,
  loopReverse,
  otherVert,
  radialLoops,
  edgeKill,
  vertKill,
  type BE,
  type BL,
  type BV,
} from "./bmesh-lite";

/** Blender's `delimit` flags. */
export type DissolveDelimit = "normal" | "material" | "seam" | "sharp" | "uv";

export interface DissolveLimitMeshOptions {
  /** `angle_limit`, radians; clamped to π/2 as the operator does. */
  angleLimit: number;
  /**
   * `delimit`: edges that stay — `normal` (faces wound against each other),
   * `material` (different materials), `seam`, `sharp`, `uv` (a UV seam; the
   * one UV layer a MeshData has — Blender checks every float2 corner layer).
   * `bmesh.ops.dissolve_limit` and the Decimate modifier default to none,
   * the edit-mode operator to `normal`.
   */
  delimit?: Iterable<DissolveDelimit>;
  /** `use_dissolve_boundaries`: dissolve every vertex left between two edges. */
  useDissolveBoundaries?: boolean;
  /** The input vertices (default all). */
  verts?: Iterable<number>;
  /** The input edges, as vertex pairs (default all). */
  edges?: Iterable<readonly [number, number]>;
}

const COST_INVALID = FLT_MAX;
const RIGHT = f((90 * Math.PI) / 180);

const saasin = (x: number): number => (x <= -1 ? f(-Math.PI / 2) : x >= 1 ? f(Math.PI / 2) : f(Math.asin(x)));
const lenV = (a: V3): number => f(Math.sqrt(dot(a, a)));
/** `angle_normalized_v3v3`, in float. */
function angleNormalized(a: V3, b: V3): number {
  if (dot(a, b) >= 0) return f(2 * saasin(f(lenV(sub(a, b)) / 2)));
  const nb: V3 = [f(-b[0]!), f(-b[1]!), f(-b[2]!)];
  return f(f(Math.PI) - f(2 * saasin(f(lenV(sub(a, nb)) / 2))));
}
/** `angle_v3v3v3`: the angle at `b`. */
function angle3(a: V3, b: V3, c: V3): number {
  const u = sub(b, a);
  const v = sub(b, c);
  normalizeInPlace(u);
  normalizeInPlace(v);
  return angleNormalized(u, v);
}

const isManifold = (e: BE): boolean => !!e.l && e.l.rn !== e.l && e.l.rn!.rn === e.l;
const isWire = (e: BE): boolean => !e.l;
/** `BM_edge_is_contiguous`: manifold, and the two faces wound the same way. */
const isContiguous = (e: BE): boolean => isManifold(e) && e.l!.v !== e.l!.rn!.v;

/** `BM_vert_edge_pair`. */
function vertEdgePair(v: BV): [BE, BE] | null {
  const e1 = v.e;
  if (!e1) return null;
  const e2 = diskNext(e1, v);
  if (e1 === e2 || diskNext(e2, v) !== e1) return null;
  return [e1, e2];
}

/**
 * Dissolve what is flatter than `angleLimit` — faces first, joined across
 * their flattest shared edge again and again (a heap of `-cos` of the angle
 * between the two faces' normals, recomputed round each new face), then the
 * vertices left between two edges, straightest first, where removing one
 * does not fold a face (`USE_DEGENERATE_CHECK`). A vertex's cost is the angle
 * its two edges turn by times the angle between the faces there, both scaled
 * to 0..1 over 90°, so a corner of a nearly flat surface goes before one of a
 * folded strip; next to a delimiting edge only the edge angle counts.
 *
 * With `useDissolveBoundaries` every input vertex between two edges goes,
 * whatever its angle. Edges delimited (see `delimit`) are never dissolved.
 *
 * Layers: joined faces keep their corners (`BM_faces_join`); a removed
 * vertex's neighbours keep theirs; materials, vertex groups and the edge
 * flags of the edges that survive are carried. The joined face's material is
 * `faces[0]`'s — the face on the edge's first loop.
 */
export function dissolveLimitMesh(data: MeshData, opts: DissolveLimitMeshOptions): MeshData {
  return dissolveCore(data, { ...opts, angleLimit: f(Math.min(f(Math.PI / 2), opts.angleLimit)) });
}

export interface DecimatePlanarOptions {
  /** `angle_limit`, radians (default 5°, as a float). Not clamped: the modifier calls the tool directly. */
  angleLimit?: number;
  /** `delimit` (default none). */
  delimit?: Iterable<DissolveDelimit>;
  /** `use_dissolve_boundaries` (default false). */
  useDissolveBoundaries?: boolean;
}

/**
 * The **Decimate modifier in Planar mode** (`MOD_decimate.cc`,
 * `BM_mesh_decimate_dissolve`): the same procedure as
 * {@link dissolveLimitMesh} over every vertex and edge, with the modifier's
 * defaults (read from Blender, `probe-decimate-planar-defaults.py`: 5°, no
 * delimit, boundaries off) and its two early outs — an angle of 0, or a mesh
 * of three faces or fewer ("Modifier requires more than 3 input faces"),
 * comes back unchanged — and without the operator's π/2 clamp.
 */
export function decimatePlanar(data: MeshData, opts: DecimatePlanarOptions = {}): MeshData {
  const angleLimit = f(opts.angleLimit ?? f((5 * Math.PI) / 180));
  if (angleLimit === 0 || data.polys.length <= 3) return dissolveCore(data, { angleLimit: 0 });
  return dissolveCore(data, { angleLimit, delimit: opts.delimit, useDissolveBoundaries: opts.useDissolveBoundaries });
}

function dissolveCore(data: MeshData, opts: DissolveLimitMeshOptions): MeshData {
  const angleLimit = f(opts.angleLimit);
  const delimit = new Set(opts.delimit ?? []);
  const bm = bmFromMesh(data);

  // Edge flags, carried on the edge objects.
  const key = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const byKey = new Map<string, BE>();
  for (const e of liveEdges(bm)) byKey.set(key(e.v1.index, e.v2.index), e);
  const sharp = new Set<BE>();
  const seam = new Set<BE>();
  const crease = new Map<BE, number>();
  for (const k of data.sharp ?? []) {
    const e = byKey.get(k);
    if (e) sharp.add(e);
  }
  for (const k of data.seams ?? []) {
    const e = byKey.get(k);
    if (e) seam.add(e);
  }
  for (const [k, c] of data.creases ?? []) {
    const e = byKey.get(k);
    if (e) crease.set(e, c);
  }

  // The input corners' UV and the faces' materials, read through `src`.
  const cornerStart: number[] = [];
  let corners = 0;
  for (const p of data.polys) {
    cornerStart.push(corners);
    corners += p.length;
  }
  const uvOf = new Map<number, number[]>();
  if (data.uvs && data.uvs.length === data.polys.length)
    data.uvs.forEach((face, fi) => face.forEach((uv, k) => uvOf.set(cornerStart[fi]! + k, uv)));
  const useUv = delimit.has("uv") && uvOf.size > 0;
  const mat = (src: number): number => (src >= 0 ? (data.materials?.[src] ?? 0) : 0);

  const uvEqual = (a: BL, b: BL): boolean => {
    const ua = uvOf.get(a.src) ?? [0, 0];
    const ub = uvOf.get(b.src) ?? [0, 0];
    const dx = f(ua[0]! - ub[0]!);
    const dy = f(ua[1]! - ub[1]!);
    return f(f(dx * dx) + f(dy * dy)) < f(0.00001);
  };
  /** `BM_edge_is_contiguous_loop_cd` for the UV layer. */
  const uvContiguous = (e: BE): boolean => {
    if (!e.l || e.l.rn === e.l) return true;
    const b1 = e.l;
    const b2 = e.l.next;
    for (let l = e.l.rn!; l !== e.l; l = l.rn!) {
      const l1 = l.v === b1.v ? l : l.next;
      const l2 = l.v === b1.v ? l.next : l;
      if (!uvEqual(b1, l1) || !uvEqual(b2, l2)) return false;
    }
    return true;
  };
  /** `bm_edge_is_delimiter` (the edge is manifold). */
  const edgeDelimits = (e: BE): boolean => {
    if (delimit.has("seam") && seam.has(e)) return true;
    if (delimit.has("sharp") && sharp.has(e)) return true;
    if (delimit.has("material") && mat(e.l!.f.src) !== mat(e.l!.rn!.f.src)) return true;
    if (delimit.has("normal") && !isContiguous(e)) return true;
    if (useUv && !uvContiguous(e)) return true;
    return false;
  };
  const vertDelimits = (v: BV): boolean => {
    if (delimit.size === 0 || !v.e) return false;
    for (const e of diskEdges(v)) if (isManifold(e) && edgeDelimits(e)) return true;
    return false;
  };
  /** `bm_edge_calc_dissolve_error`. */
  const edgeCost = (e: BE): number => {
    if (isManifold(e) && !edgeDelimits(e)) {
      let c = dot(e.l!.f.no, e.l!.rn!.f.no);
      if (isContiguous(e)) c = f(-c);
      return c;
    }
    return COST_INVALID;
  };
  /** `bm_vert_edge_face_angle`. */
  const vertCost = (v: BV): number => {
    const pair = vertEdgePair(v);
    const angle = pair ? f(f(Math.PI) - angle3(otherVert(pair[0], v).co, v.co, otherVert(pair[1], v).co)) : RIGHT;
    if (v.e && isManifold(v.e) && !vertDelimits(v)) {
      const fa = angleNormalized(v.e.l!.f.no, v.e.l!.rn!.f.no);
      const unit = f(1 / RIGHT);
      return f(f(f(angle * unit) * f(fa * unit)) * RIGHT);
    }
    return angle;
  };

  // Both in mesh order, as the operators' tagged buffers are: the heap
  // breaks ties by insertion order.
  const vinput: (BV | null)[] = opts.verts
    ? [...new Set(opts.verts)].sort((a, b) => a - b).map((i) => bm.verts[i] ?? null).filter((v): v is BV => !!v)
    : bm.verts.filter((v): v is BV => !!v);
  const einput: BE[] = [];
  if (opts.edges) {
    for (const [a, b] of opts.edges) {
      const e = byKey.get(key(a, b));
      if (e && !einput.includes(e)) einput.push(e);
    }
    einput.sort((a, b) => a.slot - b.slot);
  } else einput.push(...liveEdges(bm));

  // ── first edges ──
  const angleLimitCosNeg = f(-f(Math.cos(angleLimit)));
  const wasWire = new Set<BE>(liveEdges(bm).filter(isWire));
  {
    const heap: Heap<BE> = { tree: [] };
    const table = new Map<BE, HeapNode<BE>>();
    for (const e of einput) table.set(e, heapInsert(heap, edgeCost(e), e));
    while (heap.tree.length && heap.tree[0]!.value < angleLimitCosNeg) {
      const top = heap.tree[0]!;
      const e = top.ptr;
      let joined = false;
      if (isManifold(e)) {
        const la = e.l!;
        const lb = e.l!.rn!;
        if (la.v === lb.v) loopReverse(lb.f);
        const fNew = facesJoin(bm, [la.f, lb.f], false, true);
        if (fNew) {
          joined = true;
          heapRemove(heap, top);
          table.delete(e);
          fNew.no = faceCalcNormal(fNew);
          for (const l of faceLoops(fNew)) {
            const node = table.get(l.e!);
            if (node) heapUpdate(heap, node, edgeCost(l.e!), l.e!);
          }
        }
      }
      if (!joined) heapUpdate(heap, top, COST_INVALID, e);
    }

    // Cleanup: edges the joins left as wire go, and vertices left with nothing.
    const earray = liveEdges(bm);
    for (let i = earray.length - 1; i >= 0; i--) {
      const e = earray[i]!;
      if (!e.v1 || bm.edges.items[e.slot] !== e) continue;
      if (isWire(e) && !wasWire.has(e)) {
        const { v1, v2 } = e;
        edgeKill(bm, e);
        for (const v of [v1, v2])
          if (!v.e && bm.verts[v.index]) {
            const at = vinput.indexOf(v);
            if (at >= 0) vinput[at] = null;
            vertKill(bm, v);
          }
      }
    }
  }

  // ── second verts ──
  if (opts.useDissolveBoundaries) {
    for (const v of vinput) if (v && bm.verts[v.index] && vertEdgePair(v)) joinEdgeKillVert(bm, v.e!, v);
  } else {
    const heap: Heap<BV> = { tree: [] };
    const table = new Map<BV, HeapNode<BV>>();
    for (const v of vinput) if (v) table.set(v, heapInsert(heap, vertCost(v), v));
    while (heap.tree.length && heap.tree[0]!.value < angleLimit) {
      const top = heap.tree[0]!;
      const v = top.ptr;
      let eNew: BE | null = null;
      if (!collapseIsDegenerate(v)) {
        eNew = joinEdgeKillVert(bm, v.e!, v);
        if (eNew) {
          heapRemove(heap, top);
          table.delete(v);
          for (const l of radialLoops(eNew)) l.f.no = faceCalcNormal(l.f);
          for (const w of [eNew.v1, eNew.v2]) {
            const node = table.get(w);
            if (node) heapUpdate(heap, node, vertCost(w), w);
          }
          // Vertices that could not go may now (a do-while: a triangle's third corner once).
          for (const l of radialLoops(eNew)) {
            const stop = l.prev;
            let c = l.next.next;
            do {
              const node = table.get(c.v);
              if (node && node.value === COST_INVALID) heapUpdate(heap, node, vertCost(c.v), c.v);
            } while ((c = c.next) !== stop);
          }
        }
      }
      if (!eNew) heapUpdate(heap, top, COST_INVALID, v);
    }
  }

  // Out, with the layers.
  const out = bmToMesh(bm);
  Object.assign(out, bmLayers(bm, data));
  const remap = new Map<number, number>();
  let k = 0;
  for (const v of bm.verts) if (v) remap.set(v.index, k++);
  if (data.groups)
    out.groups = new Map(
      [...data.groups].map(([name, g]) => {
        const ng = new Map<number, number>();
        for (const [v, w] of g) {
          const nvx = remap.get(v);
          if (nvx !== undefined) ng.set(nvx, w);
        }
        return [name, ng];
      }),
    );
  const outKey = (e: BE): string => key(remap.get(e.v1.index)!, remap.get(e.v2.index)!);
  const live = new Set(liveEdges(bm));
  if (data.sharp) out.sharp = new Set([...sharp].filter((e) => live.has(e)).map(outKey));
  if (data.seams) out.seams = new Set([...seam].filter((e) => live.has(e)).map(outKey));
  if (data.creases) out.creases = new Map([...crease].filter(([e]) => live.has(e)).map(([e, c]) => [outKey(e), c]));
  return out;
}

// ── USE_DEGENERATE_CHECK ──

const cross2 = (a: number[], b: number[], c: number[]): number =>
  f(f(f(a[0]! - b[0]!) * f(b[1]! - c[1]!)) + f(f(a[1]! - b[1]!) * f(c[0]! - b[0]!)));
const signum = (x: number): number => (x > 0 ? 1 : x < 0 ? -1 : 0);
const sideOfLine = (l1: number[], l2: number[], p: number[]): number =>
  f(f(f(l1[0]! - p[0]!) * f(l2[1]! - p[1]!)) - f(f(l2[0]! - p[0]!) * f(l1[1]! - p[1]!)));
/** `isect_point_tri_v2_cw`. */
const inTriCw = (p: number[], a: number[], b: number[], c: number[]): boolean =>
  sideOfLine(a, b, p) >= 0 && sideOfLine(b, c, p) >= 0 && sideOfLine(c, a, p) >= 0;

/** `axis_dominant_v3_to_m3`'s two rows (`ortho_basis_v3v3_v3`). */
function axisRows(no: V3): [V3, V3] {
  const len2 = f(f(no[0]! * no[0]!) + f(no[1]! * no[1]!));
  if (len2 > FLT_EPSILON) {
    const d = f(1 / f(Math.sqrt(len2)));
    const n1: V3 = [f(no[1]! * d), f(-no[0]! * d), 0];
    const n2: V3 = [f(-no[2]! * n1[1]!), f(no[2]! * n1[0]!), f(f(no[0]! * n1[1]!) - f(no[1]! * n1[0]!))];
    return [n1, n2];
  }
  return [[no[2]! < 0 ? -1 : 1, 0, 0], [0, 1, 0]];
}

/** `bm_loop_collapse_is_degenerate`. */
function loopCollapseIsDegenerate(lEar: BL): boolean {
  const center = lEar.v.co;
  const [r0, r1] = axisRows(lEar.f.no);
  const to2 = (co: V3): number[] => {
    const d = sub(co, center);
    return [dot(r0, d), dot(r1, d)];
  };
  const tri = [to2(lEar.prev.v.co), [0, 0], to2(lEar.next.v.co)];
  if (!vertEdgePair(lEar.prev.v)) {
    const adj = to2(lEar.prev.prev.v.co);
    if (signum(cross2(adj, tri[0]!, tri[1]!)) !== signum(cross2(adj, tri[0]!, tri[2]!))) return true;
  }
  if (!vertEdgePair(lEar.next.v)) {
    const adj = to2(lEar.next.next.v.co);
    if (signum(cross2(adj, tri[2]!, tri[1]!)) !== signum(cross2(adj, tri[2]!, tri[0]!))) return true;
  }
  if (cross2(tri[0]!, tri[1]!, tri[2]!) < 0) [tri[1], tri[2]] = [tri[2]!, tri[1]!];
  const first = lEar.prev;
  for (let l = lEar.next.next; l !== first; l = l.next) if (inTriCw(to2(l.v.co), tri[0]!, tri[1]!, tri[2]!)) return true;
  return false;
}

/** `bm_vert_collapse_is_degenerate`: true when `v` is not between two edges, or removing it folds a face. */
function collapseIsDegenerate(v: BV): boolean {
  const pair = vertEdgePair(v);
  if (!pair) return true;
  if (isWire(pair[0]) || isWire(pair[1])) return false;
  const a = otherVert(pair[0], v).co;
  const c = otherVert(pair[1], v).co;
  const u = sub(v.co, a);
  const w = sub(v.co, c);
  normalizeInPlace(u);
  normalizeInPlace(w);
  if (Math.abs(dot(u, w)) < f(1 - FLT_EPSILON)) {
    for (const l of radialLoops(pair[1])) {
      if (l.f.len > 3) {
        const pivot = l.v === v ? l : l.next;
        if (loopCollapseIsDegenerate(pivot)) return true;
      }
    }
  }
  return false;
}

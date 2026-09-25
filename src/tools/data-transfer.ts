/**
 * Blender's **Data Transfer** modifier for vertex-group weights, with every
 * vertex mapping it has (`BKE_mesh_remap_calc_verts_from_mesh` in
 * `mesh_remap.cc`).
 *
 * The map listed `transferAttribute` / `transferSkinWeights` as this
 * modifier's counterpart ("partial") until 2026-09-25. They are not: those two
 * carry an attribute through an edit — the old vertices keep their values
 * verbatim and only the new ones sample the old surface. This is the modifier:
 * two meshes, every vertex mapped.
 *
 * | `mapping` | Blender | a target vertex takes |
 * |---|---|---|
 * | `topology` | `TOPOLOGY` | the source vertex with the same index |
 * | `nearest` (default) | `NEAREST` | the nearest source vertex |
 * | `edgeNearest` | `EDGE_NEAREST` | the nearer end of the nearest source edge |
 * | `edgeInterpolated` | `EDGEINTERP_NEAREST` | both ends of the nearest edge, blended by where the foot falls |
 * | `faceNearest` | `POLY_NEAREST` | the corner of the nearest face closest to the foot |
 * | `faceInterpolated` | `POLYINTERP_NEAREST` | every corner of the nearest face, by mean-value weights at the foot |
 * | `faceProjected` | `POLYINTERP_VNORPROJ` | the same, at the face hit by a ray along its own normal (both ways) |
 *
 * **Membership** (`vgroups_datatransfer_interp`): a target vertex joins a
 * group when **any** of its sources is in it, whatever that source's blend
 * weight; its weight is the blend of the members' weights, non-members
 * counting as nothing. With sources but none in the group, a vertex already
 * in it is kept at weight 0 and one that was not stays out. With no source at
 * all (a ray that misses) it is left as it was.
 *
 * Faces are triangulated as Blender's `corner_tris` are for quads; larger
 * faces as a fan, which agrees with Blender's polyfill only when they are
 * convex. The mean-value weights are `interp_weights_poly_v3`, with its
 * snapping to a corner or an edge when the foot lies on one.
 *
 * Pure and headless.
 */
import type { MeshData } from "../lib/mesh";
import { closestPointOnTriangleBary } from "./edit-mode/attribute-transfer";
import { faceNormalCalc, meshVertNormals, type V3 } from "./blender-math";
import { calcEdges } from "./bmesh-lite";

export type TransferMapping =
  | "topology"
  | "nearest"
  | "edgeNearest"
  | "edgeInterpolated"
  | "faceNearest"
  | "faceInterpolated"
  | "faceProjected";

export interface TransferWeightsOptions {
  /** Which groups to carry. Default every group the source has. */
  groups?: readonly string[];
  /** How a target vertex finds its source. Default `"nearest"`. */
  mapping?: TransferMapping;
}

type Vec3 = [number, number, number];
/** Source vertices and their blend weights, or null for "no source". */
type Sources = { index: number[]; weight: number[] } | null;

const FLT_EPSILON = 1.1920928955078125e-7;
const at = (P: ArrayLike<number>, v: number): Vec3 => [P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const lenSq = (a: Vec3, b: Vec3): number => dot(sub(a, b), sub(a, b));

/** `line_point_factor_v3`: where `p` falls along l1→l2 (0 when the segment is a point). */
function lineFactor(p: Vec3, l1: Vec3, l2: Vec3): number {
  const u = sub(l2, l1);
  const d = dot(u, u);
  return d > 0 ? dot(u, sub(p, l1)) / d : 0;
}

/** `dist_squared_to_line_segment_v3` */
function segmentDistSq(p: Vec3, l1: Vec3, l2: Vec3): number {
  const t = lineFactor(p, l1, l2);
  const c: Vec3 =
    t <= 0 ? l1 : t >= 1 ? l2 : [l1[0] + (l2[0] - l1[0]) * t, l1[1] + (l2[1] - l1[1]) * t, l1[2] + (l2[2] - l1[2]) * t];
  return lenSq(p, c);
}

/** `interp_weights_poly_v3`: mean-value weights, snapping to a corner or an edge. */
function meanValueWeights(v: readonly Vec3[], co: Vec3): number[] {
  const n = v.length;
  let maxValue = 0;
  for (const p of v) for (let k = 0; k < 3; k++) maxValue = Math.max(maxValue, Math.abs(p[k]! - co[k]!));
  const eps = 16 * FLT_EPSILON * maxValue;
  const epsSq = eps * eps;
  const dirOf = (p: Vec3): { dir: Vec3; len: number } => {
    const dir = sub(p, co);
    return { dir, len: Math.hypot(dir[0], dir[1], dir[2]) };
  };
  const halfTan = (a: { dir: Vec3; len: number }, b: { dir: Vec3; len: number }): number => {
    const c = cross(a.dir, b.dir);
    const area = Math.hypot(c[0], c[1], c[2]);
    if (area !== 0) {
      const r = (a.len * b.len - dot(a.dir, b.dir)) / area;
      if (Number.isFinite(r)) return r;
    }
    return 0;
  };
  const w = new Array<number>(n).fill(0);
  let total = 0;
  let iCurr = n - 1;
  let iNext = 0;
  let dCurr = dirOf(v[(n - 2 + n) % n]!);
  let dNext = dirOf(v[n - 1]!);
  let htPrev = halfTan(dCurr, dNext);
  let flag: "point" | "segment" | null = null;
  while (iNext < n) {
    if (dNext.len < eps) {
      flag = "point";
      break;
    }
    if (segmentDistSq(co, v[iCurr]!, v[iNext]!) < epsSq) {
      flag = "segment";
      break;
    }
    dCurr = dNext;
    dNext = dirOf(v[iNext]!);
    const ht = halfTan(dCurr, dNext);
    w[iCurr] = (htPrev + ht) / dCurr.len;
    total += w[iCurr]!;
    iCurr = iNext++;
    htPrev = ht;
  }
  if (flag) {
    w.fill(0);
    if (flag === "point") w[iCurr] = 1;
    else {
      const fac = Math.min(1, Math.max(0, lineFactor(co, v[iCurr]!, v[iNext]!)));
      w[iCurr] = 1 - fac;
      w[iNext] = fac;
    }
  } else if (total !== 0) for (let i = 0; i < n; i++) w[i] = w[i]! / total;
  return w;
}

/** Blender's `corner_tris` for a quad (0,1,2)(0,2,3), flipped when that diagonal is degenerate; a fan otherwise. */
function trianglesOf(P: ArrayLike<number>, polys: readonly (readonly number[])[]): { tri: Vec3; face: number }[] {
  const out: { tri: Vec3; face: number }[] = [];
  polys.forEach((poly, face) => {
    if (poly.length === 4) {
      const v1 = at(P, poly[0]!);
      const d13 = sub(at(P, poly[2]!), v1);
      const flip = dot(cross(sub(at(P, poly[1]!), v1), d13), cross(sub(at(P, poly[3]!), v1), d13)) > 0;
      if (flip) {
        out.push({ tri: [poly[0]!, poly[1]!, poly[3]!], face }, { tri: [poly[1]!, poly[2]!, poly[3]!], face });
        return;
      }
    }
    for (let i = 1; i + 1 < poly.length; i++) out.push({ tri: [poly[0]!, poly[i]!, poly[i + 1]!], face });
  });
  return out;
}

/** Möller–Trumbore, both faces; the distance along `dir`, or null. */
function rayTri(o: Vec3, dir: Vec3, a: Vec3, b: Vec3, c: Vec3): number | null {
  const e1 = sub(b, a);
  const e2 = sub(c, a);
  const p = cross(dir, e2);
  const det = dot(e1, p);
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  const s = sub(o, a);
  const u = dot(s, p) * inv;
  if (u < 0 || u > 1) return null;
  const q = cross(s, e1);
  const w = dot(dir, q) * inv;
  if (w < 0 || u + w > 1) return null;
  const t = dot(e2, q) * inv;
  return t >= 0 ? t : null;
}

export type EdgeTransferMapping = "topology" | "vertexNearest" | "nearest" | "faceNearest";

export interface TransferEdgeDataOptions {
  /** Which edge layers to carry. Default all three. */
  layers?: readonly ("sharp" | "seams" | "creases")[];
  /** How a target edge finds its source edge. Default `"nearest"`. */
  mapping?: EdgeTransferMapping;
}

/**
 * Carry edge layers — sharp, seam, crease — from `source` onto `target`:
 * Blender's Data Transfer with **edge data** (`BKE_mesh_remap_calc_edges_from_mesh`).
 *
 * | `mapping` | Blender | a target edge takes |
 * |---|---|---|
 * | `topology` | `TOPOLOGY` | the source edge with the same index (the mesh's edge order) |
 * | `vertexNearest` | `VERT_NEAREST` | of the edges at its ends' nearest source vertices, the one whose far end is closest |
 * | `nearest` (default) | `NEAREST` | the source edge nearest its midpoint |
 * | `faceNearest` | `POLY_NEAREST` | the edge of the nearest source face whose midpoint is closest to its midpoint |
 *
 * Every mapping here has one source per edge, so a flag is copied and a
 * crease is copied; a target edge with no source is left as it was.
 * `EDGEINTERP_VNORPROJ` is not offered: at Blender's default ray radius of 0
 * a ray never meets a line, and its approximate retries are a sampling scheme
 * of their own.
 *
 * Edges are numbered as Blender's `mesh_calc_edges` numbers them (face by
 * face, from each face's last corner), which `topology` and every tie depend on.
 */
export function transferEdgeData(
  target: MeshData,
  source: MeshData,
  options: TransferEdgeDataOptions = {},
): MeshData {
  const mapping = options.mapping ?? "nearest";
  const layers = new Set(options.layers ?? ["sharp", "seams", "creases"]);
  const S = source.positions;
  const T = target.positions;
  const edgesOf = (m: MeshData): [number, number][] => {
    const polys = m.polys.filter((p) => p.length >= 3);
    const out = calcEdges(polys, polys.length < 1000 ? 1 : 8);
    const seen = new Set(out.map(([a, b]) => `${a}_${b}`));
    for (const e of m.edges ?? []) {
      const a = Math.min(e[0]!, e[1]!);
      const b = Math.max(e[0]!, e[1]!);
      if (a !== b && !seen.has(`${a}_${b}`)) {
        seen.add(`${a}_${b}`);
        out.push([a, b]);
      }
    }
    return out;
  };
  const srcEdges = edgesOf(source);
  const dstEdges = edgesOf(target);
  if (mapping === "topology" && srcEdges.length !== dstEdges.length)
    throw new Error(`transferEdgeData: "topology" needs the same edge count (${dstEdges.length} and ${srcEdges.length})`);
  const mid = (P: ArrayLike<number>, [a, b]: [number, number]): Vec3 => {
    const pa = at(P, a);
    const pb = at(P, b);
    return [(pa[0] + pb[0]) * 0.5, (pa[1] + pb[1]) * 0.5, (pa[2] + pb[2]) * 0.5];
  };

  // `vert_to_edge_map`: edges around each source vertex, in edge order.
  const around = new Map<number, number[]>();
  srcEdges.forEach(([a, b], i) => {
    for (const v of [a, b]) {
      const list = around.get(v);
      if (list) list.push(i);
      else around.set(v, [i]);
    }
  });
  const tris = mapping === "faceNearest" ? trianglesOf(S, source.polys) : [];
  const srcEdgeIndex = new Map(srcEdges.map(([a, b], i) => [`${a}_${b}`, i]));

  // `mesh_remap_bvhtree_query_nearest` keeps the previous answer on a tie.
  let prevVert = -1;
  const nearestVert = (p: Vec3): number => {
    let s = prevVert;
    let best = prevVert >= 0 ? lenSq(at(S, prevVert), p) : Infinity;
    for (let i = 0; i < S.length / 3; i++) {
      const d = lenSq(at(S, i), p);
      if (d < best) {
        best = d;
        s = i;
      }
    }
    prevVert = s;
    return s;
  };
  const vertCache = new Map<number, { src: number; dist: number }>();
  let prevEdge = -1;

  const sourceOf: number[] = dstEdges.map((edge, i) => {
    if (mapping === "topology") return i;
    if (mapping === "nearest") {
      const m = mid(T, edge);
      let e = prevEdge;
      let best = prevEdge >= 0 ? segmentDistSq(m, at(S, srcEdges[prevEdge]![0]), at(S, srcEdges[prevEdge]![1])) : Infinity;
      srcEdges.forEach(([a, b], k) => {
        const d = segmentDistSq(m, at(S, a), at(S, b));
        if (d < best) {
          best = d;
          e = k;
        }
      });
      prevEdge = e;
      return e;
    }
    if (mapping === "vertexNearest") {
      // j = 1 then 0: the edge's first vertex, then its second.
      for (const vd of [edge[0], edge[1]])
        if (!vertCache.has(vd)) {
          const src = nearestVert(at(T, vd));
          vertCache.set(vd, { src, dist: src >= 0 ? Math.sqrt(lenSq(at(S, src), at(T, vd))) : Infinity });
        }
      let bestTotal = Infinity;
      let bestEdge = -1;
      for (const [vd, other] of [
        [edge[0], edge[1]],
        [edge[1], edge[0]],
      ] as const) {
        const hit = vertCache.get(vd)!;
        if (hit.src < 0) continue;
        for (const k of around.get(hit.src) ?? []) {
          const [a, b] = srcEdges[k]!;
          const otherSrc = a === hit.src ? b : a;
          const total = hit.dist + Math.sqrt(lenSq(at(S, otherSrc), at(T, other)));
          if (total < bestTotal) {
            bestTotal = total;
            bestEdge = k;
          }
        }
      }
      return bestEdge;
    }
    // faceNearest: the nearest face to the midpoint, then its closest edge.
    const m = mid(T, edge);
    let best = Infinity;
    let face = -1;
    for (const { tri, face: f } of tris) {
      const r = closestPointOnTriangleBary(m[0], m[1], m[2], ...at(S, tri[0]), ...at(S, tri[1]), ...at(S, tri[2]));
      if (r.dist2 < best) {
        best = r.dist2;
        face = f;
      }
    }
    if (face < 0) return -1;
    const poly = source.polys[face]!;
    let bestD = Infinity;
    let bestEdge = -1;
    for (let c = 0; c < poly.length; c++) {
      const a = poly[c]!;
      const b = poly[(c + 1) % poly.length]!;
      const k = srcEdgeIndex.get(a < b ? `${a}_${b}` : `${b}_${a}`)!;
      const d = lenSq(m, mid(S, srcEdges[k]!));
      if (d < bestD) {
        bestD = d;
        bestEdge = k;
      }
    }
    return bestEdge;
  });

  const key = ([a, b]: [number, number]): string => `${a}_${b}`;
  const out: MeshData = { ...target };
  if (layers.has("sharp")) {
    const sharp = new Set(target.sharp ?? []);
    dstEdges.forEach((e, i) => {
      const s = sourceOf[i]!;
      if (s < 0) return;
      if (source.sharp?.has(key(srcEdges[s]!))) sharp.add(key(e));
      else sharp.delete(key(e));
    });
    out.sharp = sharp;
  }
  if (layers.has("seams")) {
    const seams = new Set(target.seams ?? []);
    dstEdges.forEach((e, i) => {
      const s = sourceOf[i]!;
      if (s < 0) return;
      if (source.seams?.has(key(srcEdges[s]!))) seams.add(key(e));
      else seams.delete(key(e));
    });
    out.seams = seams;
  }
  if (layers.has("creases")) {
    const creases = new Map(target.creases ?? []);
    dstEdges.forEach((e, i) => {
      const s = sourceOf[i]!;
      if (s < 0) return;
      const c = source.creases?.get(key(srcEdges[s]!)) ?? 0;
      if (c !== 0) creases.set(key(e), c);
      else creases.delete(key(e));
    });
    out.creases = creases;
  }
  return out;
}

/**
 * Give every vertex of `target` vertex-group weights from `source` — Blender's
 * Data Transfer, `VGROUP_WEIGHTS`, groups matched by name, mix mode Replace at
 * factor 1, with the vertex mapping named by `options.mapping`.
 *
 * ```ts
 * const rigged = transferWeights(lod, fullDetail);                              // nearest vertex
 * const smooth = transferWeights(lod, fullDetail, { mapping: "faceInterpolated" }); // blended
 * ```
 *
 * The meshes are compared in their own coordinates — place them first.
 * Groups the target has that are not carried are left as they were.
 */
export function transferWeights(
  target: MeshData,
  source: MeshData,
  options: TransferWeightsOptions = {},
): MeshData {
  const mapping = options.mapping ?? "nearest";
  const S = source.positions;
  const T = target.positions;
  const ns = S.length / 3;
  const nt = T.length / 3;
  if (mapping === "topology" && ns !== nt)
    throw new Error(`transferWeights: "topology" needs the same vertex count (${nt} and ${ns})`);

  const sources: Sources[] = [];
  const edges: [number, number][] = [];
  if (mapping === "edgeNearest" || mapping === "edgeInterpolated") {
    const seen = new Set<string>();
    const add = (a: number, b: number): void => {
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (a === b || seen.has(k)) return;
      seen.add(k);
      edges.push([Math.min(a, b), Math.max(a, b)]);
    };
    for (const poly of source.polys)
      for (let i = 0; i < poly.length; i++) add(poly[i]!, poly[(i + 1) % poly.length]!);
    for (const e of source.edges ?? []) add(e[0]!, e[1]!);
  }
  const tris =
    mapping === "faceNearest" || mapping === "faceInterpolated" || mapping === "faceProjected"
      ? trianglesOf(S, source.polys)
      : [];
  const targetNormals =
    mapping === "faceProjected"
      ? meshVertNormals(Array.from({ length: nt }, (_, v) => at(T, v) as V3), target.polys)
      : null;

  /** Weights over the corners of source face `face` at `point`, or its closest corner. */
  const faceSources = (face: number, point: Vec3, interpolate: boolean): Sources => {
    const poly = source.polys[face]!;
    const cos = poly.map((v) => at(S, v));
    if (interpolate) return { index: [...poly], weight: meanValueWeights(cos, point) };
    let best = Infinity;
    let closest = poly[0]!;
    poly.forEach((v, i) => {
      const d = lenSq(point, cos[i]!);
      if (d < best) {
        best = d;
        closest = v;
      }
    });
    return { index: [closest], weight: [1] };
  };

  let prevEdge: [number, number] | null = null;
  let prevVert = -1;
  for (let v = 0; v < nt; v++) {
    const p = at(T, v);
    if (mapping === "topology") {
      sources.push({ index: [v], weight: [1] });
    } else if (mapping === "nearest") {
      // As with the edges: the previous vertex's source is kept on a tie.
      let s = prevVert;
      let best = prevVert >= 0 ? lenSq(at(S, prevVert), p) : Infinity;
      for (let i = 0; i < ns; i++) {
        const d = lenSq(at(S, i), p);
        if (d < best) {
          best = d;
          s = i;
        }
      }
      prevVert = s;
      sources.push(s < 0 ? null : { index: [s], weight: [1] });
    } else if (mapping === "edgeNearest" || mapping === "edgeInterpolated") {
      // `mesh_remap_bvhtree_query_nearest` starts from the previous vertex's
      // edge and only moves for one strictly closer, so a tie keeps it. That
      // matters here: at a foot on a shared vertex every edge gives the same
      // weight, but membership also comes from the edge's far end.
      let e: [number, number] | null = prevEdge;
      let best = prevEdge ? segmentDistSq(p, at(S, prevEdge[0]), at(S, prevEdge[1])) : Infinity;
      for (const edge of edges) {
        const d = segmentDistSq(p, at(S, edge[0]), at(S, edge[1]));
        if (d < best) {
          best = d;
          e = edge;
        }
      }
      prevEdge = e;
      if (!e) {
        sources.push(null);
        continue;
      }
      const v1 = at(S, e[0]);
      const v2 = at(S, e[1]);
      if (mapping === "edgeNearest") sources.push({ index: [lenSq(p, v1) > lenSq(p, v2) ? e[1] : e[0]], weight: [1] });
      else {
        // "Weight is inverse of point factor here": measured from the second end.
        const w0 = Math.min(1, Math.max(0, lineFactor(p, v2, v1)));
        sources.push({ index: [e[0], e[1]], weight: [w0, 1 - w0] });
      }
    } else if (mapping === "faceProjected") {
      const n: Vec3 = [...targetNormals![v]!] as Vec3;
      let bestT = Infinity;
      let hit: { face: number; t: number; dir: Vec3 } | null = null;
      for (const dir of [n, [-n[0], -n[1], -n[2]] as Vec3])
        for (const { tri, face } of tris) {
          const t = rayTri(p, dir, at(S, tri[0]), at(S, tri[1]), at(S, tri[2]));
          if (t !== null && t < bestT) {
            bestT = t;
            hit = { face, t, dir };
          }
        }
      if (!hit) {
        sources.push(null);
        continue;
      }
      const point: Vec3 = [p[0] + hit.dir[0] * hit.t, p[1] + hit.dir[1] * hit.t, p[2] + hit.dir[2] * hit.t];
      sources.push(faceSources(hit.face, point, true));
    } else {
      let best = Infinity;
      let face = -1;
      let point: Vec3 = [0, 0, 0];
      for (const { tri, face: f } of tris) {
        const a = at(S, tri[0]);
        const b = at(S, tri[1]);
        const c = at(S, tri[2]);
        const r = closestPointOnTriangleBary(p[0], p[1], p[2], ...a, ...b, ...c);
        if (r.dist2 < best) {
          best = r.dist2;
          face = f;
          point = [
            a[0] * r.u + b[0] * r.v + c[0] * r.w,
            a[1] * r.u + b[1] * r.v + c[1] * r.w,
            a[2] * r.u + b[2] * r.v + c[2] * r.w,
          ];
        }
      }
      sources.push(face < 0 ? null : faceSources(face, point, mapping === "faceInterpolated"));
    }
  }

  const names = options.groups ?? [...(source.groups?.keys() ?? [])];
  const groups = new Map(target.groups ?? []);
  for (const name of names) {
    const from = source.groups?.get(name);
    if (!from) continue;
    const to = new Map(groups.get(name) ?? []);
    for (let v = 0; v < nt; v++) {
      const src = sources[v];
      if (!src) continue;
      let weight = 0;
      let member = false;
      src.index.forEach((s, i) => {
        const w = from.get(s);
        if (w === undefined) return;
        member = true;
        weight += w * src.weight[i]!;
      });
      // No member source: a vertex already in the group stays in it at 0
      // (`dw_dst->weight = weight_src`), one that was not is not added.
      if (!member) {
        if (to.has(v)) to.set(v, 0);
        continue;
      }
      to.set(v, Math.min(1, Math.max(0, weight)));
    }
    groups.set(name, to);
  }
  return { ...target, groups };
}

export type LoopTransferMapping =
  | "topology"
  | "cornerNormal"
  | "faceNormal"
  | "faceNearest"
  | "faceInterpolated"
  | "faceProjected";

export interface TransferLoopDataOptions {
  /** Which corner layers to carry. Default both. */
  layers?: readonly ("uvs" | "colors")[];
  /** How a target corner finds its source. Default `"faceNormal"`, Blender's. */
  mapping?: LoopTransferMapping;
}

/**
 * Carry face-corner layers — UVs and colours — from `source` onto `target`:
 * Blender's Data Transfer with **face corner data**
 * (`BKE_mesh_remap_calc_loops_from_mesh`), mix mode Replace at factor 1.
 *
 * | `mapping` | Blender | a target corner takes |
 * |---|---|---|
 * | `topology` | `TOPOLOGY` | the source corner with the same index |
 * | `cornerNormal` | `NEAREST_NORMAL` | at the nearest source vertex, the corner whose normal is closest to its own |
 * | `faceNormal` (default) | `NEAREST_POLYNOR` | at the nearest source vertex, the corner of the face whose normal is closest to its face's |
 * | `faceNearest` | `NEAREST_POLY` | the corner of the nearest source face closest to the foot |
 * | `faceInterpolated` | `POLYINTERP_NEAREST` | every corner of the nearest face, by mean-value weights at the foot |
 * | `faceProjected` | `POLYINTERP_LNORPROJ` | the same, at the face hit by a ray along the corner's normal (both ways); the nearest face when it misses |
 *
 * **UVs go island by island.** The source is cut into islands at its seams
 * (`BKE_mesh_calc_islands_loop_face_edgeseam`: faces joined across every
 * edge that is not a seam). Each target face tries every island on its own —
 * the nearest vertex or face *within* that island — and takes the island
 * whose corners scored best on average (`1 / distance`, times `(dot + 1) / 2`
 * for the two normal mappings), so one face never draws from both sides of a
 * seam. Colours have no islands; the whole source is one.
 *
 * The rest is Blender's too: a tie of normals (within 1e-6) goes to the face
 * whose centre is closer; values are a weighted sum (colours as floats); a
 * corner that finds no source keeps what it had, and a target with no layer
 * gets one of zeros.
 *
 * Not ported, and why:
 *
 * - **Island precision** (`islands_precision`, an A* walk that stops a face's
 *   corners from straddling a cut) — it is 0 by default, and at 0 Blender
 *   skips the walk entirely.
 * - **Custom normals** as a layer: Blender re-bakes them into its 16-bit
 *   corner spaces afterwards (`normals_corner_custom_set`), a second port.
 * - **Smooth shading.** `MeshData` has no smooth flag, so a corner's normal is
 *   its face's — Blender's flat faces, which is what an OBJ without `s` lines
 *   imports as — unless `normals` gives one.
 *
 * Nearest queries do not keep the previous answer here — Blender resets it
 * for every corner — so an exact tie between two source elements is decided
 * by Blender's BVH order, which this does not follow (the lowest index wins).
 */
export function transferLoopData(
  target: MeshData,
  source: MeshData,
  options: TransferLoopDataOptions = {},
): MeshData {
  const mapping = options.mapping ?? "faceNormal";
  const layers = new Set(options.layers ?? ["uvs", "colors"]);
  const S = source.positions;
  const T = target.positions;
  const ns = S.length / 3;
  const srcPolys = source.polys;
  const dstPolys = target.polys;
  const srcCornerCount = srcPolys.reduce((n, p) => n + p.length, 0);
  const dstCornerCount = dstPolys.reduce((n, p) => n + p.length, 0);
  if (mapping === "topology" && srcCornerCount !== dstCornerCount)
    throw new Error(
      `transferLoopData: "topology" needs the same corner count (${dstCornerCount} and ${srcCornerCount})`,
    );

  const srcStart: number[] = [];
  const srcCornerFace: number[] = [];
  const srcCornerVert: number[] = [];
  srcPolys.forEach((p, f) => {
    srcStart.push(srcCornerVert.length);
    for (const v of p) {
      srcCornerFace.push(f);
      srcCornerVert.push(v);
    }
  });

  const SP: V3[] = Array.from({ length: ns }, (_, v) => at(S, v));
  const TP: V3[] = Array.from({ length: T.length / 3 }, (_, v) => at(T, v));
  const srcFaceNormals = srcPolys.map((p) => faceNormalCalc(SP, p));
  const dstFaceNormals = dstPolys.map((p) => faceNormalCalc(TP, p));
  const cornerNormal = (m: MeshData, faceNormals: V3[], f: number, i: number): Vec3 => {
    const n = m.normals?.[f]?.[i];
    const face = faceNormals[f]!;
    return n ? [n[0]!, n[1]!, n[2]!] : [face[0]!, face[1]!, face[2]!];
  };
  /** `face_center_calc`: the mean of the corners. */
  const centre = (P: readonly V3[], poly: readonly number[]): Vec3 => {
    const c: Vec3 = [0, 0, 0];
    for (const v of poly) for (let k = 0; k < 3; k++) c[k] = c[k]! + P[v]![k]!;
    return [c[0] / poly.length, c[1] / poly.length, c[2] / poly.length];
  };
  const srcCentres = srcPolys.map((p) => centre(SP, p));
  const useFromVert = mapping === "cornerNormal" || mapping === "faceNormal";

  /** Nearest triangle of `tris` to `p`: its face, squared distance and foot. */
  const nearestTri = (
    tris: readonly { tri: Vec3; face: number }[],
    p: Vec3,
  ): { face: number; d2: number; point: Vec3 } | null => {
    let best = Infinity;
    let face = -1;
    let point: Vec3 = [0, 0, 0];
    for (const { tri, face: f } of tris) {
      const a = at(S, tri[0]);
      const b = at(S, tri[1]);
      const c = at(S, tri[2]);
      const r = closestPointOnTriangleBary(p[0], p[1], p[2], ...a, ...b, ...c);
      if (r.dist2 < best) {
        best = r.dist2;
        face = f;
        point = [
          a[0] * r.u + b[0] * r.v + c[0] * r.w,
          a[1] * r.u + b[1] * r.v + c[1] * r.w,
          a[2] * r.u + b[2] * r.v + c[2] * r.w,
        ];
      }
    }
    return face < 0 ? null : { face, d2: best, point };
  };

  /** A source per target corner, in source corner indices and weights. */
  const sourcesFor = (withIslands: boolean): Sources[] => {
    const out: Sources[] = new Array<Sources>(dstCornerCount).fill(null);
    if (mapping === "topology") {
      for (let c = 0; c < dstCornerCount; c++) out[c] = { index: [c], weight: [1] };
      return out;
    }

    // Islands: faces joined across non-seam edges, numbered from the lowest face.
    const island = new Array<number>(srcPolys.length).fill(0);
    let islandCount = 1;
    if (withIslands) {
      island.fill(-1);
      const key = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);
      const edgeFaces = new Map<string, number[]>();
      srcPolys.forEach((p, f) =>
        p.forEach((v, i) => {
          const k = key(v, p[(i + 1) % p.length]!);
          const list = edgeFaces.get(k);
          if (list) list.push(f);
          else edgeFaces.set(k, [f]);
        }),
      );
      islandCount = 0;
      for (let seed = 0; seed < srcPolys.length; seed++) {
        if (island[seed]! >= 0) continue;
        const id = islandCount++;
        island[seed] = id;
        const stack = [seed];
        for (let s = 0; s < stack.length; s++) {
          const p = srcPolys[stack[s]!]!;
          p.forEach((v, i) => {
            const k = key(v, p[(i + 1) % p.length]!);
            if (source.seams?.has(k)) return;
            for (const g of edgeFaces.get(k)!)
              if (island[g]! < 0) {
                island[g] = id;
                stack.push(g);
              }
          });
        }
      }
    }

    const islandVerts: number[][] = Array.from({ length: islandCount }, () => []);
    const islandTris: { tri: Vec3; face: number }[][] = Array.from({ length: islandCount }, () => []);
    const vertCorners: number[][] = Array.from({ length: ns }, () => []);
    if (useFromVert) {
      const seen = Array.from({ length: islandCount }, () => new Uint8Array(ns));
      srcPolys.forEach((p, f) => {
        for (const v of p)
          if (!seen[island[f]!]![v]) {
            seen[island[f]!]![v] = 1;
            islandVerts[island[f]!]!.push(v);
          }
      });
      for (const list of islandVerts) list.sort((a, b) => a - b);
      srcCornerVert.forEach((v, c) => vertCorners[v]!.push(c));
    } else for (const t of trianglesOf(S, srcPolys)) islandTris[island[t.face]!]!.push(t);

    type Hit = { factor: number; index: number; point: Vec3 };
    const none: Hit = { factor: 0, index: -1, point: [0, 0, 0] };
    /** One target corner against one island (`islands_res[tindex][plidx_dst]`). */
    const hitIn = (t: number, f: number, i: number, dstCentre: () => Vec3): Hit => {
      const p = at(T, dstPolys[f]![i]!);
      if (useFromVert) {
        let nearest = -1;
        let best = Infinity;
        for (const v of islandVerts[t]!) {
          const d = lenSq(at(S, v), p);
          if (d < best) {
            best = d;
            nearest = v;
          }
        }
        if (nearest < 0) return none;
        const hitDist = Math.sqrt(best);
        const perCorner = mapping === "cornerNormal";
        const nDst = perCorner ? cornerNormal(target, dstFaceNormals, f, i) : (dstFaceNormals[f]! as Vec3);
        // `vert_to_corner_map` / `vert_to_face_map`, both in index order.
        const refs = perCorner
          ? vertCorners[nearest]!
          : [...new Set(vertCorners[nearest]!.map((c) => srcCornerFace[c]!))];
        let bestDot = -2;
        let bestFallback = Infinity;
        let bestIndex = -1;
        for (const r of refs) {
          const face = perCorner ? srcCornerFace[r]! : r;
          if (island[face] !== t) continue;
          const nSrc = perCorner
            ? cornerNormal(source, srcFaceNormals, face, r - srcStart[face]!)
            : (srcFaceNormals[face]! as Vec3);
          const d = dot(nSrc, nDst);
          if (d > bestDot - 1e-6) {
            const sq = lenSq(dstCentre(), srcCentres[face]!);
            if (d > bestDot + 1e-6 || sq < bestFallback) {
              bestDot = d;
              bestFallback = sq;
              bestIndex = r;
            }
          }
        }
        if (bestIndex < 0) return none;
        if (!perCorner) bestIndex = srcStart[bestIndex]! + srcPolys[bestIndex]!.indexOf(nearest);
        const score = (bestDot + 1) * 0.5;
        return { factor: hitDist ? score / hitDist : 1e18, index: bestIndex, point: [0, 0, 0] };
      }
      if (mapping === "faceProjected") {
        const n = cornerNormal(target, dstFaceNormals, f, i);
        let bestT = Infinity;
        let hit: { face: number; dir: Vec3 } | null = null;
        for (const dir of [n, [-n[0], -n[1], -n[2]] as Vec3])
          for (const { tri, face } of islandTris[t]!) {
            const d = rayTri(p, dir, at(S, tri[0]), at(S, tri[1]), at(S, tri[2]));
            if (d !== null && d < bestT) {
              bestT = d;
              hit = { face, dir };
            }
          }
        if (hit) {
          const point: Vec3 = [p[0] + hit.dir[0] * bestT, p[1] + hit.dir[1] * bestT, p[2] + hit.dir[2] * bestT];
          return { factor: bestT ? 1 / bestT : 1e18, index: hit.face, point };
        }
        // The nearest face instead, with no say in which island wins.
        const near = nearestTri(islandTris[t]!, p);
        return near ? { factor: 0, index: near.face, point: near.point } : none;
      }
      const near = nearestTri(islandTris[t]!, p);
      if (!near) return none;
      const hitDist = Math.sqrt(near.d2);
      return { factor: hitDist ? 1 / hitDist : 1e18, index: near.face, point: near.point };
    };

    let corner = 0;
    dstPolys.forEach((poly, f) => {
      let cached: Vec3 | null = null;
      const dstCentre = (): Vec3 => (cached ??= centre(TP, poly));
      const results = Array.from({ length: islandCount }, (_, t) => poly.map((_, i) => hitIn(t, f, i, dstCentre)));
      let bestIsland = -1;
      let bestFactor = 0;
      results.forEach((row, t) => {
        const mean = row.reduce((s, h) => s + h.factor, 0) / poly.length;
        if (mean > bestFactor) {
          bestFactor = mean;
          bestIsland = t;
        }
      });
      poly.forEach((_, i) => {
        const hit = bestIsland < 0 ? none : results[bestIsland]![i]!;
        const c = corner + i;
        if (hit.index < 0) return;
        if (useFromVert) {
          out[c] = { index: [hit.index], weight: [1] };
          return;
        }
        const spoly = srcPolys[hit.index]!;
        const corners = spoly.map((_, k) => srcStart[hit.index]! + k);
        if (mapping === "faceNearest") {
          let best = Infinity;
          let closest = corners[0]!;
          spoly.forEach((v, k) => {
            const d = lenSq(hit.point, at(S, v));
            if (d < best) {
              best = d;
              closest = corners[k]!;
            }
          });
          out[c] = { index: [closest], weight: [1] };
        } else
          out[c] = {
            index: corners,
            weight: meanValueWeights(
              spoly.map((v) => at(S, v)),
              hit.point,
            ),
          };
      });
      corner += poly.length;
    });
    return out;
  };

  /** Blend the source layer into a new target layer; corners with no source keep theirs. */
  const carry = (
    from: readonly (readonly (readonly number[])[])[],
    to: readonly (readonly (readonly number[])[])[] | undefined,
    width: number,
    sources: Sources[],
  ): number[][][] => {
    const flat = from.flat();
    let c = 0;
    return dstPolys.map((poly, f) =>
      poly.map((_, i) => {
        const s = sources[c++];
        const old = to?.[f]?.[i];
        if (!s) return old ? [...old] : new Array<number>(width).fill(0);
        const value = new Array<number>(width).fill(0);
        s.index.forEach((k, j) => {
          const src = flat[k]!;
          for (let d = 0; d < width; d++) value[d] = value[d]! + src[d]! * s.weight[j]!;
        });
        return value;
      }),
    );
  };

  const out: MeshData = { ...target };
  if (layers.has("uvs") && source.uvs) out.uvs = carry(source.uvs, target.uvs, 2, sourcesFor(true));
  if (layers.has("colors") && source.colors) out.colors = carry(source.colors, target.colors, 4, sourcesFor(false));
  return out;
}

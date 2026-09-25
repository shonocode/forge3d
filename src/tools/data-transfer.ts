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
import { meshVertNormals, type V3 } from "./blender-math";

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

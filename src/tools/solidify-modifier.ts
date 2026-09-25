/**
 * Blender's **Solidify modifier**, Simple mode — a port of
 * `source/blender/modifiers/intern/MOD_solidify_extrude.cc` at `v5.1.1`
 * (compat-backlog B3).
 *
 * Not {@link solidify} in `mesh-ops.ts`, which is `bmesh.ops.solidify` — a
 * different operator with a different rule. This is what the modifier does,
 * with its defaults: thickness 0.01, offset −1 (the shell grows inward from
 * the surface), **even thickness off**, rim on.
 *
 * The result is the input, then (with a shell) a copy of every vertex and a
 * copy of every face turned round (first corner kept), then one rim quad per
 * boundary edge. Each half is moved along the vertex normals by its share of
 * the thickness (`offset` splits it), scaled for even thickness by the
 * corners' angle-weighted `1 / cos` and cut down near short edges by
 * `thicknessClamp`.
 *
 * Complex mode (`MOD_solidify_nonmanifold.cc`) is compat-backlog C30. Custom
 * normals are dropped: Blender keeps the copies' two angles and reads them in
 * the turned faces' normal spaces (C29).
 */
import type { MeshData } from "../lib/mesh";
import { faceNormalCalc, meshVertNormals, type V3 } from "./blender-math";
import { seamKey } from "./edit-mode/half-edge";

/** Blender's Solidify modifier settings (Simple mode), with its defaults. */
export interface SolidifyModifierOptions {
  /** `thickness`. Default 0.01. */
  thickness?: number;
  /** `offset`, −1 … 1: where the shell sits against the surface. Default −1 (inside). */
  offset?: number;
  /** `use_even_offset`. Default off. */
  evenThickness?: boolean;
  /** `use_quality_normals`: vertex normals from the edges, each the angle-weighted mean of its two faces. */
  qualityNormals?: boolean;
  /** `use_rim`. Default on. */
  rim?: boolean;
  /** `use_rim_only`: no shell, the rim alone. */
  rimOnly?: boolean;
  /** `use_flip_normals`. */
  flip?: boolean;
  /** `thickness_clamp`: at most this many times the shortest edge at a vertex. Default 0 (off). */
  thicknessClamp?: number;
  /** `use_thickness_angle_clamp`. */
  angleClamp?: boolean;
  /**
   * `material_offset` / `material_offset_rim`. Blender clamps to the object's
   * material slots; a `MeshData` has no slot count, so these clamp to the
   * highest index a face uses (found by review).
   */
  materialOffset?: number;
  materialOffsetRim?: number;
  /** `edge_crease_inner` / `_outer` / `_rim`. */
  creaseInner?: number;
  creaseOuter?: number;
  creaseRim?: number;
  /** `vertex_group` (by name), `invert_vertex_group`, `thickness_vertex_group`. */
  vertexGroup?: string;
  invertVertexGroup?: boolean;
  vertexGroupFactor?: number;
  /** `shell_vertex_group` / `rim_vertex_group`: groups the new shell / rim vertices go into at 1. */
  shellVertexGroup?: string;
  rimVertexGroup?: string;
}

const f = Math.fround;
const FLT_EPSILON = 1.1920929e-7;
const INVALID_UNUSED = -1;
const INVALID_PAIR = -2;

const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cross = (a: readonly number[], b: readonly number[]): V3 => [
  a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!,
];
function normalize(a: number[]): number {
  const l = Math.hypot(a[0]!, a[1]!, a[2]!);
  if (l > 1e-35) {
    a[0] = a[0]! / l;
    a[1] = a[1]! / l;
    a[2] = a[2]! / l;
  } else {
    a[0] = a[1] = a[2] = 0;
  }
  return l > 1e-35 ? l : 0;
}
const safeAsin = (x: number): number => Math.asin(Math.max(-1, Math.min(1, x)));
/** `angle_normalized_v3v3`. */
function angleNormalized(a: readonly number[], b: readonly number[]): number {
  if (dot(a, b) >= 0) return 2 * safeAsin(Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!) / 2);
  return Math.PI - 2 * safeAsin(Math.hypot(a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!) / 2);
}
/** `angle_v3v3`: normalises copies first. */
function angleV3(a: readonly number[], b: readonly number[]): number {
  const x = [...a];
  const y = [...b];
  normalize(x);
  normalize(y);
  return angleNormalized(x, y);
}
/** `angle_signed_on_axis_v3v3_v3`. */
function angleSignedOnAxis(v1: readonly number[], v2: readonly number[], axis: readonly number[]): number {
  const proj = (v: readonly number[]): V3 => {
    const d = dot(v, axis);
    return [v[0]! - axis[0]! * d, v[1]! - axis[1]! * d, v[2]! - axis[2]! * d];
  };
  const p1 = proj(v1);
  const p2 = proj(v2);
  let angle = angleV3(p1, p2);
  if (dot(cross(p2, p1), axis) < 0) angle = Math.PI * 2 - angle;
  return angle;
}
/** `shell_v3v3_normalized_to_dist`. */
function shellToDist(a: readonly number[], b: readonly number[]): number {
  const c = Math.abs(dot(a, b));
  return c < 1e-8 ? 1 : 1 / c;
}
/**
 * `mid_v3_v3v3_angle_weighted`. The `min(1, …)` is not Blender's: two
 * coplanar faces can round |a + b| / 2 a hair above 1, where Blender's
 * `acosf` gives NaN and the vertex goes nowhere sensible — kept out on
 * purpose (found by review).
 */
function midAngleWeighted(a: readonly number[], b: readonly number[]): V3 {
  const r = [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
  const angle = (2 / Math.PI) * 2 * Math.acos(Math.min(1, normalize(r) / 2));
  return [r[0]! * angle, r[1]! * angle, r[2]! * angle];
}

/**
 * Blender's Solidify modifier, Simple mode — see the file's header. Layers:
 * UVs, colours, vertex groups, materials, creases, seams and sharp edges
 * carry (the copies copy, the rim quads take their face's corners);
 * custom normals are dropped.
 */
export function solidifyModifier(data: MeshData, opts: SolidifyModifierOptions = {}): MeshData {
  const P0 = data.positions;
  const V = P0.length / 3;
  const polys = data.polys.filter((p) => p.length >= 3);
  const keptFace = data.polys.map((p, i) => (p.length >= 3 ? i : -1)).filter((i) => i >= 0);
  const F = polys.length;

  const thickness = opts.thickness ?? 0.01;
  const offsetFac = opts.offset ?? -1;
  const ofsOrig = f(-(((-offsetFac + 1) * 0.5) * thickness));
  const ofsNew = f(thickness + ofsOrig);
  const doFlip = !!opts.flip;
  const clampF = opts.thicknessClamp ?? 0;
  const doClamp = clampF !== 0;
  const doAngleClamp = doClamp && !!opts.angleClamp;
  const doRim = opts.rim ?? true;
  const doShell = !(doRim && opts.rimOnly);
  const even = !!opts.evenThickness;
  const quality = !!opts.qualityNormals;

  // The edges, in first-use order round the faces, with their users.
  const edgeIndex = new Map<string, number>();
  const edges: [number, number][] = [];
  const edgeOf = (a: number, b: number): number => {
    const k = seamKey(a, b);
    let e = edgeIndex.get(k);
    if (e === undefined) {
      e = edges.length;
      edgeIndex.set(k, e);
      edges.push(a < b ? [a, b] : [b, a]);
    }
    return e;
  };
  // `corner_edges`: the edge from each corner to the next.
  const cornerEdge = polys.map((p) => p.map((v, i) => edgeOf(v, p[(i + 1) % p.length]!)));
  for (const w of data.edges ?? []) if (w.length === 2) edgeOf(w[0]!, w[1]!);
  const E = edges.length;

  const Pv: V3[] = Array.from({ length: V }, (_, i) => [P0[i * 3]!, P0[i * 3 + 1]!, P0[i * 3 + 2]!]);
  const faceNo = polys.map((p) => faceNormalCalc(Pv, p));
  const vertNo = meshVertNormals(Pv, polys);

  // ── rim: boundary edges and their vertices ─────────────────────────────
  const edgeUsers = new Array<number>(E).fill(INVALID_UNUSED);
  const edgeOrder = new Array<number>(E).fill(0);
  const newEdgeArr: number[] = [];
  const newVertArr: number[] = [];
  const oldVertArr = new Array<number>(V).fill(INVALID_UNUSED);
  if (doRim) {
    polys.forEach((p, i) => {
      for (let j = 0; j < p.length; j++) {
        const jPrev = (j + p.length - 1) % p.length;
        const vert = p[j]!;
        const prev = p[jPrev]!;
        const e = cornerEdge[i]![jPrev]!;
        if (edgeUsers[e] === INVALID_UNUSED) {
          const [e0, e1] = edges[e]!;
          edgeUsers[e] = (prev > vert) === (e0 < e1) ? i : i + F;
          edgeOrder[e] = j;
        } else edgeUsers[e] = INVALID_PAIR;
      }
    });
    const tag = new Uint8Array(V);
    for (let e = 0; e < E; e++)
      if (edgeUsers[e]! >= 0) {
        tag[edges[e]![0]] = 1;
        tag[edges[e]![1]] = 1;
        newEdgeArr.push(e);
      }
    for (let v = 0; v < V; v++)
      if (tag[v]) {
        oldVertArr[v] = newVertArr.length;
        newVertArr.push(v);
      }
  }
  const rimVerts = newVertArr.length;
  const newVerts = doShell ? 0 : rimVerts;

  // Non-manifold edges (3+ faces), which quality normals and even skip.
  const edgeFaceCount = new Array<number>(E).fill(0);
  cornerEdge.forEach((ce) => ce.forEach((e) => edgeFaceCount[e]!++));
  const nonManifold = (e: number): boolean => edgeFaceCount[e]! > 2;

  let vertNors: V3[] | null = null;
  if (quality) {
    // `mesh_calc_hq_normal`.
    const p1 = new Array<number>(E).fill(-2);
    const p2 = new Array<number>(E).fill(-1);
    polys.forEach((_, i) =>
      cornerEdge[i]!.forEach((e) => {
        if (p1[e] === -2) p1[e] = i;
        else if (p1[e] !== -1 && p2[e] === -1) p2[e] = i;
        else p1[e] = p2[e] = -1;
      }),
    );
    const acc: number[][] = Array.from({ length: V }, () => [0, 0, 0]);
    for (let e = 0; e < E; e++) {
      if (p1[e] === -2 || p1[e] === -1) continue;
      const n = p2[e] !== -1 ? midAngleWeighted(faceNo[p1[e]!]!, faceNo[p2[e]!]!) : faceNo[p1[e]!]!;
      for (const v of edges[e]!) for (let k = 0; k < 3; k++) acc[v]![k] = acc[v]![k]! + n[k]!;
    }
    vertNors = acc.map((a, v) => (normalize(a) === 0 ? ([...vertNo[v]!] as V3) : (a as V3)));
  }

  // ── positions: the input, then the copies ─────────────────────────────
  const outV = V * (doShell ? 2 : 1) + newVerts;
  const pos = new Float32Array(outV * 3);
  pos.set(P0);
  if (doShell) pos.set(P0, V * 3);
  else newVertArr.forEach((v, i) => pos.set(P0.subarray(v * 3, v * 3 + 3), (V + i) * 3));

  // `INIT_VERT_ARRAY_OFFSETS(test)`: which half the offset moves.
  const halves = (test: boolean): { start: number; count: number; align: boolean } => {
    if ((ofsNew >= ofsOrig) === doFlip === test) return { start: 0, count: V, align: true };
    if (doShell) return { start: V, count: V, align: true };
    return { start: V, count: newVerts, align: false };
  };
  const weightOf = (v: number): number | null => {
    if (!opts.vertexGroup) return null;
    const g = data.groups?.get(opts.vertexGroup);
    if (!data.groups || !g) return null;
    const w = g.get(v) ?? 0;
    return opts.invertVertexGroup ? 1 - w : w;
  };
  const fvg = opts.vertexGroupFactor ?? 0;
  const moveBy = (at: number, nor: readonly number[], d: number): void => {
    for (let k = 0; k < 3; k++) pos[at * 3 + k] = f(pos[at * 3 + k]! + f(nor[k]! * d));
  };

  // Edge pairs for the angle clamp: the two faces running the edge opposite ways.
  const pairAngles = (): { pair0: number[]; pair1: number[] } => {
    const pair0 = new Array<number>(E).fill(INVALID_UNUSED);
    const pair1 = new Array<number>(E).fill(INVALID_UNUSED);
    polys.forEach((p, i) => {
      for (let j = 0; j < p.length; j++) {
        const jPrev = (j + p.length - 1) % p.length;
        const e = cornerEdge[i]![jPrev]!;
        const [e0, e1] = edges[e]!;
        const flip = (p[jPrev]! > p[j]!) === (e0 < e1) ? 1 : 0;
        const slot = flip ? pair1 : pair0;
        if (slot[e] === INVALID_UNUSED) slot[e] = i;
        else pair0[e] = pair1[e] = INVALID_PAIR;
      }
    });
    return { pair0, pair1 };
  };
  const edgeLenSq = (): number[] => {
    const l = new Array<number>(V).fill(Infinity);
    for (const [a, b] of edges) {
      // `len_squared_v3v3` in float, a step at a time.
      const dx = f(P0[a * 3]! - P0[b * 3]!);
      const dy = f(P0[a * 3 + 1]! - P0[b * 3 + 1]!);
      const dz = f(P0[a * 3 + 2]! - P0[b * 3 + 2]!);
      const d = f(f(f(dx * dx) + f(dy * dy)) + f(dz * dz));
      l[a] = Math.min(l[a]!, d);
      l[b] = Math.min(l[b]!, d);
    }
    return l;
  };

  if (!even) {
    const offset = Math.abs(thickness) * clampF;
    const vertLens = doClamp ? edgeLenSq() : null;
    let vertAngs: number[] | null = null;
    if (doAngleClamp) {
      vertAngs = new Array<number>(V).fill(0.5 * Math.PI);
      const { pair0, pair1 } = pairAngles();
      for (let e = 0; e < E; e++) {
        if (pair0[e]! < 0 || pair1[e]! < 0) continue;
        const [a, b] = edges[e]!;
        const ev = sub(Pv[a]!, Pv[b]!);
        normalize(ev);
        const angle = angleSignedOnAxis(faceNo[pair0[e]!]!, faceNo[pair1[e]!]!, ev);
        vertAngs[a] = Math.max(vertAngs[a]!, angle);
        vertAngs[b] = Math.max(vertAngs[b]!, angle);
      }
    }
    const apply = (ofs: number, test: boolean): void => {
      if (ofs === 0) return;
      const h = halves(test);
      for (let iOrig = 0; iOrig < h.count; iOrig++) {
        const i = h.align ? iOrig : newVertArr[iOrig]!;
        let d = ofs;
        const w = weightOf(i);
        if (w !== null) d = (fvg + w * (1 - fvg)) * ofs;
        if (doClamp && offset > FLT_EPSILON) {
          if (w === null) d = ofs;
          if (doAngleClamp) {
            // `ofs_new` measures the angle from the other side; `ofs_orig`
            // reads `vert_angs[i_orig]` (Blender's index, kept).
            const ang = test ? vertAngs![iOrig]! : 2 * Math.PI - vertAngs![i]!;
            const cosAng = Math.cos(ang * 0.5);
            if (cosAng > 0) {
              const maxOff = (Math.sqrt(vertLens![i]!) * 0.5) / cosAng;
              if (maxOff < offset * 0.5) d *= (maxOff / offset) * 2;
            }
          } else if (vertLens![i]! < offset * offset) d *= Math.sqrt(vertLens![i]!) / offset;
        }
        moveBy(h.start + iOrig, vertNors ? vertNors[i]! : vertNo[i]!, d);
      }
    };
    apply(ofsNew, false);
    apply(ofsOrig, true);
  } else {
    const nors = vertNors ?? vertNo;
    const angles = new Array<number>(V).fill(0);
    const accum = new Array<number>(V).fill(0);
    polys.forEach((p, i) => {
      const n = p.length;
      let iCurr = n - 1;
      const prevV = sub(Pv[p[iCurr - 1 < 0 ? n - 1 : iCurr - 1]!]!, Pv[p[iCurr]!]!);
      normalize(prevV);
      let norPrev = prevV;
      for (let iNext = 0; iNext < n; iNext++) {
        const norNext = sub(Pv[p[iCurr]!]!, Pv[p[iNext]!]!);
        normalize(norNext);
        const angle = Math.max(angleNormalized(norPrev, norNext), FLT_EPSILON);
        const v = p[iCurr]!;
        accum[v] = accum[v]! + angle;
        const eCurr = cornerEdge[i]![iCurr]!;
        const eNext = cornerEdge[i]![iNext]!;
        if (!quality || (!nonManifold(eCurr) && !nonManifold(eNext)))
          angles[v] = angles[v]! + shellToDist(nors[v]!, faceNo[i]!) * angle;
        else angles[v] = angles[v]! + angle;
        norPrev = norNext;
        iCurr = iNext;
      }
    });
    if (opts.vertexGroup && data.groups?.get(opts.vertexGroup))
      for (let v = 0; v < V; v++) angles[v] = angles[v]! * (fvg + weightOf(v)! * (1 - fvg));
    if (doClamp) {
      const clampFac = 1 + (doAngleClamp ? Math.abs(offsetFac) : 0);
      const offset = Math.abs(thickness) * clampF * clampFac;
      if (offset > FLT_EPSILON) {
        const lens = edgeLenSq();
        if (doAngleClamp) {
          const vertAngs = new Array<number>(V).fill(0.5 * Math.PI);
          const { pair0, pair1 } = pairAngles();
          for (let e = 0; e < E; e++) {
            if (pair0[e]! < 0 || pair1[e]! < 0) continue;
            const angle = Math.PI - angleNormalized(faceNo[pair0[e]!]!, faceNo[pair1[e]!]!);
            const [a, b] = edges[e]!;
            vertAngs[a] = Math.max(vertAngs[a]!, angle);
            vertAngs[b] = Math.max(vertAngs[b]!, angle);
          }
          for (let v = 0; v < V; v++) {
            const cosAng = Math.cos(vertAngs[v]! * 0.5);
            if (cosAng > 0) {
              const maxOff = (Math.sqrt(lens[v]!) * 0.5) / cosAng;
              if (maxOff < offset * 0.5) angles[v] = angles[v]! * ((maxOff / offset) * 2);
            }
          }
        } else
          for (let v = 0; v < V; v++)
            if (lens[v]! < offset * offset) angles[v] = angles[v]! * (Math.sqrt(lens[v]!) / offset);
      }
    }
    const apply = (ofs: number, test: boolean): void => {
      if (ofs === 0) return;
      const h = halves(test);
      for (let iOrig = 0; iOrig < h.count; iOrig++) {
        const i = h.align ? iOrig : newVertArr[iOrig]!;
        if (accum[i]) moveBy(h.start + iOrig, nors[i]!, ofs * (angles[i]! / accum[i]!));
      }
    };
    apply(ofsNew, false);
    apply(ofsOrig, true);
  }

  // ── faces ──────────────────────────────────────────────────────────────
  const outPolys: number[][] = polys.map((p) => [...p]);
  const src: Array<{ face: number; corners: number[] }> = polys.map((p, i) => ({ face: i, corners: p.map((_, k) => k) }));
  const matMax = data.materials && data.materials.length ? Math.max(0, ...data.materials) : 0;
  const clampMat = (m: number): number => Math.max(0, Math.min(matMax, m));
  const matOfs = matMax ? opts.materialOffset ?? 0 : 0;
  const matOfsRim = matMax ? opts.materialOffsetRim ?? 0 : 0;
  const mats: number[] = keptFace.map((fi) => data.materials?.[fi] ?? 0);
  if (doShell)
    polys.forEach((p, i) => {
      // Turned round, first corner kept.
      const order = p.map((_, j) => (j === 0 ? 0 : p.length - j));
      outPolys.push(order.map((k) => p[k]! + V));
      src.push({ face: i, corners: order });
      mats.push(matOfs ? clampMat(mats[i]! + matOfs) : mats[i]!);
    });
  // Rim quads: [q, p, p', q'] where the face runs p → q along the edge.
  const copyOf = (v: number): number => (doShell ? v : oldVertArr[v]!) + V;
  for (const e of newEdgeArr) {
    const face = edgeUsers[e]! % F;
    const p = polys[face]!;
    const j = edgeOrder[e]!;
    const jPrev = (j + p.length - 1) % p.length;
    const q = p[j]!;
    const pv = p[jPrev]!;
    outPolys.push([q, pv, copyOf(pv), copyOf(q)]);
    src.push({ face, corners: [j, jPrev, jPrev, j] });
    mats.push(matOfsRim ? clampMat(mats[face]! + matOfsRim) : mats[face]!);
  }

  const out: MeshData = { positions: pos, polys: outPolys };
  const corner = (layer: number[][][] | undefined): number[][][] | undefined =>
    layer && layer.length === data.polys.length
      ? src.map(({ face, corners }) => corners.map((k) => [...layer[keptFace[face]!]![k]!]))
      : undefined;
  const uvs = corner(data.uvs);
  if (uvs) out.uvs = uvs;
  const colors = corner(data.colors);
  if (colors) out.colors = colors;
  if (data.materials && data.materials.length === data.polys.length) out.materials = mats;

  // Vertex groups: the copies copy; shell / rim groups at 1.
  if (data.groups || opts.shellVertexGroup || opts.rimVertexGroup) {
    const groups = new Map<string, Map<number, number>>();
    for (const [name, g] of data.groups ?? []) {
      const ng = new Map(g);
      for (const [v, w] of g) {
        if (doShell) ng.set(v + V, w);
        else if (oldVertArr[v]! >= 0) ng.set(oldVertArr[v]! + V, w);
      }
      groups.set(name, ng);
    }
    const ensure = (name: string): Map<number, number> => {
      let g = groups.get(name);
      if (!g) groups.set(name, (g = new Map()));
      return g;
    };
    if (opts.rimVertexGroup) {
      const g = ensure(opts.rimVertexGroup);
      for (const v of newVertArr) {
        g.set(v, 1);
        g.set(copyOf(v), 1);
      }
    }
    if (opts.shellVertexGroup) {
      const g = ensure(opts.shellVertexGroup);
      for (let v = V; v < outV; v++) g.set(v, 1);
    }
    out.groups = groups;
  }

  // Edge layers: the copies copy; the rim's creases.
  const copyKey = (k: string): string | null => {
    const [a, b] = k.split("_").map(Number) as [number, number];
    if (doShell) return seamKey(a + V, b + V);
    const ia = oldVertArr[a]!;
    const ib = oldVertArr[b]!;
    const e = edgeIndex.get(k);
    return ia >= 0 && ib >= 0 && e !== undefined && edgeUsers[e]! >= 0 ? seamKey(ia + V, ib + V) : null;
  };
  const withCopies = <T>(entries: Iterable<[string, T]>, add: (k: string, v: T) => void): void => {
    for (const [k, v] of entries) {
      add(k, v);
      const c = copyKey(k);
      if (c) add(c, v);
    }
  };
  const creases = new Map<string, number>();
  withCopies(data.creases ?? [], (k, v) => creases.set(k, v));
  if (doRim) {
    for (const v of newVertArr) if (opts.creaseRim) creases.set(seamKey(v, copyOf(v)), opts.creaseRim);
    for (const e of newEdgeArr) {
      const [a, b] = edges[e]!;
      if (opts.creaseOuter) creases.set(seamKey(a, b), Math.min(1, (creases.get(seamKey(a, b)) ?? 0) + opts.creaseOuter));
      if (opts.creaseInner) {
        const k = seamKey(copyOf(a), copyOf(b));
        creases.set(k, Math.min(1, (creases.get(k) ?? 0) + opts.creaseInner));
      }
    }
  }
  if (creases.size) out.creases = creases;
  if (data.seams) {
    const s = new Set<string>();
    withCopies([...data.seams].map((k) => [k, true] as [string, boolean]), (k) => s.add(k));
    out.seams = s;
  }
  if (data.sharp) {
    const s = new Set<string>();
    withCopies([...data.sharp].map((k) => [k, true] as [string, boolean]), (k) => s.add(k));
    out.sharp = s;
  }
  if (data.edges?.length) {
    // Wire edges have no face, so no rim; the shell copies them.
    out.edges = [...data.edges.map((e) => [...e]), ...(doShell ? data.edges.map((e) => e.map((v) => v + V)) : [])];
  }
  return out;
}

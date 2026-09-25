/**
 * Blender's **Wireframe modifier** — a port of `BM_mesh_wireframe`
 * (`source/blender/bmesh/tools/bmesh_wireframe.cc` at `v5.1.1`), which the
 * modifier (`MOD_wireframe.cc`) and `bmesh.ops.wireframe` both call
 * (compat-backlog B4).
 *
 * {@link wireframe} in `mesh-ops.ts` was built by measurement and has only
 * `thickness` and `boundary`; this is the function itself, with the
 * modifier's defaults: thickness 0.02, offset 0, **even thickness on**,
 * relative off, boundary off, replace on, crease off.
 *
 * Each vertex becomes two points along its normal (the bar's two sides), each
 * face corner one point `thickness / 2` into the face along the corner's
 * tangent (`1 / cos` of half the exterior angle further with even
 * thickness), each open edge's end one point off the rim with `boundary`;
 * each face side then gets two quads, a boundary side two more.
 *
 * Custom normals are dropped (compat-backlog C29).
 */
import type { MeshData } from "../lib/mesh";
import { faceNormalCalc, meshVertNormals, type V3 } from "./blender-math";
import { seamKey } from "./edit-mode/half-edge";
import { vertexGroupWeights } from "./mesh-layers";

/** Blender's Wireframe modifier settings, with its defaults. */
export interface WireframeModifierOptions {
  /** `thickness`. Default 0.02. */
  thickness?: number;
  /** `offset`, −1 … 1: where the bar sits against the surface. Default 0. */
  offset?: number;
  /** `use_even_offset`. Default on. */
  evenThickness?: boolean;
  /** `use_relative_offset`: scale by each vertex's mean edge length. */
  relativeThickness?: boolean;
  /** `use_boundary`: bars along open edges too. Default off. */
  boundary?: boolean;
  /** `use_replace`: drop the input's faces. Default on. */
  replace?: boolean;
  /** `use_crease` with `crease_weight` (default 1): crease the bars' long edges. */
  crease?: boolean;
  creaseWeight?: number;
  /**
   * `material_offset`. Blender clamps to the object's material slots; a
   * `MeshData` has no slot count, so this clamps to the highest index a face
   * uses — an offset past it on a mesh with spare slots is lost (found by review).
   */
  materialOffset?: number;
  /** `vertex_group` (by name), `invert_vertex_group`, `thickness_vertex_group`. */
  vertexGroup?: string;
  invertVertexGroup?: boolean;
  vertexGroupFactor?: number;
}

const f = Math.fround;
const SMALL_NUMBER = 1e-8;
const sub = (a: readonly number[], b: readonly number[]): V3 => [f(a[0]! - b[0]!), f(a[1]! - b[1]!), f(a[2]! - b[2]!)];
const add = (a: readonly number[], b: readonly number[]): V3 => [f(a[0]! + b[0]!), f(a[1]! + b[1]!), f(a[2]! + b[2]!)];
const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const neg3 = (a: readonly number[]): V3 => [-a[0]!, -a[1]!, -a[2]!];
const cross = (a: readonly number[], b: readonly number[]): V3 => [
  f(a[1]! * b[2]! - a[2]! * b[1]!),
  f(a[2]! * b[0]! - a[0]! * b[2]!),
  f(a[0]! * b[1]! - a[1]! * b[0]!),
];
const madd = (a: readonly number[], b: readonly number[], s: number): V3 => [
  f(a[0]! + f(b[0]! * s)),
  f(a[1]! + f(b[1]! * s)),
  f(a[2]! + f(b[2]! * s)),
];
function normalized(a: readonly number[]): V3 {
  const l = Math.hypot(a[0]!, a[1]!, a[2]!);
  return l > 1e-35 ? [f(a[0]! / l), f(a[1]! / l), f(a[2]! / l)] : [0, 0, 0];
}
const safeAsin = (x: number): number => Math.asin(Math.max(-1, Math.min(1, x)));
function angleNormalized(a: readonly number[], b: readonly number[]): number {
  if (dot(a, b) >= 0) return 2 * safeAsin(Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!) / 2);
  return Math.PI - 2 * safeAsin(Math.hypot(a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!) / 2);
}
/** `angle_v3v3v3`: the angle at `b`. */
const angle3 = (a: readonly number[], b: readonly number[], c: readonly number[]): number =>
  angleNormalized(normalized(sub(a, b)), normalized(sub(c, b)));
/** `angle_on_axis_v3v3v3_v3`: the angle at `b`, both arms projected off `axis`. */
function angleOnAxis(a: readonly number[], b: readonly number[], c: readonly number[], axis: readonly number[]): number {
  const proj = (v: readonly number[]): V3 => {
    const d = dot(v, axis) / dot(axis, axis);
    return [v[0]! - axis[0]! * d, v[1]! - axis[1]! * d, v[2]! - axis[2]! * d];
  };
  return angleNormalized(normalized(proj(sub(a, b))), normalized(proj(sub(c, b))));
}
/** `shell_angle_to_dist`. */
const shellAngleToDist = (angle: number): number => (angle < SMALL_NUMBER ? 1 : Math.abs(1 / Math.cos(angle)));

/** Blender's Wireframe modifier — see the file's header. */
export function wireframeModifier(data: MeshData, opts: WireframeModifierOptions = {}): MeshData {
  const offset = opts.thickness ?? 0.02;
  const offsetFac = opts.offset ?? 0;
  const useEven = opts.evenThickness ?? true;
  const useRelative = !!opts.relativeThickness;
  const useBoundary = !!opts.boundary;
  const useReplace = opts.replace ?? true;
  const useCrease = !!opts.crease;
  const creaseWeight = opts.creaseWeight ?? 1;
  const ofsOrig = f(-(((-offsetFac + 1) * 0.5) * offset));
  const ofsNew = f(offset + ofsOrig);
  const ofsMid = f((ofsOrig + ofsNew) / 2);
  const inset = f(offset / 2);

  const P0 = data.positions;
  const V = P0.length / 3;
  const Pv: V3[] = Array.from({ length: V }, (_, i) => [P0[i * 3]!, P0[i * 3 + 1]!, P0[i * 3 + 2]!]);
  const polys = data.polys.filter((p) => p.length >= 3);
  const keptFace = data.polys.map((p, i) => (p.length >= 3 ? i : -1)).filter((i) => i >= 0);
  const faceNo = polys.map((p) => faceNormalCalc(Pv, p));
  const vertNo = meshVertNormals(Pv, polys);

  // Edge face counts, and every edge at a vertex (for the relative offset).
  const faceCount = new Map<string, number>();
  for (const p of polys) p.forEach((v, i) => {
    const k = seamKey(v, p[(i + 1) % p.length]!);
    faceCount.set(k, (faceCount.get(k) ?? 0) + 1);
  });
  const isBoundary = (a: number, b: number): boolean => faceCount.get(seamKey(a, b)) === 1;
  const vertEdges: number[][] = Array.from({ length: V }, () => []);
  const seen = new Set<string>();
  const addEdge = (a: number, b: number): void => {
    const k = seamKey(a, b);
    if (seen.has(k)) return;
    seen.add(k);
    vertEdges[a]!.push(b);
    vertEdges[b]!.push(a);
  };
  for (const p of polys) p.forEach((v, i) => addEdge(v, p[(i + 1) % p.length]!));
  for (const e of data.edges ?? []) if (e.length === 2) addEdge(e[0]!, e[1]!);

  const tagged = new Uint8Array(V);
  for (const p of polys) for (const v of p) tagged[v] = 1;

  const out: number[] = [];
  const srcOf: number[] = [];
  const newVert = (co: readonly number[], src: number): number => {
    out.push(co[0]!, co[1]!, co[2]!);
    srcOf.push(src);
    return srcOf.length - 1;
  };
  // The input's own vertices stay first (and go with `replace`).
  for (let v = 0; v < V; v++) newVert(Pv[v]!, v);

  // Relative / vertex group factor per vertex.
  // `cd_dvert_offset` is -1 when no vertex is in any group: the group is ignored then.
  const vgRead = vertexGroupWeights(data, opts.vertexGroup, opts.invertVertexGroup);
  const groupW = vgRead && !vgRead.empty ? vgRead.weights : null;
  const fvg = opts.vertexGroupFactor ?? 0;
  const relfac = new Array<number>(V).fill(1);
  if (useRelative || groupW)
    for (let v = 0; v < V; v++) {
      if (!tagged[v]) continue;
      let r = 1;
      if (useRelative) {
        let len = 0;
        for (const w of vertEdges[v]!)
          if (tagged[w]) {
            const d = sub(Pv[v]!, Pv[w]!);
            len = f(len + f(Math.sqrt(f(f(f(d[0]! * d[0]!) + f(d[1]! * d[1]!)) + f(d[2]! * d[2]!)))));
          }
        r = vertEdges[v]!.length ? len / vertEdges[v]!.length : 0;
      }
      if (groupW) {
        let w = groupW[v]!;
        if (fvg > 0) w = fvg + w * (1 - fvg);
        r *= w;
      }
      relfac[v] = f(r);
    }

  const neg = new Array<number>(V).fill(-1);
  const pos = new Array<number>(V).fill(-1);
  for (let v = 0; v < V; v++) {
    if (!tagged[v]) continue;
    const fac = relfac[v]!;
    const co = Pv[v]!;
    const no = vertNo[v]!;
    if (offset === 0) {
      neg[v] = newVert(madd(co, no, f(ofsOrig * fac)), v);
      pos[v] = newVert(madd(co, no, f(ofsNew * fac)), v);
    } else {
      const t = madd(co, no, f(ofsMid * fac));
      neg[v] = newVert(madd(t, no, f(f(ofsOrig - ofsMid) * fac)), v);
      pos[v] = newVert(madd(t, no, f(f(ofsNew - ofsMid) * fac)), v);
    }
  }

  // Loop points, and boundary points as their edges come up.
  const loopVert: number[][] = [];
  const boundaryVert = new Array<number>(V).fill(-1);
  polys.forEach((p, fi) => {
    const n = p.length;
    loopVert.push(
      p.map((v, i) => {
        const prev = Pv[p[(i + n - 1) % n]!]!;
        const next = Pv[p[(i + 1) % n]!]!;
        const co = Pv[v]!;
        // `BM_loop_calc_face_tangent`.
        const vp = normalized(sub(prev, co));
        const vn = normalized(sub(co, next));
        const dir = add(vp, vn);
        let tan: V3;
        const same = [0, 1, 2].every((k) => Math.abs(vp[k]! - vn[k]!) <= 1.1920929e-6);
        if (!same) {
          let nor = cross(vp, vn);
          if (dot(nor, faceNo[fi]!) < 0) nor = neg3(nor);
          tan = normalized(cross(dir, nor));
        } else tan = normalized(cross(dir, faceNo[fi]!));
        const fac = relfac[v]!;
        let facShell = fac;
        if (useEven) facShell = f(facShell * shellAngleToDist((Math.PI - angle3(prev, co, next)) * 0.5));
        let t = madd(co, tan, f(inset * facShell));
        if (offset !== 0) t = madd(t, vertNo[v]!, f(ofsMid * fac));
        const lv = newVert(t, v);

        if (useBoundary && isBoundary(v, p[(i + 1) % n]!)) {
          for (const vb of [v, p[(i + 1) % n]!]) {
            if (boundaryVert[vb] !== -1) continue;
            boundaryVert[vb] = newVert(boundaryPoint(vb), vb);
          }
        }
        return lv;
      }),
    );
  });

  function boundaryPoint(v: number): V3 {
    // `bm_vert_boundary_tangent`: the first two boundary edges at `v`.
    const be = vertEdges[v]!.filter((w) => isBoundary(v, w));
    const faceOf = (a: number, b: number): { fi: number; from: number; to: number } => {
      for (let fi = 0; fi < polys.length; fi++) {
        const p = polys[fi]!;
        const i = p.indexOf(a);
        if (i < 0) continue;
        if (p[(i + 1) % p.length] === b) return { fi, from: a, to: b };
        if (p[(i + p.length - 1) % p.length] === b) return { fi, from: b, to: a };
      }
      throw new Error("wireframeModifier: a boundary edge with no face");
    };
    const co = Pv[v]!;
    let noFace: V3;
    let noEdge: V3;
    let tvec: V3;
    let va = -1;
    let vb = -1;
    const edgeTangent = (e: { fi: number; from: number; to: number }): V3 =>
      normalized(cross(sub(Pv[e.from]!, Pv[e.to]!), faceNo[e.fi]!));
    if (be.length >= 2) {
      const [a, b] = be as [number, number];
      const la = faceOf(v, a);
      const lb = faceOf(v, b);
      noFace = normalized(add(faceNo[la.fi]!, faceNo[lb.fi]!));
      noEdge = add(normalized(sub(co, Pv[a]!)), normalized(sub(Pv[b]!, co)));
      tvec = add(edgeTangent(la), edgeTangent(lb));
      va = a;
      vb = b;
    } else {
      const a = be[0]!;
      const la = faceOf(v, a);
      noFace = faceNo[la.fi]!;
      noEdge = sub(co, Pv[a]!);
      tvec = edgeTangent(la);
    }
    let no = normalized(cross(noEdge, noFace));
    if (dot(no, tvec) > 0) no = neg3(no);
    const fac = relfac[v]!;
    let facShell = fac;
    if (useEven && va >= 0) facShell = f(facShell * shellAngleToDist((Math.PI - angleOnAxis(Pv[va]!, co, Pv[vb]!, noFace)) * 0.5));
    let t = madd(co, no, f(inset * facShell));
    if (offset !== 0) t = madd(t, vertNo[v]!, f(ofsMid * fac));
    return t;
  }

  // Faces: for each side of each face, the two bar quads (and two more on a boundary).
  const outPolys: number[][] = [];
  const src: Array<{ face: number; corners: number[] }> = [];
  const matMax = data.materials && data.materials.length ? Math.max(0, ...data.materials) : 0;
  const mats: number[] = [];
  const faceMat = (fi: number): number => {
    const m = data.materials?.[keptFace[fi]!] ?? 0;
    const o = opts.materialOffset ?? 0;
    return o ? Math.max(0, Math.min(matMax, m + o)) : m;
  };
  const creases = new Map<string, number>();
  if (!useReplace) {
    polys.forEach((p, fi) => {
      outPolys.push([...p]);
      src.push({ face: fi, corners: p.map((_, k) => k) });
      mats.push(data.materials?.[keptFace[fi]!] ?? 0);
    });
    for (const [k, w] of data.creases ?? []) creases.set(k, w);
  }
  polys.forEach((p, fi) => {
    const n = p.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const v1 = p[i]!;
      const v2 = p[j]!;
      const l1 = loopVert[fi]![i]!;
      const l2 = loopVert[fi]![j]!;
      const push = (quad: number[], corners: number[]): void => {
        outPolys.push(quad);
        src.push({ face: fi, corners });
        mats.push(faceMat(fi));
      };
      push([l1, l2, neg[v2]!, neg[v1]!], [i, j, j, i]);
      push([l2, l1, pos[v1]!, pos[v2]!], [j, i, i, j]);
      if (useBoundary && isBoundary(v1, v2)) {
        const b1 = boundaryVert[v1]!;
        const b2 = boundaryVert[v2]!;
        push([b2, b1, neg[v1]!, neg[v2]!], [j, i, i, j]);
        push([b1, b2, pos[v2]!, pos[v1]!], [i, j, j, i]);
        if (useCrease)
          for (const [x, y] of [[pos[v1]!, b1], [pos[v2]!, b2], [neg[v1]!, b1], [neg[v2]!, b2]] as const)
            creases.set(seamKey(x, y), creaseWeight);
      }
      if (useCrease)
        for (const [x, y] of [[pos[v1]!, l1], [pos[v2]!, l2], [neg[v1]!, l1], [neg[v2]!, l2]] as const)
          creases.set(seamKey(x, y), creaseWeight);
    }
  });

  // `replace`: the input's vertices go; renumber.
  const keep = new Int32Array(srcOf.length).fill(-1);
  let n = 0;
  for (let v = 0; v < srcOf.length; v++) if (!(useReplace && v < V)) keep[v] = n++;
  const positions = new Float32Array(n * 3);
  for (let v = 0; v < srcOf.length; v++) if (keep[v]! >= 0) positions.set(out.slice(v * 3, v * 3 + 3), keep[v]! * 3);
  const result: MeshData = { positions, polys: outPolys.map((p) => p.map((v) => keep[v]!)) };

  const corner = (layer: number[][][] | undefined): number[][][] | undefined =>
    layer && layer.length === data.polys.length
      ? src.map(({ face, corners }) => corners.map((k) => [...layer[keptFace[face]!]![k]!]))
      : undefined;
  const uvs = corner(data.uvs);
  if (uvs) result.uvs = uvs;
  const colors = corner(data.colors);
  if (colors) result.colors = colors;
  if (data.materials && data.materials.length === data.polys.length) result.materials = mats;
  if (data.groups) {
    const groups = new Map<string, Map<number, number>>();
    for (const [name, g] of data.groups) {
      const ng = new Map<number, number>();
      srcOf.forEach((s, v) => {
        const w = g.get(s);
        if (w !== undefined && keep[v]! >= 0) ng.set(keep[v]!, w);
      });
      groups.set(name, ng);
    }
    result.groups = groups;
  }
  const rekey = (k: string): string | null => {
    const [a, b] = k.split("_").map(Number) as [number, number];
    return keep[a]! >= 0 && keep[b]! >= 0 ? seamKey(keep[a]!, keep[b]!) : null;
  };
  const cr = new Map<string, number>();
  for (const [k, w] of creases) {
    const r = rekey(k);
    if (r) cr.set(r, w);
  }
  if (cr.size) result.creases = cr;
  if (!useReplace) {
    if (data.seams) result.seams = new Set(data.seams);
    if (data.sharp) result.sharp = new Set(data.sharp);
    if (data.edges?.length) result.edges = data.edges.map((e) => [...e]);
  }
  return result;
}

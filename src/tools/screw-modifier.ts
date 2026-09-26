/**
 * The Screw modifier — Blender's `MOD_screw.cc` (Blender 5.1.1), ported: every
 * edge of the mesh turned about an axis into a band of quads.
 */
import type { MeshData } from "../lib/mesh";
import { f } from "./blender-math";
import { calcEdges } from "./bmesh-lite";
import { weldByMap } from "./remove-doubles";

export interface ScrewModifierOptions {
  /** `axis`: the local axis turned about. Default `Z`. */
  axis?: "X" | "Y" | "Z";
  /** `angle`, radians. Default a whole turn. */
  angle?: number;
  /** `screw_offset`: the climb along the axis over the turn. Default 0. */
  screwOffset?: number;
  /** `iterations`: repeat the turn. Default 1. */
  iterations?: number;
  /** `steps`. Default 16. */
  steps?: number;
  /** `use_merge_vertices`: weld vertices within `mergeThreshold` of the axis. Default false. */
  mergeVertices?: boolean;
  /** `merge_threshold`. Default 0.01. */
  mergeThreshold?: number;
  /** `use_normal_flip`. Default false. */
  normalFlip?: boolean;
  /** `use_normal_calculate`: order each chain of edges so the faces point outwards. Default false. */
  normalCalculate?: boolean;
  /** `use_stretch_u`: UVs span 0–1 around the turn whatever the angle. Default false. */
  stretchU?: boolean;
  /** `use_stretch_v`: generated UVs span 0–1 along the axis. Default false. */
  stretchV?: boolean;
}

const UNUSED = -1;
const INVALID = -2;
const valid = (v: number): boolean => v >= 0;

interface VertConnect {
  distSq: number;
  co: number[];
  v: [number, number];
  e: [number, number];
  flag: number;
}

/**
 * The Screw modifier (`MOD_screw.cc`): each vertex is copied round the axis
 * `steps` times, each edge becomes a band of quads between its copies, and
 * the input's faces are **not** kept — a profile of edges, or a face's rim,
 * sweeps a surface. A whole turn with no climb closes onto itself.
 *
 * - **Winding.** An edge on a face runs the way the (last) face that holds it
 *   runs; a loose edge keeps the order it has. With `normalCalculate` each
 *   chain of edges is re-ordered from its vertex furthest from the axis, by
 *   whether the chain rises or falls along it there, so the faces point
 *   outwards. `normalFlip` reverses every face — its corners' data do not
 *   follow (the modifier copies them before it reorders).
 * - **`iterations`** repeat the turn and the climb: the angle and the offset
 *   are multiplied, and the steps become `(steps + 1) × iterations −
 *   (iterations − 1)`.
 * - **`mergeVertices`** (only with no climb): vertices of the input within
 *   `mergeThreshold` of the axis move onto it and every copy of them welds
 *   to them (`mesh_merge_verts`, no mixing), so a profile touching the axis
 *   closes into a cap.
 * - **Layers.** Vertex groups come with every copy. Custom normals are
 *   copied as the vectors they were — Blender copies the stored angles, which
 *   each new corner reads in its own space (`screw-mod-custom-normals`,
 *   recorded different). A band takes the
 *   material of the face on its edge (0 if none) and the corners of that
 *   face's last corner at each end (`vert_loop_map`); UVs are those plus a
 *   step along u (`stretchU` spreads a turn of any angle over 0–1), or, for
 *   an edge on no face, generated from each end's distance along the axis
 *   (`stretchV` fits them to 0–1). Edge creases, seams and sharp flags are
 *   not carried — Blender's modifier copies no edge data.
 *
 * Not ported: the axis object (`object`, `use_object_screw_offset`) and
 * smooth shading (MeshData has no per-face shading flag).
 */
export function screwModifier(data: MeshData, opts: ScrewModifierOptions = {}): MeshData {
  const axis = { X: 0, Y: 1, Z: 2 }[opts.axis ?? "Z"];
  const [other1, other2] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
  const iter = Math.max(1, Math.floor(opts.iterations ?? 1));
  const doFlip = !!opts.normalFlip;
  const quadOrd = [doFlip ? 3 : 0, doFlip ? 2 : 1, doFlip ? 1 : 2, doFlip ? 0 : 3];

  const totvert = data.positions.length / 3;
  if (totvert === 0) return { positions: new Float32Array(), polys: [] };
  // The Mesh's edges as the OBJ import leaves them: the loose ones first, as
  // stored (`mesh_calc_edges` keeps the existing edges at the front), then
  // the faces' in its hash order. The order decides only the bands' order.
  const polys = data.polys.filter((p) => p.length >= 3);
  const seen = new Set<string>();
  const edges: [number, number][] = [];
  const push = (a: number, b: number): void => {
    const k = a < b ? `${a}_${b}` : `${b}_${a}`;
    if (a === b || seen.has(k)) return;
    seen.add(k);
    edges.push([a, b]);
  };
  for (const e of data.edges ?? []) push(e[0]!, e[1]!);
  for (const [a, b] of calcEdges(polys, polys.length < 1000 ? 1 : 8)) push(a, b);
  const totedge = edges.length;
  const edgeIndex = new Map<string, number>();
  edges.forEach(([a, b], i) => edgeIndex.set(a < b ? `${a}_${b}` : `${b}_${a}`, i));

  let angle = f(opts.angle ?? Math.PI * 2);
  let screwOfs = f(opts.screwOffset ?? 0);
  let stepTot = Math.max(0, Math.floor(opts.steps ?? 16));
  angle = f(angle * iter);
  screwOfs = f(screwOfs * iter);
  let uvUScale = f(1 / stepTot);
  stepTot = (stepTot + 1) * iter - (iter - 1);
  const EPS = f(1.1920929e-7 * 100);
  let close: boolean;
  if (Math.abs(screwOfs) <= EPS && Math.abs(Math.abs(angle) - f(Math.PI * 2)) <= EPS && stepTot > 3) {
    close = true;
    stepTot--;
    screwOfs = 0;
  } else {
    close = false;
    stepTot = Math.max(stepTot, 2);
  }
  if (!opts.stretchU) uvUScale = f(f(uvUScale / iter) * f(angle / f(Math.PI * 2)));
  const doRemoveDoubles = !!opts.mergeVertices && screwOfs === 0;

  const P = data.positions;
  const positions = new Float32Array(totvert * stepTot * 3);
  positions.set(P.subarray(0, totvert * 3));

  // UV plane: through the origin, normal along the axis.
  const distAlong = (v: number): number => positions[v * 3 + axis]!;
  const hasUVs = !!data.uvs && data.uvs.length === data.polys.length;
  let uvVMin = Infinity;
  let uvVMax = -Infinity;
  let uvVRangeInv = 0;
  if (hasUVs) {
    if (opts.stretchV)
      for (let i = 0; i < totvert; i++) {
        const v = P[i * 3 + axis]!;
        uvVMin = Math.min(v, uvVMin);
        uvVMax = Math.max(v, uvVMax);
      }
    else {
      uvVMin = f(3.4028235e38);
      uvVMax = -f(3.4028235e38);
    }
    const range = f(uvVMax - uvVMin);
    uvVRangeInv = range ? f(1 / range) : 0;
  }

  // Edge → face (last one), vertex → corner (last one); edges run as the
  // corners that end on them do.
  const edgeFace = new Array<number>(totedge).fill(-1);
  const vertLoop = new Array<[number, number] | null>(totvert).fill(null);
  if (data.polys.length) {
    data.polys.forEach((p, fi) => {
      if (p.length < 3) return;
      p.forEach((v, k) => {
        const w = p[(k + 1) % p.length]!;
        const ei = edgeIndex.get(v < w ? `${v}_${w}` : `${w}_${v}`)!;
        edgeFace[ei] = fi;
        vertLoop[v] = [fi, k];
        if (edges[ei]![0] !== v) edges[ei] = [edges[ei]![1], edges[ei]![0]];
      });
    });
  }

  if (opts.normalCalculate && totedge !== 0) {
    const vc: VertConnect[] = [];
    for (let i = 0; i < totvert; i++) {
      const co = [P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!];
      vc.push({ distSq: f(f(co[other1]! * co[other1]!) + f(co[other2]! * co[other2]!)), co, v: [UNUSED, UNUSED], e: [-1, -1], flag: 0 });
    }
    edges.forEach(([a, b], ei) => {
      for (const [x, y] of [
        [a, b],
        [b, a],
      ] as const) {
        const c = vc[x]!;
        if (c.v[0] === UNUSED) {
          c.v[0] = y;
          c.e[0] = ei;
        } else if (c.v[1] === UNUSED) {
          c.v[1] = y;
          c.e[1] = ei;
        } else c.v[0] = c.v[1] = INVALID;
      }
    });
    interface It {
      v: number;
      poin: VertConnect | null;
      other: number;
      e: number;
    }
    const init = (vInit: number, dir: number): It => {
      if (valid(vInit)) {
        const poin = vc[vInit]!;
        return { v: vInit, poin, other: poin.v[dir]!, e: poin.e[dir ? 0 : 1]! };
      }
      return { v: vInit, poin: null, other: 0, e: -1 };
    };
    const step = (it: It): void => {
      const p = it.poin!;
      if (p.v[0] === it.other) {
        it.other = it.v;
        it.v = p.v[1];
      } else if (p.v[1] === it.other) {
        it.other = it.v;
        it.v = p.v[0];
      }
      if (valid(it.v)) {
        it.poin = vc[it.v]!;
        it.e = it.poin.e[it.poin.e[0] === it.e ? 1 : 0]!;
      } else {
        it.e = -1;
        it.poin = null;
      }
    };
    for (let i = 0; i < totvert; i++) {
      if (vc[i]!.flag !== 0) continue;
      let linked = 0;
      let vBest = UNUSED;
      let closed = 0;
      let fl = -1;
      for (let j = 0; j < 2; j++) {
        const it = init(i, j);
        if (j === 1) step(it);
        while (it.poin) {
          if (it.poin.flag) {
            closed = 1;
            break;
          }
          it.poin.flag = 1;
          linked++;
          if (fl <= it.poin.distSq) {
            fl = it.poin.distSq;
            vBest = it.v;
          }
          step(it);
          if (!it.poin) break;
        }
      }
      if (linked <= 1) continue;
      let flip = false;
      const best = vc[vBest]!;
      const t1 = valid(best.v[0]) ? vc[best.v[0]]!.co : null;
      const t2 = valid(best.v[1]) ? vc[best.v[1]]!.co : null;
      if (t1 && t2) {
        const vf1 = t1[axis]!;
        const vf2 = t2[axis]!;
        const vfb = best.co[axis]!;
        if (vf1 < vfb && vfb < vf2) flip = false;
        else if (vf1 > vfb && vfb > vf2) flip = true;
        else {
          // normalize_v3, in float: `1 / len` times each.
          const n = (a: number[]): number[] => {
            const l = f(Math.sqrt(f(f(f(a[0]! * a[0]!) + f(a[1]! * a[1]!)) + f(a[2]! * a[2]!))));
            if (!(l > 1e-35)) return a;
            const inv = f(1 / l);
            return a.map((x) => f(x * inv));
          };
          const d1 = n(t1.map((x, k) => f(x - best.co[k]!)));
          const d2 = n(t2.map((x, k) => f(x - best.co[k]!)));
          flip = d1[axis]! < d2[axis]!;
        }
      } else if (t1) flip = t1[axis]! < best.co[axis]!;
      if (angle < 0) flip = !flip;
      for (let j = closed; j < 2; j++) {
        const it = init(vBest, j);
        it.poin!.flag = 1;
        if (j === 1 && valid(best.v[0]) && valid(best.v[1])) flip = !flip;
        while (it.poin && it.poin.flag !== 2) {
          it.poin.flag = 2;
          if (it.e >= 0) {
            const e = edges[it.e]!;
            if (it.v === e[0]) {
              if (!flip) edges[it.e] = [e[1], e[0]];
            } else if (it.v === e[1]) {
              if (flip) edges[it.e] = [e[1], e[0]];
            }
          }
          step(it);
        }
      }
    }
  }

  // The copies.
  for (let s = 1; s < stepTot; s++) {
    const stepAngle = f(f(angle / (stepTot - (close ? 0 : 1))) * s);
    const c = f(Math.cos(stepAngle));
    const sn = f(Math.sin(stepAngle));
    const lift = screwOfs ? f(screwOfs * f(s / (stepTot - 1))) : 0;
    for (let j = 0; j < totvert; j++) {
      const x = positions[j * 3]!;
      const y = positions[j * 3 + 1]!;
      const z = positions[j * 3 + 2]!;
      let o: [number, number, number];
      // axis_angle_to_mat3_single, applied as mul_m4_v3 (column-major).
      if (axis === 0) o = [x, f(f(c * y) - f(sn * z)), f(f(sn * y) + f(c * z))];
      else if (axis === 1) o = [f(f(c * x) + f(sn * z)), y, f(f(-sn * x) + f(c * z))];
      else o = [f(f(c * x) - f(sn * y)), f(f(sn * x) + f(c * y)), z];
      o[axis] = f(o[axis]! + lift);
      positions.set(o, (s * totvert + j) * 3);
    }
  }

  // The bands.
  const out: number[][] = [];
  const materials: number[] = [];
  const uvs: number[][][] = [];
  const colors: number[][][] = [];
  const normals: number[][][] = [];
  const hasColors = !!data.colors && data.colors.length === data.polys.length;
  const hasNormals = !!data.normals && data.normals.length === data.polys.length;
  const corner = (layer: number[][][] | undefined, at: [number, number] | null, blank: number[]): number[] =>
    at && layer ? [...layer[at[0]]![at[1]]!] : [...blank];
  const stepLast = stepTot - (close ? 1 : 2);
  const onEdge = new Set<number>();
  for (let i = 0; i < totedge; i++) {
    const faceOrig = edgeFace[i]!;
    const hasPoly = faceOrig >= 0;
    const [ea, eb] = edges[i]!;
    onEdge.add(ea);
    onEdge.add(eb);
    const loopA = vertLoop[ea]!;
    const loopB = vertLoop[eb]!;
    const hasLoop = hasPoly && loopA !== null;
    const mat = hasPoly ? (data.materials?.[faceOrig] ?? 0) : 0;
    let uvVA = 0;
    let uvVB = 0;
    if (!hasLoop && hasUVs) {
      uvVA = distAlong(ea);
      uvVB = distAlong(eb);
      if (opts.stretchV) {
        uvVA = f(f(uvVA - uvVMin) * uvVRangeInv);
        uvVB = f(f(uvVB - uvVMin) * uvVRangeInv);
      }
    }
    let i1 = ea;
    let i2 = eb;
    for (let s = 0; s <= stepLast; s++) {
      const poly = new Array<number>(4);
      if (!(close && s === stepLast)) {
        poly[quadOrd[0]!] = i1;
        poly[quadOrd[1]!] = i2;
        poly[quadOrd[2]!] = i2 + totvert;
        poly[quadOrd[3]!] = i1 + totvert;
        i1 += totvert;
        i2 += totvert;
      } else {
        poly[quadOrd[0]!] = i1;
        poly[quadOrd[1]!] = i2;
        poly[quadOrd[2]!] = eb;
        poly[quadOrd[3]!] = ea;
      }
      out.push(poly);
      materials.push(mat);
      // Corners 0–3 take A, B, B, A before the face is reordered.
      const src = [loopA, loopB, loopB, loopA];
      if (hasUVs) {
        const uA = f(s * uvUScale);
        const uB = f((s + 1) * uvUScale);
        let f4: number[][];
        if (hasLoop) {
          f4 = src.map((at) => corner(data.uvs, at, [0, 0]));
          f4[quadOrd[0]!]![0] = f(f4[quadOrd[0]!]![0]! + uA);
          f4[quadOrd[1]!]![0] = f(f4[quadOrd[1]!]![0]! + uA);
          f4[quadOrd[2]!]![0] = f(f4[quadOrd[2]!]![0]! + uB);
          f4[quadOrd[3]!]![0] = f(f4[quadOrd[3]!]![0]! + uB);
        } else {
          f4 = [[], [], [], []];
          f4[quadOrd[0]!] = [uA, uvVA];
          f4[quadOrd[1]!] = [uA, uvVB];
          f4[quadOrd[2]!] = [uB, uvVB];
          f4[quadOrd[3]!] = [uB, uvVA];
        }
        uvs.push(f4);
      }
      if (hasColors) colors.push(src.map((at) => corner(hasLoop ? data.colors : undefined, at, [1, 1, 1, 1])));
      if (hasNormals) normals.push(src.map((at) => corner(hasLoop ? data.normals : undefined, at, [0, 0, 0])));
    }
  }

  // The rungs between the copies of a vertex on no edge are loose edges.
  const wire: number[][] = [];
  for (let j = 0; j < totvert; j++) {
    if (onEdge.has(j)) continue;
    for (let s = 1; s < stepTot; s++) wire.push([s * totvert + j, (s - 1) * totvert + j]);
    if (close) wire.push([j, (stepTot - 1) * totvert + j]);
  }

  let result: MeshData = { positions, polys: out };
  if (wire.length) result.edges = wire;
  if (data.materials && data.materials.length === data.polys.length) result.materials = materials;
  if (hasUVs) result.uvs = uvs;
  if (hasColors) result.colors = colors;
  if (hasNormals) result.normals = normals;
  if (data.groups) {
    result.groups = new Map();
    for (const [name, g] of data.groups) {
      const ng = new Map<number, number>();
      for (const [v, w] of g) for (let s = 0; s < stepTot; s++) ng.set(s * totvert + v, w);
      result.groups.set(name, ng);
    }
  }

  if (doRemoveDoubles) {
    // mesh_remove_doubles_on_axis: the input's vertices near the axis move
    // onto it, and each of their copies welds to them.
    const thr = f(opts.mergeThreshold ?? 0.01);
    const onAxis = new Set<number>();
    for (let i = 0; i < totvert; i++) {
      const co = [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];
      const axisCo = [0, 0, 0];
      axisCo[axis] = co[axis]!;
      const d = f(f((co[0]! - axisCo[0]!) ** 2) + f((co[1]! - axisCo[1]!) ** 2) + f((co[2]! - axisCo[2]!) ** 2));
      if (d <= f(thr * thr)) {
        onAxis.add(i);
        positions.set(axisCo, i * 3);
      }
    }
    if (onAxis.size) {
      const map = (v: number): number => {
        const i = v % totvert;
        return v >= totvert && onAxis.has(i) ? i : v;
      };
      result = weldByMap(result, map, "array");
    }
  }
  return result;
}

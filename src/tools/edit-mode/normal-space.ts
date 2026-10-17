/**
 * Custom normals as Blender stores them — two int16 per face corner, angles against the corner's **normal space**
 * (compat-backlog C29b). A port of `blenkernel/intern/mesh_normals.cc` (Blender 5.1.1): the smooth fans and their
 * spaces (`normals_calc_corners`, `corner_fan_space_define`), the encoding both ways
 * (`corner_space_custom_normal_to_data` / `corner_space_custom_data_to_normal`), and laying normals down
 * (`mesh_normals_corner_custom_set`, which marks sharp the edges a fan's normals disagree across). Float32 throughout,
 * as Blender's — the integers are only reproducible that way.
 *
 * `MeshData.normals` stays vectors; these are the pieces an operator uses to read them as Blender would after the mesh
 * under them changes (C29c). Corners are numbered flat: polygon by polygon, corner by corner.
 *
 * ```ts
 * const { clnors, sharp } = setCustomNormals(mesh, normals); // what `normals_split_custom_set` stores
 * const shown = decodeCustomNormals({ ...mesh, sharp }, clnors); // what Blender then shows per corner
 * ```
 */
import type { MeshData } from "../../lib/mesh";
import { f, dot, sub, cross, mathNormalize, meshFaceNormal, safeAcosApprox, type V3 } from "../blender-math";

/** A fan's normal space — `CornerNormalSpace`. `alpha` and `beta` 0 mark one Blender could not build. */
export interface CornerSpace {
  lnor: V3;
  ref: V3;
  ortho: V3;
  alpha: number;
  beta: number;
}

/** The smooth fans of a mesh and what `normals_calc_corners` gives each corner. */
export interface CornerFans {
  /** One space per fan. */
  spaces: CornerSpace[];
  /** The corners of each fan, in the order Blender's traversal lists them (`corners_by_space`). */
  fans: number[][];
  /** The fan of each corner (flat corner index); -1 for the second corner of a vertex a face repeats (an invalid face). */
  fanOf: Int32Array;
  /** Each corner's normal: the fan's, or its custom normal decoded when `clnors` were given. */
  normals: V3[];
}

/** `LNOR_SPACE_TRIGO_THRESHOLD`. */
const TRIGO = f(1 - f(1e-4));
const PI2_F = f(f(Math.PI) * 2);
const PI2_D = f(Math.PI * 2);
const SHRT_MAX = 32767;

const edgeKey = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);
const scaleF = (a: V3, k: number): V3 => [f(a[0]! * k), f(a[1]! * k), f(a[2]! * k)];
const addF = (a: V3, b: V3): V3 => [f(a[0]! + b[0]!), f(a[1]! + b[1]!), f(a[2]! + b[2]!)];

/** `corner_fan_space_define`. */
export function cornerFanSpace(lnor: V3, vecRef: V3, vecOther: V3, edgeVectors: readonly V3[]): CornerSpace {
  const dtpRef = dot(vecRef, lnor);
  const dtpOther = dot(vecOther, lnor);
  if (Math.abs(dtpRef) >= TRIGO || Math.abs(dtpOther) >= TRIGO)
    return { lnor: [0, 0, 0], ref: [0, 0, 0], ortho: [0, 0, 0], alpha: 0, beta: 0 };
  let alpha: number;
  if (edgeVectors.length > 0) {
    let sum = 0;
    for (const v of edgeVectors) sum = f(sum + safeAcosApprox(dot(v, lnor)));
    alpha = f(sum / f(edgeVectors.length));
  } else alpha = f(f(safeAcosApprox(dtpRef) + safeAcosApprox(dtpOther)) / 2);
  const ref = mathNormalize(sub(vecRef, scaleF(lnor, dtpRef)));
  const ortho = mathNormalize(cross(lnor, ref));
  const otherProj = mathNormalize(sub(vecOther, scaleF(lnor, dtpOther)));
  const dtp = dot(ref, otherProj);
  let beta: number;
  if (dtp < TRIGO) {
    const b = safeAcosApprox(dtp);
    beta = dot(ortho, otherProj) < 0 ? f(PI2_F - b) : b;
  } else beta = PI2_F;
  return { lnor: [...lnor], ref, ortho, alpha, beta };
}

/** `unit_float_to_short`. */
const unitFloatToShort = (val: number): number => Math.floor(f(f(val * SHRT_MAX) + 0.5));
/** `unit_short_to_float`. */
const unitShortToFloat = (val: number): number => f(val / SHRT_MAX);

/** `corner_space_custom_data_to_normal`: the stored pair read in `space` (not normalised, as Blender's). */
export function customDataToNormal(space: CornerSpace, data: readonly [number, number]): V3 {
  if (data[0] === 0 || space.alpha === 0 || space.beta === 0) return [...space.lnor];
  const alphafac = unitShortToFloat(data[0]);
  const alpha = f((alphafac > 0 ? space.alpha : f(PI2_D - space.alpha)) * alphafac);
  const betafac = unitShortToFloat(data[1]);
  const cosA = f(Math.cos(alpha));
  const sinA = f(Math.sin(alpha));
  let n = scaleF(space.lnor, cosA);
  if (betafac === 0) n = addF(n, scaleF(space.ref, sinA));
  else {
    const beta = f((betafac > 0 ? space.beta : f(PI2_D - space.beta)) * betafac);
    n = addF(n, scaleF(space.ref, f(sinA * f(Math.cos(beta)))));
    n = addF(n, scaleF(space.ortho, f(sinA * f(Math.sin(beta)))));
  }
  return n;
}

/** `corner_space_custom_normal_to_data`: the pair that stores `normal` in `space`. */
export function customNormalToData(space: CornerSpace, normal: V3): [number, number] {
  const isZero = normal[0] === 0 && normal[1] === 0 && normal[2] === 0;
  const same = [0, 1, 2].every((k) => Math.abs(f(space.lnor[k]! - normal[k]!)) <= f(1e-4));
  if (isZero || same) return [0, 0];
  const cosAlpha = dot(space.lnor, normal);
  const alpha = safeAcosApprox(cosAlpha);
  const c0 =
    alpha > space.alpha
      ? unitFloatToShort(f(f(-f(PI2_D - alpha)) / f(PI2_D - space.alpha)))
      : unitFloatToShort(f(alpha / space.alpha));
  const vec = mathNormalize(addF(scaleF(space.lnor, -cosAlpha), normal));
  const cosBeta = dot(space.ref, vec);
  let c1 = 0;
  if (cosBeta < TRIGO) {
    let beta = safeAcosApprox(cosBeta);
    if (dot(space.ortho, vec) < 0) beta = f(PI2_D - beta);
    c1 =
      beta > space.beta
        ? unitFloatToShort(f(f(-f(PI2_D - beta)) / f(PI2_D - space.beta)))
        : unitFloatToShort(f(beta / space.beta));
  }
  return [c0, c1];
}

/** The mesh as flat corner arrays. */
function corners(data: MeshData): { start: number[]; vertOf: number[]; faceOf: number[] } {
  const start: number[] = [];
  const vertOf: number[] = [];
  const faceOf: number[] = [];
  data.polys.forEach((p, fi) => {
    start.push(vertOf.length);
    for (const v of p) (vertOf.push(v), faceOf.push(fi));
  });
  return { start, vertOf, faceOf };
}

type EdgeInfo = { kind: "none" } | { kind: "one"; c1: number; toward: boolean } | { kind: "two"; c1: number; c2: number } | { kind: "sharp" };

/**
 * `normals_calc_corners`: the smooth fans, their spaces, and each corner's normal. A fan stops at an edge marked sharp,
 * an edge of a flat face (`sharpFaces`), an edge of more than two faces, and an edge its two faces run the same way.
 * With `clnors` (a pair per flat corner) each fan shows its corners' pairs averaged (integer division) and read in its
 * space — `handle_fan_result_and_custom_normals`.
 */
export function cornerFans(data: MeshData, clnors?: readonly (readonly [number, number])[]): CornerFans {
  const P = data.positions;
  const PV: V3[] = Array.from({ length: P.length / 3 }, (_, v) => [P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!]);
  const faceN = data.polys.map((poly) => meshFaceNormal(PV, poly));
  const { start, vertOf } = corners(data);
  const sharp = data.sharp ?? new Set<string>();
  const flat = data.sharpFaces && data.sharpFaces.length === data.polys.length ? data.sharpFaces : null;
  const facesOf: number[][] = PV.map(() => []);
  data.polys.forEach((p, fi) => {
    for (const v of new Set(p)) facesOf[v]!.push(fi);
  });

  const spaces: CornerSpace[] = [];
  const fans: number[][] = [];
  const fanOf = new Int32Array(vertOf.length).fill(-1);
  const normals: V3[] = vertOf.map(() => [0, 0, 0]);

  for (let v = 0; v < PV.length; v++) {
    const vf = facesOf[v]!;
    if (vf.length === 0) continue;
    // `collect_corner_info` and `calc_local_edge_indices`.
    const info = vf.map((face) => {
      const p = data.polys[face]!;
      const k = p.indexOf(v);
      const kp = (k - 1 + p.length) % p.length;
      const kn = (k + 1) % p.length;
      return { face, corner: start[face]! + k, vertPrev: p[kp]!, vertNext: p[kn]!, edgePrev: 0, edgeNext: 0 };
    });
    const local: number[] = [];
    const indexOf = (x: number): number => {
      let i = local.indexOf(x);
      if (i < 0) (i = local.length), local.push(x);
      return i;
    };
    for (const c of info) (c.edgePrev = indexOf(c.vertPrev)), (c.edgeNext = indexOf(c.vertNext));
    // `calc_connecting_edge_info` / `add_corner_to_edge`.
    const edges: EdgeInfo[] = local.map(() => ({ kind: "none" }));
    const add = (lc: number, edge: number, toward: boolean, key: string): void => {
      const e = edges[edge]!;
      if (e.kind === "none") edges[edge] = sharp.has(key) ? { kind: "sharp" } : { kind: "one", c1: lc, toward };
      else if (e.kind === "one") edges[edge] = e.toward === toward ? { kind: "sharp" } : { kind: "two", c1: e.c1, c2: lc };
      else edges[edge] = { kind: "sharp" };
    };
    info.forEach((c, lc) => {
      if (flat && flat[c.face]) {
        edges[c.edgePrev] = { kind: "sharp" };
        edges[c.edgeNext] = { kind: "sharp" };
        return;
      }
      add(lc, c.edgePrev, true, edgeKey(c.vertPrev, v));
      add(lc, c.edgeNext, false, edgeKey(v, c.vertNext));
    });
    // `calc_edge_directions`.
    const dirs = local.map((o) => mathNormalize(sub(PV[o]!, PV[v]!)));

    const visited = new Array<boolean>(info.length).fill(false);
    let visitedCount = 0;
    let startLc = 0;
    for (;;) {
      // `traverse_fan_local_corners`.
      let fan: number[] = [startLc];
      let cur = startLc;
      let edge = info[cur]!.edgeNext;
      let cyclic = false;
      for (let e = edges[edge]!; e.kind === "two"; e = edges[edge]!) {
        cur = e.c1 === cur ? e.c2 : e.c1;
        if (cur === startLc) {
          cyclic = true;
          break;
        }
        fan.push(cur);
        edge = info[cur]!.edgeNext;
      }
      fan.reverse();
      if (cyclic) {
        let at = 0;
        for (let i = 1; i < fan.length; i++) if (info[fan[i]!]!.corner < info[fan[at]!]!.corner) at = i;
        fan = [...fan.slice(at), ...fan.slice(0, at)];
      } else {
        cur = startLc;
        edge = info[cur]!.edgePrev;
        for (let e = edges[edge]!; e.kind === "two"; e = edges[edge]!) {
          cur = e.c1 === cur ? e.c2 : e.c1;
          fan.push(cur);
          edge = info[cur]!.edgePrev;
        }
      }
      // `accumulate_fan_normal`.
      let fanNormal: V3;
      if (fan.length === 1) fanNormal = [...faceN[info[fan[0]!]!.face]!];
      else {
        let sum: V3 = [0, 0, 0];
        for (const lc of fan) {
          const c = info[lc]!;
          sum = addF(sum, scaleF(faceN[c.face]!, safeAcosApprox(dot(dirs[c.edgePrev]!, dirs[c.edgeNext]!))));
        }
        fanNormal = mathNormalize(sum);
      }
      // `handle_fan_result_and_custom_normals`.
      const first = info[fan[0]!]!.edgeNext;
      const last = info[fan[fan.length - 1]!]!.edgePrev;
      const fanDirs: V3[] = [];
      if (fan.length > 1) {
        for (const lc of fan) fanDirs.push(dirs[info[lc]!.edgeNext]!);
        if (last !== first) fanDirs.push(dirs[last]!);
      }
      const space = cornerFanSpace(fanNormal, dirs[first]!, dirs[last]!, fanDirs);
      if (clnors) {
        let a = 0;
        let b = 0;
        for (const lc of fan) {
          const d = clnors[info[lc]!.corner]!;
          a += d[0];
          b += d[1];
        }
        fanNormal = customDataToNormal(space, [Math.trunc(a / fan.length), Math.trunc(b / fan.length)]);
      }
      const id = spaces.length;
      spaces.push(space);
      fans.push(fan.map((lc) => info[lc]!.corner));
      for (const lc of fan) {
        const c = info[lc]!.corner;
        fanOf[c] = id;
        normals[c] = [...fanNormal];
      }

      visitedCount += fan.length;
      if (visitedCount === info.length) break;
      for (const lc of fan) visited[lc] = true;
      while (visited[startLc]) startLc++;
    }
  }
  return { spaces, fans, fanOf, normals };
}

/**
 * `mesh_normals_corner_custom_set` (corners, not vertices) — what `Mesh.normals_split_custom_set` stores: the pair per
 * corner, and the mesh's sharp edges with those it adds where a fan's normals disagree (more than
 * `LNOR_SPACE_TRIGO_THRESHOLD`, against the fan's last corner walking back), so each fan can hold one normal. A fan's
 * corners store the mean of their normals. `normals` is shaped like `polys` and normalised first
 * (`mesh_set_custom_normals`); a zero vector keeps the corner's own normal. `clnors` are the pairs the mesh holds already
 * (none: zeros). A corner in no fan (a vertex its face repeats) keeps its pair — Blender's second pass skips it.
 */
export function setCustomNormals(
  data: MeshData,
  normals: readonly (readonly number[])[][],
  clnors?: readonly (readonly [number, number])[],
): { clnors: [number, number][]; sharp: Set<string> } {
  const { start, vertOf, faceOf } = corners(data);
  if (normals.length !== data.polys.length || normals.some((face, fi) => face.length !== data.polys[fi]!.length))
    throw new RangeError("setCustomNormals: normals must be shaped like polys");
  const want: V3[] = normals.flatMap((face) => face.map((n) => mathNormalize([f(n[0]!), f(n[1]!), f(n[2]!)])));
  const zero = vertOf.map(() => [0, 0] as [number, number]);
  const held = clnors ?? zero;
  const sharp = new Set(data.sharp ?? []);
  let fans = cornerFans({ ...data, sharp }, held);
  want.forEach((n, i) => {
    if (n[0] === 0 && n[1] === 0 && n[2] === 0) want[i] = [...fans.normals[i]!];
  });
  const edgeOf = (c: number): string => {
    const p = data.polys[faceOf[c]!]!;
    const k = c - start[faceOf[c]!]!;
    return edgeKey(p[k]!, p[(k + 1) % p.length]!);
  };
  const prevCorner = (c: number): number => {
    const fi = faceOf[c]!;
    const k = c - start[fi]!;
    return start[fi]! + ((k - 1 + data.polys[fi]!.length) % data.polys[fi]!.length);
  };
  const done = new Array<boolean>(vertOf.length).fill(false);
  for (let i = 0; i < vertOf.length; i++) {
    if (done[i] || fans.fanOf[i]! < 0) continue;
    const fan = fans.fans[fans.fanOf[i]!]!;
    let prev = -1;
    let org: V3 | null = null;
    for (let j = fan.length - 1; j >= 0; j--) {
      const c = fan[j]!;
      const n = want[c]!;
      if (!org) org = n;
      else if (dot(org, n) < TRIGO) {
        const e = edgeOf(c);
        const ePrev = edgeOf(prevCorner(c));
        const prevEdge = edgeOf(prev);
        sharp.add(prevEdge === ePrev ? prevEdge : e);
        org = n;
      }
      prev = c;
      done[c] = true;
    }
    if (fan.length > 1 && org) {
      const c = fan[fan.length - 1]!;
      if (dot(org, want[c]!) < TRIGO) {
        const e = edgeOf(c);
        const ePrev = edgeOf(prevCorner(c));
        const prevEdge = edgeOf(prev);
        sharp.add(prevEdge === ePrev ? prevEdge : e);
      }
    }
  }
  fans = cornerFans({ ...data, sharp }, held);
  const out = held.map((d) => [d[0], d[1]] as [number, number]);
  done.fill(true);
  for (let i = 0; i < vertOf.length; i++) {
    if (!done[i]) continue;
    const id = fans.fanOf[i]!;
    if (id < 0) continue;
    const fan = fans.fans[id]!;
    if (fan.length < 2) {
      out[i] = customNormalToData(fans.spaces[id]!, want[i]!);
      done[i] = false;
    } else {
      let avg: V3 = [0, 0, 0];
      for (const c of fan) (avg = addF(avg, want[c]!)), (done[c] = false);
      avg = scaleF(avg, f(1 / f(fan.length)));
      const d = customNormalToData(fans.spaces[id]!, avg);
      for (const c of fan) out[c] = [d[0], d[1]];
    }
  }
  return { clnors: out, sharp };
}

/** The normal each corner shows for stored pairs — `normals_calc_corners` with them, shaped like `polys`. */
export function decodeCustomNormals(data: MeshData, clnors: readonly (readonly [number, number])[]): number[][][] {
  const shown = cornerFans(data, clnors).normals;
  let c = 0;
  return data.polys.map((p) => p.map(() => [...shown[c++]!]));
}

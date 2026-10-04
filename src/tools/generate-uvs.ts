/**
 * The UVs Blender's primitives lay down with `calc_uvs` (on by default in
 * `bpy.ops.mesh.primitive_*_add`, off in `bmesh.ops.create_*`) — compat-backlog C20.
 *
 * Source (tag **v5.1.1**): `source/blender/bmesh/operators/bmo_primitive.cc`
 * (`BM_mesh_calc_uvs_grid` / `_cube` / `_sphere` / `_circle` / `_cone`, the
 * `icouvs` and `monkeyuvs` tables).
 *
 * Every rule here is a function of the **geometry**: it is applied to a mesh
 * the generator has already built, reading each corner's position in
 * Blender's own frame — `(X, Y, Z)` of forge3d's Y-up meshes is
 * `(x, z, −y)` of Blender's Z-up primitives, which is the `matrix` the
 * parity rows turn them by, so a corner's UV is what the Blender corner at
 * the same place gets. They do not depend on the order forge3d emits its
 * faces or on which corner a face starts at. The rotation used is therefore
 * written down once ({@link toBlender}) and is the only thing to change if a
 * generator ever turns.
 *
 * Float arithmetic follows the C (`Math.fround` per operation); the corners
 * of a face come back in the face's own order.
 */
import type { MeshData } from "../lib/mesh";
import { ICO_FACE, ICO_UVS, ICO_VERT, MONKEY_UVS } from "./generate-uv-data";

const f = Math.fround;

type V3 = readonly [number, number, number];
export type CornerUVs = number[][][];

/** forge3d's `(X, Y, Z)` about `c`, in Blender's pre-matrix axes: `(x, y, z) = (X, −Z, Y)`. */
function toBlender(P: Float32Array, v: number, c: readonly [number, number, number]): [number, number, number] {
  return [f(P[v * 3]! - c[0]), f(-(P[v * 3 + 2]! - c[2])), f(P[v * 3 + 1]! - c[1])];
}

/** `create_grid`: `ix · dx`, `iy · dy`, the grid index of each corner over the segment count. */
export function planeUVs(
  data: MeshData,
  size: readonly [number, number],
  segments: readonly [number, number],
  at: readonly [number, number, number],
): CornerUVs {
  const dx = f(1 / segments[0]);
  const dy = f(1 / segments[1]);
  const P = data.positions;
  return data.polys.map((poly) =>
    poly.map((v) => {
      const b = toBlender(P, v, at);
      const ix = Math.round((b[0] / size[0] + 0.5) * segments[0]);
      const iy = Math.round((b[1] / size[1] + 0.5) * segments[1]);
      return [f(ix * dx), f(iy * dy)];
    }),
  );
}

/** `BM_mesh_calc_uvs_cube`: the cross layout, walked in Blender's face and corner order. */
const CUBE_FACES: readonly (readonly number[])[] = [
  [0, 1, 3, 2],
  [2, 3, 7, 6],
  [6, 7, 5, 4],
  [4, 5, 1, 0],
  [2, 6, 4, 0],
  [7, 3, 1, 5],
];

function cubeUVTable(): number[][][] {
  const width = 0.25;
  let x = 0.375;
  let y = 0;
  const out: number[][][] = CUBE_FACES.map(() => []);
  CUBE_FACES.forEach((face, fi) => {
    face.forEach((vi, j) => {
      out[fi]![vi] = [f(x), f(y)];
      if (j === 0) x = f(x + width);
      else if (j === 1) y = f(y + width);
      else if (j === 2) x = f(x - width);
      else y = f(y - width);
    });
    if (y >= 0.75 && x > 0.125) {
      x = 0.125;
      y = 0.5;
    } else if (x <= 0.125) {
      x = 0.625;
      y = 0.5;
    } else y = f(y + 0.25);
  });
  return out;
}

/**
 * `create_cube`'s unwrap, for a box of one quad per side. Each vertex is named
 * by which side of the centre it lies on, in Blender's order
 * (`4·[x > 0] + 2·[y > 0] + [z > 0]`, Blender's axes), and each face looked up
 * by the four names it joins.
 */
export function boxUVs(data: MeshData): CornerUVs {
  const P = data.positions;
  const n = P.length / 3;
  const c: [number, number, number] = [0, 0, 0];
  for (let v = 0; v < n; v++) for (let k = 0; k < 3; k++) c[k] = c[k]! + P[v * 3 + k]! / n;
  const name = (v: number): number => {
    const b = toBlender(P, v, c);
    return (b[0] > 0 ? 4 : 0) + (b[1] > 0 ? 2 : 0) + (b[2] > 0 ? 1 : 0);
  };
  const table = cubeUVTable();
  const byKey = new Map<string, number>();
  CUBE_FACES.forEach((face, fi) => byKey.set([...face].sort().join(","), fi));
  return data.polys.map((poly) => {
    const names = poly.map(name);
    const fi = byKey.get([...names].sort().join(","));
    if (fi === undefined) throw new Error("box: uvs are defined for a box of one quad per side");
    return names.map((nm) => [...table[fi]![nm]!]);
  });
}

function faceNormal(P: Float32Array, poly: readonly number[]): V3 {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  poly.forEach((a, i) => {
    const b = poly[(i + 1) % poly.length]!;
    nx += (P[a * 3 + 1]! - P[b * 3 + 1]!) * (P[a * 3 + 2]! + P[b * 3 + 2]!);
    ny += (P[a * 3 + 2]! - P[b * 3 + 2]!) * (P[a * 3]! + P[b * 3]!);
    nz += (P[a * 3]! - P[b * 3]!) * (P[a * 3 + 1]! + P[b * 3 + 1]!);
  });
  return [nx, ny, nz];
}

/**
 * `BM_mesh_calc_uvs_cone`. Side quads are unwrapped into a strip, one `1/segments`
 * wide, running right to left; the end caps (and any face with a collapsed
 * end, which the C treats as one) are laid flat as discs.
 *
 * Blender's first ring vertex is a quarter turn from forge3d's: forge ring
 * index `i` is Blender's `i + segments/4`, which is exact for a segment count
 * divisible by 4 (and what the geometry rows compare).
 */
export function cylinderUVs(
  data: MeshData,
  o: { radius1: number; radius2: number; segments: number; capped: boolean; center: readonly [number, number, number] },
): CornerUVs {
  const P = data.positions;
  const n = o.segments;
  const rt = f(o.radius2);
  const rb = f(o.radius1);
  const h = o.capped ? 0.5 : 1;
  const uvWidth = f(1 / n);
  const cy = o.capped ? 0.25 : 0.5;
  const cxTop = o.capped ? 0.25 : 0.5;
  const cxBottom = o.capped ? 0.75 : 0.5;
  const uvRadius = o.capped ? f(0.24) : 0.5;
  const scaleTop = rt !== 0 ? f(uvRadius / rt) : rb !== 0 ? f(uvRadius / rb) : uvRadius;
  const scaleBottom = rb !== 0 ? f(uvRadius / rb) : scaleTop;
  const q = Math.round(n / 4);
  // x after k faces of the strip, by the C's running subtraction.
  const xs: number[] = [1];
  for (let k = 0; k < n; k++) xs.push(f(xs[k]! - uvWidth));
  const y0 = f(1 - h);
  const y1 = f(y0 + h);
  const ringIndex = (v: number): number => {
    const a = Math.atan2(P[v * 3 + 2]! - o.center[2], P[v * 3]! - o.center[0]);
    return ((Math.round((a / (2 * Math.PI)) * n) % n) + n) % n;
  };
  return data.polys.map((poly) => {
    const ys = poly.map((v) => P[v * 3 + 1]!);
    const flat = ys.every((y) => Math.abs(y - ys[0]!) < 1e-6);
    if (poly.length === 4 && !flat && rt !== 0 && rb !== 0) {
      const mid = o.center[1];
      const idx = poly.map(ringIndex);
      // The face joins ring index `i` and `i + 1` (wrapping): the one whose successor is the other.
      const [r0, r1] = [...new Set(idx)] as [number, number];
      const i = (r1 - r0 + n) % n === 1 ? r0 : r1;
      const k = (i + q) % n;
      return poly.map((_, c) => {
        const top = ys[c]! > mid;
        return [f(idx[c] === i ? xs[k]! : xs[k + 1]!), top ? y1 : y0];
      });
    }
    const normalUp = faceNormal(P, poly)[1] > 0;
    return poly.map((v) => {
      const b = toBlender(P, v, o.center);
      return normalUp
        ? [f(cxTop + f(b[0] * scaleTop)), f(cy + f(b[1] * scaleTop))]
        : [f(cxBottom + f(b[0] * scaleBottom)), f(cy + f(b[1] * scaleBottom))];
    });
  });
}

/**
 * `BM_mesh_calc_uvs_sphere` (the UV sphere): longitude from `atan2(y, x)` and
 * latitude from `acos(z / r)`, a face's corners pulled to the right of any
 * wrap, then everything shifted so the smallest `u` is 0. A pole corner takes
 * its longitude from the face's other corners.
 */
export function sphereUVs(data: MeshData, center: readonly [number, number, number]): CornerUVs {
  const P = data.positions;
  const PI = f(Math.PI);
  const out: number[][][] = data.polys.map((poly) => {
    const co = poly.map((v) => toBlender(P, v, center));
    let avgx = 0;
    let avgy = 0;
    if (poly.length === 3)
      for (const c of co) {
        avgx = f(avgx + c[0]);
        avgy = f(avgy + c[1]);
      }
    avgx = f(avgx / 3);
    avgy = f(avgy / 3);
    const uv = co.map((c) => {
      const len = f(Math.hypot(c[0], c[1], c[2]));
      let theta: number;
      if (poly.length === 3 && Math.abs(c[0]) < 0.0001 && Math.abs(c[1]) < 0.0001) theta = f(Math.atan2(avgy, avgx));
      else theta = f(Math.atan2(c[1], c[0]));
      if (Math.abs(f(theta - PI)) < 0.0001) theta = -PI;
      const z = f(c[2] / len);
      const phi = f(Math.acos(z < -1 ? -1 : z > 1 ? 1 : z));
      return [f(0.5 + f(theta / f(PI * 2))), f(1 - f(phi / PI))];
    });
    let maxK = 0;
    for (let k = 1; k < uv.length; k++) if (uv[k]![0]! > uv[maxK]![0]!) maxK = k;
    for (let k = 0; k < uv.length; k++)
      if (k !== maxK && f(uv[maxK]![0]! - uv[k]![0]!) > 0.5) uv[k]![0] = f(uv[k]![0]! + 1);
    return uv;
  });
  let minx = 1;
  for (const face of out) for (const c of face) minx = Math.min(c[0]!, minx);
  for (const face of out) for (const c of face) c[0] = f(c[0]! - minx);
  return out;
}

/** `BM_mesh_calc_uvs_circle`: the unit disc laid on the square, `0.5 + 0.5·x/r`, in the disc's own frame. */
export function circleUVs(
  data: MeshData,
  radius: number,
  frame: readonly [V3, V3],
  center: readonly [number, number, number],
): CornerUVs {
  const P = data.positions;
  const scale = f(0.5 / f(radius));
  return data.polys.map((poly) =>
    poly.map((v) => {
      const d = [f(P[v * 3]! - center[0]), f(P[v * 3 + 1]! - center[1]), f(P[v * 3 + 2]! - center[2])];
      const dot = (a: V3): number => f(f(f(d[0]! * a[0]) + f(d[1]! * a[1])) + f(d[2]! * a[2]));
      return [f(0.5 + f(scale * dot(frame[0]))), f(0.5 + f(scale * dot(frame[1])))];
    }),
  );
}

/**
 * The bare icosahedron's corner UVs (`icouvs`), by face. The icosahedron's
 * corners are named by Blender's `icovert`, found by position, and the 20
 * faces by the three names they join.
 */
export function icoCornerUVs(unitCorners: readonly V3[], tris: readonly (readonly number[])[]): number[][][] {
  const names = unitCorners.map((p) => {
    const b: V3 = [p[0], -p[2], p[1]];
    let best = 0;
    let bd = Infinity;
    ICO_VERT.forEach((q, i) => {
      const d = (q[0] - b[0]) ** 2 + (q[1] - b[1]) ** 2 + (q[2] - b[2]) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  });
  const byKey = new Map<string, number>();
  ICO_FACE.forEach((fc, i) => byKey.set([...fc].sort((a, b) => a - b).join(","), i));
  return tris.map((t) => {
    const ns = t.map((v) => names[v]!);
    const fi = byKey.get([...ns].sort((a, b) => a - b).join(","));
    if (fi === undefined) throw new Error("icosphere: a face is not one of the icosahedron's twenty");
    return ns.map((nm) => {
      const j = ICO_FACE[fi]!.indexOf(nm);
      return [f(ICO_UVS[(fi * 3 + j) * 2]!), f(ICO_UVS[(fi * 3 + j) * 2 + 1]!)];
    });
  });
}

/** `create_monkey`'s `monkeyuvs`: one pair per corner, in face creation order. */
export function monkeyUVs(polys: readonly (readonly number[])[]): CornerUVs {
  let at = 0;
  return polys.map((poly) =>
    poly.map(() => {
      const uv = [f(MONKEY_UVS[at * 2]!), f(MONKEY_UVS[at * 2 + 1]!)];
      at++;
      return uv;
    }),
  );
}

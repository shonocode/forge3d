/**
 * Where `subdivide_edgering`'s new vertices go — Blender's
 * `bm_edgering_pair_interpolate` (`bmesh/operators/bmo_subdivide_edgering.cc`,
 * Blender 5.1.1), with the pairing and the surface tangents it reads.
 *
 * The cuts are made first, evenly along each ring edge; this then moves the
 * inner vertices. Only the positions move — the topology and the layers are
 * the caller's.
 */
import { edgeloopCenter, edgeloopNormal, edgeloopNormalAligned } from "../bridge-loops";
import { falloffCalc, type SubdivideFalloff } from "./refine";
import { seamKey } from "./half-edge";

/** `interp_mode`: `LINEAR` leaves the cuts on the edges, `PATH` bends them along one spline between the loops' centres, `SURFACE` along a spline per edge that leaves the surface tangentially. */
export type EdgeringInterpolation = "LINEAR" | "PATH" | "SURFACE";

export interface EdgeringShape {
  interpolation: EdgeringInterpolation;
  /** How far the splines' handles reach, as a fraction of the natural length. */
  smooth: number;
  /** `profile_shape`: the curve the loops shrink or swell by, towards the middle. */
  profileShape: SubdivideFalloff;
  /** `profile_shape_factor`: 0 keeps every loop its own size. */
  profileShapeFactor: number;
}

export type V = [number, number, number];
const sub = (a: readonly number[], b: readonly number[]): V => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const add = (a: readonly number[], b: readonly number[]): V => [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
const scale = (a: readonly number[], s: number): V => [a[0]! * s, a[1]! * s, a[2]! * s];
const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cross = (a: readonly number[], b: readonly number[]): V => [
  a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!,
];
const lerp = (a: readonly number[], b: readonly number[], t: number): V => [
  a[0]! + (b[0]! - a[0]!) * t,
  a[1]! + (b[1]! - a[1]!) * t,
  a[2]! + (b[2]! - a[2]!) * t,
];
function normalized(a: readonly number[]): V {
  const l = Math.hypot(a[0]!, a[1]!, a[2]!);
  return l > 1e-35 ? [a[0]! / l, a[1]! / l, a[2]! / l] : [0, 0, 0];
}
const len = (a: readonly number[]): number => Math.hypot(a[0]!, a[1]!, a[2]!);

type M3 = [V, V, V]; // rows
const IDENTITY: M3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const mulMV = (m: M3, v: readonly number[]): V => [dot(m[0], v), dot(m[1], v), dot(m[2], v)];
const mulMM = (a: M3, b: M3): M3 =>
  [0, 1, 2].map((i) => [0, 1, 2].map((j) => a[i]![0] * b[0]![j]! + a[i]![1] * b[1]![j]! + a[i]![2] * b[2]![j]!)) as M3;
const transpose = (m: M3): M3 => [0, 1, 2].map((i) => [m[0][i]!, m[1][i]!, m[2][i]!]) as M3;
/** `axis_angle_to_quat` as a matrix (Rodrigues); the identity for a zero axis. */
function axisAngle(axis: readonly number[], angle: number): M3 {
  const [x, y, z] = normalized(axis);
  if (x === 0 && y === 0 && z === 0) return IDENTITY;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
}
/** `angle_normalized_v3v3`. */
function angleNormalized(a: readonly number[], b: readonly number[]): number {
  const asin = (x: number): number => Math.asin(Math.min(1, Math.max(-1, x)));
  if (dot(a, b) >= 0) return 2 * asin(len(sub(a, b)) / 2);
  return Math.PI - 2 * asin(len(add(a, b)) / 2);
}
/** `bisect_v3_v3v3v3`. */
const bisect = (a: V, b: V, c: V): V => normalized(add(normalized(sub(b, a)), normalized(sub(c, b))));
/** `BKE_curve_forward_diff_bezier` for 3 dimensions, `steps` segments: the cubic at t = i / steps. */
function bezier(p0: V, p1: V, p2: V, p3: V, steps: number): V[] {
  const out: V[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
    out.push([0, 1, 2].map((k) => w[0]! * p0[k]! + w[1]! * p1[k]! + w[2]! * p2[k]! + w[3]! * p3[k]!) as V);
  }
  return out;
}
/** `bezier_handle_calc_length_v3`. */
function handleLength(coA: V, noA: V, coB: V, noB: V): number {
  const d = dot(noA, noB);
  let fac = 1.333333;
  if (d < 0) {
    const t = 1 + d;
    fac = fac * t + 0.75 * (1 - t);
  }
  // 2D length, projected on the plane of the normals.
  let ofs: V = cross(noA, noB);
  if (dot(ofs, ofs) > 1.1920929e-7) {
    // closest_to_line_v3(co_b, co_a, co_a + ofs)
    const u = ofs;
    const lambda = dot(sub(coB, coA), u) / dot(u, u);
    ofs = add(coA, scale(u, lambda));
  } else ofs = coA;
  return len(sub(ofs, coB)) * 0.5 * fac;
}

export interface Loop {
  verts: number[];
  closed: boolean;
}

/** What `subdivide_edgering` will cut, read from the mesh before the cut. */
export interface EdgeringPlan {
  /** FACE_OUT: the faces the rings cross (four sides or fewer, two ring edges or more). */
  faceOut: Set<number>;
  /** Every edge to cut, by `seamKey`: those joining the two loops of a pair (`bm_edgering_pair_subdiv`). */
  cut: Map<string, [number, number]>;
  jobs: { A: Loop; B: Loop; tangents: Map<number, V>; rings: { a: number; b: number }[] }[];
}

/**
 * Find the rim loops and pair them, as `bmo_subdivide_edgering_exec` does.
 * Throws where Blender cancels with an error and changes nothing: fewer than
 * two rim loops, two that the ring does not fully join, or three or more
 * with no pair joined. With three or more, a pair not fully joined is left
 * uncut, as Blender leaves it.
 *
 * @param P positions (only the input's vertices are read)
 * @param polys the faces
 * @param ring the ring edges, as `seamKey`s
 */
export function edgeringPlan(
  P: ArrayLike<number>,
  polys: readonly (readonly number[])[],
  ring: ReadonlySet<string>,
): EdgeringPlan {
  const co = (v: number): V => [P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!];

  // FACE_OUT: faces of up to four sides with two ring edges or more; their
  // other edges are the rims (EDGE_RIM).
  const faceOut = new Set<number>();
  const rim = new Map<string, [number, number]>();
  const faceNormal: V[] = [];
  polys.forEach((p, f) => {
    // Newell, as BMesh's face normal.
    const n: V = [0, 0, 0];
    for (let i = 0; i < p.length; i++) {
      const a = co(p[i]!);
      const b = co(p[(i + 1) % p.length]!);
      n[0] += (a[1] - b[1]) * (a[2] + b[2]);
      n[1] += (a[2] - b[2]) * (a[0] + b[0]);
      n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    faceNormal.push(normalized(n));
    if (p.length > 4) return;
    let rings = 0;
    for (let i = 0; i < p.length; i++) if (ring.has(seamKey(p[i]!, p[(i + 1) % p.length]!))) rings++;
    if (rings < 2) return;
    faceOut.add(f);
    for (let i = 0; i < p.length; i++) {
      const a = p[i]!;
      const b = p[(i + 1) % p.length]!;
      if (!ring.has(seamKey(a, b))) rim.set(seamKey(a, b), [a, b]);
    }
  });

  // The faces on each edge, with the corner that starts it.
  const facesOfEdge = new Map<string, { f: number; from: number; to: number }[]>();
  polys.forEach((p, f) => {
    for (let i = 0; i < p.length; i++) {
      const a = p[i]!;
      const b = p[(i + 1) % p.length]!;
      const k = seamKey(a, b);
      const l = facesOfEdge.get(k);
      const e = { f, from: a, to: b };
      if (l) l.push(e);
      else facesOfEdge.set(k, [e]);
    }
  });

  // The rim loops (`BM_mesh_edgeloops_find` over EDGE_RIM): chains of rim
  // edges, a vertex with three or more ending the search.
  const rimAt = new Map<number, number[]>();
  for (const [a, b] of rim.values()) {
    for (const [x, y] of [
      [a, b],
      [b, a],
    ] as const) {
      const l = rimAt.get(x);
      if (l) l.push(y);
      else rimAt.set(x, [y]);
    }
  }
  const loops: Loop[] = [];
  const seen = new Set<number>();
  for (const start of rimAt.keys()) {
    if (seen.has(start)) continue;
    // Walk to one end (or all the way round), then collect from there.
    const comp: number[] = [];
    const stack = [start];
    const inComp = new Set<number>([start]);
    while (stack.length) {
      const v = stack.pop()!;
      comp.push(v);
      for (const w of rimAt.get(v)!) if (!inComp.has(w)) {
        inComp.add(w);
        stack.push(w);
      }
    }
    for (const v of comp) seen.add(v);
    if (comp.some((v) => rimAt.get(v)!.length > 2)) continue;
    const end = comp.find((v) => rimAt.get(v)!.length === 1);
    const closed = end === undefined;
    const first = end ?? Math.min(...comp);
    const verts = [first];
    let prev = -1;
    let cur = first;
    for (;;) {
      const next = rimAt.get(cur)!.find((w) => w !== prev && (verts.length < 2 || w !== verts[verts.length - 2]));
      if (next === undefined || next === first) break;
      verts.push(next);
      prev = cur;
      cur = next;
    }
    if (verts.length > 1) loops.push({ verts, closed });
  }
  if (loops.length < 2) throw new Error("subdivideEdgering: no edge rings found");

  // Which loop each vertex is on, and the ring edges out of each vertex.
  const loopOf = new Map<number, number>();
  loops.forEach((l, i) => l.verts.forEach((v) => loopOf.set(v, i)));
  const ringAt = new Map<number, number[]>();
  for (const k of ring) {
    const [a, b] = k.split("_").map(Number) as [number, number];
    for (const [x, y] of [
      [a, b],
      [b, a],
    ] as const) {
      const l = ringAt.get(x);
      if (l) l.push(y);
      else ringAt.set(x, [y]);
    }
  }

  // Pairs of loops joined by ring edges (`bm_edgering_pair_calc`), kept only
  // when every vertex of each has a ring edge to the other (full overlap).
  const pairs: [number, number][] = [];
  if (loops.length === 2) pairs.push([0, 1]);
  else {
    const have = new Set<string>();
    loops.forEach((l, i) => {
      for (const w of ringAt.get(l.verts[0]!) ?? []) {
        const j = loopOf.get(w);
        if (j === undefined) continue;
        const key = i < j ? `${i}_${j}` : `${j}_${i}`;
        if (have.has(key)) continue;
        have.add(key);
        pairs.push([Math.min(i, j), Math.max(i, j)]);
      }
    });
  }
  const overlaps = (x: Loop, y: Loop): boolean => {
    const inY = new Set(y.verts);
    const inX = new Set(x.verts);
    return (
      x.verts.every((v) => (ringAt.get(v) ?? []).some((w) => inY.has(w))) &&
      y.verts.every((v) => (ringAt.get(v) ?? []).some((w) => inX.has(w)))
    );
  };

  // Surface tangents, from the mesh as it was (`bm_vert_calc_surface_tangent`).
  const tangent = (v: number, shared: Set<number>): V => {
    let inner: V = [0, 0, 0];
    let outer: V = [0, 0, 0];
    let foundInner = false;
    let foundOuter = false;
    let foundOuterTag = false;
    for (const w of rimAt.get(v) ?? []) {
      for (const { f, from, to } of facesOfEdge.get(seamKey(v, w)) ?? []) {
        // BM_edge_calc_face_tangent: into the face.
        const t = normalized(cross(sub(co(from), co(to)), faceNormal[f]!));
        if (shared.has(f)) {
          inner = add(inner, t);
          foundInner = true;
        } else {
          outer = add(outer, t);
          foundOuter = true;
          if (faceOut.has(f)) foundOuterTag = true;
        }
      }
    }
    if (foundInner && foundOuterTag) return normalized(add(normalized(scale(outer, -1)), normalized(inner)));
    if (foundOuter) return normalized(scale(outer, -1));
    return normalized(inner);
  };
  const edgesOf = (l: Loop): [number, number][] => {
    const out: [number, number][] = [];
    for (let i = 0; i + 1 < l.verts.length; i++) out.push([l.verts[i]!, l.verts[i + 1]!]);
    if (l.closed) out.push([l.verts[l.verts.length - 1]!, l.verts[0]!]);
    return out;
  };

  const valid = pairs.filter(([i, j]) => overlaps(loops[i]!, loops[j]!));
  if (loops.length === 2 && valid.length === 0) throw new Error("subdivideEdgering: the edge-ring pair isn't connected");
  if (loops.length > 2 && pairs.length === 0) throw new Error("subdivideEdgering: the edge rings are not connected");

  // The mesh's edges out of each vertex: a pair cuts **every** edge between
  // its loops, selected or not (`bm_edgering_pair_subdiv`).
  const edgeAt = new Map<number, Set<number>>();
  for (const k of facesOfEdge.keys()) {
    const [a, b] = k.split("_").map(Number) as [number, number];
    if (!edgeAt.has(a)) edgeAt.set(a, new Set());
    if (!edgeAt.has(b)) edgeAt.set(b, new Set());
    edgeAt.get(a)!.add(b);
    edgeAt.get(b)!.add(a);
  }

  // Every pair's inputs are read before any vertex moves: the rims do not
  // move, and the tangents are the operator's `LoopPairStore`.
  const cut = new Map<string, [number, number]>();
  const jobs = valid.map(([i, j]) => {
    const A = loops[i]!;
    const B = loops[j]!;
    const both = new Set([...A.verts, ...B.verts]);
    const shared = new Set<number>();
    for (const [a, b] of [...edgesOf(A), ...edgesOf(B)])
      for (const { f } of facesOfEdge.get(seamKey(a, b)) ?? []) if (polys[f]!.every((v) => both.has(v))) shared.add(f);
    const tangents = new Map<number, V>();
    for (const v of [...A.verts, ...B.verts]) tangents.set(v, tangent(v, shared));
    // Each edge between them, from its A end.
    const inB = new Set(B.verts);
    const rings: { a: number; b: number }[] = [];
    for (const a of A.verts)
      for (const b of edgeAt.get(a) ?? [])
        if (inB.has(b)) {
          rings.push({ a, b });
          cut.set(seamKey(a, b), [a, b]);
        }
    return { A, B, tangents, rings };
  });
  return { faceOut, cut, jobs };
}

/**
 * Move the inner vertices of each ring edge (`bm_edgering_pair_interpolate`).
 *
 * @param P positions, the new vertices already on their edges; written in place
 * @param plan {@link edgeringPlan} of the mesh before the cut
 * @param runOf the new vertices on a cut edge, in order from its first end
 */
export function edgeringInterpolate(
  P: number[],
  plan: EdgeringPlan,
  runOf: (a: number, b: number) => number[],
  cuts: number,
  shape: EdgeringShape,
): void {
  const resolu = cuts + 2;
  const co = (v: number): V => [P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!];

  // Profile falloff, symmetric (the operator's `falloff_cache`).
  let falloff: number[] | null = null;
  if (shape.profileShapeFactor !== 0) {
    falloff = [];
    for (let i = 0; i < resolu; i++) {
      let fac = i / (resolu - 1);
      fac = Math.abs(1 - 2 * Math.abs(0.5 - fac));
      falloff.push(1 + falloffCalc(shape.profileShape, fac) * shape.profileShapeFactor);
    }
  }
  if (shape.interpolation === "LINEAR" && !falloff) return;

  for (const { A, B, tangents, rings: ringEdges } of plan.jobs) {
    const rings = ringEdges.map((x) => ({ ...x, inner: runOf(x.a, x.b) }));
    const pts = (l: Loop) => l.verts.map((v) => ({ co: co(v) }));
    const v3 = (a: readonly number[]): V => [a[0]!, a[1]!, a[2]!];
    const aCo = v3(edgeloopCenter(pts(A)));
    const bCo = v3(edgeloopCenter(pts(B)));
    const elDir = sub(aCo, bCo);
    const toward = normalized(elDir);
    let aNo = v3(edgeloopNormal(pts(A)) ?? edgeloopNormalAligned(pts(A), toward));
    let bNo = v3(edgeloopNormal(pts(B)) ?? edgeloopNormalAligned(pts(B), toward));
    if (dot(aNo, elDir) > 0) aNo = scale(aNo, -1);
    if (dot(bNo, elDir) < 0) bNo = scale(bNo, -1);

    let main: V[] | null = null;
    if (shape.interpolation === "PATH" || falloff) {
      const h = handleLength(aCo, aNo, bCo, bNo) * shape.smooth;
      main = bezier(aCo, add(aCo, scale(aNo, h)), add(bCo, scale(bNo, h)), bCo, resolu - 1);
    }

    if (shape.interpolation === "LINEAR") {
      for (const r of rings)
        r.inner.forEach((v, k) => {
          const i = k + 1;
          const at = lerp(aCo, bCo, i / (resolu - 1));
          const p = lerp(at, co(v), falloff![i]!);
          P.splice(v * 3, 3, ...p);
        });
    } else if (shape.interpolation === "PATH") {
      // The frames along the spline, with the least twist: each turns from
      // the last by the angle between their directions. Only the turn
      // relative to the first matters, so the first frame is the identity.
      const dirs: V[] = [aNo];
      for (let i = 1; i < resolu - 1; i++) dirs.push(bisect(main![i - 1]!, main![i]!, main![i + 1]!));
      dirs.push(scale(bNo, -1));
      const rot: M3[] = [IDENTITY];
      for (let i = 1; i < resolu; i++) {
        const angle = angleNormalized(dirs[i - 1]!, dirs[i]!);
        rot.push(angle > 0 ? mulMM(axisAngle(cross(dirs[i - 1]!, dirs[i]!), angle), rot[i - 1]!) : rot[i - 1]!);
      }
      const size = (i: number): number => (falloff ? falloff[i]! : 1);
      /**
       * `transform_point_by_tri_v3` from the frame at `j` to the frame at
       * `i`: the triangle's plane scales by the size ratio (a negative size
       * mirrors it), the offset along its normal — the spline's direction —
       * by `sqrt(area)`, so by the ratio's magnitude.
       */
      const carry = (p: V, j: number, i: number): V => {
        const d = sub(p, main![j]!);
        const along = dot(d, dirs[j]!);
        const inPlane = sub(d, scale(dirs[j]!, along));
        const ratio = size(i) / size(j);
        const local = add(scale(inPlane, ratio), scale(dirs[j]!, along * Math.abs(ratio)));
        const turn = mulMM(rot[i]!, transpose(rot[j]!));
        return add(main![i]!, mulMV(turn, local));
      };
      for (const r of rings) {
        const va = co(r.a);
        const vb = co(r.b);
        r.inner.forEach((v, k) => {
          const i = k + 1;
          const coA = carry(va, 0, i);
          const coB = carry(vb, resolu - 1, i);
          P.splice(v * 3, 3, ...lerp(coA, coB, i / (resolu - 1)));
        });
      }
    } else {
      for (const r of rings) {
        const coA = co(r.a);
        const coB = co(r.b);
        const noA = tangents.get(r.a)!;
        const noB = tangents.get(r.b)!;
        const h = handleLength(coA, noA, coB, noB) * shape.smooth;
        const curve = bezier(coA, add(coA, scale(noA, h)), add(coB, scale(noB, h)), coB, resolu - 1);
        r.inner.forEach((v, k) => {
          const i = k + 1;
          let p = curve[i]!;
          if (falloff) p = lerp(main![i]!, p, falloff[i]!);
          P.splice(v * 3, 3, ...p);
        });
      }
    }
  }
}

/**
 * Blender's **CurveProfile** — the profile widget the Bevel modifier's "Custom" profile is drawn with — a port of
 * `source/blender/blenkernel/intern/curveprofile.cc` and `BKE_curve_forward_diff_bezier` at `v5.1.1`
 * (compat-backlog C35).
 *
 * A profile is a path of control points from (1, 0) to (0, 1), each with a handle on either side, auto or vector. The Bevel
 * modifier asks it for `segments + 1` points along the path ({@link curveProfileSegments}): the segments are shared out
 * over the path's edges — one to every edge when there are enough, the remainder to the most curved edges — and each
 * edge is sampled by forward differencing its bezier. Arithmetic is float32, in C's order, so the samples are Blender's.
 *
 * Only `AUTO` and `VECTOR` handles are supported (the presets use no others).
 *
 * Pure and headless.
 */

export type CurveProfileHandle = "AUTO" | "VECTOR";

export interface CurveProfilePointInput {
  x: number;
  y: number;
  /** The handle on the side towards the path's start. Default `"AUTO"`. */
  handle1?: CurveProfileHandle;
  /** The handle on the side towards the path's end. Default `"AUTO"`. */
  handle2?: CurveProfileHandle;
}

export type CurveProfilePreset = "LINE" | "SUPPORTS" | "CORNICE" | "CROWN" | "STEPS";

export interface CurveProfileInput {
  /** The control points, in path order from (1, 0) to (0, 1). Give these or a `preset`. */
  points?: readonly CurveProfilePointInput[];
  /** One of Blender's presets (`BKE_curveprofile_reset`, as the modifier's widget builds them). */
  preset?: CurveProfilePreset;
  /** `use_sample_straight_edges`: also put samples on the straight edges between vector handles. */
  sampleStraightEdges?: boolean;
  /** `use_sample_even_lengths`: space the samples evenly along the curve instead. */
  sampleEvenLengths?: boolean;
}

const f = Math.fround;
const PROF_TABLE_MAX = 512;

interface P {
  x: number;
  y: number;
  h1: CurveProfileHandle;
  h2: CurveProfileHandle;
  h1loc: [number, number];
  h2loc: [number, number];
}

const pt = (x: number, y: number, h: CurveProfileHandle): P => ({ x: f(x), y: f(y), h1: h, h2: h, h1loc: [0, 0], h2loc: [0, 0] });

/** `curveprofile_build_supports`, with the five points the preset has before any segment count is set. */
function supports(n: number): P[] {
  const path: P[] = new Array<P>(n);
  path[0] = pt(1, 0, "VECTOR");
  path[1] = pt(1, 0.5, "VECTOR");
  for (let i = 1; i < n - 2; i++) {
    const t = f(f(i / f(n - 3)) * f(Math.PI / 2));
    const x = f(1 - f(0.5 * f(1 - f(Math.cos(t)))));
    const y = f(0.5 + f(0.5 * f(Math.sin(t))));
    path[i] = pt(x, y, "AUTO");
  }
  path[n - 2] = pt(0.5, 1, "VECTOR");
  path[n - 1] = pt(0, 1, "VECTOR");
  return path;
}

/** `curveprofile_build_steps`. */
function steps(n: number): P[] {
  const path: P[] = new Array<P>(n);
  if (n === 2) return [pt(1, 0, "VECTOR"), pt(0, 1, "VECTOR")];
  const nStepsX = n % 2 === 0 ? n : n - 1;
  const nStepsY = n % 2 === 0 ? n - 2 : n - 1;
  for (let i = 0; i < n; i++) {
    const stepX = Math.floor((i + 1) / 2);
    const stepY = Math.floor(i / 2);
    path[i] = pt(f(1 - f((2 * stepX) / nStepsX)), f((2 * stepY) / nStepsY), "VECTOR");
  }
  return path;
}

/** `BKE_curveprofile_reset`: the points of a preset (the dynamic ones as they are with no segment count set: 5 and 17). */
export function curveProfilePresetPoints(preset: CurveProfilePreset): CurveProfilePointInput[] {
  const path = presetPath(preset);
  return path.map((p) => ({ x: p.x, y: p.y, handle1: p.h1, handle2: p.h2 }));
}

function presetPath(preset: CurveProfilePreset): P[] {
  switch (preset) {
    case "LINE":
      return [pt(1, 0, "AUTO"), pt(0, 1, "AUTO")];
    case "SUPPORTS":
      return supports(5);
    case "STEPS":
      return steps(17);
    case "CORNICE":
      return [
        pt(1, 0, "VECTOR"), pt(1, 0.125, "VECTOR"), pt(0.92, 0.16, "AUTO"), pt(0.875, 0.25, "VECTOR"), pt(0.8, 0.25, "VECTOR"),
        pt(0.733, 0.433, "AUTO"), pt(0.582, 0.522, "AUTO"), pt(0.4, 0.6, "AUTO"), pt(0.289, 0.727, "AUTO"), pt(0.25, 0.925, "VECTOR"),
        pt(0.175, 0.925, "VECTOR"), pt(0.175, 1, "VECTOR"), pt(0, 1, "VECTOR"),
      ];
    case "CROWN":
      return [
        pt(1, 0, "VECTOR"), pt(1, 0.25, "VECTOR"), pt(0.75, 0.25, "VECTOR"), pt(0.75, 0.325, "VECTOR"), pt(0.925, 0.4, "AUTO"),
        pt(0.975, 0.5, "AUTO"), pt(0.94, 0.65, "AUTO"), pt(0.85, 0.75, "AUTO"), pt(0.75, 0.875, "AUTO"), pt(0.7, 1, "VECTOR"), pt(0, 1, "VECTOR"),
      ];
  }
}

/** `point_calculate_handle`: the handle positions of `point` from its neighbours. */
function pointCalculateHandle(point: P, prev: P | null, next: P | null): void {
  let prevLoc: [number, number];
  let nextLoc: [number, number];
  if (prev === null) {
    nextLoc = [next!.x, next!.y];
    prevLoc = [f(f(2 * point.x) - nextLoc[0]), f(f(2 * point.y) - nextLoc[1])];
  } else prevLoc = [prev.x, prev.y];
  if (next === null) {
    prevLoc = [prev!.x, prev!.y];
    nextLoc = [f(f(2 * point.x) - prevLoc[0]), f(f(2 * point.y) - prevLoc[1])];
  } else nextLoc = [next.x, next.y];

  const dvecA: [number, number] = [f(point.x - prevLoc[0]), f(point.y - prevLoc[1])];
  const dvecB: [number, number] = [f(nextLoc[0] - point.x), f(nextLoc[1] - point.y)];
  const len2 = (v: [number, number]): number => f(Math.sqrt(f(f(v[0] * v[0]) + f(v[1] * v[1]))));
  let lenA = len2(dvecA);
  let lenB = len2(dvecB);
  if (lenA === 0) lenA = 1;
  if (lenB === 0) lenB = 1;

  if (point.h1 === "AUTO" || point.h2 === "AUTO") {
    const tvec: [number, number] = [f(f(dvecB[0] / lenB) + f(dvecA[0] / lenA)), f(f(dvecB[1] / lenB) + f(dvecA[1] / lenA))];
    const len = f(len2(tvec) * f(2.5614));
    if (len !== 0) {
      if (point.h1 === "AUTO") {
        lenA = f(lenA / len);
        point.h1loc = [f(point.x + f(tvec[0] * -lenA)), f(point.y + f(tvec[1] * -lenA))];
      }
      if (point.h2 === "AUTO") {
        lenB = f(lenB / len);
        point.h2loc = [f(point.x + f(tvec[0] * lenB)), f(point.y + f(tvec[1] * lenB))];
      }
    }
  }
  if (point.h1 === "VECTOR") point.h1loc = [f(point.x + f(dvecA[0] * f(-1 / 3))), f(point.y + f(dvecA[1] * f(-1 / 3)))];
  if (point.h2 === "VECTOR") point.h2loc = [f(point.x + f(dvecB[0] * f(1 / 3))), f(point.y + f(dvecB[1] * f(1 / 3)))];
}

function calculatePathHandles(path: P[]): void {
  pointCalculateHandle(path[0]!, null, path[1]!);
  for (let i = 1; i < path.length - 1; i++) pointCalculateHandle(path[i]!, path[i - 1]!, path[i + 1]!);
  pointCalculateHandle(path[path.length - 1]!, path[path.length - 2]!, null);
}

/** `angle_v2v2` in float, as `normalize_v2` (a multiply by 1 / length), `len_v2v2` and `saasinf` do it. */
function angleV2(a: readonly number[], b: readonly number[]): number {
  const norm = (v: readonly number[]): [number, number] => {
    const d = f(f(v[0]! * v[0]!) + f(v[1]! * v[1]!));
    if (d > 1e-35) {
      const inv = f(1 / f(Math.sqrt(d)));
      return [f(v[0]! * inv), f(v[1]! * inv)];
    }
    return [0, 0];
  };
  const len2v = (x: readonly number[], y: readonly number[]): number => {
    const dx = f(x[0]! - y[0]!);
    const dy = f(x[1]! - y[1]!);
    return f(Math.sqrt(f(f(dx * dx) + f(dy * dy))));
  };
  const na = norm(a);
  const nb = norm(b);
  const sasin = (x: number): number => f(Math.asin(Math.max(-1, Math.min(1, x))));
  if (f(f(na[0] * nb[0]) + f(na[1] * nb[1])) >= 0) return f(2 * sasin(f(len2v(na, nb) / 2)));
  return f(f(Math.PI) - f(2 * sasin(f(len2v(na, [-nb[0], -nb[1]]) / 2))));
}

/** `bezt_edge_handle_angle`: how far the handles bend the edge starting at `i`. */
function edgeHandleAngle(path: P[], i: number): number {
  const a = path[i]!;
  const b = path[i + 1]!;
  return angleV2([f(a.h2loc[0] - a.x), f(a.h2loc[1] - a.y)], [f(b.x - b.h1loc[0]), f(b.y - b.h1loc[1])]);
}

/**
 * The C library's `qsort` as the Microsoft runtime runs it (Blender for Windows — the reference here) with
 * `sort_points_curvature`, which returns 0 or 1 and never a negative: the curvier edge goes first, and edges of equal curvature
 * (which is common — the presets are built from equal pieces) end up in an order only that implementation decides. Up to eight
 * elements it is a selection sort, above that a median-of-three quicksort; both are written out as the runtime has them.
 */
function curvatureOrder(curv: readonly number[]): number[] {
  const a = curv.map((_, i) => i);
  const comp = (x: number, y: number): number => (curv[a[x]!]! > curv[a[y]!]! ? 0 : 1);
  const swap = (x: number, y: number): void => {
    const t = a[x]!;
    a[x] = a[y]!;
    a[y] = t;
  };
  const CUTOFF = 8;
  const shortsort = (lo: number, hi: number): void => {
    while (hi > lo) {
      let max = lo;
      for (let q = lo + 1; q <= hi; q++) if (comp(q, max) > 0) max = q;
      swap(max, hi);
      hi--;
    }
  };
  if (a.length < 2) return a;
  const lostk: number[] = [];
  const histk: number[] = [];
  let lo = 0;
  let hi = a.length - 1;
  for (;;) {
    const size = hi - lo + 1;
    if (size <= CUTOFF) shortsort(lo, hi);
    else {
      let mid = lo + Math.floor(size / 2);
      if (comp(lo, mid) > 0) swap(lo, mid);
      if (comp(lo, hi) > 0) swap(lo, hi);
      if (comp(mid, hi) > 0) swap(mid, hi);
      let loguy = lo;
      let higuy = hi;
      for (;;) {
        if (mid > loguy) {
          do loguy++;
          while (loguy < mid && comp(loguy, mid) <= 0);
        }
        if (mid <= loguy) {
          do loguy++;
          while (loguy <= hi && comp(loguy, mid) <= 0);
        }
        do higuy--;
        while (higuy > mid && comp(higuy, mid) > 0);
        if (higuy < loguy) break;
        swap(loguy, higuy);
        if (mid === higuy) mid = loguy;
      }
      higuy++;
      if (mid < higuy) {
        do higuy--;
        while (higuy > mid && comp(higuy, mid) === 0);
      }
      if (mid >= higuy) {
        do higuy--;
        while (higuy > lo && comp(higuy, mid) === 0);
      }
      if (higuy - lo >= hi - loguy) {
        if (lo < higuy) {
          lostk.push(lo);
          histk.push(higuy);
        }
        if (loguy < hi) {
          lo = loguy;
          continue;
        }
      } else {
        if (loguy < hi) {
          lostk.push(loguy);
          histk.push(hi);
        }
        if (lo < higuy) {
          hi = higuy;
          continue;
        }
      }
    }
    if (lostk.length === 0) break;
    lo = lostk.pop()!;
    hi = histk.pop()!;
  }
  return a;
}

/** `BKE_curve_forward_diff_bezier` for one axis: the `it + 1` samples of the bezier q0..q3. */
function forwardDiffBezier(q0: number, q1: number, q2: number, q3: number, it: number): number[] {
  let fl = f(it);
  const rt0 = q0;
  const rt1 = f(f(3 * f(q1 - q0)) / fl);
  fl = f(fl * fl);
  const rt2 = f(f(3 * f(f(q0 - f(2 * q1)) + q2)) / fl);
  fl = f(fl * it);
  const rt3 = f(f(f(q3 - q0) + f(3 * f(q1 - q2))) / fl);
  let a0 = rt0;
  let a1 = f(f(rt1 + rt2) + rt3);
  let a2 = f(f(2 * rt2) + f(6 * rt3));
  const a3 = f(6 * rt3);
  const out: number[] = [];
  for (let a = 0; a <= it; a++) {
    out.push(a0);
    a0 = f(a0 + a1);
    a1 = f(a1 + a2);
    a2 = f(a2 + a3);
  }
  return out;
}

/** `create_samples`: `nSegments + 1` points along the path (the last stays 0,0 when there are fewer segments than edges). */
function createSamples(path: P[], nSegments: number, sampleStraightEdges: boolean): [number, number][] {
  const totEdges = path.length - 1;
  calculatePathHandles(path);
  const curv = Array.from({ length: totEdges }, (_, i) => edgeHandleAngle(path, i));
  const sorted = curvatureOrder(curv);
  const isCurved = (i: number): boolean => path[i]!.h2 !== "VECTOR" || path[i + 1]!.h1 !== "VECTOR";

  const nSamples = new Array<number>(totEdges).fill(0);
  let nLeft: number;
  if (nSegments >= totEdges) {
    if (sampleStraightEdges) {
      const nCommon = Math.floor(nSegments / totEdges);
      nLeft = nSegments % totEdges;
      if (nCommon > 0) for (let i = 0; i < totEdges; i++) nSamples[i] = nCommon;
    } else {
      let nCurved = 0;
      for (let i = 0; i < totEdges; i++) if (isCurved(i)) nCurved++;
      nCurved = nCurved === 0 ? totEdges : nCurved;
      nLeft = nSegments - (totEdges - nCurved);
      const nCommon = Math.floor(nLeft / nCurved);
      if (nCommon > 0)
        for (let i = 0; i < totEdges; i++) {
          if (isCurved(i) || nCurved === totEdges) nSamples[i] = nSamples[i]! + nCommon;
          else nSamples[i] = 1;
        }
      nLeft -= nCommon * nCurved;
    }
  } else nLeft = nSegments;
  for (let i = 0; i < nLeft; i++) nSamples[sorted[i]!]!++;

  const out: [number, number][] = Array.from({ length: nSegments + 1 }, () => [0, 0] as [number, number]);
  let iSample = 0;
  for (let i = 0; i < totEdges; i++) {
    if (nSamples[i]! > 0) {
      const xs = forwardDiffBezier(path[i]!.x, path[i]!.h2loc[0], path[i + 1]!.h1loc[0], path[i + 1]!.x, nSamples[i]!);
      const ys = forwardDiffBezier(path[i]!.y, path[i]!.h2loc[1], path[i + 1]!.h1loc[1], path[i + 1]!.y, nSamples[i]!);
      for (let k = 0; k <= nSamples[i]!; k++) {
        out[iSample + k]![0] = xs[k]!;
        out[iSample + k]![1] = ys[k]!;
      }
    }
    iSample += nSamples[i]!;
  }
  return out;
}

/** `create_samples_even_spacing`: equal chords along the sampled table (`PROF_SAMPLE_EVEN_LENGTHS`). */
function createSamplesEvenSpacing(table: [number, number][], nSegments: number): [number, number][] {
  const dist = (i: number): number => f(Math.sqrt(f(f((table[i]![0] - table[i + 1]![0]) ** 2) + f((table[i]![1] - table[i + 1]![1]) ** 2))));
  let total = 0;
  for (let i = 0; i < table.length - 1; i++) total = f(total + dist(i));
  const segmentLength = f(total / nSegments);
  let distanceToNext = dist(0);
  let distanceToPrev = 0;
  let iTable = 0;
  const out: [number, number][] = Array.from({ length: nSegments + 1 }, () => [0, 0] as [number, number]);
  out[0] = [table[0]![0], table[0]![1]];
  let segmentLeft = segmentLength;
  for (let i = 1; i < nSegments; i++) {
    while (distanceToNext < segmentLeft) {
      segmentLeft = f(segmentLeft - distanceToNext);
      iTable++;
      distanceToNext = dist(iTable);
      distanceToPrev = 0;
    }
    const factor = f(f(distanceToPrev + segmentLeft) / f(distanceToPrev + distanceToNext));
    // `interpf(a, b, t)` = b·(1 − t) + a·t
    const interp = (a: number, b: number): number => f(f(b * f(1 - factor)) + f(a * factor));
    out[i] = [interp(table[iTable + 1]![0], table[iTable]![0]), interp(table[iTable + 1]![1], table[iTable]![1])];
    distanceToNext = f(distanceToNext - segmentLeft);
    distanceToPrev = f(distanceToPrev + segmentLeft);
    segmentLeft = segmentLength;
  }
  return out;
}

function pathOf(profile: CurveProfileInput): P[] {
  if (profile.points) {
    if (profile.points.length < 2) throw new Error("curve profile: needs at least two points");
    return profile.points.map((q) => ({
      x: f(q.x),
      y: f(q.y),
      h1: q.handle1 ?? "AUTO",
      h2: q.handle2 ?? "AUTO",
      h1loc: [0, 0],
      h2loc: [0, 0],
    }));
  }
  return presetPath(profile.preset ?? "LINE");
}

/**
 * The `segments + 1` points of the profile (`BKE_curveprofile_init` and the `segments` table): `[x, y]` from the path's start,
 * (1, 0), to its end, (0, 1). `x` is the distance from the surface the bevel leaves, `y` along it, as the widget draws them.
 */
export function curveProfileSegments(profile: CurveProfileInput, segments: number): [number, number][] {
  const path = pathOf(profile);
  if (profile.sampleEvenLengths) {
    // The sampled table the even spacing walks: 16 samples to an edge, at most PROF_TABLE_MAX, the end point put in by hand.
    const nTable = Math.max(1, Math.min(PROF_TABLE_MAX, (path.length - 1) * 16 + 1));
    const table = nTable > 1 ? createSamples(path, nTable - 1, false) : [[0, 0] as [number, number]];
    table[nTable - 1] = [0, 1];
    return createSamplesEvenSpacing(table, segments);
  }
  return createSamples(path, segments, !!profile.sampleStraightEdges);
}

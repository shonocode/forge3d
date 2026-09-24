/**
 * Show part of a mesh, as if it were being built — Blender's `BUILD`
 * modifier (`MOD_build.cc`), evaluated at one frame.
 *
 * The fraction shown is `(frame − start) / duration`, clamped to 0..1 and
 * flipped by `reverse`. That fraction of the **faces** is kept, first to last
 * (or in a shuffled order); if it rounds down to no face, the fraction is
 * taken of the **edges** instead, and failing that of the **vertices**.
 *
 * What comes out, and in what order, is Blender's:
 *
 * - vertices in the order the kept faces first use them;
 * - every edge of the input whose two ends both survive — **including edges
 *   of faces that did not survive**, which come out as loose edges;
 * - faces in the order they were kept.
 *
 * `randomOrder` shuffles with Blender's own generator (`BLI_array_randomize`:
 * the 48-bit `drand48` recurrence, seeded `seed << 16 | 0x330E`, then a
 * backwards Fisher–Yates), so the same seed reveals the same faces.
 */
import type { MeshData } from "../lib/mesh";

export interface BuildOptions {
  /** The frame to evaluate at (Blender's scene time). */
  frame: number;
  /** Blender's `frame_start`. Default 1. */
  frameStart?: number;
  /** Blender's `frame_duration`. Default 100. */
  frameDuration?: number;
  /** Blender's `use_reverse` — take the mesh apart instead. Default false. */
  reverse?: boolean;
  /** Blender's `use_random_order`. Default false. */
  randomOrder?: boolean;
  /** Blender's `seed`. Default 0. */
  seed?: number;
}

const f = Math.fround;

/** `BLI_array_randomize`: seed the 48-bit LCG, then swap backwards. */
export function blenderShuffle(n: number, seed: number): number[] {
  const out = [...Array(n).keys()];
  if (n <= 1) return out;
  const MASK = 0xffffffffffffn;
  let x = ((BigInt(seed >>> 0) << 16n) | 0x330en) & MASK;
  const next = (): number => {
    x = (0x5deece66dn * x + 0xbn) & MASK;
    return Number(x >> 17n) >>> 0;
  };
  let i = n;
  while (i-- > 0) {
    const j = next() % n;
    if (i !== j) [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * The input's edges in a Blender `Mesh`'s order: face by face, each face's
 * closing edge first, new ones only; then the loose edges.
 */
function meshEdges(data: MeshData): [number, number][] {
  const seen = new Set<string>();
  const out: [number, number][] = [];
  const add = (a: number, b: number): void => {
    const k = a < b ? `${a}_${b}` : `${b}_${a}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(a < b ? [a, b] : [b, a]);
  };
  for (const p of data.polys) for (let i = 0; i < p.length; i++) add(p[(i + p.length - 1) % p.length]!, p[i]!);
  for (const e of data.edges ?? []) add(e[0]!, e[1]!);
  return out;
}

/** Blender's `BUILD` modifier at one frame. */
export function build(data: MeshData, opts: BuildOptions): MeshData {
  const start = opts.frameStart ?? 1;
  const length = opts.frameDuration ?? 100;
  let frac = f(f(f(opts.frame) - f(start)) / f(length));
  frac = Math.min(1, Math.max(0, frac));
  if (opts.reverse) frac = f(1 - frac);

  const nVerts = data.positions.length / 3;
  const edgesSrc = meshEdges(data);
  const facesDst = Math.trunc(f(data.polys.length * frac));
  const edgesDst = Math.trunc(f(edgesSrc.length * frac));
  const seed = opts.seed ?? 0;
  const order = (n: number): number[] => (opts.randomOrder ? blenderShuffle(n, seed) : [...Array(n).keys()]);

  const vertNew = new Map<number, number>();
  const keepVert = (v: number): void => {
    if (!vertNew.has(v)) vertNew.set(v, vertNew.size);
  };
  let keptFaces: number[] = [];
  let keptEdges: [number, number][] = [];

  if (facesDst > 0) {
    keptFaces = order(data.polys.length).slice(0, facesDst);
    for (const fi of keptFaces) for (const v of data.polys[fi]!) keepVert(v);
    keptEdges = edgesSrc.filter(([a, b]) => vertNew.has(a) && vertNew.has(b));
  } else if (edgesDst > 0) {
    keptEdges = order(edgesSrc.length)
      .slice(0, edgesDst)
      .map((i) => edgesSrc[i]!);
    for (const [a, b] of keptEdges) {
      keepVert(a);
      keepVert(b);
    }
  } else {
    for (const v of order(nVerts).slice(0, Math.trunc(f(nVerts * frac)))) keepVert(v);
  }

  const positions = new Float32Array(vertNew.size * 3);
  for (const [old, nu] of vertNew) {
    positions[nu * 3] = data.positions[old * 3]!;
    positions[nu * 3 + 1] = data.positions[old * 3 + 1]!;
    positions[nu * 3 + 2] = data.positions[old * 3 + 2]!;
  }
  const polys = keptFaces.map((fi) => data.polys[fi]!.map((v) => vertNew.get(v)!));
  const onFace = new Set<string>();
  for (const p of polys)
    for (let i = 0; i < p.length; i++) {
      const a = p[i]!;
      const b = p[(i + 1) % p.length]!;
      onFace.add(a < b ? `${a}_${b}` : `${b}_${a}`);
    }
  const loose = keptEdges
    .map(([a, b]) => [vertNew.get(a)!, vertNew.get(b)!])
    .filter(([a, b]) => !onFace.has(a! < b! ? `${a}_${b}` : `${b}_${a}`));
  return { positions, polys, ...(loose.length > 0 ? { edges: loose } : {}) };
}

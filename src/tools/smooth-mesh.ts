/**
 * Blender's **Smooth** modifier (`MOD_smooth.cc`) — not the same operation as
 * the `smooth_vert` op (`smoothVert`), though the map listed that as its
 * counterpart until the parity row said otherwise (2026-09-25, 0/4).
 *
 * Per pass, every vertex is pulled toward **the mean of the midpoints of its
 * edges** — not of its neighbours — by `factor`, on the chosen axes. All
 * vertices read the positions from before the pass. Nothing is pinned: a
 * boundary vertex moves like any other, which is what separates it from
 * `smoothVert` on an open sheet.
 *
 * The midpoint mean is `(p + mean of neighbours) / 2`, so a factor here goes
 * half as far as the same factor toward the neighbours would.
 *
 * Pure and headless.
 */
import type { MeshData } from "../lib/mesh";

export interface SmoothMeshOptions {
  /** How far toward the edge-midpoint mean, per pass — Blender's `factor`. Default 0.5. */
  factor?: number;
  /** Passes — Blender's `iterations`. Default 1. */
  iterations?: number;
  /** Which axes move — Blender's `use_x` / `use_y` / `use_z`. Default all three. */
  axes?: { x?: boolean; y?: boolean; z?: boolean };
}

/**
 * Smooth a mesh as Blender's Smooth modifier does.
 *
 * ```ts
 * const softer = smoothMesh(mesh, { factor: 0.5, iterations: 3 });
 * ```
 *
 * A vertex on no edge stays where it is. (Blender pulls it toward the origin —
 * its midpoint mean is an empty sum — which is not copied.)
 */
export function smoothMesh(data: MeshData, options: SmoothMeshOptions = {}): MeshData {
  const factor = options.factor ?? 0.5;
  const iterations = options.iterations ?? 1;
  const use = [options.axes?.x ?? true, options.axes?.y ?? true, options.axes?.z ?? true];

  // `mesh->edges()`: each edge once, from the faces and the loose edges alike.
  const seen = new Set<string>();
  const edges: [number, number][] = [];
  const addEdge = (a: number, b: number): void => {
    if (a === b) return;
    const k = a < b ? `${a}_${b}` : `${b}_${a}`;
    if (seen.has(k)) return;
    seen.add(k);
    edges.push([a, b]);
  };
  for (const poly of data.polys)
    for (let i = 0; i < poly.length; i++) addEdge(poly[i]!, poly[(i + 1) % poly.length]!);
  for (const e of data.edges ?? []) addEdge(e[0]!, e[1]!);

  const n = data.positions.length / 3;
  const P = Float64Array.from(data.positions);
  const sum = new Float64Array(n * 3);
  const count = new Uint32Array(n);
  for (let it = 0; it < iterations; it++) {
    sum.fill(0);
    count.fill(0);
    for (const [a, b] of edges)
      for (let k = 0; k < 3; k++) {
        const mid = (P[a * 3 + k]! + P[b * 3 + k]!) / 2;
        sum[a * 3 + k] = sum[a * 3 + k]! + mid;
        sum[b * 3 + k] = sum[b * 3 + k]! + mid;
      }
    for (const [a, b] of edges) {
      count[a] = count[a]! + 1;
      count[b] = count[b]! + 1;
    }
    for (let v = 0; v < n; v++) {
      const c = count[v]!;
      if (c === 0) continue;
      for (let k = 0; k < 3; k++)
        if (use[k]) P[v * 3 + k] = (1 - factor) * P[v * 3 + k]! + factor * (sum[v * 3 + k]! / c);
    }
  }

  const out: MeshData = { positions: Float32Array.from(P), polys: data.polys.map((p) => [...p]) };
  if (data.edges) out.edges = data.edges.map((e) => [...e]);
  if (data.creases) out.creases = new Map(data.creases);
  if (data.seams) out.seams = new Set(data.seams);
  if (data.uvs) out.uvs = data.uvs.map((f) => f.map((c) => [...c]));
  return out;
}

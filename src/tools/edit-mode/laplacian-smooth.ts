/**
 * The `LAPLACIANSMOOTH` **modifier** — `MOD_laplaciansmooth.cc`, ported.
 *
 * Not the same operator as `smoothLaplacianVert` (`bmesh.ops.
 * smooth_laplacian_vert`), though the two share a name, a paper and most of a
 * loop walk. The modifier:
 *
 * - **builds its matrix once**, from the mesh as it comes in, and solves it
 *   `iterations` times against the positions each pass leaves behind;
 * - **smooths the rim** with its own operator — the umbrella over boundary
 *   edges, weighted by inverse length, with `lambdaBorder` — where the bmesh op
 *   pins it. The bmesh op's `lambda_border` scales toward the world origin;
 *   this one does not (measured: the same grid at the origin and at x+4 lands
 *   within 6.9e-7, `probe-laplacian-mod.py`);
 * - has **no** edge-length check (`validate_solution` here only writes back);
 * - has `normalized` (default on) and `preserveVolume` (default on).
 *
 * ## The system, as the loop walk builds it
 *
 * For every corner of every face, the corner triangle (prev, curr, next): its
 * area goes to all three vertices' `ring`, its three cotangents (halved) to the
 * three pairs — including prev–next, which is a **diagonal** of a quad. An
 * interior vertex `i` (as many faces as edges around it) gets the row
 *
 * ```
 * normalized:  (1 + λ) x_i − λ Σ_j w_ij x_j / Σ_j w_ij          = x_i⁰
 * otherwise:   (1 + λ/(4 ring_i)) x_i − λ/(4 ring_i) Σ_j w_ij x_j / Σ_j w_ij = x_i⁰
 * ```
 *
 * and a rim vertex, over the edges whose **both** ends are on the rim,
 *
 * ```
 * (1 + 2λ_b) x_i − 2λ_b Σ_e (1/len_e) x_e / Σ_e (1/len_e) = x_i⁰
 * ```
 *
 * A negative `λ` (or `λ_b`) solves with its magnitude and then reflects the
 * move: the vertex goes to `2x⁰ − x`, which inflates.
 *
 * Every stored quantity is float32, as Blender's are (`fweights`,
 * `ring_areas`, `vweights`, `vlengths`, the coordinates); only the solve is
 * double. That matters little for the answer but it is cheap, and this
 * project has been bitten three times by double arithmetic under a tie.
 *
 * ## What is left out, and why
 *
 * - **Loose vertices stay where they are.** Blender gives them a row with
 *   nothing but a diagonal, so the normalized form scales them toward the
 *   **world origin** (1.0 → 0.309 after two passes of λ 0.8) and the other
 *   form divides by a zero ring area and returns NaN — both measured.
 * - **No vertex group.** The weight multiplies λ per vertex at the first pass
 *   and nothing else; it can come when something needs it.
 */
import type { MeshData } from "../../lib/mesh";
import { bicgstab, type Row } from "./laplacian";

export interface LaplacianSmoothOptions {
  /** Blender's `iterations` — passes over the same matrix. Default 1. */
  iterations?: number;
  /** `lambda_factor`, for interior vertices. Default 0.01, as Blender's. */
  lambda?: number;
  /** `lambda_border`, for vertices on a boundary. Default 0.01. */
  lambdaBorder?: number;
  /** Which axes may move. Default all three, as Blender's. */
  useX?: boolean;
  useY?: boolean;
  useZ?: boolean;
  /** `use_volume_preserve`: rescale about the centroid after each pass. Default true. */
  preserveVolume?: boolean;
  /** `use_normalized`: drop the `1/(4·ring)` area factor from λ. Default true. */
  normalized?: boolean;
}

const f = Math.fround;

/**
 * Laplacian-smooth a mesh the way Blender's modifier does.
 *
 * ```ts
 * const smooth = laplacianSmooth(scan, { iterations: 3, lambda: 1.5, lambdaBorder: 0 });
 * ```
 */
export function laplacianSmooth(data: MeshData, opts: LaplacianSmoothOptions = {}): MeshData {
  const repeat = opts.iterations ?? 1;
  const lambda = f(opts.lambda ?? 0.01);
  const lambdaBorder = f(opts.lambdaBorder ?? 0.01);
  const use = [opts.useX ?? true, opts.useY ?? true, opts.useZ ?? true];
  const preserveVolume = opts.preserveVolume ?? true;
  const normalized = opts.normalized ?? true;
  const MIN_AREA = f(0.00001);

  const P = Float32Array.from(data.positions);
  const n = P.length / 3;
  const polys = data.polys.filter((p) => p.length >= 3);
  const out = (): MeshData => ({
    ...data,
    positions: P,
    polys: data.polys.map((p) => [...p]),
  });
  if (!use.some(Boolean) || n === 0) return out();

  // Blender's edges: every face edge once, then the wire edges.
  const edges: [number, number][] = [];
  const seen = new Set<number>();
  const addEdge = (a: number, b: number): void => {
    const key = a < b ? a * n + b : b * n + a;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push([a, b]);
  };
  for (const p of polys) for (let i = 0; i < p.length; i++) addEdge(p[i]!, p[(i + 1) % p.length]!);
  for (const e of data.edges ?? []) if (e[0] !== e[1]) addEdge(e[0]!, e[1]!);

  const eweights = new Float32Array(edges.length);
  const ringAreas = new Float32Array(n);
  const vlengths = new Float32Array(n);
  const vweights = new Float32Array(n);
  const neEd = new Int32Array(n);
  const neFa = new Int32Array(n);
  const zerola = new Uint8Array(n);

  const co = (v: number, k: number): number => P[v * 3 + k]!;
  const len3 = (x: number, y: number, z: number): number =>
    f(Math.sqrt(f(f(f(x * x) + f(y * y)) + f(z * z))));

  /** `area_tri_v3`, in float. */
  const areaTri = (a: number, b: number, c: number): number => {
    const n1 = [0, 1, 2].map((k) => f(co(a, k) - co(b, k)));
    const n2 = [0, 1, 2].map((k) => f(co(b, k) - co(c, k)));
    return f(
      len3(
        f(f(n1[1]! * n2[2]!) - f(n1[2]! * n2[1]!)),
        f(f(n1[2]! * n2[0]!) - f(n1[0]! * n2[2]!)),
        f(f(n1[0]! * n2[1]!) - f(n1[1]! * n2[0]!)),
      ) * 0.5,
    );
  };
  /** `cotangent_tri_weight_v3`: the cotangent at `v1`, in float. */
  const cot = (v1: number, v2: number, v3: number): number => {
    const a = [0, 1, 2].map((k) => f(co(v2, k) - co(v1, k)));
    const b = [0, 1, 2].map((k) => f(co(v3, k) - co(v1, k)));
    const cl = len3(
      f(f(a[1]! * b[2]!) - f(a[2]! * b[1]!)),
      f(f(a[2]! * b[0]!) - f(a[0]! * b[2]!)),
      f(f(a[0]! * b[1]!) - f(a[1]! * b[0]!)),
    );
    if (cl > 1.1920928955078125e-7) return f(f(f(f(a[0]! * b[0]!) + f(a[1]! * b[1]!)) + f(a[2]! * b[2]!)) / cl);
    return 0;
  };

  // ── init_laplacian_matrix ────────────────────────────────────────────────
  edges.forEach(([a, b], i) => {
    neEd[a]!++;
    neEd[b]!++;
    let w = len3(f(co(a, 0) - co(b, 0)), f(co(a, 1) - co(b, 1)), f(co(a, 2) - co(b, 2)));
    if (w < MIN_AREA) {
      zerola[a] = 1;
      zerola[b] = 1;
    } else {
      w = f(1 / w);
    }
    eweights[i] = w;
  });

  /** Per corner: the halved cotangents at next, prev and curr of its triangle. */
  const fweights: [number, number, number][] = [];
  const corners: [number, number, number][] = []; // (prev, curr, next)
  for (const p of polys) {
    const m = p.length;
    for (let k = 0; k < m; k++) {
      // Blender starts at the last corner with prev = the one before it.
      const curr = p[(k + m - 1) % m]!;
      const prev = p[(k + m - 2) % m]!;
      const next = p[k]!;
      neFa[curr]!++;
      const areaf = areaTri(prev, curr, next);
      if (areaf < MIN_AREA) zerola[curr] = 1;
      ringAreas[prev] = f(ringAreas[prev]! + areaf);
      ringAreas[curr] = f(ringAreas[curr]! + areaf);
      ringAreas[next] = f(ringAreas[next]! + areaf);
      const w1 = f(cot(curr, next, prev) / 2);
      const w2 = f(cot(next, prev, curr) / 2);
      const w3 = f(cot(prev, curr, next) / 2);
      fweights.push([w1, w2, w3]);
      corners.push([prev, curr, next]);
      vweights[curr] = f(vweights[curr]! + f(w2 + w3));
      vweights[next] = f(vweights[next]! + f(w1 + w3));
      vweights[prev] = f(vweights[prev]! + f(w1 + w2));
    }
  }
  const isRing = (v: number): boolean => neEd[v] === neFa[v];
  edges.forEach(([a, b], i) => {
    if (!isRing(a) && !isRing(b)) {
      vlengths[a] = f(vlengths[a]! + eweights[i]!);
      vlengths[b] = f(vlengths[b]! + eweights[i]!);
    }
  });

  // A vertex with neither edges nor faces: Blender's row for it scales it
  // toward the origin or divides by zero (see the file note). It stays put.
  const loose = (v: number): boolean => neEd[v] === 0;

  // ── first pass: the diagonal and the per-vertex scale ───────────────────
  const diag = new Float64Array(n);
  const absL = Math.abs(lambda);
  const absLB = Math.abs(lambdaBorder);
  for (let i = 0; i < n; i++) {
    if (zerola[i] || loose(i)) {
      diag[i] = 1;
      continue;
    }
    if (normalized) {
      const w = vweights[i]!;
      vweights[i] = w === 0 ? 0 : f(-absL / w);
      const l = vlengths[i]!;
      vlengths[i] = l === 0 ? 0 : f(f(-absLB * 2) / l);
      diag[i] = isRing(i) ? f(1 + absL) : f(1 + f(absLB * 2));
    } else {
      const w = f(vweights[i]! * ringAreas[i]!);
      vweights[i] = w === 0 ? 0 : f(-absL / f(4 * w));
      const l = vlengths[i]!;
      vlengths[i] = l === 0 ? 0 : f(f(-absLB * 2) / l);
      diag[i] = isRing(i) ? f(1 + f(absL / f(4 * ringAreas[i]!))) : f(1 + f(absLB * 2));
    }
  }

  // ── fill_laplacian_matrix ────────────────────────────────────────────────
  const entries: Map<number, number>[] = Array.from({ length: n }, () => new Map());
  const add = (r: number, c: number, v: number): void => {
    entries[r]!.set(c, (entries[r]!.get(c) ?? 0) + v);
  };
  const open = (v: number): boolean => isRing(v) && !zerola[v] && !loose(v);
  corners.forEach(([prev, curr, next], k) => {
    const [w0, w1, w2] = fweights[k]!;
    if (open(curr)) {
      add(curr, next, f(w2 * vweights[curr]!));
      add(curr, prev, f(w1 * vweights[curr]!));
    }
    if (open(next)) {
      add(next, curr, f(w2 * vweights[next]!));
      add(next, prev, f(w0 * vweights[next]!));
    }
    if (open(prev)) {
      add(prev, curr, f(w1 * vweights[prev]!));
      add(prev, next, f(w0 * vweights[prev]!));
    }
  });
  edges.forEach(([a, b], i) => {
    if (!isRing(a) && !isRing(b) && !zerola[a] && !zerola[b]) {
      add(a, b, f(eweights[i]! * vlengths[a]!));
      add(b, a, f(eweights[i]! * vlengths[b]!));
    }
  });
  const rows: Row[] = entries.map((m, i) => {
    let d = diag[i]!;
    const cols: number[] = [];
    const vals: number[] = [];
    for (const [c, v] of m) {
      if (c === i) d += v;
      else {
        cols.push(c);
        vals.push(v);
      }
    }
    return { diag: d, cols, vals };
  });

  // The centroid of the input, in float, for volume preservation.
  const centroid = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) centroid[k] = f(centroid[k]! + co(i, k));
  const invN = f(1 / n);
  for (let k = 0; k < 3; k++) centroid[k] = f(centroid[k]! * invN);

  const volume = (): number => {
    let vol = 0;
    const c = centroid;
    for (const p of polys) {
      for (let k = 2; k < p.length; k++) {
        const v = [p[0]!, p[k - 1]!, p[k]!];
        // volume_tetrahedron_signed_v3(center, v0, v1, v2)
        const m0 = [0, 1, 2].map((a) => f(c[a]! - co(v[0]!, a)));
        const m1 = [0, 1, 2].map((a) => f(co(v[0]!, a) - co(v[1]!, a)));
        const m2 = [0, 1, 2].map((a) => f(co(v[1]!, a) - co(v[2]!, a)));
        const det = f(
          f(
            f(m0[0]! * f(f(m1[1]! * m2[2]!) - f(m1[2]! * m2[1]!))) -
              f(m1[0]! * f(f(m0[1]! * m2[2]!) - f(m0[2]! * m2[1]!))),
          ) + f(m2[0]! * f(f(m0[1]! * m1[2]!) - f(m0[2]! * m1[1]!))),
        );
        vol = f(vol + f(det / 6));
      }
    }
    return Math.abs(vol);
  };

  const lamIn = lambda >= 0 ? 1 : -1;
  const lamB = lambdaBorder >= 0 ? 1 : -1;
  const b = new Float64Array(n);
  for (let iter = 0; iter < repeat; iter++) {
    const solved: Float64Array[] = [];
    for (let k = 0; k < 3; k++) {
      for (let i = 0; i < n; i++) b[i] = co(i, k);
      solved.push(bicgstab(rows, b, 1e-14, 4000));
    }
    const vini = preserveVolume ? volume() : 0;
    for (let i = 0; i < n; i++) {
      if (zerola[i] || loose(i)) continue;
      const lam = isRing(i) ? lamIn : lamB;
      for (let k = 0; k < 3; k++) {
        if (!use[k]) continue;
        const x = co(i, k);
        P[i * 3 + k] = f(x + f(lam * f(f(solved[k]![i]!) - x)));
      }
    }
    if (preserveVolume) {
      const vend = volume();
      if (vend !== 0) {
        const beta = f(Math.pow(f(vini / vend), f(1 / 3)));
        for (let i = 0; i < n; i++)
          for (let k = 0; k < 3; k++)
            if (use[k]) P[i * 3 + k] = f(f(f(co(i, k) - centroid[k]!) * beta) + centroid[k]!);
      }
    }
  }
  return out();
}

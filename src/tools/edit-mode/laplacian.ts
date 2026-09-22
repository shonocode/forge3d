/**
 * Laplacian smoothing — Blender's `smooth_laplacian_vert`
 * (the `LAPLACIANSMOOTH` modifier).
 *
 * Unlike `smoothVert`, which averages a vertex with its neighbours and so
 * shrinks whatever it touches, this relaxes the surface toward its own
 * curvature: it keeps the shape's volume far better and is what you reach for
 * when a scan or a boolean has left a surface noisy but the silhouette has to
 * survive.
 *
 * Pure and headless.
 *
 * ## It was recorded as unmeasurable, and the axis flags were why
 *
 * The API matrix listed this under "the reference will not act" over five
 * configurations, all of which varied `lambda_factor` and `lambda_border` and
 * none of which mentioned `use_x` / `use_y` / `use_z`. **Those default to
 * false**, so every one of the five asked Blender to move nothing and Blender
 * obliged. This project had already been caught by exactly that default on
 * `smoothVert`'s reference, and the note was in the record.
 *
 * ## The rule
 *
 * It is **implicit** — one linear solve, not a sweep. For every vertex that
 * is not on a boundary:
 *
 * ```
 * (1 + L_i) x_i  −  L_i · (Σ_j w_ij x_j) / (Σ_j w_ij)  =  x0_i
 * L_i = lambda / (12 · A_i)
 * ```
 *
 * where `A_i` is the area of the faces touching `i` and `w_ij` are the usual
 * cotangent weights. Boundary vertices are pinned. Everything in it is
 * measured, and each piece took its own probe
 * (`tools/modeling/parity/probe-laplacian*.py`):
 *
 * - **implicit, not explicit.** Fitting `x = (x0 + L t)/(1 + L)` to four
 *   values of `lambda` gives the same `L/lambda` to six places, which a
 *   single explicit step cannot do.
 * - **the target is the cotangent umbrella**, not the neighbour mean. On nine
 *   differently-shaped fans the measured displacement points at it to within
 *   1e-9, where the mean is 10° away.
 * - **`L_i = lambda/(12 A_i)`**, over 27 fans across three valences, three
 *   radii and three apex heights. This took three probes: on a cone
 *   `Σw/L` happens to be independent of the height, which sent two runs
 *   looking for a denominator with no area in it at all.
 * - **it is one coupled solve.** Every fan has a boundary rim, so its single
 *   interior vertex decouples and Jacobi, Gauss-Seidel and a solve all agree.
 *   Grids and a closed icosphere tell them apart, and the solve wins.
 *
 * Against Blender the whole rule reproduces to **1.2e-7** — float32, which is
 * what Blender stores coordinates in — on fans, on grids whose interior
 * vertices are coupled, and on an icosphere with no boundary at all.
 *
 * ## Quads
 *
 * A cotangent weight is a statement about a triangle, and Blender does not
 * simply triangulate: a quad contributes **both** of its triangulations with
 * every weight halved, diagonals included, and **half** its area to each
 * corner. Measured, that predicts Blender's whole output to 2.0e-17 on a 4x4
 * quad grid and 2.5e-11 on a 6x6, against 3.7e-3 to 1.5e-2 for plain
 * triangulation either way round.
 *
 * On a sheet made deliberately irregular in all three axes the same rule
 * lands at **2.9e-6**, which is thirty times float32 and so is a real
 * remainder — the two triangulations of a strongly non-planar quad have
 * different areas, and which one Blender takes is not settled. Cages are not
 * that bent; this is recorded rather than hidden.
 *
 * ## What this does not do, and why
 *
 * - **`lambda_border` is not offered.** Blender's is **frame-dependent**,
 *   which makes it a bug rather than a rule to copy: at the origin every rim
 *   vertex comes back at exactly `x / (1 + 2·lambda_border)` — a scaling
 *   toward the world origin, not a move toward its neighbours, measured on an
 *   irregular rim where the two are nothing alike. Translate the same mesh to
 *   x+4 and the operator stops doing anything at all, interior vertices
 *   included; past `lambda_border` 4 it also stops. With it at 0 the operator
 *   is exact and translating the mesh 100 units changes nothing.
 * - **no vertex selection.** Blender's `verts=` does not mean "smooth these
 *   and pin the rest". Measured on a 25-vertex grid: selecting the 9 interior
 *   vertices moves the same 9 but lands them 0.036 away from selecting all
 *   25; selecting one or two moves nothing; and selecting the 16 border
 *   vertices moves exactly the 10 of them that are **not** in any
 *   fully-selected face. No reading fits all four. Smoothing part of a mesh
 *   is better served by running this and blending the result.
 * - **n-gons are refused.** Blender has a path for them — an 8-gon does move
 *   things — but it has not been measured, and guessing here would be the
 *   fourth time this operator was written down wrong.
 */
import type { MeshData } from "../../lib/mesh";

export interface SmoothLaplacianOptions {
  /** Blender's `lambda_factor`. Default 1. Larger relaxes further. */
  lambda?: number;
  /** Whether each axis may move. Default **true** — see below. */
  useX?: boolean;
  useY?: boolean;
  useZ?: boolean;
  /**
   * Residual the solver stops at, relative to the right-hand side.
   * Default 1e-12, which is well inside the float32 the comparison is made
   * in.
   */
  tolerance?: number;
  /** Cap on solver iterations. Default 2000. */
  maxIterations?: number;
}

/** One row of the system: the diagonal, and the off-diagonal entries. */
interface Row {
  diag: number;
  cols: number[];
  vals: number[];
}

/**
 * Relax a surface toward its own curvature.
 *
 * ```ts
 * const relaxed = smoothLaplacianVert(noisy, { lambda: 2 });
 * ```
 *
 * **The axis flags default to `true` here and to `false` in Blender.** That
 * is deliberate: Blender's defaults make the operator do nothing, which is
 * how it spent three sessions in this project's "the reference will not act"
 * list. Anyone who wants one axis can say so; nobody wants the no-op.
 *
 * Boundary vertices are held. Triangles and quads only — an n-gon throws,
 * because Blender's n-gon path has not been measured.
 */
export function smoothLaplacianVert(
  data: MeshData,
  opts: SmoothLaplacianOptions = {},
): MeshData {
  const lambda = opts.lambda ?? 1;
  const use = [opts.useX ?? true, opts.useY ?? true, opts.useZ ?? true];
  const tolerance = opts.tolerance ?? 1e-12;
  const maxIterations = opts.maxIterations ?? 2000;

  const P = Float64Array.from(data.positions);
  const count = P.length / 3;

  for (const poly of data.polys)
    if (poly.length > 4)
      throw new Error(
        `smoothLaplacianVert: ${poly.length}-gon — Blender's n-gon path is not measured`,
      );

  // ── weights, areas, and which edges have one face ────────────────────────
  const weights: Map<number, number>[] = Array.from({ length: count }, () => new Map());
  const area = new Float64Array(count);
  const edgeFaces = new Map<number, number>();

  const at = (v: number): [number, number, number] => [P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!];

  const addWeight = (p: number, q: number, value: number): void => {
    weights[p]!.set(q, (weights[p]!.get(q) ?? 0) + value);
    weights[q]!.set(p, (weights[q]!.get(p) ?? 0) + value);
  };

  /** cot of the angle at `o`, for the edge (p, q). */
  const cot = (p: number, q: number, o: number): number => {
    const [ox, oy, oz] = at(o);
    const [px, py, pz] = at(p);
    const [qx, qy, qz] = at(q);
    const ux = px - ox, uy = py - oy, uz = pz - oz;
    const tx = qx - ox, ty = qy - oy, tz = qz - oz;
    const cx = uy * tz - uz * ty;
    const cy = uz * tx - ux * tz;
    const cz = ux * ty - uy * tx;
    const s = Math.hypot(cx, cy, cz);
    return s > 1e-14 ? (ux * tx + uy * ty + uz * tz) / s : 0;
  };

  const triArea = (a: number, b: number, c: number): number => {
    const [ax, ay, az] = at(a);
    const [bx, by, bz] = at(b);
    const [cx0, cy0, cz0] = at(c);
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx0 - ax, vy = cy0 - ay, vz = cz0 - az;
    return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  };

  const triangle = (a: number, b: number, c: number, scale = 1): void => {
    addWeight(a, b, cot(a, b, c) * scale);
    addWeight(b, c, cot(b, c, a) * scale);
    addWeight(c, a, cot(c, a, b) * scale);
  };

  for (const poly of data.polys) {
    if (poly.length === 3) {
      const [a, b, c] = poly as [number, number, number];
      triangle(a, b, c);
      const ar = triArea(a, b, c);
      for (const v of poly) area[v]! += ar;
    } else if (poly.length === 4) {
      const [a, b, c, d] = poly as [number, number, number, number];
      // Both triangulations, halved, diagonals kept — measured, and the one
      // reading of six that gets a quad grid exactly right.
      triangle(a, b, c, 0.5);
      triangle(a, c, d, 0.5);
      triangle(b, c, d, 0.5);
      triangle(b, d, a, 0.5);
      const ar = (triArea(a, b, c) + triArea(a, c, d)) / 2;
      for (const v of poly) area[v]! += ar;
    } else {
      continue; // a 1- or 2-gon carries no area and no angle
    }
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!;
      const q = poly[(i + 1) % poly.length]!;
      const key = p < q ? p * count + q : q * count + p;
      edgeFaces.set(key, (edgeFaces.get(key) ?? 0) + 1);
    }
  }

  const boundary = new Uint8Array(count);
  for (const [key, n] of edgeFaces) {
    if (n !== 1) continue;
    boundary[Math.floor(key / count)] = 1;
    boundary[key % count] = 1;
  }

  // ── the system ──────────────────────────────────────────────────────────
  const rows: Row[] = [];
  for (let i = 0; i < count; i++) {
    const w = weights[i]!;
    let ws = 0;
    for (const value of w.values()) ws += value;
    if (boundary[i] || area[i]! <= 0 || w.size === 0 || Math.abs(ws) < 1e-14) {
      rows.push({ diag: 1, cols: [], vals: [] });
      continue;
    }
    const L = lambda / (12 * area[i]!);
    const cols: number[] = [];
    const vals: number[] = [];
    for (const [j, wij] of w) {
      cols.push(j);
      vals.push((-L * wij) / ws);
    }
    rows.push({ diag: 1 + L, cols, vals });
  }

  const out = Float64Array.from(P);
  for (let axis = 0; axis < 3; axis++) {
    if (!use[axis]) continue;
    const b = new Float64Array(count);
    for (let i = 0; i < count; i++) b[i] = P[i * 3 + axis]!;
    const x = bicgstab(rows, b, tolerance, maxIterations);
    for (let i = 0; i < count; i++) out[i * 3 + axis] = x[i]!;
  }

  return {
    positions: new Float32Array(out),
    polys: data.polys.map((p) => [...p]),
    ...(data.creases ? { creases: new Map(data.creases) } : {}),
    ...(data.seams ? { seams: new Set(data.seams) } : {}),
    ...(data.edges ? { edges: data.edges.map((e) => [...e]) } : {}),
    ...(data.uvs ? { uvs: data.uvs.map((f) => f.map((c) => [...c])) } : {}),
    ...(data.colors ? { colors: data.colors.map((f) => f.map((c) => [...c])) } : {}),
  };
}

/** y = A·x, with A in the row form above. */
function apply(rows: Row[], x: Float64Array, y: Float64Array): void {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    let sum = row.diag * x[i]!;
    for (let k = 0; k < row.cols.length; k++) sum += row.vals[k]! * x[row.cols[k]!]!;
    y[i] = sum;
  }
}

/**
 * BiCGSTAB with Jacobi preconditioning.
 *
 * **Not conjugate gradient**, because the matrix is not symmetric: the row for
 * vertex `i` divides by `i`'s own weight sum, so the `(i, j)` and `(j, i)`
 * entries differ whenever two vertices have different one-ring areas — which
 * is nearly always. CG on this converges to the wrong answer quietly, which
 * is the worst way to be wrong here.
 *
 * It is also not Gauss-Seidel. The system is diagonally dominant only while
 * every cotangent weight is positive, and an obtuse triangle makes one
 * negative — common in a cage and in anything a boolean has touched.
 */
function bicgstab(
  rows: Row[],
  b: Float64Array,
  tolerance: number,
  maxIterations: number,
): Float64Array {
  const n = b.length;
  const x = Float64Array.from(b); // the input positions are a good first guess
  const r = new Float64Array(n);
  const tmp = new Float64Array(n);
  apply(rows, x, tmp);
  let bnorm = 0;
  for (let i = 0; i < n; i++) {
    r[i] = b[i]! - tmp[i]!;
    bnorm += b[i]! * b[i]!;
  }
  bnorm = Math.sqrt(bnorm) || 1;

  const inv = new Float64Array(n);
  for (let i = 0; i < n; i++) inv[i] = rows[i]!.diag !== 0 ? 1 / rows[i]!.diag : 1;

  const r0 = Float64Array.from(r);
  const p = new Float64Array(n);
  const v = new Float64Array(n);
  const s = new Float64Array(n);
  const t = new Float64Array(n);
  const ph = new Float64Array(n);
  const sh = new Float64Array(n);
  let rho = 1;
  let alpha = 1;
  let omega = 1;

  const dot = (a: Float64Array, c: Float64Array): number => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += a[i]! * c[i]!;
    return sum;
  };
  const norm = (a: Float64Array): number => Math.sqrt(dot(a, a));

  if (norm(r) / bnorm <= tolerance) return x;

  for (let it = 0; it < maxIterations; it++) {
    const rhoNew = dot(r0, r);
    if (Math.abs(rhoNew) < 1e-300) break; // breakdown; keep the best so far
    if (it === 0) {
      p.set(r);
    } else {
      const beta = (rhoNew / rho) * (alpha / omega);
      for (let i = 0; i < n; i++) p[i] = r[i]! + beta * (p[i]! - omega * v[i]!);
    }
    rho = rhoNew;

    for (let i = 0; i < n; i++) ph[i] = inv[i]! * p[i]!;
    apply(rows, ph, v);
    const denom = dot(r0, v);
    if (Math.abs(denom) < 1e-300) break;
    alpha = rho / denom;

    for (let i = 0; i < n; i++) s[i] = r[i]! - alpha * v[i]!;
    if (norm(s) / bnorm <= tolerance) {
      for (let i = 0; i < n; i++) x[i] = x[i]! + alpha * ph[i]!;
      return x;
    }

    for (let i = 0; i < n; i++) sh[i] = inv[i]! * s[i]!;
    apply(rows, sh, t);
    const tt = dot(t, t);
    omega = tt > 1e-300 ? dot(t, s) / tt : 0;

    for (let i = 0; i < n; i++) x[i] = x[i]! + alpha * ph[i]! + omega * sh[i]!;
    for (let i = 0; i < n; i++) r[i] = s[i]! - omega * t[i]!;
    if (norm(r) / bnorm <= tolerance) return x;
    if (omega === 0) break;
  }
  return x;
}

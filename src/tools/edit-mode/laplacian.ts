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
 * L_i = lambda / (4 · ring_i)
 * ```
 *
 * where `ring_i` is the sum of the **corner triangles** touching `i` — for
 * each corner of each face, the triangle (prev, curr, next), its area added to
 * all three of them — and `w_ij` are the usual cotangent weights. A triangle's
 * own area therefore lands in `ring_i` three times, which is why this is the
 * same thing as the `lambda / (12 · A_i)` the probes fitted on fans.
 *
 * Boundary vertices are pinned. Everything in it is measured, and each piece
 * took its own probe (`tools/modeling/parity/probe-laplacian*.py`):
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
 * every weight halved, diagonals included. Measured, that predicts Blender's
 * whole output to 2.0e-17 on a 4x4 quad grid and 2.5e-11 on a 6x6, against
 * 3.7e-3 to 1.5e-2 for plain triangulation either way round. It is also what
 * the loop walk in `init_laplacian_matrix` comes to, read later: the four
 * corner triangles, each weight halved.
 *
 * **The area is the part that took reading the source.** For three sessions
 * this file said "half its area to each corner", which is the closest of six
 * guesses and still left 2.9e-6 on a strongly bent sheet — thirty times
 * float32, so a real remainder. There is no triangulation in it: the ring area
 * is the sum of the corner triangles, so a quad gives each of its corners
 * three of its four, with the fourth — the one opposite — left out. With that,
 * the `saddleGrid` parity case went from 0.02 mm to **0.0000 mm**.
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
 * - **n-gons are refused.** Blender's loop walk is general and would handle
 *   them, and the corner-triangle form above is the shape of that path — but
 *   it has not been *measured* here, and guessing would be the fourth time
 *   this operator got written down wrong.
 *
 * ## The two clamps, which no well-proportioned mesh can see
 *
 * Both come straight from `bmo_smooth_laplacian.cc` and both only ever
 * subtract movement:
 *
 * - **a corner triangle under `1e-5` freezes its own vertex** (Blender's
 *   `zerola`), not its neighbours.
 * - **`validate_solution`** throws away the answer for *both* ends of any edge
 *   the solve would stretch past **1.8x** or squash below **0.15x** of its
 *   original length. Those vertices keep the positions they came in with.
 *
 * A cage's edges never come near either limit, which is exactly why the
 * `character` parity case was the only one of three that could see it: dense
 * thin triangles, and 22 mm of average error on the interior vertices that no
 * amount of solver tuning was going to explain. With the clamps in, that case
 * reads **0.0001 mm**, and the two sides freeze **the same 812 vertices of
 * 1495** — the same set, not just the same count.
 *
 * **What is not read: exactly when the edge clamp fires.** A 4x4 sheet with two
 * interior vertices deliberately brought 0.0005 apart has the solve pull that
 * edge to 79x its length, which is far past the 1.8x ceiling, and **neither
 * Blender nor this freezes them** — both move them to the same place, to six
 * decimals (`probe-laplacian24.py`). So the trigger is narrower than the code
 * reads, in the same way on both sides. It is recorded rather than guessed at:
 * every case measured agrees, and the next person should not assume the
 * condition is understood.
 */
import { withPositions, type MeshData } from "../../lib/mesh";

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
export interface Row {
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
  // Blender's three constants, from `bmo_smooth_laplacian.cc`: a corner
  // triangle thinner than `min_area` freezes its vertex, and an edge the solve
  // would stretch or squash past these ratios disqualifies both of its ends.
  const MIN_AREA = 0.00001;
  const MAX_EDGE_RATIO = 1.8;
  const MIN_EDGE_RATIO = 0.15;

  for (const poly of data.polys)
    if (poly.length > 4)
      throw new Error(
        `smoothLaplacianVert: ${poly.length}-gon — Blender's n-gon path is not measured`,
      );

  // ── weights, areas, and which edges have one face ────────────────────────
  const weights: Map<number, number>[] = Array.from({ length: count }, () => new Map());
  /** Blender's `ring_areas`: the sum of the corner triangles touching a vertex. */
  const area = new Float64Array(count);
  /** Blender's `zerola`: vertices whose row is the identity, so they do not move. */
  const frozen = new Uint8Array(count);
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
    } else if (poly.length === 4) {
      const [a, b, c, d] = poly as [number, number, number, number];
      // Both triangulations, halved, diagonals kept — measured, and the one
      // reading of six that gets a quad grid exactly right. It is also what
      // Blender's loop walk comes to: the four corner triangles, each weight
      // halved. Only the **scale** of these matters, because the row divides
      // by the vertex's own weight sum.
      triangle(a, b, c, 0.5);
      triangle(a, c, d, 0.5);
      triangle(b, c, d, 0.5);
      triangle(b, d, a, 0.5);
    } else {
      continue; // a 1- or 2-gon carries no area and no angle
    }

    // The one-ring area, exactly as `init_laplacian_matrix` accumulates it:
    // **per corner**, the triangle (prev, curr, next), its area added to all
    // three of those vertices. For a triangle that is the face's own area
    // counted three times over — which is where the 12 in `lambda/(12·A)`
    // comes from — and for a quad it is three of the four corner triangles at
    // each corner, which is a different number from "half of one
    // triangulation" and the 0.02 mm the `saddleGrid` row used to be out by.
    for (let i = 0; i < poly.length; i++) {
      const prev = poly[(i - 1 + poly.length) % poly.length]!;
      const curr = poly[i]!;
      const next = poly[(i + 1) % poly.length]!;
      const areaf = triArea(prev, curr, next);
      // A corner thinner than this freezes **its own** vertex, not its
      // neighbours — `sys->zerola[vi_curr] = true` and nothing else.
      if (areaf < MIN_AREA) frozen[curr] = 1;
      area[prev]! += areaf;
      area[curr]! += areaf;
      area[next]! += areaf;
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
    if (frozen[i] || boundary[i] || area[i]! <= 0 || w.size === 0 || Math.abs(ws) < 1e-14) {
      rows.push({ diag: 1, cols: [], vals: [] });
      continue;
    }
    // `1 + lambda/(4·ring_areas)` on the diagonal. The familiar `12·A` is this
    // with a triangle's ring area written out — it counts each incident
    // triangle three times.
    const L = lambda / (4 * area[i]!);
    const cols: number[] = [];
    const vals: number[] = [];
    for (const [j, wij] of w) {
      cols.push(j);
      vals.push((-L * wij) / ws);
    }
    rows.push({ diag: 1 + L, cols, vals });
  }

  // All three axes are solved whatever `use` says, because the check below
  // reads the solved position as a whole — Blender sets the right-hand side
  // for x, y and z unconditionally and only consults `use_*` when writing the
  // answer back.
  const solved = Float64Array.from(P);
  for (let axis = 0; axis < 3; axis++) {
    const b = new Float64Array(count);
    for (let i = 0; i < count; i++) b[i] = P[i * 3 + axis]!;
    const x = bicgstab(rows, b, tolerance, maxIterations);
    for (let i = 0; i < count; i++) solved[i * 3 + axis] = x[i]!;
  }

  // `validate_solution`: an edge that the solve would stretch past 1.8x or
  // squash below 0.15x of its length **disqualifies both of its ends**, which
  // keep the positions they came in with. This is the whole of the 22 mm the
  // `character` row was out by, and it is invisible on anything well
  // proportioned: a cage's edges never come near either limit, so the row's
  // other two cases cannot see it. Dense thin triangles can, and do.
  const rejected = new Uint8Array(count);
  const seen = new Set<number>();
  const check = (p: number, q: number): void => {
    const key = p < q ? p * count + q : q * count + p;
    if (seen.has(key)) return;
    seen.add(key);
    const before = Math.hypot(
      P[p * 3]! - P[q * 3]!,
      P[p * 3 + 1]! - P[q * 3 + 1]!,
      P[p * 3 + 2]! - P[q * 3 + 2]!,
    );
    const after = Math.hypot(
      solved[p * 3]! - solved[q * 3]!,
      solved[p * 3 + 1]! - solved[q * 3 + 1]!,
      solved[p * 3 + 2]! - solved[q * 3 + 2]!,
    );
    if (after > before * MAX_EDGE_RATIO || after < before * MIN_EDGE_RATIO) {
      rejected[p] = 1;
      rejected[q] = 1;
    }
  };
  for (const poly of data.polys)
    for (let i = 0; i < poly.length; i++) check(poly[i]!, poly[(i + 1) % poly.length]!);
  for (const e of data.edges ?? []) check(e[0]!, e[1]!);

  const out = Float64Array.from(P);
  for (let i = 0; i < count; i++) {
    if (rejected[i]) continue;
    for (let axis = 0; axis < 3; axis++) if (use[axis]) out[i * 3 + axis] = solved[i * 3 + axis]!;
  }

  return withPositions(data, new Float32Array(out));
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
export function bicgstab(
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

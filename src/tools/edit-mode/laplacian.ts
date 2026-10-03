/**
 * Laplacian smoothing — Blender's `smooth_laplacian_vert`
 * (`bmo_smooth_laplacian.cc`, 5.1.1; the operator behind
 * `bpy.ops.mesh.vertices_smooth_laplacian`), ported whole on `bmesh-lite`.
 *
 * Unlike `smoothVert`, which averages a vertex with its neighbours and so
 * shrinks whatever it touches, this relaxes the surface toward its own
 * curvature: it keeps the shape's volume far better and is what you reach for
 * when a scan or a boolean has left a surface noisy but the silhouette has to
 * survive.
 *
 * Pure and headless.
 *
 * ## The rule
 *
 * It is **implicit** — one linear least-squares solve, not a sweep. For every
 * vertex that is not on a boundary:
 *
 * ```
 * (1 + L_i) x_i  −  L_i · (Σ_j w_ij x_j) / (Σ_j w_ij)  =  x0_i
 * L_i = lambda / (4 · ring_i)
 * ```
 *
 * where `ring_i` is the sum of the **corner triangles** touching `i` — for
 * each corner of each selected face, the triangle (prev, curr, next), its
 * area added to all three of them — and `w_ij` the cotangent weights, each
 * corner contributing half of its triangle's. A triangle's own area therefore
 * lands in `ring_i` three times (the `lambda / (12 · A_i)` the first probes
 * fitted on fans), and a quad's corner triangles are the four of its two
 * triangulations, which is why a quad is not simply two triangles.
 *
 * ## Selection decides what a vertex is
 *
 * Blender does not read `verts=` alone. A **face counts only if it is
 * selected**, and a vertex is a *boundary* vertex when one of its edges has a
 * single face **or one of its faces is not selected**. Boundary rows are the
 * identity plus `lambda_border` — and the border-edge terms that would smooth
 * them along the border (`1 / length` weights) are built only for edges that
 * are boundary and **not** selected. With everything selected, which is what
 * the operator sees when the whole mesh is, no edge qualifies, so a boundary
 * vertex's row is `(1 + 2·lambda_border) · x_i = x0_i` — a **scaling toward
 * the world origin**, which {@link SmoothLaplacianOptions.lambdaBorder} reproduces.
 * An earlier version of this file called that "frame-dependent" and refused
 * `lambda_border`; the frame dependence is real and it is this.
 *
 * `verts` is taken as a vertex selection in **vertex select mode**: an edge
 * is selected when both ends are, a face when all its corners are.
 *
 * Variables are locked for every vertex **not** in `verts`, at the value `0`
 * (Blender only sets the unlocked ones). The solve itself never reads them — a
 * selected, non-boundary vertex only references the corners of its own
 * selected faces — but `validate_solution` does, so a selected vertex next to
 * an unselected one sees that edge as stretched to or from the origin and is
 * frozen, and one border term (a boundary edge with a single selected end) is
 * built from the raw `1 / length` sum and pulls toward 0. That is the reason a
 * partial selection gives results "no reading fits": they are all one reading
 * of the same quirk.
 *
 * ## The clamps
 *
 * - **a corner triangle under `1e-5` freezes its own vertex** (`zerola`);
 * - **`validate_solution`** throws away the answer for *both* ends of any edge
 *   the solve would stretch past **1.8x** or squash below **0.15x** of its
 *   original length. Those vertices keep the positions they came in with.
 *
 * ## Volume
 *
 * `preserve_volume` measures the mesh's volume before and after
 * (`BM_mesh_calc_volume`, every face tessellated by the ear-clip polyfill,
 * absolute value) and scales the smoothed vertices by `cbrt(before / after)`
 * **about the world origin** — frame-dependent by construction.
 *
 * Coordinates, weights and areas are held in float32 as Blender does; the
 * solve is double (Eigen's sparse LU on the normal equations, here
 * preconditioned conjugate gradients on the same system).
 */
import { withPositions, type MeshData } from "../../lib/mesh";
import { f, sub, dot, cross, type V3 } from "../blender-math";
import { bmFromMesh, diskEdges, faceLoops, isBoundary, liveEdges, liveFaces, loopsOfVert, type BM, type BV } from "../bmesh-lite";
import { ngonTriangles } from "../triangulate";

export interface SmoothLaplacianOptions {
  /** Blender's `lambda_factor`. Default 1. Larger relaxes further. */
  lambda?: number;
  /**
   * Blender's `lambda_border`. Default **0**, which leaves the boundary where
   * it is; see the module comment for what a positive value does with the
   * whole mesh selected. (The operator's own default is 5e-5.)
   */
  lambdaBorder?: number;
  /** Whether each axis may move. Default **true** — Blender's bmesh op defaults to false and then does nothing. */
  useX?: boolean;
  useY?: boolean;
  useZ?: boolean;
  /** Blender's `preserve_volume`. Default false (the operator's is true). */
  preserveVolume?: boolean;
  /**
   * The vertices to smooth, as a vertex selection. Default all. Vertices
   * outside it are locked at the origin, as Blender does — see above.
   */
  verts?: Iterable<number>;
  /** Residual the solver stops at, relative to the right-hand side. Default 1e-13. */
  tolerance?: number;
  /** Cap on solver iterations. Default 20000. */
  maxIterations?: number;
}

const SMOOTH_LAPLACIAN_MAX_EDGE_PERCENTAGE = 1.8;
const SMOOTH_LAPLACIAN_MIN_EDGE_PERCENTAGE = 0.15;
const MIN_AREA = f(0.00001);
const FLT_EPSILON = 1.1920928955078125e-7;

const len3 = (a: V3): number => f(Math.sqrt(dot(a, a)));
/** `area_tri_v3`: `len(cross_tri) / 2`, `cross_tri_v3 = (v1 − v2) × (v2 − v3)`. */
const areaTri = (a: V3, b: V3, c: V3): number => f(len3(cross(sub(a, b), sub(b, c))) * 0.5);
/** `cotangent_tri_weight_v3`. */
function cotTriWeight(v1: V3, v2: V3, v3: V3): number {
  const a = sub(v2, v1);
  const b = sub(v3, v1);
  const cLen = len3(cross(a, b));
  return cLen > FLT_EPSILON ? f(dot(a, b) / cLen) : 0;
}

/**
 * Relax a surface toward its own curvature — `bmesh.ops.smooth_laplacian_vert`.
 *
 * ```ts
 * const relaxed = smoothLaplacianVert(noisy, { lambda: 2 });
 * ```
 *
 * **The axis flags default to `true` here and to `false` in Blender.** That
 * is deliberate: Blender's defaults make the operator do nothing, which is
 * how it spent three sessions in this project's "the reference will not act"
 * list.
 *
 * Triangles, quads and n-gons. A mesh with no faces comes back unchanged.
 */
export function smoothLaplacianVert(data: MeshData, opts: SmoothLaplacianOptions = {}): MeshData {
  if (data.polys.length === 0) return data;
  const lambdaFactor = f(opts.lambda ?? 1);
  const lambdaBorder = f(opts.lambdaBorder ?? 0);
  const use = [opts.useX ?? true, opts.useY ?? true, opts.useZ ?? true];
  const preserveVolume = !!opts.preserveVolume;
  const count = data.positions.length / 3;
  const slot = [...new Set(opts.verts ?? Array.from({ length: count }, (_, i) => i))].filter((v) => v >= 0 && v < count);
  const out = solveOnce(data, slot, lambdaFactor, lambdaBorder, use, preserveVolume, opts.tolerance ?? 1e-13, opts.maxIterations ?? 20000);
  return withPositions(data, out);
}

/** Options of {@link smoothLaplacianSelection}: `bpy.ops.mesh.vertices_smooth_laplacian`'s. */
export interface SmoothLaplacianSelectionOptions {
  /** `repeat`, default 1: passes, each reading the last one's result. */
  repeat?: number;
  /** `lambda_factor`, default 1. */
  lambdaFactor?: number;
  /** `lambda_border`, default **5e-5**. */
  lambdaBorder?: number;
  /** `use_x` / `use_y` / `use_z`, default true. */
  useX?: boolean;
  useY?: boolean;
  useZ?: boolean;
  /** `preserve_volume`, default **true**. */
  preserveVolume?: boolean;
  /** The selected vertices, default all. */
  verts?: Iterable<number>;
}

/**
 * Laplacian Smooth as the **operator** runs it —
 * `bpy.ops.mesh.vertices_smooth_laplacian` (`edbm_do_smooth_laplacian_vertex_exec`):
 * {@link smoothLaplacianVert} with the operator's defaults (a `lambda_border`
 * of 5e-5 and the volume preserved, where the bmesh op's are 0 and off) and
 * `repeat` passes. The border value is not a no-op — with the whole mesh
 * selected it scales every rim vertex by `1 / (1 + 2·5e-5)` toward the origin.
 */
export function smoothLaplacianSelection(data: MeshData, opts: SmoothLaplacianSelectionOptions = {}): MeshData {
  let out = data;
  const verts = opts.verts ? [...opts.verts] : undefined;
  for (let i = 0; i < Math.max(1, Math.floor(opts.repeat ?? 1)); i++)
    out = smoothLaplacianVert(out, {
      lambda: opts.lambdaFactor ?? 1,
      lambdaBorder: opts.lambdaBorder ?? 5e-5,
      useX: opts.useX,
      useY: opts.useY,
      useZ: opts.useZ,
      preserveVolume: opts.preserveVolume ?? true,
      verts,
    });
  return out;
}

/** One `bmo_smooth_laplacian_vert_exec`. */
function solveOnce(
  data: MeshData,
  slot: number[],
  lambdaFactor: number,
  lambdaBorder: number,
  use: boolean[],
  preserveVolume: boolean,
  tolerance: number,
  maxIterations: number,
): Float32Array {
  const bm = bmFromMesh(data);
  const faces = liveFaces(bm);
  const count = bm.verts.length;
  const co = (v: BV): V3 => v.co;
  const id = (v: BV): number => v.index;

  // The selection, as vertex select mode flushes it.
  const inSlot = new Uint8Array(count);
  for (const v of slot) inSlot[v] = 1;
  const edgeSel = new Map<object, boolean>();
  for (const e of liveEdges(bm)) edgeSel.set(e, !!inSlot[e.v1.index] && !!inSlot[e.v2.index]);
  const faceSel = new Map<object, boolean>();
  for (const fc of faces) faceSel.set(fc, faceLoops(fc).every((l) => inSlot[l.v.index]));

  const eweights = new Map<object, number>();
  const fweights: [number, number, number][] = [];
  const ringAreas = new Float64Array(count);
  const vlengths = new Float64Array(count);
  const vweights = new Float64Array(count);
  const zerola = new Uint8Array(count);
  // Float32 accumulators: JS doubles rounded at every add.
  const addF = (arr: Float64Array, i: number, x: number): void => {
    arr[i] = f(arr[i]! + x);
  };

  // init_laplacian_matrix
  for (const e of liveEdges(bm)) {
    if (edgeSel.get(e) || !isBoundary(e)) continue;
    let w1 = f(Math.sqrt(dot(sub(co(e.v1), co(e.v2)), sub(co(e.v1), co(e.v2)))));
    if (w1 > MIN_AREA) {
      w1 = f(1 / w1);
      eweights.set(e, w1);
      addF(vlengths, id(e.v1), w1);
      addF(vlengths, id(e.v2), w1);
    } else {
      zerola[id(e.v1)] = 1;
      zerola[id(e.v2)] = 1;
    }
  }
  const loopBase = new Map<object, number>();
  let lCurr = 0;
  for (const fc of faces) {
    loopBase.set(fc, lCurr);
    if (!faceSel.get(fc)) {
      lCurr += fc.len;
      continue;
    }
    for (const l of faceLoops(fc)) {
      const viPrev = id(l.prev.v);
      const viCurr = id(l.v);
      const viNext = id(l.next.v);
      const cp = co(l.prev.v);
      const cc = co(l.v);
      const cn = co(l.next.v);
      const areaf = areaTri(cp, cc, cn);
      if (areaf < MIN_AREA) zerola[viCurr] = 1;
      addF(ringAreas, viPrev, areaf);
      addF(ringAreas, viCurr, areaf);
      addF(ringAreas, viNext, areaf);
      const w1 = f(cotTriWeight(cc, cn, cp) / 2);
      const w2 = f(cotTriWeight(cn, cp, cc) / 2);
      const w3 = f(cotTriWeight(cp, cc, cn) / 2);
      const k = lCurr++;
      fweights[k] = [w1, w2, w3];
      addF(vweights, viPrev, f(w1 + w2));
      addF(vweights, viCurr, f(w2 + w3));
      addF(vweights, viNext, f(w1 + w3));
    }
  }

  const isBoundaryVert = (v: BV): boolean => {
    for (const e of diskEdges(v)) if (isBoundary(e)) return true;
    for (const l of loopsOfVert(v)) if (!faceSel.get(l.f)) return true;
    return false;
  };
  const boundaryCache = new Map<BV, boolean>();
  const vertIsBoundary = (v: BV): boolean => {
    let b = boundaryCache.get(v);
    if (b === undefined) boundaryCache.set(v, (b = isBoundaryVert(v)));
    return b;
  };

  // The matrix: rows = every vertex, columns = the slot's vertices (the rest are locked at 0).
  const colOf = new Int32Array(count).fill(-1);
  slot.forEach((v, k) => (colOf[v] = k));
  const rowsT: { r: number; c: number; v: number }[] = [];
  const add = (row: number, col: number, value: number): void => {
    if (colOf[col]! < 0) return; // a locked column at 0 contributes nothing
    rowsT.push({ r: row, c: colOf[col]!, v: value });
  };
  const rhs: Float64Array[] = [0, 1, 2].map(() => new Float64Array(count));

  for (const vi of slot) {
    const v = bm.verts[vi]!;
    for (let a = 0; a < 3; a++) rhs[a]![vi] = v.co[a]!;
    const i = vi;
    if (!zerola[i] && ringAreas[i] !== 0) {
      let w = f(vweights[i]! * ringAreas[i]!);
      vweights[i] = w === 0 ? 0 : f(f(-lambdaFactor) / f(4 * w));
      w = vlengths[i]!;
      vlengths[i] = w === 0 ? 0 : f(f(f(-lambdaBorder) * 2) / w);
      if (!vertIsBoundary(v)) add(i, i, f(1 + f(lambdaFactor / f(4 * ringAreas[i]!))));
      else add(i, i, f(1 + f(lambdaBorder * 2)));
    } else {
      add(i, i, 1);
    }
  }

  // fill_laplacian_matrix
  for (const fc of faces) {
    if (!faceSel.get(fc)) continue;
    const ls = faceLoops(fc);
    let k = loopBase.get(fc)!;
    let l0 = ls[0]!;
    let viPrev = id(l0.prev.v);
    let viCurr = id(l0.v);
    const okOf = (v: BV): boolean => !zerola[id(v)] && !vertIsBoundary(v);
    let okPrev = okOf(l0.prev.v);
    let okCurr = okOf(l0.v);
    for (const l of ls) {
      const viNext = id(l.next.v);
      const okNext = okOf(l.next.v);
      const fw = fweights[k]!;
      if (okPrev) {
        add(viPrev, viCurr, f(fw[1] * vweights[viPrev]!));
        add(viPrev, viNext, f(fw[0] * vweights[viPrev]!));
      }
      if (okCurr) {
        add(viCurr, viNext, f(fw[2] * vweights[viCurr]!));
        add(viCurr, viPrev, f(fw[1] * vweights[viCurr]!));
      }
      if (okNext) {
        add(viNext, viCurr, f(fw[2] * vweights[viNext]!));
        add(viNext, viPrev, f(fw[0] * vweights[viNext]!));
      }
      viPrev = viCurr;
      viCurr = viNext;
      okPrev = okCurr;
      okCurr = okNext;
      k++;
    }
    l0 = ls[0]!;
  }
  for (const e of liveEdges(bm)) {
    if (edgeSel.get(e) || !isBoundary(e)) continue;
    const i1 = id(e.v1);
    const i2 = id(e.v2);
    if (!zerola[i1] && !zerola[i2]) {
      const w = eweights.get(e) ?? 0;
      add(i1, i2, f(w * vlengths[i1]!));
      add(i2, i1, f(w * vlengths[i2]!));
    }
  }

  const solved = leastSquares(rowsT, rhs, count, slot.length, colOf, tolerance, maxIterations);
  const start = Float32Array.from(data.positions);
  if (!solved) return start;

  // validate_solution — the locked variables read as 0.
  const ve = (vi: number, a: number): number => (colOf[vi]! >= 0 ? f(solved[a]![colOf[vi]!]!) : 0);
  for (const e of liveEdges(bm)) {
    const i1 = id(e.v1);
    const i2 = id(e.v2);
    const v1: V3 = [ve(i1, 0), ve(i1, 1), ve(i1, 2)];
    const v2: V3 = [ve(i2, 0), ve(i2, 1), ve(i2, 2)];
    const leni = len3(sub(co(e.v1), co(e.v2)));
    const lene = len3(sub(v1, v2));
    if (
      lene > f(leni * f(SMOOTH_LAPLACIAN_MAX_EDGE_PERCENTAGE)) ||
      lene < f(leni * f(SMOOTH_LAPLACIAN_MIN_EDGE_PERCENTAGE))
    ) {
      zerola[i1] = 1;
      zerola[i2] = 1;
    }
  }
  const vini = preserveVolume ? bmVolume(bm) : 0;
  for (const vi of slot) {
    if (zerola[vi]) continue;
    for (let a = 0; a < 3; a++) if (use[a]) bm.verts[vi]!.co[a] = f(solved[a]![colOf[vi]!]!);
  }
  if (preserveVolume) {
    const vend = bmVolume(bm);
    if (f(vend) !== 0) {
      const beta = f(Math.pow(f(f(vini) / f(vend)), f(1 / 3)));
      for (const vi of slot) {
        const v = bm.verts[vi]!;
        for (let a = 0; a < 3; a++) if (use[a]) v.co[a] = f(v.co[a]! * beta);
      }
    }
  }
  const res = Float32Array.from(data.positions);
  for (const v of bm.verts) if (v) for (let a = 0; a < 3; a++) res[v.index * 3 + a] = v.co[a]!;
  return res;
}

/** `BM_mesh_calc_volume(bm, false)`: every face tessellated by the ear-clip polyfill, in double. */
function bmVolume(bm: BM): number {
  let vol = 0;
  for (const fc of liveFaces(bm)) {
    const ls = faceLoops(fc);
    const tris = ls.length === 3 ? [[0, 1, 2]] : ngonTriangles(ls.map((l) => l.v.co), fc.no, "earClip");
    for (const t of tris) {
      const [p1, p2, p3] = t.map((k) => ls[k!]!.v.co) as [V3, V3, V3];
      const cx = p2[1]! * p3[2]! - p2[2]! * p3[1]!;
      const cy = p2[2]! * p3[0]! - p2[0]! * p3[2]!;
      const cz = p2[0]! * p3[1]! - p2[1]! * p3[0]!;
      vol += (p1[0]! * cx + p1[1]! * cy + p1[2]! * cz) / 6;
    }
  }
  return Math.abs(vol);
}

/**
 * `min ‖M x − b‖²` for the three right-hand sides at once — the system Eigen's
 * `EIG_linear_least_squares_solver_new` factorises. A square system is solved
 * as it is (BiCGSTAB); otherwise, and when that does not converge, by
 * conjugate gradients on the normal equations (`MᵀM`, Jacobi-preconditioned).
 * Returns null when neither converges, so nothing half-solved is applied.
 */
function leastSquares(
  triplets: { r: number; c: number; v: number }[],
  rhs: Float64Array[],
  rows: number,
  cols: number,
  colOfRow: Int32Array,
  tolerance: number,
  maxIterations: number,
): Float64Array[] | null {
  if (cols === 0) return rhs.map(() => new Float64Array(0));
  // The usual case: every row with an entry belongs to a selected vertex (a
  // vertex outside the selection is a boundary one, which gets none), so the
  // system is square in the selected vertices and the other rows are zero.
  // Its least-squares solution is its solution, and BiCGSTAB on it converges
  // where conjugate gradients on `MᵀM` (condition number squared) stalls for a
  // large `lambda_factor`.
  if (triplets.every((t) => colOfRow[t.r]! >= 0)) {
    const sq: Row[] = Array.from({ length: cols }, () => ({ diag: 0, cols: [] as number[], vals: [] as number[] }));
    for (const t of triplets) {
      const i = colOfRow[t.r]!;
      if (t.c === i) sq[i]!.diag += t.v;
      else {
        sq[i]!.cols.push(t.c);
        sq[i]!.vals.push(t.v);
      }
    }
    const out: Float64Array[] = [];
    let ok = true;
    for (const b of rhs) {
      const bs = new Float64Array(cols);
      for (let r = 0; r < rows; r++) if (colOfRow[r]! >= 0) bs[colOfRow[r]!] = b[r]!;
      const x = bicgstab(sq, bs, tolerance, maxIterations);
      // bicgstab does not say whether it got there: look.
      const ax = new Float64Array(cols);
      apply(sq, x, ax);
      let rn = 0;
      let bn = 0;
      for (let i = 0; i < cols; i++) {
        rn += (ax[i]! - bs[i]!) ** 2;
        bn += bs[i]! ** 2;
      }
      if (!(Math.sqrt(rn) <= 1e-9 * (Math.sqrt(bn) || 1))) {
        ok = false;
        break;
      }
      out.push(x);
    }
    if (ok) return out;
  }
  const byRow: { c: number; v: number }[][] = Array.from({ length: rows }, () => []);
  for (const t of triplets) byRow[t.r]!.push({ c: t.c, v: t.v });
  const mulM = (x: Float64Array, y: Float64Array): void => {
    for (let r = 0; r < rows; r++) {
      let s = 0;
      for (const { c, v } of byRow[r]!) s += v * x[c]!;
      y[r] = s;
    }
  };
  const mulMt = (y: Float64Array, x: Float64Array): void => {
    x.fill(0);
    for (let r = 0; r < rows; r++) for (const { c, v } of byRow[r]!) x[c]! += v * y[r]!;
  };
  const diag = new Float64Array(cols);
  for (const t of triplets) diag[t.c]! += t.v * t.v;
  const tmp = new Float64Array(rows);
  const mtm = (x: Float64Array, out: Float64Array): void => {
    mulM(x, tmp);
    mulMt(tmp, out);
  };
  const result: Float64Array[] = [];
  for (const b of rhs) {
    const mtb = new Float64Array(cols);
    mulMt(b, mtb);
    const x = new Float64Array(cols);
    const r = Float64Array.from(mtb);
    const z = new Float64Array(cols);
    for (let i = 0; i < cols; i++) z[i] = diag[i]! > 0 ? r[i]! / diag[i]! : r[i]!;
    const p = Float64Array.from(z);
    const q = new Float64Array(cols);
    let rz = 0;
    let bnorm = 0;
    for (let i = 0; i < cols; i++) {
      rz += r[i]! * z[i]!;
      bnorm += mtb[i]! * mtb[i]!;
    }
    bnorm = Math.sqrt(bnorm) || 1;
    for (let it = 0; it < maxIterations; it++) {
      let rn = 0;
      for (let i = 0; i < cols; i++) rn += r[i]! * r[i]!;
      if (Math.sqrt(rn) <= tolerance * bnorm) break;
      mtm(p, q);
      let pq = 0;
      for (let i = 0; i < cols; i++) pq += p[i]! * q[i]!;
      if (!(pq > 0)) return null;
      const alpha = rz / pq;
      for (let i = 0; i < cols; i++) {
        x[i]! += alpha * p[i]!;
        r[i]! -= alpha * q[i]!;
      }
      let rzNew = 0;
      for (let i = 0; i < cols; i++) {
        z[i] = diag[i]! > 0 ? r[i]! / diag[i]! : r[i]!;
        rzNew += r[i]! * z[i]!;
      }
      const beta = rzNew / rz;
      rz = rzNew;
      for (let i = 0; i < cols; i++) p[i] = z[i]! + beta * p[i]!;
      if (it === maxIterations - 1) return null;
    }
    result.push(x);
  }
  return result;
}

// ── the square-system solver `laplacian-smooth.ts` (the modifier) shares ──

/** One row of the system: the diagonal, and the off-diagonal entries. */
export interface Row {
  diag: number;
  cols: number[];
  vals: number[];
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

/**
 * LSCM — Least Squares Conformal Maps (Lévy et al. 2002).
 *
 * Flattens a connected triangle chart to 2D while minimizing angle distortion
 * (conformal = locally shape-preserving). Far better than planar projection on
 * curved charts: a cylinder side or a rounded limb unwraps with even texel
 * density instead of the smear planar projection produces at grazing angles.
 *
 * Method:
 *  - Each triangle is placed in its own orthonormal 2D frame and contributes
 *    the discrete Cauchy-Riemann (conformality) condition as two real linear
 *    equations in the unknown per-vertex (u, v).
 *  - The map is defined only up to a similarity (translation + rotation +
 *    scale), so TWO vertices are pinned to remove that 4-DOF null space. We pin
 *    the two most distant vertices along the U axis, spaced by their 3D
 *    distance, so the result keeps roughly the chart's real scale.
 *  - The resulting least-squares system A·x = b (A: 2·|T| rows, 2·|free| cols)
 *    is solved with CGLS (conjugate gradient on the normal equations) — matrix
 *    free, so no dense factorization and it scales to a few thousand verts.
 *  - A final orientation check flips V if the map came out mirrored.
 *
 * Pure and headless. Returns per-vertex UVs (length = vertexCount·2). Returns
 * null when the chart is too small / degenerate to pin (caller falls back to
 * planar projection).
 */

export interface LSCMResult {
  /** Per-vertex UVs, length = vertexCount * 2 (u0,v0,u1,v1,…). */
  uvs: Float32Array;
}

/**
 * @param positions chart-local 3D vertex positions (length = n*3)
 * @param triangles flat triangle index list into `positions` (CCW)
 */
export function computeLSCM(positions: Float32Array, triangles: readonly number[]): LSCMResult | null {
  const n = positions.length / 3;
  if (n < 3 || triangles.length < 3) return null;

  const pins = pickPins(positions, n);
  if (!pins) return null;
  const [p0, p1] = pins;

  // Pin the two farthest verts along U, spaced by their 3D distance.
  const dist = Math.hypot(
    positions[p1 * 3]! - positions[p0 * 3]!,
    positions[p1 * 3 + 1]! - positions[p0 * 3 + 1]!,
    positions[p1 * 3 + 2]! - positions[p0 * 3 + 2]!,
  );
  const pinUV = new Map<number, [number, number]>();
  pinUV.set(p0, [0, 0]);
  pinUV.set(p1, [dist > 1e-9 ? dist : 1, 0]);

  // Free-unknown numbering: each free vertex owns 2 consecutive columns.
  const freeCol = new Int32Array(n).fill(-1);
  let freeCount = 0;
  for (let v = 0; v < n; v++) {
    if (!pinUV.has(v)) freeCol[v] = freeCount++;
  }
  if (freeCount === 0) {
    // Everything pinned (n === 2 handled above; here n>=3 so this is unusual).
    const uvs = new Float32Array(n * 2);
    for (const [v, uv] of pinUV) { uvs[v * 2] = uv[0]; uvs[v * 2 + 1] = uv[1]; }
    return { uvs };
  }
  const cols = freeCount * 2;

  // Sparse matrix rows + RHS. Each triangle → 2 rows (real, imag).
  const rowCols: number[][] = [];
  const rowCoef: number[][] = [];
  const b: number[] = [];

  const addRow = (
    entries: Array<{ v: number; cu: number; cv: number }>,
  ): void => {
    const rc: number[] = [];
    const rk: number[] = [];
    let rhs = 0;
    for (const e of entries) {
      const pin = pinUV.get(e.v);
      if (pin) {
        rhs -= e.cu * pin[0] + e.cv * pin[1];
      } else {
        const base = freeCol[e.v]! * 2;
        rc.push(base, base + 1);
        rk.push(e.cu, e.cv);
      }
    }
    rowCols.push(rc);
    rowCoef.push(rk);
    b.push(rhs);
  };

  for (let t = 0; t + 2 < triangles.length; t += 3) {
    const i = triangles[t]!, j = triangles[t + 1]!, k = triangles[t + 2]!;
    const local = triangleLocal2D(positions, i, j, k);
    if (!local) continue; // degenerate — skip
    const { x1, y1, x2, y2, x3, y3, sqrtDt } = local;
    // W_j complex, divided by sqrt(dT).
    const w1r = (x3 - x2) / sqrtDt, w1i = (y3 - y2) / sqrtDt;
    const w2r = (x1 - x3) / sqrtDt, w2i = (y1 - y3) / sqrtDt;
    const w3r = (x2 - x1) / sqrtDt, w3i = (y2 - y1) / sqrtDt;
    // Real row: Σ (Wr·u - Wi·v) = 0
    addRow([
      { v: i, cu: w1r, cv: -w1i },
      { v: j, cu: w2r, cv: -w2i },
      { v: k, cu: w3r, cv: -w3i },
    ]);
    // Imag row: Σ (Wi·u + Wr·v) = 0
    addRow([
      { v: i, cu: w1i, cv: w1r },
      { v: j, cu: w2i, cv: w2r },
      { v: k, cu: w3i, cv: w3r },
    ]);
  }

  const x = solveCGLS(rowCols, rowCoef, b, cols);

  // Assemble full UV array.
  const uvs = new Float32Array(n * 2);
  for (const [v, uv] of pinUV) { uvs[v * 2] = uv[0]; uvs[v * 2 + 1] = uv[1]; }
  for (let v = 0; v < n; v++) {
    const fc = freeCol[v]!;
    if (fc < 0) continue;
    uvs[v * 2] = x[fc * 2]!;
    uvs[v * 2 + 1] = x[fc * 2 + 1]!;
  }

  // Orientation: if the map is globally mirrored (negative total signed UV
  // area), flip V so texturing isn't back-to-front. Pins sit on V=0, so the
  // flip keeps them valid.
  if (signedUVArea(uvs, triangles) < 0) {
    for (let v = 0; v < n; v++) uvs[v * 2 + 1] = -uvs[v * 2 + 1]!;
  }

  return { uvs };
}

// ── helpers ──────────────────────────────────────────────────────────────

/** Two vertices maximally far apart (approx: farthest from 0, then farthest from that). */
function pickPins(positions: Float32Array, n: number): [number, number] | null {
  const far = (from: number): number => {
    let best = -1, bestD = -1;
    for (let v = 0; v < n; v++) {
      if (v === from) continue;
      const dx = positions[v * 3]! - positions[from * 3]!;
      const dy = positions[v * 3 + 1]! - positions[from * 3 + 1]!;
      const dz = positions[v * 3 + 2]! - positions[from * 3 + 2]!;
      const d = dx * dx + dy * dy + dz * dz;
      if (d > bestD) { bestD = d; best = v; }
    }
    return best;
  };
  const a = far(0);
  if (a < 0) return null;
  const b = far(a);
  if (b < 0 || b === a) return null;
  return [a, b];
}

/** Place triangle (i,j,k) in an orthonormal 2D frame. Null if degenerate. */
function triangleLocal2D(
  P: Float32Array, i: number, j: number, k: number,
): { x1: number; y1: number; x2: number; y2: number; x3: number; y3: number; sqrtDt: number } | null {
  const ax = P[i * 3]!, ay = P[i * 3 + 1]!, az = P[i * 3 + 2]!;
  const bx = P[j * 3]!, by = P[j * 3 + 1]!, bz = P[j * 3 + 2]!;
  const cx = P[k * 3]!, cy = P[k * 3 + 1]!, cz = P[k * 3 + 2]!;
  let e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const len1 = Math.hypot(e1x, e1y, e1z);
  if (len1 < 1e-12) return null;
  e1x /= len1; e1y /= len1; e1z /= len1;
  // normal = e1 × e2
  let nx = e1y * e2z - e1z * e2y;
  let ny = e1z * e2x - e1x * e2z;
  let nz = e1x * e2y - e1y * e2x;
  const nlen = Math.hypot(nx, ny, nz);
  if (nlen < 1e-12) return null;
  nx /= nlen; ny /= nlen; nz /= nlen;
  // y-axis = normal × e1
  const yx = ny * e1z - nz * e1y;
  const yy = nz * e1x - nx * e1z;
  const yz = nx * e1y - ny * e1x;
  const x1 = 0, y1 = 0;
  const x2 = len1, y2 = 0;
  const x3 = e2x * e1x + e2y * e1y + e2z * e1z;
  const y3 = e2x * yx + e2y * yy + e2z * yz;
  const dt = x2 * y3 - y2 * x3; // = 2*area, > 0 for CCW
  if (dt < 1e-14) return null;
  return { x1, y1, x2, y2, x3, y3, sqrtDt: Math.sqrt(dt) };
}

/** Sum of signed UV triangle areas (orientation probe). */
function signedUVArea(uvs: Float32Array, triangles: readonly number[]): number {
  let sum = 0;
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    const i = triangles[t]!, j = triangles[t + 1]!, k = triangles[t + 2]!;
    const ux = uvs[j * 2]! - uvs[i * 2]!, uy = uvs[j * 2 + 1]! - uvs[i * 2 + 1]!;
    const vx = uvs[k * 2]! - uvs[i * 2]!, vy = uvs[k * 2 + 1]! - uvs[i * 2 + 1]!;
    sum += ux * vy - uy * vx;
  }
  return sum;
}

/**
 * Solve min‖A·x − b‖ via CGLS (conjugate gradient, normal equations). Matrix
 * is given as sparse rows (`rowCols[r]` columns, `rowCoef[r]` coefficients).
 * Iterates to a small residual or a column-count-bounded cap.
 */
function solveCGLS(rowCols: number[][], rowCoef: number[][], b: number[], cols: number): Float64Array {
  const rows = b.length;
  const x = new Float64Array(cols);
  const Ax = (v: Float64Array, out: Float64Array): void => {
    for (let r = 0; r < rows; r++) {
      const rc = rowCols[r]!, rk = rowCoef[r]!;
      let s = 0;
      for (let e = 0; e < rc.length; e++) s += rk[e]! * v[rc[e]!]!;
      out[r] = s;
    }
  };
  const Atv = (v: Float64Array, out: Float64Array): void => {
    out.fill(0);
    for (let r = 0; r < rows; r++) {
      const rc = rowCols[r]!, rk = rowCoef[r]!, vr = v[r]!;
      for (let e = 0; e < rc.length; e++) {
        const col = rc[e]!;
        out[col] = out[col]! + rk[e]! * vr;
      }
    }
  };

  // r = b - A x0 (x0 = 0 → r = b)
  const r = Float64Array.from(b);
  const z = new Float64Array(cols);
  Atv(r, z);
  const p = Float64Array.from(z);
  let gamma = dot(z, z);
  if (gamma < 1e-30) return x;

  const w = new Float64Array(rows);
  const maxIter = Math.min(2 * cols + 20, 5000);
  const tol = gamma * 1e-12;
  for (let it = 0; it < maxIter; it++) {
    Ax(p, w);
    const wn = dot(w, w);
    if (wn < 1e-30) break;
    const alpha = gamma / wn;
    for (let c = 0; c < cols; c++) x[c] = x[c]! + alpha * p[c]!;
    for (let rr = 0; rr < rows; rr++) r[rr] = r[rr]! - alpha * w[rr]!;
    Atv(r, z);
    const gammaNew = dot(z, z);
    if (gammaNew < tol) break;
    const beta = gammaNew / gamma;
    for (let c = 0; c < cols; c++) p[c] = z[c]! + beta * p[c]!;
    gamma = gammaNew;
  }
  return x;
}

function dot(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

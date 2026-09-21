/**
 * Cutting a mesh's triangle count down — Blender's **Decimate ▸ Collapse**.
 *
 * The way a cage built for modelling becomes a mesh a game can afford: a
 * 5,000-triangle character at 30% is still recognisably the same silhouette,
 * and nothing about the original has to be rebuilt. Blender's Decimate has
 * three modes and **the other two are already here** — Planar is
 * `dissolveLimit` (measured: the modifier and `bmesh.ops.dissolve_limit` agree
 * on six configurations), and Un-Subdivide is `unsubdivide`, whose rule was
 * only half readable and is deliberately not written.
 *
 * Quadric error metric, Garland & Heckbert. Each vertex carries the sum of the
 * squared-distance forms of its incident triangle planes; collapsing an edge
 * costs whatever that sum says the new position is worth, and the cheapest
 * collapse goes first.
 *
 * Pure and headless.
 *
 * ## What this is not
 *
 * **It is not going to match Blender vertex for vertex, and the reason is
 * measured rather than assumed.** Decimate triangulates before it starts, and
 * *which* triangulation it picks changes the answer: the same bumpy grid put
 * through at ratio 0.5 comes back with 15 vertices as quads and 17 vertices
 * when it is fan-triangulated first. Blender's own output is reproducible —
 * five runs of the same input agree exactly — so the gap is a difference of
 * algorithm, not of determinism, and the parity row for it says `different`
 * and scores how far the surface moved.
 *
 * Blender also merges triangles back into quads on the way out (a sphere at
 * ratio 0.5 comes back as 90 faces over 112 triangles). This returns
 * triangles. `trisToQuads` is the operator for that half and has its own
 * measured row.
 */
import type { MeshData } from "../lib/mesh";

/** A symmetric 4×4 quadric, stored as its ten distinct entries. */
type Quadric = Float64Array;

function planeQuadric(a: number, b: number, c: number, d: number): Quadric {
  return Float64Array.of(
    a * a, a * b, a * c, a * d,
    b * b, b * c, b * d,
    c * c, c * d,
    d * d,
  );
}

function addScaled(into: Quadric, q: Quadric, weight: number): void {
  for (let i = 0; i < 10; i++) into[i]! += q[i]! * weight;
}

/** `vᵀ Q v` for a point — the squared distance to the planes Q was built from. */
function quadricError(q: Quadric, x: number, y: number, z: number): number {
  return (
    q[0]! * x * x + 2 * q[1]! * x * y + 2 * q[2]! * x * z + 2 * q[3]! * x +
    q[4]! * y * y + 2 * q[5]! * y * z + 2 * q[6]! * y +
    q[7]! * z * z + 2 * q[8]! * z +
    q[9]!
  );
}

/**
 * The point that minimises `vᵀ Q v`, or null when the 3×3 part is too close
 * to singular to trust — which happens wherever the surface is nearly flat,
 * because then every point on the plane is nearly as good and the solve has
 * no opinion about where along it to go.
 *
 * **The threshold has to be relative to the quadric's own scale.** An absolute
 * one lets a nearly-flat neighbourhood through, and the solve then answers
 * with a point a long way off that has a *low* computed cost — low because the
 * quadric barely constrains that direction, not because the point is good.
 * Measured: with an absolute 1e-12, decimating the `character` cage to half
 * put a vertex **62.6 mm** off the original surface where Blender's worst was
 * 1.70 mm.
 */
function optimalPoint(q: Quadric): [number, number, number] | null {
  const a = q[0]!, b = q[1]!, c = q[2]!;
  const e = q[4]!, f = q[5]!;
  const i = q[7]!;
  const det =
    a * (e * i - f * f) - b * (b * i - f * c) + c * (b * f - e * c);
  // Relative to the largest entry cubed, which is what the determinant of a
  // well-conditioned 3×3 of that scale would be within a constant.
  const norm = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(e), Math.abs(f), Math.abs(i));
  if (!Number.isFinite(det) || norm <= 0 || Math.abs(det) < 1e-8 * norm * norm * norm) return null;

  // -(3×3)⁻¹ · (the linear part).
  const rx = -q[3]!, ry = -q[6]!, rz = -q[8]!;
  const inv = [
    (e * i - f * f) / det, (c * f - b * i) / det, (b * f - c * e) / det,
    (c * f - b * i) / det, (a * i - c * c) / det, (b * c - a * f) / det,
    (b * f - c * e) / det, (b * c - a * f) / det, (a * e - b * b) / det,
  ];
  return [
    inv[0]! * rx + inv[1]! * ry + inv[2]! * rz,
    inv[3]! * rx + inv[4]! * ry + inv[5]! * rz,
    inv[6]! * rx + inv[7]! * ry + inv[8]! * rz,
  ];
}

export interface DecimateOptions {
  /**
   * How much of the **triangle** count to keep, 0..1 — Blender's `ratio`, and
   * measured to be triangles rather than faces: a 32-triangle grid at 0.5
   * comes back with 16 triangles whether it went in as quads or as triangles.
   *
   * The target is rounded down, so 0.1 of 32 is 3.
   */
  ratio: number;
  /**
   * How hard to hold the open edges of a surface in place. Boundary edges get
   * an extra plane, perpendicular to their own triangle, weighted by this.
   * Default 1000 — high enough that a sheet keeps its outline until almost
   * everything inside it has gone.
   */
  boundaryWeight?: number;
}

/** Fan-triangulate, which is what `meshToTriangles` does for the same reason. */
function triangulate(polys: readonly (readonly number[])[]): number[][] {
  const tris: number[][] = [];
  for (const poly of polys)
    for (let i = 1; i + 1 < poly.length; i++) tris.push([poly[0]!, poly[i]!, poly[i + 1]!]);
  return tris;
}

/**
 * Collapse edges until only `ratio` of the triangles are left.
 *
 * ```ts
 * const lod = decimateCollapse(meshToData(em), { ratio: 0.3 });
 * ```
 *
 * The input is triangulated first (n-gons fan out), so the count the ratio
 * applies to is the triangle count, not the polygon count. The result is
 * triangles, compacted — vertices no triangle uses are gone.
 *
 * Three things are refused rather than done badly: a collapse that would fold
 * a triangle over (its normal turning by more than a right angle), one that
 * would make the surface non-manifold, and one that would take the last two
 * triangles of a closed shell with it. All three leave the edge in place and
 * move on to the next cheapest, so a mesh can stop short of its target.
 *
 * **A closed shell bottoms out at two triangles over three vertices**, and
 * that is Blender's floor too, measured: a cube comes back as 2 triangles for
 * every ratio from 0.25 down to 0. An open sheet has no floor — the same
 * measurement takes a flat grid to nothing at ratio 0.
 */
export function decimateCollapse(data: MeshData, opts: DecimateOptions): MeshData {
  const ratio = opts.ratio;
  const boundaryWeight = opts.boundaryWeight ?? 1000;

  const tris = triangulate(data.polys);
  const target = Math.floor(tris.length * ratio);
  const P = Float64Array.from(data.positions);
  const vertCount = P.length / 3;

  if (ratio >= 1 || target >= tris.length)
    return { positions: new Float32Array(P), polys: tris.map((t) => [...t]) };

  // ── adjacency ──────────────────────────────────────────────────────────
  const live: Array<number[] | null> = tris.map((t) => [...t]);
  const vertTris: Array<Set<number>> = Array.from({ length: vertCount }, () => new Set());
  for (let t = 0; t < live.length; t++) for (const v of live[t]!) vertTris[v]!.add(t);
  const dead = new Uint8Array(vertCount);

  const triNormal = (t: number): [number, number, number] | null => {
    const f = live[t];
    if (!f) return null;
    const [i, j, k] = f as [number, number, number];
    const ux = P[j * 3]! - P[i * 3]!, uy = P[j * 3 + 1]! - P[i * 3 + 1]!, uz = P[j * 3 + 2]! - P[i * 3 + 2]!;
    const wx = P[k * 3]! - P[i * 3]!, wy = P[k * 3 + 1]! - P[i * 3 + 1]!, wz = P[k * 3 + 2]! - P[i * 3 + 2]!;
    return [uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx];
  };

  // ── quadrics ───────────────────────────────────────────────────────────
  const Q: Quadric[] = Array.from({ length: vertCount }, () => new Float64Array(10));
  for (let t = 0; t < live.length; t++) {
    const n = triNormal(t)!;
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len < 1e-20) continue; // a degenerate triangle has no plane to offer
    const [a, b, c] = [n[0] / len, n[1] / len, n[2] / len];
    const i = live[t]![0]!;
    const d = -(a * P[i * 3]! + b * P[i * 3 + 1]! + c * P[i * 3 + 2]!);
    const q = planeQuadric(a, b, c, d);
    // Area-weighted: a big triangle's plane should matter more than a sliver's.
    for (const v of live[t]!) addScaled(Q[v]!, q, len / 2);
  }

  /** How many live triangles use both `u` and `v`. 1 means a boundary edge. */
  const sharedTris = (u: number, v: number): number[] => {
    const out: number[] = [];
    for (const t of vertTris[u]!) if (live[t] && live[t]!.includes(v)) out.push(t);
    return out;
  };

  const edgeKey = (u: number, v: number): number =>
    u < v ? u * vertCount + v : v * vertCount + u;

  // An open edge gets a plane through it, perpendicular to its own triangle,
  // so the outline of a sheet is expensive to move. Without this a decimated
  // plane loses its corners first, which is the wrong way round.
  const edgesSeen = new Set<number>();
  for (let t = 0; t < live.length; t++) {
    const f = live[t]!;
    for (let e = 0; e < 3; e++) {
      const u = f[e]!, v = f[(e + 1) % 3]!;
      const key = edgeKey(u, v);
      if (edgesSeen.has(key)) continue;
      edgesSeen.add(key);
      if (sharedTris(u, v).length !== 1) continue;
      const n = triNormal(t)!;
      const nl = Math.hypot(n[0], n[1], n[2]);
      if (nl < 1e-20) continue;
      const ex = P[v * 3]! - P[u * 3]!, ey = P[v * 3 + 1]! - P[u * 3 + 1]!, ez = P[v * 3 + 2]! - P[u * 3 + 2]!;
      // edge × normal — in the triangle's plane, perpendicular to the edge.
      let ax = ey * (n[2] / nl) - ez * (n[1] / nl);
      let ay = ez * (n[0] / nl) - ex * (n[2] / nl);
      let az = ex * (n[1] / nl) - ey * (n[0] / nl);
      const al = Math.hypot(ax, ay, az);
      if (al < 1e-20) continue;
      ax /= al; ay /= al; az /= al;
      const d = -(ax * P[u * 3]! + ay * P[u * 3 + 1]! + az * P[u * 3 + 2]!);
      const q = planeQuadric(ax, ay, az, d);
      addScaled(Q[u]!, q, boundaryWeight);
      addScaled(Q[v]!, q, boundaryWeight);
    }
  }

  // ── the cost of one collapse ───────────────────────────────────────────
  type Candidate = { u: number; v: number; cost: number; at: [number, number, number] };

  const evaluate = (u: number, v: number): Candidate => {
    const q = new Float64Array(10);
    addScaled(q, Q[u]!, 1);
    addScaled(q, Q[v]!, 1);
    const options: Array<[number, number, number]> = [];
    const best = optimalPoint(q);
    // A leash as well as the conditioning test: even a solve that passes can
    // land somewhere absurd on a surface that is flat in one direction, and a
    // collapse is meant to put the new vertex *on* the edge it replaces, not
    // out in space. Two edge-lengths from the midpoint is generous — the
    // optimal point for a genuine crease sits between the two ends.
    if (best) {
      const mx = (P[u * 3]! + P[v * 3]!) / 2;
      const my = (P[u * 3 + 1]! + P[v * 3 + 1]!) / 2;
      const mz = (P[u * 3 + 2]! + P[v * 3 + 2]!) / 2;
      const len = Math.hypot(
        P[v * 3]! - P[u * 3]!,
        P[v * 3 + 1]! - P[u * 3 + 1]!,
        P[v * 3 + 2]! - P[u * 3 + 2]!,
      );
      if (Math.hypot(best[0] - mx, best[1] - my, best[2] - mz) <= 2 * len) options.push(best);
    }
    options.push([P[u * 3]!, P[u * 3 + 1]!, P[u * 3 + 2]!]);
    options.push([P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!]);
    options.push([
      (P[u * 3]! + P[v * 3]!) / 2,
      (P[u * 3 + 1]! + P[v * 3 + 1]!) / 2,
      (P[u * 3 + 2]! + P[v * 3 + 2]!) / 2,
    ]);
    let at = options[0]!;
    let cost = Infinity;
    for (const o of options) {
      const c = quadricError(q, o[0], o[1], o[2]);
      if (c < cost) {
        cost = c;
        at = o;
      }
    }
    return { u, v, cost, at };
  };

  /**
   * Would this collapse fold a triangle over, or tear the surface?
   *
   * The link condition is the manifold half: an edge may only be collapsed
   * when the vertices that neighbour **both** ends are exactly the ones
   * opposite it in the triangles that share it. Anything else joins two parts
   * of the surface that were not joined.
   */
  const allowed = (u: number, v: number, at: readonly number[]): boolean => {
    const shared = sharedTris(u, v);
    if (shared.length === 0 || shared.length > 2) return false;

    const nu = new Set<number>();
    for (const t of vertTris[u]!) if (live[t]) for (const w of live[t]!) if (w !== u) nu.add(w);
    const opposite = new Set<number>();
    for (const t of shared) for (const w of live[t]!) if (w !== u && w !== v) opposite.add(w);
    // Two triangles on the *same* three vertices — the state a closed shell
    // ends in — share an edge whose two "opposite" vertices are one vertex.
    // Collapsing that removes both and leaves nothing. **Measured: Blender
    // stops there too**, taking a cube down to 2 triangles over 3 vertices at
    // any ratio below 0.25 and refusing to go further. An open sheet has no
    // such floor and does reach zero.
    if (opposite.size !== shared.length) return false;
    let common = 0;
    for (const t of vertTris[v]!)
      if (live[t])
        for (const w of live[t]!)
          if (w !== v && nu.has(w)) {
            if (!opposite.has(w)) return false;
            common++;
          }
    if (common === 0) return false;

    // No triangle may turn by more than a right angle.
    for (const side of [u, v])
      for (const t of vertTris[side]!) {
        const f = live[t];
        if (!f || shared.includes(t)) continue;
        const before = triNormal(t)!;
        const moved = f.map((w) => (w === u || w === v ? -1 : w));
        const p = (w: number, axis: number): number =>
          w === -1 ? at[axis]! : P[w * 3 + axis]!;
        const ux = p(moved[1]!, 0) - p(moved[0]!, 0);
        const uy = p(moved[1]!, 1) - p(moved[0]!, 1);
        const uz = p(moved[1]!, 2) - p(moved[0]!, 2);
        const wx = p(moved[2]!, 0) - p(moved[0]!, 0);
        const wy = p(moved[2]!, 1) - p(moved[0]!, 1);
        const wz = p(moved[2]!, 2) - p(moved[0]!, 2);
        const after: [number, number, number] = [
          uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx,
        ];
        if (before[0] * after[0] + before[1] * after[1] + before[2] * after[2] <= 0) return false;
      }
    return true;
  };

  // ── the loop ───────────────────────────────────────────────────────────
  let count = live.length;
  const stale = new Set<number>();

  const currentEdges = (): Candidate[] => {
    const seen = new Set<number>();
    const out: Candidate[] = [];
    for (let t = 0; t < live.length; t++) {
      const f = live[t];
      if (!f) continue;
      for (let e = 0; e < 3; e++) {
        const a = f[e]!, b = f[(e + 1) % 3]!;
        const key = edgeKey(a, b);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(evaluate(Math.min(a, b), Math.max(a, b)));
      }
    }
    out.sort((x, y) => x.cost - y.cost || x.u - y.u || x.v - y.v);
    return out;
  };

  // Rebuilt rather than kept in a heap: the mesh sizes this library deals in
  // are hundreds to a few thousand triangles, and a rebuild after every batch
  // of collapses is simpler to get right than lazy invalidation. The batch is
  // what keeps it from being quadratic in practice.
  while (count > target) {
    const queue = currentEdges();
    if (queue.length === 0) break;
    let did = 0;
    stale.clear();
    for (const cand of queue) {
      if (count <= target) break;
      const { u, v, at } = cand;
      if (dead[u] || dead[v] || stale.has(u) || stale.has(v)) continue;
      if (!allowed(u, v, at)) continue;

      P[u * 3] = at[0];
      P[u * 3 + 1] = at[1];
      P[u * 3 + 2] = at[2];
      addScaled(Q[u]!, Q[v]!, 1);

      for (const t of vertTris[v]!) {
        const f = live[t];
        if (!f) continue;
        if (f.includes(u)) {
          live[t] = null;
          count--;
          continue;
        }
        for (let i = 0; i < 3; i++) if (f[i] === v) f[i] = u;
        vertTris[u]!.add(t);
      }
      vertTris[v]!.clear();
      dead[v] = 1;
      // Everything one step away has a different cost now; leave it for the
      // next rebuild rather than trusting a stale number.
      stale.add(u);
      for (const t of vertTris[u]!) if (live[t]) for (const w of live[t]!) stale.add(w);
      did++;
    }
    if (did === 0) break; // nothing legal left — a closed shell at its floor
  }

  // ── compact ────────────────────────────────────────────────────────────
  const used = new Set<number>();
  for (const f of live) if (f) for (const v of f) used.add(v);
  const remap = new Map<number, number>();
  const out: number[] = [];
  for (let v = 0; v < vertCount; v++) {
    if (!used.has(v)) continue;
    remap.set(v, out.length / 3);
    out.push(P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!);
  }

  return {
    positions: new Float32Array(out),
    polys: live.filter((f): f is number[] => f !== null).map((f) => f.map((v) => remap.get(v)!)),
  };
}

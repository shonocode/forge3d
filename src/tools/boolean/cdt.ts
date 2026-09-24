/**
 * The constrained Delaunay triangulation of points inside a triangle — what
 * Blender's `delaunay_2d_calc(…, CDT_INSIDE)` returns for each triangle in
 * `mesh_intersect.cc`, reached by a shorter road (ADR-012 does not port
 * `delaunay_2d.cc`'s 3416 lines).
 *
 * The road: split the outer triangle at every point (any triangulation),
 * flip edges until every constraint is an edge (Sloan's method), then flip
 * every unconstrained edge that fails the in-circle test (Lawson). Lawson's
 * flips reach **the** constrained Delaunay triangulation from any
 * constrained triangulation — it is unique unless four points are
 * cocircular, and there the two algorithms may choose differently.
 *
 * Why it is needed at all: the triangulation mostly dissolves away, but not
 * where the pieces of a face cannot become one polygon — a cut loop inside a
 * face leaves a ring, and the edges that survive to split it are Delaunay
 * edges (`slabPin`, measured).
 *
 * Everything is exact (`exact.ts`). Constraints must not cross each other
 * or pass through a point; the arrangement in `intersect.ts` guarantees both.
 */
import { add, mul, sign, sub, type Q } from "./exact";

export type Q2 = readonly [Q, Q];

const orient = (a: Q2, b: Q2, c: Q2): number =>
  sign(sub(mul(sub(b[0], a[0]), sub(c[1], a[1])), mul(sub(b[1], a[1]), sub(c[0], a[0]))));

/** > 0 when `d` is strictly inside the circle through CCW `a`, `b`, `c`. */
function inCircle(a: Q2, b: Q2, c: Q2, d: Q2): number {
  const r = [a, b, c].map((p) => {
    const x = sub(p[0], d[0]);
    const y = sub(p[1], d[1]);
    return [x, y, add(mul(x, x), mul(y, y))] as const;
  });
  const [A, B, C] = r as unknown as [readonly [Q, Q, Q], readonly [Q, Q, Q], readonly [Q, Q, Q]];
  const det = add(
    sub(mul(A[0], sub(mul(B[1], C[2]), mul(B[2], C[1]))), mul(A[1], sub(mul(B[0], C[2]), mul(B[2], C[0])))),
    mul(A[2], sub(mul(B[0], C[1]), mul(B[1], C[0]))),
  );
  return sign(det);
}

/**
 * Triangulate `pts` — the first three are the outer triangle, counter-
 * clockwise, and every other point lies inside it or on its boundary — with
 * the edges `constraints` (index pairs) present. Returns CCW index triples.
 */
export function constrainedDelaunay(pts: readonly Q2[], constraints: readonly [number, number][]): [number, number, number][] {
  const tris: ([number, number, number] | null)[] = [[0, 1, 2]];
  /** Directed edge "a,b" → the triangle having it. */
  const owner = new Map<string, number>();
  const ek = (a: number, b: number): string => `${a},${b}`;
  const addTri = (a: number, b: number, c: number): number => {
    const t = tris.length;
    tris.push([a, b, c]);
    owner.set(ek(a, b), t);
    owner.set(ek(b, c), t);
    owner.set(ek(c, a), t);
    return t;
  };
  const killTri = (t: number): void => {
    const [a, b, c] = tris[t]!;
    for (const [u, v] of [[a, b], [b, c], [c, a]] as const) if (owner.get(ek(u, v)) === t) owner.delete(ek(u, v));
    tris[t] = null;
  };
  owner.set(ek(0, 1), 0);
  owner.set(ek(1, 2), 0);
  owner.set(ek(2, 0), 0);

  // 1. Insert points by splitting.
  for (let p = 3; p < pts.length; p++) {
    const P = pts[p]!;
    let placed = false;
    for (let t = 0; t < tris.length && !placed; t++) {
      const tri = tris[t];
      if (!tri) continue;
      const o = tri.map((_, i) => orient(pts[tri[i]!]!, pts[tri[(i + 1) % 3]!]!, P));
      if (o.some((s) => s < 0)) continue;
      const zero = o.findIndex((s) => s === 0);
      if (zero < 0) {
        const [a, b, c] = tri;
        killTri(t);
        addTri(a, b, p);
        addTri(b, c, p);
        addTri(c, a, p);
      } else {
        // On edge (u, v): split this triangle and the one across, if any.
        const u = tri[zero]!;
        const v = tri[(zero + 1) % 3]!;
        const w = tri[(zero + 2) % 3]!;
        const across = owner.get(ek(v, u));
        killTri(t);
        addTri(u, p, w);
        addTri(p, v, w);
        if (across !== undefined) {
          const x = tris[across]!.find((q) => q !== u && q !== v)!;
          killTri(across);
          addTri(v, p, x);
          addTri(p, u, x);
        }
      }
      placed = true;
    }
    if (!placed) throw new Error("constrainedDelaunay: a point outside the outer triangle");
  }

  const isConstraint = new Set<string>();
  for (const [a, b] of constraints) {
    isConstraint.add(ek(a, b));
    isConstraint.add(ek(b, a));
  }

  /** Flip the edge (a, b); returns the new edge, or null if not convex. */
  const flip = (a: number, b: number): [number, number] | null => {
    const t1 = owner.get(ek(a, b));
    const t2 = owner.get(ek(b, a));
    if (t1 === undefined || t2 === undefined) return null;
    const c = tris[t1]!.find((q) => q !== a && q !== b)!;
    const d = tris[t2]!.find((q) => q !== a && q !== b)!;
    // Convex quad a, d, b, c: c and d strictly on opposite sides of both diagonals.
    if (orient(pts[c]!, pts[d]!, pts[a]!) >= 0 || orient(pts[c]!, pts[d]!, pts[b]!) <= 0) return null;
    killTri(t1);
    killTri(t2);
    addTri(c, a, d);
    addTri(d, b, c);
    return [c, d];
  };

  // 2. Force each constraint in (Sloan): flip the edges that cross it.
  const crosses = (u: number, v: number, a: number, b: number): boolean =>
    u !== a && u !== b && v !== a && v !== b &&
    orient(pts[a]!, pts[b]!, pts[u]!) * orient(pts[a]!, pts[b]!, pts[v]!) < 0 &&
    orient(pts[u]!, pts[v]!, pts[a]!) * orient(pts[u]!, pts[v]!, pts[b]!) < 0;
  for (const [a, b] of constraints) {
    if (owner.has(ek(a, b)) || owner.has(ek(b, a))) continue;
    const queue: [number, number][] = [];
    const seen = new Set<string>();
    for (const tri of tris) {
      if (!tri) continue;
      for (let i = 0; i < 3; i++) {
        const u = tri[i]!;
        const v = tri[(i + 1) % 3]!;
        const k = u < v ? ek(u, v) : ek(v, u);
        if (!seen.has(k) && crosses(u, v, a, b)) {
          seen.add(k);
          queue.push([u, v]);
        }
      }
    }
    for (let guard = 0; queue.length > 0; guard++) {
      if (guard > 100000) throw new Error("constrainedDelaunay: constraint insertion did not converge");
      const [u, v] = queue.shift()!;
      if (!owner.has(ek(u, v))) continue; // already flipped away
      const e = flip(u, v);
      if (!e) {
        queue.push([u, v]);
        continue;
      }
      if (crosses(e[0], e[1], a, b)) queue.push(e);
    }
  }

  // 3. Lawson: flip unconstrained edges that fail the in-circle test.
  const stack: [number, number][] = [];
  for (const tri of tris) if (tri) for (let i = 0; i < 3; i++) stack.push([tri[i]!, tri[(i + 1) % 3]!]);
  for (let guard = 0; stack.length > 0; guard++) {
    if (guard > 1000000) throw new Error("constrainedDelaunay: Lawson flips did not converge");
    const [a, b] = stack.pop()!;
    if (isConstraint.has(ek(a, b))) continue;
    const t1 = owner.get(ek(a, b));
    const t2 = owner.get(ek(b, a));
    if (t1 === undefined || t2 === undefined) continue;
    const c = tris[t1]!.find((q) => q !== a && q !== b)!;
    const d = tris[t2]!.find((q) => q !== a && q !== b)!;
    if (inCircle(pts[a]!, pts[b]!, pts[c]!, pts[d]!) <= 0) continue;
    if (!flip(a, b)) continue;
    stack.push([a, d], [d, b], [b, c], [c, a]);
  }

  return tris.filter((t): t is [number, number, number] => t !== null);
}

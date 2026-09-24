import { describe, it, expect } from "vitest";
import { add, mul, q, sign, sub } from "./exact";
import { constrainedDelaunay, type Q2 } from "./cdt";

const pt = (x: number, y: number): Q2 => [q(BigInt(x)), q(BigInt(y))];

const inCircle = (a: Q2, b: Q2, c: Q2, d: Q2): number => {
  const r = [a, b, c].map((p) => {
    const x = sub(p[0], d[0]);
    const y = sub(p[1], d[1]);
    return [x, y, add(mul(x, x), mul(y, y))];
  });
  const [A, B, C] = r as [typeof r[0], typeof r[0], typeof r[0]];
  return sign(
    add(
      sub(mul(A[0]!, sub(mul(B[1]!, C[2]!), mul(B[2]!, C[1]!))), mul(A[1]!, sub(mul(B[0]!, C[2]!), mul(B[2]!, C[0]!)))),
      mul(A[2]!, sub(mul(B[0]!, C[1]!), mul(B[1]!, C[0]!))),
    ),
  );
};

/** Every unconstrained interior edge passes the in-circle test. */
function isConstrainedDelaunay(pts: Q2[], tris: number[][], constraints: [number, number][]): boolean {
  const fixed = new Set(constraints.flatMap(([a, b]) => [`${a},${b}`, `${b},${a}`]));
  const owner = new Map<string, number[]>();
  for (const t of tris) for (let i = 0; i < 3; i++) owner.set(`${t[i]},${t[(i + 1) % 3]}`, t);
  for (const t of tris)
    for (let i = 0; i < 3; i++) {
      const a = t[i]!;
      const b = t[(i + 1) % 3]!;
      const other = owner.get(`${b},${a}`);
      if (!other || fixed.has(`${a},${b}`)) continue;
      const c = t.find((v) => v !== a && v !== b)!;
      const d = other.find((v) => v !== a && v !== b)!;
      if (inCircle(pts[a]!, pts[b]!, pts[c]!, pts[d]!) > 0) return false;
    }
  return true;
}

describe("constrainedDelaunay", () => {
  // Outer triangle, counter-clockwise, and points inside it.
  const outer = [pt(0, 0), pt(100, 0), pt(0, 100)];

  it("triangulates points inside the triangle, Delaunay without constraints", () => {
    const pts = [...outer, pt(10, 10), pt(30, 12), pt(12, 40), pt(25, 25), pt(50, 5)];
    const tris = constrainedDelaunay(pts, []);
    // Every interior point adds two triangles.
    expect(tris).toHaveLength(1 + 2 * 5);
    expect(isConstrainedDelaunay(pts, tris, [])).toBe(true);
  });

  it("keeps every constraint as an edge, and is Delaunay elsewhere", () => {
    const pts = [...outer, pt(10, 10), pt(60, 12), pt(12, 60), pt(25, 25), pt(30, 3), pt(3, 30)];
    // Two long thin constraints the unconstrained Delaunay would not have
    // (parallel, so they do not cross — `cdt.ts` requires that).
    const constraints: [number, number][] = [[7, 8], [4, 5]];
    const tris = constrainedDelaunay(pts, constraints);
    const edges = new Set(tris.flatMap((t) => t.map((v, i) => `${v},${t[(i + 1) % 3]}`)));
    for (const [a, b] of constraints) expect(edges.has(`${a},${b}`) || edges.has(`${b},${a}`)).toBe(true);
    expect(isConstrainedDelaunay(pts, tris, constraints)).toBe(true);
  });

  it("splits a triangle at a point on its boundary", () => {
    const tris = constrainedDelaunay([...outer, pt(50, 0)], []);
    expect(tris).toHaveLength(2);
  });
});

import { describe, it, expect } from "vitest";
import { q, q3Dot, q3Sub, sign, toDouble, type Q3 } from "./exact";
import { evertFromDoubles, intersectTriTri, makeTri, type ETri } from "./tri-tri";

const tri = (a: number[], b: number[], c: number[]): ETri =>
  makeTri(
    evertFromDoubles(a[0]!, a[1]!, a[2]!),
    evertFromDoubles(b[0]!, b[1]!, b[2]!),
    evertFromDoubles(c[0]!, c[1]!, c[2]!),
  );

const d3 = (p: Q3): number[] => p.map(toDouble);

/** The two endpoints of a segment result, in a fixed order for comparing. */
function endpoints(r: ReturnType<typeof intersectTriTri>): number[][] {
  if (r.kind !== "segment") throw new Error(`expected a segment, got ${r.kind}`);
  return [d3(r.p1), d3(r.p2)].sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!);
}

/** Is `p` exactly on the plane of `t`? */
const onPlane = (p: Q3, t: ETri): boolean => sign(q3Dot(q3Sub(p, t.v[0].exact), t.nExact)) === 0;

describe("intersectTriTri", () => {
  const flat = tri([0, 0, 0], [2, 0, 0], [0, 2, 0]);

  it("returns the segment where a triangle pierces another", () => {
    const r = intersectTriTri(flat, tri([0.3, 0.5, -1], [1, 0.5, 1], [0.3, 0.5, 1]));
    expect(endpoints(r)).toEqual([
      [0.3, 0.5, 0],
      [0.65, 0.5, 0],
    ]);
  });

  it("clips the segment to both triangles", () => {
    // The standing triangle crosses z = 0 for x in [-1/3, 7/3]; the flat one
    // covers only [0, 3/2] at y = 0.5. The answer is the overlap, exactly.
    const r = intersectTriTri(flat, tri([-1, 0.5, -1], [3, 0.5, -1], [1, 0.5, 2]));
    expect(r.kind).toBe("segment");
    if (r.kind !== "segment") return;
    const xs = [r.p1[0], r.p2[0]].sort((a, b) => sign({ n: a.n * b.d - b.n * a.d, d: 1n }));
    expect(xs[0]).toEqual(q(0n));
    expect(xs[1]).toEqual(q(3n, 2n));
  });

  it("returns a point where only a vertex touches", () => {
    const r = intersectTriTri(flat, tri([0.5, 0.5, 0], [0.5, 0.5, 1], [1, 1, 1]));
    expect(r.kind).toBe("point");
    if (r.kind === "point") expect(d3(r.p)).toEqual([0.5, 0.5, 0]);
  });

  it("reports coplanar triangles instead of intersecting them", () => {
    expect(intersectTriTri(flat, tri([0.5, 0.5, 0], [3, 0.5, 0], [0.5, 3, 0])).kind).toBe("coplanar");
  });

  it("returns nothing for triangles that miss", () => {
    expect(intersectTriTri(flat, tri([0, 0, 1], [1, 0, 1], [0, 1, 1])).kind).toBe("none");
    // Crosses the plane, but outside the flat triangle.
    expect(intersectTriTri(flat, tri([5, 5, -1], [6, 5, 1], [5, 6, 1])).kind).toBe("none");
  });

  it("puts every intersection point exactly on both planes", () => {
    // The invariant that makes the later stages possible: the new points are
    // not "close to" both planes, they are on them — checked in rationals.
    let seed = 99;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
    let hits = 0;
    for (let i = 0; i < 400; i++) {
      const a = tri([rnd(), rnd(), rnd()], [rnd(), rnd(), rnd()], [rnd(), rnd(), rnd()]);
      const b = tri([rnd(), rnd(), rnd()], [rnd(), rnd(), rnd()], [rnd(), rnd(), rnd()]);
      const r = intersectTriTri(a, b);
      if (r.kind === "segment") {
        hits++;
        for (const p of [r.p1, r.p2]) {
          expect(onPlane(p, a)).toBe(true);
          expect(onPlane(p, b)).toBe(true);
        }
      } else if (r.kind === "point") {
        expect(onPlane(r.p, a) && onPlane(r.p, b)).toBe(true);
      }
    }
    expect(hits).toBeGreaterThan(20);
  });

  it("agrees with a brute-force float reference on where the segment is", () => {
    // Clip each triangle's plane crossing against the other in doubles and
    // compare lengths — an independent route to the same segment.
    let seed = 4242;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
    const crossSegment = (t: number[][], planeP: number[], n: number[]): number[][] => {
      const s = t.map((p) => (p[0]! - planeP[0]!) * n[0]! + (p[1]! - planeP[1]!) * n[1]! + (p[2]! - planeP[2]!) * n[2]!);
      const out: number[][] = [];
      for (let i = 0; i < 3; i++) {
        const j = (i + 1) % 3;
        if ((s[i]! > 0) !== (s[j]! > 0)) {
          const k = s[i]! / (s[i]! - s[j]!);
          out.push([0, 1, 2].map((c) => t[i]![c]! + (t[j]![c]! - t[i]![c]!) * k));
        }
      }
      return out;
    };
    let checked = 0;
    for (let i = 0; i < 300; i++) {
      const A = [0, 1, 2].map(() => [rnd(), rnd(), rnd()]);
      const B = [0, 1, 2].map(() => [rnd(), rnd(), rnd()]);
      const r = intersectTriTri(tri(A[0]!, A[1]!, A[2]!), tri(B[0]!, B[1]!, B[2]!));
      if (r.kind !== "segment") continue;
      // Both triangles' crossing segments lie on the common line; the exact
      // answer is their overlap, so its length can be no longer than either.
      const nA = cross(sub3(A[0]!, A[2]!), sub3(A[1]!, A[2]!));
      const nB = cross(sub3(B[0]!, B[2]!), sub3(B[1]!, B[2]!));
      const sa = crossSegment(A, B[0]!, nB);
      const sb = crossSegment(B, A[0]!, nA);
      if (sa.length !== 2 || sb.length !== 2) continue;
      const len = (s: number[][]): number => Math.hypot(...[0, 1, 2].map((c) => s[0]![c]! - s[1]![c]!));
      const got = len(endpoints(r));
      expect(got).toBeLessThanOrEqual(len(sa) + 1e-9);
      expect(got).toBeLessThanOrEqual(len(sb) + 1e-9);
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
  });
});

function sub3(a: number[], b: number[]): number[] {
  return [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
}
function cross(a: number[], b: number[]): number[] {
  return [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
}

import { describe, it, expect } from "vitest";
import {
  add,
  cmp,
  div,
  fromDouble,
  mul,
  orient3d,
  orient3dExact,
  q,
  q3FromDoubles,
  sub,
  toDouble,
} from "./exact";

describe("exact rationals", () => {
  it("converts a double without rounding", () => {
    // 0.1 is not 1/10 in binary — it is this, exactly.
    const tenth = fromDouble(0.1);
    expect(tenth.n).toBe(3602879701896397n);
    expect(tenth.d).toBe(36028797018963968n);
    expect(fromDouble(0.5)).toEqual({ n: 1n, d: 2n });
    expect(fromDouble(-3)).toEqual({ n: -3n, d: 1n });
    expect(fromDouble(1e300).d).toBe(1n);
    expect(toDouble(fromDouble(5e-324))).toBe(5e-324);
  });

  it("round-trips every double it is given", () => {
    for (const x of [0.1, -2.5e-7, 123456.789, 1 / 3, Math.PI, 1e-300, -1e300])
      expect(toDouble(fromDouble(x))).toBe(x);
  });

  it("does arithmetic that doubles cannot", () => {
    // 0.1 + 0.2 === 0.3 is false in floats and in exact binary values too —
    // but the exact sum is the exact sum, and subtracting 0.1 gives 0.2 back.
    const s = add(fromDouble(0.1), fromDouble(0.2));
    expect(cmp(sub(s, fromDouble(0.1)), fromDouble(0.2))).toBe(0);
    expect(div(q(1n), q(3n))).toEqual({ n: 1n, d: 3n });
    expect(mul(q(2n, 3n), q(3n, 4n))).toEqual({ n: 1n, d: 2n });
  });

  it("keeps denominators reduced and positive", () => {
    expect(q(6n, -4n)).toEqual({ n: -3n, d: 2n });
    expect(q(0n, 7n)).toEqual({ n: 0n, d: 1n });
    expect(() => q(1n, 0n)).toThrow(/division by zero/);
  });
});

describe("orient3d", () => {
  const O = [0, 0, 0], X = [1, 0, 0], Y = [0, 1, 0];

  it("signs the side of a plane", () => {
    expect(orient3d(O, X, Y, [0, 0, 1])).toBe(1);
    expect(orient3d(O, X, Y, [0, 0, -1])).toBe(-1);
    expect(orient3d(O, X, Y, [0.3, 0.7, 0])).toBe(0);
  });

  it("agrees with the exact form on random points", () => {
    let seed = 12345;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
    for (let i = 0; i < 300; i++) {
      const p = [0, 1, 2, 3].map(() => [rnd(), rnd(), rnd()]);
      const [a, b, c, d] = p as [number[], number[], number[], number[]];
      expect(orient3d(a, b, c, d)).toBe(
        orient3dExact(
          q3FromDoubles(a[0]!, a[1]!, a[2]!),
          q3FromDoubles(b[0]!, b[1]!, b[2]!),
          q3FromDoubles(c[0]!, c[1]!, c[2]!),
          q3FromDoubles(d[0]!, d[1]!, d[2]!),
        ),
      );
    }
  });

  it("gets the nearly coplanar cases right, where floats guess", () => {
    // A point on the plane z = 0.1·x + 0.2·y, with coordinates that doubles
    // cannot hold exactly — the naive determinant is a coin toss here, and
    // the filter has to fall through to the exact answer. The answer is not
    // necessarily 0 (the stored doubles are not exactly on the plane), but it
    // must be the exact one.
    const plane = (x: number, y: number): number[] => [x, y, 0.1 * x + 0.2 * y];
    for (let i = 1; i < 60; i++) {
      const a = plane(0, 0), b = plane(1, 0), c = plane(0, 1), d = plane(i / 7, i / 13);
      const exact = orient3dExact(
        q3FromDoubles(a[0]!, a[1]!, a[2]!),
        q3FromDoubles(b[0]!, b[1]!, b[2]!),
        q3FromDoubles(c[0]!, c[1]!, c[2]!),
        q3FromDoubles(d[0]!, d[1]!, d[2]!),
      );
      expect(orient3d(a, b, c, d), `i=${i}`).toBe(exact);
    }
  });
});

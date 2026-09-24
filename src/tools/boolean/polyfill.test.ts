import { describe, it, expect } from "vitest";
import { polyfill, tessellateNgon } from "./polyfill";

/** Twice the signed area, positive for counter-clockwise. */
const area2 = (pts: readonly (readonly [number, number])[]): number =>
  pts.reduce((s, p, i) => {
    const q = pts[(i + 1) % pts.length]!;
    return s + p[0] * q[1] - q[0] * p[1];
  }, 0);

describe("polyfill", () => {
  it("fills a clockwise polygon with n − 2 triangles of its own winding", () => {
    // An L, clockwise (Blender's `coords_sign = 1`), with a reflex corner.
    const L = [
      [0, 0], [0, 2], [1, 2], [1, 1], [2, 1], [2, 0],
    ] as const;
    const tris = polyfill(L);
    expect(tris).toHaveLength(L.length - 2);
    let total = 0;
    for (const t of tris) {
      const a = area2(t.map((i) => L[i]!));
      expect(a).toBeLessThan(0); // clockwise, like the input
      total += a;
    }
    expect(total).toBeCloseTo(area2(L), 12);
  });

  it("never clips an ear with the reflex corner inside it", () => {
    // Cutting (5, 0, 1) would swallow corner 3; every triangle must be empty.
    const L = [
      [0, 0], [0, 2], [1, 2], [1, 1], [2, 1], [2, 0],
    ] as const;
    for (const t of polyfill(L)) {
      const [a, b, c] = t.map((i) => L[i]!);
      for (let v = 0; v < L.length; v++) {
        if (t.includes(v)) continue;
        const p = L[v]!;
        const s = [area2([a!, b!, p]), area2([b!, c!, p]), area2([c!, a!, p])];
        expect(s.every((x) => x < 0)).toBe(false);
      }
    }
  });
});

describe("tessellateNgon", () => {
  it("splits a bent hexagon into four triangles over its own corners", () => {
    const P: number[] = [];
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3;
      P.push(Math.cos(a), i === 0 ? 0.25 : 0, Math.sin(a));
    }
    const tris = tessellateNgon([0, 1, 2, 3, 4, 5], Float32Array.from(P));
    expect(tris).toHaveLength(4);
    expect(new Set(tris.flat()).size).toBe(6);
  });
});

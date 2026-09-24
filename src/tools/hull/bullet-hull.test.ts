import { describe, it, expect } from "vitest";
import { bulletConvexHull } from "./bullet-hull";

describe("bulletConvexHull", () => {
  it("gives a cube's six square faces", () => {
    const pts: number[][] = [];
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) pts.push([x, y, z]);
    const h = bulletConvexHull(pts);
    expect(h.originalIndex.length).toBe(8);
    expect(h.faces.map((f) => f.length).sort()).toEqual([4, 4, 4, 4, 4, 4]);
  });

  it("drops interior points and keeps every edge in two faces", () => {
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
    const pts: number[][] = [];
    for (let i = 0; i < 200; i++) pts.push([rnd(), rnd(), rnd()]);
    pts.push([0, 0, 0]); // inside
    const h = bulletConvexHull(pts);
    expect(h.originalIndex).not.toContain(200);
    // Closed and consistently wound: each directed edge once, its reverse once.
    const dir = new Set<string>();
    for (const f of h.faces)
      f.forEach((a, i) => {
        const k = `${a}>${f[(i + 1) % f.length]}`;
        expect(dir.has(k)).toBe(false);
        dir.add(k);
      });
    for (const k of dir) {
      const [a, b] = k.split(">");
      expect(dir.has(`${b}>${a}`)).toBe(true);
    }
    // Euler: V − E + F = 2.
    expect(h.originalIndex.length - dir.size / 2 + h.faces.length).toBe(2);
  });

  it("faces outward", () => {
    const pts = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const h = bulletConvexHull(pts);
    const P = h.originalIndex.map((i) => pts[i]!);
    const c = [0.25, 0.25, 0.25];
    for (const f of h.faces) {
      const [a, b, d] = f.map((v) => P[v]!);
      const u = [b![0]! - a![0]!, b![1]! - a![1]!, b![2]! - a![2]!];
      const w = [d![0]! - a![0]!, d![1]! - a![1]!, d![2]! - a![2]!];
      const n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
      const out = n[0]! * (a![0]! - c[0]!) + n[1]! * (a![1]! - c[1]!) + n[2]! * (a![2]! - c[2]!);
      expect(out).toBeGreaterThan(0);
    }
  });
});

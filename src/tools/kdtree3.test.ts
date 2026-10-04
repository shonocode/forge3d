import { describe, it, expect } from "vitest";
import { kdBuild, kdRangeSearch } from "./kdtree3";

describe("kdtree3 (Blender's BLI_kdtree, compat-backlog C21)", () => {
  const pts = (n: number): [number, number, number][] =>
    Array.from({ length: n }, (_, i) => [((i * 37) % 11) / 10, ((i * 17) % 7) / 10, ((i * 5) % 13) / 10]);

  it("finds exactly the points in range, whatever the walk order", () => {
    const P = pts(60);
    const tree = kdBuild(P);
    for (const [i, c] of P.entries()) {
      const hits: number[] = [];
      kdRangeSearch(tree, c, 0.25, (idx) => (hits.push(idx), true));
      const want = P.map((p, j) => [p, j] as const)
        .filter(([p]) => Math.fround(Math.hypot(...(p.map((x, k) => Math.fround(x) - Math.fround(c[k]!)) as [number, number, number]))) <= 0.25 + 1e-6)
        .map(([, j]) => j);
      expect(hits.sort((a, b) => a - b)).toEqual(want.sort((a, b) => a - b));
      expect(hits).toContain(i);
    }
  });

  it("stops when the callback says so", () => {
    const tree = kdBuild(pts(30));
    let calls = 0;
    kdRangeSearch(tree, [0.5, 0.3, 0.6], 5, () => (calls++, false));
    expect(calls).toBe(1);
  });

  it("is a permutation of the input: every index once", () => {
    const tree = kdBuild(pts(25));
    expect(tree.nodes.map((n) => n.index).sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });
});

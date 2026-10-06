import { describe, it, expect } from "vitest";
import { meshFromData, meshToData } from "../../lib/mesh";
import { canonicalEdge, edgeEnd, edgeOrigin, forEachEdge } from "./half-edge";
import { dissolveDegenerate } from "./operators";

/** Parity row `dissolve-degenerate-ears` (compat-backlog C84); the numbers are Blender 5.1.1's. */
describe("dissolveDegenerate — clipping ears", () => {
  const quad = (pts: number[][]) =>
    meshFromData({ positions: Float32Array.from(pts.flatMap(([x, y]) => [x!, y!, 0])), polys: [pts.map((_, i) => i)] });

  it("cuts a spike whose previous edge is the shorter: a triangle is left, with the sliver's edge as a wire", () => {
    const em = quad([[0, 0], [1, 0], [1, 1], [0.5, 0]]);
    dissolveDegenerate(em, 0.01);
    const out = meshToData(em);
    expect(out.positions.length / 3).toBe(4);
    expect(out.polys).toHaveLength(1);
    expect(out.polys[0]).toHaveLength(3);
    expect(out.edges).toHaveLength(1);
  });

  it("joins the far ends of a kite whose two edges are the same length, and collapses the join", () => {
    const em = quad([[0, 0], [1, 0], [2, 0], [1, 0.001]]);
    dissolveDegenerate(em, 0.01);
    const out = meshToData(em);
    expect(out.polys).toHaveLength(0);
    expect(out.edges).toHaveLength(2);
    expect(out.positions.length / 3).toBe(3);
  });

  it("counts a short edge at a wide angle as an ear: the test is len(dir_prev - dir_next) * min(len)", () => {
    const em = quad([[0, 0], [0.02, 0], [1, 1], [1, 0.3]]);
    dissolveDegenerate(em, 0.01);
    expect(meshToData(em).polys).toHaveLength(1);
    expect(meshToData(em).polys[0]).toHaveLength(3);
  });

  it("flags the far edge itself when the ear is a triangle with equal edges (measured: probe-ears-triangle.py)", () => {
    // Edge 1-2 (0.01 long, under dist 0.0105) is left out of `edges`, so the first phase does not collapse it; the ear at vertex 0 does.
    const em = meshFromData({ positions: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 0.01, 0]), polys: [[0, 1, 2]] });
    const edges = new Set<number>();
    forEachEdge(em, (he) => {
      const c = canonicalEdge(em, he);
      const pair = [edgeOrigin(em, c), edgeEnd(em, c)].sort().join();
      if (pair !== "1,2") edges.add(c);
    });
    dissolveDegenerate(em, 0.0105, edges);
    const out = meshToData(em);
    expect(out.polys).toHaveLength(0);
    expect(out.positions.length / 3).toBe(2);
    expect(out.edges).toHaveLength(1);
    expect(out.positions[4]).toBeCloseTo(0.005, 6);
  });

  it("leaves a corner alone that is not an ear", () => {
    const em = quad([[0, 0], [1, 0], [1, 1], [0, 1]]);
    dissolveDegenerate(em, 0.01);
    expect(meshToData(em).polys).toHaveLength(1);
    expect(meshToData(em).positions.length / 3).toBe(4);
  });
});

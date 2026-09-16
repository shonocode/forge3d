/**
 * The dissolve family against numbers read off Blender 5.1.1.
 *
 * Every count here came out of `bmesh.ops`, not out of reasoning about what
 * ought to happen — the defaults in this corner are surprising enough that
 * reasoning would have produced a different (wrong) set of expectations.
 */
import { describe, it, expect } from "vitest";
import { meshFromData, meshToData } from "../../lib/mesh";
import { forEachEdge } from "./half-edge";
import { dissolveFaces, dissolveEdges, dissolveLimit } from "./dissolve";

/** `nx` by `ny` quads in the z=0 plane, one unit each. */
function grid(nx: number, ny: number) {
  const positions: number[] = [];
  const id = new Map<string, number>();
  for (let i = 0; i <= nx; i++)
    for (let j = 0; j <= ny; j++) {
      id.set(`${i},${j}`, positions.length / 3);
      positions.push(i, j, 0);
    }
  const polys: number[][] = [];
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++)
      polys.push([
        id.get(`${i},${j}`)!,
        id.get(`${i + 1},${j}`)!,
        id.get(`${i + 1},${j + 1}`)!,
        id.get(`${i},${j + 1}`)!,
      ]);
  return { positions: new Float32Array(positions), polys };
}

/** Two quads meeting at an angle, so the shared edge carries shape. */
function bentPair(z: number) {
  return {
    positions: new Float32Array([
      0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
      2, 0, z, 2, 1, z,
    ]),
    polys: [
      [0, 1, 2, 3],
      [1, 4, 5, 2],
    ],
  };
}

const arities = (polys: readonly (readonly number[])[]): number[] =>
  polys.map((p) => p.length).sort((a, b) => a - b);

describe("dissolveFaces", () => {
  it("merges two quads into a hexagon, keeping the straight vertices", () => {
    // Measured: verts 6 -> 6, faces 2 -> 1, one 6-gon.
    const em = meshFromData(grid(2, 1));
    const report = dissolveFaces(em, new Set([0, 1]));
    const out = meshToData(em);

    expect(out.polys).toHaveLength(1);
    expect(arities(out.polys)).toEqual([6]);
    expect(out.positions).toHaveLength(18);
    expect(report.merged).toBe(1);
    expect(report.skipped).toBe(0);
  });

  it("useVerts also takes the two-edged vertices out", () => {
    // Measured: verts 6 -> 4, one quad.
    const em = meshFromData(grid(2, 1));
    const report = dissolveFaces(em, new Set([0, 1]), { useVerts: true });
    const out = meshToData(em);

    expect(arities(out.polys)).toEqual([4]);
    expect(report.vertsRemoved).toBe(2);
  });

  it("merges only what actually touches", () => {
    // Faces 0 and 2 of a 3x1 grid are not adjacent, so they stay two faces.
    const em = meshFromData(grid(3, 1));
    dissolveFaces(em, new Set([0, 2]));
    expect(meshToData(em).polys).toHaveLength(3);
  });

  it("is a no-op below two faces", () => {
    const em = meshFromData(grid(2, 1));
    dissolveFaces(em, new Set([0]));
    expect(meshToData(em).polys).toHaveLength(2);
  });

  it("skips a region that rings a hole rather than mangling it", () => {
    // The eight faces around the middle of a 3x3 grid: their border is two
    // loops, and one polygon cannot hold a hole.
    const em = meshFromData(grid(3, 3));
    const ring = new Set([0, 1, 2, 3, 5, 6, 7, 8]); // everything but the centre
    const report = dissolveFaces(em, ring);
    expect(report.skipped).toBe(1);
    expect(meshToData(em).polys).toHaveLength(9);
  });
});

describe("dissolveEdges", () => {
  it("removes the shared edge and merges the two faces", () => {
    // Measured: the same result dissolve_faces gives — 6 verts, one hexagon.
    const em = meshFromData(grid(2, 1));
    const shared = new Set<number>();
    forEachEdge(em, (he) => {
      if (em.halfEdges[he]!.twin >= 0) shared.add(he);
    });
    dissolveEdges(em, shared);
    const out = meshToData(em);
    expect(arities(out.polys)).toEqual([6]);
  });

  it("ignores boundary edges instead of deleting geometry", () => {
    // Dissolving is not deleting. An edge with one face has nothing to merge.
    const em = meshFromData(grid(1, 1));
    const all = new Set<number>();
    forEachEdge(em, (he) => all.add(he));
    dissolveEdges(em, all);
    expect(meshToData(em).polys).toHaveLength(1);
  });
});

describe("dissolveLimit", () => {
  it("leaves a perfectly flat grid alone at a limit of zero", () => {
    // Measured, and the surprising half: 0 means nothing dissolves, because
    // the test is strictly less-than.
    const em = meshFromData(grid(3, 1));
    dissolveLimit(em, { angleLimit: 0 });
    expect(meshToData(em).polys).toHaveLength(3);
  });

  it("merges a flat grid into one quad at any positive limit", () => {
    // Measured: 8 verts / 3 faces becomes 4 verts / 1 quad at 0.01 rad.
    const em = meshFromData(grid(3, 1));
    dissolveLimit(em, { angleLimit: 0.01 });
    const out = meshToData(em);
    expect(arities(out.polys)).toEqual([4]);
    expect(out.positions).toHaveLength(12);
  });

  it("keeps an edge that turns a corner", () => {
    // Two quads at 0.464 rad. Measured: survives 0.10, merges at 0.60.
    const keep = meshFromData(bentPair(0.5));
    dissolveLimit(keep, { angleLimit: 0.1 });
    expect(meshToData(keep).polys).toHaveLength(2);

    const merge = meshFromData(bentPair(0.5));
    dissolveLimit(merge, { angleLimit: 0.6 });
    expect(arities(meshToData(merge).polys)).toEqual([4]);
  });

  it("is what a generated room wants: coplanar quads collapse, corners stay", () => {
    // A flat 4x1 strip with a fold at the end — the shape of every wall that
    // was built as several boxes.
    const strip = grid(4, 1);
    // lift the last column so the final edge is a real corner
    for (let v = 0; v < strip.positions.length / 3; v++)
      if (strip.positions[v * 3]! === 4) strip.positions[v * 3 + 2] = 1;

    const em = meshFromData(strip);
    dissolveLimit(em, { angleLimit: 0.05 });
    const out = meshToData(em);
    expect(out.polys).toHaveLength(2); // three flat quads merged, the fold kept
  });
});

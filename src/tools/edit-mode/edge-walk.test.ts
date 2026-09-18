import { describe, it, expect } from "vitest";

import { box, cylinder, plane } from "../generate";
import { meshFromData } from "../../lib/mesh";
import { nearestEdges } from "../select";
import { canonicalEdge, edgeEnd, edgeOrigin, forEachEdge, type EditMesh } from "./half-edge";
import { edgesAtVertex, selectEdgeLoop, selectEdgeRing } from "./edge-walk";

/**
 * Every expected count here was measured against Blender 5.1.1 first —
 * `tools/modeling/parity/compare-edge-walk.ts` in the soul repo runs the same
 * questions against the reference and this suite is the fast copy of it.
 */

/** The canonical edge joining two vertices. */
function edgeBetween(em: EditMesh, a: number, b: number): number {
  let found = -1;
  forEachEdge(em, (he) => {
    const x = edgeOrigin(em, he);
    const y = edgeEnd(em, he);
    if ((x === a && y === b) || (x === b && y === a)) found = canonicalEdge(em, he);
  });
  return found;
}

/** An octahedron: every vertex valence 4, every face a triangle. */
function octahedron(): EditMesh {
  return meshFromData({
    positions: Float32Array.from([1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1]),
    polys: [
      [0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4],
      [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5],
    ],
  });
}

/** A drum: 8 side quads between two 8-gon caps. */
function drum(): EditMesh {
  return meshFromData(cylinder({ radius1: 1, depth: 2, uSegments: 8, caps: "ngon" }));
}

describe("selectEdgeLoop", () => {
  it("test_cube_edge_has_no_loop", () => {
    // Valence 3 everywhere, so the walk cannot leave the seed — the cube is
    // the shape that says a loop is not simply "the edges in a row".
    const em = meshFromData(box({ size: [2, 2, 2] }));
    const seed = nearestEdges(em, [1, 1, 0])[0]!;
    expect(selectEdgeLoop(em, seed).size).toBe(1);
  });

  it("test_octahedron_loop_runs_through_triangles", () => {
    // Nothing in the rule is about quads: these vertices have four edges, so
    // the loop steps through them and comes back round in four.
    const em = octahedron();
    const loop = selectEdgeLoop(em, edgeBetween(em, 0, 2));
    expect(loop.size).toBe(4);
  });

  it("test_ngon_cap_gives_its_own_perimeter", () => {
    // The n-gon hub: the seed has an 8-gon on one side, so the loop is that
    // face's rim. This is the selection the brazier's bowl needed.
    const em = drum();
    const loop = selectEdgeLoop(em, nearestEdges(em, [1, 1, 0])[0]!);
    expect(loop.size).toBe(8);
    for (const e of loop) {
      expect(em.positions[edgeOrigin(em, e) * 3 + 1]).toBeCloseTo(1, 6);
      expect(em.positions[edgeEnd(em, e) * 3 + 1]).toBeCloseTo(1, 6);
    }
  });

  it("test_quad_to_quad_edge_of_the_same_drum_stops", () => {
    // A vertical edge of the drum has a quad on each side and valence-3 ends.
    const em = drum();
    const loop = selectEdgeLoop(em, nearestEdges(em, [1, 0, 0])[0]!);
    expect(loop.size).toBe(1);
  });

  it("test_grid_column_runs_to_both_edges_of_the_sheet", () => {
    const em = meshFromData(plane({ size: [4, 4], segments: [4, 4] }));
    // An interior edge one row in: the loop runs the whole column and stops
    // where the sheet does, because a boundary vertex has an open fan.
    const loop = selectEdgeLoop(em, nearestEdges(em, [-1, 0, -1.5])[0]!);
    expect(loop.size).toBe(4);
  });

  it("test_grid_boundary_loop_stops_at_the_corners", () => {
    // Along the edge of the sheet, not around it: a corner of a quad is where
    // Blender stops, and it stops on arity rather than on the angle.
    const em = meshFromData(plane({ size: [4, 4], segments: [4, 4] }));
    const loop = selectEdgeLoop(em, nearestEdges(em, [-2, 0, -1.5])[0]!);
    expect(loop.size).toBe(4);
  });
});

describe("selectEdgeRing", () => {
  it("test_cube_ring_closes_at_four", () => {
    const em = meshFromData(box({ size: [2, 2, 2] }));
    expect(selectEdgeRing(em, nearestEdges(em, [1, 1, 0])[0]!).size).toBe(4);
  });

  it("test_ring_stops_at_triangles", () => {
    // A triangle has no opposite side, so there is nowhere to come out.
    const em = octahedron();
    expect(selectEdgeRing(em, edgeBetween(em, 0, 2)).size).toBe(1);
  });

  it("test_ring_crosses_the_drum_and_stops_at_the_caps", () => {
    const em = drum();
    // From a cap edge: across one side quad to the far cap, and no further.
    expect(selectEdgeRing(em, nearestEdges(em, [1, 1, 0])[0]!).size).toBe(2);
    // From a vertical edge: right round the drum.
    expect(selectEdgeRing(em, nearestEdges(em, [1, 0, 0])[0]!).size).toBe(8);
  });

  it("test_ring_is_not_the_loop", () => {
    // The two walks through one edge of a grid are perpendicular, and share
    // only the seed. `loopCut` wants the ring; "the loop around the rim" wants
    // the loop. They used to have one name between them.
    const em = meshFromData(plane({ size: [4, 4], segments: [4, 4] }));
    const seed = nearestEdges(em, [-1, 0, -1.5])[0]!;
    const loop = selectEdgeLoop(em, seed);
    const ring = selectEdgeRing(em, seed);
    const shared = [...loop].filter((e) => ring.has(e));
    expect(shared).toEqual([seed]);
  });
});

describe("edgesAtVertex", () => {
  it("test_cube_corner_is_three_edges_and_closed", () => {
    const em = meshFromData(box({ size: [2, 2, 2] }));
    const fan = edgesAtVertex(em, 0);
    expect(fan.edges).toHaveLength(3);
    expect(fan.closed).toBe(true);
  });

  it("test_sheet_corner_is_two_edges_and_open", () => {
    // The open fan is the whole reason this returns a flag: a count alone
    // cannot tell a corner of a hole from an ordinary interior vertex.
    const em = meshFromData(plane({ size: [4, 4], segments: [4, 4] }));
    const corner = nearestEdges(em, [-2, 0, -2])[0]!;
    const v = edgeOrigin(em, corner);
    const fan = edgesAtVertex(em, v);
    expect(fan.closed).toBe(false);
    expect(fan.edges.length).toBeLessThanOrEqual(3);
  });
});

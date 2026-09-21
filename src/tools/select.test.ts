import { describe, it, expect } from "vitest";

import { box } from "./generate";
import { meshFromData, meshToData, type MeshData } from "../lib/mesh";
import { extrudeFacesBy, scaleFaces } from "./edit-mode/face-transform";
import {
  faceCentroid,
  faceNormal,
  selectFaces,
  facing,
  centroidWhere,
  withinBounds,
  hasSides,
  and,
  or,
  not,
  nearestFaces,
  selectEdges,
  edgeAlong,
  edgeMidpoint,
  nearestEdges,
  regionExtend,
} from "./select";

/** A unit cube centred on the origin: six quads, one per axis direction. */
function cube() {
  return meshFromData(box({ size: [2, 2, 2] }));
}

describe("faceCentroid", () => {
  it("test_cube_face_centroids_sit_on_the_axes", () => {
    const em = cube();
    const centroids = Array.from({ length: em.faces.length }, (_, f) => faceCentroid(em, f));

    // Every face of a 2-unit cube is centred one unit out along one axis.
    for (const c of centroids) {
      const nonZero = c.filter((v) => Math.abs(v) > 1e-6);
      expect(nonZero).toHaveLength(1);
      expect(Math.abs(nonZero[0]!)).toBeCloseTo(1, 5);
    }
  });
});

describe("faceNormal", () => {
  it("test_cube_normals_are_unit_length_and_axis_aligned", () => {
    const em = cube();
    for (let f = 0; f < em.faces.length; f++) {
      const n = faceNormal(em, f);
      expect(Math.hypot(...n)).toBeCloseTo(1, 5);
      expect(n.filter((v) => Math.abs(v) > 1e-6)).toHaveLength(1);
    }
  });
});

describe("facing", () => {
  it("test_picks_exactly_one_face_per_axis_direction", () => {
    const em = cube();
    for (const dir of [
      [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
    ] as const) {
      expect(selectFaces(em, facing(dir, 45)).size).toBe(1);
    }
  });

  it("test_a_wide_cone_catches_the_four_faces_around_an_axis", () => {
    const em = cube();
    // Anything within 90 degrees of +Y: the top, plus the four sides, but not
    // the bottom.
    expect(selectFaces(em, facing([0, 1, 0], 90)).size).toBe(5);
  });

  it("test_selects_nothing_when_the_cone_is_too_narrow", () => {
    const em = cube();
    expect(selectFaces(em, facing([1, 1, 0], 10)).size).toBe(0);
  });
});

describe("withinBounds", () => {
  it("test_null_bounds_leave_an_axis_unconstrained", () => {
    const em = cube();
    // A height band containing only the faces whose centroid is at y = 0 —
    // that is the four sides.
    const band = selectFaces(em, withinBounds([null, -0.5, null], [null, 0.5, null]));
    expect(band.size).toBe(4);
  });

  it("test_a_closed_box_isolates_one_face", () => {
    const em = cube();
    const picked = selectFaces(em, withinBounds([0.5, -0.5, -0.5], [1.5, 0.5, 0.5]));
    expect(picked.size).toBe(1);
    expect(faceCentroid(em, [...picked][0]!)[0]).toBeCloseTo(1, 5);
  });
});

describe("combinators", () => {
  it("test_and_narrows_to_the_intersection", () => {
    const em = cube();
    const picked = selectFaces(em, and(facing([1, 0, 0], 90), facing([0, 1, 0], 90)));
    // A 90-degree cone on a cube takes five of the six faces — everything but
    // the one pointing away. Two such cones therefore drop one face each, and
    // -X and -Y are different faces, so four survive.
    expect(picked.size).toBe(4);

    // Narrow the cones and nothing survives: a box has no face pointing
    // between two axes, so the intersection empties rather than shrinking.
    const corner = selectFaces(em, and(facing([1, 0, 0], 60), facing([0, 1, 0], 60)));
    expect(corner.size).toBe(0);
  });

  it("test_or_widens_to_the_union", () => {
    const em = cube();
    const picked = selectFaces(em, or(facing([1, 0, 0], 45), facing([-1, 0, 0], 45)));
    expect(picked.size).toBe(2);
  });

  it("test_not_inverts", () => {
    const em = cube();
    const picked = selectFaces(em, not(facing([0, 1, 0], 45)));
    expect(picked.size).toBe(5);
  });
});

describe("hasSides", () => {
  it("test_a_generated_box_is_all_quads", () => {
    const em = cube();
    expect(selectFaces(em, hasSides(4)).size).toBe(em.faces.length);
    expect(selectFaces(em, hasSides(3)).size).toBe(0);
  });
});

describe("nearestFaces", () => {
  it("test_returns_faces_ordered_by_distance", () => {
    const em = cube();
    const near = nearestFaces(em, [3, 0, 0], 2);
    expect(near).toHaveLength(2);
    // The +X face is closest; whatever comes second must be further away.
    expect(faceCentroid(em, near[0]!)[0]).toBeCloseTo(1, 5);
    expect(faceCentroid(em, near[1]!)[0]).toBeLessThan(1);
  });

  it("test_honours_a_predicate_filter", () => {
    const em = cube();
    // Nearest face to a point outside +X, but only considering upward faces.
    const near = nearestFaces(em, [3, 0, 0], 1, facing([0, 1, 0], 45));
    expect(near).toHaveLength(1);
    expect(faceCentroid(em, near[0]!)[1]).toBeCloseTo(1, 5);
  });

  it("test_asking_for_more_than_exist_returns_them_all", () => {
    const em = cube();
    expect(nearestFaces(em, [0, 0, 0], 99)).toHaveLength(em.faces.length);
  });
});

describe("centroidWhere", () => {
  it("test_an_arbitrary_test_on_the_centroid_selects", () => {
    const em = cube();
    // Everything in the upper half — on a cube, only the top.
    const upper = selectFaces(em, centroidWhere((p) => p[1] > 0.5));
    expect(upper.size).toBe(1);
    expect(faceNormal(em, [...upper][0]!)[1]).toBeCloseTo(1, 5);
  });
});

describe("selection driving a transform", () => {
  it("test_a_declarative_selection_grows_a_tapered_stub", () => {
    const em = cube();
    // The sentence this module exists to spell: "the outward-facing side,
    // level with the middle" — which is the shape of growing a limb.
    const side = selectFaces(em, and(
      facing([1, 0, 0], 45),
      centroidWhere((p) => Math.abs(p[1]) < 0.5),
    ));
    expect(side.size).toBe(1);

    const grown = extrudeFacesBy(em, side, 0.8);
    scaleFaces(em, grown, 0.6);

    // The cap has moved out past the original face and narrowed.
    expect(faceCentroid(em, [...grown][0]!)[0]).toBeCloseTo(1.8, 5);

    const data = meshToData(em);
    for (const v of data.polys[[...grown][0]!]!) {
      expect(Math.abs(data.positions[v * 3 + 1]!)).toBeCloseTo(0.6, 5);
    }
  });
});

describe("edge selection", () => {
  it("test_every_edge_of_a_cube_is_found_once", () => {
    const em = cube();
    expect(selectEdges(em, () => true).size).toBe(12);
  });

  it("test_edgeAlong_splits_a_cube_into_its_three_directions", () => {
    const em = cube();
    for (const axis of [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const) {
      // Four edges run along each axis, and `edgeAlong` is unsigned, so the
      // ones pointing backwards count too.
      expect(selectEdges(em, edgeAlong(axis, 10)).size).toBe(4);
    }
  });

  it("test_nearestEdges_picks_the_edge_the_point_sits_on", () => {
    const em = cube();
    // The midpoint of the cube's top-front edge, exactly.
    const [edge] = nearestEdges(em, [0, 1, 1]);
    expect(edgeMidpoint(em, edge!)).toEqual([0, 1, 1]);
  });

  it("test_a_predicate_changes_which_edge_is_nearest", () => {
    const em = cube();
    // Nearest to a corner is ambiguous between the three edges meeting there,
    // so the direction is what names the one meant — the mechanism that makes
    // "click on the rim" work on a bowl.
    const [vertical] = nearestEdges(em, [1, 1, 1], 1, edgeAlong([0, 1, 0], 10));
    expect(edgeMidpoint(em, vertical!)).toEqual([1, 0, 1]);
  });
});

describe("regionExtend", () => {
  /**
   * The 4×4 grid the Blender probe used — face `r * 4 + c`, so
   *
   *   12 13 14 15
   *    8  9 10 11
   *    4  5  6  7
   *    0  1  2  3
   */
  function grid4(): MeshData {
    const positions: number[] = [];
    for (let r = 0; r <= 4; r++)
      for (let c = 0; c <= 4; c++) positions.push(c * 0.25 - 0.5, r * 0.25 - 0.5, 0);
    const polys: number[][] = [];
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 4; c++)
        polys.push([r * 5 + c, r * 5 + c + 1, (r + 1) * 5 + c + 1, (r + 1) * 5 + c]);
    return { positions: new Float32Array(positions), polys };
  }

  const sorted = (s: ReadonlySet<number>): number[] => [...s].sort((a, b) => a - b);
  const g = grid4();

  // Every expectation is a Blender 5.1.1 result from
  // tools/modeling/parity/probe-region-extend.py.

  it("grows to the faces sharing an edge", () => {
    expect(sorted(regionExtend(g, new Set([5])))).toEqual([1, 4, 6, 9]);
    expect(sorted(regionExtend(g, new Set([0])))).toEqual([1, 4]);
    expect(sorted(regionExtend(g, new Set([5, 6, 9, 10])))).toEqual([
      1, 2, 4, 7, 8, 11, 13, 14,
    ]);
  });

  it("grows to the faces sharing only a vertex with faceStep", () => {
    expect(sorted(regionExtend(g, new Set([5]), { faceStep: true }))).toEqual([
      0, 1, 2, 4, 6, 8, 9, 10,
    ]);
    expect(sorted(regionExtend(g, new Set([0]), { faceStep: true }))).toEqual([1, 4, 5]);
    expect(sorted(regionExtend(g, new Set([5, 6, 9, 10]), { faceStep: true }))).toEqual([
      0, 1, 2, 3, 4, 7, 8, 11, 12, 13, 14, 15,
    ]);
  });

  it("returns what changed, not the new selection", () => {
    // Blender returns the extension. A single face grows to four neighbours
    // and the face itself is not among them.
    expect(regionExtend(g, new Set([5])).has(5)).toBe(false);
  });

  it("shrinks to the selection's own border", () => {
    expect(sorted(regionExtend(g, new Set([5]), { contract: true }))).toEqual([5]);
    expect(sorted(regionExtend(g, new Set([5, 6, 9, 10]), { contract: true }))).toEqual([
      5, 6, 9, 10,
    ]);
    // A 3×3 block: only its middle survives.
    const block = new Set([5, 6, 7, 9, 10, 11, 13, 14, 15]);
    expect(sorted(regionExtend(g, block, { contract: true }))).toEqual([5, 6, 7, 9, 13]);
  });

  it("uses the selection's border, not the mesh's", () => {
    // The whole grid has nothing outside it, so shrinking removes nothing —
    // the outer faces are on the *mesh* boundary, which does not count.
    const all = new Set(g.polys.map((_, i) => i));
    expect(sorted(regionExtend(g, all, { contract: true }))).toEqual([]);
    expect(sorted(regionExtend(g, all))).toEqual([]);
  });

  it("applies faceStep when shrinking too", () => {
    // The case built to tell the two adjacencies apart: a 3×3 block with one
    // corner missing. Face 10 has all four edge-neighbours inside but touches
    // the absent 15 at a point.
    const notched = new Set([5, 6, 7, 9, 10, 11, 13, 14]);
    expect(sorted(regionExtend(g, notched, { contract: true }))).toEqual([
      5, 6, 7, 9, 11, 13, 14,
    ]);
    expect(sorted(regionExtend(g, notched, { contract: true, faceStep: true }))).toEqual([
      5, 6, 7, 9, 10, 11, 13, 14,
    ]);
  });

  it("returns nothing for an empty selection", () => {
    expect(sorted(regionExtend(g, new Set()))).toEqual([]);
    expect(sorted(regionExtend(g, new Set(), { contract: true }))).toEqual([]);
  });
});

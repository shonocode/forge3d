import { describe, it, expect } from "vitest";

import { box } from "./generate";
import { meshFromData, meshToData } from "../lib/mesh";
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

import { describe, it, expect } from "vitest";
import { deleteLoose } from "./mesh-repair";
import { box, plane } from "./generate";
import {
  mergeMeshes,
  transformMesh,
  mirrorMesh,
  arrayMesh,
  instanceMesh,
  radialArray,
  arrayAlongPath,
  weldMesh,
  maskMesh,
  wireframe,
  boundsOf,
} from "./mesh-ops";
import { creaseAll, meshFromData, meshToData } from "../lib/mesh";
import type { MeshData } from "../lib/mesh";

const vertCount = (m: MeshData): number => m.positions.length / 3;
const vert = (m: MeshData, i: number): [number, number, number] => [
  m.positions[i * 3]!,
  m.positions[i * 3 + 1]!,
  m.positions[i * 3 + 2]!,
];

describe("mergeMeshes", () => {
  it("offsets polygon indices into the combined vertex array", () => {
    const a = box();
    const b = box({ at: [3, 0, 0] });
    const m = mergeMeshes([a, b]);
    expect(vertCount(m)).toBe(16);
    expect(m.polys).toHaveLength(12);
    for (const poly of m.polys) for (const v of poly) expect(v).toBeLessThan(16);
    // The second box's faces must all point into its own half of the array.
    expect(Math.min(...m.polys[6]!)).toBeGreaterThanOrEqual(8);
  });

  it("carries creases across, remapped to the new indices", () => {
    const a = box();
    creaseAll(a, 1);
    const b = box({ at: [3, 0, 0] });
    creaseAll(b, 1);
    const m = mergeMeshes([a, b]);
    expect(m.creases!.size).toBe(24); // 12 edges each, none shared
    for (const key of m.creases!.keys()) {
      const [p, q] = key.split("_").map(Number);
      expect(p!).toBeLessThan(16);
      expect(q!).toBeLessThan(16);
    }
  });

  it("produces a mesh the half-edge builder accepts", () => {
    const m = mergeMeshes([box(), box({ at: [3, 0, 0] })]);
    const round = meshToData(meshFromData(m));
    expect(round.polys).toHaveLength(12);
  });

  it("handles an empty list", () => {
    const m = mergeMeshes([]);
    expect(vertCount(m)).toBe(0);
    expect(m.polys).toHaveLength(0);
  });
});

describe("transformMesh", () => {
  it("translates without touching topology", () => {
    const m = transformMesh(box(), { translate: [1, 2, 3] });
    const bb = boundsOf(m)!;
    expect(bb.center[0]).toBeCloseTo(1, 6);
    expect(bb.center[1]).toBeCloseTo(2, 6);
    expect(bb.center[2]).toBeCloseTo(3, 6);
  });

  it("rotates about the pivot, not the origin", () => {
    const m = transformMesh(box({ at: [2, 0, 0] }), {
      rotate: [0, Math.PI / 2, 0],
      pivot: [2, 0, 0],
    });
    expect(boundsOf(m)!.center[0]).toBeCloseTo(2, 5);

    const spun = transformMesh(box({ at: [2, 0, 0] }), { rotate: [0, Math.PI / 2, 0] });
    expect(boundsOf(spun)!.center[2]).toBeCloseTo(-2, 5);
  });

  it("scales per axis", () => {
    expect(boundsOf(transformMesh(box(), { scale: [2, 4, 6] }))!.size).toEqual([2, 4, 6]);
    expect(boundsOf(transformMesh(box(), { scale: 3 }))!.size).toEqual([3, 3, 3]);
  });

  it("reverses winding when a scale mirrors the mesh", () => {
    const src = box();
    const flipped = transformMesh(src, { scale: [-1, 1, 1] });
    expect(flipped.polys[0]).toEqual([...src.polys[0]!].reverse());
    // Two negative axes is a rotation, not a reflection — winding is kept.
    const twice = transformMesh(src, { scale: [-1, -1, 1] });
    expect(twice.polys[0]).toEqual(src.polys[0]);
  });

  it("does not alias the source mesh", () => {
    const src = box();
    const moved = transformMesh(src, { translate: [1, 0, 0] });
    moved.polys[0]![0] = 99;
    expect(src.polys[0]![0]).not.toBe(99);
    expect(vert(src, 0)[0]).not.toBeCloseTo(vert(moved, 0)[0]);
  });
});

describe("mirrorMesh", () => {
  it("keeps both halves by default", () => {
    const m = mirrorMesh(box({ at: [2, 0, 0] }), "x");
    expect(vertCount(m)).toBe(16);
    const bb = boundsOf(m)!;
    expect(bb.min[0]).toBeCloseTo(-2.5, 5);
    expect(bb.max[0]).toBeCloseTo(2.5, 5);
  });

  it("mirrors about an offset plane", () => {
    const m = mirrorMesh(box({ at: [1, 0, 0] }), "x", { keepOriginal: false, offset: 5 });
    expect(boundsOf(m)!.center[0]).toBeCloseTo(9, 5);
  });

  it("welds the seam into a single surface", () => {
    // Half a box, mirrored back onto itself: the shared face welds away and
    // the result is one closed box rather than two shells meeting.
    const half = box({ size: [1, 1, 1], at: [0.5, 0, 0] });
    const welded = mirrorMesh(half, "x", { weld: 1e-4 });
    expect(vertCount(welded)).toBe(12); // 16 minus the 4 shared corners
    const loose = mirrorMesh(half, "x");
    expect(vertCount(loose)).toBe(16);
  });
});

describe("arrayMesh / instanceMesh", () => {
  it("repeats at a fixed offset", () => {
    const m = arrayMesh(box(), 4, [2, 0, 0]);
    expect(vertCount(m)).toBe(32);
    const bb = boundsOf(m)!;
    expect(bb.min[0]).toBeCloseTo(-0.5, 6);
    expect(bb.max[0]).toBeCloseTo(6.5, 6);
  });

  it("count 1 is the mesh itself", () => {
    expect(vertCount(arrayMesh(box(), 1, [2, 0, 0]))).toBe(8);
  });

  it("places instances individually", () => {
    const m = instanceMesh(box(), [
      { translate: [0, 0, 0] },
      { translate: [0, 0, 4], rotate: [0, Math.PI / 4, 0] },
    ]);
    expect(vertCount(m)).toBe(16);
    // The rotated copy is wider across x than the unrotated one.
    expect(boundsOf(m)!.size[0]).toBeGreaterThan(1);
  });
});

describe("weldMesh", () => {
  it("fuses coincident vertices and drops the faces that collapse", () => {
    const doubled = mergeMeshes([plane(), plane()]);
    expect(vertCount(doubled)).toBe(8);
    const w = weldMesh(doubled);
    expect(vertCount(w)).toBe(4);
    expect(w.polys).toHaveLength(2); // both quads survive, now sharing verts
  });

  it("leaves distinct geometry alone", () => {
    const m = weldMesh(mergeMeshes([box(), box({ at: [3, 0, 0] })]));
    expect(vertCount(m)).toBe(16);
  });

  it("drops creases that weld onto themselves", () => {
    const a = plane();
    creaseAll(a, 1);
    const w = weldMesh(mergeMeshes([a, a]));
    expect(w.creases!.size).toBe(4);
  });

  it("respects the tolerance", () => {
    const near = mergeMeshes([box(), box({ at: [0.01, 0, 0] })]);
    expect(vertCount(weldMesh(near, 1e-4))).toBe(16);
    expect(vertCount(weldMesh(near, 0.05))).toBe(8);
  });
});

describe("boundsOf", () => {
  it("reports min, max, size and centre", () => {
    const bb = boundsOf(box({ size: [2, 4, 6], at: [1, 2, 3] }))!;
    expect(bb.min).toEqual([0, 0, 0]);
    expect(bb.max).toEqual([2, 4, 6]);
    expect(bb.size).toEqual([2, 4, 6]);
    expect(bb.center).toEqual([1, 2, 3]);
  });

  it("is null for an empty mesh", () => {
    expect(boundsOf({ positions: new Float32Array(), polys: [] })).toBeNull();
  });
});

describe("radialArray", () => {
  it("test_a_full_turn_does_not_put_a_copy_on_the_original", () => {
    // Blender's spin does, and that is the reason this function exists rather
    // than a thin wrapper: 40 vertices where 32 are distinct is invisible
    // until something z-fights.
    const ring = radialArray(box({ at: [1.5, 0, 0] }), { count: 4 });
    expect(vertCount(ring)).toBe(32);
    const distinct = new Set<string>();
    for (let i = 0; i < vertCount(ring); i++) distinct.add(vert(ring, i).map((n) => n.toFixed(5)).join(","));
    expect(distinct.size).toBe(32);
  });

  it("test_three_copies_land_at_120_degrees", () => {
    const legs = radialArray(box({ at: [1, 0, 0] }), { count: 3 });
    const centres = [0, 1, 2].map((i) => {
      // Each copy's 8 vertices average back to where its box centre went.
      let x = 0, z = 0;
      for (let v = i * 8; v < i * 8 + 8; v++) {
        x += vert(legs, v)[0];
        z += vert(legs, v)[2];
      }
      return [x / 8, z / 8];
    });
    expect(centres[0]![0]).toBeCloseTo(1, 5);
    expect(centres[1]![0]).toBeCloseTo(Math.cos((2 * Math.PI) / 3), 5);
    // +Y is up and the turn is right-handed about it, so the second copy goes
    // to negative z. Pinned because a sign flip here is a mirrored prop.
    expect(centres[1]![1]).toBeCloseTo(-Math.sin((2 * Math.PI) / 3), 5);
    expect(centres[2]![1]).toBeCloseTo(Math.sin((2 * Math.PI) / 3), 5);
  });

  it("test_a_partial_angle_puts_the_last_copy_on_the_angle", () => {
    // A fan of five across a quarter turn is five, not four and a gap.
    const fan = radialArray(box({ at: [1, 0, 0] }), { count: 5, angle: Math.PI / 2 });
    expect(vertCount(fan)).toBe(40);
    let x = 0, z = 0;
    for (let v = 32; v < 40; v++) {
      x += vert(fan, v)[0];
      z += vert(fan, v)[2];
    }
    expect(x / 8).toBeCloseTo(0, 5);
    expect(z / 8).toBeCloseTo(-1, 5);
  });

  it("test_the_axis_and_centre_are_honoured", () => {
    const m = radialArray(box(), { count: 2, axis: "z", center: [0, 2, 0] });
    const bb = boundsOf(m)!;
    // Half a turn about a point two above: the copy lands two above that.
    expect(bb.max[1]).toBeCloseTo(4.5, 5);
  });
});

describe("arrayAlongPath", () => {
  const path: [number, number, number][] = [
    [0, 0, 0],
    [0, 0, 2],
    [0, 0, 6],
  ];

  it("test_copies_are_spaced_by_arc_length_not_by_segment", () => {
    // Three copies over a path whose two segments differ: the middle one sits
    // at distance 3, inside the long segment, not at the joint at 2.
    const m = arrayAlongPath(box(), path, { count: 3, follow: false });
    expect(vertCount(m)).toBe(24);
    let z = 0;
    for (let v = 8; v < 16; v++) z += vert(m, v)[2];
    expect(z / 8).toBeCloseTo(3, 5);
  });

  it("test_spacing_places_one_copy_per_step", () => {
    const m = arrayAlongPath(box(), path, { spacing: 2, follow: false });
    expect(vertCount(m)).toBe(8 * 4); // 0, 2, 4, 6
  });

  it("test_following_turns_the_copy_onto_the_path", () => {
    const tall = box({ size: [0.2, 0.2, 2] });
    const bent: [number, number, number][] = [[0, 0, 0], [4, 0, 0]];
    const m = arrayAlongPath(tall, bent, { count: 1 });
    // +z is along the path, so a mesh long in z comes out long in x.
    const bb = boundsOf(m)!;
    expect(bb.size[0]).toBeCloseTo(2, 5);
    expect(bb.size[2]).toBeCloseTo(0.2, 5);
  });

  it("test_twist_alternates_the_copies", () => {
    // What a chain needs: every other link turned a quarter turn.
    const flat = box({ size: [1, 0.1, 0.4] });
    const m = arrayAlongPath(flat, [[0, 0, 0], [0, 0, 3]], {
      count: 2,
      twistPerCopy: Math.PI / 2,
      follow: false,
    });
    const width = (from: number): number => {
      let min = Infinity, max = -Infinity;
      for (let v = from; v < from + 8; v++) {
        min = Math.min(min, vert(m, v)[0]);
        max = Math.max(max, vert(m, v)[0]);
      }
      return max - min;
    };
    expect(width(0)).toBeCloseTo(1, 5);
    expect(width(8)).toBeCloseTo(0.1, 5);
  });
});

describe("wireframe", () => {
  it("test_a_cube_becomes_forty_vertices_and_forty_eight_bars", () => {
    // Every count here was read off Blender first: two points per vertex, one
    // per face corner, four quads per edge side.
    const m = wireframe(box({ size: [1, 1, 1] }), { thickness: 0.1, boundary: false });
    expect(vertCount(m)).toBe(40);
    expect(m.polys).toHaveLength(48);
    for (const poly of m.polys) expect(poly).toHaveLength(4);
  });

  it("test_a_sheet_keeps_its_rim_only_with_boundary_on", () => {
    // 3x3 quads: 16 vertices, 24 edges, 12 of them on the border.
    const sheet = plane({ size: [3, 3], segments: [3, 3] });
    const open = wireframe(sheet, { thickness: 0.1, boundary: false });
    const closed = wireframe(sheet, { thickness: 0.1, boundary: true });
    // The border edges gain their outer half: one point per border vertex,
    // two quads per border edge.
    expect(vertCount(closed) - vertCount(open)).toBe(12);
    expect(closed.polys.length - open.polys.length).toBe(24);
  });

  it("test_the_bars_are_the_thickness_asked_for", () => {
    // A flat sheet wireframes into bars standing `thickness` tall, because the
    // two per-vertex points sit half that either side of the surface.
    const m = wireframe(plane({ size: [2, 2], segments: [2, 2] }), { thickness: 0.2 });
    const bb = boundsOf(m)!;
    expect(bb.size[1]).toBeCloseTo(0.2, 6);
  });

  it("test_the_middle_is_gone", () => {
    // The point of it: faces are replaced, not decorated. Nothing in the
    // output sits at the centre of what was a face.
    const m = wireframe(plane({ size: [2, 2], segments: [2, 2] }), { thickness: 0.1 });
    const centres = m.polys.map((poly) => {
      let x = 0, z = 0;
      for (const v of poly) {
        x += m.positions[v * 3]!;
        z += m.positions[v * 3 + 2]!;
      }
      return [x / poly.length, z / poly.length];
    });
    // (0.5, 0.5) is the middle of one of the four quads.
    for (const [x, z] of centres) expect(Math.hypot(x! - 0.5, z! - 0.5)).toBeGreaterThan(0.05);
  });
});

describe("maskMesh", () => {
  /**
   * Two quads sharing an edge: 0-1-4-3 and 1-2-5-4, on a row of six.
   *
   *   3---4---5
   *   |   |   |
   *   0---1---2
   */
  const strip = () => ({
    positions: new Float32Array([
      0, 0, 0, 1, 0, 0, 2, 0, 0,
      0, 1, 0, 1, 1, 0, 2, 1, 0,
    ]),
    polys: [
      [0, 1, 4, 3],
      [1, 2, 5, 4],
    ],
  });

  it("drops a polygon when any one of its vertices goes", () => {
    // Three corners of the left quad is not enough — measured on Blender,
    // where 9 vertices masked to 3 came back with no faces at all.
    const out = maskMesh(strip(), new Set([0, 1, 3]));
    expect(out.positions.length / 3).toBe(3);
    expect(out.polys).toEqual([]);
  });

  it("keeps a vertex whose polygons have all gone", () => {
    // The loose-vertex half of the same rule. Blender does not sweep them up
    // and neither does this; `deleteLoose` is the operator for that.
    const out = maskMesh(strip(), new Set([0, 1, 3]));
    expect(out.positions.length / 3).toBe(3);
    expect(deleteLoose(out).positions.length / 3).toBe(0);
  });

  it("renumbers in the original order", () => {
    const out = maskMesh(strip(), new Set([1, 2, 4, 5]));
    expect(out.polys).toEqual([[0, 1, 3, 2]]); // was [1, 2, 5, 4]
    expect([...out.positions.slice(0, 3)]).toEqual([1, 0, 0]);
  });

  it("keeps a vertex only when its weight is strictly above the threshold", () => {
    // Measured: weight 0.5 against threshold 0.5 is dropped, and 0.4 against
    // 0.3 is kept. A `>=` here would pass the second and fail the first.
    const all = new Map([0, 1, 2, 3, 4, 5].map((v) => [v, 0.5] as const));
    expect(maskMesh(strip(), all).positions.length / 3).toBe(0);
    const lower = new Map([0, 1, 2, 3, 4, 5].map((v) => [v, 0.4] as const));
    expect(maskMesh(strip(), lower, { threshold: 0.3 }).positions.length / 3).toBe(6);
  });

  it("inverts the test, not the weight", () => {
    // The one that separates the two readings: at weight 0.6 against a
    // threshold of 0.3, inverting the **test** drops everything, while
    // inverting the *weight* would keep it all (1 − 0.6 is still above 0.3).
    // Blender drops it — measured in probe-face-add3.py.
    const w = new Map([0, 1, 2, 3, 4, 5].map((v) => [v, 0.6] as const));
    expect(maskMesh(strip(), w, { threshold: 0.3, invert: true }).positions.length / 3).toBe(0);
    expect(maskMesh(strip(), w, { threshold: 0.3 }).positions.length / 3).toBe(6);
  });

  it("treats a vertex nobody mentions as weight 0", () => {
    const out = maskMesh(strip(), new Map([[0, 1]]), { invert: true });
    expect(out.positions.length / 3).toBe(5); // everything but vertex 0
  });

  it("carries creases and seams through the renumbering", () => {
    // `deleteLoose` renumbered and then handed back the **old** seam set until
    // 2026-09-21; nothing in the parity harness compares seams, so this is the
    // only thing that catches it.
    const out = maskMesh(
      { ...strip(), creases: new Map([["1_4", 1]]), seams: new Set(["4_5"]) },
      new Set([1, 2, 4, 5]),
    );
    // 1→0, 2→1, 4→2, 5→3.
    expect([...out.creases!]).toEqual([["0_2", 1]]);
    expect([...out.seams!]).toEqual(["2_3"]);
  });

  it("drops a crease whose edge did not survive", () => {
    const out = maskMesh(
      { ...strip(), creases: new Map([["0_1", 1], ["1_4", 0.5]]) },
      new Set([1, 2, 4, 5]),
    );
    expect([...out.creases!]).toEqual([["0_2", 0.5]]);
  });
});

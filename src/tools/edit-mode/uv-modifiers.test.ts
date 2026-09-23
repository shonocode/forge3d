import { describe, it, expect } from "vitest";
import type { MeshData } from "../../lib/mesh";
import { uvProject, uvWarp } from "./uv-modifiers";

/**
 * `uvProject` and `uvWarp`, against Blender 5.1.1.
 *
 * Every number is measured — `probe-uv-modifiers.py`,
 * `probe-uv-modifiers2.py` and `probe-uv-project-choice.py`. The third exists
 * because the second **could not read the multi-projector choice**: it used two
 * projectors whose answers happened to agree at the corners it printed, so the
 * choice was invisible. Giving each projector its own translation made every
 * face's answer name its projector.
 *
 * The rule that came out of that is also the one place here where the source
 * had to be read: the per-face test uses the projector's **+Z** axis, not the
 * −Z a camera looks along, which is why the measurement looked like
 * "the perpendicular projector always wins".
 */

/** The 2×2 grid the probes use: the z = 0 plane, corners at ±0.5. */
function grid(): MeshData {
  const positions: number[] = [];
  for (let j = 0; j <= 2; j++)
    for (let i = 0; i <= 2; i++) positions.push(i / 2 - 0.5, j / 2 - 0.5, 0);
  const polys: number[][] = [];
  for (let j = 0; j < 2; j++)
    for (let i = 0; i < 2; i++) {
      const a = j * 3 + i;
      polys.push([a, a + 1, a + 4, a + 3]);
    }
  return { positions: Float32Array.from(positions), polys };
}

/**
 * A fresh UV layer as Blender's `uv_layers.new()` fills it: 0..1 per face.
 * Measured — both modifiers were run on exactly this, and `uvWarp` with
 * nothing set returns it unchanged.
 */
function withUVs(data: MeshData): MeshData {
  return {
    ...data,
    uvs: data.polys.map(() => [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]),
  };
}

/** The unit cube, faces in the order the probes printed: -z, +z, -y, +x, +y, -x. */
function cube(): MeshData {
  return {
    positions: Float32Array.from([
      -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5,
      -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
    ]),
    polys: [
      [0, 3, 2, 1],
      [4, 5, 6, 7],
      [0, 1, 5, 4],
      [1, 2, 6, 5],
      [2, 3, 7, 6],
      [3, 0, 4, 7],
    ],
  };
}

function expectUV(got: readonly number[] | undefined, want: readonly number[], why?: string): void {
  expect(got, why).toBeDefined();
  expect(got![0]!, `${why ?? ""} u`).toBeCloseTo(want[0]!, 5);
  expect(got![1]!, `${why ?? ""} v`).toBeCloseTo(want[1]!, 5);
}

/** The corner of `face` that sits on vertex `v`. */
function corner(data: MeshData, face: number, v: number): number[] {
  const i = data.polys[face]!.indexOf(v);
  expect(i, `face ${face} has no vertex ${v}`).toBeGreaterThanOrEqual(0);
  return data.uvs![face]![i]!;
}

describe("uvProject", () => {
  it("halves and centres the point in the projector's space", () => {
    // Blender, projector at the origin with no rotation: vertex 0 at
    // (-0.5, -0.5, 0) reads (0.25, 0.25) and vertex 4 at the centre reads
    // (0.5, 0.5). So uv = p/2 + 0.5, which is the whole rule.
    const out = uvProject(grid(), { projectors: [{}] });
    expectUV(corner(out, 0, 0), [0.25, 0.25], "vertex 0");
    expectUV(corner(out, 0, 1), [0.5, 0.25], "vertex 1");
    expectUV(corner(out, 0, 4), [0.5, 0.5], "vertex 4");
    expectUV(corner(out, 0, 3), [0.25, 0.5], "vertex 3");
  });

  it("reads the projector's position, scale and rotation", () => {
    // Three measurements. The third is the one worth having: moving the
    // projector along its **own z** changes nothing, because an empty
    // projects orthographically and the z coordinate is dropped.
    expectUV(
      corner(uvProject(grid(), { projectors: [{ at: [0.25, 0, 0] }] }), 0, 0),
      [0.125, 0.25],
      "moved",
    );
    expectUV(
      corner(uvProject(grid(), { projectors: [{ scale: 2 }] }), 0, 0),
      [0.375, 0.375],
      "scaled",
    );
    expectUV(
      corner(uvProject(grid(), { projectors: [{ at: [0, 0, 3] }] }), 0, 0),
      [0.25, 0.25],
      "moved along its own z",
    );
  });

  it("projects along the rotated axis", () => {
    // Projector turned 90 degrees about x, so the mesh's y becomes its -z and
    // is dropped: every corner of the grid lands on v = 0.5.
    const out = uvProject(grid(), { projectors: [{ rotate: [Math.PI / 2, 0, 0] }] });
    expectUV(corner(out, 0, 0), [0.25, 0.5], "vertex 0");
    expectUV(corner(out, 0, 1), [0.5, 0.5], "vertex 1");
    expectUV(corner(out, 0, 4), [0.5, 0.5], "vertex 4");
    expectUV(corner(out, 0, 3), [0.25, 0.5], "vertex 3");
  });

  it("picks the projector whose +z best agrees with the face normal", () => {
    // **The rule that had to be read from `MOD_uvproject.cc`.** Measured on a
    // cube with two projectors given distinct translations so their answers
    // differ: face 0 (normal -z) takes the x-facing projector, faces 2 and 5
    // take the z one. A −Z reading of "forward" gets all three backwards.
    const out = uvProject(cube(), {
      projectors: [{}, { at: [0.3, 0, 0], rotate: [0, Math.PI / 2, 0] }],
    });
    expectUV(corner(out, 0, 0), [0.75, 0.25], "face 0 takes px");
    expectUV(corner(out, 2, 0), [0.25, 0.25], "face 2 keeps pz");
    expectUV(corner(out, 5, 3), [0.25, 0.75], "face 5 keeps pz");
  });

  it("keeps the earlier projector when the dot products tie", () => {
    // Measured with three projectors along -z, -x and -y. Face 5's normal is
    // (-1, 0, 0), which is perpendicular to both the z and y projectors'
    // axes — a tie, and Blender's loop compares with a strict `>`, so the
    // first of them wins. Face 2 ties between the z and x projectors the same
    // way.
    const out = uvProject(cube(), {
      projectors: [
        {},
        { at: [0.3, 0, 0], rotate: [0, Math.PI / 2, 0] },
        { at: [0, 0.7, 0], rotate: [-Math.PI / 2, 0, 0] },
      ],
    });
    expectUV(corner(out, 5, 3), [0.25, 0.75], "face 5 ties, keeps the first");
    expectUV(corner(out, 2, 0), [0.25, 0.25], "face 2 ties, keeps the first");
    expectUV(corner(out, 0, 0), [0.75, 0.25], "face 0 ties between px and py");
  });

  it("gives every face the same projector when they all point one way", () => {
    // Measured: two projectors with the same rotation and different positions
    // tie on every face, so the nearer-listed one takes all six.
    const out = uvProject(cube(), {
      projectors: [{ at: [0, 0, 1] }, { at: [0.4, 0, 5] }],
    });
    const alone = uvProject(cube(), { projectors: [{ at: [0, 0, 1] }] });
    expect(out.uvs).toEqual(alone.uvs);
  });

  it("moves nothing and needs no UV layer to start with", () => {
    const before = grid();
    const out = uvProject(before, { projectors: [{}] });
    expect([...out.positions]).toEqual([...before.positions]);
    expect(out.polys).toEqual(before.polys);
    expect(out.uvs).toHaveLength(before.polys.length);
  });

  it("refuses an empty projector list", () => {
    expect(() => uvProject(grid(), { projectors: [] })).toThrow(/at least one/);
  });
});

describe("uvWarp", () => {
  it("does nothing when nothing is asked for", () => {
    const out = uvWarp(withUVs(grid()));
    expectUV(out.uvs![0]![0]!, [0, 0]);
    expectUV(out.uvs![0]![1]!, [1, 0]);
    expectUV(out.uvs![0]![2]!, [1, 1]);
    expectUV(out.uvs![0]![3]!, [0, 1]);
  });

  it("adds the offset", () => {
    const out = uvWarp(withUVs(grid()), { offset: [0.25, 0] });
    expectUV(out.uvs![0]![0]!, [0.25, 0]);
    expectUV(out.uvs![0]![1]!, [1.25, 0]);
  });

  it("scales about (0.5, 0.5) by default", () => {
    // Which is how the default centre was measured: a scale of 2 sends (0, 0)
    // to (-0.5, 0), not to (0, 0).
    const out = uvWarp(withUVs(grid()), { scale: [2, 1] });
    expectUV(out.uvs![0]![0]!, [-0.5, 0]);
    expectUV(out.uvs![0]![1]!, [1.5, 0]);
    const both = uvWarp(withUVs(grid()), { scale: [2, 3] });
    expectUV(both.uvs![0]![0]!, [-0.5, -1]);
  });

  it("rotates about the same centre", () => {
    const out = uvWarp(withUVs(grid()), { rotation: Math.PI / 2 });
    expectUV(out.uvs![0]![0]!, [1, 0]);
    expectUV(out.uvs![0]![1]!, [1, 1]);
    // Asking for the default centre explicitly changes nothing — which is how
    // (0.5, 0.5) was confirmed rather than inferred.
    const same = uvWarp(withUVs(grid()), { rotation: Math.PI / 2, center: [0.5, 0.5] });
    expect(same.uvs).toEqual(out.uvs);
  });

  it("offsets first, then rotates, then scales", () => {
    // **The composition order, and the case that pins it.** With all three
    // set Blender gives (1.5, 0.25) and (1.5, 1.25). Offsetting afterwards
    // gives (1.75, 0); scaling before rotating sends the two corners two
    // apart instead of one.
    const out = uvWarp(withUVs(grid()), {
      offset: [0.25, 0],
      scale: [2, 1],
      rotation: Math.PI / 2,
    });
    expectUV(out.uvs![0]![0]!, [1.5, 0.25], "corner (0,0)");
    expectUV(out.uvs![0]![1]!, [1.5, 1.25], "corner (1,0)");
  });

  it("applies the object pair as inverse(to) then from", () => {
    // Three measurements: a `to` moved, rotated and scaled. The direction is
    // the point — moving `to` by +0.25 in x moves the UVs by -0.25 in u.
    expectUV(
      uvWarp(withUVs(grid()), { from: {}, to: { at: [0.25, 0, 0] } }).uvs![0]![0]!,
      [-0.25, 0],
      "translated",
    );
    expectUV(
      uvWarp(withUVs(grid()), { from: {}, to: { at: [0, 0, 0.25] } }).uvs![0]![0]!,
      [0, 0],
      "translated along an axis neither u nor v rides",
    );
    const turned = uvWarp(withUVs(grid()), {
      from: {},
      to: { rotate: [0, 0, Math.PI / 2] },
    });
    expectUV(turned.uvs![0]![0]!, [0, 1], "rotated");
    expectUV(turned.uvs![0]![1]!, [0, 0], "rotated");
    expectUV(
      uvWarp(withUVs(grid()), { from: {}, to: { scale: 2 } }).uvs![0]![0]!,
      [0.25, 0.25],
      "scaled",
    );
  });

  it("turns the UVs the opposite way from an explicit rotation", () => {
    // Measured side by side with centre (0, 0): a `to` rotated by +90 degrees
    // sends (1, 0) to (0, -1), while `rotation: +90 degrees` sends it to
    // (0, 1). That is the inverse showing.
    const byPair = uvWarp(withUVs(grid()), {
      center: [0, 0],
      from: {},
      to: { rotate: [0, 0, Math.PI / 2] },
    });
    const byRotation = uvWarp(withUVs(grid()), { center: [0, 0], rotation: Math.PI / 2 });
    expectUV(byPair.uvs![0]![1]!, [0, -1], "pair");
    expectUV(byRotation.uvs![0]![1]!, [0, 1], "rotation");
  });

  it("ignores a pair with only one half set", () => {
    // Measured both ways round: Blender leaves the UVs alone.
    const from = uvWarp(withUVs(grid()), { from: { at: [0.25, 0, 0] } });
    const to = uvWarp(withUVs(grid()), { to: { at: [0.25, 0, 0] } });
    expectUV(from.uvs![0]![0]!, [0, 0]);
    expectUV(from.uvs![0]![1]!, [1, 0]);
    expect(to.uvs).toEqual(from.uvs);
  });

  it("reads axisU and axisV as which plane the pair acts in", () => {
    // Measured with `to` at (0.25, 0.5, 0.75) — three different numbers, so
    // each combination names itself. Five of them.
    const pair = { from: {}, to: { at: [0.25, 0.5, 0.75] } } as const;
    const cases: [("x" | "y" | "z"), ("x" | "y" | "z"), [number, number]][] = [
      ["x", "y", [-0.25, -0.5]],
      ["y", "x", [-0.5, -0.25]],
      ["x", "z", [-0.25, -0.75]],
      ["z", "y", [-0.75, -0.5]],
      ["y", "z", [-0.5, -0.75]],
    ];
    for (const [axisU, axisV, want] of cases)
      expectUV(
        uvWarp(withUVs(grid()), { ...pair, axisU, axisV }).uvs![0]![0]!,
        want,
        `axisU ${axisU} axisV ${axisV}`,
      );
  });

  it("puts the pair after the offset, rotation and scale", () => {
    // Measured with `to` translated 0.25 in x and each of the three in turn,
    // then all together.
    const pair = { from: {}, to: { at: [0.25, 0, 0] } } as const;
    expectUV(uvWarp(withUVs(grid()), pair).uvs![0]![0]!, [-0.25, 0], "pair alone");
    expectUV(
      uvWarp(withUVs(grid()), { ...pair, offset: [0.25, 0] }).uvs![0]![0]!,
      [0, 0],
      "with offset",
    );
    const turned = uvWarp(withUVs(grid()), { ...pair, rotation: Math.PI / 2 });
    expectUV(turned.uvs![0]![0]!, [0.75, 0], "with rotation");
    expectUV(turned.uvs![0]![1]!, [0.75, 1], "with rotation");
    const scaled = uvWarp(withUVs(grid()), { ...pair, scale: [2, 1] });
    expectUV(scaled.uvs![0]![0]!, [-0.75, 0], "with scale");
    expectUV(scaled.uvs![0]![1]!, [1.25, 0], "with scale");
    const all = uvWarp(withUVs(grid()), {
      ...pair,
      offset: [0.25, 0],
      rotation: Math.PI / 2,
      scale: [2, 1],
    });
    expectUV(all.uvs![0]![0]!, [1.25, 0.25], "all four");
    expectUV(all.uvs![0]![1]!, [1.25, 1.25], "all four");
  });

  it("leaves a mesh with no UV layer alone", () => {
    const out = uvWarp(grid(), { offset: [0.25, 0] });
    expect(out.uvs).toBeUndefined();
    expect([...out.positions]).toEqual([...grid().positions]);
  });

  it("moves no vertex", () => {
    const before = withUVs(grid());
    const out = uvWarp(before, { rotation: 1, scale: [2, 3], offset: [0.1, 0.2] });
    expect([...out.positions]).toEqual([...before.positions]);
    expect(out.polys).toEqual(before.polys);
  });
});

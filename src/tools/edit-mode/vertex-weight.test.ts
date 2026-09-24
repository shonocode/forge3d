import { describe, it, expect } from "vitest";
import type { MeshData } from "../../lib/mesh";
import { vertexWeightEdit, vertexWeightMix, vertexWeightProximity } from "./vertex-weight";

/**
 * The three `VERTEX_WEIGHT_*` modifiers, against Blender 5.1.1.
 *
 * Every number is measured — `probe-vertex-weight.py`, `probe-vertex-weight2.py`
 * and `probe-vertex-weight3.py`. **The second exists because two of the first
 * probe's cases could not tell the candidates apart**, and the third because
 * two boundaries needed a case sitting exactly on them:
 *
 *   * `add_threshold` looked inert at four values, because every vertex of
 *     that input was already a member and there was nothing to add;
 *   * `mix_set` gave one answer for all five of its values, for the same
 *     reason — the five only differ over vertices that are in one group and
 *     not the other;
 *   * `add_threshold` and `remove_threshold` are `>=` and `<=`, which only a
 *     case *at* the threshold can say.
 *
 * That is the "does this case separate the candidates?" question, and this
 * time it was asked before the parity rows rather than after.
 */

/** The strip the probes use: 5 columns along x at 0, 0.25, 0.5, 0.75, 1. */
function strip(): MeshData {
  const positions: number[] = [];
  for (let i = 0; i < 5; i++) {
    positions.push(i / 4, 0, 0);
    positions.push(i / 4, 0, 0.2);
  }
  const polys: number[][] = [];
  for (let i = 0; i < 4; i++) polys.push([i * 2, i * 2 + 1, i * 2 + 3, i * 2 + 2]);
  return { positions: Float32Array.from(positions), polys };
}

function withGroups(entries: Record<string, Record<number, number>>): MeshData {
  const groups = new Map<string, Map<number, number>>();
  for (const [name, ws] of Object.entries(entries))
    groups.set(name, new Map(Object.entries(ws).map(([v, w]) => [Number(v), w])));
  return { ...strip(), groups };
}

/** The group's weights at the even vertices, `null` where absent. */
function evens(data: MeshData, name = "A"): (number | null)[] {
  const g = data.groups!.get(name)!;
  return [0, 2, 4, 6, 8].map((v) => (g.has(v) ? g.get(v)! : null));
}

function expectWeights(
  got: (number | null)[],
  want: (number | null)[],
  why?: string,
): void {
  expect(got.length, `${why ?? ""} length`).toBe(want.length);
  for (let i = 0; i < want.length; i++) {
    if (want[i] === null) expect(got[i], `${why ?? ""} slot ${i} should be absent`).toBeNull();
    else {
      expect(got[i], `${why ?? ""} slot ${i} should be present`).not.toBeNull();
      expect(got[i]!, `${why ?? ""} slot ${i}`).toBeCloseTo(want[i]!, 5);
    }
  }
}

/** The ramp from the first probe: 0, 0.25, 0.5, 0.75, 1 down the strip. */
const RAMP = { 0: 0, 1: 0, 2: 0.25, 3: 0.25, 4: 0.5, 5: 0.5, 6: 0.75, 7: 0.75, 8: 1, 9: 1 };

/**
 * The layout that tells `mix_set` apart: vertex 0 in A only, 2 in both, 4 in B
 * only, 6 in neither, 8 in both.
 */
const A_ONLY = { 0: 0.2, 1: 0.2, 2: 0.4, 3: 0.4, 8: 0.9, 9: 0.9 };
const B_ONLY = { 2: 0.6, 3: 0.6, 4: 0.8, 5: 0.8, 8: 0.1, 9: 0.1 };

describe("vertexWeightEdit", () => {
  it("maps the weight through each falloff curve", () => {
    // Blender, on the ramp. The first five are `falloffWeight`'s own table,
    // confirmed a second time through this modifier; `step` is the one it
    // does not have.
    const cases: [Parameters<typeof vertexWeightEdit>[1]["falloff"], number[]][] = [
      ["linear", [0, 0.25, 0.5, 0.75, 1]],
      ["sharp", [0, 0.0625, 0.25, 0.5625, 1]],
      ["smooth", [0, 0.15625, 0.5, 0.84375, 1]],
      ["root", [0, 0.5, 0.707107, 0.866025, 1]],
      ["sphere", [0, 0.661438, 0.866025, 0.968246, 1]],
      ["step", [0, 0, 1, 1, 1]],
    ];
    for (const [falloff, want] of cases)
      expectWeights(evens(vertexWeightEdit(withGroups({ A: RAMP }), { group: "A", falloff })), want, `${falloff}`);
  });

  it("inverts the curve's output, not its input", () => {
    // The two readings agree for `linear` and differ everywhere else, so
    // `sharp` is the case: measured 0.9375 at 0.25, which is 1 − 0.0625.
    // `curve(1 − w)` would give 0.5625.
    expectWeights(
      evens(vertexWeightEdit(withGroups({ A: RAMP }), { group: "A", invertFalloff: true })),
      [1, 0.75, 0.5, 0.25, 0],
      "linear",
    );
    expectWeights(
      evens(
        vertexWeightEdit(withGroups({ A: RAMP }), {
          group: "A",
          falloff: "sharp",
          invertFalloff: true,
        }),
      ),
      [1, 0.9375, 0.75, 0.4375, 0],
      "sharp",
    );
  });

  it("leaves non-members out unless add is on", () => {
    // Measured at three default weights: without `use_add` the vertices
    // outside the group stay outside and `default_weight` never shows.
    const only = { 2: 0.25, 3: 0.25, 4: 0.5, 5: 0.5 };
    for (const defaultWeight of [0, 0.3, 1])
      expectWeights(
        evens(vertexWeightEdit(withGroups({ A: only }), { group: "A", defaultWeight })),
        [null, 0.25, 0.5, null, null],
        `default ${defaultWeight}`,
      );
    expectWeights(
      evens(
        vertexWeightEdit(withGroups({ A: only }), {
          group: "A",
          defaultWeight: 0.3,
          add: true,
          addThreshold: 0,
        }),
      ),
      [0.3, 0.25, 0.5, 0.3, 0.3],
      "with add",
    );
  });

  it("adds a non-member at or above the threshold", () => {
    // **The boundary, and it needed its own probe.** A candidate of 0.3 joins
    // at 0.29 and at 0.30, and does not at 0.31 — so `>=`.
    const one = { 0: 0.2, 1: 0.2 };
    for (const [threshold, joins] of [
      [0.29, true],
      [0.3, true],
      [0.31, false],
    ] as [number, boolean][])
      expectWeights(
        evens(
          vertexWeightEdit(withGroups({ A: one }), {
            group: "A",
            defaultWeight: 0.3,
            add: true,
            addThreshold: threshold,
          }),
        ),
        [0.2, joins ? 0.3 : null, joins ? 0.3 : null, joins ? 0.3 : null, joins ? 0.3 : null],
        `threshold ${threshold}`,
      );
  });

  it("removes a member at or below the threshold", () => {
    // The other boundary: 0.4 survives 0.39 and is dropped at 0.40.
    for (const [threshold, kept] of [
      [0.39, true],
      [0.4, false],
      [0.41, false],
    ] as [number, boolean][]) {
      const out = vertexWeightEdit(withGroups({ A: { 0: 0.4, 1: 0.4 } }), {
        group: "A",
        remove: true,
        removeThreshold: threshold,
      });
      expectWeights(evens(out), [kept ? 0.4 : null, null, null, null, null], `threshold ${threshold}`);
    }
    // And across the ramp, at four thresholds.
    const ramp: [number, (number | null)[]][] = [
      [0, [null, 0.25, 0.5, 0.75, 1]],
      [0.3, [null, null, 0.5, 0.75, 1]],
      [0.6, [null, null, null, 0.75, 1]],
      [1, [null, null, null, null, null]],
    ];
    for (const [threshold, want] of ramp)
      expectWeights(
        evens(
          vertexWeightEdit(withGroups({ A: RAMP }), {
            group: "A",
            remove: true,
            removeThreshold: threshold,
          }),
        ),
        want,
        `ramp at ${threshold}`,
      );
  });

  it("reads maskConstant as a lerp from the original", () => {
    // Measured at three values with the `sharp` curve.
    const cases: [number, number[]][] = [
      [0, [0, 0.25, 0.5, 0.75, 1]],
      [0.5, [0, 0.15625, 0.375, 0.65625, 1]],
      [1, [0, 0.0625, 0.25, 0.5625, 1]],
    ];
    for (const [maskConstant, want] of cases)
      expectWeights(
        evens(
          vertexWeightEdit(withGroups({ A: RAMP }), {
            group: "A",
            falloff: "sharp",
            maskConstant,
          }),
        ),
        want,
        `mask ${maskConstant}`,
      );
  });

  it("normalizes by the largest weight in the group", () => {
    // Measured: the `sharp` curve of 0.2, 0.4, 0.9 gives 0.04, 0.16, 0.81,
    // and normalizing sends 0.81 to 1 and 0.04 to 0.049383.
    expectWeights(
      evens(vertexWeightEdit(withGroups({ A: A_ONLY }), { group: "A", falloff: "sharp" })),
      [0.04, 0.16, null, null, 0.81],
      "not normalized",
    );
    expectWeights(
      evens(
        vertexWeightEdit(withGroups({ A: A_ONLY }), {
          group: "A",
          falloff: "sharp",
          normalize: true,
        }),
      ),
      [0.049383, 0.197531, null, null, 1],
      "normalized",
    );
  });

  it("refuses a group that is not there, and moves nothing", () => {
    expect(() => vertexWeightEdit(withGroups({ A: RAMP }), { group: "B" })).toThrow(/no vertex group/);
    const before = withGroups({ A: RAMP });
    const out = vertexWeightEdit(before, { group: "A", falloff: "sharp" });
    expect([...out.positions]).toEqual([...before.positions]);
    expect(out.polys).toEqual(before.polys);
  });
});

describe("vertexWeightMix", () => {
  it("combines the two groups nine ways", () => {
    // Blender, with A the ramp and B [1, 0.5, 0, absent, absent] under
    // `mixSet: "all"` and both defaults 0 — so B reads as [1, 0.5, 0, 0, 0].
    // The clamp shows in `add` and `sub`.
    const B = { 0: 1, 1: 1, 2: 0.5, 3: 0.5, 4: 0, 5: 0 };
    const cases: [Parameters<typeof vertexWeightMix>[1]["mixMode"], number[]][] = [
      ["set", [1, 0.5, 0, 0, 0]],
      ["add", [1, 0.75, 0.5, 0.75, 1]],
      ["sub", [0, 0, 0.5, 0.75, 1]],
      ["mul", [0, 0.125, 0, 0, 0]],
      ["div", [0, 0.5, 1, 1, 1]],
      ["dif", [1, 0.25, 0.5, 0.75, 1]],
      ["avg", [0.5, 0.375, 0.25, 0.375, 0.5]],
      ["min", [0, 0.25, 0, 0, 0]],
      ["max", [1, 0.5, 0.5, 0.75, 1]],
    ];
    for (const [mixMode, want] of cases)
      expectWeights(
        evens(
          vertexWeightMix(withGroups({ A: RAMP, B }), {
            groupA: "A",
            groupB: "B",
            mixMode,
            mixSet: "all",
          }),
        ),
        want,
        `${mixMode}`,
      );
  });

  it("reads mixSet as which vertices it may touch", () => {
    // **The five values needed their own input.** On the first probe every
    // vertex was in A and all five agreed. Here vertex 0 is in A only, 2 in
    // both, 4 in B only, 6 in neither and 8 in both.
    const cases: [Parameters<typeof vertexWeightMix>[1]["mixSet"], (number | null)[]][] = [
      ["all", [0.2, 1, 0.8, 0, 1]],
      ["a", [0.2, 1, null, null, 1]],
      ["b", [0.2, 1, 0.8, null, 1]],
      ["or", [0.2, 1, 0.8, null, 1]],
      ["and", [0.2, 1, null, null, 1]],
    ];
    for (const [mixSet, want] of cases)
      expectWeights(
        evens(
          vertexWeightMix(withGroups({ A: A_ONLY, B: B_ONLY }), {
            groupA: "A",
            groupB: "B",
            mixMode: "add",
            mixSet,
          }),
        ),
        want,
        `${mixSet}`,
      );
  });

  it("uses the default weight where a vertex is missing from a group", () => {
    // Measured at three pairs, with A short at one end and B at the other.
    const A = { 2: 0.25, 3: 0.25, 4: 0.5, 5: 0.5 };
    const B = { 4: 0.5, 5: 0.5, 6: 0.75, 7: 0.75 };
    const cases: [number, number, number[]][] = [
      [0, 0, [0, 0.25, 1, 0.75, 0]],
      [0, 1, [1, 1, 1, 0.75, 1]],
      [0.7, 0.2, [0.9, 0.45, 1, 1, 0.9]],
    ];
    for (const [defaultWeightA, defaultWeightB, want] of cases)
      expectWeights(
        evens(
          vertexWeightMix(withGroups({ A, B }), {
            groupA: "A",
            groupB: "B",
            mixMode: "add",
            mixSet: "all",
            defaultWeightA,
            defaultWeightB,
          }),
        ),
        want,
        `a=${defaultWeightA} b=${defaultWeightB}`,
      );
  });

  it("clamps after the mask, not before", () => {
    // **The parity rows caught this; these probes could not.** Without a
    // clamp the two readings are the same thing — `lerp(a, a + b, m)` *is*
    // `a + m·b` — so every case whose sum stays inside 0..1 agrees with both.
    // These numbers come off `arm`, where the sum goes above 1.
    const out = vertexWeightMix(
      { ...strip(), groups: new Map([["A", new Map([[0, 0.249557]])], ["B", new Map([[0, 1]])]]) },
      { groupA: "A", groupB: "B", mixMode: "add", mixSet: "all", maskConstant: 0.75 },
    );
    expect(out.groups!.get("A")!.get(0)!, "clamped after").toBeCloseTo(0.999557, 5);
    // The other order would give 0.812389, which is what the first
    // implementation returned.
    expect(out.groups!.get("A")!.get(0)!).not.toBeCloseTo(0.812389, 4);

    // And where the sum stays under 1 the two agree, which is why no probe
    // could separate them: a = 0.4, b = 0.6 at m = 0.75 is 0.85 either way.
    const inside = vertexWeightMix(
      { ...strip(), groups: new Map([["A", new Map([[0, 0.4]])], ["B", new Map([[0, 0.6]])]]) },
      { groupA: "A", groupB: "B", mixMode: "add", mixSet: "all", maskConstant: 0.75 },
    );
    expect(inside.groups!.get("A")!.get(0)!).toBeCloseTo(0.85, 6);
  });

  it("reads maskConstant as a lerp, from the default where A has no weight", () => {
    // Measured. The interesting slot is vertex 4, which is in B only: at
    // maskConstant 0 it still joins, at the value `defaultWeightA` gives.
    const cases: [number, (number | null)[]][] = [
      [0, [0.2, 0.4, 0, 0, 0.9]],
      [0.5, [0.2, 0.7, 0.4, 0, 0.95]],
      [1, [0.2, 1, 0.8, 0, 1]],
    ];
    for (const [maskConstant, want] of cases)
      expectWeights(
        evens(
          vertexWeightMix(withGroups({ A: A_ONLY, B: B_ONLY }), {
            groupA: "A",
            groupB: "B",
            mixMode: "add",
            mixSet: "all",
            maskConstant,
          }),
        ),
        want,
        `mask ${maskConstant}`,
      );
  });

  it("works with no second group, which is then all default", () => {
    expectWeights(
      evens(
        vertexWeightMix(withGroups({ A: RAMP }), {
          groupA: "A",
          mixMode: "add",
          mixSet: "all",
          defaultWeightB: 0.25,
        }),
      ),
      [0.25, 0.5, 0.75, 1, 1],
      "b defaults to 0.25 everywhere",
    );
  });
});

describe("vertexWeightProximity", () => {
  /** The target from the third probe: a quad at x = 1.5, corners at ±0.5. */
  function standingQuad(): MeshData {
    return {
      positions: Float32Array.from([
        1.5, -0.5, -0.5, 1.5, 0.5, -0.5, 1.5, 0.5, 0.5, 1.5, -0.5, 0.5,
      ]),
      polys: [[0, 1, 2, 3]],
    };
  }

  const ALL_ONE = Object.fromEntries([...Array(10).keys()].map((i) => [i, 1]));

  it("measures to a vertex, an edge or a face, and they differ", () => {
    // **The case is chosen so the three cannot agree.** The quad stands at
    // x = 1.5 with its corners at y, z = ±0.5, and the strip runs along
    // y = z = 0 — so from x = 0 the face is 1.5 away, the nearest edge
    // sqrt(2.5), and the nearest corner sqrt(2.75). At maxDist 2 those come
    // back as 0.75, 0.790569 and 0.829156.
    const cases: [Parameters<typeof vertexWeightProximity>[1]["geometry"], number[]][] = [
      [["vertex"], [0.829156, 0.71807, 0.612372, 0.515388, 0.433013]],
      [["edge"], [0.790569, 0.673146, 0.559017, 0.450694, 0.353553]],
      [["face"], [0.75, 0.625, 0.5, 0.375, 0.25]],
    ];
    for (const [geometry, want] of cases)
      expectWeights(
        evens(
          vertexWeightProximity(withGroups({ A: ALL_ONE }), {
            group: "A",
            target: standingQuad(),
            geometry,
            maxDist: 2,
          }),
        ),
        want,
        `${geometry}`,
      );
  });

  it("takes the minimum when several kinds are asked for", () => {
    // Measured: vertex and face together give the face answer, it being the
    // nearer of the two on this shape.
    expectWeights(
      evens(
        vertexWeightProximity(withGroups({ A: ALL_ONE }), {
          group: "A",
          target: standingQuad(),
          geometry: ["vertex", "face"],
          maxDist: 2,
        }),
      ),
      [0.75, 0.625, 0.5, 0.375, 0.25],
    );
  });

  it("falls back to the distance to a point when no kind is asked for", () => {
    // Measured: with no `proximity_geometry` flag Blender measures each
    // vertex to the target's origin — the strip's own x coordinates came
    // straight back at maxDist 2.
    expectWeights(
      evens(
        vertexWeightProximity(withGroups({ A: ALL_ONE }), {
          group: "A",
          geometry: [],
          maxDist: 2,
        }),
      ),
      [0, 0.125, 0.25, 0.375, 0.5],
      "origin at 0",
    );
    expectWeights(
      evens(
        vertexWeightProximity(withGroups({ A: ALL_ONE }), {
          group: "A",
          geometry: [],
          origin: [1, 0, 0],
          maxDist: 2,
        }),
      ),
      [0.5, 0.375, 0.25, 0.125, 0],
      "origin at x = 1",
    );
  });

  it("inverts the ramp when minDist is above maxDist", () => {
    // Measured rather than treated as an error: min 1, max 0 turns a
    // distance of 0 into a weight of 1.
    expectWeights(
      evens(
        vertexWeightProximity(withGroups({ A: ALL_ONE }), {
          group: "A",
          geometry: [],
          minDist: 1,
          maxDist: 0,
        }),
      ),
      [1, 0.75, 0.5, 0.25, 0],
    );
  });

  it("clamps outside the band and shapes the inside with the falloff", () => {
    // min 0.25 max 0.75 over distances 0, 0.25, 0.5, 0.75, 1.
    expectWeights(
      evens(
        vertexWeightProximity(withGroups({ A: ALL_ONE }), {
          group: "A",
          geometry: [],
          minDist: 0.25,
          maxDist: 0.75,
        }),
      ),
      [0, 0, 0.5, 1, 1],
      "linear",
    );
    expectWeights(
      evens(
        vertexWeightProximity(withGroups({ A: ALL_ONE }), {
          group: "A",
          geometry: [],
          minDist: 0.25,
          maxDist: 0.75,
          falloff: "sharp",
        }),
      ),
      [0, 0, 0.25, 1, 1],
      "sharp",
    );
  });

  it("only writes the vertices already in the group", () => {
    // Blender's proximity modifier reshapes a group; it does not recruit.
    const out = vertexWeightProximity(withGroups({ A: { 2: 1, 4: 1 } }), {
      group: "A",
      geometry: [],
      maxDist: 2,
    });
    expectWeights(evens(out), [null, 0.125, 0.25, null, null]);
  });

  it("refuses geometry with no target", () => {
    expect(() =>
      vertexWeightProximity(withGroups({ A: ALL_ONE }), { group: "A", geometry: ["face"] }),
    ).toThrow(/no target mesh/);
  });
});

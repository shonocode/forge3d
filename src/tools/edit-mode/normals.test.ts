import { describe, it, expect } from "vitest";
import type { MeshData } from "../../lib/mesh";
import {
  splitNormals,
  mergeNormals,
  averageNormals,
  smoothNormals,
  pointNormals,
} from "./normals";

/**
 * The custom-normal operators against Blender 5.1.1.
 *
 * `probe-custom-normals.py` established where the answer lives (per face
 * corner — a cube has 24) and what each operator does; `probe-custom-normals2.py`
 * pinned the weighting, because **a cube cannot tell the three apart**: every
 * face at its corner has the same area and the same corner angle, so plain,
 * area-weighted and angle-weighted all give the same diagonal. The fan below is
 * the shape that separates them — its faces differ tenfold in area and
 * threefold in corner angle — and the three predictions there are
 *
 *   plain  (+0.011435, -0.978284, -0.206952)
 *   area   ( 0,        -1,         0       )
 *   angle  (+0.026718, -0.992824, -0.116559)
 *
 * which is what makes the assertions below mean anything.
 */

const CUBE = (): MeshData => {
  const s = 0.1;
  return {
    positions: Float32Array.from([
      -s, -s, -s, s, -s, -s, s, s, -s, -s, s, -s,
      -s, -s, s, s, -s, s, s, s, s, -s, s, s,
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
};

/** The irregular fan from the probe: apex 0, five rim vertices. */
const FAN = (): MeshData => {
  const spec: [number, number][] = [
    [0, 0.2],
    [35, 0.06],
    [120, 0.18],
    [190, 0.1],
    [280, 0.22],
  ];
  const positions: number[] = [0, 0.06, 0];
  for (const [deg, r] of spec) {
    const a = (deg * Math.PI) / 180;
    positions.push(Math.cos(a) * r, 0, Math.sin(a) * r);
  }
  const polys: number[][] = [];
  for (let i = 0; i < spec.length; i++) polys.push([0, i + 1, 1 + ((i + 1) % spec.length)]);
  return { positions: Float32Array.from(positions), polys };
};

/** The normal on the first corner that belongs to vertex `v`. */
function atVertex(mesh: MeshData, v: number): number[] {
  for (const [f, poly] of mesh.polys.entries())
    for (const [i, w] of poly.entries()) if (w === v) return mesh.normals![f]![i]!;
  throw new Error(`no corner at vertex ${v}`);
}

function expectClose(got: readonly number[], want: readonly number[], what: string): void {
  for (let k = 0; k < 3; k++) expect(got[k]!, `${what}[${k}]`).toBeCloseTo(want[k]!, 4);
}

describe("custom normals", () => {
  it("splitNormals writes the face normal and marks every edge sharp", () => {
    // Measured: 10 of 10 edges sharp on the fan, and the corner normals are
    // the face normals — the layer exists but nothing has moved.
    const out = splitNormals(FAN());
    expect(out.normals).toHaveLength(5);
    expect(out.sharp?.size).toBe(10);
    expectClose(out.normals![0]![0]!, [-0.1787, -0.5956, -0.7832], "face 0");
  });

  it("mergeNormals takes the plain average and clears sharp", () => {
    // The fan's apex, measured: (0.011442, -0.978292, -0.206913), which is the
    // **unweighted** average to 4e-5. Area weighting would give (0, -1, 0).
    const out = mergeNormals(splitNormals(FAN()));
    expectClose(atVertex(out, 0), [0.011442, -0.978292, -0.206913], "apex");
    expect(out.sharp?.size ?? 0).toBe(0);
  });

  it("averageNormals weights three ways, and the fan tells them apart", () => {
    expectClose(atVertex(averageNormals(FAN()), 0), [0.011472, -0.978294, -0.206906], "plain");
    expectClose(
      atVertex(averageNormals(FAN(), { weight: "area" }), 0),
      [0, -1, 0],
      "area",
    );
    // **Looser, and the reason is in the numbers.** The angle-weighted answer
    // comes out 6.1e-5 from Blender's, because the weights are `acos` of
    // float32 dot products and the sum carries that noise; the float64
    // prediction in the probe agrees with this to 1e-6. Nothing rests on it:
    // the three candidates differ in x by 0.011, 0.027 and 0.000, which is
    // orders of magnitude more than the disagreement.
    const angle = atVertex(averageNormals(FAN(), { weight: "angle" }), 0);
    for (const [k, want] of [0.026719, -0.992831, -0.116498].entries())
      expect(angle[k]!, `angle[${k}]`).toBeCloseTo(want, 3);
  });

  it("averageNormals does nothing once splitNormals has been over it", () => {
    // Because the split marked every edge sharp, so each corner is alone in
    // its smooth group. Measured both ways in Blender.
    const split = splitNormals(FAN());
    const after = averageNormals(split);
    for (const [f, face] of after.normals!.entries())
      for (const [i, n] of face.entries())
        expectClose(n, split.normals![f]![i]!, `face ${f} corner ${i}`);
  });

  it("smoothNormals blends toward the average", () => {
    // The cube's first corner, measured: factor 0 leaves the face normal,
    // 0.5 gives (-0.325081, -0.325034, -0.888074), 1.0 the diagonal.
    const zero = smoothNormals(CUBE(), { factor: 0 });
    expectClose(zero.normals![0]![0]!, [0, 0, -1], "factor 0");
    const half = smoothNormals(CUBE(), { factor: 0.5 });
    expectClose(half.normals![0]![0]!, [-0.325081, -0.325034, -0.888074], "factor 0.5");
    const one = smoothNormals(CUBE(), { factor: 1 });
    expectClose(one.normals![0]![0]!, [-0.57735, -0.57735, -0.57735], "factor 1");
  });

  it("smoothNormals defaults to 0.5, as Blender does", () => {
    const out = smoothNormals(CUBE());
    expectClose(out.normals![0]![0]!, [-0.325081, -0.325034, -0.888074], "default");
  });

  it("pointNormals aims every corner at the target", () => {
    // Measured with no arguments: the cube's corner at (-0.1, -0.1, -0.1)
    // comes back pointing at (+0.577, +0.577, +0.577) — at the origin.
    const out = pointNormals(CUBE());
    expectClose(atVertex(out, 0), [0.57735, 0.57735, 0.57735], "at the origin");
    const away = pointNormals(CUBE(), { invert: true });
    expectClose(atVertex(away, 0), [-0.57735, -0.57735, -0.57735], "inverted");
    const elsewhere = pointNormals(CUBE(), { target: [0, 1, 0] });
    const n = atVertex(elsewhere, 0);
    expect(Math.hypot(n[0]!, n[1]!, n[2]!)).toBeCloseTo(1, 6);
    expect(n[1]!).toBeGreaterThan(0.9);
  });

  it("carries the other layers and moves nothing", () => {
    const base: MeshData = {
      ...CUBE(),
      seams: new Set(["0_1"]),
      creases: new Map([["0_1", 0.5]]),
    };
    const out = mergeNormals(base);
    expect(out.seams).toEqual(new Set(["0_1"]));
    expect(out.creases).toEqual(new Map([["0_1", 0.5]]));
    expect([...out.positions]).toEqual([...base.positions]);
    expect(out.polys).toEqual(base.polys);
  });

  it("gives one normal per corner, shaped like polys", () => {
    const out = mergeNormals(CUBE());
    expect(out.normals).toHaveLength(6);
    for (const [f, face] of out.normals!.entries())
      expect(face).toHaveLength(out.polys[f]!.length);
    expect(out.normals!.flat()).toHaveLength(24);
  });
});

import { describe, it, expect } from "vitest";
import type { MeshData } from "../../lib/mesh";
import { normalEdit, weightedNormal } from "./normal-modifiers";

/**
 * `weightedNormal` and `normalEdit`, against Blender 5.1.1.
 *
 * Every number here is measured, and it took **six probes** because the first
 * one read three of the rules wrongly and neither of them saw the fourth:
 *
 *   * `keep_sharp` looked like "ignore the weighting and keep the face
 *     normal", because the probe's `from_pydata` mesh was flat shaded and each
 *     smooth group was therefore one face
 *     (`probe-weighted-normal-sharp.py`);
 *   * `DIRECTIONAL` looked unreadable, because its default
 *     `use_direction_parallel = False` branch is not `target - vertex`
 *     (`probe-normal-edit-directional.py`);
 *   * `offset` looked like a move of the centre. It is, with no target — and
 *     with one Blender ignores it outright (`probe-normal-edit-offset.py`), so
 *     forge3d does not offer it;
 *   * **this operator rewinds faces**, which no probe asked about and the
 *     parity rows found: `no_polynors_fix` is off by default
 *     (`probe-normal-edit-flip.py`).
 *
 * **The tolerance is an angle, not decimal places** — see `TOLERANCE_DEG`.
 * A custom normal is stored as two 16-bit angles relative to the corner's own
 * normal space, so an exact `(0, 1, 0)` reads back as
 * `(1.3e-05, 1.0, -1.8e-05)`, and a direction near perpendicular to its face
 * can lose most of a degree (`probe-custom-normal-storage.py`). Asking for
 * more than that would be asserting the quantisation, not the rule.
 */

/**
 * The irregular fan the probes use. Its five faces differ tenfold in area and
 * threefold in corner angle, which is what separates the three weightings — a
 * cube gives all three the same answer.
 */
function fan(): MeshData {
  const positions: number[] = [0, 0.06, 0];
  const rim: [number, number][] = [
    [0, 0.2],
    [35, 0.06],
    [120, 0.18],
    [190, 0.1],
    [280, 0.22],
  ];
  for (const [deg, r] of rim) {
    const a = (deg * Math.PI) / 180;
    positions.push(Math.cos(a) * r, 0, Math.sin(a) * r);
  }
  const polys: number[][] = [];
  for (let i = 0; i < rim.length; i++) polys.push([0, i + 1, 1 + ((i + 1) % rim.length)]);
  return { positions: Float32Array.from(positions), polys };
}

/**
 * The unit cube the flip measurements used, wound outward, with its faces in
 * the order the probe printed them: -z, +z, -y, +x, +y, -x.
 */
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

/** Every corner at the apex, in face order. */
function apex(data: MeshData): number[][] {
  const out: number[][] = [];
  for (const [f, poly] of data.polys.entries()) {
    const i = poly.indexOf(0);
    if (i >= 0) out.push(data.normals![f]![i]!);
  }
  return out;
}

/**
 * The tolerance, in degrees, and why it is what it is.
 *
 * Blender's custom normals are two 16-bit spherical coordinates, so a value
 * read back carries up to about 1e-4 of component error — 0.006 degrees. The
 * worst disagreement across every case in this file is 9.6e-5 in one
 * component; this allows three times that and nothing like a wrong rule. The
 * candidates these tests reject (plain `target - vertex` for `directional`,
 * normalising after the blend instead of before) are off by 1e-3 to 2e-2,
 * which is 100 to 2000 times further out.
 */
const TOLERANCE_DEG = 0.02;

/**
 * Compare directions by the angle between them, which is the only thing a
 * normal means — and the same measure the parity harness uses, so a number
 * here and a number in a parity row are read the same way.
 */
function expectVec(got: readonly number[], want: readonly number[], why?: string): void {
  const unit = (v: readonly number[]): number[] => {
    const len = Math.hypot(v[0]!, v[1]!, v[2]!);
    return [v[0]! / len, v[1]! / len, v[2]! / len];
  };
  const a = unit(got);
  const b = unit(want);
  const cos = Math.min(1, Math.max(-1, a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!));
  const deg = (Math.acos(cos) * 180) / Math.PI;
  expect(
    deg,
    `${why ?? ""} [${got.map((c) => c.toFixed(6)).join(", ")}] vs ` +
      `[${want.map((c) => c.toFixed(6)).join(", ")}]`,
  ).toBeLessThan(TOLERANCE_DEG);
}

describe("weightedNormal", () => {
  it("weights by area, angle, or their product", () => {
    // Blender, at the apex of the fan. The three answers differ in the second
    // decimal, which is the point of using this shape.
    expectVec(apex(weightedNormal(fan()))[0]!, [0, -1, 0], "area");
    expectVec(apex(weightedNormal(fan(), { mode: "area" }))[0]!, [0, -1, 0], "area");
    expectVec(
      apex(weightedNormal(fan(), { mode: "angle" }))[0]!,
      [0.026719, -0.992831, -0.116498],
      "angle",
    );
    expectVec(
      apex(weightedNormal(fan(), { mode: "areaAngle" }))[0]!,
      [0.004649, -0.998481, 0.05491],
      "areaAngle",
    );
  });

  it("gives every corner at a vertex the same normal, sharp edges and all", () => {
    // Measured: with (0,1) and (0,3) marked sharp and `keep_sharp` off, all
    // five corners at the apex still read (0, -1, 0). The option is the only
    // thing that reads sharpness.
    const marked: MeshData = { ...fan(), sharp: new Set(["0_1", "0_3"]) };
    for (const n of apex(weightedNormal(marked))) expectVec(n, [0, -1, 0]);
  });

  it("averages within each smooth group with keepSharp", () => {
    // Measured. The two sharp edges cut the apex fan into {face 0, face 1} and
    // {face 2, face 3, face 4} — the halves of the cycle between the cuts —
    // and each half gets its own area-weighted average.
    const marked: MeshData = { ...fan(), sharp: new Set(["0_1", "0_3"]) };
    const got = apex(weightedNormal(marked, { keepSharp: true }));
    const near: number[] = [-0.35314, -0.6661, -0.65697];
    const far: number[] = [0.1106, -0.97234, 0.2057];
    expectVec(got[0]!, near, "face 0");
    expectVec(got[1]!, near, "face 1");
    expectVec(got[2]!, far, "face 2");
    expectVec(got[3]!, far, "face 3");
    expectVec(got[4]!, far, "face 4");
  });

  it("does not split a group that a single sharp edge cannot cut", () => {
    // Measured: one sharp edge at the apex leaves the fan connected the other
    // way round, so `keep_sharp` changes nothing. A cycle needs two cuts.
    const one: MeshData = { ...fan(), sharp: new Set(["0_1"]) };
    for (const n of apex(weightedNormal(one, { keepSharp: true }))) expectVec(n, [0, -1, 0]);
  });

  it("falls back to the face normal per corner when every edge is sharp", () => {
    // This is what the first probe measured without knowing it: a flat-shaded
    // mesh has every edge sharp, so each smooth group is one face. The five
    // face normals of the fan, in order.
    const all = new Set<string>();
    for (const poly of fan().polys)
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i]!;
        const b = poly[(i + 1) % poly.length]!;
        all.add(a < b ? `${a}_${b}` : `${b}_${a}`);
      }
    const flat: MeshData = { ...fan(), sharp: all };
    const got = apex(weightedNormal(flat, { keepSharp: true }));
    expectVec(got[0]!, [-0.17867, -0.59557, -0.78318], "face 0");
    expectVec(got[1]!, [-0.47185, -0.69655, -0.54053], "face 1");
    expectVec(got[2]!, [0.52342, -0.85169, -0.02562], "face 2");
    expectVec(got[3]!, [0.45382, -0.83496, 0.31125], "face 3");
    expectVec(got[4]!, [-0.28095, -0.93651, 0.20981], "face 4");
  });

  it("weight 100 with a fine thresh leaves the largest face's normal", () => {
    // w = SHRT_MAX: every tier after the first is divided to nothing.
    const mesh = fan();
    const P = mesh.positions;
    let best = -1;
    let bestNormal: [number, number, number] = [0, 0, 0];
    for (const poly of mesh.polys) {
      const [a, b, c] = poly.map((v) => [P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!]) as [
        number[], number[], number[],
      ];
      const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
      const v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
      const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
      const len = Math.hypot(n[0]!, n[1]!, n[2]!);
      if (len > best) {
        best = len;
        bestNormal = [n[0]! / len, n[1]! / len, n[2]! / len];
      }
    }
    expectVec(apex(weightedNormal(mesh, { weight: 100, thresh: 1e-6 }))[0]!, bestNormal, "largest face");
  });

  it("moves nothing and changes no face", () => {
    const before = fan();
    const out = weightedNormal(before);
    expect([...out.positions]).toEqual([...before.positions]);
    expect(out.polys).toEqual(before.polys);
    expect(out.normals).toHaveLength(before.polys.length);
  });
});

describe("normalEdit", () => {
  it("points radially away from the target", () => {
    // Measured with three targets. The apex sits at (0, 0.06, 0), so a target
    // above it flips its normal — which is how the sign was pinned.
    expectVec(apex(normalEdit(fan()))[0]!, [0, 1, 0], "origin");
    expectVec(apex(normalEdit(fan(), { target: [0, 0.5, 0] }))[0]!, [0, -1, 0], "above");
    expectVec(
      apex(normalEdit(fan(), { target: [0.3, 0, 0] }))[0]!,
      [-0.980565, 0.196196, 0],
      "beside",
    );
  });

  it("has no offset, and that is measured", () => {
    // Blender has one; forge3d does not, because it could not be read. With
    // a target set Blender **ignores** `offset` — four values, one answer —
    // and with none an off-axis value does not move the centre either. The
    // usable form of the modifier has a target, since `directional` is
    // disabled without one. `probe-normal-edit-offset.py` holds the numbers;
    // the way to move the centre here is `target`.
    expect("offset" in normalEdit).toBe(false);
    expectVec(apex(normalEdit(fan(), { target: [0, 0.5, 0] }))[0]!, [0, -1, 0]);
  });

  it("gives one shared direction with parallel on", () => {
    // Measured: every corner reads the target direction exactly.
    for (const target of [
      [0, 1, 0],
      [1, 0, 0],
      [0, 0, 2],
    ] as [number, number, number][]) {
      const out = normalEdit(fan(), { mode: "directional", target, parallel: true });
      const want = [target[0], target[1], target[2]].map((c) => c / Math.hypot(...target));
      for (const n of out.normals!.flat()) expectVec(n, want, `target ${target}`);
    }
  });

  it("sums the shared and per-vertex directions with parallel off", () => {
    // **The rule that does not look like its name.** Blender's default here is
    // parallel *off*, and the answer is `normalize(target + (target - vertex))`,
    // not `normalize(target - vertex)`. Measured at three corners for each of
    // three targets; plain per-vertex aiming is off by up to 2e-2, which these
    // 4-decimal assertions would catch.
    const cases: [readonly [number, number, number], Record<number, number[]>][] = [
      [
        [0, 1, 0],
        {
          0: [0, 1, 0],
          2: [-0.024548, 0.99955, -0.017224],
          1: [-0.099561, 0.995032, 0],
        },
      ],
      [
        [1, 0, 0],
        {
          0: [0.999552, -0.029931, 0],
          2: [0.999844, 0, -0.017643],
          1: [1, 0, 0],
        },
      ],
      [
        [0, 0, 2],
        {
          0: [0, -0.015058, 0.999887],
          2: [-0.012401, 0, 0.999923],
          1: [-0.04991, 0, 0.998754],
        },
      ],
    ];
    for (const [target, want] of cases) {
      const out = normalEdit(fan(), { mode: "directional", target });
      for (const [f, poly] of out.polys.entries())
        for (const [i, v] of poly.entries()) {
          const expected = want[v];
          if (expected) expectVec(out.normals![f]![i]!, expected, `target ${target} vertex ${v}`);
        }
    }
  });

  it("blends the computed normal with the original, four ways", () => {
    // Measured at the apex of face 0, whose face normal — the original, there
    // being no custom layer — is (-0.178672, -0.595573, -0.783179), and whose
    // radial answer is (0, 1, 0).
    //
    // `ADD` at factor 1.0 equals `COPY` at 0.5. That is what shows the sum is
    // normalised *before* the blend, not after.
    const face0 = (out: MeshData): number[] => out.normals![0]![out.polys[0]!.indexOf(0)]!;
    const cases: [Parameters<typeof normalEdit>[1], number[]][] = [
      [{ mixFactor: 0 }, [-0.178672, -0.595573, -0.783179]],
      [{ mixFactor: 0.5 }, [-0.198761, 0.449654, -0.870807]],
      [{ mixFactor: 1 }, [0, 1, 0]],
      [{ mixMode: "add", mixFactor: 0 }, [-0.178672, -0.595573, -0.783179]],
      [{ mixMode: "add", mixFactor: 0.5 }, [-0.221659, -0.085671, -0.971354]],
      [{ mixMode: "add", mixFactor: 1 }, [-0.198761, 0.449654, -0.870807]],
      [{ mixMode: "sub", mixFactor: 0.5 }, [-0.170277, 0.64391, -0.745913]],
      [{ mixMode: "sub", mixFactor: 1 }, [0.100032, 0.893181, 0.43843]],
      [{ mixMode: "mul", mixFactor: 0.5 }, [-0.100031, -0.893181, -0.43843]],
      [{ mixMode: "mul", mixFactor: 1 }, [0, -1, 0]],
    ];
    for (const [options, want] of cases)
      expectVec(face0(normalEdit(fan(), options)), want, JSON.stringify(options));
  });

  it("blends against the stored layer when there is one", () => {
    // `mixFactor: 0` returns what was there, which for a mesh carrying its own
    // normals is that layer and not the face normals.
    const base = fan();
    const stored: MeshData = {
      ...base,
      normals: base.polys.map((poly) => poly.map(() => [0, 0, 1])),
    };
    const out = normalEdit(stored, { mixFactor: 0 });
    for (const n of out.normals!.flat()) expectVec(n, [0, 0, 1]);
  });

  it("moves no vertex", () => {
    // It does change faces — see the rewind tests below. Nothing moves.
    const before = fan();
    expect([...normalEdit(before).positions]).toEqual([...before.positions]);
    expect([...normalEdit(cube()).positions]).toEqual([...cube().positions]);
  });

  /**
   * The rewind — `no_polynors_fix` off, Blender's default.
   *
   * **The parity rows found this, not the probes.** Eight of the nine rows
   * went green and `normal-edit` came back with the fan inside out and a unit
   * cube reading 0.6667 where it should read 1.0.
   */
  describe("rewinds faces whose winding disagrees", () => {
    it("leaves a cube alone on a radial from its own centre", () => {
      // Measured: 0 of 6. Every face already points away from the centre.
      expect(normalEdit(cube(), { target: [0, 0, 0] }).polys).toEqual(cube().polys);
    });

    it("reverses the one face a radial from above turns around", () => {
      // Measured: only face 4, (2, 3, 7, 6) coming back as (2, 6, 7, 3) —
      // which is the rule that the ring keeps its first vertex.
      const out = normalEdit(cube(), { target: [0, 2, 0] });
      expect(out.polys[4]).toEqual([2, 6, 7, 3]);
      for (const f of [0, 1, 2, 3, 5]) expect(out.polys[f], `face ${f}`).toEqual(cube().polys[f]);
    });

    it("reverses only the away-facing face for a parallel direction", () => {
      // Measured: only face 2, the -y face, out of six. The four side faces
      // sit at a dot of analytically zero and Blender leaves them — which is
      // why the threshold here is a small negative number and not zero.
      const out = normalEdit(cube(), {
        mode: "directional",
        target: [0, 1, 0],
        parallel: true,
      });
      expect(out.polys[2]).toEqual([0, 4, 5, 1]);
      for (const f of [0, 1, 3, 4, 5]) expect(out.polys[f], `face ${f}`).toEqual(cube().polys[f]);
    });

    it("reverses five of six for the non-parallel direction", () => {
      // Measured: everything but face 4, the +y face — the only one whose
      // normals still lean its way once each is aimed per vertex.
      const out = normalEdit(cube(), { mode: "directional", target: [0, 1, 0] });
      expect(out.polys[0]).toEqual([0, 1, 2, 3]);
      expect(out.polys[1]).toEqual([4, 7, 6, 5]);
      expect(out.polys[2]).toEqual([0, 4, 5, 1]);
      expect(out.polys[3]).toEqual([1, 5, 6, 2]);
      expect(out.polys[4]).toEqual([2, 3, 7, 6]);
      expect(out.polys[5]).toEqual([3, 7, 4, 0]);
    });

    it("turns the whole fan around, and a gentle mix not at all", () => {
      // Measured: 5 of 5 for the radial, 0 of 5 once the answer is mixed
      // halfway back toward the face normal.
      const turned = normalEdit(fan());
      for (const [f, poly] of turned.polys.entries())
        expect(poly, `face ${f}`).toEqual([fan().polys[f]![0]!, ...fan().polys[f]!.slice(1).reverse()]);
      const mixed = normalEdit(fan(), { mixMode: "add", mixFactor: 0.5 });
      expect(mixed.polys).toEqual(fan().polys);
    });

    it("carries each corner normal with its vertex", () => {
      // Measured: reversing the ring does not change any normal, it only
      // moves where it sits. The apex's is still the apex's.
      const out = normalEdit(fan());
      for (const [f, poly] of out.polys.entries())
        for (const [i, v] of poly.entries()) {
          const want = normalEdit(fan(), { noPolynorsFix: true });
          const j = want.polys[f]!.indexOf(v);
          expectVec(out.normals![f]![i]!, want.normals![f]![j]!, `face ${f} vertex ${v}`);
        }
    });

    it("leaves the winding alone with noPolynorsFix", () => {
      // Measured with the flag on: 0 of 6 on the cube, 0 of 5 on the fan,
      // where the default flips 5 of each.
      expect(normalEdit(fan(), { noPolynorsFix: true }).polys).toEqual(fan().polys);
      expect(
        normalEdit(cube(), { mode: "directional", target: [0, 1, 0], noPolynorsFix: true }).polys,
      ).toEqual(cube().polys);
    });

    it("reverses the other per-corner layers with the face", () => {
      // Not measured against Blender — a UV layer would have to survive the
      // round trip to be — but forced by the rule above: a corner's data
      // belongs to its corner, so a reversed ring has to take it along.
      const base = fan();
      const uvs = base.polys.map((poly, f) => poly.map((_v, i) => [f, i] as [number, number]));
      const out = normalEdit({ ...base, uvs });
      for (const [f, poly] of out.polys.entries())
        for (const [i, v] of poly.entries()) {
          const j = base.polys[f]!.indexOf(v);
          expect(out.uvs![f]![i], `face ${f} vertex ${v}`).toEqual([f, j]);
        }
    });
  });
});

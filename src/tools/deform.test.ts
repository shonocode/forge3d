import { describe, it, expect } from "vitest";
import { cast, simpleDeform, wave, warp } from "./deform";
import { falloffWeight } from "./edit-mode/proportional";
import type { MeshData } from "../lib/mesh";

/** A strip of four verts spanning x ±0.5 and z [zlo, zhi]. */
function strip(zlo: number, zhi: number): MeshData {
  return {
    positions: new Float32Array([-0.5, 0, zlo, 0.5, 0, zlo, 0.5, 0, zhi, -0.5, 0, zhi]),
    polys: [[0, 1, 2, 3]],
  };
}

/** The unit cube, ±0.5 — the same shape the parity rows use. */
function cube(): MeshData {
  return {
    positions: new Float32Array([
      -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
      -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
    ]),
    polys: [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]],
  };
}

const at = (m: MeshData, v: number): [number, number, number] => [
  m.positions[v * 3]!,
  m.positions[v * 3 + 1]!,
  m.positions[v * 3 + 2]!,
];

describe("cast", () => {
  it("auto size for a sphere is the mean distance from the centre", () => {
    // Measured against Blender on a 5x5 grid spanning ±1: 0.93718, which is
    // exactly that mean. Checked here through the result: at factor 1 every
    // vertex lands at that radius.
    const positions: number[] = [];
    for (let i = 0; i <= 4; i++)
      for (let j = 0; j <= 4; j++) positions.push(i / 2 - 1, 0, j / 2 - 1);
    const grid: MeshData = { positions: new Float32Array(positions), polys: [] };

    let sum = 0;
    for (let v = 0; v < 25; v++) sum += Math.hypot(...at(grid, v));
    const mean = sum / 25;
    expect(mean).toBeCloseTo(0.93718, 5);

    const out = cast(grid, { shape: "sphere", factor: 1 });
    for (let v = 0; v < 25; v++) {
      const r = Math.hypot(...at(out, v));
      if (r < 1e-9) continue; // the centre has no direction
      expect(r).toBeCloseTo(mean, 6);
    }
  });

  it("cuboid uses the bounding box per axis, not one size", () => {
    // The rule a sphere cannot see: with a box that is not a cube, a vertex is
    // scaled until the **first** axis reaches its face, which is the smallest
    // of the three ratios — not the largest component.
    const squashed: MeshData = {
      positions: new Float32Array([
        1, 0, 0, 0, 0.6, 0, 0, 0, 1.4, 0.6124, 0.3674, 0.7,
      ]),
      polys: [],
    };
    const out = cast(squashed, { shape: "cuboid", factor: 1 });
    // The three axis-aligned vertices are already on their faces.
    expect(at(out, 0)).toEqual([1, 0, 0]);
    expect(at(out, 1)[1]).toBeCloseTo(0.6, 6);
    expect(at(out, 2)[2]).toBeCloseTo(1.4, 6);
    // The fourth: x and y tie at k = 1.633, so it lands on both faces at once.
    // 3 places, not more — the input coordinates are Blender's probe output
    // rounded to four, so the tie is only approximate here. The parity row is
    // what checks it at full precision.
    const [x, y, z] = at(out, 3);
    expect(x).toBeCloseTo(1.0, 3);
    expect(y).toBeCloseTo(0.6, 3);
    expect(z).toBeCloseTo(1.1431, 3);
  });

  it("leaves a vertex on the centre alone", () => {
    const one: MeshData = { positions: new Float32Array([0, 0, 0, 1, 0, 0]), polys: [] };
    const out = cast(one, { shape: "sphere", factor: 1 });
    expect(at(out, 0)).toEqual([0, 0, 0]);
  });
});

describe("simpleDeform", () => {
  it("measures t from the origin, not from the low end", () => {
    // Three strips two units long. A mesh centred on the origin cannot tell
    // the two readings apart; these can.
    for (const [zlo, zhi, zAt, wantT] of [
      [-1, 1, 1, 0.5],
      [0, 2, 2, 1.0],
      [2, 4, 4, 2.0],
    ] as const) {
      const out = simpleDeform(strip(zlo, zhi), { mode: "taper", axis: "z", factor: 0.5 });
      // Taper scales the perpendicular axes by 1 + factor·t.
      const v = zAt === zhi ? 2 : 0;
      expect(at(out, v)[2]).toBeCloseTo(zAt, 6);
      expect(at(out, v)[0]).toBeCloseTo(0.5 * (1 + 0.5 * wantT), 6);
    }
  });

  it("bend wraps around a cylinder using the vertex's own radius", () => {
    // Measured from Blender on the parity cube, 45° about Z: all eight corners
    // to six places. The `radius - v` term is what a first attempt missed, and
    // without it a curved cage comes back inside out.
    const out = simpleDeform(cube(), { mode: "bend", axis: "z", angle: Math.PI / 4 });
    expect(at(out, 0)[0]).toBeCloseTo(-0.67859, 5);
    expect(at(out, 0)[1]).toBeCloseTo(-0.36502, 5);
    expect(at(out, 0)[2]).toBeCloseTo(-0.5, 6);
    expect(at(out, 2)[0]).toBeCloseTo(0.29591, 5);
    expect(at(out, 2)[1]).toBeCloseTo(0.55886, 5);
  });

  it("twist turns the cross-section by angle · t", () => {
    const out = simpleDeform(strip(-1, 1), { mode: "twist", axis: "z", angle: Math.PI / 4 });
    // z = -1 with extent 2 is t = -0.5, so -22.5°.
    const th = (-Math.PI / 4) * 0.5;
    expect(at(out, 0)[0]).toBeCloseTo(-0.5 * Math.cos(th), 6);
    expect(at(out, 0)[1]).toBeCloseTo(-0.5 * Math.sin(th), 6);
  });

  it("refuses stretch rather than guessing its perpendicular scale", () => {
    // Six extents did not pin the rule down; the message carries the numbers.
    expect(() => simpleDeform(cube(), { mode: "stretch", axis: "z", factor: 0.5 })).toThrow(
      /not implemented/,
    );
  });
});

/**
 * A row of `n` vertices along +X at y = z = 0, which is the shape the Blender
 * probe used for everything that is not a ring.
 */
function row(n: number, lo: number, hi: number): MeshData {
  const positions: number[] = [];
  for (let i = 0; i < n; i++) positions.push(lo + ((hi - lo) * i) / (n - 1), 0, 0);
  return { positions: new Float32Array(positions), polys: [] };
}

/** The z of the vertex at x, for a row built by `row`. */
function zAt(m: MeshData, x: number): number {
  for (let v = 0; v < m.positions.length / 3; v++)
    if (Math.abs(m.positions[v * 3]! - x) < 1e-6) return m.positions[v * 3 + 2]!;
  throw new Error(`no vertex at x = ${x}`);
}

describe("wave", () => {
  // Every number below came off Blender 5.1.1 via
  // tools/modeling/parity/probe-wave.py. Six places is what the probe printed.
  const ridge = { height: 1, width: 1.5, narrowness: 1.5, speed: 0, along: "x" } as const;

  it("subtracts the pedestal, so the crest is short of the full height", () => {
    // The trap a first guess falls into: at the default width and narrowness
    // the crest is 0.99367·height, not height, because Blender takes
    // exp(-(width·narrowness)²) off every sample so the ridge meets zero at
    // the edge of its band instead of stepping.
    const out = wave(row(17, -4, 4), ridge);
    expect(zAt(out, 0)).toBeCloseTo(0.993670, 6);
    expect(zAt(out, -0.5)).toBeCloseTo(0.563453, 6);
    expect(zAt(out, -1)).toBeCloseTo(0.099070, 6);
  });

  it("leaves everything outside the band exactly alone", () => {
    const out = wave(row(17, -4, 4), ridge);
    for (const x of [-4, -3, -2, -1.5, 1.5, 2, 3, 4]) expect(zAt(out, x)).toBe(0);
  });

  it("measures a one-axis wave signed, not absolute", () => {
    // With the front moved out to 0.25, the ridge is no longer symmetric about
    // the start: x = 0.5 and x = -0.5 are at different points on the curve.
    // An implementation that took |x| would put them at the same one.
    const out = wave(row(17, -4, 4), { ...ridge, speed: 0.25, time: 1 });
    expect(zAt(out, 0)).toBeCloseTo(0.862486, 5);
    expect(zAt(out, 0.5)).toBeCloseTo(0.862486, 5);
    expect(zAt(out, -0.5)).toBeCloseTo(0.275734, 5);
  });

  it("repeats on the near side of the front only", () => {
    // Blender wraps with C's fmod, which keeps the sign of its left operand,
    // so the crests run backwards from the front and there are none beyond it.
    // This is the branch that looks like a bug until it is measured.
    const out = wave(row(17, -4, 4), { ...ridge, cyclic: true });
    expect(zAt(out, -3)).toBeCloseTo(0.993670, 6); // a repeat of the crest
    expect(zAt(out, -4)).toBeCloseTo(0.099070, 6);
    expect(zAt(out, 3)).toBe(0); // and nothing at all on the far side
    expect(zAt(out, 2)).toBe(0);
  });

  it("fades from the start position, not from the travelled front", () => {
    // The front is 1.0 out, so the crest sits at x = 1 — and the fade scales
    // it by 1 − 1/3, which is the distance from the **start**. Anchored to the
    // front it would be untouched.
    const travelled = { ...ridge, speed: 0.25, time: 5, timeOffset: 1 };
    const plain = wave(row(17, -4, 4), travelled);
    expect(zAt(plain, 1)).toBeCloseTo(0.993670, 6);
    const faded = wave(row(17, -4, 4), { ...travelled, falloff: 3 });
    expect(zAt(faded, 1)).toBeCloseTo(0.662447, 6);
    expect(zAt(faded, 0)).toBeCloseTo(0.099070, 6); // at the start: no fade
  });

  it("rings when both plane axes are used", () => {
    // The default. On a 5×5 grid spanning ±1 at Blender's own defaults and
    // frame 1, the centre and the four neighbours half a unit out land on the
    // same height — both are a quarter-unit from the front, on opposite sides.
    const positions: number[] = [];
    for (let i = 0; i <= 4; i++)
      for (let j = 0; j <= 4; j++) positions.push(i / 2 - 1, j / 2 - 1, 0);
    const out = wave({ positions: new Float32Array(positions), polys: [] }, { time: 1 });
    const z = (i: number, j: number) => out.positions[(i * 5 + j) * 3 + 2]!;
    expect(z(2, 2)).toBeCloseTo(0.431243, 6);
    expect(z(2, 1)).toBeCloseTo(0.431243, 6);
    expect(z(1, 1)).toBeCloseTo(0.309296, 5);
    expect(z(0, 0)).toBeCloseTo(0.020523, 6);
  });

  it("keeps the topology and the other two coordinates", () => {
    const before = cube();
    const out = wave(before, { height: 0.2, width: 0.6, narrowness: 4, time: 1 });
    expect(out.polys).toEqual(before.polys);
    for (let v = 0; v < 8; v++) {
      expect(out.positions[v * 3]).toBe(before.positions[v * 3]);
      expect(out.positions[v * 3 + 1]).toBe(before.positions[v * 3 + 1]);
    }
  });
});

describe("falloffWeight", () => {
  it("matches Blender at t = 0.25 on all seven curves", () => {
    // Read off the Warp modifier with radius 2 and a vertex 1.5 out, which is
    // t = 0.25: tools/modeling/parity/probe-warp.py. `sphere` is the one worth
    // having — a quarter circle, not a square root.
    expect(falloffWeight(0.25, "constant")).toBeCloseTo(1.0, 6);
    expect(falloffWeight(0.25, "linear")).toBeCloseTo(0.25, 6);
    expect(falloffWeight(0.25, "sharp")).toBeCloseTo(0.0625, 6);
    expect(falloffWeight(0.25, "smooth")).toBeCloseTo(0.15625, 6);
    expect(falloffWeight(0.25, "root")).toBeCloseTo(0.5, 6);
    expect(falloffWeight(0.25, "inverseSquare")).toBeCloseTo(0.4375, 6);
    expect(falloffWeight(0.25, "sphere")).toBeCloseTo(0.661438, 6);
  });

  it("is 1 at the centre and 0 at the rim, except for constant", () => {
    for (const c of ["linear", "sharp", "smooth", "root", "inverseSquare", "sphere"] as const) {
      expect(falloffWeight(1, c)).toBeCloseTo(1, 6);
      expect(falloffWeight(0, c)).toBeCloseTo(0, 6);
    }
    expect(falloffWeight(0, "constant")).toBe(1);
  });
});

describe("warp", () => {
  /** A row of vertices along +X — the shape the Blender probe used. */
  function xs(...at: number[]): MeshData {
    const positions: number[] = [];
    for (const x of at) positions.push(x, 0, 0);
    return { positions: new Float32Array(positions), polys: [] };
  }

  const up = { from: { at: [0, 0, 0] as const }, to: { at: [0, 0, 1] as const }, radius: 2 };

  it("carries a vertex the falloff's share of the way", () => {
    // Blender, radius 2, LINEAR, strength 1: z is 0.25 / 0.5 / 0.75 / 1 at
    // x = -1.5 / -1 / -0.5 / 0.
    const out = warp(xs(-1.5, -1, -0.5, 0), { ...up, falloff: "linear" });
    for (const [v, z] of [[0, 0.25], [1, 0.5], [2, 0.75], [3, 1]] as const)
      expect(out.positions[v * 3 + 2]).toBeCloseTo(z, 6);
  });

  it("leaves everything at or past the radius alone", () => {
    const out = warp(xs(-2, -2.5, 2, 4), { ...up, falloff: "constant" });
    for (let v = 0; v < 4; v++) expect(out.positions[v * 3 + 2]).toBe(0);
  });

  it("moves nothing at all when the radius is zero", () => {
    // Measured. "No falloff" would be the other reading, and it is wrong.
    const out = warp(xs(-1, 0, 1), { ...up, radius: 0, falloff: "constant" });
    for (let v = 0; v < 3; v++) expect(out.positions[v * 3 + 2]).toBe(0);
  });

  it("overshoots rather than clamping above strength 1", () => {
    // Blender at strength 2, LINEAR: z = 2 at the centre and 1 at x = -1.
    const out = warp(xs(-1, 0), { ...up, falloff: "linear", strength: 2 });
    expect(out.positions[2]).toBeCloseTo(1, 6);
    expect(out.positions[5]).toBeCloseTo(2, 6);
  });

  it("applies the rotation of `to` about the origin", () => {
    // `to` turned 90° about +Y sends (x, 0, 0) to (0, 0, -x): measured, the
    // vertex at x = 1.5 comes back at z = -1.5 and the one at -1.5 at +1.5.
    const out = warp(xs(-1.5, 1.5), {
      from: { at: [0, 0, 0] },
      to: { at: [0, 0, 0], rotate: [0, Math.PI / 2, 0] },
      radius: 2,
      falloff: "constant",
    });
    expect(out.positions[0]).toBeCloseTo(0, 6);
    expect(out.positions[2]).toBeCloseTo(1.5, 6);
    expect(out.positions[3]).toBeCloseTo(0, 6);
    expect(out.positions[5]).toBeCloseTo(-1.5, 6);
  });

  it("inverts the transform of `from`", () => {
    // The mirror of the case above: turning `from` instead sends x = 1.5 to
    // z = +1.5, because it is the inverse that is applied.
    const out = warp(xs(-1.5, 1.5), {
      from: { at: [0, 0, 0], rotate: [0, Math.PI / 2, 0] },
      to: { at: [0, 0, 0] },
      radius: 2,
      falloff: "constant",
    });
    expect(out.positions[2]).toBeCloseTo(-1.5, 6);
    expect(out.positions[5]).toBeCloseTo(1.5, 6);
  });

  it("scales about `from`", () => {
    // `to` at 2x sends x = 1.5 to 3. Measured.
    const out = warp(xs(-1.5, 0.5, 1.5), {
      from: { at: [0, 0, 0] },
      to: { at: [0, 0, 0], scale: 2 },
      radius: 2,
      falloff: "constant",
    });
    expect(out.positions[0]).toBeCloseTo(-3, 6);
    expect(out.positions[3]).toBeCloseTo(1, 6);
    expect(out.positions[6]).toBeCloseTo(3, 6);
  });

  it("refuses a `from` that has collapsed an axis", () => {
    expect(() =>
      warp(xs(0), {
        from: { at: [0, 0, 0], scale: [1, 0, 1] },
        to: { at: [0, 0, 1] },
        radius: 2,
      }),
    ).toThrow(/zero scale/);
  });
});

describe("every deform returns its own creases", () => {
  // They all used to spread `...data`, which handed back the input's own Map
  // and Set. No parity row could see it — the contents match either way — so
  // it needs a test of its own rather than a measurement.
  const creased = (): MeshData => ({
    ...cube(),
    creases: new Map([["0-1", 1]]),
    seams: new Set(["2-3"]),
  });

  it("does not crease the input when the caller creases the result", () => {
    const cases: Array<[string, (m: MeshData) => MeshData]> = [
      ["cast", (m) => cast(m, { shape: "sphere", factor: 0.3 })],
      ["simpleDeform", (m) => simpleDeform(m, { mode: "twist", axis: "z", angle: 0.4 })],
      ["wave", (m) => wave(m, { height: 0.1, width: 0.6, narrowness: 4, time: 1 })],
      [
        "warp",
        (m) => warp(m, { from: { at: [0, 0, 0] }, to: { at: [0, 0, 0.2] }, radius: 2 }),
      ],
    ];
    for (const [name, run] of cases) {
      const input = creased();
      const out = run(input);
      out.creases!.set("4-5", 0.5);
      out.seams!.add("6-7");
      expect(input.creases!.has("4-5"), name).toBe(false);
      expect(input.seams!.has("6-7"), name).toBe(false);
      // …and the values that were there did come through.
      expect(out.creases!.get("0-1")).toBe(1);
      expect(out.seams!.has("2-3")).toBe(true);
    }
  });
});

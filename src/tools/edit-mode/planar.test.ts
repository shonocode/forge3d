import { describe, it, expect } from "vitest";
import { planarFaces } from "./planar";
import type { MeshData } from "../../lib/mesh";

/** One quad with its last corner lifted 0.4 — the probe's first shape. */
function lifted(): MeshData {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0.4]),
    polys: [[0, 1, 2, 3]],
  };
}

// Rounded to the six places Blender's probes print, and **−0 folded to 0** —
// a sign on a zero is not a difference, and letting one through cost two runs.
const at = (m: MeshData, v: number): number[] =>
  [0, 1, 2].map((k) => (Math.round(m.positions[v * 3 + k]! * 1e6) / 1e6) || 0);

describe("planarFaces", () => {
  // Every expectation is a Blender 5.1.1 result from
  // tools/modeling/parity/probe-planar.py, to six places.

  it("projects each corner onto the face's own plane", () => {
    // Blender: (0,0,0) -> (0.018519, -0.018519, 0.092593). Not a straight drop
    // in z — the face's normal is tilted, so every component moves.
    const out = planarFaces(lifted(), [0]);
    expect(at(out, 0)).toEqual([0.018519, -0.018519, 0.092593]);
    expect(at(out, 1)).toEqual([0.981481, 0.018519, -0.092593]);
    expect(at(out, 2)).toEqual([1.018519, 0.981481, 0.092593]);
    expect(at(out, 3)).toEqual([-0.018519, 1.018519, 0.307407]);
  });

  it("interpolates by factor", () => {
    // Blender at 0.5 moves exactly half as far, and at 0.25 a quarter.
    expect(at(planarFaces(lifted(), [0], { factor: 0.5 }), 0)).toEqual([
      0.009259, -0.009259, 0.046296,
    ]);
    expect(at(planarFaces(lifted(), [0], { factor: 0.25 }), 0)).toEqual([
      0.00463, -0.00463, 0.023148,
    ]);
  });

  it("does nothing more once the face is flat", () => {
    // Blender: one, two and five iterations all give the same answer.
    const one = planarFaces(lifted(), [0], { iterations: 1 });
    for (const iterations of [2, 5]) {
      const more = planarFaces(lifted(), [0], { iterations });
      expect([...more.positions], `iterations ${iterations}`).toEqual([...one.positions]);
    }
  });

  it("flattens a saddle to its mid-plane", () => {
    // Every corner is off the plane here, and Blender drops all four to z = 0
    // with x and y untouched — the clean case, because the face's normal is
    // exactly +Z.
    const saddle: MeshData = {
      positions: new Float32Array([0, 0, 0.2, 1, 0, -0.2, 1, 1, 0.2, 0, 1, -0.2]),
      polys: [[0, 1, 2, 3]],
    };
    const out = planarFaces(saddle, [0]);
    for (const v of [0, 1, 2, 3]) expect(at(out, v)[2], `vertex ${v}`).toBe(0);
    expect(at(out, 0)).toEqual([0, 0, 0]);
    expect(at(out, 2)).toEqual([1, 1, 0]);
  });

  it("puts a shared corner on the average of what its faces asked for", () => {
    // Two quads pulling their shared edge opposite ways. Blender lands the
    // shared corner at (1, 0.018519, 0) — halfway between the two proposals,
    // which is what says the passes are applied together rather than one face
    // at a time.
    const pair: MeshData = {
      positions: new Float32Array([
        0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0.4, 2, 0, 0, 2, 1, -0.4,
      ]),
      polys: [
        [0, 1, 2, 3],
        [1, 4, 5, 2],
      ],
    };
    const out = planarFaces(pair, [0, 1]);
    expect(at(out, 1)).toEqual([1, 0.018519, 0]);
    expect(at(out, 2)).toEqual([1, 0.981481, 0]);
    expect(at(out, 0)).toEqual([0.018519, -0.018519, 0.092593]);
  });

  it("leaves faces it was not given alone", () => {
    const pair: MeshData = {
      positions: new Float32Array([
        0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0.4, 2, 0, 0, 2, 1, -0.4,
      ]),
      polys: [
        [0, 1, 2, 3],
        [1, 4, 5, 2],
      ],
    };
    const out = planarFaces(pair, [0]);
    expect(at(out, 4)).toEqual([2, 0, 0]);
    expect(at(out, 5)).toEqual([2, 1, -0.4]);
  });

  it("keeps projecting onto the planes the input had, pass after pass", () => {
    // The one thing a single face cannot tell you. On a lone quad every pass
    // after the first is a no-op either way, so "recompute the plane each
    // pass" and "read it once off the input" look identical — and the first
    // implementation took the wrong one for it.
    //
    // A 2x2 sheet of `3xz` plus a checkerboard (the `saddleGrid` parity input,
    // at n = 2) tells them apart: the vertex four faces share lands on the
    // average and so on none of their planes, so later passes keep moving it.
    // Blender moves 0.008126 between one pass and two here.
    //
    // Numbers are Blender 5.1.1, tools/modeling/parity/probe-planar2.py.
    const sheet: MeshData = {
      positions: new Float32Array([
        -0.2, 0.06, -0.2, 0, 0.06, -0.2, 0.2, -0.18, -0.2,
        -0.2, 0.06, 0, 0, -0.06, 0, 0.2, 0.06, 0,
        -0.2, -0.18, 0.2, 0, 0.06, 0.2, 0.2, 0.06, 0.2,
      ]),
      polys: [
        [0, 3, 4, 1],
        [1, 4, 5, 2],
        [3, 6, 7, 4],
        [4, 7, 8, 5],
      ],
    };
    const all = [0, 1, 2, 3];

    // One pass: the centre vertex is averaged off every plane it sits on.
    const one = planarFaces(sheet, all, { iterations: 1 });
    expect(at(one, 4)).toEqual([0, -0.009153, 0]);
    expect(at(one, 1)).toEqual([-0.015254, 0.009153, -0.192373]);

    // Two: it keeps moving, toward a fit to those same four planes.
    const two = planarFaces(sheet, all, { iterations: 2 });
    expect(at(two, 4)).toEqual([0, -0.001396, 0]);
    expect(at(two, 1)).toEqual([-0.016418, 0.005274, -0.185328]);

    // The corners belong to one face each, so they are done after one pass
    // and stay put however many more it is given.
    for (const v of [0, 2, 6, 8]) expect(at(two, v), `corner ${v}`).toEqual(at(one, v));
  });

  it("zero iterations changes nothing", () => {
    const before = lifted();
    const out = planarFaces(before, [0], { iterations: 0 });
    expect([...out.positions]).toEqual([...before.positions]);
  });

  it("refuses a face the mesh does not have", () => {
    expect(() => planarFaces(lifted(), [3])).toThrow(/no face 3/);
  });
});

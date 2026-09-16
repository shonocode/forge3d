/**
 * `solidify` and `bisectPlane` against numbers read off Blender.
 *
 * The fixtures are not invented: they are what `bmesh.ops.solidify` and
 * `bmesh.ops.bisect_plane` produced for the same input, recorded so a
 * regression shows up here rather than only in the parity harness, which needs
 * Blender installed to run at all.
 */
import { describe, it, expect } from "vitest";
import type { MeshData } from "../lib/mesh";
import { solidify, bisectPlane } from "./mesh-ops";

/** One quad in the z=0 plane, wound so its normal is +Z. */
function quad(): MeshData {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    polys: [[0, 1, 2, 3]],
  };
}

/** Unit cube spanning -1..1, every quad wound outward. */
function cube(): MeshData {
  return {
    positions: new Float32Array([
      -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1,
      -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1,
    ]),
    polys: [
      [0, 3, 2, 1],
      [4, 5, 6, 7],
      [0, 1, 5, 4],
      [2, 3, 7, 6],
      [0, 4, 7, 3],
      [1, 2, 6, 5],
    ],
  };
}

/** A face as a canonical rotation of its cycle, so order of listing is free. */
function cycle(poly: readonly number[]): string {
  const n = poly.length;
  let best = "";
  for (let s = 0; s < n; s++) {
    const rotated = Array.from({ length: n }, (_, k) => poly[(s + k) % n]).join(",");
    if (best === "" || rotated < best) best = rotated;
  }
  return best;
}

const cycles = (polys: readonly (readonly number[])[]): Set<string> =>
  new Set(polys.map(cycle));

function at(m: MeshData, v: number): [number, number, number] {
  return [m.positions[v * 3]!, m.positions[v * 3 + 1]!, m.positions[v * 3 + 2]!];
}

describe("solidify", () => {
  it("offsets along the NEGATIVE normal for positive thickness", () => {
    // Measured: a quad at z=0 with normal +Z, solidified by 0.25, grows to
    // z=-0.25. Getting this backwards is invisible until something renders.
    const out = solidify(quad(), { thickness: 0.25 });
    const zs = new Set(Array.from({ length: 8 }, (_, v) => at(out, v)[2]));
    expect([...zs].sort()).toEqual([-0.25, 0]);
  });

  it("reproduces Blender's faces for the one-quad case", () => {
    // 1 original + 1 reversed copy + 4 rim = 6, and these exact cycles came
    // out of bmesh.ops.solidify.
    const out = solidify(quad(), { thickness: 0.25 });
    expect(out.positions).toHaveLength(24);
    expect(out.polys).toHaveLength(6);
    expect(cycles(out.polys)).toEqual(
      cycles([
        [0, 1, 2, 3],
        [4, 7, 6, 5],
        [2, 1, 5, 6],
        [0, 3, 7, 4],
        [3, 2, 6, 7],
        [1, 0, 4, 5],
      ]),
    );
  });

  it("makes the thickness even at a corner, not the naive offset", () => {
    // The cube corner's averaged normal is the diagonal. Moving it by
    // `thickness` along that would leave each face only thickness/sqrt(3)
    // thick; Blender moves it by thickness*sqrt(3) so each face is exactly
    // `thickness` in. Measured: a 2-unit cube solidified by 0.1 has x values
    // -1, -0.9, 0.9, 1 — not -0.9423.
    const out = solidify(cube(), { thickness: 0.1 });
    const xs = [...new Set(Array.from({ length: 16 }, (_, v) => at(out, v)[0]))].sort(
      (a, b) => a - b,
    );
    expect(xs).toHaveLength(4);
    expect(xs[0]).toBeCloseTo(-1, 6);
    expect(xs[1]).toBeCloseTo(-0.9, 5);
    expect(xs[2]).toBeCloseTo(0.9, 5);
    expect(xs[3]).toBeCloseTo(1, 6);
  });

  it("adds no rim to a closed shell", () => {
    const out = solidify(cube(), { thickness: 0.1 });
    expect(out.polys).toHaveLength(12); // 6 + 6, nothing to bridge
    expect(out.positions).toHaveLength(48);
  });

  it("negative thickness goes the other way", () => {
    const out = solidify(quad(), { thickness: -0.25 });
    const zs = [...new Set(Array.from({ length: 8 }, (_, v) => at(out, v)[2]))].sort();
    expect(zs).toEqual([0, 0.25]);
  });

  it("mirrors creases and seams onto the offset copy", () => {
    const m = quad();
    m.creases = new Map([["0_1", 1]]);
    m.seams = new Set(["1_2"]);
    const out = solidify(m, { thickness: 0.25 });
    expect(out.creases?.get("0_1")).toBe(1);
    expect(out.creases?.get("4_5")).toBe(1);
    expect(out.seams?.has("1_2")).toBe(true);
    expect(out.seams?.has("5_6")).toBe(true);
  });
});

describe("bisectPlane", () => {
  const PLANE = { planeCo: [0, 0, 0] as [number, number, number], planeNo: [0, 0, 1] as [number, number, number] };

  it("splits the crossing faces and shares the new vertices", () => {
    // Measured on the cube: 12 verts, 10 faces, all quads. Four new vertices
    // (one per vertical edge), each shared by the two faces that meet there —
    // if they were not shared it would be 16.
    const out = bisectPlane(cube(), PLANE);
    expect(out.positions).toHaveLength(36);
    expect(out.polys).toHaveLength(10);
    for (const poly of out.polys) expect(poly).toHaveLength(4);
  });

  it("does not fill the hole", () => {
    // bmesh.ops.bisect_plane leaves the cut open. The Bisect *tool* has a fill
    // option; the operator does not, and neither does this.
    const out = bisectPlane(cube(), { ...PLANE, clearOuter: true });
    const onPlane = out.polys.filter((poly) =>
      poly.every((v) => Math.abs(at(out, v)[2]) < 1e-6),
    );
    expect(onPlane).toHaveLength(0);
  });

  it("clearOuter drops the side the normal points TO", () => {
    // Measured, because the two names read equally well either way round.
    const out = bisectPlane(cube(), { ...PLANE, clearOuter: true });
    expect(out.polys).toHaveLength(5);
    expect(out.positions).toHaveLength(24);
    for (let v = 0; v < 8; v++) expect(at(out, v)[2]).toBeLessThanOrEqual(1e-6);
  });

  it("clearInner keeps the other half", () => {
    const out = bisectPlane(cube(), { ...PLANE, clearInner: true });
    expect(out.polys).toHaveLength(5);
    for (let v = 0; v < 8; v++) expect(at(out, v)[2]).toBeGreaterThanOrEqual(-1e-6);
  });

  it("compacts away the vertices a cleared side left behind", () => {
    const out = bisectPlane(cube(), { ...PLANE, clearOuter: true });
    const used = new Set(out.polys.flat());
    expect(used.size).toBe(out.positions.length / 3);
  });

  it("a plane that misses the mesh changes nothing", () => {
    const out = bisectPlane(cube(), { planeCo: [0, 0, 5], planeNo: [0, 0, 1] });
    expect(out.polys).toEqual(cube().polys);
    expect(out.positions).toHaveLength(24);
  });

  it("a split edge passes its crease to both halves", () => {
    const m = cube();
    m.creases = new Map([["0_4", 1]]); // a vertical edge, so the cut splits it
    const out = bisectPlane(m, PLANE);
    // The two halves both carry the sharpness; nothing else picks it up.
    const sharp = [...(out.creases ?? new Map())].filter(([, s]) => s === 1);
    expect(sharp).toHaveLength(2);
  });

  it("rejects a zero-length normal rather than dividing by it", () => {
    expect(() => bisectPlane(cube(), { planeCo: [0, 0, 0], planeNo: [0, 0, 0] })).toThrow(
      /zero length/,
    );
  });
});

import { describe, it, expect } from "vitest";
import type { MeshData } from "../lib/mesh";
import {
  recalcFaceNormals,
  connectVertsConcave,
  deleteLoose,
  separateLoose,
  type RecalcFaceNormalsReport,
  type ConnectVertsConcaveReport,
} from "./mesh-repair";

const emptyRecalc = (): RecalcFaceNormalsReport => ({
  flipped: 0,
  shells: 0,
  inconsistentEdges: 0,
  openShells: 0,
  nonManifoldEdges: 0,
});

const emptyConcave = (): ConnectVertsConcaveReport => ({ split: 0, pieces: 0, failed: 0 });

/** Unit cube at the origin, every quad wound outward. */
function cube(): MeshData {
  return {
    positions: new Float32Array([
      0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
      0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
    ]),
    polys: [
      [0, 3, 2, 1], // -z
      [4, 5, 6, 7], // +z
      [0, 1, 5, 4], // -y
      [2, 3, 7, 6], // +y
      [0, 4, 7, 3], // -x
      [1, 2, 6, 5], // +x
    ],
  };
}

/** Six times the signed volume — positive when the shell faces outward. */
function volume6(m: MeshData): number {
  const P = m.positions;
  let v = 0;
  for (const poly of m.polys)
    for (let t = 1; t + 1 < poly.length; t++) {
      const a = poly[0]! * 3;
      const b = poly[t]! * 3;
      const c = poly[t + 1]! * 3;
      v +=
        P[a]! * (P[b + 1]! * P[c + 2]! - P[b + 2]! * P[c + 1]!) -
        P[a + 1]! * (P[b]! * P[c + 2]! - P[b + 2]! * P[c]!) +
        P[a + 2]! * (P[b]! * P[c + 1]! - P[b + 1]! * P[c]!);
    }
  return v;
}

describe("recalcFaceNormals", () => {
  it("leaves a correctly wound closed mesh alone", () => {
    const report = emptyRecalc();
    const before = cube();
    const after = recalcFaceNormals(before, report);

    expect(report.flipped).toBe(0);
    expect(report.inconsistentEdges).toBe(0);
    expect(report.shells).toBe(1);
    expect(report.openShells).toBe(0);
    expect(after.polys).toEqual(before.polys);
  });

  it("turns a fully inverted mesh outward", () => {
    const inverted = cube();
    inverted.polys = inverted.polys.map((p) => [...p].reverse());
    expect(volume6(inverted)).toBeLessThan(0);

    const report = emptyRecalc();
    const fixed = recalcFaceNormals(inverted, report);

    expect(volume6(fixed)).toBeGreaterThan(0);
    // Consistent to begin with, so the fix is the whole-shell reversal only.
    expect(report.inconsistentEdges).toBe(0);
    expect(report.flipped).toBe(6);
  });

  it("repairs a mesh whose faces disagree with each other", () => {
    // This is the case `orientOutward` cannot see: one face reversed leaves the
    // total volume positive, so a signed-volume test reports nothing wrong.
    const mixed = cube();
    mixed.polys[3] = [...mixed.polys[3]!].reverse();
    expect(volume6(mixed)).toBeGreaterThan(0); // the blind spot, stated

    const report = emptyRecalc();
    const fixed = recalcFaceNormals(mixed, report);

    expect(report.inconsistentEdges).toBeGreaterThan(0);
    expect(fixed.polys).toEqual(cube().polys);
    expect(volume6(fixed)).toBeCloseTo(volume6(cube()), 12);
  });

  it("makes an open shell consistent but does not guess its direction", () => {
    // Two quads sharing an edge, the second wound the wrong way.
    const strip: MeshData = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 2, 0, 0, 2, 1, 0]),
      polys: [
        [0, 1, 2, 3],
        [1, 2, 5, 4],
      ],
    };
    const report = emptyRecalc();
    const fixed = recalcFaceNormals(strip, report);

    expect(report.openShells).toBe(1);
    expect(report.inconsistentEdges).toBe(1);
    expect(report.flipped).toBe(1);
    // Now both traverse the shared edge 1-2 in opposite directions.
    expect(fixed.polys[1]).toEqual([4, 5, 2, 1]);
  });

  it("orients each shell independently", () => {
    const a = cube();
    const b = cube();
    // Second cube, shifted clear of the first, built inside out.
    const positions = new Float32Array(a.positions.length * 2);
    positions.set(a.positions, 0);
    for (let i = 0; i < b.positions.length; i += 3) {
      positions[a.positions.length + i] = b.positions[i]! + 5;
      positions[a.positions.length + i + 1] = b.positions[i + 1]!;
      positions[a.positions.length + i + 2] = b.positions[i + 2]!;
    }
    const polys = [
      ...a.polys,
      ...b.polys.map((p) => [...p].reverse().map((v) => v + 8)),
    ];

    const report = emptyRecalc();
    const fixed = recalcFaceNormals({ positions, polys }, report);

    expect(report.shells).toBe(2);
    expect(report.flipped).toBe(6); // only the inverted one
    // volume6 returns 6V, so two unit cubes are 12.
    expect(volume6(fixed)).toBeCloseTo(12, 9);
  });

  it("carries creases and seams through", () => {
    const m = cube();
    m.creases = new Map([["0_1", 1]]);
    m.seams = new Set(["2_3"]);
    const fixed = recalcFaceNormals(m);
    expect(fixed.creases?.get("0_1")).toBe(1);
    expect(fixed.seams?.has("2_3")).toBe(true);
  });
});

describe("connectVertsConcave", () => {
  /** An L-shaped hexagon in the XY plane, CCW, with one reflex corner. */
  function lShape(): MeshData {
    return {
      positions: new Float32Array([
        0, 0, 0,
        2, 0, 0,
        2, 1, 0,
        1, 1, 0,
        1, 2, 0,
        0, 2, 0,
      ]),
      polys: [[0, 1, 2, 3, 4, 5]],
    };
  }

  it("leaves convex faces untouched", () => {
    const report = emptyConcave();
    const before = cube();
    const after = connectVertsConcave(before, report);
    expect(report.split).toBe(0);
    expect(after.polys).toEqual(before.polys);
  });

  it("splits an L into convex pieces covering the same area", () => {
    const report = emptyConcave();
    const after = connectVertsConcave(lShape(), report);

    expect(report.split).toBe(1);
    expect(report.failed).toBe(0);
    expect(after.polys.length).toBeGreaterThan(1);

    // Same total area as the L (2×1 + 1×1 = 3).
    const area = (poly: readonly number[]): number => {
      const P = after.positions;
      let s = 0;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i]! * 3;
        const b = poly[(i + 1) % poly.length]! * 3;
        s += P[a]! * P[b + 1]! - P[b]! * P[a + 1]!;
      }
      return s / 2;
    };
    expect(after.polys.reduce((s, p) => s + area(p), 0)).toBeCloseTo(3, 9);
  });

  it("every piece it produces is convex", () => {
    const after = connectVertsConcave(lShape());
    for (const poly of after.polys) {
      const P = after.positions;
      let sign = 0;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i]!;
        const b = poly[(i + 1) % poly.length]!;
        const c = poly[(i + 2) % poly.length]!;
        const cr =
          (P[b * 3]! - P[a * 3]!) * (P[c * 3 + 1]! - P[b * 3 + 1]!) -
          (P[b * 3 + 1]! - P[a * 3 + 1]!) * (P[c * 3]! - P[b * 3]!);
        if (Math.abs(cr) < 1e-12) continue;
        const s = cr > 0 ? 1 : -1;
        if (sign === 0) sign = s;
        else expect(s).toBe(sign);
      }
    }
  });

  it("prefers quads over triangles — the merge step is doing its job", () => {
    // An L-hexagon splits into two quads. Ear clipping alone would give four
    // triangles, which is what Catmull-Clark would rather not be handed.
    const after = connectVertsConcave(lShape());
    expect(after.polys).toHaveLength(2);
    for (const poly of after.polys) expect(poly).toHaveLength(4);
  });

  it("handles a U with its face point outside the polygon", () => {
    // The case the parity harness measured: the average of the vertices lands
    // in the slot, outside the shape itself.
    const u: MeshData = {
      positions: new Float32Array([
        0, 0, 0,
        3, 0, 0,
        3, 3, 0,
        2, 3, 0,
        2, 1, 0,
        1, 1, 0,
        1, 3, 0,
        0, 3, 0,
      ]),
      polys: [[0, 1, 2, 3, 4, 5, 6, 7]],
    };
    const report = emptyConcave();
    const after = connectVertsConcave(u, report);

    expect(report.split).toBe(1);
    expect(report.failed).toBe(0);
    // 3×3 minus the 1×2 slot.
    const P = after.positions;
    let total = 0;
    for (const poly of after.polys) {
      let s = 0;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i]! * 3;
        const b = poly[(i + 1) % poly.length]! * 3;
        s += P[a]! * P[b + 1]! - P[b]! * P[a + 1]!;
      }
      total += s / 2;
    }
    expect(total).toBeCloseTo(7, 9);
  });

  it("works on a face that is not axis aligned", () => {
    // Same L, rotated out of every axis plane: the projection has to come from
    // the face's own normal, not a fixed axis.
    const m = lShape();
    const P = m.positions;
    const rotated = new Float32Array(P.length);
    const c = Math.cos(0.7);
    const s = Math.sin(0.7);
    for (let i = 0; i < P.length; i += 3) {
      const x = P[i]!;
      const y = P[i + 1]!;
      const z = P[i + 2]!;
      // rotate about X, then about Z
      const y1 = y * c - z * s;
      const z1 = y * s + z * c;
      rotated[i] = x * c - y1 * s;
      rotated[i + 1] = x * s + y1 * c;
      rotated[i + 2] = z1;
    }
    const report = emptyConcave();
    const after = connectVertsConcave({ positions: rotated, polys: m.polys }, report);
    expect(report.split).toBe(1);
    expect(after.polys).toHaveLength(2);
  });

  it("carries creases and seams through", () => {
    const m = lShape();
    m.creases = new Map([["0_1", 1]]);
    m.seams = new Set(["4_5"]);
    const after = connectVertsConcave(m);
    expect(after.creases?.get("0_1")).toBe(1);
    expect(after.seams?.has("4_5")).toBe(true);
  });
});

describe("deleteLoose / separateLoose", () => {
  /** A quad, plus a vertex no polygon uses. */
  const withOrphan = () => ({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 9, 9, 9]),
    polys: [[0, 1, 2, 3]],
  });

  it("drops a vertex no polygon uses and renumbers the rest", () => {
    const out = deleteLoose(withOrphan());
    expect(out.positions.length / 3).toBe(4);
    expect(out.polys).toEqual([[0, 1, 2, 3]]);
  });

  it("renumbers when the orphan is in the middle", () => {
    const out = deleteLoose({
      positions: new Float32Array([0, 0, 0, 9, 9, 9, 1, 0, 0, 1, 0, 1, 0, 0, 1]),
      polys: [[0, 2, 3, 4]],
    });
    expect(out.positions.length / 3).toBe(4);
    // Everything above the hole shifts down by one.
    expect(out.polys).toEqual([[0, 1, 2, 3]]);
    expect(Array.from(out.positions.slice(3, 6))).toEqual([1, 0, 0]);
  });

  it("is a no-op when every vertex is used", () => {
    const before = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 1]), polys: [[0, 1, 2]] };
    const out = deleteLoose(before);
    expect(Array.from(out.positions)).toEqual(Array.from(before.positions));
    expect(out.polys).toEqual(before.polys);
  });

  it("carries creases across the renumbering and drops the ones that go", () => {
    const out = deleteLoose({
      positions: new Float32Array([0, 0, 0, 9, 9, 9, 1, 0, 0, 1, 0, 1, 0, 0, 1]),
      polys: [[0, 2, 3, 4]],
      creases: new Map([
        ["2_3", 1],
        ["0_1", 0.5], // names the orphan — goes with it
      ]),
    });
    expect([...out.creases!.keys()].sort()).toEqual(["1_2"]);
  });

  it("separates a mesh into the pieces it was made of", () => {
    // Two triangles that share nothing.
    const out = separateLoose({
      positions: new Float32Array([
        0, 0, 0, 1, 0, 0, 0, 0, 1,
        5, 0, 0, 6, 0, 0, 5, 0, 1,
      ]),
      polys: [[0, 1, 2], [3, 4, 5]],
    });
    expect(out).toHaveLength(2);
    for (const piece of out) {
      expect(piece.positions.length / 3).toBe(3);
      expect(piece.polys).toEqual([[0, 1, 2]]);
    }
    expect(out[0]!.positions[0]).toBe(0);
    expect(out[1]!.positions[0]).toBe(5);
  });

  it("keeps faces that share a single vertex in one piece", () => {
    // Two triangles meeting at a corner are one piece, not two.
    const out = separateLoose({
      positions: new Float32Array([
        0, 0, 0, 1, 0, 0, 0, 0, 1,
        -1, 0, 0, 0, 0, -1,
      ]),
      polys: [[0, 1, 2], [0, 3, 4]],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.positions.length / 3).toBe(5);
  });
});

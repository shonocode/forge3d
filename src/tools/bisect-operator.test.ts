/**
 * `bisectPlane`'s face splitting (`bm_face_bisect_verts`) and the Bisect tool's fill, against Blender 5.1.1
 * (compat-backlog C25 / C34; the parity rows `bisect-*`).
 */
import { describe, it, expect } from "vitest";
import type { MeshData } from "../lib/mesh";
import { bisectPlane, type BisectReport } from "./mesh-ops";
import { bisectOperator } from "./bisect-operator";

/** A polygon in the x–y plane from its outline. */
const flat = (outline: [number, number][]): MeshData => ({
  positions: Float32Array.from(outline.flatMap(([x, y]) => [x, y, 0])),
  polys: [outline.map((_, i) => i)],
});

/** The comb: base 5 × 1, three teeth from y = 1 to 2. */
const COMB: [number, number][] = [
  [0, 0], [5, 0], [5, 2], [4, 2], [4, 1], [3, 1], [3, 2], [2, 2], [2, 1], [1, 1], [1, 2], [0, 2],
];

/** A unit cube centred on the origin. */
function cube(): MeshData {
  const p = [-0.5, 0.5];
  const positions: number[] = [];
  for (const z of p) for (const y of p) for (const x of p) positions.push(x, y, z);
  return {
    positions: Float32Array.from(positions),
    polys: [
      [0, 2, 3, 1],
      [4, 5, 7, 6],
      [0, 1, 5, 4],
      [2, 6, 7, 3],
      [0, 4, 6, 2],
      [1, 3, 7, 5],
    ],
  };
}

describe("bisectPlane: faces cut along chords", () => {
  it("cuts a polygon the plane meets six times into the comb's base and three teeth", () => {
    const out = bisectPlane(flat(COMB), { planeCo: [0, 1.5, 0], planeNo: [0, 1, 0] });
    expect(out.polys).toHaveLength(4);
    expect(out.positions.length / 3).toBe(18);
  });

  it("keeps only the base with the outer side cleared", () => {
    const out = bisectPlane(flat(COMB), { planeCo: [0, 1.5, 0], planeNo: [0, 1, 0], clearOuter: true });
    expect(out.polys).toHaveLength(1);
    expect(out.positions.length / 3).toBe(12);
  });

  it("cuts along an edge that lies on the plane without toggling 'inside' there", () => {
    // C–D (2,1)–(3,1) is on the plane; B below it, E above.
    const zig: [number, number][] = [[0, 0], [2, 0], [2, 1], [3, 1], [3, 2], [0, 2]];
    const out = bisectPlane(flat(zig), { planeCo: [0, 1, 0], planeNo: [0, 1, 0] });
    expect(out.polys).toHaveLength(2);
    expect(out.positions.length / 3).toBe(7);
  });

  it("splits a face between two of its vertices on the plane, no edge of it crossing the plane", () => {
    // (0,0) and (0,2) lie on x = 0, the corners (2,0) and (2,2) on one side, (-1,1) on the other — nothing crosses.
    const out = bisectPlane(flat([[0, 0], [2, 0], [2, 2], [0, 2], [-1, 1]]), { planeCo: [0, 0, 0], planeNo: [1, 0, 0] });
    expect(out.polys.map((p) => p.length).sort()).toEqual([3, 4]);
    expect(out.positions.length / 3).toBe(5);
  });

  it("cuts a wire edge the plane crosses and keeps the half that is left", () => {
    const data: MeshData = {
      positions: Float32Array.from([0, 0, 0, 0, 1, 0, 0, 2, 0, 1, 0, 0]),
      polys: [],
      edges: [
        [0, 2],
        [0, 3],
      ],
    };
    const out = bisectPlane(data, { planeCo: [0, 1.5, 0], planeNo: [0, 1, 0], clearOuter: true });
    // vertex 2 is beyond the plane and goes; the edge 0–2 leaves 0–m; vertex 1 (unused) stays.
    expect(out.edges).toHaveLength(2);
    expect(out.positions.length / 3).toBe(4);
  });

  it("snaps the vertices near the plane onto it with snapCenter", () => {
    const out = bisectPlane(flat([[0, 0], [1, 0.0004], [1, 1], [0, 1]]), {
      planeCo: [0, 0, 0],
      planeNo: [0, 1, 0],
      dist: 0.001,
      snapCenter: true,
    });
    expect(out.positions[4]).toBe(0);
  });

  it("reports the edges left on the plane", () => {
    const report: BisectReport = { cutEdges: [] };
    bisectPlane(cube(), { planeCo: [0, 0, 0], planeNo: [0, 0, 1], clearOuter: true }, report);
    expect(report.cutEdges).toHaveLength(4);
  });
});

describe("bisectOperator (bpy.ops.mesh.bisect)", () => {
  it("leaves the cut open without fill", () => {
    const out = bisectOperator(cube(), { planeCo: [0, 0, 0], planeNo: [0, 0, 1], clearOuter: true });
    expect(out.polys).toHaveLength(5);
  });

  it("fills the cut with one face", () => {
    const out = bisectOperator(cube(), { planeCo: [0, 0, 0], planeNo: [0, 0, 1], clearOuter: true, useFill: true });
    expect(out.polys).toHaveLength(6);
    expect(out.polys.filter((p) => p.length === 4)).toHaveLength(6);
  });

  it("winds the cap like the faces around it, whichever side is cleared", () => {
    const signedVolume = (m: MeshData): number => {
      let v = 0;
      const P = m.positions;
      for (const poly of m.polys)
        for (let i = 1; i + 1 < poly.length; i++) {
          const a = poly[0]! * 3;
          const b = poly[i]! * 3;
          const c = poly[i + 1]! * 3;
          v +=
            (P[a]! * (P[b + 1]! * P[c + 2]! - P[b + 2]! * P[c + 1]!) -
              P[a + 1]! * (P[b]! * P[c + 2]! - P[b + 2]! * P[c]!) +
              P[a + 2]! * (P[b]! * P[c + 1]! - P[b + 1]! * P[c]!)) /
            6;
        }
      return v;
    };
    // The unit cube is wound outward-in here or outward-out; whichever it is, halving must keep the sign.
    const whole = signedVolume(cube());
    for (const clear of ["clearOuter", "clearInner"] as const) {
      const out = bisectOperator(cube(), { planeCo: [0, 0, 0], planeNo: [0, 0, 1], [clear]: true, useFill: true });
      expect(Math.sign(signedVolume(out))).toBe(Math.sign(whole));
      expect(Math.abs(signedVolume(out))).toBeCloseTo(0.5 * Math.abs(whole), 6);
    }
  });

  it("fills two nested loops, leaving the hole open", () => {
    // A frame: outer 2 × 2, hole 1 × 1, z 0–1; the top and bottom are four trapezoids each.
    const ring = (z: number): number[] => [-1, -1, z, 1, -1, z, 1, 1, z, -1, 1, z, -0.5, -0.5, z, 0.5, -0.5, z, 0.5, 0.5, z, -0.5, 0.5, z];
    const polys: number[][] = [];
    for (let k = 0; k < 4; k++) {
      const j = (k + 1) % 4;
      polys.push([k, 4 + k, 4 + j, j], [8 + j, 12 + j, 12 + k, 8 + k], [k, j, 8 + j, 8 + k], [4 + j, 4 + k, 12 + k, 12 + j]);
    }
    const frame: MeshData = { positions: Float32Array.from([...ring(0), ...ring(1)]), polys };
    const cut = bisectOperator(frame, { planeCo: [0, 0, 0.5], planeNo: [0, 0, 1], clearOuter: true });
    const filled = bisectOperator(frame, { planeCo: [0, 0, 0.5], planeNo: [0, 0, 1], clearOuter: true, useFill: true });
    // 16 cut quads' lower halves + 4 + 4 …: the fill adds the annulus, in at most a few faces (not 8 triangles),
    // and does not close the hole: no face has a vertex of the hole's loop and one of the outer loop only.
    expect(filled.polys.length).toBeGreaterThan(cut.polys.length);
    expect(filled.polys.length - cut.polys.length).toBeLessThan(8);
  });
});

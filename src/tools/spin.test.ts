import { describe, expect, it } from "vitest";
import type { MeshData } from "../lib/mesh";
import { screw, spin } from "./spin";

// compat-backlog C99 — the parity rows `screw-bpy` / `-turns` / `-flat` measure these against Blender 5.1.1's `bpy.ops.mesh.screw`.
describe("screw", () => {
  const pts: [number, number][] = [[0, 0], [0.2, 0], [0.3, 0.15], [0.2, 0.3], [0, 0.3], [-0.1, 0.15]];
  const chain = (at: (p: [number, number]) => number[], reversed = false): MeshData => ({
    positions: Float32Array.from((reversed ? [...pts].reverse() : pts).flatMap(at)),
    polys: [],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]],
  });
  const wire = { verts: [0, 1, 2, 3, 4, 5], edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]] as [number, number][] };
  const upright = ([x, z]: [number, number]) => [x, 0, z];
  const flat = ([x, y]: [number, number]) => [x, y, 0];
  /** The output's vertices as a sorted list of rounded positions — the same helix whatever the numbering. */
  const cloud = (m: MeshData): string[] =>
    Array.from({ length: m.positions.length / 3 }, (_, i) => [...m.positions.slice(i * 3, i * 3 + 3)].map((x) => x.toFixed(4)).join(",")).sort();
  const opts = { center: [0.6, 0, 0] as const, axis: [0, 0, 1] as const };

  it("defaults to 9 steps and 1 turn: 10 copies of the 6-vertex chain, 9 × 5 quads", () => {
    const out = screw(chain(upright), wire, opts);
    expect(out.positions.length / 3).toBe(60);
    expect(out.polys).toHaveLength(45);
  });

  it("climbs downward whichever end is numbered first — a climb up +Z is negated", () => {
    expect(cloud(screw(chain(upright, true), wire, opts))).toEqual(cloud(screw(chain(upright), wire, opts)));
  });

  it("with the ends level the climb is not negated, so the numbering decides its direction", () => {
    const o = { center: [0.6, 0, 0] as const, axis: [0, 1, 0] as const };
    expect(cloud(screw(chain(flat, true), wire, o))).not.toEqual(cloud(screw(chain(flat), wire, o)));
  });

  it("refuses a selection that is not a string with two ends, and a zero axis", () => {
    const loop = { verts: wire.verts, edges: [...wire.edges, [5, 0]] as [number, number][] };
    expect(() => screw(chain(upright), loop, opts)).toThrow(/string of connected vertices/);
    expect(() => screw(chain(upright), wire, { axis: [0, 0, 0] })).toThrow(/axis/);
  });
});

// A wire profile: three points along x at y = 0, two edges, no face.
function profile(): MeshData {
  return {
    positions: new Float32Array([1, 0, 0, 1.5, 0.5, 0, 1, 1, 0]),
    polys: [],
    edges: [
      [0, 1],
      [1, 2],
    ],
  };
}
const all = { verts: [0, 1, 2], edges: [[0, 1], [1, 2]] as [number, number][] };

describe("spin", () => {
  it("sweeps a wire profile into a band of quads, one ring per step", () => {
    const out = spin(profile(), all, { axis: [0, 1, 0], angle: Math.PI, steps: 4 });
    expect(out.positions.length / 3).toBe(3 * 5);
    expect(out.polys).toHaveLength(2 * 4);
    // The last ring is the profile turned half way round: x negated.
    const last = [...out.positions.slice(12 * 3)];
    expect(last[0]).toBeCloseTo(-1, 5);
    expect(last[2]).toBeCloseTo(0, 5);
  });

  it("with useMerge closes a whole turn instead of doubling the first ring", () => {
    const open = spin(profile(), all, { axis: [0, 1, 0], angle: Math.PI * 2, steps: 6 });
    const shut = spin(profile(), all, { axis: [0, 1, 0], angle: Math.PI * 2, steps: 6, useMerge: true });
    expect(open.positions.length / 3).toBe(3 * 7);
    expect(shut.positions.length / 3).toBe(3 * 6);
    expect(shut.polys).toHaveLength(2 * 6);
    expect(shut.edges ?? []).toHaveLength(0);
  });

  it("useDuplicate leaves turned copies, unjoined", () => {
    const out = spin(profile(), all, { axis: [0, 1, 0], angle: Math.PI, steps: 2, useDuplicate: true });
    expect(out.positions.length / 3).toBe(9);
    expect(out.polys).toHaveLength(0);
    expect(out.edges).toHaveLength(6);
  });

  it("turns dvec with each step's rotation before moving the step", () => {
    // A quarter turn per step about y; dvec along x turns to −z, then −x.
    const out = spin(
      { positions: new Float32Array([1, 0, 0]), polys: [] },
      { verts: [0] },
      { axis: [0, 1, 0], angle: Math.PI, steps: 2, dvec: [0.1, 0, 0] },
    );
    // Step 1: (1,0,0) turned 90° → (0,0,−1), plus R90·dvec = (0,0,−0.1).
    expect(out.positions[3 * 1 + 2]).toBeCloseTo(-1.1, 5);
  });
});

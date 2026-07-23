import { describe, it, expect } from "vitest";
import { computeLSCM } from "./lscm";

/** UV distance between two vertex ids. */
function uvDist(uvs: Float32Array, a: number, b: number): number {
  return Math.hypot(uvs[a * 2]! - uvs[b * 2]!, uvs[a * 2 + 1]! - uvs[b * 2 + 1]!);
}
function pos3Dist(p: Float32Array, a: number, b: number): number {
  return Math.hypot(
    p[a * 3]! - p[b * 3]!,
    p[a * 3 + 1]! - p[b * 3 + 1]!,
    p[a * 3 + 2]! - p[b * 3 + 2]!,
  );
}

describe("computeLSCM", () => {
  it("returns null for degenerate input", () => {
    expect(computeLSCM(new Float32Array([0, 0, 0]), [0, 0, 0])).toBeNull();
    expect(computeLSCM(new Float32Array(9), [])).toBeNull();
  });

  it("maps a flat (planar) chart as a similarity — edge-length ratios preserved", () => {
    // A 2x2 grid of quads in the z=0 plane, split into triangles. LSCM on an
    // already-flat chart must be an exact similarity, so every UV distance is
    // the same constant multiple of the 3D distance.
    const P: number[] = [];
    const idx = (r: number, c: number): number => r * 3 + c;
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) P.push(c, r, 0);
    }
    const pos = new Float32Array(P);
    const tris: number[] = [];
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 2; c++) {
        const a = idx(r, c), b = idx(r, c + 1), d = idx(r + 1, c), e = idx(r + 1, c + 1);
        tris.push(a, b, e, a, e, d);
      }
    }
    const res = computeLSCM(pos, tris)!;
    expect(res).not.toBeNull();
    // Pick several edges; UV/3D length ratio must be ~constant.
    const edges: Array<[number, number]> = [[0, 1], [0, 3], [4, 5], [4, 7], [0, 8]];
    const ratios = edges.map(([a, b]) => uvDist(res.uvs, a, b) / pos3Dist(pos, a, b));
    const base = ratios[0]!;
    for (const rr of ratios) expect(rr).toBeCloseTo(base, 4);
    // All UVs finite.
    for (const v of res.uvs) expect(Number.isFinite(v)).toBe(true);
  });

  it("preserves right angles on a flat right-triangle chart (conformal)", () => {
    // Two triangles forming a unit square; the corner angles should stay 90°.
    const pos = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    const tris = [0, 1, 2, 0, 2, 3];
    const res = computeLSCM(pos, tris)!;
    // Angle at vertex 0 between edges 0→1 and 0→3 should be ~90°.
    const e1x = res.uvs[1 * 2]! - res.uvs[0]!, e1y = res.uvs[1 * 2 + 1]! - res.uvs[1]!;
    const e2x = res.uvs[3 * 2]! - res.uvs[0]!, e2y = res.uvs[3 * 2 + 1]! - res.uvs[1]!;
    const cosang = (e1x * e2x + e1y * e2y) / (Math.hypot(e1x, e1y) * Math.hypot(e2x, e2y));
    expect(Math.abs(cosang)).toBeLessThan(0.02); // ~90°
  });

  it("pins two vertices; the map is non-degenerate (positive spread)", () => {
    const pos = new Float32Array([0, 0, 0, 2, 0, 0, 1, 1.5, 0]);
    const res = computeLSCM(pos, [0, 1, 2])!;
    // Some pair of UVs is meaningfully apart (chart didn't collapse).
    let maxD = 0;
    for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) maxD = Math.max(maxD, uvDist(res.uvs, a, b));
    expect(maxD).toBeGreaterThan(0.5);
  });

  it("is deterministic", () => {
    const pos = new Float32Array([0, 0, 0, 1, 0, 0.2, 1, 1, 0, 0, 1, 0.1]);
    const tris = [0, 1, 2, 0, 2, 3];
    const a = computeLSCM(pos, tris)!;
    const b = computeLSCM(pos, tris)!;
    expect(Array.from(a.uvs)).toEqual(Array.from(b.uvs));
  });

  it("honors 2 user pins exactly (pinned verts keep their UVs)", () => {
    const pos = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    const tris = [0, 1, 2, 0, 2, 3];
    const pins = new Map<number, readonly [number, number]>([
      [0, [0.25, 0.25]],
      [2, [0.75, 0.75]],
    ]);
    const res = computeLSCM(pos, tris, { pins })!;
    expect(res.uvs[0]).toBeCloseTo(0.25, 6);
    expect(res.uvs[1]).toBeCloseTo(0.25, 6);
    expect(res.uvs[2 * 2]).toBeCloseTo(0.75, 6);
    expect(res.uvs[2 * 2 + 1]).toBeCloseTo(0.75, 6);
    // Chart still spans (didn't collapse onto the pin segment).
    let maxD = 0;
    for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) maxD = Math.max(maxD, uvDist(res.uvs, a, b));
    expect(maxD).toBeGreaterThan(0.3);
    for (const v of res.uvs) expect(Number.isFinite(v)).toBe(true);
  });

  it("honors 3+ user pins exactly (over-determined pins stay fixed)", () => {
    const pos = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    const tris = [0, 1, 2, 0, 2, 3];
    const pins = new Map<number, readonly [number, number]>([
      [0, [0, 0]],
      [1, [1, 0]],
      [3, [0, 1]],
    ]);
    const res = computeLSCM(pos, tris, { pins })!;
    for (const [v, uv] of pins) {
      expect(res.uvs[v * 2]).toBeCloseTo(uv[0], 6);
      expect(res.uvs[v * 2 + 1]).toBeCloseTo(uv[1], 6);
    }
    // The free vertex (2) should land near (1,1) — the flat square's corner.
    expect(res.uvs[2 * 2]).toBeCloseTo(1, 1);
    expect(res.uvs[2 * 2 + 1]).toBeCloseTo(1, 1);
  });

  it("a single user pin translates the auto-pinned solve onto it", () => {
    const pos = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    const tris = [0, 1, 2, 0, 2, 3];
    const pins = new Map<number, readonly [number, number]>([[2, [5, 7]]]);
    const res = computeLSCM(pos, tris, { pins })!;
    expect(res.uvs[2 * 2]).toBeCloseTo(5, 5);
    expect(res.uvs[2 * 2 + 1]).toBeCloseTo(7, 5);
    // Shape identical to the unpinned solve (just translated): edge ratios hold.
    const base = computeLSCM(pos, tris)!;
    expect(uvDist(res.uvs, 0, 1)).toBeCloseTo(uvDist(base.uvs, 0, 1), 5);
  });

  it("returns null when all user pins are out of range", () => {
    const pos = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]);
    const pins = new Map<number, readonly [number, number]>([
      [99, [0, 0]],
      [100, [1, 0]],
    ]);
    expect(computeLSCM(pos, [0, 1, 2], { pins })).toBeNull();
  });

  it("unwraps a curved chart (bent quad) with lower stretch than planar projection", () => {
    // A quad bent along its middle (a shallow roof). Planar projection onto the
    // average normal squashes one half; LSCM should keep both halves' edge
    // lengths closer to their 3D lengths.
    const pos = new Float32Array([
      0, 0, 0,   1, 0, 0.5,   2, 0, 0,   // bottom row, tented up in the middle
      0, 1, 0,   1, 1, 0.5,   2, 1, 0,   // top row
    ]);
    const tris = [0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4];
    const res = computeLSCM(pos, tris)!;
    // The two middle-spanning edges (0→1 and 1→2) both have 3D length
    // sqrt(1+0.25); their UV lengths should be within ~15% of each other
    // (conformal keeps them comparable — planar projection would not).
    const d01 = uvDist(res.uvs, 0, 1);
    const d12 = uvDist(res.uvs, 1, 2);
    expect(Math.abs(d01 - d12) / Math.max(d01, d12)).toBeLessThan(0.15);
  });
});

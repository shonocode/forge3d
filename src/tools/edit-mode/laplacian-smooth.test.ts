import { describe, it, expect } from "vitest";
import type { MeshData } from "../../lib/mesh";
import { laplacianSmooth } from "./laplacian-smooth";

/**
 * `laplacianSmooth` — the LAPLACIANSMOOTH modifier. The agreement with Blender
 * is the parity rows `laplacian-smooth` / `-area` / `-neg` (10 cases,
 * 0.0000 mm); these check the properties that hold whatever Blender does.
 */

/** A bumpy, irregular 4×4 quad sheet (as `probe-laplacian-mod.py` builds it). */
function sheet(dx = 0): MeshData {
  const n = 4;
  const p: number[] = [];
  for (let j = 0; j <= n; j++)
    for (let i = 0; i <= n; i++) p.push(i * 0.25 - 0.5 + dx, (0.15 * ((i * 7 + j * 3) % 5)) / 4, j * 0.25 - 0.5);
  const polys: number[][] = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      polys.push([a, a + 1, a + n + 2, a + n + 1]);
    }
  return { positions: Float32Array.from(p), polys };
}

const RIM = [0, 1, 2, 3, 4, 5, 9, 10, 14, 15, 19, 20, 21, 22, 23, 24];

describe("laplacianSmooth", () => {
  const opts = { iterations: 2, lambda: 0.8, lambdaBorder: 0.6, preserveVolume: false };

  it("does not depend on where the mesh is", () => {
    // The bmesh op's lambda_border scales toward the origin; this one must not.
    const a = laplacianSmooth(sheet(0), opts).positions;
    const b = laplacianSmooth(sheet(4), opts).positions;
    for (let i = 0; i < a.length; i++) expect(b[i]! - (i % 3 === 0 ? 4 : 0)).toBeCloseTo(a[i]!, 5);
  });

  it("smooths the rim along the rim, and leaves it with lambdaBorder 0", () => {
    const input = sheet().positions;
    const moved = laplacianSmooth(sheet(), opts).positions;
    const held = laplacianSmooth(sheet(), { ...opts, lambdaBorder: 0 }).positions;
    const d = (P: Float32Array, v: number): number =>
      Math.hypot(P[v * 3]! - input[v * 3]!, P[v * 3 + 1]! - input[v * 3 + 1]!, P[v * 3 + 2]! - input[v * 3 + 2]!);
    expect(Math.max(...RIM.map((v) => d(moved, v)))).toBeGreaterThan(0.01);
    for (const v of RIM) expect(d(held, v)).toBe(0);
    expect(d(held, 12)).toBeGreaterThan(0.001); // the interior still moves
  });

  it("reflects the move for a negative lambda", () => {
    const one = { iterations: 1, lambdaBorder: 0.3, preserveVolume: false };
    const input = sheet().positions;
    const pos = laplacianSmooth(sheet(), { ...one, lambda: 0.5 }).positions;
    const neg = laplacianSmooth(sheet(), { ...one, lambda: -0.5, lambdaBorder: -0.3 }).positions;
    for (let i = 0; i < input.length; i++) expect(neg[i]!).toBeCloseTo(2 * input[i]! - pos[i]!, 5);
  });

  it("leaves a loose vertex where it is", () => {
    // Blender scales it toward the origin (normalized) or returns NaN.
    const m = sheet();
    const withLoose: MeshData = { positions: Float32Array.from([...m.positions, 1, 0.3, 0.2]), polys: m.polys };
    for (const normalized of [true, false]) {
      const out = laplacianSmooth(withLoose, { ...opts, normalized }).positions;
      expect([...out.slice(75)]).toEqual([1, Math.fround(0.3), Math.fround(0.2)]);
    }
  });

  it("gives a cube back with volume preserved", () => {
    const P = [-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
      -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5];
    const cube: MeshData = {
      positions: Float32Array.from(P),
      polys: [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]],
    };
    const out = laplacianSmooth(cube, { lambda: 0.5, lambdaBorder: 0.3 }).positions;
    for (let i = 0; i < P.length; i++) expect(out[i]!).toBeCloseTo(P[i]!, 6);
    // …and without it, it shrinks.
    const shrunk = laplacianSmooth(cube, { lambda: 0.5, preserveVolume: false }).positions;
    expect(Math.abs(shrunk[0]!)).toBeLessThan(0.5);
  });
});

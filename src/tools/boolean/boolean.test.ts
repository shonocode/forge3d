import { describe, it, expect } from "vitest";
import type { MeshData } from "../../lib/mesh";
import { booleanMesh, type BooleanOperation } from "./boolean";

/**
 * `booleanMesh`, against Blender 5.1.1's `intersect_boolean` with the exact
 * solver (parity rows `boolean-union` / `-difference` / `-intersect`, whose
 * cases these numbers come from). A is the first box, B the second.
 */

/** An axis-aligned box as Blender's `create_cube` winds it. */
function box(center: number[], size: number[]): MeshData {
  const positions: number[] = [];
  for (const [x, y, z] of [
    [-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, -0.5], [-0.5, 0.5, 0.5],
    [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5],
  ])
    positions.push(center[0]! + x! * size[0]!, center[1]! + y! * size[1]!, center[2]! + z! * size[2]!);
  return {
    positions: Float32Array.from(positions),
    polys: [[0, 1, 3, 2], [2, 3, 7, 6], [6, 7, 5, 4], [4, 5, 1, 0], [2, 6, 4, 0], [7, 3, 1, 5]],
  };
}

const B = new Set([6, 7, 8, 9, 10, 11]);

function run(a: MeshData, b: MeshData, operation: BooleanOperation): MeshData {
  return booleanMesh(
    {
      positions: Float32Array.from([...a.positions, ...b.positions]),
      polys: [...a.polys, ...b.polys.map((p) => p.map((v) => v + a.positions.length / 3))],
    },
    { operation, set: B },
  );
}

/** Signed volume by the divergence theorem, fanning each polygon. */
function volume(m: MeshData): number {
  const P = m.positions;
  let v = 0;
  for (const p of m.polys)
    for (let i = 1; i + 1 < p.length; i++) {
      const [a, b, c] = [p[0]!, p[i]!, p[i + 1]!].map((k) => [P[k * 3]!, P[k * 3 + 1]!, P[k * 3 + 2]!]);
      v +=
        (a![0]! * (b![1]! * c![2]! - b![2]! * c![1]!) -
          a![1]! * (b![0]! * c![2]! - b![2]! * c![0]!) +
          a![2]! * (b![0]! * c![1]! - b![1]! * c![0]!)) /
        6;
    }
  return v;
}

const counts = (m: MeshData): [number, number] => [m.positions.length / 3, m.polys.length];

describe("booleanMesh", () => {
  const A = box([0, 0, 0], [1, 1, 1]);
  const Bx = box([0.5, 0.3, 0.2], [1, 1, 1]);
  // The overlap is 0.5 × 0.7 × 0.8 = 0.28.

  it("unions two boxes in general position", () => {
    const out = run(A, Bx, "union");
    expect(counts(out)).toEqual([20, 12]);
    expect(volume(out)).toBeCloseTo(2 - 0.28, 6);
  });

  it("takes B out of A", () => {
    const out = run(A, Bx, "difference");
    expect(counts(out)).toEqual([14, 9]);
    expect(volume(out)).toBeCloseTo(1 - 0.28, 6);
  });

  it("keeps only where both are", () => {
    const out = run(A, Bx, "intersect");
    expect(counts(out)).toEqual([8, 6]);
    expect(volume(out)).toBeCloseTo(0.28, 6);
  });

  it("handles faces lying exactly on each other", () => {
    // Moved (0.5, 0, 0): four faces overlap exactly — zero-volume cells.
    const Bf = box([0.5, 0, 0], [1, 1, 1]);
    expect(counts(run(A, Bf, "union"))).toEqual([16, 14]);
    expect(volume(run(A, Bf, "union"))).toBeCloseTo(1.5, 6);
    expect(volume(run(A, Bf, "intersect"))).toBeCloseTo(0.5, 6);
    expect(volume(run(A, Bf, "difference"))).toBeCloseTo(0.5, 6);
  });

  it("hollows a box by one nested inside it, touching nothing", () => {
    // Two components with no cut between them: the inner one's outside cell
    // is merged into the cell of the outer one that contains it.
    const inner = box([0.1, 0.05, -0.07], [0.4, 0.4, 0.4]);
    const diff = run(A, inner, "difference");
    expect(counts(diff)).toEqual([16, 12]);
    expect(volume(diff)).toBeCloseTo(1 - 0.064, 6);
    expect(volume(run(A, inner, "union"))).toBeCloseTo(1, 6);
    expect(volume(run(A, inner, "intersect"))).toBeCloseTo(0.064, 6);
  });

  it("leaves parts far apart alone, and their intersection empty", () => {
    const far = box([3, 0.2, 0.1], [1, 1, 1]);
    expect(counts(run(A, far, "union"))).toEqual([16, 12]);
    expect(counts(run(A, far, "difference"))).toEqual([8, 6]);
    expect(counts(run(A, far, "intersect"))).toEqual([0, 0]);
  });

  it("refuses a part that is not closed", () => {
    const open: MeshData = { positions: A.positions, polys: A.polys.slice(0, 5) };
    expect(() => run(open, Bx, "union")).toThrow(/not closed/);
  });
});

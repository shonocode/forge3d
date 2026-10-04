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

  it("cuts with an open sheet by casting rays, as Blender does", () => {
    // A tilted quad through the cube (parity case `boxSheet`): B has no
    // inside, so there are no cells; Blender decides each patch by rays.
    // A − B keeps the part of the cube above the sheet, capped by the piece
    // of the sheet inside it — 8 vertices, 6 faces.
    const sheet: MeshData = {
      positions: Float32Array.from([-1, 0.05, -1, 1, 0.05, -1, 1, 0.15, 1, -1, 0.15, 1]),
      polys: [[0, 3, 2, 1]],
    };
    const joined: MeshData = {
      positions: Float32Array.from([...A.positions, ...sheet.positions]),
      polys: [...A.polys, [8, 11, 10, 9]],
    };
    const out = booleanMesh(joined, { operation: "difference", set: new Set([6]) });
    expect(counts(out)).toEqual([8, 6]);
    // Above y = 0.1 + 0.05 z inside the unit cube: ∫(0.4 − 0.05 z) dz = 0.4.
    expect(volume(out)).toBeCloseTo(0.4, 6);
    // Hole Tolerant (per triangle) agrees here.
    expect(counts(booleanMesh(joined, { operation: "difference", set: new Set([6]), holeTolerant: true }))).toEqual([8, 6]);
  });

  it("takes more than two parts, as the Collection operand does", () => {
    // Parity case `threeBoxes`: two cutters that overlap A and each other.
    // A∩B = 0.3·0.6·0.6 = 0.108, A∩C = 0.75·0.55·0.4 = 0.165,
    // A∩B∩C = 0.3·0.5·0.15 = 0.0225.
    const Bb = box([0.55, 0, -0.05], [0.7, 0.6, 0.6]);
    const C = box([0.175, 0.075, 0.45], [0.85, 0.55, 0.7]);
    const joined: MeshData = {
      positions: Float32Array.from([...A.positions, ...Bb.positions, ...C.positions]),
      polys: [...A.polys, ...Bb.polys.map((p) => p.map((v) => v + 8)), ...C.polys.map((p) => p.map((v) => v + 16))],
    };
    const parts = [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2];
    const union = booleanMesh(joined, { operation: "union", parts });
    const diff = booleanMesh(joined, { operation: "difference", parts });
    const inter = booleanMesh(joined, { operation: "intersect", parts });
    expect(counts(union)).toEqual([30, 17]);
    expect(counts(diff)).toEqual([26, 15]);
    expect(volume(diff)).toBeCloseTo(1 - 0.108 - 0.165 + 0.0225, 5);
    expect(counts(inter)).toEqual([8, 6]);
    expect(volume(inter)).toBeCloseTo(0.0225, 5);
  });
});

describe("booleanMesh edge layers (compat-backlog C22)", () => {
  const edgeKeys = (m: MeshData): string[] => {
    const out = new Set<string>();
    for (const p of m.polys) p.forEach((v, i) => out.add([v, p[(i + 1) % p.length]!].sort((a, b) => a - b).join("_")));
    return [...out];
  };
  /** Two overlapping boxes, every edge creased and sharp and a seam. */
  const marked = (): MeshData => {
    const a = box([0, 0, 0], [1, 1, 1]);
    const b = box([0.5, 0.3, 0.2], [1, 1, 1]);
    const n = a.positions.length / 3;
    const data: MeshData = {
      positions: Float32Array.from([...a.positions, ...b.positions]),
      polys: [...a.polys, ...b.polys.map((p) => p.map((v) => v + n))],
    };
    const keys = edgeKeys(data);
    return { ...data, creases: new Map(keys.map((k) => [k, 0.75] as [string, number])), sharp: new Set(keys), seams: new Set(keys) };
  };

  it("a split input edge keeps its flags on every piece; the edges the cut makes have none", () => {
    const out = booleanMesh(marked(), { operation: "union", set: B });
    const total = edgeKeys(out).length;
    expect(out.creases!.size).toBeGreaterThan(12);
    expect(out.creases!.size).toBeLessThan(total);
    expect(out.sharp!.size).toBe(out.creases!.size);
    expect(out.seams!.size).toBe(out.creases!.size);
    for (const c of out.creases!.values()) expect(c).toBe(0.75);
  });

  it("without the layers on the input, none come out", () => {
    const m = marked();
    const out = booleanMesh({ positions: m.positions, polys: m.polys }, { operation: "union", set: B });
    expect(out.creases).toBeUndefined();
    expect(out.sharp).toBeUndefined();
  });

  it("the modifier and the operator disagree only where the first face that makes an edge names no original", () => {
    const op = booleanMesh(marked(), { operation: "difference", set: B });
    const mod = booleanMesh(marked(), { operation: "difference", set: B, modifier: true });
    expect(mod.creases!.size).toBeGreaterThan(0);
    expect(Math.abs(op.creases!.size - mod.creases!.size)).toBeLessThanOrEqual(4);
  });
});

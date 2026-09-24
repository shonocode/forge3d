import { describe, it, expect } from "vitest";
import { meshFromData, meshToData } from "../../lib/mesh";
import { connectVertsNonplanar } from "./operators";

/**
 * `connectVertsNonplanar`, against Blender.
 *
 * Every expected value here was read off
 * `bmesh.ops.connect_verts_nonplanar(angle_limit=0.05)` in Blender 5.1 —
 * `tools/modeling/parity/probe-nonplanar7.py` prints them, and
 * `probe-nonplanar8.py` prints the candidate table behind each one.
 *
 * The cases are bent **n-gons** on purpose. A quad cannot test this rule: both
 * of its candidate cuts leave two exactly planar triangles, so both planarity
 * errors are zero and Blender's float32 rounding decides
 * (`probe-nonplanar6.py` reproduces its 16 answers on a bent sheet that way).
 * From five corners up the minimum is real, and it is nothing like the fan from
 * corner 0 that this operator used to produce — the last test is that contrast,
 * because that is the bug these measurements found.
 */

/** Faces as sorted corner lists, sorted — comparable regardless of order. */
function faces(positions: Float32Array, polys: number[][], angle = 0.05): number[][] {
  const em = meshFromData({ positions, polys });
  connectVertsNonplanar(em, new Set(polys.map((_, i) => i)), angle);
  const out = meshToData(em);
  return out.polys.map((p) => [...p].sort((a, b) => a - b)).sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!);
}

function ring(sides: number, radius: number, height: (i: number, x: number, z: number) => number): Float32Array {
  const p: number[] = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    const x = Math.cos(a) * radius;
    const z = Math.sin(a) * radius;
    p.push(x, height(i, x, z), z);
  }
  return Float32Array.from(p);
}

const HEX_ZIGZAG = ring(6, 0.1, (i) => (i % 2 ? 0.03 : -0.03));
const HEX_ONE_CORNER = ring(6, 0.1, (i) => (i === 3 ? 0.05 : 0));
const HEPT_SADDLE = ring(7, 0.1, (_i, x, z) => 3 * x * z);
const OCT_ROLLED = ring(8, 0.1, (_i, x) => 0.4 * x * x);
const PENTA_FOLDED = Float32Array.from([
  0, 0, 0, 0.1, 0, 0, 0.13, 0.04, 0.08, 0.05, 0, 0.12, -0.03, 0, 0.05,
]);

describe("connectVertsNonplanar follows the planarity-error search", () => {
  it("cuts a zigzag hexagon 0-2 and 3-5, leaving a quad in the middle", () => {
    // The whole candidate table ties here at err 0.210036, and Blender takes
    // the first pair its search reaches. The middle quad survives because the
    // fold across it is inside the limit.
    expect(faces(HEX_ZIGZAG, [[0, 1, 2, 3, 4, 5]])).toEqual([
      [0, 1, 2],
      [0, 2, 3, 5],
      [3, 4, 5],
    ]);
  });

  it("cuts one lifted corner off a flat hexagon and stops", () => {
    // One cut, 2-4, err 0. The pentagon left behind is flat, so the operator
    // declines to cut it — a face is not triangulated just because it was
    // handed over.
    expect(faces(HEX_ONE_CORNER, [[0, 1, 2, 3, 4, 5]])).toEqual([
      [0, 1, 2, 4, 5],
      [2, 3, 4],
    ]);
  });

  it("cuts a folded pentagon along the fold", () => {
    expect(faces(PENTA_FOLDED, [[0, 1, 2, 3, 4]])).toEqual([
      [0, 1, 3, 4],
      [1, 2, 3],
    ]);
  });

  it("makes the saddle heptagon's first cut at 1-4, not at 3-6", () => {
    // The tie that matters: pairs 1-4 and 3-6 score the same — 3.5e-17 apart
    // in float64, 1.4e-16 relative once the coordinates are float32 — and
    // Blender keeps 1-4 because its search reaches it first. Believing a
    // strict `<` on those two numbers is what made an earlier float64 walk of
    // this rule answer 3-6 and get every later cut wrong.
    //
    // Only the first cut is asserted. This heptagon splits all the way down to
    // quads, and a quad's diagonal is decided by rounding on both sides, so
    // Blender's own answer for the last two cuts ([1,2,4]+[2,3,4] and
    // [0,1,4]+[0,4,6]) is not something to match — see the operator's note.
    const out = faces(HEPT_SADDLE, [[0, 1, 2, 3, 4, 5, 6]]);
    expect(out).toHaveLength(5);
    for (const f of out) expect(f).toHaveLength(3);
    const has = (a: number, b: number): number =>
      out.filter((f) => f.includes(a) && f.includes(b)).length;
    expect(has(1, 4)).toBe(2); // an interior edge: two faces share it
    expect(has(3, 6)).toBe(0);
  });

  it("halves a rolled octagon across the roll and stops", () => {
    expect(faces(OCT_ROLLED, [[0, 1, 2, 3, 4, 5, 6, 7]])).toEqual([
      [0, 1, 2, 3, 4],
      [0, 4, 5, 6, 7],
    ]);
  });

  it("leaves everything alone once the limit is wider than the fold", () => {
    // Measured: the zigzag hexagon splits at every limit up to 1.0 rad and is
    // left whole at 1.5, because the two halves' normals are 1.1 rad apart.
    expect(faces(HEX_ZIGZAG, [[0, 1, 2, 3, 4, 5]], 1.0)).toHaveLength(3);
    expect(faces(HEX_ZIGZAG, [[0, 1, 2, 3, 4, 5]], 1.5)).toEqual([[0, 1, 2, 3, 4, 5]]);
  });

  it("leaves a flat n-gon alone however bent its neighbours are", () => {
    const flat = ring(6, 0.1, () => 0);
    expect(faces(flat, [[0, 1, 2, 3, 4, 5]])).toEqual([[0, 1, 2, 3, 4, 5]]);
  });

  it("takes v0-v2 on a bent quad when the two zeros round the same", () => {
    // Both cuts leave exactly planar triangles: the errors are zero, and a
    // float32 tie keeps the first candidate.
    const quad = Float32Array.from([0, 0, 0, 0.1, 0, 0, 0.1, 0.05, 0.1, 0, 0, 0.1]);
    expect(faces(quad, [[0, 1, 2, 3]])).toEqual([
      [0, 1, 2],
      [0, 2, 3],
    ]);
  });

  /**
   * The parity inputs `saddleGrid` / `saddleBump`, built as their OBJ is
   * (float32, six decimals): on a quad the float32 rounding of two zeros is
   * the whole answer, so the input has to be the same to the last digit.
   */
  function saddle(twist: number, bump: number): { positions: Float32Array; polys: number[][] } {
    const n = 4;
    const step = 0.4 / n;
    const r6 = (x: number): number => Number(Math.fround(x).toFixed(6));
    const p: number[] = [];
    for (let r = 0; r <= n; r++)
      for (let c = 0; c <= n; c++) {
        const x = c * step - 0.2;
        const z = r * step - 0.2;
        p.push(r6(x), r6(twist * x * z + ((r + c) % 2 ? bump : -bump)), r6(z));
      }
    const polys: number[][] = [];
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++)
        polys.push([r * (n + 1) + c, (r + 1) * (n + 1) + c, (r + 1) * (n + 1) + c + 1, r * (n + 1) + c + 1]);
    return { positions: Float32Array.from(p), polys };
  }

  /** Per input quad: "02", "13", or "--" for left whole. */
  function diagonals(sheet: { positions: Float32Array; polys: number[][] }): string[] {
    const em = meshFromData(sheet);
    connectVertsNonplanar(em, new Set(sheet.polys.map((_, i) => i)), 0.05);
    const out = meshToData(em);
    const edges = new Set<string>();
    for (const p of out.polys)
      p.forEach((a, i) => {
        const b = p[(i + 1) % p.length]!;
        edges.add(a < b ? `${a},${b}` : `${b},${a}`);
      });
    const has = (a: number, b: number): boolean => edges.has(a < b ? `${a},${b}` : `${b},${a}`);
    return sheet.polys.map((q) => (has(q[0]!, q[2]!) ? "02" : has(q[1]!, q[3]!) ? "13" : "--"));
  }

  it("picks Blender's diagonal on every quad of a bent sheet — float32 rounding and all", () => {
    // Read off Blender's output for the parity row (2026-09-25): 6 of 16 go
    // v1-v3, with no geometric reason — the rounding of two zeros.
    expect(diagonals(saddle(3, 0.06))).toEqual([
      "02", "02", "02", "13", "13", "13", "02", "02",
      "02", "02", "13", "13", "13", "02", "02", "02",
    ]);
  });

  it("leaves a quad whole when no cut through it is legal", () => {
    // `saddleBump`: the bump folds four quads so far that they are not
    // convex in their own projection, and Blender keeps them whole — an
    // illegal cut is passed over, never taken as a fallback, which forge3d
    // used to do (it split all 16; Blender's output has 28 faces, not 32).
    expect(diagonals(saddle(3, 0.2))).toEqual([
      "02", "--", "13", "13", "--", "02", "13", "13",
      "13", "13", "02", "--", "13", "13", "--", "02",
    ]);
  });

  it("does not fan from corner 0 — the answer it used to give", () => {
    const fan = [
      [0, 1, 2],
      [0, 2, 3],
      [0, 3, 4],
      [0, 4, 5],
    ];
    expect(faces(HEX_ZIGZAG, [[0, 1, 2, 3, 4, 5]])).not.toEqual(fan);
    expect(faces(HEX_ONE_CORNER, [[0, 1, 2, 3, 4, 5]])).not.toEqual(fan);
  });
});

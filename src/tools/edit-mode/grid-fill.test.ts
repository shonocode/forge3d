import { describe, it, expect } from "vitest";
import type { MeshData } from "../../lib/mesh";
import { gridFill } from "./grid-fill";

/**
 * `gridFill`, against Blender.
 *
 * Every number here was read off `bpy.ops.mesh.fill_grid()` in Blender 5.1.1;
 * `tools/modeling/parity/probe-gridfill4.py` prints the whole set, and
 * `probe-gridfill.py` / `2` / `3` are the measurements that got there.
 *
 * **The ring is a teardrop because a circle cannot test this.** The rule has
 * two argmax steps — which vertex the grid starts at, and which corner's index
 * becomes the span — and on a symmetric ring both are ties: a circle of 10's
 * corner angles agree to 3.3e-07 and a rectangle's four right angles agree
 * exactly, so Blender lands wherever its float32 arithmetic does. A teardrop's
 * twelve corner angles are all different, the top four spread over 0.078
 * radians, so every choice here is decided by a margin.
 *
 * **And the ring is handed over backwards**, which is not a fudge: the order is
 * an input, and the two sides enumerate the same geometric ring differently.
 * Blender's own edge-loop walk on a wire ring built with edges `(i, i+1)` runs
 * **towards decreasing index** (measured — `probe-gridfill5.py` decodes it from
 * the faces, after ruling out the active vertex, which `fill_grid` prefers over
 * the corner rule when there is one and which forge3d has no notion of). Given
 * the ring in the order Blender walks it, everything below agrees to six
 * decimals; given it forwards, the grid comes out mirrored, which is the same
 * answer for the mirrored input.
 */

/** A ring with no faces — the shape the probes hand Blender. */
function ring(points: number[][]): MeshData {
  return { positions: Float32Array.from(points.flat()), polys: [] };
}

/** The ring in the order Blender's loop walk takes it: index 0, then down. */
const loopOf = (n: number): number[] => [0, ...Array.from({ length: n - 1 }, (_, i) => n - 1 - i)];

/** Radius swept so that no two turns are equal. The probes' formula. */
function teardrop(n = 12, r = 0.2): number[][] {
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    const rad = r * (1 + 0.35 * Math.sin(t) + 0.18 * Math.cos(2 * t + 0.7));
    return [Math.cos(t) * rad, 0, Math.sin(t) * rad];
  });
}

/** The same ring lifted out of plane — the only way to separate the two
 * interpolations, since a flat ring gives a flat interior either way. */
function bentTeardrop(n = 12, r = 0.2): number[][] {
  return teardrop(n, r).map(([x, , z]) => [x!, 0.6 * x! * z! + 0.05 * x!, z!]);
}

/** The boundary of an `nx` by `nz` grid, walked once round. */
function rectLoop(nx: number, nz: number, w = 0.4, d = 0.2): number[][] {
  const pts: number[][] = [];
  for (let i = 0; i < nx; i++) pts.push([-w / 2 + (w * i) / nx, 0, -d / 2]);
  for (let i = 0; i < nz; i++) pts.push([w / 2, 0, -d / 2 + (d * i) / nz]);
  for (let i = 0; i < nx; i++) pts.push([w / 2 - (w * i) / nx, 0, d / 2]);
  for (let i = 0; i < nz; i++) pts.push([-w / 2, 0, d / 2 - (d * i) / nz]);
  return pts;
}

/** The vertices the fill appended, in the order it appended them. */
function addedVerts(mesh: MeshData, before: number): number[][] {
  const out: number[][] = [];
  for (let v = before; v < mesh.positions.length / 3; v++)
    out.push([mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!]);
  return out;
}

/** Faces as sorted vertex lists, sorted — the same quads, without asking the
 * two sides to emit them in the same order. Which corner the grid starts at is
 * asserted by the positions; the emission order is not a property of the fill. */
const faceSets = (polys: readonly number[][]): number[][] =>
  polys
    .map((p) => [...p].sort((a, b) => a - b))
    .sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!);

function expectPoints(got: number[][], want: number[][]): void {
  expect(got).toHaveLength(want.length);
  got.forEach((p, i) =>
    p.forEach((c, k) => expect(c, `vertex ${i} axis ${k}`).toBeCloseTo(want[i]![k]!, 5)),
  );
}

describe("gridFill reproduces Blender's topology", () => {
  it("rebuilds a rectangular ring's own grid", () => {
    // Measured: 4x2 ring of 12 -> 15 verts / 8 quads; 4x4 -> 25 / 16;
    // 6x2 -> 21 / 12; 3x3 -> 16 / 9; 5x3 -> 24 / 15. Counts only — a
    // rectangle's four corners tie, so which way round the grid runs is
    // Blender's rounding and not something to assert.
    for (const [nx, nz, verts, faces] of [
      [4, 2, 15, 8],
      [4, 4, 25, 16],
      [6, 2, 21, 12],
      [3, 3, 16, 9],
      [5, 3, 24, 15],
    ]) {
      const loop = rectLoop(nx!, nz!);
      const out = gridFill(ring(loop), loopOf(loop.length));
      expect(out.positions.length / 3, `${nx}x${nz} verts`).toBe(verts);
      expect(out.polys.length, `${nx}x${nz} faces`).toBe(faces);
      for (const p of out.polys) expect(p).toHaveLength(4);
    }
  });

  it("walks the split as span moves", () => {
    // Measured on the teardrop of 12, where the choice is not a tie:
    // the calculated span gives 5 quads and no interior, and 2, 3, 4 give
    // 8, 9, 8. span 0 is clamped to 1 by the operator's RNA range, which is
    // why it produces the same mesh as span 1.
    const loop = teardrop();
    const base = ring(loop);
    for (const [span, faces, newVerts] of [
      [0, 5, 0],
      [1, 5, 0],
      [2, 8, 3],
      [3, 9, 4],
      [4, 8, 3],
      [5, 5, 0],
    ]) {
      const out = gridFill(base, loopOf(12), { span });
      expect(out.polys.length, `span ${span} faces`).toBe(faces);
      expect(out.positions.length / 3 - 12, `span ${span} new verts`).toBe(newVerts);
    }
  });

  it("calculates the span the way Blender calculates it", () => {
    // The teardrop's own corners put the span at 5 — one edge per side — so
    // the fill is a strip of 5 quads with nothing inside it.
    const out = gridFill(ring(teardrop()), loopOf(12));
    expect(out.polys).toHaveLength(5);
    expect(out.positions.length / 3).toBe(12);
    expect(faceSets(out.polys)).toEqual(
      faceSets([
        [4, 7, 6, 5],
        [3, 8, 7, 4],
        [2, 9, 8, 3],
        [1, 10, 9, 2],
        [0, 11, 10, 1],
      ]),
    );
  });

  it("refuses an odd ring, the way Blender does", () => {
    expect(() => gridFill(ring(teardrop(7)), loopOf(7))).toThrow(/even/);
  });

  it("fills a ring of four with a single quad and adds nothing", () => {
    const out = gridFill(ring(rectLoop(1, 1)), loopOf(4));
    expect(out.polys).toHaveLength(1);
    expect(out.positions.length / 3).toBe(4);
  });

  it("refuses a ring that repeats a vertex, or names one that is not there", () => {
    const base = ring(teardrop());
    expect(() => gridFill(base, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10])).toThrow(/twice/);
    expect(() => gridFill(base, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 99])).toThrow(/does not have/);
  });
});

describe("gridFill reproduces Blender's interior vertices", () => {
  it("places them by curvature, which is Blender's default", () => {
    const flat = ring(teardrop());
    expectPoints(addedVerts(gridFill(flat, loopOf(12), { span: 2 }), 12), [
      [-0.087178, 0, 0.112135],
      [0.002751, 0, 0.00964],
      [0.070325, 0, -0.06251],
    ]);
    expectPoints(addedVerts(gridFill(flat, loopOf(12), { span: 3 }), 12), [
      [0.044778, 0, 0.11598],
      [0.088164, 0, -0.026653],
      [-0.122046, 0, 0.089511],
      [-0.049685, 0, -0.035902],
    ]);
    expectPoints(addedVerts(gridFill(flat, loopOf(12), { span: 4 }), 12), [
      [0.123286, 0, 0.025039],
      [-0.002209, 0, 0.063564],
      [-0.126512, 0, 0.052984],
    ]);
  });

  it("places them by the flat blend when asked for simple interpolation", () => {
    const flat = ring(teardrop());
    expectPoints(addedVerts(gridFill(flat, loopOf(12), { span: 2, interpSimple: true }), 12), [
      [-0.071255, 0, 0.123134],
      [0, 0, 0.035],
      [0.049604, 0, -0.040634],
    ]);
    expectPoints(addedVerts(gridFill(flat, loopOf(12), { span: 3, interpSimple: true }), 12), [
      [0.040234, 0, 0.097906],
      [0.077224, 0, -0.014871],
      [-0.087327, 0, 0.079038],
      [-0.03013, 0, -0.022073],
    ]);
  });

  it("follows a ring out of its plane — the two schemes differ in y", () => {
    // This is what the default interpolation is for: the interior leaves the
    // plane because the boundary does. The simple blend gets a different
    // height at the same places, which is how the two are told apart.
    const bent = ring(bentTeardrop());
    expectPoints(addedVerts(gridFill(bent, loopOf(12), { span: 2 }), 12), [
      [-0.086738, -0.008929, 0.11239],
      [0.00327, 0.000451, 0.009929],
      [0.070608, -0.000287, -0.062477],
    ]);
    expectPoints(addedVerts(gridFill(bent, loopOf(12), { span: 2, interpSimple: true }), 12), [
      [-0.071255, -0.009422, 0.123134],
      [0, -0.000975, 0.035],
      [0.049604, -0.001908, -0.040634],
    ]);
    expectPoints(addedVerts(gridFill(bent, loopOf(12), { span: 3 }), 12), [
      [0.044758, 0.00695, 0.115735],
      [0.088071, 0.003191, -0.02708],
      [-0.121833, -0.010639, 0.089488],
      [-0.04954, -0.002613, -0.036177],
    ]);
  });

  it("puts the same faces on the grid as Blender does", () => {
    // Not just the positions: the same quads, by index, so a grid that came
    // out transposed or mirrored would fail even where the point set matches.
    const out = gridFill(ring(teardrop()), loopOf(12), { span: 2 });
    expect(faceSets(out.polys)).toEqual(
      faceSets([
        [2, 12, 4, 3],
        [12, 6, 5, 4],
        [1, 13, 12, 2],
        [13, 7, 6, 12],
        [0, 14, 13, 1],
        [14, 8, 7, 13],
        [11, 10, 14, 0],
        [10, 9, 8, 14],
      ]),
    );
  });
});

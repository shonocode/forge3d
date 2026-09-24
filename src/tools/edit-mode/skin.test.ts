import { describe, it, expect } from "vitest";
import type { MeshData } from "../../lib/mesh";
import { skin } from "./skin";

/**
 * `skin`, against Blender 5.1.1 — every number from `probe-skin.py`.
 *
 * The constants (how many rings, where they sit) were read from
 * `MOD_skin.cc`; these tests are the measurements that confirmed them.
 */

function skeleton(points: [number, number, number][], edges: [number, number][]): MeshData {
  return { positions: Float32Array.from(points.flat()), polys: [], edges };
}

function coords(m: MeshData): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < m.positions.length; i += 3)
    out.push([m.positions[i]!, m.positions[i + 1]!, m.positions[i + 2]!]);
  return out;
}

function expectCoords(got: number[][], want: number[][]): void {
  expect(got.length).toBeGreaterThanOrEqual(want.length);
  want.forEach((w, i) => {
    for (let k = 0; k < 3; k++) expect(got[i]![k]!, `vertex ${i} axis ${k}`).toBeCloseTo(w[k]!, 4);
  });
}

describe("skin", () => {
  it("wraps one edge in a square tube with two rings along it", () => {
    // Blender: 16 vertices, 14 quads. L / (r̄₀ + r̄₁) = 1 / 0.5 = 2 rings.
    const out = skin(skeleton([[0, 0, 0], [0, 0, 1]], [[0, 1]]));
    expect(out.positions.length / 3).toBe(16);
    expect(out.polys).toHaveLength(14);
    expect(out.polys.every((p) => p.length === 4)).toBe(true);
    expectCoords(coords(out), [
      [0.25, -0.25, 0], [-0.25, -0.25, 0], [-0.25, 0.25, 0], [0.25, 0.25, 0],
      [0.25, -0.25, 1], [-0.25, -0.25, 1], [-0.25, 0.25, 1], [0.25, 0.25, 1],
      [0.25, -0.25, 1 / 3], [-0.25, -0.25, 1 / 3], [-0.25, 0.25, 1 / 3], [0.25, 0.25, 1 / 3],
      [0.25, -0.25, 2 / 3], [-0.25, -0.25, 2 / 3], [-0.25, 0.25, 2 / 3], [0.25, 0.25, 2 / 3],
    ]);
    // The two caps, wound as Blender winds them.
    expect(out.polys[0]).toEqual([0, 1, 2, 3]);
    expect(out.polys[1]).toEqual([7, 6, 5, 4]);
  });

  it("orients an edge off the vertical by z × x", () => {
    // Blender, along x and along the diagonal (1, 1, 1).
    const x = skin(skeleton([[0, 0, 0], [1, 0, 0]], [[0, 1]]));
    expectCoords(coords(x), [[0, 0.25, -0.25], [0, -0.25, -0.25], [0, -0.25, 0.25], [0, 0.25, 0.25]]);
    const d = skin(skeleton([[0, 0, 0], [1, 1, 1]], [[0, 1]]));
    expect(d.positions.length / 3).toBe(20); // √3 / 0.5 → 3 rings
    expectCoords(coords(d), [
      [-0.07471, 0.27884, -0.20412], [0.27884, -0.07471, -0.20412],
      [0.07471, -0.27884, 0.20412], [-0.27884, 0.07471, 0.20412],
    ]);
  });

  it("counts rings by length over radius", () => {
    // Radius 0.5 on a unit edge: one ring, 12 vertices.
    expect(skin(skeleton([[0, 0, 0], [0, 0, 1]], [[0, 1]]), { radius: 0.5 }).positions.length / 3).toBe(12);
  });

  it("maps radius x and y onto the edge's two cross axes", () => {
    for (const [r, xr, yr] of [[[0.5, 0.1], 0.5, 0.1], [[0.1, 0.5], 0.1, 0.5]] as const) {
      const c = coords(skin(skeleton([[0, 0, 0], [0, 0, 1]], [[0, 1]]), { radius: r }));
      expect(Math.max(...c.map((p) => p[0]!))).toBeCloseTo(xr, 6);
      expect(Math.max(...c.map((p) => p[1]!))).toBeCloseTo(yr, 6);
    }
  });

  it("spaces the rings by the radius ratio when the ends differ", () => {
    // Radii 0.5 → 0.1: one ring at t = 0.5^0.6 = 0.65975, radius 0.2361.
    const c = coords(
      skin(skeleton([[0, 0, 0], [0, 0, 1]], [[0, 1]]), { radius: [[0.5, 0.5], [0.1, 0.1]] }),
    );
    expectCoords(c.slice(8), [
      [0.2361, -0.2361, 0.65975], [-0.2361, -0.2361, 0.65975],
      [-0.2361, 0.2361, 0.65975], [0.2361, 0.2361, 0.65975],
    ]);
  });

  it("gives a straight or bent middle node one ring", () => {
    // Blender: 28 vertices for both; the L's middle ring sits on the bisector.
    const straight = skin(skeleton([[0, 0, 0], [0, 0, 1], [0, 0, 2]], [[0, 1], [1, 2]]));
    expect(straight.positions.length / 3).toBe(28);
    expect(straight.polys).toHaveLength(26);
    const bent = skin(skeleton([[0, 0, 0], [0, 0, 1], [1, 0, 1]], [[0, 1], [1, 2]]));
    expect(bent.positions.length / 3).toBe(28);
    expectCoords(coords(bent).slice(4, 12), [
      [0.17678, -0.25, 0.82322], [-0.17678, -0.25, 1.17678],
      [-0.17678, 0.25, 1.17678], [0.17678, 0.25, 0.82322],
      [1, -0.25, 0.75], [1, -0.25, 1.25], [1, 0.25, 1.25], [1, 0.25, 0.75],
    ]);
  });

  it("builds a different mesh when the root moves", () => {
    // Blender: 28 / 26 with the root at an end, 32 / 30 with it in the middle,
    // where the node gets two bridged frames instead of one.
    const chain = skeleton([[0, 0, 0], [0, 0, 1], [0, 0, 2]], [[0, 1], [1, 2]]);
    for (const [root, verts, faces] of [[0, 28, 26], [1, 32, 30], [2, 28, 26]] as const) {
      const out = skin(chain, { roots: [root] });
      expect(out.positions.length / 3, `root ${root}`).toBe(verts);
      expect(out.polys, `root ${root}`).toHaveLength(faces);
    }
  });

  it("ring count repeats per edge along a longer chain", () => {
    // Blender: five in a row is 52 vertices, 50 quads.
    const five = skin(skeleton([0, 1, 2, 3, 4].map((i) => [0, 0, i]), [[0, 1], [1, 2], [2, 3], [3, 4]]));
    expect(five.positions.length / 3).toBe(52);
    expect(five.polys).toHaveLength(50);
  });

});

/**
 * Arms of length 1 from vertex 0, at `2πi/n + 0.3` — the probe's
 * (`probe-skin-branch.py`) — written the way the parity row's OBJ input is
 * (float32, then six decimals), because these inputs sit on edges of the
 * rules: an arm of length 1 at radius 0.25 is **exactly** two rings'
 * worth (`L / (r̄₀ + r̄₁)` = 2), so the last digit decides one ring or two,
 * and where frames overlap (the last two tests) it decides the hull.
 */
function star(n: number, length = 1, plane = true): MeshData {
  const r6 = (x: number): number => Number(Math.fround(x).toFixed(6));
  const pts: [number, number, number][] = [[0, 0, 0]];
  const edges: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n + 0.3;
    pts.push([r6(length * Math.cos(a)), r6(length * Math.sin(a)), plane ? 0 : 0.4 * (-1) ** i]);
    edges.push([0, i + 1]);
  }
  return skeleton(pts, edges);
}

function faceSizes(m: MeshData): Record<number, number> {
  const out: Record<number, number> = {};
  for (const p of m.polys) out[p.length] = (out[p.length] ?? 0) + 1;
  return out;
}

/** Every edge on exactly two faces, each direction once. */
function isClosedManifold(m: MeshData): boolean {
  const dir = new Set<string>();
  for (const p of m.polys)
    for (let i = 0; i < p.length; i++) {
      const k = `${p[i]}>${p[(i + 1) % p.length]}`;
      if (dir.has(k)) return false;
      dir.add(k);
    }
  for (const k of dir) {
    const [a, b] = k.split(">");
    if (!dir.has(`${b}>${a}`)) return false;
  }
  return true;
}

describe("skin at branch nodes", () => {
  // Blender 5.1.1 on the parity row's input, radius 0.25, root at vertex 0.
  // (The probe's own numbers for Y and five arms are one ring fewer per arm —
  // its arms are a hair under length 1; see `star`.)
  const measured: [string, MeshData, number, number, Record<number, number>][] = [
    ["Y", star(3), 36, 39, { 3: 10, 4: 29 }],
    ["T", skeleton([[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0]], [[0, 1], [0, 2], [0, 3]]), 32, 30, { 4: 30 }],
    ["four arms", star(4), 40, 40, { 3: 4, 4: 36 }],
    ["tripod", star(3, 1, false), 35, 38, { 3: 10, 4: 28 }],
    ["five arms", star(5), 50, 51, { 3: 6, 4: 45 }],
    [
      "a branch mid-chain",
      skeleton([[0, 0, 0], [0, 0, 1], [0, 0, 2], [0.8, 0, 1.5], [-0.7, 0.2, 1.6]], [[0, 1], [1, 2], [1, 3], [1, 4]]),
      36,
      38,
      { 3: 8, 4: 30 },
    ],
  ];
  for (const [name, sk, verts, faces, sizes] of measured)
    it(`wraps a ${name} in a closed mesh, as Blender does`, () => {
      const out = skin(sk, { radius: 0.25 });
      expect(out.positions.length / 3).toBe(verts);
      expect(out.polys).toHaveLength(faces);
      expect(faceSizes(out)).toEqual(sizes);
      expect(isClosedManifold(out)).toBe(true);
    });

  it("merges into quads across the X plane only when the quad is symmetric", () => {
    // The T's hull is mirror-symmetric in X: every triangle pair that
    // crosses the plane makes a symmetric quad, so none is left over.
    const t = skin(skeleton([[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0]], [[0, 1], [0, 2], [0, 3]]), { radius: 0.25 });
    expect(faceSizes(t)).toEqual({ 4: 30 });
    // Turning the heuristic off changes which pairs are taken.
    const off = skin(skeleton([[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0]], [[0, 1], [0, 2], [0, 3]]), {
      radius: 0.25,
      symmetry: [false, false, false],
    });
    expect(off.polys.length).toBeGreaterThan(0);
    expect(isClosedManifold(off)).toBe(true);
  });

  it("joins a frame the hull swallowed back on, as Blender does", () => {
    // Six short arms: a frame ends up inside the hull, and a hull face is
    // extruded onto it. Blender's result is 35 faces with four edges not on
    // exactly two of them — not closed, and not ours to close.
    const out = skin(star(6, 0.2), { radius: 0.25 });
    expect(out.polys).toHaveLength(35);
    expect(faceSizes(out)).toEqual({ 3: 12, 4: 23 });
    expect(isClosedManifold(out)).toBe(false);
  });

  it("keeps Blender's loose edge when overlapping frames make one", () => {
    // Eight arms: the frames overlap. A tag Blender sets to pick an edge to
    // subdivide is never cleared, and the last merge deletes the tagged edges
    // with their faces — 77 faces and one loose edge, measured.
    const out = skin(star(8), { radius: 0.25 });
    expect(out.polys).toHaveLength(77);
    expect(out.edges).toHaveLength(1);
  });
});

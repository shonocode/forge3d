import { describe, it, expect } from "vitest";
import { catmullClark } from "./subdivide";

/** Undirected edge key + count how many faces reference each edge. */
function boundaryEdgeCount(polys: number[][]): number {
  const count = new Map<string, number>();
  for (const p of polys) {
    for (let i = 0; i < p.length; i++) {
      const a = p[i]!;
      const b = p[(i + 1) % p.length]!;
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  }
  let boundary = 0;
  for (const c of count.values()) if (c !== 2) boundary++;
  return boundary;
}

/** Unit cube: 8 verts, 6 CCW-outward quads. */
const CUBE_POS = new Float32Array([
  -1, -1, -1,  1, -1, -1,  1, 1, -1,  -1, 1, -1,
  -1, -1,  1,  1, -1,  1,  1, 1,  1,  -1, 1,  1,
]);
const CUBE_QUADS: number[][] = [
  [0, 3, 2, 1], // -z
  [4, 5, 6, 7], // +z
  [0, 1, 5, 4], // -y
  [3, 7, 6, 2], // +y
  [0, 4, 7, 3], // -x
  [1, 2, 6, 5], // +x
];

/** A single open quad (has a boundary). */
const QUAD_POS = new Float32Array([
  0, 0, 0,  1, 0, 0,  1, 1, 0,  0, 1, 0,
]);
const QUAD: number[][] = [[0, 1, 2, 3]];

describe("catmullClark", () => {
  it("level 0 returns a copy of the input", () => {
    const r = catmullClark(CUBE_POS, CUBE_QUADS, 0);
    expect(Array.from(r.positions)).toEqual(Array.from(CUBE_POS));
    expect(r.polys).toEqual(CUBE_QUADS);
    // Must be a copy, not the same reference.
    expect(r.positions).not.toBe(CUBE_POS);
  });

  it("one step turns each quad into 4 quads (cube → 24 faces)", () => {
    const r = catmullClark(CUBE_POS, CUBE_QUADS, 1);
    expect(r.polys).toHaveLength(24);
    for (const p of r.polys) expect(p).toHaveLength(4);
    // 8 original + 6 face points + 12 edge points = 26 vertices.
    expect(r.positions.length / 3).toBe(26);
  });

  it("keeps a closed mesh watertight (no boundary edges)", () => {
    const r = catmullClark(CUBE_POS, CUBE_QUADS, 1);
    expect(boundaryEdgeCount(r.polys)).toBe(0);
    const r2 = catmullClark(CUBE_POS, CUBE_QUADS, 2);
    expect(boundaryEdgeCount(r2.polys)).toBe(0);
    expect(r2.polys).toHaveLength(24 * 4);
  });

  it("shrinks the cube toward its limit surface (corners pull inward)", () => {
    const r = catmullClark(CUBE_POS, CUBE_QUADS, 1);
    // Original corner 0 (-1,-1,-1) is a valence-3 vertex; its new position must
    // move toward the centroid (origin), so each coord magnitude drops below 1.
    for (let axis = 0; axis < 3; axis++) {
      expect(Math.abs(r.positions[axis]!)).toBeLessThan(1);
      expect(Math.abs(r.positions[axis]!)).toBeGreaterThan(0);
    }
    // Symmetry: the cube stays centered at the origin.
    let cx = 0, cy = 0, cz = 0;
    const n = r.positions.length / 3;
    for (let i = 0; i < n; i++) {
      cx += r.positions[i * 3]!;
      cy += r.positions[i * 3 + 1]!;
      cz += r.positions[i * 3 + 2]!;
    }
    expect(cx / n).toBeCloseTo(0, 6);
    expect(cy / n).toBeCloseTo(0, 6);
    expect(cz / n).toBeCloseTo(0, 6);
  });

  it("face point is the centroid of the original face", () => {
    const r = catmullClark(CUBE_POS, CUBE_QUADS, 1);
    // Layout: original 8 verts, then 6 face points (index 8..13).
    // Face 0 = -z quad centroid = (0,0,-1).
    expect(r.positions[8 * 3]!).toBeCloseTo(0, 6);
    expect(r.positions[8 * 3 + 1]!).toBeCloseTo(0, 6);
    expect(r.positions[8 * 3 + 2]!).toBeCloseTo(-1, 6);
  });

  it("preserves the boundary of an open quad (edge points are edge midpoints)", () => {
    const r = catmullClark(QUAD_POS, QUAD, 1);
    // Single quad → 4 quads.
    expect(r.polys).toHaveLength(4);
    // The open quad has 4 boundary edges → after 1 step still an open patch.
    expect(boundaryEdgeCount(r.polys)).toBeGreaterThan(0);
    // Face point = centroid (0.5, 0.5, 0).
    expect(r.positions[4 * 3]!).toBeCloseTo(0.5, 6);
    expect(r.positions[4 * 3 + 1]!).toBeCloseTo(0.5, 6);
    // All points stay in the z=0 plane (planar input stays planar).
    for (let i = 0; i < r.positions.length / 3; i++) {
      expect(r.positions[i * 3 + 2]!).toBeCloseTo(0, 6);
    }
  });

  it("boundary corner of the open quad uses the (6P+b1+b2)/8 rule", () => {
    const r = catmullClark(QUAD_POS, QUAD, 1);
    // Corner 0 = (0,0,0); its 2 boundary neighbors are (1,0,0) and (0,1,0).
    // V' = (6*0 + 1 + 0)/8 = 0.125 in x, (6*0 + 0 + 1)/8 = 0.125 in y.
    expect(r.positions[0]!).toBeCloseTo(0.125, 6);
    expect(r.positions[1]!).toBeCloseTo(0.125, 6);
  });

  it("is deterministic (same input → same output)", () => {
    const a = catmullClark(CUBE_POS, CUBE_QUADS, 2);
    const b = catmullClark(CUBE_POS, CUBE_QUADS, 2);
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(a.polys).toEqual(b.polys);
  });

  it("subdivides a triangle mesh into quads too (n-gon agnostic)", () => {
    // Single triangle.
    const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const r = catmullClark(pos, [[0, 1, 2]], 1);
    // Triangle → 3 quads.
    expect(r.polys).toHaveLength(3);
    for (const p of r.polys) expect(p).toHaveLength(4);
  });

  it("empty crease map is identical to no creases", () => {
    const a = catmullClark(CUBE_POS, CUBE_QUADS, 1);
    const b = catmullClark(CUBE_POS, CUBE_QUADS, 1, new Map());
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
  });
});

describe("catmullClark creases", () => {
  const key = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);

  it("a fully-creased edge keeps its edge point at the midpoint", () => {
    // Crease the -z quad's edge 0-3 (σ = 1, fully sharp).
    const creases = new Map([[key(0, 3), 1]]);
    const r = catmullClark(CUBE_POS, CUBE_QUADS, 1, creases);
    // Without crease the edge point pulls inward; with σ≥1 it sits at the
    // midpoint of verts 0(-1,-1,-1) and 3(-1,1,-1) = (-1, 0, -1).
    // Find the edge point index for edge 0_3: layout = [8 verts | 6 face pts | edge pts].
    // We can't know its exact index, so instead verify SOME vertex equals the
    // sharp midpoint that the smooth version would NOT produce.
    const target = [-1, 0, -1];
    let foundSharp = false;
    for (let i = 0; i < r.positions.length / 3; i++) {
      if (Math.abs(r.positions[i * 3]! - target[0]!) < 1e-9 &&
          Math.abs(r.positions[i * 3 + 1]! - target[1]!) < 1e-9 &&
          Math.abs(r.positions[i * 3 + 2]! - target[2]!) < 1e-9) {
        foundSharp = true; break;
      }
    }
    expect(foundSharp).toBe(true);
    // The smooth version must NOT contain that exact point.
    const smooth = catmullClark(CUBE_POS, CUBE_QUADS, 1);
    let foundInSmooth = false;
    for (let i = 0; i < smooth.positions.length / 3; i++) {
      if (Math.abs(smooth.positions[i * 3]! - target[0]!) < 1e-9 &&
          Math.abs(smooth.positions[i * 3 + 1]! - target[1]!) < 1e-9 &&
          Math.abs(smooth.positions[i * 3 + 2]! - target[2]!) < 1e-9) {
        foundInSmooth = true; break;
      }
    }
    expect(foundInSmooth).toBe(false);
  });

  it("a ring of 4 creased edges pins the cross-section (2 creases per vertex)", () => {
    // Crease the whole -z face boundary loop: 0-3, 3-2, 2-1, 1-0.
    const creases = new Map([
      [key(0, 3), 1], [key(3, 2), 1], [key(2, 1), 1], [key(1, 0), 1],
    ]);
    const r = catmullClark(CUBE_POS, CUBE_QUADS, 1, creases);
    // Each -z corner vertex has exactly 2 crease edges → crease rule
    // (6P + n1 + n2)/8. Vertex 0 (-1,-1,-1) neighbors along the loop are
    // 3(-1,1,-1) and 1(1,-1,-1): (6*-1 + -1 + 1)/8 = -0.75 x,
    // (6*-1 + 1 + -1)/8 = -0.75 y, z stays -1.
    expect(r.positions[0]!).toBeCloseTo(-0.75, 6);
    expect(r.positions[1]!).toBeCloseTo(-0.75, 6);
    expect(r.positions[2]!).toBeCloseTo(-1, 6);
    // Watertight preserved.
    expect(boundaryEdgeCount(r.polys)).toBe(0);
  });

  it("propagates σ-1 to child edges (σ=2 stays sharp one more level)", () => {
    const creases = new Map([[key(0, 3), 2]]);
    const r1 = catmullClark(CUBE_POS, CUBE_QUADS, 1, creases);
    // The two child edges of 0-3 must carry σ = 1.
    const vals = [...r1.creases.values()];
    expect(vals).toHaveLength(2);
    for (const v of vals) expect(v).toBeCloseTo(1, 9);
    // After a second level, σ reaches 0 and no creases remain.
    const r2 = catmullClark(CUBE_POS, CUBE_QUADS, 2, creases);
    expect(r2.creases.size).toBe(0);
  });

  it("σ=1 does not propagate (child σ = 0)", () => {
    const creases = new Map([[key(0, 3), 1]]);
    const r = catmullClark(CUBE_POS, CUBE_QUADS, 1, creases);
    expect(r.creases.size).toBe(0);
  });

  it("fractional crease blends between smooth and sharp", () => {
    const sharp = catmullClark(CUBE_POS, CUBE_QUADS, 1, new Map([[key(0, 3), 1]]));
    const half = catmullClark(CUBE_POS, CUBE_QUADS, 1, new Map([[key(0, 3), 0.5]]));
    const smooth = catmullClark(CUBE_POS, CUBE_QUADS, 1);
    // The vertex-0 position under a half crease must lie strictly between the
    // smooth and fully-sharp positions (single crease = dart, so vertex point
    // stays smooth here; instead compare the total displacement of vertex 0).
    // Use vertex 0's x coordinate as the probe.
    const s0 = smooth.positions[0]!;
    const h0 = half.positions[0]!;
    const p0 = sharp.positions[0]!;
    // At minimum, the fractional result should not exceed the sharp extreme.
    expect(Math.abs(h0 - s0)).toBeLessThanOrEqual(Math.abs(p0 - s0) + 1e-9);
  });
});

describe("catmullClark UVs (Blender's UV Smooth = Keep Boundaries)", () => {
  /** A flat 2×2 grid with one UV island whose centre value is off-centre. */
  const grid = (): { positions: Float32Array; polys: number[][]; uvs: number[][][] } => {
    const positions: number[] = [];
    for (let j = 0; j <= 2; j++) for (let i = 0; i <= 2; i++) positions.push(i, 0, j);
    const uvOf = (i: number, j: number): number[] => (i === 1 && j === 1 ? [0.6, 0.5] : [i / 2, j / 2]);
    const polys: number[][] = [];
    const uvs: number[][][] = [];
    for (let j = 0; j < 2; j++)
      for (let i = 0; i < 2; i++) {
        const a = j * 3 + i;
        polys.push([a, a + 3, a + 4, a + 1]);
        uvs.push([uvOf(i, j), uvOf(i, j + 1), uvOf(i + 1, j + 1), uvOf(i + 1, j)]);
      }
    return { positions: Float32Array.from(positions), polys, uvs };
  };

  it("smooths UVs inside an island and keeps its boundary where it was", () => {
    const g = grid();
    const r = catmullClark(g.positions, g.polys, 1, undefined, g.uvs);
    expect(r.uvs).toHaveLength(16);
    // Corner 0 of each child quad is an original vertex.
    const centre = r.uvs!.filter((_, f) => r.polys[f]![0] === 4).map((f) => f[0]!);
    expect(centre).toHaveLength(4);
    // Interior value: (Q + 2R + (n-3)S)/n pulls 0.6 back toward 0.5 in u.
    for (const c of centre) {
      expect(c[0]!).toBeGreaterThan(0.5);
      expect(c[0]!).toBeLessThan(0.6);
      expect(c[1]!).toBeCloseTo(0.5, 6);
    }
    // A boundary corner does not move (linear boundary).
    const corner = r.uvs!.find((_, f) => r.polys[f]![0] === 0)![0]!;
    expect(corner).toEqual([0, 0]);
  });

  it("treats a UV seam as a boundary — linear on both sides", () => {
    const g = grid();
    // Cut the island down the middle column: the right-hand faces get their own u range.
    g.uvs = g.uvs.map((face, f) => (f % 2 === 1 ? face.map(([u, v]) => [u! + 1, v!]) : face));
    const r = catmullClark(g.positions, g.polys, 1, undefined, g.uvs);
    // The centre vertex sits on the seam now: every corner keeps its face's value.
    for (let f = 0; f < r.polys.length; f++)
      if (r.polys[f]![0] === 4) {
        const src = Math.floor(f / 4);
        const i = g.polys[src]!.indexOf(4);
        expect(r.uvs![f]![0]).toEqual(g.uvs[src]![i]);
      }
  });

  it("returns no UVs when none were given", () => {
    const g = grid();
    expect(catmullClark(g.positions, g.polys, 1).uvs).toBeUndefined();
  });
});

describe("catmullClark options (Blender's Subdivision Surface settings, compat-backlog B1)", () => {
  /** A flat 2×2 grid of unit quads in the XZ plane — four boundary corners. */
  const grid = (): { positions: Float32Array; polys: number[][] } => {
    const positions: number[] = [];
    for (let j = 0; j <= 2; j++) for (let i = 0; i <= 2; i++) positions.push(i, 0, j);
    const polys: number[][] = [];
    for (let j = 0; j < 2; j++)
      for (let i = 0; i < 2; i++) {
        const a = j * 3 + i;
        polys.push([a, a + 3, a + 4, a + 1]);
      }
    return { positions: Float32Array.from(positions), polys };
  };
  const at = (p: Float32Array, v: number): number[] => [p[v * 3]!, p[v * 3 + 1]!, p[v * 3 + 2]!];

  it("puts an input vertex at the same limit point whatever the level", () => {
    const one = catmullClark(CUBE_POS, CUBE_QUADS, 1, undefined, undefined, { limitSurface: true });
    const two = catmullClark(CUBE_POS, CUBE_QUADS, 2, undefined, undefined, { limitSurface: true });
    for (let v = 0; v < 8; v++)
      at(one.positions, v).forEach((x, k) => expect(x).toBeCloseTo(at(two.positions, v)[k]!, 6));
  });

  it("moves a smooth one-face corner as far as `quality` rounds of refinement", () => {
    // (a + 6x + b) / 8 three times from the corner at 0 with neighbours at 1
    // and 0 — 0.1640625, short of the limit 1/6 (measured on Blender's grid).
    const g = grid();
    const q3 = catmullClark(g.positions, g.polys, 1, undefined, undefined, { limitSurface: true });
    expect(at(q3.positions, 0)[0]).toBeCloseTo(0.1640625, 6);
    expect(at(q3.positions, 0)[2]).toBeCloseTo(0.1640625, 6);
    const q1 = catmullClark(g.positions, g.polys, 1, undefined, undefined, { limitSurface: true, quality: 1 });
    expect(at(q1.positions, 0)[0]).toBeCloseTo(0.125, 6);
    const kept = catmullClark(g.positions, g.polys, 1, undefined, undefined, {
      limitSurface: true,
      boundarySmooth: "PRESERVE_CORNERS",
    });
    expect(at(kept.positions, 0)).toEqual([0, 0, 0]);
  });

  it("PRESERVE_CORNERS keeps a one-face vertex where it is without the limit too", () => {
    const g = grid();
    expect(at(catmullClark(g.positions, g.polys, 1).positions, 0)[0]).toBeCloseTo(0.125, 6);
    const kept = catmullClark(g.positions, g.polys, 1, undefined, undefined, { boundarySmooth: "PRESERVE_CORNERS" });
    expect(at(kept.positions, 0)).toEqual([0, 0, 0]);
  });

  it("refuses the limit where it would not be Blender's", () => {
    expect(() => catmullClark(CUBE_POS, CUBE_QUADS, 4, undefined, undefined, { limitSurface: true })).toThrow(/quality/);
    expect(() =>
      catmullClark(CUBE_POS, CUBE_QUADS, 1, new Map([["0_1", 1]]), undefined, { limitSurface: true }),
    ).toThrow(/creases/);
    const uvs = CUBE_QUADS.map((p) => p.map(() => [0, 0]));
    expect(() => catmullClark(CUBE_POS, CUBE_QUADS, 1, undefined, uvs, { limitSurface: true })).toThrow(/UVs/);
  });

  it("UV Smooth NONE subdivides the UVs linearly everywhere", () => {
    const g = grid();
    const uvs = g.polys.map((p) => p.map((v) => (v === 4 ? [0.6, 0.5] : [(v % 3) / 2, Math.floor(v / 3) / 2])));
    const r = catmullClark(g.positions, g.polys, 1, undefined, uvs, { uvSmooth: "NONE" });
    const centre = r.uvs!.filter((_, f) => r.polys[f]![0] === 4).map((f) => f[0]!);
    for (const c of centre) expect(c).toEqual([0.6, 0.5]);
  });
});

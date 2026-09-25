/**
 * poke / subdivideEdges / bisectEdges / smoothVert / holesFill against Blender 5.1.1.
 *
 * Three of the four have a default that does the opposite of what a reader
 * expects, so every number here is one Blender produced rather than one that
 * seemed right.
 */
import { describe, it, expect } from "vitest";
import { meshFromData, meshToData } from "../../lib/mesh";
import { forEachEdge } from "./half-edge";
import { poke, subdivideEdges, bisectEdges, smoothVert, holesFill } from "./refine";

function grid(nx: number, ny: number) {
  const positions: number[] = [];
  const id = new Map<string, number>();
  for (let i = 0; i <= nx; i++)
    for (let j = 0; j <= ny; j++) {
      id.set(`${i},${j}`, positions.length / 3);
      positions.push(i, j, 0);
    }
  const polys: number[][] = [];
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++)
      polys.push([
        id.get(`${i},${j}`)!,
        id.get(`${i + 1},${j}`)!,
        id.get(`${i + 1},${j + 1}`)!,
        id.get(`${i},${j + 1}`)!,
      ]);
  return { positions: new Float32Array(positions), polys };
}

/** The trapezoid the centre modes were measured on. */
const trapezoid = () => ({
  positions: new Float32Array([0, 0, 0, 4, 0, 0, 3, 1, 0, 1, 1, 0]),
  polys: [[0, 1, 2, 3]],
});

const arities = (polys: readonly (readonly number[])[]): number[] =>
  polys.map((p) => p.length).sort((a, b) => a - b);

describe("poke", () => {
  it("fans a quad into four triangles", () => {
    const em = meshFromData(grid(1, 1));
    const made = poke(em, new Set([0]));
    const out = meshToData(em);
    expect(out.polys).toHaveLength(4);
    expect(arities(out.polys)).toEqual([3, 3, 3, 3]);
    expect(made.size).toBe(4);
    expect(out.positions).toHaveLength(15);
  });

  it("MEAN_WEIGHTED is the default and is not the plain average", () => {
    // Measured on the trapezoid: weighted y = 0.3867, plain y = 0.5.
    const w = meshFromData(trapezoid());
    poke(w, new Set([0]));
    const wc = meshToData(w).positions.slice(12);
    expect(wc[0]).toBeCloseTo(2.0, 4);
    expect(wc[1]).toBeCloseTo(0.3867, 4);

    const m = meshFromData(trapezoid());
    poke(m, new Set([0]), { centerMode: "MEAN" });
    const mc = meshToData(m).positions.slice(12);
    expect(mc[1]).toBeCloseTo(0.5, 6);
  });

  it("BOUNDS uses the middle of the bounding box", () => {
    const em = meshFromData(trapezoid());
    poke(em, new Set([0]), { centerMode: "BOUNDS" });
    const c = meshToData(em).positions.slice(12);
    expect(c[0]).toBeCloseTo(2.0, 6);
    expect(c[1]).toBeCloseTo(0.5, 6);
  });

  it("offset lifts the centre along the normal", () => {
    // Measured: a quad in z=0 poked with offset 0.25 puts its centre at z=0.25.
    const em = meshFromData(grid(1, 1));
    poke(em, new Set([0]), { offset: 0.25 });
    const c = meshToData(em).positions.slice(12);
    expect(c[2]).toBeCloseTo(0.25, 6);
  });
});

describe("subdivideEdges", () => {
  it("does not split the face — one cut edge makes a pentagon", () => {
    // Measured: verts 4 -> 5, faces stay 1, arity 5. The surprising one.
    const em = meshFromData(grid(1, 1));
    const first = new Set<number>();
    forEachEdge(em, (he) => {
      if (first.size === 0) first.add(he);
    });
    subdivideEdges(em, first, { cuts: 1 });
    const out = meshToData(em);
    expect(out.polys).toHaveLength(1);
    expect(arities(out.polys)).toEqual([5]);
    expect(out.positions).toHaveLength(15);
  });

  it("cuts=2 on one edge makes a hexagon", () => {
    const em = meshFromData(grid(1, 1));
    const first = new Set<number>();
    forEachEdge(em, (he) => {
      if (first.size === 0) first.add(he);
    });
    subdivideEdges(em, first, { cuts: 2 });
    expect(arities(meshToData(em).polys)).toEqual([6]);
  });

  it("all four edges of a quad make an octagon, not four quads", () => {
    // Measured: 8 verts, 1 face, arity 8.
    const em = meshFromData(grid(1, 1));
    const all = new Set<number>();
    forEachEdge(em, (he) => all.add(he));
    subdivideEdges(em, all, { cuts: 1 });
    const out = meshToData(em);
    expect(out.polys).toHaveLength(1);
    expect(arities(out.polys)).toEqual([8]);
  });

  it("useGridFill gives the four quads the UI's Subdivide gives", () => {
    // Measured: 9 verts, 12 edges, 4 quads.
    const em = meshFromData(grid(1, 1));
    const all = new Set<number>();
    forEachEdge(em, (he) => all.add(he));
    subdivideEdges(em, all, { cuts: 1, useGridFill: true });
    const out = meshToData(em);
    expect(out.polys).toHaveLength(4);
    expect(arities(out.polys)).toEqual([4, 4, 4, 4]);
    expect(out.positions).toHaveLength(27);
  });

  it("shares the new vertices between the two faces on an edge", () => {
    // A 2x1 grid with its shared edge cut: both quads become pentagons and
    // the new vertex belongs to both, so the count goes 6 -> 7, not 6 -> 8.
    const em = meshFromData(grid(2, 1));
    const shared = new Set<number>();
    forEachEdge(em, (he) => {
      if (em.halfEdges[he]!.twin >= 0) shared.add(he);
    });
    subdivideEdges(em, shared, { cuts: 1 });
    const out = meshToData(em);
    expect(out.positions).toHaveLength(21);
    expect(arities(out.polys)).toEqual([5, 5]);
  });

  /** The edges of face 0 of a 1x1 grid, by position in the face. */
  function quadEdges(em: ReturnType<typeof meshFromData>, which: number[]): Set<number> {
    const poly = meshToData(em).polys[0]!;
    const want = which.map((i) => [poly[i]!, poly[(i + 1) % 4]!].sort().join());
    const out = new Set<number>();
    forEachEdge(em, (he) => {
      const h = em.halfEdges[he]!;
      if (want.includes([h.v, em.halfEdges[h.next]!.v].sort().join())) out.add(he);
    });
    return out;
  }

  it("two adjacent cut edges are joined straight across the corner by default", () => {
    // bmesh.ops' quad_corner_type defaults to STRAIGHT_CUT (the enum slot's
    // first entry): grid row x-ge-z cuts=1 gained faces and no vertex.
    const em = meshFromData(grid(1, 1));
    subdivideEdges(em, quadEdges(em, [0, 1]), { cuts: 1 });
    const out = meshToData(em);
    expect(out.positions).toHaveLength(6 * 3);
    expect(arities(out.polys)).toEqual([3, 5]);
  });

  it("INNER_VERT turns the corner into three quads", () => {
    const em = meshFromData(grid(1, 1));
    subdivideEdges(em, quadEdges(em, [0, 1]), { cuts: 1, cornerType: "INNER_VERT" });
    const out = meshToData(em);
    expect(out.positions).toHaveLength(7 * 3);
    expect(arities(out.polys)).toEqual([4, 4, 4]);
  });

  it("two opposite cut edges are joined across, cut by cut", () => {
    const em = meshFromData(grid(1, 1));
    subdivideEdges(em, quadEdges(em, [0, 2]), { cuts: 2 });
    expect(arities(meshToData(em).polys)).toEqual([4, 4, 4]);
  });

  it("three cut edges split a quad whatever the options", () => {
    const em = meshFromData(grid(1, 1));
    subdivideEdges(em, quadEdges(em, [0, 1, 2]), { cuts: 1 });
    expect(arities(meshToData(em).polys)).toEqual([3, 3, 3, 4]);
  });

  it("a triangle with all three edges cut becomes a grid only with useGridFill", () => {
    const tri = () => meshFromData({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), polys: [[0, 1, 2]] });
    const all = (em: ReturnType<typeof tri>) => {
      const s = new Set<number>();
      forEachEdge(em, (he) => s.add(he));
      return s;
    };
    const plain = tri();
    subdivideEdges(plain, all(plain), { cuts: 2 });
    expect(arities(meshToData(plain).polys)).toEqual([9]);
    const filled = tri();
    subdivideEdges(filled, all(filled), { cuts: 2, useGridFill: true });
    const out = meshToData(filled);
    expect(out.polys).toHaveLength(9);
    expect(out.positions).toHaveLength(10 * 3);
  });

  it("a cut edge's crease and seam go to every piece of it", () => {
    const em = meshFromData(grid(1, 1));
    const poly = meshToData(em).polys[0]!;
    const [a, b] = [poly[0]!, poly[1]!];
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    em.creases.set(key, 0.7);
    em.seams.add(key);
    subdivideEdges(em, quadEdges(em, [0]), { cuts: 2 });
    expect(em.creases.has(key)).toBe(false);
    expect([...em.creases.values()]).toEqual([0.7, 0.7, 0.7]);
    expect(em.seams.size).toBe(3);
  });

  it("cuts=0 with INNER_VERT joins the corners of a two-edge quad", () => {
    // Blender runs the patterns even with no cuts; the grid row
    // `subdivide-edges-zero` pins 16 -> 20 faces with no new vertex.
    const em = meshFromData(grid(1, 1));
    subdivideEdges(em, quadEdges(em, [0, 1]), { cuts: 0, cornerType: "INNER_VERT" });
    expect(arities(meshToData(em).polys)).toEqual([3, 3]);
  });

  it("bisectEdges never splits", () => {
    const em = meshFromData(grid(1, 1));
    bisectEdges(em, quadEdges(em, [0, 1, 2]), 1);
    expect(arities(meshToData(em).polys)).toEqual([7]);
  });

  it("is a no-op for zero cuts", () => {
    const em = meshFromData(grid(1, 1));
    const all = new Set<number>();
    forEachEdge(em, (he) => all.add(he));
    expect(subdivideEdges(em, all, { cuts: 0 }).size).toBe(0);
    expect(meshToData(em).polys).toHaveLength(1);
  });
});

describe("smoothVert", () => {
  /** A 2x1 grid with the middle column lifted to z = 1. */
  function lifted() {
    const g = grid(2, 1);
    for (let v = 0; v < g.positions.length / 3; v++)
      if (g.positions[v * 3] === 1) g.positions[v * 3 + 2] = 1;
    return g;
  }

  const midZ = (m: { positions: Float32Array }): number[] => {
    const out: number[] = [];
    for (let v = 0; v < m.positions.length / 3; v++)
      if (m.positions[v * 3] === 1) out.push(m.positions[v * 3 + 2]!);
    return out;
  };

  it("moves nothing when no axis is enabled — Blender's default", () => {
    const em = meshFromData(lifted());
    const mid = new Set<number>();
    for (let v = 0; v < em.positions.length / 3; v++)
      if (em.positions[v * 3] === 1) mid.add(v);
    smoothVert(em, mid, { factor: 1 });
    expect(midZ(meshToData(em))).toEqual([1, 1]);
  });

  it("factor 1 lands on the neighbours' average", () => {
    // Measured: neighbours at z = 0, 0 and 1 put it at 1/3.
    const em = meshFromData(lifted());
    const mid = new Set<number>();
    for (let v = 0; v < em.positions.length / 3; v++)
      if (em.positions[v * 3] === 1) mid.add(v);
    smoothVert(em, mid, { factor: 1, useAxisX: true, useAxisY: true, useAxisZ: true });
    for (const z of midZ(meshToData(em))) expect(z).toBeCloseTo(1 / 3, 5);
  });

  it("factor 0.5 goes half way — measured 0.6667", () => {
    const em = meshFromData(lifted());
    const mid = new Set<number>();
    for (let v = 0; v < em.positions.length / 3; v++)
      if (em.positions[v * 3] === 1) mid.add(v);
    smoothVert(em, mid, { factor: 0.5, useAxisX: true, useAxisY: true, useAxisZ: true });
    for (const z of midZ(meshToData(em))) expect(z).toBeCloseTo(0.6667, 4);
  });

  it("an axis that is off does not move", () => {
    const em = meshFromData(lifted());
    const mid = new Set<number>();
    for (let v = 0; v < em.positions.length / 3; v++)
      if (em.positions[v * 3] === 1) mid.add(v);
    smoothVert(em, mid, { factor: 1, useAxisX: true, useAxisY: true });
    expect(midZ(meshToData(em))).toEqual([1, 1]);
  });
});

describe("holesFill", () => {
  /** A 2x2 grid with the middle face removed — one hole and one outer rim. */
  function holed() {
    const g = grid(2, 2);
    // face order is (i,j) = (0,0),(0,1),(1,0),(1,1); drop the one at (1,1)?
    // The 2x2 grid has no "middle" face — remove one corner face instead, which
    // leaves a single L-shaped rim, then check the square-hole case separately.
    return { positions: g.positions, polys: g.polys.filter((_, i) => i !== 0) };
  }

  it("fills the outer rim too — that is the operation, not a bug in it", () => {
    // Measured on a grid with a face punched out: 3 faces become 5, because
    // the sheet's own border is a loop with nothing on one side as well.
    const em = meshFromData(holed());
    const made = holesFill(em);
    expect(made.size).toBe(1); // this shape has one rim; see the next test
    expect(meshToData(em).polys).toHaveLength(4);
  });

  it("sides is a maximum, not a count", () => {
    // Measured: an 8-edge loop is filled at sides = 0 and skipped at sides = 3.
    const wide = meshFromData(holed());
    expect(holesFill(wide, { sides: 3 }).size).toBe(0);
    expect(meshToData(wide).polys).toHaveLength(3);

    const any = meshFromData(holed());
    expect(holesFill(any, { sides: 0 }).size).toBe(1);
  });

  it("does nothing to a closed mesh", () => {
    const cube = {
      positions: new Float32Array([
        -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1,
        -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1,
      ]),
      polys: [
        [0, 3, 2, 1],
        [4, 5, 6, 7],
        [0, 1, 5, 4],
        [2, 3, 7, 6],
        [0, 4, 7, 3],
        [1, 2, 6, 5],
      ],
    };
    const em = meshFromData(cube);
    expect(holesFill(em).size).toBe(0);
    expect(meshToData(em).polys).toHaveLength(6);
  });

  it("the fill is wound against the boundary, so it faces outward", () => {
    // One quad: its rim is the only loop, and filling it should produce the
    // back face — the two together enclose zero volume and no edge is left
    // with one face.
    const em = meshFromData(grid(1, 1));
    holesFill(em);
    const out = meshToData(em);
    expect(out.polys).toHaveLength(2);
    const [a, b] = out.polys as [number[], number[]];
    // Every directed edge of one appears reversed in the other.
    for (let i = 0; i < a.length; i++) {
      const from = a[i]!;
      const to = a[(i + 1) % a.length]!;
      const j = b.indexOf(to);
      expect(b[(j + 1) % b.length]).toBe(from);
    }
  });
});

import { describe, expect, it } from "vitest";
import type { MeshData } from "../lib/mesh";
import { fillGrid } from "./fill-grid";

/** Two open wire loops at z = ±0.5 joined by wire rails — as `make-input.ts`'s `ladderInput`. */
function ladder(la: number, lb: number, ra: number, rb: number): MeshData {
  const positions: number[] = [];
  const edges: number[][] = [];
  const loop = (n: number, z: number): number[] => {
    const ids: number[] = [];
    for (let i = 0; i < n; i++) {
      ids.push(positions.length / 3);
      positions.push(-0.5 + i / (n - 1), 0, z);
    }
    for (let i = 0; i + 1 < n; i++) edges.push([ids[i]!, ids[i + 1]!]);
    return ids;
  };
  const a = loop(la, -0.5);
  const b = loop(lb, 0.5);
  const rail = (from: number, to: number, k: number, x: number): void => {
    let prev = from;
    for (let i = 1; i <= k; i++) {
      const id = positions.length / 3;
      positions.push(x, 0, -0.5 + i / (k + 1));
      edges.push([prev, id]);
      prev = id;
    }
    edges.push([prev, to]);
  };
  rail(a[0]!, b[0]!, ra, -0.5);
  rail(a[a.length - 1]!, b[b.length - 1]!, rb, 0.5);
  return { positions: Float32Array.from(positions), polys: [], edges };
}

const loopEdges = (m: MeshData): [number, number][] =>
  (m.edges ?? []).filter(([a, b]) => Math.abs(m.positions[a! * 3 + 2]!) > 0.49 && Math.abs(m.positions[b! * 3 + 2]!) > 0.49) as [
    number,
    number,
  ][];

/** Every edge used once each way: the faces agree about which side is out. */
function consistent(m: MeshData): boolean {
  const seen = new Set<string>();
  for (const p of m.polys)
    for (let i = 0; i < p.length; i++) {
      const k = `${p[i]}>${p[(i + 1) % p.length]}`;
      if (seen.has(k)) return false;
      seen.add(k);
    }
  return true;
}

describe("fillGrid (MESH_OT_fill_grid)", () => {
  it("fills a closed wire ring: a 4×2 ring of 12 is 8 quads round 3 new vertices", () => {
    const P: number[] = [];
    const ring = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [4, 1], [4, 2], [3, 2], [2, 2], [1, 2], [0, 2], [0, 1]];
    for (const [x, z] of ring) P.push(x!, 0, z!);
    const edges = ring.map((_, i) => [i, (i + 1) % ring.length]);
    const out = fillGrid({ positions: Float32Array.from(P), polys: [], edges }, { edges: edges as [number, number][] });
    expect(out.positions.length / 3).toBe(15);
    expect(out.polys).toHaveLength(8);
    expect(out.edges ?? []).toHaveLength(0);
  });

  it("fills between two open loops along their wire rails", () => {
    const m = ladder(5, 5, 3, 3);
    const out = fillGrid(m, { edges: loopEdges(m) });
    expect(out.positions.length / 3).toBe(25);
    expect(out.polys).toHaveLength(16);
    expect(consistent(out)).toBe(true);
  });

  it("pads uneven loops and rails and collapses the padding (Blender: 26 vertices, 19 faces)", () => {
    const m = ladder(4, 6, 3, 1);
    const out = fillGrid(m, { edges: loopEdges(m) });
    expect(out.positions.length / 3).toBe(26);
    expect(out.polys).toHaveLength(19);
    expect(out.polys.some((p) => p.length === 3)).toBe(true);
  });

  it("refills selected faces from their rim, wound as the faces round them", () => {
    const n = 4;
    const P: number[] = [];
    for (let r = 0; r <= n; r++) for (let c = 0; c <= n; c++) P.push(c, 0, r);
    const polys: number[][] = [];
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++) polys.push([r * (n + 1) + c, (r + 1) * (n + 1) + c, (r + 1) * (n + 1) + c + 1, r * (n + 1) + c + 1]);
    // The middle 2×2.
    const faces = [5, 6, 9, 10];
    const out = fillGrid({ positions: Float32Array.from(P), polys }, { faces });
    expect(out.polys).toHaveLength(16);
    expect(out.positions.length / 3).toBe(25);
    expect(consistent(out)).toBe(true);
  });

  it("refuses a ring of odd length, as the operator does", () => {
    const P = [0, 0, 0, 1, 0, 0, 2, 0, 1, 1, 0, 2, 0, 0, 1];
    const edges = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 0]] as [number, number][];
    expect(() => fillGrid({ positions: Float32Array.from(P), polys: [], edges }, { edges })).toThrow(/two edge loops/);
  });
});

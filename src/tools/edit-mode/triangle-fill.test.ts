import { describe, it, expect } from "vitest";
import { meshFromData } from "../../lib/mesh";
import { triangleFill } from "./refine";
import { toPolygons } from "./half-edge";
import { crtQsort } from "./triangle-fill";

/** Boundary half-edges, one per edge. */
function boundary(em: ReturnType<typeof meshFromData>): Set<number> {
  const out = new Set<number>();
  em.halfEdges.forEach((h, i) => {
    if (h.twin < 0) out.add(i);
  });
  return out;
}

describe("crtQsort", () => {
  it("sorts, and orders ties the way the Windows C runtime does", () => {
    const a = [5, 3, 9, 1, 7, 2, 8, 6, 4, 0, 11, 10];
    crtQsort(a, (x, y) => x - y);
    expect(a).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    // Four equal keys through `shortsort`: the first lands last.
    const t = [
      { k: 1, id: "A" },
      { k: 1, id: "B" },
      { k: 1, id: "C" },
      { k: 1, id: "D" },
    ];
    crtQsort(t, (x, y) => x.k - y.k);
    expect(t.map((x) => x.id).join("")).toBe("BCDA");
  });
});

describe("triangleFill", () => {
  it("closes an open cube with two triangles wound like the rest", () => {
    const P = [-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5];
    const polys = [[4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]]; // -z missing
    const em = meshFromData({ positions: Float32Array.from(P), polys });
    const made = triangleFill(em, boundary(em));
    expect(made.size).toBe(2);
    // Closed and consistently wound: every directed edge once, its reverse once.
    const dir = new Set<string>();
    for (const p of toPolygons(em)) p.forEach((u, i) => dir.add(`${u}>${p[(i + 1) % p.length]}`));
    for (const k of dir) {
      const [u, v] = k.split(">");
      expect(dir.has(`${v}>${u}`)).toBe(true);
    }
    expect(dir.size).toBe(24 + 2); // the cube's 12 edges, and the new diagonal, both ways
  });

  it("fills a concave hole without crossing it", () => {
    // An L-shaped hole in the xy plane, framed by one quad so it has a boundary.
    const L = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]];
    const P: number[] = [];
    for (const [x, y] of L) P.push(x!, y!, 0);
    for (const [x, y] of L) P.push(x!, y!, 1); // a wall around it, so the loop is a boundary
    const n = L.length;
    const polys: number[][] = [];
    for (let i = 0; i < n; i++) polys.push([i, (i + 1) % n, n + ((i + 1) % n), n + i]);
    const em = meshFromData({ positions: Float32Array.from(P), polys });
    const bottom = new Set([...boundary(em)].filter((he) => em.positions[em.halfEdges[he]!.v * 3 + 2] === 0));
    triangleFill(em, bottom);
    const tris = toPolygons(em).slice(n);
    expect(tris).toHaveLength(n - 2);
    // Their area is the L's: 3.
    let area = 0;
    for (const t of tris) {
      const [a, b, c] = t.map((v) => [P[v * 3]!, P[v * 3 + 1]!]);
      area += Math.abs((b![0]! - a![0]!) * (c![1]! - a![1]!) - (c![0]! - a![0]!) * (b![1]! - a![1]!)) / 2;
    }
    expect(area).toBeCloseTo(3, 6);
  });
});

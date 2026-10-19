import { describe, it, expect } from "vitest";
import { extrudeContext } from "./extrude-context";
import { canonicalEdge, edgeEnd, edgeOrigin, forEachEdge, toPolygons, type EditMesh } from "./half-edge";
import { extrudeRepeat } from "./face-transform";
import { meshFromData } from "../../lib/mesh";

/** The parity `grid`: 5 × 5 vertices in the xz plane, row-major along z, 16 quads. */
function grid(): EditMesh {
  const positions: number[] = [];
  for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) positions.push(-0.2 + c * 0.1, 0, -0.2 + r * 0.1);
  const polys: number[][] = [];
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++) polys.push([r * 5 + c, (r + 1) * 5 + c, (r + 1) * 5 + c + 1, r * 5 + c + 1]);
  return meshFromData({ positions: Float32Array.from(positions), polys });
}

function edgeIds(em: EditMesh, pairs: [number, number][]): Set<number> {
  const out = new Set<number>();
  for (const [a, b] of pairs)
    forEachEdge(em, (he) => {
      const x = edgeOrigin(em, he);
      const y = edgeEnd(em, he);
      if ((x === a && y === b) || (x === b && y === a)) out.add(canonicalEdge(em, he));
    });
  return out;
}

/** How many faces use each edge — a 3 is the non-manifold edge the old edge-mode E left. */
function maxFacesOnEdge(em: EditMesh): number {
  const n = new Map<string, number>();
  for (const p of toPolygons(em))
    p.forEach((a, i) => {
      const b = p[(i + 1) % p.length]!;
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      n.set(k, (n.get(k) ?? 0) + 1);
    });
  return Math.max(...n.values());
}

describe("extrudeContext — the E key (compat-backlog C126)", () => {
  it("edge mode with no face grows fins and selects the new edges, not the fins", () => {
    const em = grid();
    const { kind, selection } = extrudeContext(em, { mode: "edge", indices: edgeIds(em, [[0, 1]]) });
    expect(kind).toBe("edges");
    expect(toPolygons(em)).toHaveLength(17);
    expect(selection.size).toBe(1);
    const [he] = [...selection];
    // Both ends are the copies — the original edge 0–1 stays put when the selection is dragged.
    expect([edgeOrigin(em, he!), edgeEnd(em, he!)].sort()).toEqual([25, 26]);
  });

  it("edge mode round a face extrudes the region — no edge with three faces", () => {
    const em = grid();
    const { kind } = extrudeContext(em, { mode: "edge", indices: edgeIds(em, [[6, 11], [11, 12], [12, 7], [7, 6]]) });
    expect(kind).toBe("region");
    expect(toPolygons(em)).toHaveLength(20);
    expect(maxFacesOnEdge(em)).toBe(2);
  });

  it("vertex mode with one vertex grows a wire edge to its selected copy", () => {
    const em = grid();
    const { kind, selection } = extrudeContext(em, { mode: "vertex", indices: new Set([12]) });
    expect(kind).toBe("verts");
    expect([...selection]).toEqual([25]);
    expect(em.wireEdges).toEqual([[12, 25]]);
  });

  it("vertex mode mixes a face, an edge off its corner and a lone vertex on shared copies", () => {
    const em = grid();
    const { kind, selection } = extrudeContext(em, { mode: "vertex", indices: new Set([6, 7, 8, 11, 12, 24]) });
    expect(kind).toBe("region");
    // Copies of 6, 7, 11, 12 (the face), 8 (the edge 7–8 shares 7's copy) and 24.
    expect(selection.size).toBe(6);
    expect(em.wireEdges?.length).toBe(1);
  });

  it("a fin on an inner edge runs against the higher-numbered face, as Blender's `e->l`", () => {
    const em = grid();
    // 7–8 lies on face 2 [2,7,8,3] (7→8) and face 6 [7,12,13,8] (8→7): the fin takes 7→8.
    extrudeContext(em, { mode: "edge", indices: edgeIds(em, [[7, 8]]) });
    const fin = toPolygons(em).at(-1)!;
    const runs = fin.some((a, i) => a === 7 && fin[(i + 1) % fin.length] === 8);
    expect(runs).toBe(true);
  });

  it("vertex mode counts a chosen wire edge, which becomes a wall", () => {
    const g = grid();
    const em = meshFromData({ positions: Float32Array.from([...g.positions, 0.3, 0, -0.2]), polys: toPolygons(g), edges: [[4, 25]] });
    const before = toPolygons(em).length;
    const { kind, selection } = extrudeContext(em, { mode: "vertex", indices: new Set([4, 25]) });
    expect(kind).toBe("region");
    expect(toPolygons(em).length).toBe(before + 1);
    expect(em.wireEdges).toEqual([]);
    expect(selection.size).toBe(2);
  });

  it("extrudeRepeat refuses the extras for more than one step", () => {
    const em = grid();
    expect(() => extrudeRepeat(em, new Set([5]), { steps: 2, offset: [0, 0.1, 0] }, { verts: new Set([24]) })).toThrow();
  });
});

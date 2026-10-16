import { describe, it, expect } from "vitest";
import { extrudeVertIndiv, orphanedEdges, faceSplitByEdges } from "./wire";
import { deleteFaces, extrudeFaces } from "./operators";
import { meshFromData, meshToData } from "../../lib/mesh";
import { deleteLoose, compactMesh } from "../mesh-repair";
import type { MeshData } from "../../lib/mesh";

/** The quad the Blender probe used: (0,0) (1,0) (1,1) (0,1). */
function quad(): MeshData {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    polys: [[0, 1, 2, 3]],
  };
}

const at = (m: MeshData, v: number): number[] => [
  m.positions[v * 3]!,
  m.positions[v * 3 + 1]!,
  m.positions[v * 3 + 2]!,
];

describe("extrudeVertIndiv", () => {
  // Every expectation is a Blender 5.1.1 result from
  // tools/modeling/parity/probe-wire.py.

  it("puts each duplicate exactly on its original", () => {
    // Extruding moves nothing — the same contract extrudeFaces has, and what
    // Blender does: v4 comes back at (0, 0, 0), on top of v0.
    const out = extrudeVertIndiv(quad(), [0]);
    expect(out.positions.length / 3).toBe(5);
    expect(at(out, 4)).toEqual(at(out, 0));
  });

  it("leaves the faces alone", () => {
    const before = quad();
    const out = extrudeVertIndiv(before, [0, 1, 2, 3]);
    expect(out.polys).toEqual(before.polys);
  });

  it("makes one wire edge per vertex, in vertex order", () => {
    // Blender: extruding 0,1,2,3 of a quad gives (0,4) (1,5) (2,6) (3,7).
    const out = extrudeVertIndiv(quad(), [0, 1, 2, 3]);
    expect(out.positions.length / 3).toBe(8);
    expect(out.edges).toEqual([
      [0, 4],
      [1, 5],
      [2, 6],
      [3, 7],
    ]);
  });

  it("takes the vertices in ascending order however they are given", () => {
    const a = extrudeVertIndiv(quad(), [2, 0]);
    const b = extrudeVertIndiv(quad(), [0, 2]);
    expect(a.edges).toEqual(b.edges);
    expect(a.edges).toEqual([
      [0, 4],
      [2, 5],
    ]);
  });

  it("keeps the wire edges a mesh already had", () => {
    const withWire: MeshData = { ...quad(), edges: [[1, 3]] };
    const out = extrudeVertIndiv(withWire, [0]);
    expect(out.edges).toEqual([
      [1, 3],
      [0, 4],
    ]);
  });

  it("does not modify its input", () => {
    const before = quad();
    extrudeVertIndiv(before, [0, 1]);
    expect(before.positions.length / 3).toBe(4);
    expect(before.edges).toBeUndefined();
  });

  it("refuses a vertex the mesh does not have", () => {
    expect(() => extrudeVertIndiv(quad(), [9])).toThrow(/not a vertex/);
    expect(() => extrudeVertIndiv(quad(), [-1])).toThrow(/not a vertex/);
  });
});

describe("wire edges through the rest of the library", () => {
  it("survive a meshFromData / meshToData round trip", () => {
    // `EditMesh` carries them untouched; nothing in the operator layer reads
    // them. Without this they would vanish the moment a mesh entered an
    // operator, and nothing in the parity harness would say so.
    const withWire: MeshData = { ...quad(), edges: [[0, 2]] };
    const back = meshToData(meshFromData(withWire));
    expect(back.edges).toEqual([[0, 2]]);
    expect(back.polys).toEqual(withWire.polys);
  });

  it("come back empty for a mesh that never had any", () => {
    expect(meshToData(meshFromData(quad())).edges).toEqual([]);
  });

  it("are renumbered by compactMesh, and dropped when an end goes", () => {
    // Renumbering is the one thing that can invalidate them, and `compactMesh`
    // is the shared path for every operator that does it.
    const m: MeshData = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0]),
      polys: [],
      edges: [
        [1, 2],
        [0, 3],
      ],
    };
    const kept = compactMesh(m, new Set([1, 2, 3]));
    // 1→0, 2→1, 3→2. The edge 0-3 loses an end and goes.
    expect(kept.edges).toEqual([[0, 1]]);
  });

  it("do not stop deleteLoose from sweeping their vertices", () => {
    // A known consequence worth pinning rather than discovering: `deleteLoose`
    // keeps the vertices a *polygon* uses, and a wire edge is not a polygon.
    // The wire vertices go, and the edge goes with them.
    const out = deleteLoose(extrudeVertIndiv(quad(), [0]));
    expect(out.positions.length / 3).toBe(4);
    expect(out.edges ?? []).toEqual([]);
  });
});

describe("orphanedEdges", () => {
  it("keeps the edges a removed face had and nothing else uses", () => {
    // Two quads sharing an edge 1-2. Removing the left one strands its three
    // outer edges; the shared one survives on the right-hand quad.
    const before = [
      [0, 1, 2, 3],
      [1, 4, 5, 2],
    ];
    const after = [[1, 4, 5, 2]];
    expect(orphanedEdges(before, after)).toEqual([
      [0, 1],
      [2, 3],
      [0, 3],
    ]);
  });

  it("returns nothing when every edge is still used", () => {
    const polys = [[0, 1, 2, 3]];
    expect(orphanedEdges(polys, polys)).toEqual([]);
  });

  it("does not repeat an edge two removed faces shared", () => {
    const before = [
      [0, 1, 2],
      [0, 2, 3],
    ];
    expect(orphanedEdges(before, [])).toEqual([
      [0, 1],
      [1, 2],
      [0, 2],
      [2, 3],
      [0, 3],
    ]);
  });
});

describe("the operators that strand edges", () => {
  /** An n×n quad grid in the XY plane — the shape the parity row uses. */
  function grid(n: number): MeshData {
    const positions: number[] = [];
    for (let r = 0; r <= n; r++)
      for (let c = 0; c <= n; c++) positions.push(c, r, 0);
    const polys: number[][] = [];
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++)
        polys.push([r * (n + 1) + c, r * (n + 1) + c + 1, (r + 1) * (n + 1) + c + 1, (r + 1) * (n + 1) + c]);
    return { positions: new Float32Array(positions), polys };
  }

  it("deleteFaces keeps the edges of what it removed — FACES_ONLY", () => {
    // Blender's own name for the behaviour, and what `deleteFaces`'s JSDoc had
    // claimed since long before it was true. On a 2×2 grid, deleting the whole
    // sheet strands every one of its 12 edges.
    const em = meshFromData(grid(2));
    deleteFaces(em, new Set([0, 1, 2, 3]));
    const out = meshToData(em);
    expect(out.polys).toEqual([]);
    expect(out.edges).toHaveLength(12);
  });

  it("deleteFaces strands nothing when a neighbour still uses the edge", () => {
    // Deleting one face of a closed cube: all four of its edges belong to
    // faces that are still there. Measured — the parity row's `cube` case is
    // 0 wire edges on both sides.
    const em = meshFromData({
      positions: new Float32Array([
        -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
        -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
      ]),
      polys: [
        [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4],
        [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7],
      ],
    });
    deleteFaces(em, new Set([1]));
    expect(meshToData(em).edges).toEqual([]);
  });

  it("extrudeFaces strands the region's interior edges, not its boundary", () => {
    // The boundary edges are taken up by the skirt; the interior ones are
    // taken up by nothing. A 4×4 grid has 40 edges, 16 on the boundary, so 24
    // interior — and Blender leaves exactly 24.
    const em = meshFromData(grid(4));
    extrudeFaces(em, new Set(Array.from({ length: 16 }, (_, i) => i)));
    expect(meshToData(em).edges).toHaveLength(24);
  });

  it("extruding one face of a grid strands nothing", () => {
    // Its four edges are all on the region boundary, so the skirt takes them.
    const em = meshFromData(grid(2));
    extrudeFaces(em, new Set([0]));
    expect(meshToData(em).edges).toEqual([]);
  });
});

describe("faceSplitByEdges", () => {
  /** The unit quad the probe used, plus whatever extra points a case needs. */
  function withPoints(...extra: Array<[number, number]>): MeshData {
    const base = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
    for (const [x, y] of extra) base.push(x, y, 0);
    return { positions: new Float32Array(base), polys: [[0, 1, 2, 3]] };
  }

  /** Faces as cycles starting at their lowest vertex, sorted, for comparing. */
  const shape = (m: MeshData): number[][] =>
    m.polys
      .map((f) => {
        const at = f.indexOf(Math.min(...f));
        return [...f.slice(at), ...f.slice(0, at)];
      })
      .sort((a, b) => a[0]! - b[0]! || a.length - b.length || a[1]! - b[1]!);

  // Every expectation is a Blender 5.1.1 result from
  // tools/modeling/parity/probe-split.py.

  it("cuts between two opposite edges", () => {
    // Blender: (0, 4, 5, 3) and (5, 4, 1, 2).
    const m = { ...withPoints([0.5, 0], [0.5, 1]), edges: [[4, 5]] };
    expect(shape(faceSplitByEdges(m))).toEqual([
      [0, 4, 5, 3],
      [1, 2, 5, 4],
    ]);
  });

  it("does not snap — an end well off the boundary gives the same answer", () => {
    // 5% of the quad away, and Blender's output is byte-identical to the
    // on-the-line case. Whatever it is doing, it is not rounding.
    const m = { ...withPoints([0.5, 0.05], [0.5, 0.95]), edges: [[4, 5]] };
    expect(shape(faceSplitByEdges(m))).toEqual([
      [0, 4, 5, 3],
      [1, 2, 5, 4],
    ]);
  });

  it("attaches ends floating in the interior to their nearest edge", () => {
    // Blender: (0, 1, 5, 4) and (4, 5, 2, 3). v4 joins the left edge, v5 the
    // right — each to the boundary edge nearest it.
    const m = { ...withPoints([0.3, 0.5], [0.7, 0.5]), edges: [[4, 5]] };
    expect(shape(faceSplitByEdges(m))).toEqual([
      [0, 1, 5, 4],
      [2, 3, 4, 5],
    ]);
  });

  it("splits on a diagonal between two corners the face already has", () => {
    // Blender: (0, 1, 2) and (2, 3, 0). No new vertices.
    const m: MeshData = { ...withPoints(), edges: [[0, 2]] };
    const out = faceSplitByEdges(m);
    expect(shape(out)).toEqual([
      [0, 1, 2],
      [0, 2, 3],
    ]);
    expect(out.positions.length / 3).toBe(4);
  });

  it("takes two cuts across one face in turn", () => {
    // Blender: (0,4,5,3) (5,4,6,7) (7,6,1,2) — three faces from two wires.
    const m = {
      ...withPoints([0.33, 0], [0.33, 1], [0.66, 0], [0.66, 1]),
      edges: [
        [4, 5],
        [6, 7],
      ],
    };
    const out = faceSplitByEdges(m);
    expect(out.polys).toHaveLength(3);
    expect(shape(out)).toEqual([
      [0, 4, 5, 3],
      [1, 2, 7, 6],
      [4, 6, 7, 5],
    ]);
  });

  it("consumes the wire edges it used", () => {
    const m = { ...withPoints([0.5, 0], [0.5, 1]), edges: [[4, 5]] };
    expect(faceSplitByEdges(m).edges).toEqual([]);
  });

  it("gives Blender's zero-area triangle for two ends nearest the same boundary edge", () => {
    // Blender (probe-split.py): (0,4,5,2,3) and (5,4,1). The ends go in one at a time: 4 into the bottom edge, then 5 —
    // which may not join an edge that ends at 4, so it goes into the right edge (1,2) while standing on the bottom one.
    // Until C115 this threw.
    const m = { ...withPoints([0.3, 0], [0.7, 0]), edges: [[4, 5]] };
    expect(shape(faceSplitByEdges(m))).toEqual([
      [0, 4, 5, 2, 3],
      [1, 5, 4],
    ]);
  });

  // Chains (compat-backlog C115): Blender 5.1.1, rows `face-split-wires` (inputs `quadChain2`, `quadChain3`, `quadChainCorner`).
  it("cuts once along a chain, joining only its ends to the boundary", () => {
    // Blender: (0,1,6,5,4) (4,5,6,2,3). The middle vertex 5 is not an end, so it is not joined to the boundary — before
    // C115 it was, and the quad came out as three faces.
    const m = { ...withPoints([0.05, 0.3], [0.5, 0.62], [0.93, 0.41]), edges: [[4, 5], [5, 6]] };
    const out = faceSplitByEdges(m);
    expect(shape(out)).toEqual([
      [0, 1, 6, 5, 4],
      [2, 3, 4, 5, 6],
    ]);
    expect(out.edges).toEqual([]);
  });

  it("cuts along a chain of three edges, whichever way it is listed", () => {
    // Blender: (0,4,5,6,7,3) (7,6,5,4,1,2).
    const want = [
      [0, 4, 5, 6, 7, 3],
      [1, 2, 7, 6, 5, 4],
    ];
    const pts: Array<[number, number]> = [[0.31, 0.06], [0.42, 0.5], [0.61, 0.47], [0.72, 0.92]];
    expect(shape(faceSplitByEdges({ ...withPoints(...pts), edges: [[4, 5], [5, 6], [6, 7]] }))).toEqual(want);
    expect(shape(faceSplitByEdges({ ...withPoints(...pts), edges: [[7, 6], [5, 4], [6, 5]] }))).toEqual(want);
  });

  it("cuts along a chain from a corner to a floating end", () => {
    // Blender: (0,1,5,4) (4,5,2,3,0).
    const m = { ...withPoints([0.55, 0.38], [0.94, 0.63]), edges: [[0, 4], [4, 5]] };
    expect(shape(faceSplitByEdges(m))).toEqual([
      [0, 1, 5, 4],
      [0, 4, 5, 2, 3],
    ]);
  });

  it("mixes the corners the cut makes: an end along its edge, a vertex inside by mean value", () => {
    // UV = position: any linear mix of the corners lands a corner's UV on its own position, so each new corner's UV says
    // what it was mixed from — an end set into the left edge at y = 0.3 reads (0, 0.3), not the edge's middle.
    const m: MeshData = {
      ...withPoints([0.05, 0.3], [0.5, 0.62], [0.93, 0.41]),
      edges: [[4, 5], [5, 6]],
      uvs: [[[0, 0], [1, 0], [1, 1], [0, 1]]],
    };
    const out = faceSplitByEdges(m);
    const uvAt = new Map<number, number[]>();
    out.polys.forEach((p, f) => p.forEach((v, i) => uvAt.set(v, out.uvs![f]![i]!)));
    expect(uvAt.get(4)![0]).toBeCloseTo(0, 6);
    expect(uvAt.get(4)![1]).toBeCloseTo(0.3, 6);
    expect(uvAt.get(6)![0]).toBeCloseTo(1, 6);
    expect(uvAt.get(6)![1]).toBeCloseTo(0.41, 6);
    // The inner vertex is mixed over the face with the ends set in, which stand at their own positions (0.05, 0.3) but
    // carry the UVs of where they joined the edge (0, 0.3) — so it reads near its position, not exactly. Blender's exact
    // value is what `face-split-wires-layers` compares.
    expect(Math.abs(uvAt.get(5)![0]! - 0.5)).toBeLessThan(0.01);
    expect(Math.abs(uvAt.get(5)![1]! - 0.62)).toBeLessThan(0.01);
    expect(uvAt.get(5)![0]).not.toBeCloseTo(0.5, 6);
  });

  it("leaves the wire when Blender's edge-net walk closes the face itself first (`gridLeaveWire`, Blender 5.1.1)", () => {
    // A wire inside one quad of a 3 × 3 grid; its ends join the quad's top and right edges. Walking from the quad's first
    // corner, the turn at the end on the top edge goes on round the boundary rather than along the wire, so the walk closes
    // the quad itself, which already exists — and Blender looks no further: no face, the wire stays. Cutting it would give a
    // triangle wound backwards.
    const positions: number[] = [];
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) positions.push(x, y, 0);
    positions.push(1.325602412223816, 0.6977723836898804, 0, 1.5023182511329651, 0.9669894933700561, 0);
    const polys: number[][] = [];
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) polys.push([y * 4 + x, y * 4 + x + 1, y * 4 + x + 5, y * 4 + x + 4]);
    const out = faceSplitByEdges({ positions: new Float32Array(positions), polys, edges: [[16, 17]] });
    expect(out.polys).toHaveLength(9);
    expect(out.edges).toEqual([[16, 17]]);
    // The ends are set in all the same: the quad and the one above it have vertex 17 on their shared edge.
    expect(out.polys.filter((p) => p.includes(17))).toHaveLength(2);
  });

  it("sets an end into the shared edge of both faces round it — no T-junction (as `gridWire`)", () => {
    // Two quads side by side; a wire in the left one from near its bottom to near the edge it shares with the right one.
    const m: MeshData = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 1, 0, 1, 1, 0, 2, 1, 0, 0.5, 0.1, 0, 0.9, 0.6, 0]),
      polys: [[0, 1, 4, 3], [1, 2, 5, 4]],
      edges: [[6, 7]],
    };
    const out = faceSplitByEdges(m);
    expect(out.polys).toHaveLength(3);
    // The right quad has vertex 7 between 4 and 1, as Blender's `BM_edge_split` leaves it.
    expect(shape({ ...out, polys: out.polys.filter((p) => p.includes(2)) })).toEqual([[1, 2, 5, 4, 7]]);
  });

  it("cuts a closed loop of wire out of the face it lies in (connect_islands, compat-backlog C124)", () => {
    // Blender (row `face-split-wires`, `quadLoopTri`): the triangle becomes a face of its own and the quad around it is
    // cut by joining edges into faces round it — three faces, no wire left. Until C124 the loop stayed as wire.
    const m = { ...withPoints([0.3, 0.3], [0.72, 0.36], [0.47, 0.71]), edges: [[4, 5], [5, 6], [6, 4]] };
    const out = faceSplitByEdges(m);
    expect(out.polys).toHaveLength(3);
    expect(out.edges).toEqual([]);
    expect(out.polys.some((p) => p.length === 3 && [4, 5, 6].every((v) => p.includes(v)))).toBe(true);
  });

  it("leaves a mesh with no wire edges exactly as it was", () => {
    const m = withPoints();
    const out = faceSplitByEdges(m);
    expect(out.polys).toEqual(m.polys);
    expect(out.edges).toEqual([]);
  });
});

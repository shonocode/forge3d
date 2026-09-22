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
    expect(out.edges).toEqual([]);
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

  it("refuses two ends nearest the same boundary edge", () => {
    // Blender answers a zero-area triangle there and the ring order that
    // produces it does not follow the rule the other arrangements do.
    const m = { ...withPoints([0.3, 0], [0.7, 0]), edges: [[4, 5]] };
    expect(() => faceSplitByEdges(m)).toThrow(/same boundary edge/);
  });

  it("leaves a mesh with no wire edges exactly as it was", () => {
    const m = withPoints();
    const out = faceSplitByEdges(m);
    expect(out.polys).toEqual(m.polys);
    expect(out.edges).toEqual([]);
  });
});

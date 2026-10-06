import { describe, it, expect } from "vitest";
import { meshFromData } from "../../lib/mesh";
import { sphere } from "../generate";
import { edgeEnd, edgeOrigin, forEachEdge, toPolygons } from "./half-edge";
import { edgeloopFill } from "./refine";

/**
 * `edgeloopFill` — `bmesh.ops.edgeloop_fill`. The parity rows are `edgeloop-fill` (a hole's rim), `edgeloop-fill-layers`, and
 * `edgeloop-fill-mid-x` (a loop of interior edges round a cut cube, the face wound by the vote of the faces already on its edges).
 */
describe("edgeloopFill", () => {
  const ball = () => meshFromData(sphere({ uSegments: 8, vSegments: 4, radius: 1 }));

  /** The half-edges with both ends on the equator. */
  const equator = (em: ReturnType<typeof ball>): Set<number> => {
    const out = new Set<number>();
    forEachEdge(em, (he) => {
      const a = edgeOrigin(em, he);
      const b = edgeEnd(em, he);
      if (Math.abs(em.positions[a * 3 + 1]!) < 1e-6 && Math.abs(em.positions[b * 3 + 1]!) < 1e-6) out.add(he);
    });
    return out;
  };

  it("fills a loop of interior edges with one face through the mesh", () => {
    const em = ball();
    const before = toPolygons(em).length;
    const made = edgeloopFill(em, equator(em));
    expect(made.size).toBe(1);
    const polys = toPolygons(em);
    expect(polys).toHaveLength(before + 1);
    expect(polys[polys.length - 1]).toHaveLength(8);
  });

  it("fills nothing when the selection is not closed loops", () => {
    const em = ball();
    const ring = [...equator(em)];
    expect(edgeloopFill(em, new Set(ring.slice(1))).size).toBe(0);
  });

  it("does not make a face that already exists", () => {
    // A quad's own four edges: the face is there already.
    const em = meshFromData({ positions: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1]), polys: [[0, 1, 2, 3]] });
    const all = new Set<number>();
    forEachEdge(em, (he) => all.add(he));
    expect(edgeloopFill(em, all).size).toBe(0);
  });
});

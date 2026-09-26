import { describe, expect, it } from "vitest";
import { meshFromData, meshToData, type MeshData } from "../../lib/mesh";
import { edgeEnd, edgeOrigin, forEachEdge, type EditMesh } from "./half-edge";
import { subdivideEdgering } from "./operators";

// An open square tube: rings at y = 0 (0-3) and y = 1 (4-7), four walls.
function tube(): MeshData {
  return {
    positions: new Float32Array([
      0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1,
      0, 1, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1,
    ]),
    polys: [
      [0, 1, 5, 4],
      [1, 2, 6, 5],
      [2, 3, 7, 6],
      [3, 0, 4, 7],
    ],
  };
}
const edges = (em: EditMesh, pick: (a: number, b: number) => boolean): Set<number> => {
  const out = new Set<number>();
  forEachEdge(em, (he) => {
    if (pick(edgeOrigin(em, he), edgeEnd(em, he))) out.add(he);
  });
  return out;
};
const vertical = (a: number, b: number): boolean => Math.abs(a - b) === 4;

describe("subdivideEdgering", () => {
  it("cuts every wall of the ring, evenly with LINEAR", () => {
    const em = meshFromData(tube());
    const made = subdivideEdgering(em, edges(em, vertical), 3);
    expect(made.size).toBe(16);
    const out = meshToData(em);
    expect(out.positions.length / 3).toBe(8 + 4 * 3);
    const ys = new Set([...Array(12).keys()].map((k) => out.positions[(8 + k) * 3 + 1]!.toFixed(4)));
    expect([...ys].sort()).toEqual(["0.2500", "0.5000", "0.7500"]);
  });

  it("gives each piece of a cut edge its crease", () => {
    const data = tube();
    data.creases = new Map([["0_4", 0.5]]);
    const em = meshFromData(data);
    subdivideEdgering(em, edges(em, vertical), 1);
    const out = meshToData(em);
    expect([...out.creases.values()]).toEqual([0.5, 0.5]);
    expect(out.creases.has("0_4")).toBe(false);
  });

  it("PATH with smoothness spaces the cuts along the spline, not evenly", () => {
    const em = meshFromData(tube());
    subdivideEdgering(em, edges(em, vertical), 1, { interpolation: "PATH", smooth: 1 });
    // One cut: the spline's middle is the middle, whatever its handles.
    const out = meshToData(em);
    for (let k = 0; k < 4; k++) expect(out.positions[(8 + k) * 3 + 1]).toBeCloseTo(0.5, 5);
  });

  it("throws where Blender cancels: no face with two ring edges, so no rim loops", () => {
    const em = meshFromData(tube());
    expect(() => subdivideEdgering(em, edges(em, (a, b) => (a === 0 && b === 4) || (a === 4 && b === 0)), 1)).toThrow(
      /no edge rings/,
    );
  });
});

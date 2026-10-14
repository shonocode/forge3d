/**
 * `extrudeRegion` (compat-backlog C107): the E key in face mode. The shapes are Blender's (`extrude-region-bpy`); these pin
 * what the parity rows do not compare — the edge-keyed layers and the caller's wire edges across the vertex renumbering.
 */
import { describe, it, expect } from "vitest";
import { meshFromData } from "../../lib/mesh";
import { toPolygons } from "./half-edge";
import { extrudeRegion } from "./face-transform";

/** A 3 × 3-face sheet, vertices `r * 4 + c`, faces `r * 3 + c`. */
function sheet() {
  const positions: number[] = [];
  for (let r = 0; r <= 3; r++) for (let c = 0; c <= 3; c++) positions.push(c, 0, r);
  const polys: number[][] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) polys.push([r * 4 + c, (r + 1) * 4 + c, (r + 1) * 4 + c + 1, r * 4 + c + 1]);
  return { positions: new Float32Array(positions), polys };
}

const at = (P: Float32Array, v: number): string => `${P[v * 3]},${P[v * 3 + 1]},${P[v * 3 + 2]}`;
const keysAt = (P: Float32Array, keys: Iterable<string>): string[] =>
  [...keys].map((k) => k.split("_").map((v) => at(P, Number(v))).sort().join("|")).sort();

describe("extrudeRegion (C107)", () => {
  it("takes the region's inside away: no wire edges, no inside vertex", () => {
    const em = meshFromData(sheet());
    extrudeRegion(em, new Set([0, 1, 3, 4]));
    expect(em.wireEdges ?? []).toEqual([]);
    const used = new Set(toPolygons(em).flat());
    expect(used.size).toBe(em.positions.length / 3);
  });

  it("keeps a seam and a crease on the same edge across the renumbering", () => {
    const em = meshFromData({ ...sheet(), seams: new Set(["14_15"]), creases: new Map([["14_15", 0.5]]) });
    const before = keysAt(em.positions, em.seams);
    extrudeRegion(em, new Set([0, 1, 3, 4]));
    expect(keysAt(em.positions, em.seams)).toEqual(before);
    expect(keysAt(em.positions, em.creases.keys())).toEqual(before);
  });

  it("keeps a wire edge the caller had on an inside vertex, and that vertex", () => {
    const em = meshFromData({ ...sheet(), edges: [[5, 10]] });
    const wire = keysAt(em.positions, ["5_10"]);
    extrudeRegion(em, new Set([0, 1, 3, 4]));
    expect(keysAt(em.positions, (em.wireEdges ?? []).map(([a, b]) => `${a}_${b}`))).toEqual(wire);
  });

  it("a whole sheet keeps its originals, flipped, and closes into a solid", () => {
    const em = meshFromData(sheet());
    extrudeRegion(em, new Set(Array.from({ length: 9 }, (_, i) => i)));
    expect(toPolygons(em)).toHaveLength(9 * 2 + 12);
  });
});

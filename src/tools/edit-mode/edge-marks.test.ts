/**
 * Edge marks through the duplicating operators (compat-backlog C129): a copied edge copies its source's crease, seam and
 * sharp; a region extrude's side edge takes a seam / sharp from the region's inside edges at its vertex; and an edge the
 * operator deletes takes its marks with it.
 */
import { describe, it, expect } from "vitest";
import { extrudeFaces, duplicateFaces, splitFaces, extrudeDiscreteFaces } from "./operators";
import { extrudeRegion, extrudeRepeat } from "./face-transform";
import { seamKey, toPolygons, type EditMesh } from "./half-edge";
import { meshFromData, meshToData } from "../../lib/mesh";

/** 5 × 5 vertices row-major, faces 5 and 6 share the inside edge 7–12, which is creased, seamed and sharp. */
function grid(): EditMesh {
  const positions: number[] = [];
  for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) positions.push(c, 0, r);
  const polys: number[][] = [];
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++) polys.push([r * 5 + c, (r + 1) * 5 + c, (r + 1) * 5 + c + 1, r * 5 + c + 1]);
  return meshFromData({ positions: Float32Array.from(positions), polys, creases: new Map([["7_12", 0.5]]), seams: new Set(["7_12"]), sharp: new Set(["7_12"]) });
}
const sel = new Set([5, 6]);

/** Keys of every mark that names no edge of the result. */
function stale(em: EditMesh): string[] {
  const d = meshToData(em);
  const live = new Set<string>();
  for (const p of toPolygons(em)) p.forEach((a, i) => live.add(seamKey(a, p[(i + 1) % p.length]!)));
  for (const [a, b] of d.edges ?? []) live.add(seamKey(a!, b!));
  return [...d.seams ?? [], ...(d.sharp ?? []), ...d.creases.keys()].filter((k) => !live.has(k));
}

describe("edge marks through duplicating operators (C129)", () => {
  it("the copies of a marked edge are marked; a side edge at an inside edge's end takes its seam and sharp", () => {
    const em = grid();
    const caps = extrudeRegion(em, sel);
    const capPolys = [...caps].map((f) => toPolygons(em)[f]!);
    // the cap edge between the two caps is the copy of 7–12
    const shared = capPolys[0]!.filter((v) => capPolys[1]!.includes(v));
    const copy = seamKey(shared[0]!, shared[1]!);
    expect(em.creases.get(copy)).toBe(0.5);
    expect(em.seams.has(copy)).toBe(true);
    expect(em.sharpEdges?.has(copy)).toBe(true);
    // the side edges up from 7 and 12: seam and sharp, no crease
    const sides = [...em.seams].filter((k) => k !== copy && k.split("_").map(Number).some((v) => v === 7 || v === 12));
    expect(sides.length).toBe(2);
    for (const k of sides) expect(em.creases.has(k)).toBe(false);
  });

  it("no mark is left on an edge that is gone", () => {
    for (const run of [
      (em: EditMesh) => extrudeFaces(em, sel),
      (em: EditMesh) => extrudeRegion(em, sel),
      (em: EditMesh) => extrudeRepeat(em, sel, { steps: 3, offset: [0, 1, 0] }),
      (em: EditMesh) => extrudeDiscreteFaces(em, sel),
      (em: EditMesh) => duplicateFaces(em, sel),
      (em: EditMesh) => splitFaces(em, sel),
    ]) {
      const em = grid();
      run(em);
      expect(stale(em)).toEqual([]);
    }
  });
});

import { describe, it, expect } from "vitest";
import { creaseAll, meshFromData, meshToData, setCrease, type MeshData } from "../../lib/mesh";
import { subsurfModifier } from "../subsurf-modifier";
import { subdivideCatmullClark } from "./operators";

// compat-backlog C118: the edit-mode Subdivide and the Subdivision Surface modifier read one crease, Blender's 0..1.

function cube(): MeshData {
  return {
    positions: new Float32Array([
      -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1,
      -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1,
    ]),
    polys: [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]],
  };
}

/** The positions as sorted rounded triples — the two paths need not number the vertices alike. */
function shape(p: Float32Array): string[] {
  const out: string[] = [];
  for (let i = 0; i < p.length; i += 3) out.push([p[i]!, p[i + 1]!, p[i + 2]!].map((c) => c.toFixed(5)).join(","));
  return out.sort();
}

describe("Subdivide reads creases as the modifier does (C118)", () => {
  it.each([1, 0.5, 0.2])("crease %s on every edge: one level makes the modifier's shape", (c) => {
    const data = cube();
    creaseAll(data, c);
    const em = meshFromData(data);
    subdivideCatmullClark(em, 1);
    const mod = subsurfModifier(data, { levels: 1, limitSurface: false });
    expect(shape(em.positions)).toEqual(shape(mod.positions));
  });

  it("crease 1 stays sharp at level 2, and both child edges keep the crease", () => {
    const data = cube();
    creaseAll(data, 1);
    const em = meshFromData(data);
    subdivideCatmullClark(em, 2);
    const mod = subsurfModifier(data, { levels: 2, limitSurface: false });
    expect(shape(em.positions)).toEqual(shape(mod.positions));
    // A fully creased cube subdivides to the cube itself.
    for (let i = 0; i < em.positions.length; i += 3) {
      const m = Math.max(...[0, 1, 2].map((j) => Math.abs(em.positions[i + j]!)));
      expect(m).toBeCloseTo(1, 6);
    }
    const out = meshToData(em);
    expect(out.creases.size).toBe(mod.creases!.size);
    expect([...out.creases.values()].every((v) => v === 1)).toBe(true);
  });

  it("a partial crease carries unchanged to both child edges", () => {
    const data = cube();
    setCrease(data, 0, 1, 0.5);
    const em = meshFromData(data);
    subdivideCatmullClark(em, 1);
    expect([...em.creases.values()]).toEqual([0.5, 0.5]);
    const mod = subsurfModifier(data, { levels: 1, limitSurface: false });
    // The two number the vertices alike, so the keys must match too.
    expect([...em.creases].sort()).toEqual([...mod.creases!].sort());
  });

  it("reads vertex creases as the modifier does", () => {
    const data = cube();
    data.vertexCreases = new Map([[0, 1], [6, 0.5]]);
    const em = meshFromData(data);
    subdivideCatmullClark(em, 2);
    const mod = subsurfModifier(data, { levels: 2, limitSurface: false });
    expect(shape(em.positions)).toEqual(shape(mod.positions));
  });
});

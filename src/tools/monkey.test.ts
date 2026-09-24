import { describe, it, expect } from "vitest";
import { createMonkey } from "./monkey";
import { reorderSpatial } from "./reorder-spatial";

describe("createMonkey", () => {
  it("has Blender's counts: 507 vertices, 500 faces", () => {
    const m = createMonkey();
    expect(m.positions.length / 3).toBe(507);
    expect(m.polys).toHaveLength(500);
  });

  it("is mirror-symmetric in x, each vertex followed by its mirror", () => {
    const m = createMonkey();
    // Vertices 0 and 1 are the first table entry and its mirror.
    expect(m.positions[3]).toBeCloseTo(-m.positions[0]!, 6);
    expect(m.positions[4]).toBeCloseTo(m.positions[1]!, 6);
  });
});

describe("reorderSpatial", () => {
  it("leaves a small single-material mesh exactly as it was", () => {
    const m = createMonkey();
    const r = reorderSpatial(m);
    expect(Array.from(r.positions)).toEqual(Array.from(m.positions));
    expect(r.polys).toEqual(m.polys);
  });

  it("groups faces by material when a small mesh mixes them", () => {
    const m = createMonkey();
    const materials = m.polys.map((_, f) => f % 2);
    const r = reorderSpatial({ ...m, materials });
    // Every face of the first material comes before any of the second.
    const first = r.materials![0]!;
    const switchAt = r.materials!.findIndex((x) => x !== first);
    expect(r.materials!.slice(switchAt).every((x) => x !== first)).toBe(true);
  });
});

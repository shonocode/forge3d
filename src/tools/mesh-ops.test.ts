import { describe, it, expect } from "vitest";
import { box, plane } from "./generate";
import {
  mergeMeshes,
  transformMesh,
  mirrorMesh,
  arrayMesh,
  instanceMesh,
  weldMesh,
  boundsOf,
} from "./mesh-ops";
import { creaseAll, meshFromData, meshToData } from "../lib/mesh";
import type { MeshData } from "../lib/mesh";

const vertCount = (m: MeshData): number => m.positions.length / 3;
const vert = (m: MeshData, i: number): [number, number, number] => [
  m.positions[i * 3]!,
  m.positions[i * 3 + 1]!,
  m.positions[i * 3 + 2]!,
];

describe("mergeMeshes", () => {
  it("offsets polygon indices into the combined vertex array", () => {
    const a = box();
    const b = box({ at: [3, 0, 0] });
    const m = mergeMeshes([a, b]);
    expect(vertCount(m)).toBe(16);
    expect(m.polys).toHaveLength(12);
    for (const poly of m.polys) for (const v of poly) expect(v).toBeLessThan(16);
    // The second box's faces must all point into its own half of the array.
    expect(Math.min(...m.polys[6]!)).toBeGreaterThanOrEqual(8);
  });

  it("carries creases across, remapped to the new indices", () => {
    const a = box();
    creaseAll(a, 1);
    const b = box({ at: [3, 0, 0] });
    creaseAll(b, 1);
    const m = mergeMeshes([a, b]);
    expect(m.creases!.size).toBe(24); // 12 edges each, none shared
    for (const key of m.creases!.keys()) {
      const [p, q] = key.split("_").map(Number);
      expect(p!).toBeLessThan(16);
      expect(q!).toBeLessThan(16);
    }
  });

  it("produces a mesh the half-edge builder accepts", () => {
    const m = mergeMeshes([box(), box({ at: [3, 0, 0] })]);
    const round = meshToData(meshFromData(m));
    expect(round.polys).toHaveLength(12);
  });

  it("handles an empty list", () => {
    const m = mergeMeshes([]);
    expect(vertCount(m)).toBe(0);
    expect(m.polys).toHaveLength(0);
  });
});

describe("transformMesh", () => {
  it("translates without touching topology", () => {
    const m = transformMesh(box(), { translate: [1, 2, 3] });
    const bb = boundsOf(m)!;
    expect(bb.center[0]).toBeCloseTo(1, 6);
    expect(bb.center[1]).toBeCloseTo(2, 6);
    expect(bb.center[2]).toBeCloseTo(3, 6);
  });

  it("rotates about the pivot, not the origin", () => {
    const m = transformMesh(box({ at: [2, 0, 0] }), {
      rotate: [0, Math.PI / 2, 0],
      pivot: [2, 0, 0],
    });
    expect(boundsOf(m)!.center[0]).toBeCloseTo(2, 5);

    const spun = transformMesh(box({ at: [2, 0, 0] }), { rotate: [0, Math.PI / 2, 0] });
    expect(boundsOf(spun)!.center[2]).toBeCloseTo(-2, 5);
  });

  it("scales per axis", () => {
    expect(boundsOf(transformMesh(box(), { scale: [2, 4, 6] }))!.size).toEqual([2, 4, 6]);
    expect(boundsOf(transformMesh(box(), { scale: 3 }))!.size).toEqual([3, 3, 3]);
  });

  it("reverses winding when a scale mirrors the mesh", () => {
    const src = box();
    const flipped = transformMesh(src, { scale: [-1, 1, 1] });
    expect(flipped.polys[0]).toEqual([...src.polys[0]!].reverse());
    // Two negative axes is a rotation, not a reflection — winding is kept.
    const twice = transformMesh(src, { scale: [-1, -1, 1] });
    expect(twice.polys[0]).toEqual(src.polys[0]);
  });

  it("does not alias the source mesh", () => {
    const src = box();
    const moved = transformMesh(src, { translate: [1, 0, 0] });
    moved.polys[0]![0] = 99;
    expect(src.polys[0]![0]).not.toBe(99);
    expect(vert(src, 0)[0]).not.toBeCloseTo(vert(moved, 0)[0]);
  });
});

describe("mirrorMesh", () => {
  it("keeps both halves by default", () => {
    const m = mirrorMesh(box({ at: [2, 0, 0] }), "x");
    expect(vertCount(m)).toBe(16);
    const bb = boundsOf(m)!;
    expect(bb.min[0]).toBeCloseTo(-2.5, 5);
    expect(bb.max[0]).toBeCloseTo(2.5, 5);
  });

  it("mirrors about an offset plane", () => {
    const m = mirrorMesh(box({ at: [1, 0, 0] }), "x", { keepOriginal: false, offset: 5 });
    expect(boundsOf(m)!.center[0]).toBeCloseTo(9, 5);
  });

  it("welds the seam into a single surface", () => {
    // Half a box, mirrored back onto itself: the shared face welds away and
    // the result is one closed box rather than two shells meeting.
    const half = box({ size: [1, 1, 1], at: [0.5, 0, 0] });
    const welded = mirrorMesh(half, "x", { weld: 1e-4 });
    expect(vertCount(welded)).toBe(12); // 16 minus the 4 shared corners
    const loose = mirrorMesh(half, "x");
    expect(vertCount(loose)).toBe(16);
  });
});

describe("arrayMesh / instanceMesh", () => {
  it("repeats at a fixed offset", () => {
    const m = arrayMesh(box(), 4, [2, 0, 0]);
    expect(vertCount(m)).toBe(32);
    const bb = boundsOf(m)!;
    expect(bb.min[0]).toBeCloseTo(-0.5, 6);
    expect(bb.max[0]).toBeCloseTo(6.5, 6);
  });

  it("count 1 is the mesh itself", () => {
    expect(vertCount(arrayMesh(box(), 1, [2, 0, 0]))).toBe(8);
  });

  it("places instances individually", () => {
    const m = instanceMesh(box(), [
      { translate: [0, 0, 0] },
      { translate: [0, 0, 4], rotate: [0, Math.PI / 4, 0] },
    ]);
    expect(vertCount(m)).toBe(16);
    // The rotated copy is wider across x than the unrotated one.
    expect(boundsOf(m)!.size[0]).toBeGreaterThan(1);
  });
});

describe("weldMesh", () => {
  it("fuses coincident vertices and drops the faces that collapse", () => {
    const doubled = mergeMeshes([plane(), plane()]);
    expect(vertCount(doubled)).toBe(8);
    const w = weldMesh(doubled);
    expect(vertCount(w)).toBe(4);
    expect(w.polys).toHaveLength(2); // both quads survive, now sharing verts
  });

  it("leaves distinct geometry alone", () => {
    const m = weldMesh(mergeMeshes([box(), box({ at: [3, 0, 0] })]));
    expect(vertCount(m)).toBe(16);
  });

  it("drops creases that weld onto themselves", () => {
    const a = plane();
    creaseAll(a, 1);
    const w = weldMesh(mergeMeshes([a, a]));
    expect(w.creases!.size).toBe(4);
  });

  it("respects the tolerance", () => {
    const near = mergeMeshes([box(), box({ at: [0.01, 0, 0] })]);
    expect(vertCount(weldMesh(near, 1e-4))).toBe(16);
    expect(vertCount(weldMesh(near, 0.05))).toBe(8);
  });
});

describe("boundsOf", () => {
  it("reports min, max, size and centre", () => {
    const bb = boundsOf(box({ size: [2, 4, 6], at: [1, 2, 3] }))!;
    expect(bb.min).toEqual([0, 0, 0]);
    expect(bb.max).toEqual([2, 4, 6]);
    expect(bb.size).toEqual([2, 4, 6]);
    expect(bb.center).toEqual([1, 2, 3]);
  });

  it("is null for an empty mesh", () => {
    expect(boundsOf({ positions: new Float32Array(), polys: [] })).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import { applyModifierTo, evaluateStack, pairTriangles, renderToSurface, simpleSubdivide, surfaceToRender, transferUVs } from "./modifier-core";
import type { Modifier, OriginalGeometry } from "../state";
import type { MeshData } from "../lib/mesh";

/**
 * The GUI's modifier stack (`modifier-core.ts`): render buffer → surface →
 * the library's operators → render buffer. The operators themselves are
 * measured against Blender elsewhere (parity rows `subdiv`, `subdiv-uv`,
 * `solidify`, `decimate-collapse`, …); these check the conversions around
 * them — welding, the shading read back, UVs kept per corner.
 */

/**
 * A unit cube as Babylon draws one: 24 vertices (4 per face, flat normals),
 * 12 triangles, and its six quads as polygon metadata. UVs 0..1 per face.
 */
function renderCube(): OriginalGeometry {
  const faces: Array<{ n: [number, number, number]; c: Array<[number, number, number]> }> = [
    { n: [0, 0, -1], c: [[-1, -1, -1], [-1, 1, -1], [1, 1, -1], [1, -1, -1]] },
    { n: [0, 0, 1], c: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
    { n: [-1, 0, 0], c: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
    { n: [1, 0, 0], c: [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]] },
    { n: [0, -1, 0], c: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
    { n: [0, 1, 0], c: [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]] },
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const polys: number[][] = [];
  const uvCorner = [[0, 0], [1, 0], [1, 1], [0, 1]];
  faces.forEach((f, i) => {
    const b = i * 4;
    f.c.forEach((p, k) => {
      positions.push(p[0] * 0.5, p[1] * 0.5, p[2] * 0.5);
      normals.push(...f.n);
      uvs.push(...uvCorner[k]!);
    });
    // Outward winding for these corner orders is (0, 2, 1) in Babylon's
    // left-handed sense; the modifiers only need it consistent.
    indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
    polys.push([b, b + 1, b + 2, b + 3]);
  });
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    uvs: Float32Array.from(uvs),
    indices,
    polys,
  };
}

const mod = <T extends Modifier>(m: Omit<T, "id" | "enabled">): T => ({ id: "m", enabled: true, ...m }) as T;

describe("renderToSurface", () => {
  it("welds a render cube to 8 corners and 6 quads, one UV per corner", () => {
    const { surface } = renderToSurface(renderCube());
    expect(surface.positions.length / 3).toBe(8);
    expect(surface.polys.map((p) => p.length)).toEqual([4, 4, 4, 4, 4, 4]);
    expect(surface.uvs!.map((f) => f.length)).toEqual([4, 4, 4, 4, 4, 4]);
    expect(surface.uvs![0]).toEqual([[0, 0], [1, 0], [1, 1], [0, 1]]);
  });

  it("reads a flat-shaded cube as sharp at 90° and a shared-normal one as smooth", () => {
    const flat = renderToSurface(renderCube()).smoothAngle;
    expect(flat).toBeGreaterThan(0);
    expect(flat).toBeLessThan(Math.PI / 2);
    // Every corner's normal pointing out of the centre: drawn smooth.
    const cube = renderCube();
    const n = cube.normals!;
    for (let v = 0; v < n.length / 3; v++) {
      const l = Math.hypot(cube.positions[v * 3]!, cube.positions[v * 3 + 1]!, cube.positions[v * 3 + 2]!);
      for (let k = 0; k < 3; k++) n[v * 3 + k] = cube.positions[v * 3 + k]! / l;
    }
    expect(renderToSurface(cube).smoothAngle).toBe(Math.PI);
  });

  it("without polygon metadata, rejoins Babylon's consecutive triangle pairs into quads", () => {
    const cube = renderCube();
    delete cube.polys;
    const { surface } = renderToSurface(cube);
    expect(surface.polys.map((p) => p.length)).toEqual([4, 4, 4, 4, 4, 4]);
  });

  it("leaves a pair that is bent, or not neighbours in the list, as triangles", () => {
    // A square folded along its diagonal.
    const bent = Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0.3, 0, 1, 0]);
    expect(pairTriangles(bent, [0, 1, 2, 0, 2, 3]).map((p) => p.length)).toEqual([3, 3]);
    // Flat, but a third triangle sits between the two halves.
    const flat = Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 5, 5, 0, 6, 5, 0, 5, 6, 0]);
    expect(pairTriangles(flat, [0, 1, 2, 4, 5, 6, 0, 2, 3]).map((p) => p.length)).toEqual([3, 3, 3]);
    expect(pairTriangles(flat, [0, 1, 2, 0, 2, 3, 4, 5, 6]).map((p) => p.length)).toEqual([4, 3]);
  });
});

describe("surfaceToRender", () => {
  it("round-trips the flat cube: 24 render vertices, 36 indices, quads as metadata", () => {
    const cube = renderCube();
    const { surface, smoothAngle } = renderToSurface(cube);
    const out = surfaceToRender(surface, smoothAngle);
    expect(out.positions.length / 3).toBe(24);
    expect(out.indices.length).toBe(36);
    expect(out.polys.every((p) => p.length === 4)).toBe(true);
    // Fan triangulation of the metadata is the index buffer — what buildEditMesh checks.
    const fan = out.polys.flatMap((p) => [p[0]!, p[1]!, p[2]!, p[0]!, p[2]!, p[3]!]);
    expect(out.indices).toEqual(fan);
  });

  it("shaded smooth, the cube shares its 8 positions (UV seams aside)", () => {
    const { surface } = renderToSurface(renderCube());
    const noUV: MeshData = { positions: surface.positions, polys: surface.polys };
    expect(surfaceToRender(noUV, Math.PI).positions.length / 3).toBe(8);
  });
});

describe("the stack", () => {
  it("Catmull-Clark rounds the cube inward; Simple keeps every vertex on it", () => {
    const cc = evaluateStack(renderCube(), [mod({ type: "subdivision", level: 2, mode: "catmull-clark" })]);
    const simple = evaluateStack(renderCube(), [mod({ type: "subdivision", level: 2, mode: "simple" })]);
    const maxAbs = (g: OriginalGeometry): number => Math.max(...Array.from(g.positions, Math.abs));
    const onCube = (g: OriginalGeometry): boolean => {
      for (let v = 0; v < g.positions.length / 3; v++) {
        const m = Math.max(Math.abs(g.positions[v * 3]!), Math.abs(g.positions[v * 3 + 1]!), Math.abs(g.positions[v * 3 + 2]!));
        if (Math.abs(m - 0.5) > 1e-6) return false;
      }
      return true;
    };
    expect(maxAbs(cc)).toBeLessThan(0.5);
    expect(onCube(simple)).toBe(true);
    expect(cc.polys.length).toBe(96);
    expect(simple.polys.length).toBe(96);
    expect(cc.uvs).not.toBeNull();
  });

  it("a subdivision saved without a mode is the old shape-keeping one", () => {
    const legacy = evaluateStack(renderCube(), [mod({ type: "subdivision", level: 1 })]);
    for (const x of legacy.positions) expect(Math.abs(x)).toBeLessThanOrEqual(0.5 + 1e-9);
    expect(legacy.polys.length).toBe(24);
  });

  it("mirror with merge fuses the halves across the plane", () => {
    // A quad with one edge on the plane x = 0.
    const quad: OriginalGeometry = {
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
      normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: [0, 1, 2, 0, 2, 3],
      polys: [[0, 1, 2, 3]],
    };
    // Straight after the modifier, before anything re-welds: merged, the
    // halves share the two vertices on the plane; apart, they do not.
    const { surface } = renderToSurface(quad);
    const merged = applyModifierTo(surface, mod({ type: "mirror", axis: "x", merge: true, mergeTolerance: 0.001 }));
    const apart = applyModifierTo(surface, mod({ type: "mirror", axis: "x", merge: false, mergeTolerance: 0.001 }));
    expect(merged.positions.length / 3).toBe(6);
    expect(apart.positions.length / 3).toBe(8);
    expect(merged.polys.length).toBe(2);
  });

  it("array, solidify, smooth, triangulate and weld all keep a UV per corner", () => {
    const stacks: Modifier[][] = [
      [mod({ type: "array", count: 3, offsetX: 2, offsetY: 0, offsetZ: 0 })],
      [mod({ type: "solidify", thickness: 0.1 })],
      [mod({ type: "smooth", factor: 0.5, repeat: 2 })],
      [mod({ type: "triangulate", quadMethod: "beauty", ngonMethod: "beauty" })],
      [mod({ type: "weld", distance: 0.001 })],
    ];
    for (const stack of stacks) {
      const out = evaluateStack(renderCube(), stack);
      expect(out.uvs).not.toBeNull();
      expect(out.uvs!.length / 2).toBe(out.positions.length / 3);
    }
    expect(evaluateStack(renderCube(), stacks[0]!).polys.length).toBe(18);
    expect(evaluateStack(renderCube(), stacks[1]!).polys.length).toBe(12);
    expect(evaluateStack(renderCube(), stacks[3]!).polys.length).toBe(12);
  });

  it("disabled modifiers are skipped and upTo stops early", () => {
    const off = { ...mod<Modifier>({ type: "subdivision", level: 1, mode: "catmull-clark" }), enabled: false };
    expect(evaluateStack(renderCube(), [off]).polys.length).toBe(6);
    const two = [mod<Modifier>({ type: "subdivision", level: 1, mode: "simple" }), mod<Modifier>({ type: "triangulate", quadMethod: "fixed", ngonMethod: "beauty" })];
    expect(evaluateStack(renderCube(), two, 1).polys.length).toBe(24);
    expect(evaluateStack(renderCube(), two).polys.length).toBe(48);
  });
});

describe("simpleSubdivide", () => {
  it("cuts a triangle into three quads, UVs at the midpoints and centre", () => {
    const out = simpleSubdivide(
      { positions: Float32Array.from([0, 0, 0, 3, 0, 0, 0, 3, 0]), polys: [[0, 1, 2]], uvs: [[[0, 0], [1, 0], [0, 1]]] },
      1,
    );
    expect(out.polys.length).toBe(3);
    expect(out.polys.every((p) => p.length === 4)).toBe(true);
    expect(out.uvs![0]).toEqual([[0, 0], [0.5, 0], [1 / 3, 1 / 3], [0, 0.5]]);
  });
});

describe("transferUVs", () => {
  it("on a flat sheet with a planar map, every corner gets its own position's UV", () => {
    const n = 6;
    const positions: number[] = [];
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) positions.push(i / n, 0, j / n);
    const polys: number[][] = [];
    const uvs: number[][][] = [];
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i;
        const q = [a, a + n + 1, a + n + 2, a + 1];
        polys.push(q);
        uvs.push(q.map((v) => [positions[v * 3]!, positions[v * 3 + 2]!]));
      }
    const from: MeshData = { positions: Float32Array.from(positions), polys, uvs };
    // A coarser sheet over the same square, as Decimate would leave.
    const to: MeshData = {
      positions: Float32Array.from([0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 0, 0, 0.5, 0, 0.5]),
      polys: [[0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]],
    };
    const out = transferUVs(from, to)!;
    to.polys.forEach((p, f) =>
      p.forEach((v, i) => {
        expect(out[f]![i]![0]).toBeCloseTo(to.positions[v * 3]!, 6);
        expect(out[f]![i]![1]).toBeCloseTo(to.positions[v * 3 + 2]!, 6);
      }),
    );
  });
});

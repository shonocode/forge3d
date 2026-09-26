import { describe, it, expect } from "vitest";
import type { MeshData } from "../../lib/mesh";
import { box } from "../generate";
import { bevelMesh } from "./bevel";

/**
 * `bevelMesh`, against Blender 5.1.1's Bevel modifier. Every number here was
 * read off a parity row (`tools/modeling/parity/compare.ts`, the `bevel-mod*`
 * rows), where both sides agree to 0.0000 mm — they are Blender's numbers, not
 * this implementation's.
 */

const unitCube = (): MeshData => box({ size: [1, 1, 1] });

/** Surface area and enclosed volume, fanning each (planar, convex) face. */
function measure(m: MeshData): { area: number; volume: number } {
  const P = m.positions;
  const at = (v: number): number[] => [P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!];
  let area = 0;
  let volume = 0;
  for (const poly of m.polys) {
    const a = at(poly[0]!);
    for (let t = 1; t + 1 < poly.length; t++) {
      const b = at(poly[t]!);
      const c = at(poly[t + 1]!);
      const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
      const w = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
      const n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
      area += Math.hypot(n[0]!, n[1]!, n[2]!) / 2;
      volume += (a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) - a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!) + a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!)) / 6;
    }
  }
  return { area, volume };
}

describe("bevelMesh", () => {
  it("bevels every edge of a cube — three at each corner, which bevelEdges refuses", () => {
    const { mesh, faceKind } = bevelMesh(unitCube(), { offset: 0.1, edges: "all" });
    expect(mesh.positions.length / 3).toBe(24);
    expect(mesh.polys.length).toBe(26);
    const { area, volume } = measure(mesh);
    // bevel-mod, cube: area 5.266927, volume 0.945333 on both sides.
    expect(area).toBeCloseTo(5.266927, 5);
    expect(volume).toBeCloseTo(0.945333, 5);
    expect(faceKind.filter((k) => k === "vert")).toHaveLength(8);
    expect(faceKind.filter((k) => k === "edge")).toHaveLength(12);
    expect(faceKind.filter((k) => k === "recon")).toHaveLength(6);
  });

  it("closes a two-segment corner with the patch Blender builds (56 verts, 54 faces)", () => {
    const { mesh } = bevelMesh(unitCube(), { offset: 0.03, segments: 2, edges: "all" });
    expect(mesh.positions.length / 3).toBe(56);
    expect(mesh.polys.length).toBe(54);
    expect(mesh.polys.every((p) => p.length === 4)).toBe(true);
  });

  it("builds pipes where an in-plane edge crosses a beveled one (gridBox: 290 / 288)", () => {
    const grid = box({ size: [2, 1, 1], segments: [3, 2, 2] });
    const { mesh } = bevelMesh(grid, { offset: 0.05, segments: 2, edges: "all" });
    expect(mesh.positions.length / 3).toBe(290);
    expect(mesh.polys.length).toBe(288);
  });

  it("limits by angle: a flat grid's in-plane edges are left alone", () => {
    const grid = box({ size: [2, 1, 1], segments: [3, 2, 2] });
    const { mesh } = bevelMesh(grid, { offset: 0.05, segments: 3, edges: { angle: Math.PI / 6 } });
    // bevel-mod-boolean, gridBox: 170 / 172.
    expect(mesh.positions.length / 3).toBe(170);
    expect(mesh.polys.length).toBe(172);
  });

  it("clamps an offset larger than the shape where the chamfers would collide", () => {
    const r = bevelMesh(unitCube(), { offset: 0.8, segments: 2, edges: "all" });
    // Two 0.8 chamfers on a 1.0 edge collide at 0.5; Blender's clamp stops there.
    expect(r.offset).toBeCloseTo(0.5, 6);
    expect(r.mesh.positions.length / 3).toBe(56);
    const off = bevelMesh(unitCube(), { offset: 0.8, segments: 2, edges: "all", clampOverlap: false });
    expect(off.offset).toBe(0.8);
  });

  it("does nothing, and says so, when no edge qualifies", () => {
    const grid = box({ size: [1, 1, 1], segments: [2, 2, 2] });
    const r = bevelMesh(grid, { offset: 0.1, edges: { angle: Math.PI } });
    expect(r.mesh.positions.length).toBe(grid.positions.length);
    expect(r.faceKind.every((k) => k === "orig")).toBe(true);
  });

  it("names what it has not ported instead of approximating it", () => {
    expect(() => bevelMesh(unitCube(), { offset: 0.1, miterOuter: "ARC" })).toThrow(/not ported/);
    expect(() => bevelMesh(unitCube(), { offset: 0.1, vmeshMethod: "CUTOFF" })).toThrow(/not ported/);
  });
});

describe("vertex bevel (affect VERTICES, compat-backlog C1)", () => {
  const unitCube = (): MeshData => ({
    positions: new Float32Array([
      -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
      -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
    ]),
    polys: [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]],
  });

  it("cuts every corner of a cube off with a triangle", () => {
    const { mesh } = bevelMesh(unitCube(), { offset: 0.1, affect: "VERTICES", edges: "all" });
    expect(mesh.positions.length / 3).toBe(24);
    expect(mesh.polys).toHaveLength(6 + 8);
    expect(mesh.polys.filter((p) => p.length === 3)).toHaveLength(8);
  });

  it("refuses an edge list for a vertex bevel instead of taking every vertex", () => {
    expect(() => bevelMesh(unitCube(), { offset: 0.1, affect: "VERTICES", edges: [[0, 1]] })).toThrow(/VERTICES/);
  });

  it("puts each boundary point `offset` along its edge", () => {
    const { mesh } = bevelMesh(unitCube(), { offset: 0.1, affect: "VERTICES", vertices: [0] });
    // Vertex 0 is gone; three points 0.1 from (-0.5, -0.5, -0.5) take its place.
    const near: number[] = [];
    for (let v = 0; v < mesh.positions.length / 3; v++) {
      const d = Math.hypot(mesh.positions[v * 3]! + 0.5, mesh.positions[v * 3 + 1]! + 0.5, mesh.positions[v * 3 + 2]! + 0.5);
      if (d < 0.2) near.push(d);
    }
    expect(near).toHaveLength(3);
    for (const d of near) expect(d).toBeCloseTo(0.1, 6);
  });
});

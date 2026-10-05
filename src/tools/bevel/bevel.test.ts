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

  it("face_strength_mode sets the weighted-normal strength by face kind (compat-backlog C35)", () => {
    const strengths = (mode: "new" | "affected" | "all"): Record<string, number[]> => {
      const { mesh, faceKind } = bevelMesh(unitCube(), { offset: 0.1, edges: "all", faceStrengthMode: mode });
      const out: Record<string, number[]> = { vert: [], edge: [], recon: [], orig: [] };
      mesh.faceStrength!.forEach((s, f) => out[faceKind[f]!]!.push(s));
      return out;
    };
    const none = bevelMesh(unitCube(), { offset: 0.1, edges: "all" });
    expect(none.mesh.faceStrength).toBeUndefined();
    const n = strengths("new");
    expect(new Set(n.vert)).toEqual(new Set([-16384])); // weak
    expect(new Set(n.edge)).toEqual(new Set([0])); // medium
    expect(new Set(n.recon)).toEqual(new Set([0])); // not set below "affected": the source face had none
    expect(new Set(strengths("affected").recon)).toEqual(new Set([16384]));
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

describe("edge layers and material (compat-backlog C17)", () => {
  const key = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);
  /** The cube's edges, each once. */
  const cubeEdges = (c: MeshData): string[] => {
    const out = new Set<string>();
    for (const poly of c.polys) poly.forEach((v, i) => out.add(key(v, poly[(i + 1) % poly.length]!)));
    return [...out];
  };

  it("keeps a sharp edge the bevel never touched, and copies a beveled one's onto the edges that replace it", () => {
    const c = unitCube();
    const [a, b] = cubeEdges(c)[0]!.split("_").map(Number) as [number, number];
    const { mesh } = bevelMesh({ ...c, sharp: new Set([key(a, b)]) }, { offset: 0.1, edges: [[a, b]], clampOverlap: false });
    // The beveled edge is gone; its two sides and both ends of the chamfer carry the flag on.
    expect(mesh.sharp?.size ?? 0).toBeGreaterThan(0);
    // A sharp edge elsewhere on the cube survives under its new number.
    const far = cubeEdges(c).find((k) => k.split("_").every((x) => Number(x) !== a && Number(x) !== b))!;
    const { mesh: m2 } = bevelMesh({ ...c, sharp: new Set([far]) }, { offset: 0.1, edges: [[a, b]], clampOverlap: false });
    expect(m2.sharp?.size).toBe(1);
  });

  it("carries creases and seams the same way, and a crease of 0 is not an entry", () => {
    const c = unitCube();
    const edges = cubeEdges(c);
    const { mesh } = bevelMesh(
      { ...c, creases: new Map(edges.map((k) => [k, 0.5])), seams: new Set(edges) },
      { offset: 0.1, edges: "all" },
    );
    expect(mesh.creases && mesh.creases.size).toBeGreaterThan(12);
    expect(mesh.seams && mesh.seams.size).toBeGreaterThan(12);
    const bare = bevelMesh(unitCube(), { offset: 0.1, edges: "all" }).mesh;
    expect(bare.creases).toBeUndefined();
    expect(bare.seams).toBeUndefined();
    expect(bare.sharp).toBeUndefined();
  });

  it("mark_seam paints the corner's outer ring when a beveled seam has unmarked beveled neighbours", () => {
    const c = unitCube();
    // Two of the three edges at vertex 0: the run between them has an unmarked beveled edge in it.
    const one = new Set(cubeEdges(c).filter((k) => k.split("_").includes("0")).slice(0, 2));
    const off = bevelMesh({ ...c, seams: one }, { offset: 0.1, segments: 2, edges: "all" }).mesh.seams?.size ?? 0;
    const on = bevelMesh({ ...c, seams: one }, { offset: 0.1, segments: 2, edges: "all", markSeam: true }).mesh.seams?.size ?? 0;
    expect(on).toBeGreaterThan(off);
  });

  it("material: the faces the bevel makes take the slot, the rebuilt ones keep theirs", () => {
    const c = unitCube();
    const { mesh, faceKind } = bevelMesh(
      { ...c, materials: c.polys.map((_, i) => i % 2) },
      { offset: 0.1, edges: "all", material: 3 },
    );
    faceKind.forEach((k, f) => {
      if (k === "recon") expect([0, 1]).toContain(mesh.materials![f]);
      else expect(mesh.materials![f]).toBe(3);
    });
    // Without slots on the input, the option still makes the layer.
    const bare = bevelMesh(unitCube(), { offset: 0.1, edges: "all", material: 2 }).mesh;
    expect(bare.materials!.filter((m) => m === 2).length).toBe(20);
  });
});

describe("bevelMesh: vmeshMethod CUTOFF (compat-backlog C35)", () => {
  it("closes each corner with a face under every profile and one joining their bottoms", () => {
    // parity row `bevel-mod-cutoff`: a cube, 3 segments — 80 vertices, 66 faces.
    const { mesh } = bevelMesh(unitCube(), { offset: 0.05, segments: 3, edges: "all", vmeshMethod: "CUTOFF" });
    expect(mesh.positions.length / 3).toBe(80);
    expect(mesh.polys.length).toBe(66);
    // Each corner: 3 profile faces (quads over 3 segments: 5 vertices) + the 3-gon bottom.
    expect(mesh.polys.filter((p) => p.length === 5).length).toBe(24);
  });

  it("is the same polygon corner as Grid Fill at one segment", () => {
    const a = bevelMesh(unitCube(), { offset: 0.05, segments: 1, edges: "all", vmeshMethod: "CUTOFF" }).mesh;
    const b = bevelMesh(unitCube(), { offset: 0.05, segments: 1, edges: "all" }).mesh;
    expect(a.polys.length).toBe(b.polys.length);
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
  });

  it("differs from Grid Fill with more than one", () => {
    const cut = bevelMesh(unitCube(), { offset: 0.05, segments: 3, edges: "all", vmeshMethod: "CUTOFF" }).mesh;
    const adj = bevelMesh(unitCube(), { offset: 0.05, segments: 3, edges: "all" }).mesh;
    expect(cut.polys.length).not.toBe(adj.polys.length);
  });
});

describe("bevelMesh: miters (compat-backlog C35)", () => {
  // An L-shaped prism: its inside corner is a reflex angle, where an outer miter goes (parity rows `bevel-mod-miter-*`).
  const lPrism = (): MeshData => {
    const pts: [number, number][] = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]];
    const positions: number[] = [];
    for (const z of [0, 1]) for (const [x, y] of pts) positions.push(x, y, z);
    const n = pts.length;
    const polys: number[][] = [[...pts.keys()].reverse(), [...pts.keys()].map((i) => i + n)];
    for (let i = 0; i < n; i++) polys.push([i, (i + 1) % n, ((i + 1) % n) + n, i + n]);
    return { positions: Float32Array.from(positions), polys };
  };
  const base = { offset: 0.1, segments: 3, edges: "all" as const };

  it("an outer miter changes only the reflex corner: arc and patch differ from sharp and from each other", () => {
    const sharp = bevelMesh(lPrism(), base).mesh;
    const arc = bevelMesh(lPrism(), { ...base, miterOuter: "ARC" }).mesh;
    const patch = bevelMesh(lPrism(), { ...base, miterOuter: "PATCH" }).mesh;
    expect(arc.positions.length).not.toBe(sharp.positions.length);
    expect(patch.positions.length).not.toBe(arc.positions.length);
  });

  it("a mesh with no reflex corner is untouched by the outer miters", () => {
    const sharp = bevelMesh(unitCube(), { ...base, offset: 0.05 }).mesh;
    const arc = bevelMesh(unitCube(), { ...base, offset: 0.05, miterOuter: "ARC" }).mesh;
    expect(Array.from(arc.positions)).toEqual(Array.from(sharp.positions));
  });

  it("the inner miter splits each sharp turn in two, spread apart", () => {
    const sharp = bevelMesh(unitCube(), { ...base, offset: 0.05 }).mesh;
    const near = bevelMesh(unitCube(), { ...base, offset: 0.05, miterInner: "ARC", spread: 0.02 }).mesh;
    const far = bevelMesh(unitCube(), { ...base, offset: 0.05, miterInner: "ARC", spread: 0.06 }).mesh;
    expect(near.positions.length).toBeGreaterThan(sharp.positions.length);
    expect(Array.from(far.positions)).not.toEqual(Array.from(near.positions));
  });

  it("a cut-off vertex mesh turns the miters off", () => {
    const plain = bevelMesh(lPrism(), { ...base, vmeshMethod: "CUTOFF" }).mesh;
    const mitered = bevelMesh(lPrism(), { ...base, vmeshMethod: "CUTOFF", miterOuter: "ARC", miterInner: "ARC" }).mesh;
    expect(Array.from(mitered.positions)).toEqual(Array.from(plain.positions));
  });
});

describe("bevelMesh: custom profile (compat-backlog C35)", () => {
  it("a cornice profile at 6 segments on a cube: 296 vertices and 294 faces (parity row bevel-mod-custom-cornice)", () => {
    const { mesh } = bevelMesh(unitCube(), {
      offset: 0.03,
      segments: 6,
      edges: "all",
      profileType: "CUSTOM",
      customProfile: { preset: "CORNICE" },
    });
    expect(mesh.positions.length / 3).toBe(296);
    expect(mesh.polys.length).toBe(294);
  });

  it("the profile's shape reaches the surface: a crown and a cornice are different bevels", () => {
    const a = bevelMesh(unitCube(), { offset: 0.03, segments: 4, edges: "all", profileType: "CUSTOM", customProfile: { preset: "CROWN" } }).mesh;
    const b = bevelMesh(unitCube(), { offset: 0.03, segments: 4, edges: "all", profileType: "CUSTOM", customProfile: { preset: "CORNICE" } }).mesh;
    expect(Array.from(a.positions)).not.toEqual(Array.from(b.positions));
  });

  it("with one segment there is no profile to read, so the custom profile changes nothing", () => {
    const plain = bevelMesh(unitCube(), { offset: 0.03, segments: 1, edges: "all" }).mesh;
    const custom = bevelMesh(unitCube(), { offset: 0.03, segments: 1, edges: "all", profileType: "CUSTOM", customProfile: { preset: "CORNICE" } }).mesh;
    expect(Array.from(custom.positions)).toEqual(Array.from(plain.positions));
  });
});

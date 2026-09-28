import { describe, expect, it } from "vitest";
import type { MeshData } from "../lib/mesh";
import { meshFromData, meshToData } from "../lib/mesh";
import { edgeSplitModifier } from "./edge-split-modifier";
import { edgeSplitVerts } from "./edit-mode/operators";

const cube = (): MeshData => ({
  positions: Float32Array.from([-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1]),
  polys: [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]],
});

// A 2×2 sheet, flat, vertex 4 in the middle.
const sheet = (): MeshData => {
  const positions: number[] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) positions.push(c, 0, r);
  const at = (r: number, c: number): number => r * 3 + c;
  const polys: number[][] = [];
  for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) polys.push([at(r, c), at(r + 1, c), at(r + 1, c + 1), at(r, c + 1)]);
  return { positions: Float32Array.from(positions), polys };
};

describe("edgeSplitModifier (MOD_edgesplit.cc)", () => {
  it("splits every edge of a cube at the default 30°", () => {
    expect(edgeSplitModifier(cube()).positions.length / 3).toBe(24);
  });

  it("leaves a flat sheet alone, unless the angle is 0", () => {
    expect(edgeSplitModifier(sheet()).positions.length / 3).toBe(9);
    expect(edgeSplitModifier(sheet(), { splitAngle: 0 }).positions.length / 3).toBe(16);
  });

  it("splits the sharp edges and keeps the flag on both copies", () => {
    const data = { ...sheet(), sharp: new Set(["1_4", "4_7"]) };
    const out = edgeSplitModifier(data, { useEdgeAngle: false });
    // The column 1–4–7 tears: 1 and 7 are on the boundary (two copies), 4 too.
    expect(out.positions.length / 3).toBe(12);
    expect(out.sharp?.size).toBe(4);
  });

  it("changes nothing with both switches off", () => {
    const out = edgeSplitModifier(cube(), { useEdgeAngle: false, useEdgeSharp: false });
    expect(out.positions.length / 3).toBe(8);
  });
});

describe("edgeSplitVerts (edge_split type VERT)", () => {
  it("gives each face round a selected vertex its own copy, and tears nothing else", () => {
    const em = meshFromData(sheet());
    edgeSplitVerts(em, new Set([4]));
    const out = meshToData(em);
    // 4 becomes four vertices; its neighbours stay joined.
    expect(out.positions.length / 3).toBe(12);
  });
});

import { describe, it, expect } from "vitest";
import type { MeshData } from "../../lib/mesh";
import {
  loopToRegion,
  regionToLoop,
  selectInteriorFaces,
  selectLinked,
  selectLoose,
  selectNonManifold,
  vertIsManifold,
} from "./select-topology";
import { bmFromMesh } from "../bmesh-lite";

/** Parity rows are in `compare-select.ts` (compat-backlog C82); these are the small cases, with Blender 5.1.1's answers. */
const cube = (): MeshData => ({
  positions: Float32Array.from([-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1]),
  polys: [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]],
});
const bowtie = (): MeshData => ({
  positions: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 2, 1, 0, 2, 2, 0, 1, 2, 0]),
  polys: [[0, 1, 2, 3], [2, 4, 5, 6]],
});
const grid = (): MeshData => {
  const positions: number[] = [];
  for (let r = 0; r <= 4; r++) for (let c = 0; c <= 4; c++) positions.push(c, r, 0);
  const polys: number[][] = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) polys.push([r * 5 + c, r * 5 + c + 1, (r + 1) * 5 + c + 1, (r + 1) * 5 + c]);
  return { positions: Float32Array.from(positions), polys };
};

describe("selectNonManifold", () => {
  it("finds nothing on a closed cube", () => {
    expect(selectNonManifold(cube(), "vertex")).toEqual({ verts: [], edges: [], faces: [] });
  });

  it("picks the vertex two quads share, and with only that option nothing else", () => {
    const only = { useWire: false, useBoundary: false, useMultiFace: false, useNonContiguous: false };
    expect(selectNonManifold(bowtie(), "vertex", {}, only).verts).toEqual([2]);
    expect(vertIsManifold(bmFromMesh(bowtie()).verts[2]!)).toBe(false);
    expect(vertIsManifold(bmFromMesh(bowtie()).verts[0]!)).toBe(true);
  });

  it("picks the edges a flipped face makes non-contiguous", () => {
    const m = cube();
    m.polys[5] = [...m.polys[5]!].reverse();
    const sel = selectNonManifold(m, "edge", {}, { useBoundary: false, useWire: false, useMultiFace: false, useVerts: false });
    expect(sel.edges).toHaveLength(4);
    expect(sel.faces).toEqual([5]);
  });

  it("extend keeps what was selected", () => {
    expect(selectNonManifold(cube(), "vertex", { verts: [0] }).verts).toEqual([0]);
    expect(selectNonManifold(cube(), "vertex", { verts: [0] }, { extend: false }).verts).toEqual([]);
  });
});

describe("selectLoose", () => {
  it("takes a face with no neighbour in face mode, and a wire edge in edge mode", () => {
    const m: MeshData = { ...bowtie(), polys: [...bowtie().polys, [0, 1, 6]], edges: [[3, 4]] };
    expect(selectLoose({ positions: m.positions, polys: [[0, 1, 2]], edges: [[3, 4]] }, "edge").edges).toEqual([[3, 4]]);
    expect(selectLoose({ positions: m.positions, polys: [[0, 1, 2]] }, "face").faces).toEqual([0]);
    expect(selectLoose(cube(), "face").faces).toEqual([]);
  });
});

describe("regionToLoop / loopToRegion", () => {
  it("turns a face of a cube into its four edges, and leaves face mode for edge mode", () => {
    const r = regionToLoop(cube(), "face", { faces: [3] });
    expect(r.edges).toHaveLength(4);
    expect(r.mode).toBe("edge");
    expect(r.faces).toEqual([3]);
  });

  it("takes the smaller region inside a loop, the bigger with selectBigger", () => {
    const ringEdges: [number, number][] = [[6, 7], [7, 8], [8, 13], [13, 18], [18, 17], [17, 16], [16, 11], [11, 6]];
    expect(loopToRegion(grid(), "edge", { edges: ringEdges }).faces).toEqual([5, 6, 9, 10]);
    expect(loopToRegion(grid(), "edge", { edges: ringEdges }, { selectBigger: true }).faces).toHaveLength(12);
  });
});

describe("selectInteriorFaces", () => {
  it("selects the wall between two boxes", () => {
    // Two boxes side by side, the wall between them made once.
    const P = [0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 1, 0, 1, 1, 0, 2, 1, 0, 0, 0, 1, 1, 0, 1, 2, 0, 1, 0, 1, 1, 1, 1, 1, 2, 1, 1];
    const polys = [
      [0, 3, 4, 1], [1, 4, 5, 2], // bottom
      [6, 7, 10, 9], [7, 8, 11, 10], // top
      [0, 1, 7, 6], [1, 2, 8, 7], // front
      [3, 9, 10, 4], [4, 10, 11, 5], // back
      [0, 6, 9, 3], [2, 5, 11, 8], // left, right
      [1, 7, 10, 4], // the wall
    ];
    const sel = selectInteriorFaces({ positions: Float32Array.from(P), polys }, "face");
    expect(sel.faces).toEqual([10]);
  });

  it("does nothing on a mesh with no edge of three faces", () => {
    expect(selectInteriorFaces(cube(), "face")).toEqual({ verts: [], edges: [], faces: [] });
  });
});

describe("selectLinked", () => {
  it("grows over the edges in vertex mode and over faces in face mode", () => {
    expect(selectLinked(grid(), "vertex", { verts: [0] }).faces).toHaveLength(16);
    expect(selectLinked(grid(), "face", { faces: [0] }).faces).toHaveLength(16);
  });

  it("stops at a seam, and a seam round a corner lets the other side through only where it is open", () => {
    const seams = new Set(["2_7", "7_12", "12_17", "17_22"]);
    const sel = selectLinked({ ...grid(), seams }, "face", { faces: [0] }, { delimit: ["seam"] });
    expect(sel.faces).toEqual([0, 1, 4, 5, 8, 9, 12, 13]);
    expect(selectLinked({ ...grid(), seams }, "face", { faces: [0] }).faces).toHaveLength(16);
  });

  it("stops at a material change", () => {
    const materials = [0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1];
    expect(selectLinked({ ...grid(), materials }, "face", { faces: [0] }, { delimit: ["material"] }).faces).toEqual([0, 1, 4, 5, 8, 9, 12, 13]);
  });
});

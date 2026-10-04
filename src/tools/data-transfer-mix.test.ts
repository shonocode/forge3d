/**
 * Data Transfer's mix mode, factor and vertex group (compat-backlog C41; the parity rows `data-transfer-mix-*`,
 * `data-transfer-loop-mix*`). Colours have no parity row — the test is the measure.
 */
import { describe, it, expect } from "vitest";
import type { MeshData } from "../lib/mesh";
import { transferWeights, transferLoopData } from "./data-transfer";

/** One triangle; the group G holds every vertex at the given weights. */
function tri(weights: [number, number, number]): MeshData {
  return {
    positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    polys: [[0, 1, 2]],
    groups: new Map([["G", new Map(weights.map((w, v) => [v, w] as const))]]),
  };
}

describe("transferWeights: mix", () => {
  const source = tri([1, 1, 1]);

  it("transfer at a factor goes that part of the way", () => {
    const out = transferWeights(tri([0.2, 0.2, 0.2]), source, { mapping: "topology", mixFactor: 0.5 });
    expect(out.groups!.get("G")!.get(0)).toBeCloseTo(0.6, 6);
  });

  it("the replace modes use the factor as a threshold and then replace in full", () => {
    const above = transferWeights(tri([0.2, 0.7, 0.2]), source, { mapping: "topology", mixMode: "replaceAbove", mixFactor: 0.5 });
    expect(above.groups!.get("G")!.get(0)).toBeCloseTo(0.2, 6); // below the threshold: left
    expect(above.groups!.get("G")!.get(1)).toBeCloseTo(1, 6); // above it: replaced whole
    const below = transferWeights(tri([0.2, 0.7, 0.2]), source, { mapping: "topology", mixMode: "replaceBelow", mixFactor: 0.5 });
    expect(below.groups!.get("G")!.get(0)).toBeCloseTo(1, 6);
    expect(below.groups!.get("G")!.get(1)).toBeCloseTo(0.7, 6);
  });

  it("add, sub and mul combine, clamped to 0..1", () => {
    const t = tri([0.5, 0.5, 0.5]);
    const half: MeshData = tri([0.4, 0.4, 0.4]);
    expect(transferWeights(t, half, { mapping: "topology", mixMode: "add" }).groups!.get("G")!.get(0)).toBeCloseTo(0.9, 6);
    expect(transferWeights(t, half, { mapping: "topology", mixMode: "sub" }).groups!.get("G")!.get(0)).toBeCloseTo(0.1, 6);
    expect(transferWeights(t, half, { mapping: "topology", mixMode: "mul" }).groups!.get("G")!.get(0)).toBeCloseTo(0.2, 6);
    expect(transferWeights(tri([0.9, 0.9, 0.9]), tri([0.9, 0.9, 0.9]), { mapping: "topology", mixMode: "add" }).groups!.get("G")!.get(0)).toBe(1);
  });

  it("the vertex group scales the factor per vertex", () => {
    const t = tri([0.2, 0.2, 0.2]);
    t.groups!.set("MASK", new Map([[0, 1], [1, 0.5]]));
    const out = transferWeights(t, source, { mapping: "topology", mixFactor: 1, vertexGroup: "MASK", groups: ["G"] });
    expect(out.groups!.get("G")!.get(0)).toBeCloseTo(1, 6); // factor 1
    expect(out.groups!.get("G")!.get(1)).toBeCloseTo(0.6, 6); // factor 0.5
    expect(out.groups!.get("G")!.get(2)).toBeCloseTo(0.2, 6); // not in the mask: factor 0
  });
});

describe("transferLoopData: mix", () => {
  const source: MeshData = {
    positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    polys: [[0, 1, 2]],
    uvs: [[[1, 1], [1, 1], [1, 1]]],
    colors: [[[1, 0, 0, 1], [1, 0, 0, 1], [1, 0, 0, 1]]],
  };
  const target = (): MeshData => ({
    positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    polys: [[0, 1, 2]],
    uvs: [[[0, 0], [0, 0], [0, 0]]],
    colors: [[[0, 0, 1, 1], [0, 0, 1, 1], [0, 0, 1, 1]]],
  });

  it("a UV is interpolated by the factor whatever the mode", () => {
    const out = transferLoopData(target(), source, { mapping: "topology", layers: ["uvs"], mixMode: "add", mixFactor: 0.25 });
    expect(out.uvs![0]![0]![0]).toBeCloseTo(0.25, 6);
  });

  it("a colour mixes by the mode, then by the factor", () => {
    const mix = transferLoopData(target(), source, { mapping: "topology", layers: ["colors"], mixMode: "mix", mixFactor: 1 });
    // pre-multiplied over: (1 − a)·dst + src, a = 1 → the source.
    expect(mix.colors![0]![0]!.slice(0, 3)).toEqual([1, 0, 0]);
    const add = transferLoopData(target(), source, { mapping: "topology", layers: ["colors"], mixMode: "add", mixFactor: 1 });
    expect(add.colors![0]![0]!.slice(0, 3)).toEqual([1, 0, 1]);
    const sub = transferLoopData(target(), source, { mapping: "topology", layers: ["colors"], mixMode: "sub", mixFactor: 1 });
    expect(sub.colors![0]![0]!.slice(0, 3)).toEqual([0, 0, 1]);
    const half = transferLoopData(target(), source, { mapping: "topology", layers: ["colors"], mixFactor: 0.5 });
    expect(half.colors![0]![0]!.slice(0, 3)).toEqual([0.5, 0, 0.5]);
  });

  it("the replace modes read the destination's brightness against the factor", () => {
    const t = target();
    const above = transferLoopData(t, source, { mapping: "topology", layers: ["colors"], mixMode: "replaceAbove", mixFactor: 0.5 });
    // dst (0,0,1) has brightness 1/3 < 0.5: left alone.
    expect(above.colors![0]![0]).toEqual([0, 0, 1, 1]);
    const below = transferLoopData(t, source, { mapping: "topology", layers: ["colors"], mixMode: "replaceBelow", mixFactor: 0.5 });
    expect(below.colors![0]![0]).toEqual([1, 0, 0, 1]);
  });
});

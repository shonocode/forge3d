import { describe, it, expect } from "vitest";
import { serializeGraph, deserializeGraph, validateGraph } from "./graph-io";
import { makeNoiseGraph, makeBrickGraph, type ProceduralGraph } from "./procedural-graph";

describe("serialize / deserialize round-trip", () => {
  it("preserves a graph through serialize → deserialize", () => {
    const g = makeBrickGraph({ scale: 5, roughness: true, normal: true, normalStrength: 2 });
    const back = deserializeGraph(serializeGraph(g));
    expect(back.outputId).toBe(g.outputId);
    expect(back.resolution).toBe(g.resolution);
    expect(back.nodes.length).toBe(g.nodes.length);
    expect(back.nodes.find((n) => n.id === "src")?.type).toBe("brick");
    expect(back.nodes.find((n) => n.id === g.outputId)?.inputs?.height).toBe("src");
  });

  it("accepts a bare graph object (no format wrapper)", () => {
    const g = makeNoiseGraph({});
    const back = deserializeGraph(JSON.stringify(g));
    expect(back.outputId).toBe(g.outputId);
    expect(back.nodes.length).toBe(g.nodes.length);
  });

  it("produces a tagged, pretty-printed format", () => {
    const text = serializeGraph(makeNoiseGraph({}));
    expect(text).toContain("forge3d-procedural-graph");
    expect(text).toContain("\n"); // pretty-printed
  });
});

describe("validation", () => {
  it("rejects non-JSON", () => {
    expect(() => deserializeGraph("{not json")).toThrow(/JSON/);
  });

  it("rejects a graph with no nodes", () => {
    expect(() => validateGraph({ nodes: [], outputId: "x", resolution: 256 })).toThrow(/no nodes/);
  });

  it("rejects an unknown node type", () => {
    expect(() =>
      validateGraph({
        nodes: [{ id: "a", type: "frobnicate" }],
        outputId: "a",
        resolution: 256,
      })
    ).toThrow(/unknown type/);
  });

  it("rejects an outputId that does not exist", () => {
    expect(() =>
      validateGraph({ nodes: [{ id: "a", type: "output" }], outputId: "ghost", resolution: 256 })
    ).toThrow(/outputId/);
  });

  it("rejects duplicate node ids", () => {
    expect(() =>
      validateGraph({
        nodes: [
          { id: "a", type: "uv" },
          { id: "a", type: "output" },
        ],
        outputId: "a",
        resolution: 256,
      })
    ).toThrow(/Duplicate/);
  });

  it("defaults an out-of-range resolution to 256", () => {
    const g: ProceduralGraph = validateGraph({
      nodes: [{ id: "out", type: "output" }],
      outputId: "out",
      resolution: 999999,
    });
    expect(g.resolution).toBe(256);
  });

  it("returns a fresh object (not the input reference)", () => {
    const input = { nodes: [{ id: "out", type: "output" }], outputId: "out", resolution: 256 };
    const g = validateGraph(input);
    expect(g.nodes).not.toBe(input.nodes);
  });
});

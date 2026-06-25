import { describe, it, expect } from "vitest";
import {
  addNode,
  removeNode,
  connect,
  disconnect,
  wouldCreateCycle,
  dependsOn,
  NODE_DEFS,
} from "./graph-ops";
import { makeNoiseGraph, type ProceduralGraph } from "./procedural-graph";

function freshGraph(): ProceduralGraph {
  // noise → ramp → out, plus a uv node.
  return makeNoiseGraph({});
}

describe("addNode", () => {
  it("adds a node with default params and a unique id", () => {
    const g = freshGraph();
    const before = g.nodes.length;
    const n = addNode(g, "voronoi", 10, 20);
    expect(g.nodes.length).toBe(before + 1);
    expect(n.type).toBe("voronoi");
    expect(n.x).toBe(10);
    expect(n.y).toBe(20);
    expect(n.params?.scale).toBe(6);
    expect(g.nodes.filter((x) => x.id === n.id)).toHaveLength(1);
  });
});

describe("removeNode", () => {
  it("removes a node and nulls inbound references", () => {
    const g = freshGraph();
    // ramp.fac references src; remove src → ramp.fac becomes null.
    expect(removeNode(g, "src")).toBe(true);
    expect(g.nodes.some((n) => n.id === "src")).toBe(false);
    const ramp = g.nodes.find((n) => n.id === "ramp")!;
    expect(ramp.inputs?.fac).toBeNull();
  });

  it("refuses to remove the output node", () => {
    const g = freshGraph();
    expect(removeNode(g, g.outputId)).toBe(false);
    expect(g.nodes.some((n) => n.id === g.outputId)).toBe(true);
  });

  it("returns false for an unknown node", () => {
    expect(removeNode(freshGraph(), "ghost")).toBe(false);
  });
});

describe("connect / disconnect", () => {
  it("wires a source output into a target input", () => {
    const g = freshGraph();
    const c = addNode(g, "constColor", 0, 0);
    expect(connect(g, c.id, g.outputId, "albedo")).toBe(true);
    const out = g.nodes.find((n) => n.id === g.outputId)!;
    expect(out.inputs?.albedo).toBe(c.id);
  });

  it("rejects an unknown input port", () => {
    const g = freshGraph();
    const c = addNode(g, "constColor", 0, 0);
    expect(connect(g, c.id, g.outputId, "nope")).toBe(false);
  });

  it("rejects connecting from the output node (no output port)", () => {
    const g = freshGraph();
    const c = addNode(g, "constColor", 0, 0);
    expect(connect(g, g.outputId, c.id, "fac")).toBe(false);
  });

  it("disconnect clears a port", () => {
    const g = freshGraph();
    expect(disconnect(g, "ramp", "fac")).toBe(true);
    expect(g.nodes.find((n) => n.id === "ramp")!.inputs?.fac).toBeNull();
    // Already cleared → false.
    expect(disconnect(g, "ramp", "fac")).toBe(false);
  });
});

describe("cycle prevention", () => {
  it("dependsOn follows input edges transitively", () => {
    const g = freshGraph();
    // ramp depends on src depends on uv.
    expect(dependsOn(g, "ramp", "src")).toBe(true);
    expect(dependsOn(g, "ramp", "uv")).toBe(true);
    expect(dependsOn(g, "uv", "ramp")).toBe(false);
  });

  it("wouldCreateCycle flags a self or back edge", () => {
    const g = freshGraph();
    expect(wouldCreateCycle(g, "src", "src")).toBe(true);
    // Connecting ramp → src.uv would loop (src→...→ramp already? ramp depends on src),
    // i.e. source=ramp depends on target=src → cycle.
    expect(wouldCreateCycle(g, "ramp", "src")).toBe(true);
  });

  it("connect refuses an edge that would create a cycle", () => {
    const g = freshGraph();
    // src.uv currently → uv. Try to feed ramp (which depends on src) into src.uv.
    expect(connect(g, "ramp", "src", "uv")).toBe(false);
    // src.uv unchanged.
    expect(g.nodes.find((n) => n.id === "src")!.inputs?.uv).toBe("uv");
  });

  it("allows a valid non-cyclic rewire", () => {
    const g = freshGraph();
    const map = addNode(g, "mapping", 0, 0);
    // uv → mapping.uv, then mapping → src.uv. No cycle.
    expect(connect(g, "uv", map.id, "uv")).toBe(true);
    expect(connect(g, map.id, "src", "uv")).toBe(true);
    expect(g.nodes.find((n) => n.id === "src")!.inputs?.uv).toBe(map.id);
  });
});

describe("NODE_DEFS", () => {
  it("marks output as non-addable with no output port", () => {
    expect(NODE_DEFS.output.addable).toBe(false);
    expect(NODE_DEFS.output.out).toBeNull();
    expect(NODE_DEFS.output.inputs.map((i) => i.name)).toContain("height");
  });
  it("defines an output kind for every addable node", () => {
    for (const [type, def] of Object.entries(NODE_DEFS)) {
      if (def.addable) expect(def.out, type).not.toBeNull();
    }
  });
});

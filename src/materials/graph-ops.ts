import type { ProceduralGraph, ProcNode, ProcNodeType, ProcParams } from "./procedural-graph";

/**
 * Pure graph-editing operations for the node editor — add / remove / connect /
 * disconnect with cycle prevention. Kept separate from the canvas UI so the
 * mutation rules (and the no-cycle guarantee) are unit-tested without any DOM.
 */

export type PortKind = "float" | "color";

export interface NodeDef {
  title: string;
  /** Input ports in display order. */
  inputs: { name: string; kind: PortKind }[];
  /** Output kind, or null for the terminal output node. */
  out: PortKind | null;
  /** Whether the palette offers this node (output is fixed, not addable). */
  addable: boolean;
}

/** Static port/metadata table per node type — drives the editor's ports & palette. */
export const NODE_DEFS: Record<ProcNodeType, NodeDef> = {
  uv: { title: "UV", inputs: [], out: "color", addable: true },
  mapping: { title: "Mapping", inputs: [{ name: "uv", kind: "color" }], out: "color", addable: true },
  noise: { title: "Noise", inputs: [{ name: "uv", kind: "color" }], out: "float", addable: true },
  voronoi: { title: "Voronoi", inputs: [{ name: "uv", kind: "color" }], out: "float", addable: true },
  brick: { title: "Brick", inputs: [{ name: "uv", kind: "color" }], out: "float", addable: true },
  checker: { title: "Checker", inputs: [{ name: "uv", kind: "color" }], out: "float", addable: true },
  gradient: { title: "Gradient", inputs: [{ name: "uv", kind: "color" }], out: "float", addable: true },
  colorRamp: { title: "Color Ramp", inputs: [{ name: "fac", kind: "float" }], out: "color", addable: true },
  mix: {
    title: "Mix",
    inputs: [
      { name: "a", kind: "color" },
      { name: "b", kind: "color" },
      { name: "fac", kind: "float" },
    ],
    out: "color",
    addable: true,
  },
  math: {
    title: "Math",
    inputs: [
      { name: "a", kind: "float" },
      { name: "b", kind: "float" },
    ],
    out: "float",
    addable: true,
  },
  constColor: { title: "Color", inputs: [], out: "color", addable: true },
  constFloat: { title: "Value", inputs: [], out: "float", addable: true },
  output: {
    title: "Output",
    inputs: [
      { name: "albedo", kind: "color" },
      { name: "roughness", kind: "float" },
      { name: "metallic", kind: "float" },
      { name: "height", kind: "float" },
    ],
    out: null,
    addable: false,
  },
};

/** Sensible default params for a freshly added node. */
export function defaultParamsFor(type: ProcNodeType): ProcParams | undefined {
  switch (type) {
    case "mapping":
      return { scale: 1, offsetX: 0, offsetY: 0, rotation: 0 };
    case "noise":
      return { scale: 8, contrast: 1.5, seed: 0 };
    case "voronoi":
      return { scale: 6, contrast: 1, seed: 0 };
    case "brick":
      return { scale: 6, contrast: 0.08 };
    case "checker":
      return { scale: 8 };
    case "gradient":
      return { axis: 0 };
    case "colorRamp":
      return { colorA: "#000000", colorB: "#ffffff" };
    case "mix":
      return { op: 0 };
    case "math":
      return { op: 2, value: 0.5 };
    case "constColor":
      return { colorA: "#808080" };
    case "constFloat":
      return { value: 0.5 };
    default:
      return undefined;
  }
}

let _idCounter = 0;
/** Generate a unique node id. Deterministic per process run (no Math.random). */
export function nextNodeId(graph: ProceduralGraph): string {
  let id: string;
  do {
    id = "n" + ++_idCounter;
  } while (graph.nodes.some((n) => n.id === id));
  return id;
}

/** Add a node of `type` at (x,y). Returns the created node. */
export function addNode(graph: ProceduralGraph, type: ProcNodeType, x: number, y: number): ProcNode {
  const node: ProcNode = { id: nextNodeId(graph), type, x, y };
  const params = defaultParamsFor(type);
  if (params) node.params = params;
  graph.nodes.push(node);
  return node;
}

/**
 * Remove a node and clear any inputs that referenced it. The output node
 * cannot be removed. Returns true if a node was removed.
 */
export function removeNode(graph: ProceduralGraph, nodeId: string): boolean {
  if (nodeId === graph.outputId) return false;
  const idx = graph.nodes.findIndex((n) => n.id === nodeId);
  if (idx < 0) return false;
  graph.nodes.splice(idx, 1);
  for (const n of graph.nodes) {
    if (!n.inputs) continue;
    for (const k of Object.keys(n.inputs)) {
      if (n.inputs[k] === nodeId) n.inputs[k] = null;
    }
  }
  return true;
}

/** Does `targetId` (transitively) feed into `sourceId` via input edges? */
export function dependsOn(graph: ProceduralGraph, sourceId: string, targetId: string): boolean {
  const seen = new Set<string>();
  const visit = (id: string): boolean => {
    if (id === targetId) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    const node = graph.nodes.find((n) => n.id === id);
    if (!node?.inputs) return false;
    for (const src of Object.values(node.inputs)) {
      if (src && visit(src)) return true;
    }
    return false;
  };
  return visit(sourceId);
}

/**
 * Connecting `sourceId` → `targetId.inputName` would create a cycle when the
 * source already depends on the target.
 */
export function wouldCreateCycle(graph: ProceduralGraph, sourceId: string, targetId: string): boolean {
  if (sourceId === targetId) return true;
  return dependsOn(graph, sourceId, targetId);
}

/**
 * Wire `sourceId`'s output into `targetId`'s `inputName` port. Rejected (returns
 * false) when either node is missing, the port is unknown, or it would create a
 * cycle. Port kind mismatches are allowed (the evaluator coerces float↔color).
 */
export function connect(
  graph: ProceduralGraph,
  sourceId: string,
  targetId: string,
  inputName: string
): boolean {
  const source = graph.nodes.find((n) => n.id === sourceId);
  const target = graph.nodes.find((n) => n.id === targetId);
  if (!source || !target) return false;
  if (NODE_DEFS[source.type].out === null) return false; // output node has no output
  if (!NODE_DEFS[target.type].inputs.some((p) => p.name === inputName)) return false;
  if (wouldCreateCycle(graph, sourceId, targetId)) return false;
  if (!target.inputs) target.inputs = {};
  target.inputs[inputName] = sourceId;
  return true;
}

/** Clear a node's input port. Returns true if it had a connection. */
export function disconnect(graph: ProceduralGraph, targetId: string, inputName: string): boolean {
  const target = graph.nodes.find((n) => n.id === targetId);
  if (!target?.inputs || !target.inputs[inputName]) return false;
  target.inputs[inputName] = null;
  return true;
}

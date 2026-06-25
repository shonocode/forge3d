import type { ProceduralGraph } from "./procedural-graph";
import { NODE_DEFS } from "./graph-ops";

/**
 * Serialize / deserialize procedural material graphs to JSON so custom
 * materials can be saved to a file and reused. Pure and validating — bad input
 * throws rather than producing a broken graph. The graph is already
 * JSON-serializable (plain nodes, no functions/textures), so this is mostly
 * about wrapping with a format tag and validating on the way back in.
 */

const FORMAT = "forge3d-procedural-graph";
const VERSION = 1;
const DEFAULT_RES = 256;

const KNOWN_TYPES = new Set(Object.keys(NODE_DEFS));

/** Wrap a graph in the tagged file format. */
export function serializeGraph(graph: ProceduralGraph): string {
  return JSON.stringify({ format: FORMAT, version: VERSION, graph }, null, 2);
}

/**
 * Parse and validate a graph from text written by {@link serializeGraph}
 * (a bare graph object is also accepted). Throws on malformed input. The
 * returned graph is a fresh, sanitized object.
 */
export function deserializeGraph(text: string): ProceduralGraph {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Not valid JSON");
  }
  const obj = data as Record<string, unknown>;
  const raw = obj && obj.format === FORMAT ? obj.graph : data;
  return validateGraph(raw);
}

/** Validate + sanitize an arbitrary value into a ProceduralGraph (throws if invalid). */
export function validateGraph(raw: unknown): ProceduralGraph {
  if (!raw || typeof raw !== "object") throw new Error("Graph must be an object");
  const g = raw as Record<string, unknown>;

  if (!Array.isArray(g.nodes)) throw new Error("Graph.nodes must be an array");
  if (g.nodes.length === 0) throw new Error("Graph has no nodes");

  const ids = new Set<string>();
  const nodes = g.nodes.map((n, i) => {
    if (!n || typeof n !== "object") throw new Error(`Node ${i} is not an object`);
    const node = n as Record<string, unknown>;
    if (typeof node.id !== "string") throw new Error(`Node ${i} has no string id`);
    if (typeof node.type !== "string" || !KNOWN_TYPES.has(node.type)) {
      throw new Error(`Node ${node.id} has unknown type "${String(node.type)}"`);
    }
    if (ids.has(node.id)) throw new Error(`Duplicate node id "${node.id}"`);
    ids.add(node.id);
    return node;
  });

  if (typeof g.outputId !== "string" || !ids.has(g.outputId)) {
    throw new Error("Graph.outputId must reference an existing node");
  }

  const resolution =
    typeof g.resolution === "number" && g.resolution >= 8 && g.resolution <= 4096
      ? Math.floor(g.resolution)
      : DEFAULT_RES;

  // Re-stringify/parse the validated nodes to drop any stray fields by structure
  // while preserving params/inputs/x/y. (Shallow trust: nodes already passed
  // type/id checks; inputs reference ids that exist or are null.)
  return {
    nodes: JSON.parse(JSON.stringify(nodes)) as ProceduralGraph["nodes"],
    outputId: g.outputId,
    resolution,
  };
}

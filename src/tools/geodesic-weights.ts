import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { distancePointToSegment, type BoneSegment, type AutoWeightOptions } from "./auto-weights";

/**
 * Geodesic (surface-distance) auto-weighting.
 *
 * Plain distance-to-bone binding (see `auto-weights.computeAutoWeights`) bleeds
 * across nearby-but-disconnected surfaces — a torso vertex picks up arm-bone
 * weight just because the wrist passes close in space. Geodesic binding instead
 * measures distance *along the mesh surface* via a vertex connectivity graph, so
 * influence only spreads where the mesh actually connects.
 *
 * All pure and headless: the graph build, Dijkstra, and weight assignment are
 * deterministic and unit-testable. `auto-weights.applyAutoWeights` does the
 * scene-space plumbing and buffer writes.
 */

const MAX_INFLUENCES = 4;

export interface MeshGraph {
  nodeCount: number;
  /** Original vertex index → welded node id (vertices at one position share a node). */
  vertexToNode: Int32Array;
  /** Representative position per node, flat XYZ (length nodeCount * 3). */
  nodePos: Float32Array;
  /** Undirected adjacency: per node, its neighbors and edge lengths. */
  adjacency: Array<Array<{ to: number; w: number }>>;
}

/**
 * Build a connectivity graph from triangle-indexed geometry. Vertices at the
 * same position (split for UV/normal seams) are welded into one node so the
 * surface stays connected across seams; triangle edges become graph edges
 * weighted by Euclidean length.
 */
export function buildMeshGraph(positions: ArrayLike<number>, indices: ArrayLike<number>): MeshGraph {
  const vertexCount = Math.floor(positions.length / 3);
  const Q = 1e5; // position weld quantization (~1e-5 units)

  const keyToNode = new Map<string, number>();
  const vertexToNode = new Int32Array(vertexCount);
  const nodePosList: number[] = [];

  for (let i = 0; i < vertexCount; i++) {
    const x = positions[i * 3]!;
    const y = positions[i * 3 + 1]!;
    const z = positions[i * 3 + 2]!;
    const key = Math.round(x * Q) + "," + Math.round(y * Q) + "," + Math.round(z * Q);
    let node = keyToNode.get(key);
    if (node === undefined) {
      node = nodePosList.length / 3;
      keyToNode.set(key, node);
      nodePosList.push(x, y, z);
    }
    vertexToNode[i] = node;
  }

  const nodeCount = nodePosList.length / 3;
  const nodePos = Float32Array.from(nodePosList);
  const adjacency: Array<Array<{ to: number; w: number }>> = Array.from(
    { length: nodeCount },
    () => []
  );

  const edgeKeys = new Set<string>();
  const addEdge = (a: number, b: number): void => {
    if (a === b) return;
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    const k = lo + "_" + hi;
    if (edgeKeys.has(k)) return;
    edgeKeys.add(k);
    const dx = nodePos[a * 3]! - nodePos[b * 3]!;
    const dy = nodePos[a * 3 + 1]! - nodePos[b * 3 + 1]!;
    const dz = nodePos[a * 3 + 2]! - nodePos[b * 3 + 2]!;
    const w = Math.sqrt(dx * dx + dy * dy + dz * dz);
    adjacency[a]!.push({ to: b, w });
    adjacency[b]!.push({ to: a, w });
  };

  const triCount = Math.floor(indices.length / 3);
  for (let t = 0; t < triCount; t++) {
    const a = vertexToNode[indices[t * 3]!]!;
    const b = vertexToNode[indices[t * 3 + 1]!]!;
    const c = vertexToNode[indices[t * 3 + 2]!]!;
    addEdge(a, b);
    addEdge(b, c);
    addEdge(c, a);
  }

  return { nodeCount, vertexToNode, nodePos, adjacency };
}

/** Minimal binary min-heap over (node, dist) pairs for Dijkstra. */
class MinHeap {
  private nodes: number[] = [];
  private dists: number[] = [];

  get size(): number {
    return this.nodes.length;
  }

  push(node: number, dist: number): void {
    this.nodes.push(node);
    this.dists.push(dist);
    let i = this.nodes.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.dists[parent]! <= this.dists[i]!) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): { node: number; dist: number } {
    const node = this.nodes[0]!;
    const dist = this.dists[0]!;
    const lastN = this.nodes.pop()!;
    const lastD = this.dists.pop()!;
    if (this.nodes.length > 0) {
      this.nodes[0] = lastN;
      this.dists[0] = lastD;
      this.siftDown(0);
    }
    return { node, dist };
  }

  private siftDown(i: number): void {
    const n = this.nodes.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let smallest = i;
      if (l < n && this.dists[l]! < this.dists[smallest]!) smallest = l;
      if (r < n && this.dists[r]! < this.dists[smallest]!) smallest = r;
      if (smallest === i) break;
      this.swap(i, smallest);
      i = smallest;
    }
  }

  private swap(a: number, b: number): void {
    const tn = this.nodes[a]!;
    this.nodes[a] = this.nodes[b]!;
    this.nodes[b] = tn;
    const td = this.dists[a]!;
    this.dists[a] = this.dists[b]!;
    this.dists[b] = td;
  }
}

/**
 * Single-source shortest path (Dijkstra) over the mesh graph. `startOffset`
 * seeds the source distance (the Euclidean gap from the bone to the seed node),
 * so geodesic distances are measured from the bone surface, not from zero.
 */
export function dijkstra(graph: MeshGraph, source: number, startOffset: number): Float32Array {
  const dist = new Float32Array(graph.nodeCount).fill(Infinity);
  dist[source] = startOffset;
  const heap = new MinHeap();
  heap.push(source, startOffset);

  while (heap.size > 0) {
    const { node, dist: d } = heap.pop();
    if (d > dist[node]!) continue; // stale entry
    for (const e of graph.adjacency[node]!) {
      const nd = d + e.w;
      if (nd < dist[e.to]!) {
        dist[e.to] = nd;
        heap.push(e.to, nd);
      }
    }
  }
  return dist;
}

/**
 * Compute skin weights using geodesic (on-surface) distance to each bone.
 *
 * For each bone the nearest mesh node to its segment seeds a Dijkstra sweep;
 * vertices then weight by inverse geodesic distance to the strongest
 * `maxInfluences` bones, normalized to 1. Bones on a disconnected mesh island
 * contribute nothing (infinite geodesic distance) rather than bleeding through.
 *
 * @returns 4-wide `indices`/`weights` buffers (length vertexCount * 4).
 */
export function computeAutoWeightsGeodesic(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  segments: BoneSegment[],
  options: AutoWeightOptions = {}
): { indices: Float32Array; weights: Float32Array } {
  const maxInf = Math.min(options.maxInfluences ?? MAX_INFLUENCES, MAX_INFLUENCES);
  const falloff = options.falloff ?? 4;
  const eps = 1e-4;

  const graph = buildMeshGraph(positions, indices);
  const vertexCount = Math.floor(positions.length / 3);

  // Per bone: seed at the node nearest its segment, sweep geodesic distances.
  const boneGeo: Float32Array[] = [];
  const np = new Vector3();
  for (const seg of segments) {
    let bestNode = -1;
    let bestD = Infinity;
    for (let nd = 0; nd < graph.nodeCount; nd++) {
      np.set(graph.nodePos[nd * 3]!, graph.nodePos[nd * 3 + 1]!, graph.nodePos[nd * 3 + 2]!);
      const d = distancePointToSegment(np, seg.head, seg.tail);
      if (d < bestD) {
        bestD = d;
        bestNode = nd;
      }
    }
    boneGeo.push(
      bestNode < 0
        ? new Float32Array(graph.nodeCount).fill(Infinity)
        : dijkstra(graph, bestNode, bestD)
    );
  }

  const indicesOut = new Float32Array(vertexCount * MAX_INFLUENCES);
  const weightsOut = new Float32Array(vertexCount * MAX_INFLUENCES);
  const cand: { idx: number; w: number }[] = [];

  for (let vi = 0; vi < vertexCount; vi++) {
    const node = graph.vertexToNode[vi]!;
    cand.length = 0;
    for (let b = 0; b < segments.length; b++) {
      const gd = boneGeo[b]![node]!;
      if (!Number.isFinite(gd)) continue;
      cand.push({ idx: segments[b]!.boneIndex, w: 1 / Math.pow(Math.max(gd, eps), falloff) });
    }

    cand.sort((a, b) => b.w - a.w);
    const keep = Math.min(maxInf, cand.length);

    let sum = 0;
    for (let s = 0; s < keep; s++) sum += cand[s]!.w;

    const base = vi * MAX_INFLUENCES;
    if (sum <= 0 || keep === 0) {
      indicesOut[base] = 0;
      weightsOut[base] = 1;
      continue;
    }
    for (let s = 0; s < MAX_INFLUENCES; s++) {
      if (s < keep) {
        indicesOut[base + s] = cand[s]!.idx;
        weightsOut[base + s] = cand[s]!.w / sum;
      } else {
        indicesOut[base + s] = 0;
        weightsOut[base + s] = 0;
      }
    }
  }

  return { indices: indicesOut, weights: weightsOut };
}

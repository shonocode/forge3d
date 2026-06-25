import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { state, status } from "../state";
import { getActiveSkeleton, getBoneWorldPosition } from "./skeleton-tool";
import { computeAutoWeightsGeodesic } from "./geodesic-weights";

/** Babylon skins with at most 4 bone influences per vertex. */
const MAX_INFLUENCES = 4;

/**
 * One deformable bone, expressed as the line segment it spans from its head
 * (parent joint) to its tail (the bone's own joint). A root bone is a
 * degenerate segment where head === tail.
 */
export interface BoneSegment {
  /** Index into `skeleton.bones` — written verbatim into MatricesIndices. */
  boneIndex: number;
  head: Vector3;
  tail: Vector3;
}

export interface AutoWeightOptions {
  /** Bones contributing to each vertex, capped at MAX_INFLUENCES (default 4). */
  maxInfluences?: number;
  /** Inverse-distance exponent — higher = tighter, more rigid binding. */
  falloff?: number;
}

/**
 * Shortest distance from point `p` to the segment `a`→`b`. Collapses to
 * point-distance when the segment is degenerate (root bones).
 */
export function distancePointToSegment(p: Vector3, a: Vector3, b: Vector3): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const lenSq = abx * abx + aby * aby + abz * abz;

  if (lenSq < 1e-12) {
    // Degenerate segment — distance to the single point.
    return Vector3.Distance(p, a);
  }

  // Project p onto the infinite line, clamp the parameter to [0,1].
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;

  const cx = a.x + abx * t;
  const cy = a.y + aby * t;
  const cz = a.z + abz * t;
  const dx = p.x - cx;
  const dy = p.y - cy;
  const dz = p.z - cz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Compute skin weights by binding each vertex to its nearest bone segments
 * with an inverse-distance-to-segment falloff (a "bone heat" approximation).
 *
 * Pure and headless — operates only on numbers and Vector3 — so the binding
 * math is unit-testable without a scene. `applyAutoWeights` does the
 * scene-space plumbing and buffer writes.
 *
 * @param positions Flat XYZ vertex positions, length = vertexCount * 3, in
 *   the same space as the segments (mesh-local).
 * @param segments One per deformable bone.
 * @returns 4-wide `indices` and `weights` buffers (length vertexCount * 4).
 *   Each vertex's weights are normalized to sum to 1; unused slots are zero.
 */
export function computeAutoWeights(
  positions: ArrayLike<number>,
  segments: BoneSegment[],
  options: AutoWeightOptions = {}
): { indices: Float32Array; weights: Float32Array } {
  const maxInf = Math.min(options.maxInfluences ?? MAX_INFLUENCES, MAX_INFLUENCES);
  const falloff = options.falloff ?? 4;
  const eps = 1e-4;

  const vertexCount = Math.floor(positions.length / 3);
  const indices = new Float32Array(vertexCount * MAX_INFLUENCES);
  const weights = new Float32Array(vertexCount * MAX_INFLUENCES);

  const p = new Vector3();
  // Reused per-vertex candidate list (boneIndex + raw weight before normalize).
  const cand: { idx: number; w: number }[] = [];

  for (let vi = 0; vi < vertexCount; vi++) {
    p.set(positions[vi * 3]!, positions[vi * 3 + 1]!, positions[vi * 3 + 2]!);

    cand.length = 0;
    for (const seg of segments) {
      const d = distancePointToSegment(p, seg.head, seg.tail);
      const w = 1 / Math.pow(Math.max(d, eps), falloff);
      cand.push({ idx: seg.boneIndex, w });
    }

    // Keep the strongest `maxInf` influences.
    cand.sort((a, b) => b.w - a.w);
    const keep = Math.min(maxInf, cand.length);

    let sum = 0;
    for (let s = 0; s < keep; s++) sum += cand[s]!.w;

    const base = vi * MAX_INFLUENCES;
    if (sum <= 0 || keep === 0) {
      // No bones (or all infinitely far) — fall back to the root bone.
      indices[base] = 0;
      weights[base] = 1;
      continue;
    }

    for (let s = 0; s < MAX_INFLUENCES; s++) {
      if (s < keep) {
        indices[base + s] = cand[s]!.idx;
        weights[base + s] = cand[s]!.w / sum;
      } else {
        indices[base + s] = 0;
        weights[base + s] = 0;
      }
    }
  }

  return { indices, weights };
}

/**
 * Automatically bind the mesh's vertices to the active skeleton, replacing
 * any existing weights. Builds a bone segment (parent joint → bone joint) per
 * bone in mesh-local space, computes weights, writes the skin buffers, and
 * registers an undo entry.
 *
 * With `{ geodesic: true }` the binding measures distance along the mesh
 * surface (preventing bleed between nearby-but-disconnected parts) instead of
 * straight-line distance. Falls back to straight-line when the mesh has no
 * index buffer to build a surface graph from.
 */
export function applyAutoWeights(mesh: AbstractMesh, opts: { geodesic?: boolean } = {}): void {
  const skelData = getActiveSkeleton();
  if (!skelData) {
    status("⚠ No active skeleton");
    return;
  }
  if (!mesh.skeleton) {
    status("⚠ Skeleton not assigned to mesh");
    return;
  }

  const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!pos) return;

  // Bone visuals live in world space; vertices are mesh-local. Bring the
  // bones into mesh-local space so distances are measured consistently.
  let inv: Matrix;
  try {
    inv = Matrix.Invert(mesh.getWorldMatrix());
  } catch (e) {
    console.warn("Auto weights: matrix inversion failed", e);
    return;
  }

  const segments: BoneSegment[] = [];
  for (const bd of skelData.bones) {
    const boneIndex = skelData.skeleton.bones.indexOf(bd.bone);
    if (boneIndex === -1) continue;

    const tail = Vector3.TransformCoordinates(getBoneWorldPosition(bd), inv);
    let head = tail;
    if (bd.parentId) {
      const parent = skelData.bones.find((b) => b.id === bd.parentId);
      if (parent) {
        head = Vector3.TransformCoordinates(getBoneWorldPosition(parent), inv);
      }
    }
    segments.push({ boneIndex, head, tail });
  }

  if (segments.length === 0) {
    status("⚠ No bones to bind");
    return;
  }

  const computeOpts = { maxInfluences: MAX_INFLUENCES, falloff: 4 };
  let mode = "distance";
  let computed: { indices: Float32Array; weights: Float32Array };
  if (opts.geodesic) {
    const tris = mesh.getIndices();
    if (tris && tris.length >= 3) {
      computed = computeAutoWeightsGeodesic(pos, tris, segments, computeOpts);
      mode = "geodesic";
    } else {
      computed = computeAutoWeights(pos, segments, computeOpts);
    }
  } else {
    computed = computeAutoWeights(pos, segments, computeOpts);
  }
  const { indices, weights } = computed;

  // Snapshot existing skin data for undo.
  const prevIndices = mesh.getVerticesData(VertexBuffer.MatricesIndicesKind);
  const prevWeights = mesh.getVerticesData(VertexBuffer.MatricesWeightsKind);
  const prevInfluencers = mesh.numBoneInfluencers;
  const indSnap = prevIndices ? new Float32Array(prevIndices) : null;
  const wSnap = prevWeights ? new Float32Array(prevWeights) : null;

  mesh.setVerticesData(VertexBuffer.MatricesIndicesKind, indices, true);
  mesh.setVerticesData(VertexBuffer.MatricesWeightsKind, weights, true);
  mesh.numBoneInfluencers = MAX_INFLUENCES;

  state.history.push({
    label: "Auto Weights",
    undo() {
      if (indSnap && wSnap) {
        mesh.setVerticesData(VertexBuffer.MatricesIndicesKind, indSnap, true);
        mesh.setVerticesData(VertexBuffer.MatricesWeightsKind, wSnap, true);
        mesh.numBoneInfluencers = prevInfluencers;
      } else {
        const zero = new Float32Array(indices.length);
        mesh.setVerticesData(VertexBuffer.MatricesIndicesKind, zero, true);
        mesh.setVerticesData(VertexBuffer.MatricesWeightsKind, zero, true);
        mesh.numBoneInfluencers = 0;
      }
    },
    redo() {
      mesh.setVerticesData(VertexBuffer.MatricesIndicesKind, indices, true);
      mesh.setVerticesData(VertexBuffer.MatricesWeightsKind, weights, true);
      mesh.numBoneInfluencers = MAX_INFLUENCES;
    },
  });

  status("Auto weights applied (" + segments.length + " bones, " + mode + ")");
}

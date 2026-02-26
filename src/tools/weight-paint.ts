import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { PickingInfo } from "@babylonjs/core/Collisions/pickingInfo";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { state, status } from "../state";
import { lastSelected } from "./selection";
import { getActiveSkeleton } from "./skeleton-tool";

const MAX_INFLUENCES = 4;

// ── Weight data initialization ──

/**
 * Initialize MatricesIndices and MatricesWeights buffers for a mesh.
 * All vertices default to bone index 0, weight 1.0.
 */
export function initWeightData(mesh: AbstractMesh): void {
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
  const vertexCount = pos.length / 3;

  // Check if weight data already exists
  const existing = mesh.getVerticesData(VertexBuffer.MatricesWeightsKind);
  if (existing && existing.length === vertexCount * MAX_INFLUENCES) {
    status("Weight data already initialized");
    return;
  }

  const indices = new Float32Array(vertexCount * MAX_INFLUENCES);
  const weights = new Float32Array(vertexCount * MAX_INFLUENCES);

  // Default: all vertices → bone 0, weight 1.0
  for (let i = 0; i < vertexCount; i++) {
    const base = i * MAX_INFLUENCES;
    indices[base] = 0;
    indices[base + 1] = 0;
    indices[base + 2] = 0;
    indices[base + 3] = 0;
    weights[base] = 1;
    weights[base + 1] = 0;
    weights[base + 2] = 0;
    weights[base + 3] = 0;
  }

  mesh.setVerticesData(VertexBuffer.MatricesIndicesKind, indices, true);
  mesh.setVerticesData(VertexBuffer.MatricesWeightsKind, weights, true);

  // Need to set numBoneInfluencers
  mesh.numBoneInfluencers = MAX_INFLUENCES;

  status("Weight data initialized (" + vertexCount + " vertices)");
}

/**
 * Check if mesh has weight data initialized.
 */
export function hasWeightData(mesh: AbstractMesh): boolean {
  const w = mesh.getVerticesData(VertexBuffer.MatricesWeightsKind);
  return w != null && w.length > 0;
}

// ── Weight painting ──

/**
 * Paint weight at the picked point for the currently selected bone.
 */
export function paintWeightAt(mesh: AbstractMesh, pick: PickingInfo): void {
  if (!pick.hit || !pick.pickedPoint) return;
  if (!state.selectedBoneId) {
    status("⚠ Select a bone first");
    return;
  }

  const skelData = getActiveSkeleton();
  if (!skelData || !mesh.skeleton) return;

  // Find bone index in skeleton
  const boneData = skelData.bones.find((b) => b.id === state.selectedBoneId);
  if (!boneData) return;
  const boneIndex = skelData.skeleton.bones.indexOf(boneData.bone);
  if (boneIndex === -1) return;

  const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
  const indices = mesh.getVerticesData(VertexBuffer.MatricesIndicesKind);
  const weights = mesh.getVerticesData(VertexBuffer.MatricesWeightsKind);
  if (!pos || !indices || !weights) return;

  // Transform hit point to local space
  const hitW = pick.pickedPoint;
  let inv: Matrix;
  try {
    inv = Matrix.Invert(mesh.getWorldMatrix());
  } catch {
    return;
  }
  const hitL = Vector3.TransformCoordinates(hitW, inv);

  const { radius: R, strength: S, falloff: F, mode } = state.weightConfig;
  const ctrlDown = state.keysDown.has("Control") || state.keysDown.has("Meta") || state.touchModifiers.ctrl;
  const shiftDown = state.keysDown.has("Shift") || state.touchModifiers.shift;
  const effectiveMode = shiftDown ? "smooth" : ctrlDown ? "subtract" : mode;

  const R2 = R * R;
  const vertexCount = pos.length / 3;

  // For smooth mode, pre-compute neighbor averages
  let avgWeights: Float32Array | null = null;
  if (effectiveMode === "smooth") {
    avgWeights = computeNeighborAverageWeights(pos, indices, weights, hitL, R, boneIndex);
  }

  let modified = false;
  for (let vi = 0; vi < vertexCount; vi++) {
    const pi = vi * 3;
    const dx = pos[pi]! - hitL.x;
    const dy = pos[pi + 1]! - hitL.y;
    const dz = pos[pi + 2]! - hitL.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= R2) continue;

    const dist = Math.sqrt(d2);
    const fall = Math.pow(1 - dist / R, F);
    const str = fall * S;

    const base = vi * MAX_INFLUENCES;

    if (effectiveMode === "smooth" && avgWeights) {
      // Blend toward neighbor average
      const currentWeight = getSlotWeight(indices, weights, base, boneIndex);
      const targetWeight = avgWeights[vi]!;
      const newWeight = currentWeight + (targetWeight - currentWeight) * str;
      setSlotWeight(indices, weights, base, boneIndex, Math.max(0, Math.min(1, newWeight)));
    } else if (effectiveMode === "subtract") {
      const currentWeight = getSlotWeight(indices, weights, base, boneIndex);
      const newWeight = Math.max(0, currentWeight - str);
      setSlotWeight(indices, weights, base, boneIndex, newWeight);
    } else {
      // add
      const currentWeight = getSlotWeight(indices, weights, base, boneIndex);
      const newWeight = Math.min(1, currentWeight + str);
      setSlotWeight(indices, weights, base, boneIndex, newWeight);
    }

    // Normalize so all weights sum to 1.0
    normalizeWeights(weights, base);
    modified = true;
  }

  if (modified) {
    mesh.updateVerticesData(VertexBuffer.MatricesIndicesKind, indices);
    mesh.updateVerticesData(VertexBuffer.MatricesWeightsKind, weights);

    // Update overlay if active
    if (state.weightOverlayActive) {
      updateWeightOverlay(mesh, boneIndex);
    }
  }
}

// ── Slot management ──

/**
 * Get the weight for a specific bone in a vertex's 4 influence slots.
 */
function getSlotWeight(
  indices: Float32Array | number[],
  weights: Float32Array | number[],
  base: number,
  boneIndex: number
): number {
  for (let s = 0; s < MAX_INFLUENCES; s++) {
    if (indices[base + s] === boneIndex && weights[base + s]! > 0) {
      return weights[base + s]!;
    }
  }
  return 0;
}

/**
 * Set the weight for a specific bone in a vertex's 4 influence slots.
 * Finds existing slot or replaces lowest-weight slot.
 */
function setSlotWeight(
  indices: Float32Array | number[],
  weights: Float32Array | number[],
  base: number,
  boneIndex: number,
  weight: number
): void {
  // Find existing slot for this bone
  for (let s = 0; s < MAX_INFLUENCES; s++) {
    if (indices[base + s] === boneIndex) {
      weights[base + s] = weight;
      return;
    }
  }

  // Find empty slot (weight = 0)
  for (let s = 0; s < MAX_INFLUENCES; s++) {
    if (weights[base + s]! <= 0) {
      indices[base + s] = boneIndex;
      weights[base + s] = weight;
      return;
    }
  }

  // Replace slot with lowest weight if new weight is higher
  let minSlot = 0;
  let minWeight = weights[base]!;
  for (let s = 1; s < MAX_INFLUENCES; s++) {
    if (weights[base + s]! < minWeight) {
      minWeight = weights[base + s]!;
      minSlot = s;
    }
  }
  if (weight > minWeight) {
    indices[base + minSlot] = boneIndex;
    weights[base + minSlot] = weight;
  }
}

/**
 * Normalize weights for a single vertex so they sum to 1.0.
 */
function normalizeWeights(weights: Float32Array | number[], base: number): void {
  let sum = 0;
  for (let s = 0; s < MAX_INFLUENCES; s++) {
    sum += weights[base + s]!;
  }
  if (sum > 0) {
    for (let s = 0; s < MAX_INFLUENCES; s++) {
      weights[base + s] = weights[base + s]! / sum;
    }
  } else {
    // Fallback: assign all weight to slot 0
    weights[base] = 1;
  }
}

// ── Smooth mode helpers ──

function computeNeighborAverageWeights(
  pos: Float32Array | number[],
  indices: Float32Array | number[],
  weights: Float32Array | number[],
  center: Vector3,
  R: number,
  boneIndex: number
): Float32Array {
  const vertexCount = pos.length / 3;
  const result = new Float32Array(vertexCount);
  const R2 = R * R;
  const hR = R * 0.6;
  const hR2 = hR * hR;

  // Collect vertices in range
  const inRange: number[] = [];
  for (let i = 0; i < vertexCount; i++) {
    const pi = i * 3;
    const dx = pos[pi]! - center.x;
    const dy = pos[pi + 1]! - center.y;
    const dz = pos[pi + 2]! - center.z;
    if (dx * dx + dy * dy + dz * dz < R2) inRange.push(i);
  }

  for (const i of inRange) {
    const pi = i * 3;
    let sumW = 0;
    let cnt = 0;
    for (const j of inRange) {
      if (j === i) continue;
      const pj = j * 3;
      const dx = pos[pj]! - pos[pi]!;
      const dy = pos[pj + 1]! - pos[pi + 1]!;
      const dz = pos[pj + 2]! - pos[pi + 2]!;
      if (dx * dx + dy * dy + dz * dz < hR2) {
        sumW += getSlotWeight(indices, weights, j * MAX_INFLUENCES, boneIndex);
        cnt++;
      }
    }
    result[i] = cnt > 0 ? sumW / cnt : getSlotWeight(indices, weights, i * MAX_INFLUENCES, boneIndex);
  }
  return result;
}

// ── Weight overlay visualization ──

/**
 * Show weight heatmap overlay for the selected bone.
 * Blue (0) → Green (0.5) → Red (1.0)
 */
export function showWeightOverlay(mesh: AbstractMesh): void {
  const skelData = getActiveSkeleton();
  if (!skelData || !state.selectedBoneId) return;

  const boneData = skelData.bones.find((b) => b.id === state.selectedBoneId);
  if (!boneData) return;
  const boneIndex = skelData.skeleton.bones.indexOf(boneData.bone);
  if (boneIndex === -1) return;

  if (!hasWeightData(mesh)) {
    initWeightData(mesh);
  }

  // Store original state for restore
  const mat = mesh.material as PBRMaterial | null;
  if (mat && !mesh.metadata?._weightOverlayRestore) {
    if (!mesh.metadata) mesh.metadata = {};
    mesh.metadata._weightOverlayRestore = {
      unlit: mat.unlit ?? false,
      emissiveColor: mat.emissiveColor?.clone() ?? new Color3(0, 0, 0),
    };
  }

  updateWeightOverlay(mesh, boneIndex);
  state.weightOverlayActive = true;
}

function updateWeightOverlay(mesh: AbstractMesh, boneIndex: number): void {
  const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
  const indices = mesh.getVerticesData(VertexBuffer.MatricesIndicesKind);
  const weights = mesh.getVerticesData(VertexBuffer.MatricesWeightsKind);
  if (!pos || !indices || !weights) return;

  const vertexCount = pos.length / 3;
  const colors = new Float32Array(vertexCount * 4);

  for (let vi = 0; vi < vertexCount; vi++) {
    const w = getSlotWeight(indices, weights, vi * MAX_INFLUENCES, boneIndex);
    // Heatmap: blue(0) → green(0.5) → red(1.0)
    let r: number, g: number, b: number;
    if (w < 0.5) {
      const t = w * 2; // 0→1 over [0, 0.5]
      r = 0;
      g = t;
      b = 1 - t;
    } else {
      const t = (w - 0.5) * 2; // 0→1 over [0.5, 1.0]
      r = t;
      g = 1 - t;
      b = 0;
    }
    const ci = vi * 4;
    colors[ci] = r;
    colors[ci + 1] = g;
    colors[ci + 2] = b;
    colors[ci + 3] = 1;
  }

  mesh.setVerticesData(VertexBuffer.ColorKind, colors, true);
  mesh.hasVertexAlpha = true;

  const mat = mesh.material as PBRMaterial | null;
  if (mat) {
    // Ensure vertex colors are used — unlit rendering
    mat.unlit = true;
  }
}

/**
 * Hide weight overlay, restore original material state.
 */
export function hideWeightOverlay(mesh: AbstractMesh): void {
  // Remove vertex color buffer entirely to avoid affecting normal rendering
  try {
    if (typeof (mesh as any).removeVerticesData === "function") {
      (mesh as any).removeVerticesData(VertexBuffer.ColorKind);
    } else {
      // Fallback: set all vertex colors to white
      const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
      if (pos) {
        const vertexCount = pos.length / 3;
        const whites = new Float32Array(vertexCount * 4);
        for (let i = 0; i < vertexCount; i++) {
          const ci = i * 4;
          whites[ci] = 1; whites[ci + 1] = 1; whites[ci + 2] = 1; whites[ci + 3] = 1;
        }
        mesh.setVerticesData(VertexBuffer.ColorKind, whites, true);
      }
    }
  } catch {
    // Some mesh types may not support removal; ignore
  }
  mesh.hasVertexAlpha = false;

  const mat = mesh.material as PBRMaterial | null;
  if (mat) {
    const restore = mesh.metadata?._weightOverlayRestore;
    if (restore) {
      mat.unlit = restore.unlit ?? false;
      if (restore.emissiveColor) {
        mat.emissiveColor = restore.emissiveColor;
      }
      delete mesh.metadata._weightOverlayRestore;
    } else {
      mat.unlit = false;
    }
  }

  state.weightOverlayActive = false;
}

/**
 * Refresh overlay when selected bone changes.
 */
export function refreshWeightOverlay(): void {
  if (!state.weightOverlayActive) return;
  const mesh = lastSelected();
  if (!mesh) return;
  if (!mesh.skeleton || !hasWeightData(mesh)) return;

  const skelData = getActiveSkeleton();
  if (!skelData || !state.selectedBoneId) return;

  const boneData = skelData.bones.find((b) => b.id === state.selectedBoneId);
  if (!boneData) return;
  const boneIndex = skelData.skeleton.bones.indexOf(boneData.bone);
  if (boneIndex === -1) return;

  updateWeightOverlay(mesh, boneIndex);
}

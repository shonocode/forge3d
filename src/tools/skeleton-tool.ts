import { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { Bone } from "@babylonjs/core/Bones/bone";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Engine } from "@babylonjs/core/Engines/engine";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { LinesMesh } from "@babylonjs/core/Meshes/linesMesh";
import type { PickingInfo } from "@babylonjs/core/Collisions/pickingInfo";
import type { Observer } from "@babylonjs/core/Misc/observable";
import { state, status } from "../state";
import type { BoneData, SkeletonData } from "../state";

const BONE_VISUAL_PREFIX = "bone_visual_";
const HIERARCHY_LINES_NAME = "bone_hierarchy_lines";
const BONE_VISUAL_SIZE = 0.06;

let boneMaterial: StandardMaterial | null = null;
let selectedBoneMaterial: StandardMaterial | null = null;

function getBoneMaterial(): StandardMaterial {
  if (!boneMaterial) {
    boneMaterial = new StandardMaterial("boneMat", state.scene);
    boneMaterial.diffuseColor = new Color3(0.36, 0.5, 1);
    boneMaterial.emissiveColor = new Color3(0.18, 0.25, 0.5);
    boneMaterial.wireframe = false;
    applyXrayToMaterial(boneMaterial, state.boneDisplay.xray);
  }
  return boneMaterial;
}

function getSelectedBoneMaterial(): StandardMaterial {
  if (!selectedBoneMaterial) {
    selectedBoneMaterial = new StandardMaterial("boneSelMat", state.scene);
    selectedBoneMaterial.diffuseColor = new Color3(1, 0.8, 0.2);
    selectedBoneMaterial.emissiveColor = new Color3(0.5, 0.4, 0.1);
    applyXrayToMaterial(selectedBoneMaterial, state.boneDisplay.xray);
  }
  return selectedBoneMaterial;
}

/**
 * Make a material draw "on top" — depth test always passes and depth write
 * disabled, so the rendered surface ignores anything in front of it. Used
 * for bone visuals when X-ray is on, so the spine bone is visible through
 * the body mesh during rigging.
 */
function applyXrayToMaterial(mat: StandardMaterial, xray: boolean): void {
  if (xray) {
    mat.disableDepthWrite = true;
    mat.depthFunction = Engine.ALWAYS;
  } else {
    mat.disableDepthWrite = false;
    mat.depthFunction = Engine.LEQUAL;
  }
}

// ── Skeleton management ──

export function createSkeleton(): SkeletonData {
  state.skeletonCounter++;
  const name = "Skeleton_" + state.skeletonCounter;
  const skeleton = new Skeleton(name, name, state.scene);
  const id = "skel_" + state.skeletonCounter;

  const skelData: SkeletonData = {
    skeleton,
    bones: [],
    assignedMesh: null,
    hierarchyLines: null,
  };
  state.skeletonMap.set(id, skelData);
  state.activeSkeletonId = id;
  status("Skeleton created: " + name);
  return skelData;
}

export function getActiveSkeleton(): SkeletonData | null {
  if (!state.activeSkeletonId) return null;
  return state.skeletonMap.get(state.activeSkeletonId) ?? null;
}

/** Look up a bone by ID in the active skeleton. Returns null if not found. */
export function findBoneById(boneId: string): BoneData | null {
  const skelData = getActiveSkeleton();
  if (!skelData) return null;
  return skelData.bones.find((b) => b.id === boneId) ?? null;
}

// ── Bone creation ──

export function addBoneAtPoint(worldPos: Vector3, parentBoneId: string | null): BoneData | null {
  let skelData = getActiveSkeleton();
  if (!skelData) {
    skelData = createSkeleton();
  }

  state.boneCounter++;
  const boneId = "bone_" + state.boneCounter;
  const boneName = "Bone_" + state.boneCounter;

  let parentBone: Bone | null = null;
  let localMatrix: Matrix;

  if (parentBoneId) {
    const parentData = skelData.bones.find((b) => b.id === parentBoneId);
    if (parentData) {
      parentBone = parentData.bone;
      // Compute relative position from parent's world position
      const parentWorld = getBoneWorldPosition(parentData);
      const relative = worldPos.subtract(parentWorld);
      localMatrix = Matrix.Translation(relative.x, relative.y, relative.z);
    } else {
      localMatrix = Matrix.Translation(worldPos.x, worldPos.y, worldPos.z);
    }
  } else {
    localMatrix = Matrix.Translation(worldPos.x, worldPos.y, worldPos.z);
  }

  const bone = new Bone(boneName, skelData.skeleton, parentBone, localMatrix);
  const visual = createBoneVisual(boneId, worldPos);

  const boneData: BoneData = {
    id: boneId,
    name: boneName,
    bone,
    parentId: parentBoneId,
    visual,
  };
  skelData.bones.push(boneData);

  updateHierarchyVisualization(skelData);
  selectBone(boneId);
  status("Bone added: " + boneName);

  const sd = skelData;
  state.history.push({
    label: "Add Bone",
    undo() {
      const i = sd.bones.indexOf(boneData);
      if (i >= 0) sd.bones.splice(i, 1);
      const bjsIdx = sd.skeleton.bones.indexOf(bone);
      if (bjsIdx >= 0) sd.skeleton.bones.splice(bjsIdx, 1);
      if (boneData.visual) { boneData.visual.dispose(); boneData.visual = null; }
      if (state.selectedBoneId === boneId) deselectBone();
      updateHierarchyVisualization(sd);
    },
    redo() {
      if (!sd.skeleton.bones.includes(bone)) sd.skeleton.bones.push(bone);
      boneData.visual = createBoneVisual(boneId, worldPos);
      sd.bones.push(boneData);
      updateHierarchyVisualization(sd);
      selectBone(boneId);
    },
  });

  return boneData;
}

function getBoneWorldPosition(boneData: BoneData): Vector3 {
  if (boneData.visual) {
    return boneData.visual.position.clone();
  }
  // Fallback: extract from bone's absolute transform
  const m = boneData.bone.getAbsoluteTransform();
  const localPos = new Vector3(m.m[12], m.m[13], m.m[14]);
  // Account for assigned mesh's world matrix if present
  const skelData = getActiveSkeleton();
  if (skelData?.assignedMesh) {
    return Vector3.TransformCoordinates(localPos, skelData.assignedMesh.getWorldMatrix());
  }
  return localPos;
}

// ── Bone visuals ──

export function createBoneVisualForImport(boneId: string, position: Vector3): AbstractMesh {
  return createBoneVisual(boneId, position);
}

function createBoneVisual(boneId: string, position: Vector3): AbstractMesh {
  const mesh = MeshBuilder.CreateIcoSphere(
    BONE_VISUAL_PREFIX + boneId,
    { radius: BONE_VISUAL_SIZE, subdivisions: 1 },
    state.scene
  );
  mesh.position.copyFrom(position);
  mesh.material = getBoneMaterial();
  mesh.isPickable = true;
  mesh.metadata = { boneId };
  // Inherit current display config so newly-created bones match the active
  // size / X-ray settings without needing a manual refresh.
  mesh.scaling.setAll(state.boneDisplay.size);
  mesh.renderingGroupId = state.boneDisplay.xray ? 1 : 0;
  return mesh;
}

export function updateHierarchyVisualization(skelData: SkeletonData): void {
  // Build line segments for parent→child connections
  const lines: Vector3[][] = [];
  for (const bd of skelData.bones) {
    if (!bd.parentId) continue;
    const parent = skelData.bones.find((b) => b.id === bd.parentId);
    if (!parent) continue;
    lines.push([getBoneWorldPosition(parent), getBoneWorldPosition(bd)]);
  }

  // Topology changed (or first time): rebuild fresh LineSystem.
  // CreateLineSystem's `instance` update path requires the same number of
  // lines AND the same vertex count per line, so we dispose when the
  // structure differs.
  const existing = skelData.hierarchyLines;
  const sameTopology = existing && _hierarchyLineCount === lines.length;

  if (lines.length === 0) {
    if (existing) {
      existing.dispose();
      skelData.hierarchyLines = null;
      _hierarchyLineCount = 0;
    }
    return;
  }

  if (sameTopology) {
    // In-place point update — no GC churn during playback.
    MeshBuilder.CreateLineSystem(
      HIERARCHY_LINES_NAME,
      { lines, instance: existing as LinesMesh },
      state.scene
    );
    return;
  }

  if (existing) existing.dispose();
  const lineSystem = MeshBuilder.CreateLineSystem(
    HIERARCHY_LINES_NAME,
    { lines, updatable: true },
    state.scene
  );
  lineSystem.color = new Color3(0.36, 0.5, 1);
  lineSystem.isPickable = false;
  lineSystem.renderingGroupId = state.boneDisplay.xray ? 1 : 0;
  skelData.hierarchyLines = lineSystem;
  _hierarchyLineCount = lines.length;
}

/**
 * Push the current `state.boneDisplay` into every existing bone visual and
 * hierarchy line across all skeletons. Call after the user adjusts the size
 * slider or X-ray toggle.
 */
export function applyBoneDisplayConfig(): void {
  const { size, xray } = state.boneDisplay;
  if (boneMaterial) applyXrayToMaterial(boneMaterial, xray);
  if (selectedBoneMaterial) applyXrayToMaterial(selectedBoneMaterial, xray);
  for (const [, skelData] of state.skeletonMap) {
    for (const bd of skelData.bones) {
      if (!bd.visual) continue;
      bd.visual.scaling.setAll(size);
      bd.visual.renderingGroupId = xray ? 1 : 0;
    }
    if (skelData.hierarchyLines) {
      skelData.hierarchyLines.renderingGroupId = xray ? 1 : 0;
    }
  }
}

let _hierarchyLineCount = 0;

// ── Gizmo drag observer tracking ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _posDragEndObserver: Observer<any> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _rotDragEndObserver: Observer<any> | null = null;

function cleanupDragObservers(): void {
  if (_posDragEndObserver) {
    try {
      const posGizmo = state.gizmoManager.gizmos?.positionGizmo;
      if (posGizmo) {
        posGizmo.onDragEndObservable.remove(_posDragEndObserver);
      }
    } catch { /* gizmo may already be disposed */ }
    _posDragEndObserver = null;
  }
  if (_rotDragEndObserver) {
    try {
      const rotGizmo = state.gizmoManager.gizmos?.rotationGizmo;
      if (rotGizmo) {
        rotGizmo.onDragEndObservable.remove(_rotDragEndObserver);
      }
    } catch { /* gizmo may already be disposed */ }
    _rotDragEndObserver = null;
  }
}

// ── Bone selection ──

export function selectBone(boneId: string): void {
  const skelData = getActiveSkeleton();
  if (!skelData) return;

  // Cleanup previous bone's drag observers
  cleanupDragObservers();

  // Deselect previous visual
  if (state.selectedBoneId) {
    const prev = skelData.bones.find((b) => b.id === state.selectedBoneId);
    if (prev?.visual) {
      prev.visual.material = getBoneMaterial();
    }
  }

  state.selectedBoneId = boneId;
  const boneData = skelData.bones.find((b) => b.id === boneId);
  if (!boneData?.visual) return;

  boneData.visual.material = getSelectedBoneMaterial();

  // Attach gizmo — Edit Mode uses position, Pose Mode uses rotation.
  // Rotation gizmo is "world axes" in this V1 (gizmo's default). Local-axis
  // rotation would be more intuitive for pose work and is a future polish:
  // set `rotGizmo.updateGizmoRotationToMatchAttachedMesh = true` once bone
  // visuals carry a meaningful orientation (currently they're isotropic
  // spheres so local vs world is visually indistinguishable mid-drag — only
  // the final baked rotation differs).
  const gm = state.gizmoManager;
  try {
    const isPose = state.boneEditMode === "pose";
    gm.positionGizmoEnabled = !isPose;
    gm.rotationGizmoEnabled = isPose;
    gm.scaleGizmoEnabled = false;

    // Ensure the visual has a rotationQuaternion before the rotation gizmo
    // attaches — without it the gizmo writes to mesh.rotation (Euler) which
    // bypasses our quaternion read path in syncBoneRotationFromVisual.
    if (isPose && !boneData.visual.rotationQuaternion) {
      boneData.visual.rotationQuaternion = Quaternion.Identity();
    }

    gm.attachToMesh(boneData.visual);

    if (isPose) {
      const rotGizmo = gm.gizmos?.rotationGizmo;
      if (rotGizmo) {
        _rotDragEndObserver = rotGizmo.onDragEndObservable.add(() => {
          syncBoneRotationFromVisual(boneData, skelData);
        });
      }
    } else {
      const posGizmo = gm.gizmos?.positionGizmo;
      if (posGizmo) {
        _posDragEndObserver = posGizmo.onDragEndObservable.add(() => {
          syncBoneFromVisual(boneData, skelData);
        });
      }
    }
  } catch { /* ignore gizmo errors */ }
}

export function deselectBone(): void {
  cleanupDragObservers();
  const skelData = getActiveSkeleton();
  if (skelData && state.selectedBoneId) {
    const prev = skelData.bones.find((b) => b.id === state.selectedBoneId);
    if (prev?.visual) {
      prev.visual.material = getBoneMaterial();
    }
  }
  state.selectedBoneId = null;
  try { state.gizmoManager.attachToMesh(null); } catch { /* ignore */ }
}

export function syncBoneFromVisual(boneData: BoneData, skelData: SkeletonData): void {
  if (!boneData.visual) return;

  const worldPos = boneData.visual.position;

  // Recalculate local matrix relative to parent
  if (boneData.parentId) {
    const parent = skelData.bones.find((b) => b.id === boneData.parentId);
    if (parent) {
      const parentPos = getBoneWorldPosition(parent);
      const relative = worldPos.subtract(parentPos);
      boneData.bone.getLocalMatrix().copyFrom(Matrix.Translation(relative.x, relative.y, relative.z));
    }
  } else {
    boneData.bone.getLocalMatrix().copyFrom(Matrix.Translation(worldPos.x, worldPos.y, worldPos.z));
  }

  // Recompute absolute transforms and update child bone visuals
  skelData.skeleton.computeAbsoluteTransforms();
  updateChildVisuals(boneData.id, skelData);

  // Update hierarchy lines
  updateHierarchyVisualization(skelData);
}

/**
 * Bake the gizmo-applied rotation on the bone's visual into the bone's
 * local matrix, then propagate to descendants and reset the visual's
 * quaternion to identity.
 *
 * The visual's quaternion is reset because:
 *   1. The rotation is now part of the bone's local transform — child
 *      visuals already reflect the new pose via `computeAbsoluteTransforms`.
 *   2. Leaving non-identity quaternion on the parent visual would
 *      compound on the next drag (gizmo would start from the current
 *      orientation, but the bone matrix is already rotated → double-apply).
 *
 * Translation in the local matrix is preserved by decomposing first.
 * Scale is preserved too, although bones almost always have unit scale.
 */
export function syncBoneRotationFromVisual(boneData: BoneData, skelData: SkeletonData): void {
  if (!boneData.visual?.rotationQuaternion) return;

  const newRotation = boneData.visual.rotationQuaternion.clone();

  // Decompose current local matrix into translation, rotation, scale
  // so we can swap in the new rotation without destroying position.
  const localMat = boneData.bone.getLocalMatrix();
  const curScale = new Vector3();
  const curRotation = new Quaternion();
  const curTranslation = new Vector3();
  localMat.decompose(curScale, curRotation, curTranslation);

  // The gizmo applied a delta rotation on top of the visual's identity
  // quaternion (we reset it on previous drag end), so `newRotation` IS
  // the new rotation in world axes. Compose absolute (not multiplied)
  // — visually identical to standard pose-tool behavior.
  const newLocal = Matrix.Compose(curScale, newRotation, curTranslation);
  boneData.bone.getLocalMatrix().copyFrom(newLocal);
  boneData.bone.markAsDirty();

  // Recompute world transforms for the whole skeleton, then resync
  // every descendant visual's position. The selected bone's own
  // position doesn't change (translation preserved) so it stays put.
  skelData.skeleton.computeAbsoluteTransforms();
  updateChildVisuals(boneData.id, skelData);

  // Bake done — clear the visual's rotation so the next gizmo drag
  // starts from identity again. Without this, repeat drags compound.
  boneData.visual.rotationQuaternion.copyFromFloats(0, 0, 0, 1);

  updateHierarchyVisualization(skelData);
}

/** Recursively update child bone visuals from their absolute transforms */
function updateChildVisuals(parentId: string, skelData: SkeletonData): void {
  for (const child of skelData.bones) {
    if (child.parentId !== parentId) continue;
    if (child.visual) {
      const absTransform = child.bone.getAbsoluteTransform();
      child.visual.position.set(absTransform.m[12]!, absTransform.m[13]!, absTransform.m[14]!);
    }
    updateChildVisuals(child.id, skelData);
  }
}

// ── Bone deletion ──

export function deleteBone(boneId: string): void {
  const skelData = getActiveSkeleton();
  if (!skelData) return;

  // Collect bone and all descendants
  const toDelete = new Set<string>();
  collectDescendants(boneId, skelData, toDelete);

  // Deselect first to clean up gizmo observers before disposing visuals
  if (state.selectedBoneId && toDelete.has(state.selectedBoneId)) {
    deselectBone();
  }

  // Snapshot weight data before reindex for undo
  const mesh = skelData.assignedMesh;
  const prevIndices = mesh?.getVerticesData(VertexBuffer.MatricesIndicesKind);
  const indicesSnapshot = prevIndices ? new Float32Array(prevIndices) : null;

  // Track deleted bones for undo
  const deletedInfo: { data: BoneData; arrayIdx: number; bjsIdx: number; worldPos: Vector3 }[] = [];

  for (const id of toDelete) {
    const idx = skelData.bones.findIndex((b) => b.id === id);
    if (idx === -1) continue;
    const bd = skelData.bones[idx]!;

    const bjsIdx = skelData.skeleton.bones.indexOf(bd.bone);
    const worldPos = bd.visual ? bd.visual.position.clone() : new Vector3(0, 0, 0);

    deletedInfo.push({ data: bd, arrayIdx: idx, bjsIdx, worldPos });

    if (bjsIdx !== -1) {
      reindexWeightData(skelData, bjsIdx);
      skelData.skeleton.bones.splice(bjsIdx, 1);
    }

    if (bd.visual) {
      bd.visual.dispose();
      bd.visual = null;
    }
    skelData.bones.splice(idx, 1);
  }

  updateHierarchyVisualization(skelData);
  status("Bone(s) deleted");

  state.history.push({
    label: "Delete Bone",
    undo() {
      // Restore weight data snapshot
      if (indicesSnapshot && mesh) {
        mesh.updateVerticesData(VertexBuffer.MatricesIndicesKind, indicesSnapshot);
      }
      // Re-insert bones in reverse order (highest arrayIdx first to preserve indices)
      const sorted = [...deletedInfo].sort((a, b) => a.arrayIdx - b.arrayIdx);
      for (const info of sorted) {
        // Re-insert into Babylon skeleton bones array
        if (info.bjsIdx !== -1) {
          skelData.skeleton.bones.splice(info.bjsIdx, 0, info.data.bone);
        }
        // Recreate visual
        info.data.visual = createBoneVisual(info.data.id, info.worldPos);
        // Re-insert into skelData.bones
        skelData.bones.splice(info.arrayIdx, 0, info.data);
      }
      skelData.skeleton.computeAbsoluteTransforms();
      updateHierarchyVisualization(skelData);
    },
    redo() {
      if (state.selectedBoneId && toDelete.has(state.selectedBoneId)) {
        deselectBone();
      }
      // Re-delete in reverse arrayIdx order (highest first)
      const sortedDesc = [...deletedInfo].sort((a, b) => b.arrayIdx - a.arrayIdx);
      for (const info of sortedDesc) {
        const bjsIdx = skelData.skeleton.bones.indexOf(info.data.bone);
        if (bjsIdx !== -1) {
          reindexWeightData(skelData, bjsIdx);
          skelData.skeleton.bones.splice(bjsIdx, 1);
        }
        if (info.data.visual) {
          info.data.visual.dispose();
          info.data.visual = null;
        }
        const idx = skelData.bones.indexOf(info.data);
        if (idx !== -1) skelData.bones.splice(idx, 1);
      }
      updateHierarchyVisualization(skelData);
    },
  });
}

/** Update weight data indices after a bone is removed from skeleton.bones */
function reindexWeightData(skelData: SkeletonData, removedBjsIndex: number): void {
  if (!skelData.assignedMesh) return;
  const mesh = skelData.assignedMesh;
  const indices = mesh.getVerticesData(VertexBuffer.MatricesIndicesKind);
  if (!indices) return;

  let modified = false;
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] === removedBjsIndex) {
      indices[i] = 0; // fallback to root bone
      modified = true;
    } else if (indices[i]! > removedBjsIndex) {
      indices[i] = indices[i]! - 1; // shift down
      modified = true;
    }
  }
  if (modified) {
    mesh.updateVerticesData(VertexBuffer.MatricesIndicesKind, indices);
  }
}

function collectDescendants(boneId: string, skelData: SkeletonData, result: Set<string>): void {
  result.add(boneId);
  for (const bd of skelData.bones) {
    if (bd.parentId === boneId && !result.has(bd.id)) {
      collectDescendants(bd.id, skelData, result);
    }
  }
}

// ── Skeleton assignment ──

export function assignSkeletonToMesh(mesh: AbstractMesh): void {
  const skelData = getActiveSkeleton();
  if (!skelData) {
    status("No active skeleton");
    return;
  }
  mesh.skeleton = skelData.skeleton;
  skelData.assignedMesh = mesh;
  status("Skeleton assigned to: " + mesh.name);
}

// ── Visibility toggle ──

export function setBoneVisualsVisible(visible: boolean): void {
  for (const [, skelData] of state.skeletonMap) {
    for (const bd of skelData.bones) {
      if (bd.visual) {
        bd.visual.isVisible = visible;
      }
    }
    if (skelData.hierarchyLines) {
      skelData.hierarchyLines.isVisible = visible;
    }
  }
}

/**
 * True when any bone visual across any skeleton is currently shown.
 * Used to decide which way to flip on toggle. Returns `false` if no
 * skeletons exist (toggle is a no-op caller-side in that case).
 */
export function areBoneVisualsVisible(): boolean {
  for (const [, skelData] of state.skeletonMap) {
    for (const bd of skelData.bones) {
      if (bd.visual?.isVisible) return true;
    }
  }
  return false;
}

// ── Bone picking helpers ──

export function isBoneVisual(mesh: AbstractMesh): boolean {
  return mesh.metadata?.boneId != null;
}

export function getBoneIdFromVisual(mesh: AbstractMesh): string | null {
  return (mesh.metadata?.boneId as string) ?? null;
}

// ── Pointer handler for bone tool ──

export function handleBonePointerDown(pick: PickingInfo): void {
  if (!pick.hit || !pick.pickedPoint) return;

  if (pick.pickedMesh && isBoneVisual(pick.pickedMesh)) {
    // Clicked an existing bone visual → select it
    const id = getBoneIdFromVisual(pick.pickedMesh);
    if (id) selectBone(id);
    return;
  }

  // Clicked on a mesh surface → add a bone at that point
  // If a bone is selected, make it the parent
  addBoneAtPoint(pick.pickedPoint, state.selectedBoneId);
}

// ── Rename bone ──

export function renameBone(boneId: string, newName: string): void {
  const skelData = getActiveSkeleton();
  if (!skelData) return;
  const bd = skelData.bones.find((b) => b.id === boneId);
  if (!bd) return;
  bd.name = newName;
  bd.bone.name = newName;
}

// ── Cleanup ──

export function disposeSkeleton(skeletonId: string): void {
  const skelData = state.skeletonMap.get(skeletonId);
  if (!skelData) return;

  // Clean up drag observers before disposing
  if (state.activeSkeletonId === skeletonId && state.selectedBoneId) {
    cleanupDragObservers();
  }

  for (const bd of skelData.bones) {
    if (bd.visual) bd.visual.dispose();
  }
  if (skelData.hierarchyLines) skelData.hierarchyLines.dispose();
  skelData.skeleton.dispose();
  state.skeletonMap.delete(skeletonId);

  if (state.activeSkeletonId === skeletonId) {
    state.activeSkeletonId = null;
    state.selectedBoneId = null;
  }
}

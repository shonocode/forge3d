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
import type { BoneData, SkeletonData, IKConstraint } from "../state";
import type { UndoCommand } from "../undo";
import { solveFabrik } from "./ik-solver";
import {
  reflectPosition,
  mirrorBoneName,
  mirrorPoseRotation,
  mirrorLocalTranslation,
  type MirrorAxis,
} from "./bone-mirror";
import {
  boneDirection,
  boneRestQuaternion,
  worldToParentLocal,
  chainLocalTranslations,
  BONE_PRIMARY_AXIS,
} from "./bone-orientation";
import { clampEulerRotation, aimLocalRotation } from "./bone-constraints";

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

// ── Local-space helpers (TRS-aware) ──

const _decompScale = new Vector3();
const _decompRot = new Quaternion();
const _decompPos = new Vector3();

/**
 * A bone's absolute (skeleton-space) rotation, read from its absolute
 * transform. Callers must ensure `computeAbsoluteTransforms` ran since the
 * last matrix edit.
 */
function absoluteRotationOf(boneData: BoneData): Quaternion {
  boneData.bone.getAbsoluteTransform().decompose(_decompScale, _decompRot, _decompPos);
  return _decompRot.clone();
}

/**
 * Parent bone's absolute rotation (identity for roots / missing parents).
 * Rotation matters since F-M6: local translations are expressed in the
 * parent's (possibly rotated) frame, no longer plain world-axis offsets.
 */
function getParentAbsoluteRotation(boneData: BoneData, skelData: SkeletonData): Quaternion {
  if (boneData.parentId) {
    const parent = skelData.bones.find((b) => b.id === boneData.parentId);
    if (parent) return absoluteRotationOf(parent);
  }
  return Quaternion.Identity();
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
      // Express the offset in the parent's frame — identical to the old
      // world-position subtraction while parents are unrotated, but correct
      // when a rotated (posed / imported) parent is extended.
      skelData.skeleton.computeAbsoluteTransforms();
      const parentWorld = getBoneWorldPosition(parentData);
      const relative = worldToParentLocal(absoluteRotationOf(parentData), parentWorld, worldPos);
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

export function getBoneWorldPosition(boneData: BoneData): Vector3 {
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

/**
 * Pose-edit notification hook. Set via {@link setPoseEditedHandler} (from UI
 * init) instead of importing animation-tool directly — animation-tool already
 * imports this module, and a static import back would create a cycle.
 */
let _poseEditedHandler: ((boneId: string) => void) | null = null;

/** Register the callback fired after a Pose Mode rotation drag ends. */
export function setPoseEditedHandler(fn: (boneId: string) => void): void {
  _poseEditedHandler = fn;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _posDragEndObserver: Observer<any> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _rotDragEndObserver: Observer<any> | null = null;

/**
 * Bone-axes orientation the visual's quaternion held when the rotation gizmo
 * was (re-)armed. The drag-end bake diffs the visual's quaternion against
 * this to get the world-space delta the gizmo applied — accumulating drags
 * correctly instead of the V1 replace-with-delta behavior.
 */
let _attachedAxesQuat: Quaternion | null = null;

/**
 * Orientation of the bone's display/gizmo axes in world space: +Y along the
 * bone's current direction (toward its first child, else away from its
 * parent), twisted by the authored {@link BoneData.roll}. Recomputed from the
 * *current* pose so the Pose-mode gizmo follows the bone while it animates.
 * Isolated single bones fall back to the world frame (+Y up).
 */
export function getBoneAxesOrientation(boneData: BoneData, skelData: SkeletonData): Quaternion {
  const head = getBoneWorldPosition(boneData);
  let dir = BONE_PRIMARY_AXIS.clone();
  const child = skelData.bones.find((b) => b.parentId === boneData.id);
  if (child) {
    dir = boneDirection(head, getBoneWorldPosition(child));
  } else if (boneData.parentId) {
    const parent = skelData.bones.find((b) => b.id === boneData.parentId);
    if (parent) dir = boneDirection(getBoneWorldPosition(parent), head);
  }
  return boneRestQuaternion(dir, boneData.roll ?? 0);
}

/**
 * Re-arm the Pose-mode rotation gizmo from the selected bone's current
 * orientation. Call after anything that moves bones programmatically while
 * the gizmo may be attached (scrub/playback, IK solve, pose paste, undo) —
 * otherwise the next drag would bake against a stale reference and jump.
 * Cheap no-op outside Pose Mode or with nothing selected.
 */
export function refreshPoseGizmoOrientation(): void {
  if (state.boneEditMode !== "pose" || !state.selectedBoneId) return;
  const skelData = getActiveSkeleton();
  if (!skelData) return;
  const bd = skelData.bones.find((b) => b.id === state.selectedBoneId);
  if (!bd?.visual?.rotationQuaternion) return;
  const axes = getBoneAxesOrientation(bd, skelData);
  bd.visual.rotationQuaternion.copyFrom(axes);
  _attachedAxesQuat = axes;
}

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
  // In Pose Mode the visual's quaternion is set to the bone's axes
  // orientation (direction + roll); with `poseRotationSpace === "local"` the
  // gizmo rings align to those axes (Blender-style), otherwise they stay
  // world-aligned. Either way the drag-end bake diffs against
  // `_attachedAxesQuat`, so both spaces share one code path.
  const gm = state.gizmoManager;
  try {
    const isPose = state.boneEditMode === "pose";
    gm.positionGizmoEnabled = !isPose;
    gm.rotationGizmoEnabled = isPose;
    gm.scaleGizmoEnabled = false;

    if (isPose) {
      // Seed the visual's quaternion with the bone-axes orientation BEFORE
      // attaching, so the gizmo rings (in local mode) render aligned to the
      // bone from the first frame.
      const axes = getBoneAxesOrientation(boneData, skelData);
      if (!boneData.visual.rotationQuaternion) {
        boneData.visual.rotationQuaternion = axes.clone();
      } else {
        boneData.visual.rotationQuaternion.copyFrom(axes);
      }
      _attachedAxesQuat = axes;
    } else {
      _attachedAxesQuat = null;
    }

    gm.attachToMesh(boneData.visual);

    if (isPose) {
      const rotGizmo = gm.gizmos?.rotationGizmo;
      if (rotGizmo) {
        rotGizmo.updateGizmoRotationToMatchAttachedMesh =
          state.poseRotationSpace === "local";
        _rotDragEndObserver = rotGizmo.onDragEndObservable.add(() => {
          syncBoneRotationFromVisual(boneData, skelData);
          // Auto-Key / dirty-pose tracking (wired in bindings to avoid an
          // import cycle with animation-tool).
          _poseEditedHandler?.(boneData.id);
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
  _attachedAxesQuat = null;
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

  // Recalculate the local translation relative to the parent (in the
  // parent's frame), preserving whatever rotation/scale the local matrix
  // already carries — a position drag must not strip a posed or imported
  // rotation.
  const localMat = boneData.bone.getLocalMatrix();
  localMat.decompose(_decompScale, _decompRot, _decompPos);
  const keepScale = _decompScale.clone();
  const keepRot = _decompRot.clone();

  let relative: Vector3;
  if (boneData.parentId) {
    const parent = skelData.bones.find((b) => b.id === boneData.parentId);
    if (parent) {
      relative = worldToParentLocal(
        absoluteRotationOf(parent),
        getBoneWorldPosition(parent),
        worldPos
      );
    } else {
      relative = worldPos.clone();
    }
  } else {
    relative = worldPos.clone();
  }
  localMat.copyFrom(Matrix.Compose(keepScale, keepRot, relative));
  boneData.bone.markAsDirty();

  // Recompute absolute transforms and update child bone visuals
  skelData.skeleton.computeAbsoluteTransforms();
  updateChildVisuals(boneData.id, skelData);

  // Update hierarchy lines
  updateHierarchyVisualization(skelData);
}

/**
 * Bake the gizmo-applied rotation on the bone's visual into the bone's
 * local matrix, then propagate to descendants.
 *
 * The visual's quaternion holds the bone-axes orientation that was seeded at
 * attach time ({@link _attachedAxesQuat}) plus whatever the gizmo added this
 * drag. Diffing the two yields the world-space delta, which is conjugated
 * into the parent's frame and composed ON TOP of the current local rotation
 * — so repeat drags accumulate (V1 replaced the rotation with the last
 * drag's delta instead, silently discarding earlier posing).
 *
 * Local translation and scale are preserved by decomposing first. After the
 * bake the gizmo is re-armed from the bone's fresh orientation so the next
 * drag diffs against up-to-date axes.
 */
export function syncBoneRotationFromVisual(boneData: BoneData, skelData: SkeletonData): void {
  if (!boneData.visual?.rotationQuaternion) return;
  const start = _attachedAxesQuat;
  if (!start) return; // rotation gizmo wasn't armed through Pose Mode

  // World-space rotation the gizmo applied during this drag.
  // (Babylon Quaternion.multiply is Hamilton order: q1.multiply(q2) applies
  // q2 first, then q1.)
  const delta = boneData.visual.rotationQuaternion.multiply(Quaternion.Inverse(start));

  const localMat = boneData.bone.getLocalMatrix();
  const curScale = new Vector3();
  const curRotation = new Quaternion();
  const curTranslation = new Vector3();
  localMat.decompose(curScale, curRotation, curTranslation);

  // newLocal = inv(P) ∘ Δ ∘ P ∘ local — the world delta conjugated into the
  // parent's frame, accumulated onto the existing local rotation.
  const parentRot = getParentAbsoluteRotation(boneData, skelData);
  const newRotation = Quaternion.Inverse(parentRot)
    .multiply(delta)
    .multiply(parentRot)
    .multiply(curRotation);

  const newLocal = Matrix.Compose(curScale, newRotation, curTranslation);
  boneData.bone.getLocalMatrix().copyFrom(newLocal);
  boneData.bone.markAsDirty();

  // Recompute world transforms for the whole skeleton, then resync
  // every descendant visual's position. The selected bone's own
  // position doesn't change (translation preserved) so it stays put.
  skelData.skeleton.computeAbsoluteTransforms();
  updateChildVisuals(boneData.id, skelData);

  // Re-arm the gizmo from the freshly-baked orientation.
  refreshPoseGizmoOrientation();

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

// ── Inverse Kinematics ──

/**
 * Walk up the parent chain from `endBoneId`, collecting up to `chainLength`
 * bones. Returned root-first (so index 0 is the chain's anchor / base and the
 * last entry is the end-effector bone). The walk stops early at a root bone.
 */
function collectIKChain(
  endBoneId: string,
  chainLength: number,
  skelData: SkeletonData
): BoneData[] {
  const chain: BoneData[] = [];
  let cur: BoneData | null = skelData.bones.find((b) => b.id === endBoneId) ?? null;
  while (cur && chain.length < chainLength) {
    chain.unshift(cur);
    const parentId: string | null = cur.parentId;
    cur = parentId ? (skelData.bones.find((b) => b.id === parentId) ?? null) : null;
  }
  return chain;
}

/**
 * Solve the IK chain ending at `endBoneId` so its tip reaches `target`,
 * preserving bone lengths (FABRIK), and write the result onto the actual
 * bone matrices. The chain's base bone is held fixed. **No undo entry** —
 * this is the per-frame / interactive core, safe to call from a render hook
 * or animation playback. Use {@link solveIKForBone} for the undo-able,
 * button-triggered variant.
 *
 * The chain length comes from the end bone's `ikConstraint.chainLength`
 * (clamped to ≥2). FABRIK solves on joint *positions*; each chain bone's
 * local rotation (pose twist, imported orientation) is preserved and the
 * solved positions are re-expressed as local translations in each parent's
 * — possibly rotated — frame via {@link chainLocalTranslations}. Bone
 * visuals (and any branches off the chain) are then cascaded from the
 * recomputed absolute transforms.
 *
 * @returns the solved chain (root-first) and whether the tip reached the
 *   target, or `null` when there is no usable ≥2-bone chain.
 */
export function applyIKChain(
  endBoneId: string,
  target: Vector3
): { chain: BoneData[]; reached: boolean } | null {
  const skelData = getActiveSkeleton();
  if (!skelData) return null;

  const endBone = skelData.bones.find((b) => b.id === endBoneId);
  if (!endBone) return null;

  const requested = endBone.ikConstraint?.chainLength ?? 2;
  const chain = collectIKChain(endBoneId, Math.max(2, requested), skelData);
  if (chain.length < 2) return null;

  const joints = chain.map((b) => getBoneWorldPosition(b));
  const ik = endBone.ikConstraint;
  const pole =
    ik?.poleEnabled
      ? new Vector3(ik.poleX ?? 0, ik.poleY ?? 0, ik.poleZ ?? 0)
      : undefined;
  const result = solveFabrik(joints, target, {
    tolerance: 1e-3,
    maxIterations: 16,
    pole,
    maxBendDeg: ik?.maxBendDeg,
  });

  // Base bone (index 0) held fixed. Preserve every chain bone's local
  // rotation/scale; rewrite only the translations, expressed in each
  // parent's frame with rotations accumulated down the chain.
  const localScales: Vector3[] = [];
  const localRots: Quaternion[] = [];
  for (const b of chain) {
    b.bone.getLocalMatrix().decompose(_decompScale, _decompRot, _decompPos);
    localScales.push(_decompScale.clone());
    localRots.push(_decompRot.clone());
  }
  const baseAbsRot = absoluteRotationOf(chain[0]!);
  const locals = chainLocalTranslations(result.positions, baseAbsRot, localRots);
  for (let i = 1; i < chain.length; i++) {
    chain[i]!.bone.getLocalMatrix().copyFrom(
      Matrix.Compose(localScales[i]!, localRots[i]!, locals[i - 1]!)
    );
    chain[i]!.bone.markAsDirty();
  }
  skelData.skeleton.computeAbsoluteTransforms();
  // Cascade visuals from the base outward — descendants (chain + branches)
  // read their refreshed absolute transforms.
  updateChildVisuals(chain[0]!.id, skelData);
  updateHierarchyVisualization(skelData);
  refreshPoseGizmoOrientation();

  return { chain, reached: result.reached };
}

/**
 * Undo-able, one-shot IK solve for the bone tool — wraps {@link applyIKChain}
 * with a snapshot of the chain's local matrices so a single "Solve IK" entry
 * lands on the history stack.
 *
 * @returns `true` when the tip reached the target within tolerance.
 */
export function solveIKForBone(endBoneId: string, target: Vector3): boolean {
  const skelData = getActiveSkeleton();
  if (!skelData) return false;

  const endBone = skelData.bones.find((b) => b.id === endBoneId);
  if (!endBone) return false;

  const chain = collectIKChain(
    endBoneId,
    Math.max(2, endBone.ikConstraint?.chainLength ?? 2),
    skelData
  );
  if (chain.length < 2) {
    status("⚠ IK needs a chain of at least 2 bones");
    return false;
  }

  // Snapshot chain local matrices for undo before mutating.
  const before = chain.map((b) => b.bone.getLocalMatrix().clone());

  const result = applyIKChain(endBoneId, target);
  if (!result) return false;

  const after = chain.map((b) => b.bone.getLocalMatrix().clone());

  const restore = (mats: Matrix[]) => {
    for (let i = 0; i < chain.length; i++) {
      chain[i]!.bone.getLocalMatrix().copyFrom(mats[i]!);
      chain[i]!.bone.markAsDirty();
    }
    skelData.skeleton.computeAbsoluteTransforms();
    updateChildVisuals(chain[0]!.id, skelData);
    updateHierarchyVisualization(skelData);
    refreshPoseGizmoOrientation();
  };

  state.history.push({
    label: "Solve IK",
    undo() { restore(before); },
    redo() { restore(after); },
  });

  status(result.reached ? "IK solved" : "IK target out of reach");
  return result.reached;
}

/**
 * Suggest a pole position for the IK chain ending at `endBoneId`: the current
 * mid-joint, pushed outward from the root→tip axis so it unambiguously marks
 * the present bend direction. Used by the "Snap to Bend" button so enabling a
 * pole keeps (and slightly exaggerates) the current elbow/knee direction
 * rather than snapping the bend somewhere arbitrary.
 *
 * @returns a world position, or `null` when there's no active/usable chain.
 */
export function getIKPoleSuggestion(endBoneId: string): Vector3 | null {
  const skelData = getActiveSkeleton();
  if (!skelData) return null;
  const endBone = skelData.bones.find((b) => b.id === endBoneId);
  if (!endBone) return null;

  const chain = collectIKChain(
    endBoneId,
    Math.max(3, endBone.ikConstraint?.chainLength ?? 2),
    skelData
  );
  const joints = chain.map((b) => getBoneWorldPosition(b));
  if (joints.length < 3) {
    // No middle joint to steer — offer a point just in front of the tip.
    return getBoneWorldPosition(endBone).add(new Vector3(0, 0, 1));
  }

  const root = joints[0]!;
  const tip = joints[joints.length - 1]!;
  const mid = joints[Math.floor((joints.length - 1) / 2)]!;

  const axis = tip.subtract(root);
  const len = axis.length();
  if (len < 1e-6) return mid.add(new Vector3(0, 0, 1));
  axis.scaleInPlace(1 / len);

  const v = mid.subtract(root);
  const along = Vector3.Dot(v, axis);
  const perp = v.subtract(axis.scale(along));
  const perpLen = perp.length();
  const dir = perpLen > 1e-6 ? perp.scale(1 / perpLen) : new Vector3(0, 0, 1);

  const reach = Vector3.Distance(root, tip);
  return mid.add(dir.scale(Math.max(0.5, reach)));
}

/**
 * Suggested Aim-constraint target for a bone: a point along its *current*
 * direction (its first child's position, else ahead of it away from the
 * parent, else straight up). Enabling Aim with this target leaves the pose
 * exactly where it is — mirroring the IK "Snap to Bone" affordance.
 */
export function getAimTargetSuggestion(boneId: string): Vector3 | null {
  const skelData = getActiveSkeleton();
  if (!skelData) return null;
  const bd = skelData.bones.find((b) => b.id === boneId);
  if (!bd) return null;

  const head = getBoneWorldPosition(bd);
  const child = skelData.bones.find((b) => b.parentId === bd.id);
  if (child) return getBoneWorldPosition(child);

  if (bd.parentId) {
    const parent = skelData.bones.find((b) => b.id === bd.parentId);
    if (parent) {
      const parentPos = getBoneWorldPosition(parent);
      const dir = boneDirection(parentPos, head);
      const len = Math.max(0.5, Vector3.Distance(parentPos, head));
      return head.add(dir.scale(len));
    }
  }
  return head.add(new Vector3(0, 1, 0));
}

// ── Bone constraints (Limit Rotation / Aim) ──

/** Depth of a bone in the hierarchy — used to order constraint evaluation. */
function boneDepth(bd: BoneData, skelData: SkeletonData): number {
  let depth = 0;
  let cur: BoneData | undefined = bd;
  while (cur?.parentId) {
    depth++;
    cur = skelData.bones.find((b) => b.id === cur!.parentId);
  }
  return depth;
}

/**
 * Enforce every bone's Limit Rotation / Aim constraints on one skeleton.
 * Per bone, Aim runs first (it *sets* the local rotation toward the target),
 * then Limit Rotation clamps the result — the fixed V1 stack order. Bones
 * evaluate parents-before-children so a constrained parent's corrected frame
 * feeds its children's evaluation in the same pass.
 *
 * Local translation/scale are preserved; nothing is written (and no visuals
 * refresh) when every constrained bone is already satisfied, so the
 * per-frame cost for a satisfied — or unconstrained — rig is a scan.
 * No undo entries: like the IK render hook, this runs continuously.
 *
 * @returns `true` when any bone's rotation was corrected.
 */
export function applyConstraintsToSkeleton(skelData: SkeletonData): boolean {
  const constrained = skelData.bones.filter(
    (b) => b.aimConstraint?.enabled || b.limitRotation?.enabled
  );
  if (constrained.length === 0) return false;

  skelData.skeleton.computeAbsoluteTransforms();
  constrained.sort((a, b) => boneDepth(a, skelData) - boneDepth(b, skelData));

  let changedAny = false;
  let absDirty = false;

  for (const bd of constrained) {
    // A corrected ancestor invalidates cached absolute transforms — refresh
    // before reading this bone's parent frame / head position.
    if (absDirty) {
      skelData.skeleton.computeAbsoluteTransforms();
      absDirty = false;
    }

    const localMat = bd.bone.getLocalMatrix();
    localMat.decompose(_decompScale, _decompRot, _decompPos);
    const scale = _decompScale.clone();
    const translation = _decompPos.clone();
    let rotation = _decompRot.clone();
    let boneChanged = false;

    const aim = bd.aimConstraint;
    if (aim?.enabled) {
      const abs = bd.bone.getAbsoluteTransform();
      const head = new Vector3(abs.m[12]!, abs.m[13]!, abs.m[14]!);
      const aimed = aimLocalRotation(
        getParentAbsoluteRotation(bd, skelData),
        head,
        new Vector3(aim.targetX, aim.targetY, aim.targetZ),
        bd.roll ?? 0
      );
      // Skip the rewrite when already aimed (|dot| ≈ 1 ⇔ same rotation).
      if (aimed && Math.abs(Quaternion.Dot(aimed, rotation)) < 1 - 1e-10) {
        rotation = aimed;
        boneChanged = true;
      }
    }

    const limit = bd.limitRotation;
    if (limit?.enabled) {
      const euler = rotation.toEulerAngles();
      const clamped = clampEulerRotation({ x: euler.x, y: euler.y, z: euler.z }, limit);
      if (clamped.changed) {
        rotation = Quaternion.FromEulerAngles(
          clamped.rotation.x,
          clamped.rotation.y,
          clamped.rotation.z
        );
        boneChanged = true;
      }
    }

    if (boneChanged) {
      localMat.copyFrom(Matrix.Compose(scale, rotation, translation));
      bd.bone.markAsDirty();
      changedAny = true;
      absDirty = true;
    }
  }

  if (changedAny) {
    skelData.skeleton.computeAbsoluteTransforms();
    for (const bd of skelData.bones) {
      if (!bd.visual) continue;
      const abs = bd.bone.getAbsoluteTransform();
      bd.visual.position.set(abs.m[12]!, abs.m[13]!, abs.m[14]!);
    }
    updateHierarchyVisualization(skelData);
    refreshPoseGizmoOrientation();
  }
  return changedAny;
}

/**
 * Run {@link applyConstraintsToSkeleton} on every skeleton. Called from the
 * per-frame render hook right after the IK pass (see
 * `animation-tool.installIkRenderHook`), so constraints correct both manual
 * posing and IK output.
 */
export function applyAllBoneConstraints(): void {
  for (const [, skelData] of state.skeletonMap) {
    applyConstraintsToSkeleton(skelData);
  }
}

// ── Bone mirroring ──

/**
 * Mirror a Limit Rotation constraint across `axis` using the same euler
 * reflection rule as `mirrorPoseRotation`: components perpendicular to the
 * mirror axis negate, so their `[min, max]` interval becomes `[-max, -min]`.
 */
function mirrorLimitRotation(
  c: import("./bone-constraints").LimitRotationConstraint,
  axis: MirrorAxis
): import("./bone-constraints").LimitRotationConstraint {
  const m = { ...c };
  const flip = (minKey: "minXDeg" | "minYDeg" | "minZDeg", maxKey: "maxXDeg" | "maxYDeg" | "maxZDeg") => {
    const lo = m[minKey] ?? 0;
    const hi = m[maxKey] ?? 0;
    m[minKey] = -hi;
    m[maxKey] = -lo;
  };
  if (axis !== "x") flip("minXDeg", "maxXDeg");
  if (axis !== "y") flip("minYDeg", "maxYDeg");
  if (axis !== "z") flip("minZDeg", "maxZDeg");
  return m;
}

/** Mirror an Aim constraint's world target across `axis`. */
function mirrorAimConstraint(
  c: import("./bone-constraints").AimConstraint,
  axis: MirrorAxis
): import("./bone-constraints").AimConstraint {
  return {
    ...c,
    targetX: axis === "x" ? -c.targetX : c.targetX,
    targetY: axis === "y" ? -c.targetY : c.targetY,
    targetZ: axis === "z" ? -c.targetZ : c.targetZ,
  };
}

/** Mirror a bone's IK config across `axis` so the copy targets the other side. */
function mirrorIKConstraint(ik: IKConstraint, axis: MirrorAxis): IKConstraint {
  const m: IKConstraint = { ...ik };
  if (axis === "x") {
    m.targetX = -ik.targetX;
    if (m.poleX != null) m.poleX = -m.poleX;
  } else if (axis === "y") {
    m.targetY = -ik.targetY;
    if (m.poleY != null) m.poleY = -m.poleY;
  } else {
    m.targetZ = -ik.targetZ;
    if (m.poleZ != null) m.poleZ = -m.poleZ;
  }
  return m;
}

/**
 * Mirror the bone `rootBoneId` and its whole subtree across the plane
 * perpendicular to `axis` (default `x` — the usual left↔right rig mirror).
 * New bones get reflected positions and side-swapped names
 * (see {@link mirrorBoneName}); a bone whose parent is outside the mirrored
 * set re-attaches to that shared parent (e.g. an arm mirrored under the spine).
 *
 * All the new bones land under a single "Mirror Bones" undo entry.
 *
 * @returns the freshly created bones (root-first), or `[]` on failure.
 */
export function mirrorBoneChain(rootBoneId: string, axis: MirrorAxis = "x"): BoneData[] {
  const skelData = getActiveSkeleton();
  if (!skelData) return [];
  if (!skelData.bones.some((b) => b.id === rootBoneId)) return [];

  // BFS the subtree so parents are always created before their children.
  const order: string[] = [];
  const seen = new Set<string>([rootBoneId]);
  const queue: string[] = [rootBoneId];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const b of skelData.bones) {
      if (b.parentId === id && !seen.has(b.id)) {
        seen.add(b.id);
        queue.push(b.id);
      }
    }
  }

  const idMap = new Map<string, string>();
  const created: BoneData[] = [];
  let pushed = 0;

  for (const origId of order) {
    const orig = skelData.bones.find((b) => b.id === origId);
    if (!orig) continue;

    const worldPos = reflectPosition(getBoneWorldPosition(orig), axis);
    // Mirrored parent if it's in the set, otherwise share the original parent.
    let newParentId: string | null = orig.parentId;
    if (orig.parentId && seen.has(orig.parentId)) {
      newParentId = idMap.get(orig.parentId) ?? orig.parentId;
    }

    const nb = addBoneAtPoint(worldPos, newParentId);
    if (!nb) continue;
    pushed++;
    renameBone(nb.id, mirrorBoneName(orig.name));
    if (orig.ikConstraint) nb.ikConstraint = mirrorIKConstraint(orig.ikConstraint, axis);
    if (orig.limitRotation) nb.limitRotation = mirrorLimitRotation(orig.limitRotation, axis);
    if (orig.aimConstraint) nb.aimConstraint = mirrorAimConstraint(orig.aimConstraint, axis);
    // Reflection inverts handedness, so the twist reverses (Blender's
    // Symmetrize negates roll the same way).
    if (orig.roll != null) nb.roll = -orig.roll;
    idMap.set(origId, nb.id);
    created.push(nb);
  }

  if (created.length === 0) return [];

  // Fold the per-bone "Add Bone" entries into one compound "Mirror Bones".
  const subCommands: UndoCommand[] = [];
  for (let i = 0; i < pushed; i++) {
    const c = state.history.popUndo();
    if (c) subCommands.unshift(c); // back into creation order
  }
  state.history.push({
    label: "Mirror Bones",
    undo() {
      for (let i = subCommands.length - 1; i >= 0; i--) subCommands[i]!.undo();
    },
    redo() {
      for (const c of subCommands) c.redo();
    },
  });

  selectBone(created[0]!.id);
  status("Mirrored " + created.length + " bone(s)");
  return created;
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

// ── Bone roll ──

/**
 * Live-update a bone's roll (radians) while the UI input is being dragged /
 * typed — updates the gizmo axes immediately, no history entry. Pair with
 * {@link commitBoneRoll} on the gesture's end for a single undo step.
 */
export function setBoneRollLive(boneId: string, roll: number): void {
  const bd = findBoneById(boneId);
  if (!bd) return;
  bd.roll = roll;
  refreshPoseGizmoOrientation();
}

/**
 * Push one "Bone Roll" undo entry mapping `fromRoll` → the bone's current
 * roll. No-op when nothing actually changed over the gesture.
 */
export function commitBoneRoll(boneId: string, fromRoll: number): void {
  const bd = findBoneById(boneId);
  if (!bd) return;
  const toRoll = bd.roll ?? 0;
  if (toRoll === fromRoll) return;
  state.history.push({
    label: "Bone Roll",
    undo() { bd.roll = fromRoll; refreshPoseGizmoOrientation(); },
    redo() { bd.roll = toRoll; refreshPoseGizmoOrientation(); },
  });
}

// ── Pose copy / paste ──

/** Copy the bone's local pose (rotation + translation) to the clipboard. */
export function copyBonePose(boneId: string): void {
  const bd = findBoneById(boneId);
  if (!bd) return;
  bd.bone.getLocalMatrix().decompose(_decompScale, _decompRot, _decompPos);
  const euler = _decompRot.toEulerAngles();
  state.poseClipboard = {
    boneName: bd.name,
    rotation: { x: euler.x, y: euler.y, z: euler.z },
    position: { x: _decompPos.x, y: _decompPos.y, z: _decompPos.z },
  };
  status("Pose copied: " + bd.name);
}

/**
 * Write a local pose onto a bone (preserving its scale), cascade transforms
 * and visuals, push a single undo entry, and fire the pose-edited hook so
 * Auto-Key captures the change like a gizmo drag would.
 */
function applyPoseToBone(
  bd: BoneData,
  skelData: SkeletonData,
  rotation: { x: number; y: number; z: number },
  position: { x: number; y: number; z: number },
  label: string
): void {
  const before = bd.bone.getLocalMatrix().clone();
  bd.bone.getLocalMatrix().decompose(_decompScale, _decompRot, _decompPos);
  const after = Matrix.Compose(
    _decompScale.clone(),
    Quaternion.FromEulerAngles(rotation.x, rotation.y, rotation.z),
    new Vector3(position.x, position.y, position.z)
  );

  const write = (mat: Matrix) => {
    bd.bone.getLocalMatrix().copyFrom(mat);
    bd.bone.markAsDirty();
    skelData.skeleton.computeAbsoluteTransforms();
    // The bone's own position may have moved (translation pasted) — resync
    // its visual as well as all descendants.
    if (bd.visual) {
      const abs = bd.bone.getAbsoluteTransform();
      bd.visual.position.set(abs.m[12]!, abs.m[13]!, abs.m[14]!);
    }
    updateChildVisuals(bd.id, skelData);
    updateHierarchyVisualization(skelData);
    refreshPoseGizmoOrientation();
  };

  write(after);
  state.history.push({
    label,
    undo() { write(before); },
    redo() { write(after); },
  });
  _poseEditedHandler?.(bd.id);
}

/**
 * Paste the clipboard pose. Without `mirrorAxis` the pose lands on the
 * currently selected bone. With `mirrorAxis` the pose is mirrored across
 * that axis and applied to the *counterpart* of the copied bone (resolved
 * via {@link mirrorBoneName} — e.g. copy `arm_L`, paste-mirrored writes
 * `arm_R`), which is the Blender "Paste Pose Flipped" flow.
 *
 * @returns `true` when a pose was applied.
 */
export function pasteBonePose(mirrorAxis?: MirrorAxis): boolean {
  const clip = state.poseClipboard;
  if (!clip) {
    status("⚠ コピーしたポーズがありません");
    return false;
  }
  const skelData = getActiveSkeleton();
  if (!skelData) return false;

  if (mirrorAxis) {
    const targetName = mirrorBoneName(clip.boneName);
    const target = skelData.bones.find((b) => b.name === targetName);
    if (!target) {
      status("⚠ 対側ボーンが見つかりません: " + targetName);
      return false;
    }
    applyPoseToBone(
      target,
      skelData,
      mirrorPoseRotation(clip.rotation, mirrorAxis),
      mirrorLocalTranslation(clip.position, mirrorAxis),
      "Paste Pose (Mirror)"
    );
    status("Pose pasted (mirrored) → " + targetName);
    return true;
  }

  if (!state.selectedBoneId) {
    status("⚠ ペースト先のボーンを選択");
    return false;
  }
  const bd = skelData.bones.find((b) => b.id === state.selectedBoneId);
  if (!bd) return false;
  applyPoseToBone(bd, skelData, clip.rotation, clip.position, "Paste Pose");
  status("Pose pasted → " + bd.name);
  return true;
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

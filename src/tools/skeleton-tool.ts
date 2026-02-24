import { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { Bone } from "@babylonjs/core/Bones/bone";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
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
  }
  return boneMaterial;
}

function getSelectedBoneMaterial(): StandardMaterial {
  if (!selectedBoneMaterial) {
    selectedBoneMaterial = new StandardMaterial("boneSelMat", state.scene);
    selectedBoneMaterial.diffuseColor = new Color3(1, 0.8, 0.2);
    selectedBoneMaterial.emissiveColor = new Color3(0.5, 0.4, 0.1);
  }
  return selectedBoneMaterial;
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
  return boneData;
}

function getBoneWorldPosition(boneData: BoneData): Vector3 {
  if (boneData.visual) {
    return boneData.visual.position.clone();
  }
  // Fallback: extract from bone's absolute transform
  const m = boneData.bone.getAbsoluteTransform();
  return new Vector3(m.m[12], m.m[13], m.m[14]);
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
  return mesh;
}

export function updateHierarchyVisualization(skelData: SkeletonData): void {
  // Dispose old lines
  if (skelData.hierarchyLines) {
    skelData.hierarchyLines.dispose();
    skelData.hierarchyLines = null;
  }

  // Build line segments for parent→child connections
  const lines: Vector3[][] = [];
  for (const bd of skelData.bones) {
    if (bd.parentId) {
      const parent = skelData.bones.find((b) => b.id === bd.parentId);
      if (parent) {
        const parentPos = getBoneWorldPosition(parent);
        const childPos = getBoneWorldPosition(bd);
        lines.push([parentPos, childPos]);
      }
    }
  }

  if (lines.length === 0) return;

  const lineSystem = MeshBuilder.CreateLineSystem(
    HIERARCHY_LINES_NAME,
    { lines },
    state.scene
  );
  lineSystem.color = new Color3(0.36, 0.5, 1);
  lineSystem.isPickable = false;
  skelData.hierarchyLines = lineSystem;
}

// ── Gizmo drag observer tracking ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _dragEndObserver: Observer<any> | null = null;

function cleanupDragObservers(): void {
  if (_dragEndObserver) {
    try {
      const posGizmo = state.gizmoManager.gizmos?.positionGizmo;
      if (posGizmo) {
        posGizmo.onDragEndObservable.remove(_dragEndObserver);
      }
    } catch { /* gizmo may already be disposed */ }
    _dragEndObserver = null;
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

  // Attach gizmo for bone movement
  const gm = state.gizmoManager;
  try {
    gm.positionGizmoEnabled = true;
    gm.rotationGizmoEnabled = false;
    gm.scaleGizmoEnabled = false;
    gm.attachToMesh(boneData.visual);

    // Subscribe to gizmo drag end — sync bone matrix + hierarchy on release
    const posGizmo = gm.gizmos?.positionGizmo;
    if (posGizmo) {
      _dragEndObserver = posGizmo.onDragEndObservable.add(() => {
        syncBoneFromVisual(boneData, skelData);
      });
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

function syncBoneFromVisual(boneData: BoneData, skelData: SkeletonData): void {
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

  // Update hierarchy lines
  updateHierarchyVisualization(skelData);
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

  for (const id of toDelete) {
    const idx = skelData.bones.findIndex((b) => b.id === id);
    if (idx === -1) continue;
    const bd = skelData.bones[idx]!;
    if (bd.visual) {
      bd.visual.dispose();
    }
    skelData.bones.splice(idx, 1);
  }

  updateHierarchyVisualization(skelData);
  status("Bone(s) deleted");
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

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { state, isMobile } from "../state";
import { updateHierarchy, updateProperties } from "../ui/panels";
import { applySelectedEdges, resetEdges } from "./mesh-utils";

export function selectMesh(mesh: AbstractMesh | null, additive: boolean): void {
  if (!additive) {
    for (const m of state.selectedMeshes) {
      resetEdges(m);
    }
    state.selectedMeshes = [];
  }
  if (mesh && !state.selectedMeshes.includes(mesh)) {
    state.selectedMeshes.push(mesh);
    applySelectedEdges(mesh);
  }
  updateGizmo();
  updateHierarchy();
  updateProperties();
}

export function deselect(): void {
  selectMesh(null, false);
}

export function lastSelected(): AbstractMesh | undefined {
  return state.selectedMeshes[state.selectedMeshes.length - 1];
}

let gizmoUndoInitialized = false;
let dragBefore: { pos: Vector3; rot: Vector3; scl: Vector3; mesh: AbstractMesh } | null = null;

function initGizmoUndo(): void {
  if (gizmoUndoInitialized) return;
  gizmoUndoInitialized = true;

  const gm = state.gizmoManager;
  const gizmos = [gm.gizmos.positionGizmo, gm.gizmos.rotationGizmo, gm.gizmos.scaleGizmo];

  for (const g of gizmos) {
    if (!g) continue;
    g.onDragStartObservable.add(() => {
      const m = lastSelected();
      if (!m) return;
      dragBefore = {
        pos: m.position.clone(),
        rot: m.rotation.clone(),
        scl: m.scaling.clone(),
        mesh: m,
      };
    });
    g.onDragEndObservable.add(() => {
      if (!dragBefore) return;
      const { mesh, pos, rot, scl } = dragBefore;
      const afterPos = mesh.position.clone();
      const afterRot = mesh.rotation.clone();
      const afterScl = mesh.scaling.clone();
      // Only push undo if something actually changed
      if (!pos.equals(afterPos) || !rot.equals(afterRot) || !scl.equals(afterScl)) {
        const bPos = pos, bRot = rot, bScl = scl;
        const aPos = afterPos, aRot = afterRot, aScl = afterScl;
        const m = mesh;
        state.history.push({
          label: "Transform",
          undo() { m.position.copyFrom(bPos); m.rotation.copyFrom(bRot); m.scaling.copyFrom(bScl); updateProperties(); },
          redo() { m.position.copyFrom(aPos); m.rotation.copyFrom(aRot); m.scaling.copyFrom(aScl); updateProperties(); },
        });
      }
      dragBefore = null;
    });
  }
}

export function updateGizmo(): void {
  const { gizmoManager: gm, tool, selectedMeshes } = state;

  // Bone visual transparency: semi-transparent in weight mode for easier painting
  const boneVis = tool === "weight" ? 0.4 : 1.0;
  for (const [, sd] of state.skeletonMap) {
    for (const bd of sd.bones) {
      if (bd.visual) bd.visual.visibility = boneVis;
    }
  }

  // Non-transform tools: detach first, then disable (order matters for Babylon.js internals)
  if (tool === "sculpt" || tool === "paint" || tool === "bone" || tool === "weight" || tool === "anim") {
    try {
      gm.attachToMesh(null);
      gm.positionGizmoEnabled = false;
      gm.rotationGizmoEnabled = false;
      gm.scaleGizmoEnabled = false;
    } catch (e) { console.warn("Gizmo detach:", e); }
    return;
  }

  try {
    gm.positionGizmoEnabled = false;
    gm.rotationGizmoEnabled = false;
    gm.scaleGizmoEnabled = false;

    if (!selectedMeshes.length) {
      gm.attachToMesh(null);
      return;
    }
    gm.attachToMesh(lastSelected()!);
    if (tool === "move") gm.positionGizmoEnabled = true;
    else if (tool === "rotate") gm.rotationGizmoEnabled = true;
    else if (tool === "scale") gm.scaleGizmoEnabled = true;
    // Enlarge gizmo handles on mobile for easier touch interaction
    const ratio = isMobile() ? 2.5 : 1;
    if (gm.gizmos.positionGizmo) gm.gizmos.positionGizmo.scaleRatio = ratio;
    if (gm.gizmos.rotationGizmo) gm.gizmos.rotationGizmo.scaleRatio = ratio;
    if (gm.gizmos.scaleGizmo) gm.gizmos.scaleGizmo.scaleRatio = ratio;
    // Enable planar gizmo handles on mobile (easier to grab than thin axes)
    if (gm.gizmos.positionGizmo && isMobile()) {
      gm.gizmos.positionGizmo.planarGizmoEnabled = true;
    }
    // Init undo observers after gizmos are created (lazy by GizmoManager)
    initGizmoUndo();
    initGizmoCameraControl();
  } catch (e) { console.warn("Gizmo update:", e); }
}

let gizmoCameraInitialized = false;

function initGizmoCameraControl(): void {
  if (gizmoCameraInitialized) return;
  gizmoCameraInitialized = true;

  const gm = state.gizmoManager;
  const gizmos = [gm.gizmos.positionGizmo, gm.gizmos.rotationGizmo, gm.gizmos.scaleGizmo];
  for (const g of gizmos) {
    if (!g) continue;
    g.onDragStartObservable.add(() => {
      if (isMobile()) state.camera.detachControl();
    });
    g.onDragEndObservable.add(() => {
      if (isMobile() && !state.cameraLocked) state.camera.attachControl(state.canvas, true);
    });
  }
}

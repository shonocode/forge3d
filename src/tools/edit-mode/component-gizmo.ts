import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { PositionGizmo } from "@babylonjs/core/Gizmos/positionGizmo";
import { UtilityLayerRenderer } from "@babylonjs/core/Rendering/utilityLayerRenderer";
import type { Scene } from "@babylonjs/core/scene";
import { commitPositions } from "./commit";
import { faceVertices, edgeOrigin, edgeEnd, type EditMesh } from "./half-edge";
import { refreshOverlayPositions, type EditOverlay } from "./overlay";
import { state } from "../../state";
import type { EditSelection } from "../../state";
import { updateProperties } from "../../ui/panels";

/**
 * Component gizmo: a position gizmo attached to an invisible TransformNode
 * parented to the source mesh, sitting at the centroid of the current
 * selection. Dragging the gizmo translates the selected components by the
 * same world-space delta — implemented by reading the local-space delta of
 * the proxy (parented = automatic transform) and applying it to each affected
 * vertex.
 */
export interface ComponentGizmo {
  proxy: TransformNode;
  gizmo: PositionGizmo;
  layer: UtilityLayerRenderer;
  dispose(): void;
  /** Recompute centroid and reposition the proxy. Call after selection change. */
  refresh(em: EditMesh, sel: EditSelection): void;
}

export function createComponentGizmo(
  scene: Scene,
  em: EditMesh,
  sel: EditSelection,
  overlay: EditOverlay,
): ComponentGizmo {
  const layer = new UtilityLayerRenderer(scene);
  const proxy = new TransformNode("edit-gizmo-proxy", scene);
  proxy.parent = em.source;

  const gizmo = new PositionGizmo(layer);
  gizmo.attachedNode = proxy;

  // Drag state — snapshot positions of affected vertices when drag begins
  // so each per-tick update can re-derive the new positions from a stable
  // baseline (avoids drift from floating-point accumulation).
  let dragSnapshot: Float32Array | null = null;
  let dragAffected: number[] | null = null;
  let dragStartLocal = new Vector3();

  const onDragStart = (): void => {
    dragSnapshot = new Float32Array(em.positions);
    dragAffected = computeAffectedVertices(em, sel);
    dragStartLocal = proxy.position.clone();
  };

  const onDrag = (): void => {
    if (!dragSnapshot || !dragAffected) return;
    const dx = proxy.position.x - dragStartLocal.x;
    const dy = proxy.position.y - dragStartLocal.y;
    const dz = proxy.position.z - dragStartLocal.z;
    for (const v of dragAffected) {
      em.positions[v * 3] = dragSnapshot[v * 3]! + dx;
      em.positions[v * 3 + 1] = dragSnapshot[v * 3 + 1]! + dy;
      em.positions[v * 3 + 2] = dragSnapshot[v * 3 + 2]! + dz;
    }
    commitPositions(em);
    refreshOverlayPositions(scene, overlay, em, sel);
  };

  const onDragEnd = (): void => {
    if (!dragSnapshot || !dragAffected) return;
    const before = dragSnapshot;
    const after = new Float32Array(em.positions);
    const affected = dragAffected.slice();
    const editMesh = em;
    // Skip undo if nothing actually moved.
    let moved = false;
    for (const v of affected) {
      if (before[v * 3] !== after[v * 3] || before[v * 3 + 1] !== after[v * 3 + 1] || before[v * 3 + 2] !== after[v * 3 + 2]) {
        moved = true; break;
      }
    }
    if (moved) {
      state.history.push({
        label: "Edit: Move " + sel.mode,
        undo() {
          for (const v of affected) {
            editMesh.positions[v * 3] = before[v * 3]!;
            editMesh.positions[v * 3 + 1] = before[v * 3 + 1]!;
            editMesh.positions[v * 3 + 2] = before[v * 3 + 2]!;
          }
          commitPositions(editMesh);
          refreshOverlayPositions(scene, overlay, editMesh, sel);
          recenterProxy(proxy, editMesh, sel);
          updateProperties();
        },
        redo() {
          for (const v of affected) {
            editMesh.positions[v * 3] = after[v * 3]!;
            editMesh.positions[v * 3 + 1] = after[v * 3 + 1]!;
            editMesh.positions[v * 3 + 2] = after[v * 3 + 2]!;
          }
          commitPositions(editMesh);
          refreshOverlayPositions(scene, overlay, editMesh, sel);
          recenterProxy(proxy, editMesh, sel);
          updateProperties();
        },
      });
    }
    dragSnapshot = null;
    dragAffected = null;
    recenterProxy(proxy, em, sel);
    dragStartLocal = proxy.position.clone();
  };

  for (const g of [gizmo.xGizmo, gizmo.yGizmo, gizmo.zGizmo]) {
    g.dragBehavior.onDragStartObservable.add(onDragStart);
    g.dragBehavior.onDragObservable.add(onDrag);
    g.dragBehavior.onDragEndObservable.add(onDragEnd);
  }

  recenterProxy(proxy, em, sel);

  return {
    proxy,
    gizmo,
    layer,
    refresh(emRef, selRef) {
      recenterProxy(proxy, emRef, selRef);
      gizmo.attachedNode = selRef.indices.size > 0 ? proxy : null;
    },
    dispose() {
      gizmo.dispose();
      layer.dispose();
      proxy.dispose();
    },
  };
}

function recenterProxy(proxy: TransformNode, em: EditMesh, sel: EditSelection): void {
  const c = computeCentroid(em, sel);
  proxy.position.copyFromFloats(c[0], c[1], c[2]);
}

function computeAffectedVertices(em: EditMesh, sel: EditSelection): number[] {
  const set = new Set<number>();
  if (sel.mode === "vertex") {
    for (const v of sel.indices) set.add(v);
  } else if (sel.mode === "edge") {
    for (const he of sel.indices) {
      set.add(edgeOrigin(em, he));
      set.add(edgeEnd(em, he));
    }
  } else {
    for (const f of sel.indices) {
      const [a, b, c] = faceVertices(em, f);
      set.add(a); set.add(b); set.add(c);
    }
  }
  return Array.from(set);
}

function computeCentroid(em: EditMesh, sel: EditSelection): [number, number, number] {
  const affected = computeAffectedVertices(em, sel);
  if (affected.length === 0) return [0, 0, 0];
  let cx = 0, cy = 0, cz = 0;
  for (const v of affected) {
    cx += em.positions[v * 3]!;
    cy += em.positions[v * 3 + 1]!;
    cz += em.positions[v * 3 + 2]!;
  }
  const n = affected.length;
  return [cx / n, cy / n, cz / n];
}

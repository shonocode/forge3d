import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { PositionGizmo } from "@babylonjs/core/Gizmos/positionGizmo";
import { RotationGizmo } from "@babylonjs/core/Gizmos/rotationGizmo";
import { ScaleGizmo } from "@babylonjs/core/Gizmos/scaleGizmo";
import { UtilityLayerRenderer } from "@babylonjs/core/Rendering/utilityLayerRenderer";
import type { Scene } from "@babylonjs/core/scene";
import { commitPositions } from "./commit";
import { faceVertices, edgeOrigin, edgeEnd, type EditMesh } from "./half-edge";
import { refreshOverlayPositions, type EditOverlay } from "./overlay";
import { computeFalloffWeights } from "./proportional";
import { state } from "../../state";
import type { EditSelection } from "../../state";
import { updateProperties } from "../../ui/panels";

/** Which transform the component gizmo currently performs. */
export type EditGizmoMode = "move" | "rotate" | "scale";

/**
 * Component gizmo: move / rotate / scale gizmos attached to an invisible
 * TransformNode parented to the source mesh, sitting at the centroid of the
 * current selection. Only the active mode's gizmo is attached at a time
 * (see {@link ComponentGizmo.setMode}).
 *
 * - **Move** translates the affected vertices by the proxy's local delta.
 * - **Rotate** spins them around the drag-start centroid (proxy rotation
 *   is reset to identity per drag, so the quaternion read IS the delta).
 * - **Scale** scales them around the drag-start centroid per axis.
 *
 * Proportional editing (F-M8): when `state.editConfig.proportional` is on,
 * drag-start computes falloff weights around the selection
 * ({@link computeFalloffWeights}) and every transform is blended per vertex —
 * full effect at weight 1, fading to none at the radius rim. Weight blending:
 * move lerps the delta, rotate slerps the delta quaternion, scale lerps the
 * per-axis factors toward 1.
 */
export interface ComponentGizmo {
  proxy: TransformNode;
  gizmo: PositionGizmo;
  rotationGizmo: RotationGizmo;
  scaleGizmo: ScaleGizmo;
  layer: UtilityLayerRenderer;
  /** Currently active transform mode. */
  readonly mode: EditGizmoMode;
  /** Switch which gizmo is shown (keeps the attachment state in sync). */
  setMode(mode: EditGizmoMode): void;
  /** True while the pointer is over any of the three gizmos' handles. */
  isHovered(): boolean;
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
  proxy.rotationQuaternion = Quaternion.Identity();

  const gizmo = new PositionGizmo(layer);
  const rotationGizmo = new RotationGizmo(layer);
  const scaleGizmo = new ScaleGizmo(layer);
  let mode: EditGizmoMode = "move";

  // Drag state — snapshot positions of affected vertices when drag begins
  // so each per-tick update can re-derive the new positions from a stable
  // baseline (avoids drift from floating-point accumulation).
  let dragSnapshot: Float32Array | null = null;
  let dragWeights: Map<number, number> | null = null;
  let dragStartLocal = new Vector3();
  let dragCentroid = new Vector3();

  const onDragStart = (): void => {
    dragSnapshot = new Float32Array(em.positions);
    const affected = computeAffectedVertices(em, sel);
    const cfg = state.editConfig;
    dragWeights = cfg.proportional
      ? computeFalloffWeights(em.positions, affected, cfg.proportionalRadius)
      : new Map(affected.map((v) => [v, 1]));
    const c = centroidOf(em.positions, affected);
    dragCentroid.copyFromFloats(c[0], c[1], c[2]);
    dragStartLocal = proxy.position.clone();
    // Rotation/scale read the proxy's transform as the drag delta — zero it.
    proxy.rotationQuaternion!.copyFrom(Quaternion.Identity());
    proxy.scaling.copyFromFloats(1, 1, 1);
  };

  const _rel = new Vector3();
  const _rot = new Vector3();
  const _blend = new Quaternion();

  const onDrag = (): void => {
    if (!dragSnapshot || !dragWeights) return;

    if (mode === "move") {
      const dx = proxy.position.x - dragStartLocal.x;
      const dy = proxy.position.y - dragStartLocal.y;
      const dz = proxy.position.z - dragStartLocal.z;
      for (const [v, w] of dragWeights) {
        em.positions[v * 3] = dragSnapshot[v * 3]! + dx * w;
        em.positions[v * 3 + 1] = dragSnapshot[v * 3 + 1]! + dy * w;
        em.positions[v * 3 + 2] = dragSnapshot[v * 3 + 2]! + dz * w;
      }
    } else if (mode === "rotate") {
      const q = proxy.rotationQuaternion!;
      for (const [v, w] of dragWeights) {
        _rel.copyFromFloats(
          dragSnapshot[v * 3]! - dragCentroid.x,
          dragSnapshot[v * 3 + 1]! - dragCentroid.y,
          dragSnapshot[v * 3 + 2]! - dragCentroid.z,
        );
        const rq = w >= 1 ? q : Quaternion.SlerpToRef(Quaternion.Identity(), q, w, _blend);
        _rel.rotateByQuaternionToRef(rq, _rot);
        em.positions[v * 3] = dragCentroid.x + _rot.x;
        em.positions[v * 3 + 1] = dragCentroid.y + _rot.y;
        em.positions[v * 3 + 2] = dragCentroid.z + _rot.z;
      }
    } else {
      const s = proxy.scaling;
      for (const [v, w] of dragWeights) {
        const sx = 1 + (s.x - 1) * w;
        const sy = 1 + (s.y - 1) * w;
        const sz = 1 + (s.z - 1) * w;
        em.positions[v * 3] = dragCentroid.x + (dragSnapshot[v * 3]! - dragCentroid.x) * sx;
        em.positions[v * 3 + 1] = dragCentroid.y + (dragSnapshot[v * 3 + 1]! - dragCentroid.y) * sy;
        em.positions[v * 3 + 2] = dragCentroid.z + (dragSnapshot[v * 3 + 2]! - dragCentroid.z) * sz;
      }
    }
    commitPositions(em);
    refreshOverlayPositions(scene, overlay, em, sel);
  };

  const onDragEnd = (): void => {
    if (!dragSnapshot || !dragWeights) return;
    const before = dragSnapshot;
    const after = new Float32Array(em.positions);
    const affected = [...dragWeights.keys()];
    const editMesh = em;
    // Skip undo if nothing actually moved.
    let moved = false;
    for (const v of affected) {
      if (before[v * 3] !== after[v * 3] || before[v * 3 + 1] !== after[v * 3 + 1] || before[v * 3 + 2] !== after[v * 3 + 2]) {
        moved = true; break;
      }
    }
    if (moved) {
      const labelVerb = mode === "move" ? "Move" : mode === "rotate" ? "Rotate" : "Scale";
      state.history.push({
        label: `Edit: ${labelVerb} ` + sel.mode,
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
    dragWeights = null;
    proxy.rotationQuaternion!.copyFrom(Quaternion.Identity());
    proxy.scaling.copyFromFloats(1, 1, 1);
    recenterProxy(proxy, em, sel);
    dragStartLocal = proxy.position.clone();
  };

  for (const g of [gizmo.xGizmo, gizmo.yGizmo, gizmo.zGizmo]) {
    g.dragBehavior.onDragStartObservable.add(onDragStart);
    g.dragBehavior.onDragObservable.add(onDrag);
    g.dragBehavior.onDragEndObservable.add(onDragEnd);
  }
  for (const g of [rotationGizmo.xGizmo, rotationGizmo.yGizmo, rotationGizmo.zGizmo]) {
    g.dragBehavior.onDragStartObservable.add(onDragStart);
    g.dragBehavior.onDragObservable.add(onDrag);
    g.dragBehavior.onDragEndObservable.add(onDragEnd);
  }
  for (const g of [scaleGizmo.xGizmo, scaleGizmo.yGizmo, scaleGizmo.zGizmo, scaleGizmo.uniformScaleGizmo]) {
    g.dragBehavior.onDragStartObservable.add(onDragStart);
    g.dragBehavior.onDragObservable.add(onDrag);
    g.dragBehavior.onDragEndObservable.add(onDragEnd);
  }

  const applyMode = (hasSelection: boolean): void => {
    gizmo.attachedNode = hasSelection && mode === "move" ? proxy : null;
    rotationGizmo.attachedNode = hasSelection && mode === "rotate" ? proxy : null;
    scaleGizmo.attachedNode = hasSelection && mode === "scale" ? proxy : null;
  };

  recenterProxy(proxy, em, sel);
  applyMode(sel.indices.size > 0);

  return {
    proxy,
    gizmo,
    rotationGizmo,
    scaleGizmo,
    layer,
    get mode() { return mode; },
    setMode(m: EditGizmoMode) {
      mode = m;
      applyMode(state.editSelection.indices.size > 0);
    },
    isHovered() {
      return gizmo.isHovered || rotationGizmo.isHovered || scaleGizmo.isHovered;
    },
    refresh(emRef, selRef) {
      recenterProxy(proxy, emRef, selRef);
      applyMode(selRef.indices.size > 0);
    },
    dispose() {
      gizmo.dispose();
      rotationGizmo.dispose();
      scaleGizmo.dispose();
      layer.dispose();
      proxy.dispose();
    },
  };
}

function recenterProxy(proxy: TransformNode, em: EditMesh, sel: EditSelection): void {
  const c = centroidOf(em.positions, computeAffectedVertices(em, sel));
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

function centroidOf(positions: Float32Array, verts: readonly number[]): [number, number, number] {
  if (verts.length === 0) return [0, 0, 0];
  let cx = 0, cy = 0, cz = 0;
  for (const v of verts) {
    cx += positions[v * 3]!;
    cy += positions[v * 3 + 1]!;
    cz += positions[v * 3 + 2]!;
  }
  const n = verts.length;
  return [cx / n, cy / n, cz / n];
}

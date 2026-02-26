import { state } from "../state";
import { Tools } from "@babylonjs/core/Misc/tools";

export function applySnapToGizmos(): void {
  const gm = state.gizmoManager;
  const sc = state.snapConfig;

  if (gm.gizmos.positionGizmo) {
    gm.gizmos.positionGizmo.snapDistance = sc.positionEnabled ? sc.positionIncrement : 0;
  }
  if (gm.gizmos.rotationGizmo) {
    gm.gizmos.rotationGizmo.snapDistance = sc.rotationEnabled ? Tools.ToRadians(sc.rotationIncrement) : 0;
  }
  if (gm.gizmos.scaleGizmo) {
    gm.gizmos.scaleGizmo.snapDistance = sc.scaleEnabled ? sc.scaleIncrement : 0;
  }
}

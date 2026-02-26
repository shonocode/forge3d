import { Vector3, Matrix } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { state, status } from "../state";
import type { MeasurementData } from "../state";

const MARKER_SIZE = 0.12;
const IDENTITY = Matrix.Identity();

let _markerMat: StandardMaterial | null = null;
function getMarkerMat(): StandardMaterial {
  if (!_markerMat) {
    _markerMat = new StandardMaterial("__measureMarker", state.scene);
    _markerMat.emissiveColor = new Color3(1, 0.3, 0.1);
    _markerMat.disableLighting = true;
  }
  return _markerMat;
}

function createMarker(pos: Vector3, name: string): import("@babylonjs/core").AbstractMesh {
  const m = MeshBuilder.CreateSphere(name, { diameter: MARKER_SIZE, segments: 6 }, state.scene);
  m.position.copyFrom(pos);
  m.material = getMarkerMat();
  m.isPickable = false;
  return m;
}

export function addMeasurePoint(worldPos: Vector3): void {
  if (!state.measureStartPoint) {
    state.measureStartPoint = worldPos.clone();
    status("Measure: click second point");
    return;
  }

  const startPos = state.measureStartPoint;
  const endPos = worldPos.clone();
  state.measureStartPoint = null;

  const distance = Vector3.Distance(startPos, endPos);
  state.measureCounter++;
  const id = "meas_" + state.measureCounter;

  const lineMesh = MeshBuilder.CreateLines(id + "_line", {
    points: [startPos, endPos],
    colors: [new Color4(1, 0.3, 0.1, 1), new Color4(1, 0.3, 0.1, 1)],
  }, state.scene);
  lineMesh.isPickable = false;

  const startMarker = createMarker(startPos, id + "_s");
  const endMarker = createMarker(endPos, id + "_e");

  const labelDiv = document.createElement("div");
  labelDiv.className = "measure-label";
  labelDiv.textContent = distance.toFixed(3) + " m";
  document.querySelector(".vp")!.appendChild(labelDiv);

  const data: MeasurementData = {
    id, start: { x: startPos.x, y: startPos.y, z: startPos.z },
    end: { x: endPos.x, y: endPos.y, z: endPos.z },
    distance, lineMesh, labelDiv, startMarker, endMarker,
  };
  state.measurements.push(data);
  status(`Distance: ${distance.toFixed(3)} m`);
}

export function clearMeasurements(): void {
  for (const m of state.measurements) {
    m.lineMesh.dispose();
    m.startMarker.dispose();
    m.endMarker.dispose();
    m.labelDiv.remove();
  }
  state.measurements = [];
  state.measureStartPoint = null;
  state.measuringActive = false;
  const btn = document.getElementById("btnMeasure");
  if (btn) btn.classList.remove("on");
  status("Measurements cleared");
}

export function toggleMeasureMode(): void {
  state.measuringActive = !state.measuringActive;
  state.measureStartPoint = null;
  const btn = document.getElementById("btnMeasure");
  if (btn) btn.classList.toggle("on", state.measuringActive);
  status(state.measuringActive ? "Measure mode ON" : "Measure mode OFF");
}

/** Update label screen positions — call from render loop */
export function updateMeasureOverlay(): void {
  if (state.measurements.length === 0) return;
  const vw = state.engine.getRenderWidth();
  const vh = state.engine.getRenderHeight();
  const transform = state.scene.getTransformMatrix();
  const viewport = state.camera.viewport.toGlobal(vw, vh);

  for (const m of state.measurements) {
    const mid = new Vector3(
      (m.start.x + m.end.x) / 2,
      (m.start.y + m.end.y) / 2,
      (m.start.z + m.end.z) / 2,
    );
    const sp = Vector3.Project(mid, IDENTITY, transform, viewport);
    if (sp.z > 0 && sp.z < 1) {
      m.labelDiv.style.display = "block";
      m.labelDiv.style.left = sp.x + "px";
      m.labelDiv.style.top = sp.y + "px";
    } else {
      m.labelDiv.style.display = "none";
    }
  }
}

/** Get bounding box dimensions for display */
export function getBoundingDimensions(mesh: import("@babylonjs/core").AbstractMesh): { w: number; h: number; d: number } | null {
  mesh.computeWorldMatrix(true);
  const bi = mesh.getBoundingInfo();
  if (!bi) return null;
  const min = bi.boundingBox.minimumWorld;
  const max = bi.boundingBox.maximumWorld;
  return {
    w: Math.abs(max.x - min.x),
    h: Math.abs(max.y - min.y),
    d: Math.abs(max.z - min.z),
  };
}

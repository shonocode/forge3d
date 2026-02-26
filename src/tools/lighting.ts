import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { SpotLight } from "@babylonjs/core/Lights/spotLight";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { state, status } from "../state";
import type { LightData, LightType } from "../state";

const MAX_LIGHTS = 8;

function hexToColor3(hex: string): Color3 {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return new Color3(r, g, b);
}

function createVisual(id: string, type: LightType, color: string): import("@babylonjs/core").AbstractMesh {
  let mesh: import("@babylonjs/core").AbstractMesh;
  if (type === "point") {
    mesh = MeshBuilder.CreateSphere("light_vis_" + id, { diameter: 0.3, segments: 8 }, state.scene);
  } else {
    mesh = MeshBuilder.CreateCylinder("light_vis_" + id, { height: 0.4, diameterTop: 0, diameterBottom: 0.3, tessellation: 8 }, state.scene);
    mesh.rotation.x = Math.PI; // Point downward
  }
  const mat = new StandardMaterial("light_mat_" + id, state.scene);
  mat.emissiveColor = hexToColor3(color);
  mat.disableLighting = true;
  mat.alpha = 0.7;
  mesh.material = mat;
  mesh.isPickable = false;
  return mesh;
}

export function addLight(type: LightType): LightData | null {
  if (state.lightMap.size >= MAX_LIGHTS) {
    status("ライト上限（" + MAX_LIGHTS + "個）に達しています");
    return null;
  }

  state.lightCounter++;
  const id = "light_" + state.lightCounter;
  const color = "#ffffff";
  const intensity = 1.0;
  const range = 20;
  const pos = new Vector3(0, 3, 0);

  let light: PointLight | SpotLight;
  if (type === "point") {
    light = new PointLight(id, pos, state.scene);
    light.intensity = intensity;
    light.range = range;
    light.diffuse = hexToColor3(color);
  } else {
    light = new SpotLight(id, pos, new Vector3(0, -1, 0), Math.PI / 4, 2, state.scene);
    light.intensity = intensity;
    light.range = range;
    light.diffuse = hexToColor3(color);
  }

  const visual = createVisual(id, type, color);
  visual.position = pos.clone();

  const data: LightData = {
    id, type, light, visual, color, intensity, range,
    angle: type === "spot" ? 45 : undefined,
  };
  state.lightMap.set(id, data);
  status((type === "point" ? "Point" : "Spot") + " Light added");
  return data;
}

export function removeLight(id: string): void {
  const data = state.lightMap.get(id);
  if (!data) return;
  data.light.dispose();
  data.visual.dispose();
  state.lightMap.delete(id);
  if (state.selectedLightId === id) state.selectedLightId = null;
  status("Light removed");
}

export function updateLightParam(id: string, key: string, value: number | string): void {
  const data = state.lightMap.get(id);
  if (!data) return;

  switch (key) {
    case "color":
      data.color = value as string;
      data.light.diffuse = hexToColor3(data.color);
      (data.visual.material as StandardMaterial).emissiveColor = hexToColor3(data.color);
      break;
    case "intensity":
      data.intensity = value as number;
      data.light.intensity = data.intensity;
      break;
    case "range":
      data.range = value as number;
      data.light.range = data.range;
      break;
    case "angle":
      if (data.type === "spot") {
        data.angle = value as number;
        (data.light as SpotLight).angle = (data.angle * Math.PI) / 180;
      }
      break;
    case "posX":
      data.light.position.x = value as number;
      data.visual.position.x = value as number;
      break;
    case "posY":
      data.light.position.y = value as number;
      data.visual.position.y = value as number;
      break;
    case "posZ":
      data.light.position.z = value as number;
      data.visual.position.z = value as number;
      break;
  }
}

export function selectLight(id: string): void {
  state.selectedLightId = id;
}

export function deselectLight(): void {
  state.selectedLightId = null;
}

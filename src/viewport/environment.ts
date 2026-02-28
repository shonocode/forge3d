import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import { HDRCubeTexture } from "@babylonjs/core/Materials/Textures/hdrCubeTexture";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { state, status } from "../state";
import { openFileDialog } from "../ui/file-input";

export interface EnvPreset {
  id: string;
  name: string;
  url: string;
  type: "env" | "hdr";
}

export const ENV_PRESETS: EnvPreset[] = [
  {
    id: "studio",
    name: "Studio",
    url: "https://assets.babylonjs.com/environments/environmentSpecular.env",
    type: "env",
  },
  {
    id: "country",
    name: "Country",
    url: "https://assets.babylonjs.com/environments/country.env",
    type: "env",
  },
];

let skybox: import("@babylonjs/core").Mesh | null = null;
let _customBlobUrl: string | null = null;

/**
 * Set default environment on scene initialization.
 */
export function initEnvironment(): void {
  setEnvironmentPreset("studio");
}

/**
 * Apply a preset environment by id.
 */
export function setEnvironmentPreset(id: string): void {
  const preset = ENV_PRESETS.find((p) => p.id === id);
  if (!preset) return;
  applyEnvironment(preset.url, preset.type);
  state.activeEnvPresetId = id;
  status("Environment: " + preset.name);
}

/**
 * Let the user pick a custom .hdr or .env file.
 */
export function loadCustomHDRI(): void {
  openFileDialog(".hdr,.env", (file) => {
    const ext = file.name.split(".").pop()?.toLowerCase();
    const url = URL.createObjectURL(file);
    _customBlobUrl = url;
    applyEnvironment(url, ext === "hdr" ? "hdr" : "env");
    state.activeEnvPresetId = "custom";
    status("Environment: " + file.name);
  });
}

function applyEnvironment(url: string, type: "env" | "hdr"): void {
  const { scene } = state;

  // Revoke previous custom blob URL to prevent memory leak
  if (_customBlobUrl && _customBlobUrl !== url) {
    URL.revokeObjectURL(_customBlobUrl);
    _customBlobUrl = null;
  }

  // Dispose previous environment texture
  if (scene.environmentTexture) {
    scene.environmentTexture.dispose();
    scene.environmentTexture = null;
  }
  disposeSkybox();

  let envTex: BaseTexture;
  if (type === "env") {
    envTex = CubeTexture.CreateFromPrefilteredData(url, scene);
  } else {
    envTex = new HDRCubeTexture(url, scene, 256);
  }
  scene.environmentTexture = envTex;
  scene.environmentIntensity = state.envIntensity;

  if (state.showSkybox) {
    createSkybox();
  }
}

export function setEnvironmentIntensity(v: number): void {
  state.envIntensity = v;
  state.scene.environmentIntensity = v;
}

export function toggleSkybox(show: boolean): void {
  state.showSkybox = show;
  if (show) {
    createSkybox();
  } else {
    disposeSkybox();
  }
}

function createSkybox(): void {
  disposeSkybox();
  if (!state.scene.environmentTexture) return;
  skybox = state.scene.createDefaultSkybox(state.scene.environmentTexture, true, 1000) as import("@babylonjs/core").Mesh | null;
  if (skybox) skybox.isPickable = false;
}

function disposeSkybox(): void {
  if (skybox) {
    skybox.dispose();
    skybox = null;
  }
}

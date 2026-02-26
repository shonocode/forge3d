import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import { HDRCubeTexture } from "@babylonjs/core/Materials/Textures/hdrCubeTexture";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { state, status } from "../state";

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
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".hdr,.env";
  input.style.display = "none";
  document.body.appendChild(input);
  const cleanup = () => { if (input.parentNode) input.remove(); };
  window.addEventListener("focus", () => setTimeout(cleanup, 300), { once: true });
  input.addEventListener("change", () => {
    cleanup();
    const file = input.files?.[0];
    if (!file) return;
    const ext = file.name.split(".").pop()?.toLowerCase();
    const url = URL.createObjectURL(file);
    applyEnvironment(url, ext === "hdr" ? "hdr" : "env");
    state.activeEnvPresetId = "custom";
    status("Environment: " + file.name);
  });
  input.click();
}

function applyEnvironment(url: string, type: "env" | "hdr"): void {
  const { scene } = state;

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

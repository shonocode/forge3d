import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import type { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { state, isMobile } from "../state";

let shadowGen: ShadowGenerator | null = null;
let shadowLight: DirectionalLight | null = null;

/**
 * Initialize shadow generator on the main directional light.
 */
export function initShadows(light: DirectionalLight): void {
  shadowLight = light;

  // Default off on mobile for performance
  if (isMobile()) {
    state.shadowsEnabled = false;
    return;
  }

  createShadowGenerator();
}

function createShadowGenerator(): void {
  if (!shadowLight) return;
  disposeShadowGenerator();

  shadowGen = new ShadowGenerator(state.shadowQuality, shadowLight);
  shadowGen.useBlurExponentialShadowMap = true;
  shadowGen.blurKernel = 32;
  shadowGen.setDarkness(0.5);

  // Add existing meshes as shadow casters
  for (const m of state.allMeshes) {
    shadowGen.addShadowCaster(m);
  }
}

function disposeShadowGenerator(): void {
  if (shadowGen) {
    shadowGen.dispose();
    shadowGen = null;
  }
}

/**
 * Add a mesh as a shadow caster.
 */
export function addShadowCaster(mesh: AbstractMesh): void {
  if (shadowGen) {
    shadowGen.addShadowCaster(mesh);
  }
  mesh.receiveShadows = true;
}

/**
 * Remove a mesh from shadow casters.
 */
export function removeShadowCaster(mesh: AbstractMesh): void {
  if (shadowGen) {
    shadowGen.removeShadowCaster(mesh);
  }
}

/**
 * Toggle shadows on/off.
 */
export function setShadowEnabled(on: boolean): void {
  state.shadowsEnabled = on;
  if (on) {
    createShadowGenerator();
  } else {
    disposeShadowGenerator();
  }
}

/**
 * Change shadow map resolution.
 */
export function setShadowQuality(size: 512 | 1024 | 2048): void {
  state.shadowQuality = size;
  if (state.shadowsEnabled) {
    createShadowGenerator();
  }
}

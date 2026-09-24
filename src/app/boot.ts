/**
 * Start the 3D side of the new screen (ADR-014): the Babylon viewport on the
 * canvas `#rc`, input, the render loop, autosave — the parts of the old
 * `main.ts` that are not the old screen — and the store's feed.
 *
 * Runs once per page; a second call (React's development double-mount) is a
 * no-op.
 */
import "../shaders"; // Babylon's shaders into the ShaderStore before the first frame
import "@babylonjs/core/Materials/Textures/Loaders/ktxTextureLoader";
import { initViewport } from "../viewport/viewport";
import { updateOrthoFrustum } from "../viewport/camera-presets";
import { state, status } from "../state";
import { store } from "../store";
import { initInput } from "../input";
import { installIkRenderHook } from "../tools/animation-tool";
import { updateMeasureOverlay } from "../tools/measure";
import { startAutoSave } from "../storage/autosave";
import { connectStore } from "./connect";

let booted = false;

/** The selected mesh's transform, to 3 decimals — the Transform fields' part of the fingerprint. */
function selectedTransform(): string {
  const m = state.selectedMeshes[state.selectedMeshes.length - 1];
  if (!m) return "";
  const r = (v: { x: number; y: number; z: number }): string => `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
  return `${r(m.position)};${r(m.rotation)};${r(m.scaling)}`;
}

export function boot(): void {
  if (booted) return;
  booted = true;
  initViewport();
  installIkRenderHook(state.scene);
  initInput();
  connectStore(store, state, state.scene, selectedTransform);
  // For browser checks (Playwright) in development only.
  if (import.meta.env.DEV) (window as unknown as { __forge: unknown }).__forge = state;

  state.engine.runRenderLoop(() => {
    state.scene.render();
    updateOrthoFrustum();
    updateMeasureOverlay();
  });

  window.addEventListener("beforeunload", (e) => {
    if (state.allMeshes.length > 0) e.preventDefault();
  });
  window.addEventListener("offline", () => status("⚠ Offline mode"));
  window.addEventListener("online", () => status("Back online"));
  startAutoSave();
  status("Ready — プリミティブを追加して開始");
}

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
import { initPrefs } from "../prefs";
import { connectStore } from "./connect";
import { initNavGizmo } from "../viewport/nav-gizmo";
import { getEditGizmoMode } from "../tools/edit-mode";

let booted = false;

/**
 * The screen's own part of the per-frame fingerprint: the selected mesh's
 * transform to 3 decimals (the Transform fields follow a gizmo drag), and in
 * Edit Mode the component mode, the selection size and the gizmo mode — keys
 * (1 / 2 / 3, G / R / S) change those without pushing history — and the
 * selected bone, clip, frame and playback, which a click in the viewport or
 * the player changes the same way.
 */
function screenFingerprint(): string {
  const m = state.selectedMeshes[state.selectedMeshes.length - 1];
  const r = (v: { x: number; y: number; z: number }): string => `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
  const xf = m ? `${r(m.position)};${r(m.rotation)};${r(m.scaling)}` : "";
  const edit = state.editMesh ? `${state.editSelection.mode}:${state.editSelection.indices.size}:${getEditGizmoMode()}` : "";
  const rig = `${state.selectedBoneId ?? ""}:${state.activeClipId ?? ""}:${state.currentFrame}:${state.isPlaying ? "P" : ""}`;
  return xf + "|" + edit + "|" + rig;
}

export function boot(): void {
  if (booted) return;
  booted = true;
  initViewport();
  installIkRenderHook(state.scene);
  initNavGizmo(); // the clickable axis widget in the view's corner
  initInput();
  connectStore(store, state, state.scene, screenFingerprint);
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
  initPrefs(); // tool settings, shading and environment from the last session
  startAutoSave();
  status("Ready — プリミティブを追加して開始");
}

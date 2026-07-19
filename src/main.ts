import "./styles.css";
import "./shaders"; // Register all Babylon.js shaders in ShaderStore before rendering
import { initViewport } from "./viewport/viewport";
import { state, E, status } from "./state";
import { initInput } from "./input";
import { buildToolPills, buildPrimitiveGrid, buildCSGButtons, buildTabs, buildBrushButtons, buildMeshToolButtons, buildMobileBar, buildGizmoFAB, buildEditToolsPanel } from "./ui/builders";
import { bindActionButtons, bindHelp } from "./ui/bindings";
import { registerCacheTransformCallback, updateLayerUI } from "./ui/panels";
import { requestPersistentStorage } from "./storage/metadata-store";
import { startAutoSave, loadCheckpoint, clearCheckpoint } from "./storage/autosave";
import { Tools } from "@babylonjs/core/Misc/tools";
import "@babylonjs/core/Materials/Textures/Loaders/ktxTextureLoader";
import { updateOrthoFrustum } from "./viewport/camera-presets";
import { updateMeasureOverlay } from "./tools/measure";
import { installIkRenderHook } from "./tools/animation-tool";
import { initGraphEditor, drawGraphEditor } from "./tools/graph-editor";
import { initDopesheet, drawDopesheet } from "./tools/dopesheet";
import { initPrefs } from "./prefs";
import { initNavGizmo } from "./viewport/nav-gizmo";

// ── Init ──
initViewport();
installIkRenderHook(state.scene); // FABRIK solver runs each frame on enabled bones
initInput();

// ── Build UI ──
buildToolPills();
buildPrimitiveGrid();
buildCSGButtons();
buildTabs();
buildBrushButtons();
buildMeshToolButtons();
buildEditToolsPanel();
buildMobileBar();
buildGizmoFAB();
bindActionButtons();
bindHelp();
updateLayerUI();
initGraphEditor();
drawGraphEditor();
initDopesheet();
drawDopesheet();
initPrefs();     // restore saved tool/viewport settings (needs UI + scene)
initNavGizmo();  // clickable axis orientation widget (top-right of viewport)

// ── Render Loop ──
let _statsFrame = 0;
let _cachedTransformInputs: HTMLInputElement[] = [];
registerCacheTransformCallback((inputs) => { _cachedTransformInputs = inputs; });

// Cache DOM refs outside render loop
const _fpsEl = E("fpsT");
const _vrtEl = E("vrtT");
const _triEl = E("triT");

state.engine.runRenderLoop(() => {
  state.scene.render();
  updateOrthoFrustum();
  updateMeasureOverlay();
  ++_statsFrame;

  // FPS: update every 10 frames
  if (_statsFrame % 10 === 0) {
    _fpsEl.textContent = state.engine.getFps().toFixed(0) + " FPS";
  }

  // Vertex/triangle counts: update every 60 frames (~1s at 60fps)
  if (_statsFrame % 60 === 0) {
    let tv = 0;
    let tt = 0;
    for (const m of state.allMeshes) {
      try {
        const p = m.getVerticesData("position");
        const idx = m.getIndices();
        if (p) tv += p.length / 3;
        if (idx) tt += idx.length / 3;
      } catch { /* disposed mesh — skip */ }
    }
    _vrtEl.textContent = tv.toLocaleString() + " v";
    _triEl.textContent = tt.toLocaleString() + " t";
  }

  // Live transform update using cached inputs
  if (
    state.selectedMeshes.length &&
    (state.tool === "move" || state.tool === "rotate" || state.tool === "scale")
  ) {
    const m = state.selectedMeshes[state.selectedMeshes.length - 1]!;
    for (const inp of _cachedTransformInputs) {
      if (inp === document.activeElement) continue;
      const [g, a] = inp.dataset.b!.split("_") as [string, "x" | "y" | "z"];
      if (g === "pos") inp.value = m.position[a].toFixed(3);
      else if (g === "rot") inp.value = Tools.ToDegrees(m.rotation[a]).toFixed(3);
      else if (g === "scl") inp.value = m.scaling[a].toFixed(3);
    }
  }
});

// ── Reset brush state when app goes to background ──
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    const wasBrushing = state.sculpting || state.painting || state.weightPainting;
    state.sculpting = false;
    state.painting = false;
    state.weightPainting = false;
    if (wasBrushing && !state.cameraLocked) state.camera.attachControl(state.canvas, true);
    // Reset touch modifiers
    state.touchModifiers.ctrl = false;
    state.touchModifiers.shift = false;
    document.querySelectorAll<HTMLElement>(".touch-mod").forEach((b) => b.classList.remove("on"));
  }
});

// ── Request persistent storage (after first interaction) ──
document.addEventListener(
  "click",
  () => {
    void requestPersistentStorage();
  },
  { once: true }
);

// ── Offline detection ──
window.addEventListener("offline", () => status("\u26a0 Offline mode"));
window.addEventListener("online", () => status("Back online"));

// ── Warn before leaving with unsaved work ──
window.addEventListener("beforeunload", (e) => {
  if (state.allMeshes.length > 0) {
    e.preventDefault();
  }
});

// ── Auto-save ──
startAutoSave();

// ── Check for recovery checkpoint on startup ──
void (async () => {
  try {
    const cp = await loadCheckpoint();
    if (!cp) return;
    const age = Date.now() - cp.timestamp;
    if (age > 24 * 60 * 60 * 1000) {
      // Older than 24h — discard
      await clearCheckpoint();
      return;
    }
    const mins = Math.round(age / 60000);
    const label = mins < 1 ? "just now" : mins + " min ago";
    if (confirm("Recover unsaved work from " + label + "?")) {
      status("Recovering...");
      const file = new File([cp.data], "recovery.glb", { type: "model/gltf-binary" });
      const { loadFileDirectly } = await import("./export/gltf-exporter");
      await loadFileDirectly(file);
      status("Session recovered");
    }
    await clearCheckpoint();
  } catch (e) {
    console.warn("Recovery check failed:", e);
  }
})();

status("Ready — プリミティブを追加して開始");

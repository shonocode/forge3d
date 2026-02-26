import "./styles.css";
import "./shaders"; // Register all Babylon.js shaders in ShaderStore before rendering
import { initViewport } from "./viewport/viewport";
import { state, E, status } from "./state";
import { initInput } from "./input";
import { buildToolPills, buildPrimitiveGrid, buildCSGButtons, buildTabs, buildBrushButtons, buildMeshToolButtons, buildMobileBar } from "./ui/builders";
import { bindActionButtons, bindHelp } from "./ui/bindings";
import { registerCacheTransformCallback, updateLayerUI } from "./ui/panels";
import { requestPersistentStorage } from "./storage/metadata-store";
import { Tools } from "@babylonjs/core/Misc/tools";
import "@babylonjs/core/Materials/Textures/Loaders/ktxTextureLoader";
import { updateOrthoFrustum } from "./viewport/camera-presets";
import { updateMeasureOverlay } from "./tools/measure";

// ── Init ──
initViewport();
initInput();

// ── Build UI ──
buildToolPills();
buildPrimitiveGrid();
buildCSGButtons();
buildTabs();
buildBrushButtons();
buildMeshToolButtons();
buildMobileBar();
bindActionButtons();
bindHelp();
updateLayerUI();

// ── Render Loop ──
let _statsFrame = 0;
let _cachedTransformInputs: HTMLInputElement[] = [];
registerCacheTransformCallback((inputs) => { _cachedTransformInputs = inputs; });

state.engine.runRenderLoop(() => {
  state.scene.render();
  updateOrthoFrustum();
  updateMeasureOverlay();
  E("fpsT").textContent = state.engine.getFps().toFixed(0) + " FPS";

  // Update vertex/triangle counts every 30 frames instead of every frame
  if (++_statsFrame % 30 === 0) {
    let tv = 0;
    let tt = 0;
    for (const m of state.allMeshes) {
      const p = m.getVerticesData("position");
      const idx = m.getIndices();
      if (p) tv += p.length / 3;
      if (idx) tt += idx.length / 3;
    }
    E("vrtT").textContent = tv.toLocaleString() + " v";
    E("triT").textContent = tt.toLocaleString() + " t";
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
    if (wasBrushing) state.camera.attachControl(state.canvas, true);
  }
});

// ── Request persistent storage (after first interaction) ──
document.addEventListener(
  "click",
  () => {
    requestPersistentStorage().then((granted) => {
      if (granted) console.log("Persistent storage granted");
    });
  },
  { once: true }
);

status("Ready — プリミティブを追加して開始");

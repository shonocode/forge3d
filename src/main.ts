import "./styles.css";
import { initViewport } from "./viewport/viewport";
import { state, E, status } from "./state";
import { initInput } from "./input";
import { buildToolPills, buildPrimitiveGrid, buildCSGButtons, buildTabs, buildBrushButtons, buildMobileBar } from "./ui/builders";
import { bindActionButtons, bindHelp } from "./ui/bindings";
import { requestPersistentStorage } from "./storage/metadata-store";
import { Tools } from "@babylonjs/core/Misc/tools";

// ── Init ──
initViewport();
initInput();

// ── Build UI ──
buildToolPills();
buildPrimitiveGrid();
buildCSGButtons();
buildTabs();
buildBrushButtons();
buildMobileBar();
bindActionButtons();
bindHelp();

// ── Render Loop ──
state.engine.runRenderLoop(() => {
  state.scene.render();
  E("fpsT").textContent = state.engine.getFps().toFixed(0) + " FPS";

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

  // Live transform update
  if (
    state.selectedMeshes.length &&
    (state.tool === "move" || state.tool === "rotate" || state.tool === "scale")
  ) {
    const m = state.selectedMeshes[state.selectedMeshes.length - 1]!;
    document.querySelectorAll<HTMLInputElement>("#xfC .pi").forEach((inp) => {
      if (inp === document.activeElement) return;
      const [g, a] = inp.dataset.b!.split("_") as [string, "x" | "y" | "z"];
      if (g === "pos") inp.value = m.position[a].toFixed(3);
      else if (g === "rot") inp.value = Tools.ToDegrees(m.rotation[a]).toFixed(3);
      else if (g === "scl") inp.value = m.scaling[a].toFixed(3);
    });
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

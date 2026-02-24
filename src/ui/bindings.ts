import { state, E, isMobile } from "../state";
import { addMorph, captureMorph } from "../tools/morph";
import { duplicateSelected, deleteSelected } from "../tools/actions";
import { clearPaintTexture } from "../tools/texture-paint";
import { createSkeleton, assignSkeletonToMesh, deleteBone } from "../tools/skeleton-tool";
import { initWeightData, showWeightOverlay, hideWeightOverlay, hasWeightData } from "../tools/weight-paint";
import {
  createClip, getActiveClip, deleteClip,
  captureKeyframe, captureAllKeyframes, deleteKeyframe,
  scrubToFrame, playPreview, stopPreview, exportClipAsJSON,
} from "../tools/animation-tool";
import {
  exportSceneLayout, importSceneLayout, clearAllMapInstances, loadModelLibrary,
} from "../tools/map-editor";
import { lastSelected } from "../tools/selection";
import { updateBoneUI, updateAnimUI, updateModelLibrary, updateMapInstances, updateWeightInfo, registerScrubCallback } from "./panels";
import { exportGLB, saveToLibrary, loadGLBFromFile } from "../export/gltf-exporter";

function bindSlider(inputId: string, displayId: string, setter: (v: number) => void, formatter?: (v: number) => string): void {
  E(inputId).addEventListener("input", function () {
    const v = +(this as HTMLInputElement).value;
    setter(v);
    E(displayId).textContent = formatter ? formatter(v) : String(v);
  });
}

export function bindActionButtons(): void {
  registerScrubCallback(scrubToFrame);

  E("btnExport").addEventListener("click", () => void exportGLB());
  E("btnSave").addEventListener("click", () => void saveToLibrary());
  E("btnLoad").addEventListener("click", () => void loadGLBFromFile());
  E("btnDup").addEventListener("click", duplicateSelected);
  E("btnDel").addEventListener("click", deleteSelected);
  E("btnAddMorph").addEventListener("click", addMorph);
  E("btnCapMorph").addEventListener("click", captureMorph);

  // Brush sliders
  bindSlider("brushSize", "bsV", (v) => { state.sculptConfig.radius = v; });
  bindSlider("brushStr", "btV", (v) => { state.sculptConfig.strength = v; });
  bindSlider("brushFall", "bfV", (v) => { state.sculptConfig.falloff = v; });

  // Paint controls
  E("paintColor").addEventListener("input", function () {
    state.paintConfig.color = (this as HTMLInputElement).value;
  });
  bindSlider("paintSize", "psV", (v) => { state.paintConfig.size = v; });
  bindSlider("paintOpacity", "poV", (v) => { state.paintConfig.opacity = v; }, (v) => v.toFixed(2));
  E("paintEraser").addEventListener("change", function () {
    state.paintConfig.eraser = (this as HTMLInputElement).checked;
  });
  E("btnClearPaint").addEventListener("click", () => {
    const m = lastSelected();
    if (m) clearPaintTexture(m);
  });

  // Bone controls
  E("btnNewSkel").addEventListener("click", () => {
    createSkeleton();
    updateBoneUI();
  });
  E("btnAssignSkel").addEventListener("click", () => {
    const m = lastSelected();
    if (m) assignSkeletonToMesh(m);
  });
  E("btnDelBone").addEventListener("click", () => {
    if (state.selectedBoneId) {
      deleteBone(state.selectedBoneId);
      updateBoneUI();
    }
  });

  // Weight paint controls
  bindSlider("weightRadius", "wrV", (v) => { state.weightConfig.radius = v; });
  bindSlider("weightStr", "wsV", (v) => { state.weightConfig.strength = v; });
  bindSlider("weightFall", "wfV", (v) => { state.weightConfig.falloff = v; });

  // Weight mode buttons
  const WEIGHT_MODES: { id: "add" | "subtract" | "smooth"; label: string }[] = [
    { id: "add", label: "+ Add" },
    { id: "subtract", label: "\u2212 Subtract" },
    { id: "smooth", label: "\u301c Smooth" },
  ];
  const wmEl = E("weightModeBtns");
  for (const wm of WEIGHT_MODES) {
    const b = document.createElement("button");
    b.className = "abtn wm" + (wm.id === "add" ? " on" : "");
    b.id = "wm_" + wm.id;
    b.textContent = wm.label;
    b.addEventListener("click", () => {
      state.weightConfig.mode = wm.id;
      document.querySelectorAll<HTMLElement>(".wm").forEach((e) =>
        e.classList.toggle("on", e.id === "wm_" + wm.id)
      );
    });
    wmEl.appendChild(b);
  }

  // Animation controls
  E("btnNewClip").addEventListener("click", () => {
    createClip();
    updateAnimUI();
  });
  E("btnDelClip").addEventListener("click", () => {
    const clip = getActiveClip();
    if (clip) {
      deleteClip(clip.id);
      updateAnimUI();
    }
  });
  E("animFrame").addEventListener("input", function () {
    const v = +(this as HTMLInputElement).value;
    scrubToFrame(v);
    E("afV").textContent = String(v);
    updateAnimUI();
  });
  E("animFps").addEventListener("input", function () {
    const v = +(this as HTMLInputElement).value;
    const clip = getActiveClip();
    if (clip) clip.frameRate = v;
    E("fpsV").textContent = String(v);
  });
  E("animMaxFrames").addEventListener("input", function () {
    const v = +(this as HTMLInputElement).value;
    const clip = getActiveClip();
    if (clip) clip.maxFrames = v;
    E("mfV").textContent = String(v);
    E("afMax").textContent = String(v);
    (E("animFrame") as HTMLInputElement).max = String(v);
  });
  E("animLoop").addEventListener("change", function () {
    const clip = getActiveClip();
    if (clip) clip.loopMode = (this as HTMLSelectElement).value as "cycle" | "constant";
  });
  E("btnRecordKF").addEventListener("click", () => {
    captureKeyframe();
    updateAnimUI();
  });
  E("btnRecordAll").addEventListener("click", () => {
    captureAllKeyframes();
    updateAnimUI();
  });
  E("btnDeleteKF").addEventListener("click", () => {
    deleteKeyframe();
    updateAnimUI();
  });
  E("btnPlayAnim").addEventListener("click", () => playPreview());
  E("btnStopAnim").addEventListener("click", () => {
    stopPreview();
    updateAnimUI();
  });
  E("btnExportAnim").addEventListener("click", () => exportClipAsJSON());

  // Map editor controls
  E("btnRefreshLib").addEventListener("click", () => {
    void loadModelLibrary().then((models) => updateModelLibrary(models));
  });
  E("btnExportLayout").addEventListener("click", () => {
    const name = (E("layoutName") as HTMLInputElement).value;
    exportSceneLayout(name);
  });
  E("btnImportLayout").addEventListener("click", () => {
    void importSceneLayout().then(() => updateMapInstances());
  });
  E("btnClearScene").addEventListener("click", () => {
    clearAllMapInstances();
    updateMapInstances();
  });

  E("btnInitWeight").addEventListener("click", () => {
    const m = lastSelected();
    if (m) {
      initWeightData(m);
      updateWeightInfo();
    }
  });

  E("btnToggleOverlay").addEventListener("click", () => {
    const m = lastSelected();
    if (!m) return;
    if (state.weightOverlayActive) {
      hideWeightOverlay(m);
    } else if (m.skeleton && hasWeightData(m)) {
      showWeightOverlay(m);
    }
  });

  // Mobile weight hint update
  if (isMobile()) {
    const wh = document.getElementById("weightHint");
    if (wh) wh.innerHTML = "Mode ボタンで Add / Subtract / Smooth 切替";
  }
}

export function bindHelp(): void {
  const overlay = E("helpOverlay");
  E("btnHelp").addEventListener("click", () => overlay.classList.add("open"));
  E("helpClose").addEventListener("click", () => overlay.classList.remove("open"));
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.classList.remove("open");
  });
}

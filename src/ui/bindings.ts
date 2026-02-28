import { state, E, isMobile, status } from "../state";
import { addMorph, captureMorph } from "../tools/morph";
import { duplicateSelected, deleteSelected } from "../tools/actions";
import { clearPaintTexture } from "../tools/texture-paint";
import { createSkeleton, assignSkeletonToMesh, deleteBone } from "../tools/skeleton-tool";
import { initWeightData, showWeightOverlay, hideWeightOverlay, hasWeightData } from "../tools/weight-paint";
import {
  createClip, getActiveClip, deleteClip,
  captureKeyframe, captureAllKeyframes, deleteKeyframe,
  scrubToFrame, playPreview, stopPreview, exportClipAsJSON,
  copyKeyframe, pasteKeyframe, setKeyframeEasing,
} from "../tools/animation-tool";
import { EASING_TYPES } from "../tools/easing";
import type { EasingType } from "../tools/easing";
import { findBoneById } from "../tools/skeleton-tool";
import {
  exportSceneLayout, importSceneLayout, clearAllMapInstances, loadModelLibrary,
} from "../tools/map-editor";
import { lastSelected } from "../tools/selection";
import { addModifier } from "../tools/modifiers";
import { createLayer } from "../tools/layers";
import { addLight } from "../tools/lighting";
import { toggleMeasureMode, clearMeasurements } from "../tools/measure";
import { updateBoneUI, updateAnimUI, updateModelLibrary, updateMapInstances, updateWeightInfo, updateModifierUI, updateLayerUI, updateLightUI, registerScrubCallback } from "./panels";
import { setEnvironmentPreset, loadCustomHDRI, setEnvironmentIntensity, toggleSkybox } from "../viewport/environment";
import { setShadowEnabled, setShadowQuality } from "../viewport/shadows";
import {
  setBloomEnabled, setBloomIntensity, setFxaaEnabled,
  setChromaticEnabled, setChromaticIntensity,
  setVignetteEnabled, setVignetteWeight,
  setSsaoEnabled, setSsaoIntensity,
} from "../viewport/postprocess";
import { setViewportMode } from "../viewport/shading";
import { applyCameraPreset, toggleOrthographic, PRESETS } from "../viewport/camera-presets";
import { applySnapToGizmos } from "../tools/snap";
import { setParent, clearParent } from "../tools/parenting";
import { updateHierarchy } from "./panels";
import type { ViewportMode } from "../state";

function bindSlider(inputId: string, displayId: string, setter: (v: number) => void, formatter?: (v: number) => string): void {
  E(inputId).addEventListener("input", function () {
    const v = +(this as HTMLInputElement).value;
    setter(v);
    E(displayId).textContent = formatter ? formatter(v) : String(v);
  });
}

export function bindActionButtons(): void {
  registerScrubCallback(scrubToFrame);

  // Undo/Redo buttons
  const undoBtn = E("btnUndo") as HTMLButtonElement;
  const redoBtn = E("btnRedo") as HTMLButtonElement;
  undoBtn.addEventListener("click", () => state.history.undo());
  redoBtn.addEventListener("click", () => state.history.redo());
  state.history.setOnChange(() => {
    undoBtn.disabled = !state.history.canUndo();
    redoBtn.disabled = !state.history.canRedo();
    const uc = state.history.undoCount();
    const rc = state.history.redoCount();
    undoBtn.title = uc ? `Undo (${uc})` : "Undo";
    redoBtn.title = rc ? `Redo (${rc})` : "Redo";
  });

  E("btnExportGLB").addEventListener("click", async () => {
    const { exportGLB } = await import("../export/gltf-exporter");
    void exportGLB();
  });
  E("btnExportOBJ").addEventListener("click", async () => {
    const { exportOBJ } = await import("../export/gltf-exporter");
    exportOBJ();
  });
  E("btnExportSTL").addEventListener("click", async () => {
    const { exportSTL } = await import("../export/gltf-exporter");
    exportSTL();
  });
  E("btnSave").addEventListener("click", async () => {
    const { saveToLibrary } = await import("../export/gltf-exporter");
    void saveToLibrary();
  });
  E("btnLoad").addEventListener("click", async () => {
    const { loadModelFromFile } = await import("../export/gltf-exporter");
    void loadModelFromFile();
  });
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

  // Keyframe Edit controls
  const easingSel = E("kfEasing") as HTMLSelectElement;
  for (const et of EASING_TYPES) {
    const opt = document.createElement("option");
    opt.value = et;
    opt.textContent = et;
    easingSel.appendChild(opt);
  }
  easingSel.addEventListener("change", function () {
    setKeyframeEasing(this.value as EasingType);
    updateAnimUI();
  });
  E("btnCopyKF").addEventListener("click", () => { copyKeyframe(); });
  E("btnPasteKF").addEventListener("click", () => { pasteKeyframe(); updateAnimUI(); });

  // IK controls
  E("ikEnabled").addEventListener("change", function () {
    if (!state.selectedBoneId) return;
    const bd = findBoneById(state.selectedBoneId);
    if (!bd) return;
    const on = (this as HTMLInputElement).checked;
    if (on) {
      bd.ikConstraint = { enabled: true, chainLength: +(E("ikChainLen") as HTMLInputElement).value, targetX: 0, targetY: 0, targetZ: 0 };
    } else {
      bd.ikConstraint = undefined;
    }
  });
  E("ikChainLen").addEventListener("input", function () {
    const v = +(this as HTMLInputElement).value;
    E("ikChainV").textContent = String(v);
    if (!state.selectedBoneId) return;
    const bd = findBoneById(state.selectedBoneId);
    if (bd?.ikConstraint) bd.ikConstraint.chainLength = v;
  });

  // Map editor controls
  E("btnRefreshLib").addEventListener("click", () => {
    void loadModelLibrary().then((models) => updateModelLibrary(models));
  });
  E("btnExportLayout").addEventListener("click", () => {
    const name = (E("layoutName") as HTMLInputElement).value;
    exportSceneLayout(name);
  });
  E("btnImportLayout").addEventListener("click", () => {
    importSceneLayout();
  });
  E("btnClearScene").addEventListener("click", () => {
    clearAllMapInstances();
    updateMapInstances();
  });

  // Modifier buttons
  E("btnAddSubdiv").addEventListener("click", () => {
    const m = lastSelected();
    if (m) { addModifier(m, "subdivision"); updateModifierUI(); }
  });
  E("btnAddMirror").addEventListener("click", () => {
    const m = lastSelected();
    if (m) { addModifier(m, "mirror"); updateModifierUI(); }
  });
  E("btnAddArray").addEventListener("click", () => {
    const m = lastSelected();
    if (m) { addModifier(m, "array"); updateModifierUI(); }
  });

  // Snap controls — restore from localStorage
  const savedSnap = localStorage.getItem("forge3d_snap");
  if (savedSnap) {
    try { Object.assign(state.snapConfig, JSON.parse(savedSnap)); } catch { /* ignore */ }
    (E("snapPos") as HTMLInputElement).checked = state.snapConfig.positionEnabled;
    (E("snapPosVal") as HTMLInputElement).value = String(state.snapConfig.positionIncrement);
    (E("snapRot") as HTMLInputElement).checked = state.snapConfig.rotationEnabled;
    (E("snapRotVal") as HTMLInputElement).value = String(state.snapConfig.rotationIncrement);
    (E("snapScl") as HTMLInputElement).checked = state.snapConfig.scaleEnabled;
    (E("snapSclVal") as HTMLInputElement).value = String(state.snapConfig.scaleIncrement);
    applySnapToGizmos();
  }
  const saveSnap = () => localStorage.setItem("forge3d_snap", JSON.stringify(state.snapConfig));
  E("snapPos").addEventListener("change", function () {
    state.snapConfig.positionEnabled = (this as HTMLInputElement).checked;
    applySnapToGizmos(); saveSnap();
  });
  E("snapPosVal").addEventListener("change", function () {
    state.snapConfig.positionIncrement = Math.max(0.01, +(this as HTMLInputElement).value || 0.5);
    applySnapToGizmos(); saveSnap();
  });
  E("snapRot").addEventListener("change", function () {
    state.snapConfig.rotationEnabled = (this as HTMLInputElement).checked;
    applySnapToGizmos(); saveSnap();
  });
  E("snapRotVal").addEventListener("change", function () {
    state.snapConfig.rotationIncrement = Math.max(1, +(this as HTMLInputElement).value || 15);
    applySnapToGizmos(); saveSnap();
  });
  E("snapScl").addEventListener("change", function () {
    state.snapConfig.scaleEnabled = (this as HTMLInputElement).checked;
    applySnapToGizmos(); saveSnap();
  });
  E("snapSclVal").addEventListener("change", function () {
    state.snapConfig.scaleIncrement = Math.max(0.01, +(this as HTMLInputElement).value || 0.25);
    applySnapToGizmos(); saveSnap();
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

  // Scene / Environment controls
  E("envPreset").addEventListener("change", function () {
    setEnvironmentPreset((this as HTMLSelectElement).value);
  });
  E("btnLoadHDRI").addEventListener("click", () => loadCustomHDRI());
  E("envIntensity").addEventListener("input", function () {
    const v = +(this as HTMLInputElement).value;
    setEnvironmentIntensity(v);
    E("envIntV").textContent = v.toFixed(2);
  });
  E("envSkybox").addEventListener("change", function () {
    toggleSkybox((this as HTMLInputElement).checked);
  });

  // Measure controls
  E("btnMeasure").addEventListener("click", toggleMeasureMode);
  E("btnClearMeasure").addEventListener("click", clearMeasurements);

  // Light controls
  E("btnAddPoint").addEventListener("click", () => { addLight("point"); updateLightUI(); });
  E("btnAddSpot").addEventListener("click", () => { addLight("spot"); updateLightUI(); });

  // Shadow controls
  E("shadowEnabled").addEventListener("change", function () {
    setShadowEnabled((this as HTMLInputElement).checked);
  });
  E("shadowQuality").addEventListener("change", function () {
    setShadowQuality(+(this as HTMLSelectElement).value as 512 | 1024 | 2048);
  });

  // Post-processing controls
  E("ppFxaa").addEventListener("change", function () { setFxaaEnabled((this as HTMLInputElement).checked); });
  E("ppBloom").addEventListener("change", function () {
    const on = (this as HTMLInputElement).checked;
    setBloomEnabled(on);
    E("ppBloomIntRow").style.display = on ? "" : "none";
  });
  bindSlider("ppBloomInt", "ppBloomV", (v) => setBloomIntensity(v), (v) => v.toFixed(2));
  E("ppSsao").addEventListener("change", function () {
    const on = (this as HTMLInputElement).checked;
    setSsaoEnabled(on);
    E("ppSsaoIntRow").style.display = on ? "" : "none";
  });
  bindSlider("ppSsaoInt", "ppSsaoV", (v) => setSsaoIntensity(v), (v) => v.toFixed(2));
  E("ppChromatic").addEventListener("change", function () {
    const on = (this as HTMLInputElement).checked;
    setChromaticEnabled(on);
    E("ppChromIntRow").style.display = on ? "" : "none";
  });
  bindSlider("ppChromInt", "ppChromV", (v) => setChromaticIntensity(v), (v) => v.toFixed(2));
  E("ppVignette").addEventListener("change", function () {
    const on = (this as HTMLInputElement).checked;
    setVignetteEnabled(on);
    E("ppVigWeightRow").style.display = on ? "" : "none";
  });
  bindSlider("ppVigWeight", "ppVigV", (v) => setVignetteWeight(v), (v) => v.toFixed(2));

  // Viewport shading mode
  document.querySelectorAll<HTMLElement>(".shade-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode as ViewportMode;
      setViewportMode(mode);
      document.querySelectorAll<HTMLElement>(".shade-btn").forEach((b) =>
        b.classList.toggle("on", b.dataset.mode === mode)
      );
    });
  });

  // Camera presets
  document.querySelectorAll<HTMLElement>(".cam-btn[data-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const preset = PRESETS[btn.dataset.preset!];
      if (preset) applyCameraPreset(preset);
    });
  });
  E("btnOrtho").addEventListener("click", toggleOrthographic);

  // Parenting controls
  E("btnSetParent").addEventListener("click", () => {
    if (state.selectedMeshes.length < 2) {
      status("2つのメッシュを選択（Ctrl+click）");
      return;
    }
    const child = lastSelected()!;
    const parent = state.selectedMeshes.find((m) => m !== child)!;
    const prevParent = child.parent as import("@babylonjs/core").AbstractMesh | null;
    setParent(child, parent);
    updateHierarchy();
    state.history.push({
      label: "Set Parent",
      undo() { if (prevParent) setParent(child, prevParent); else clearParent(child); updateHierarchy(); },
      redo() { setParent(child, parent); updateHierarchy(); },
    });
  });
  E("btnClearParent").addEventListener("click", () => {
    const m = lastSelected();
    if (!m || !m.parent) return;
    const prevParent = m.parent as import("@babylonjs/core").AbstractMesh;
    clearParent(m);
    updateHierarchy();
    state.history.push({
      label: "Clear Parent",
      undo() { setParent(m, prevParent); updateHierarchy(); },
      redo() { clearParent(m); updateHierarchy(); },
    });
  });

  // Layer controls
  E("btnNewLayer").addEventListener("click", () => {
    createLayer();
    updateLayerUI();
  });

  // Mobile weight hint update
  if (isMobile()) {
    const wh = document.getElementById("weightHint");
    if (wh) wh.innerHTML = "Mode ボタンで Add / Subtract / Smooth 切替";
  }
}

export function bindHelp(): void {
  const overlay = E("helpOverlay");
  const closeBtn = E("helpClose");
  let previousFocus: HTMLElement | null = null;

  function openHelp(): void {
    previousFocus = document.activeElement as HTMLElement | null;
    overlay.classList.add("open");
    closeBtn.focus();
  }
  function closeHelp(): void {
    overlay.classList.remove("open");
    previousFocus?.focus();
    previousFocus = null;
  }

  E("btnHelp").addEventListener("click", openHelp);
  closeBtn.addEventListener("click", closeHelp);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeHelp();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.classList.contains("open")) closeHelp();
  });

  // Focus trap: keep Tab cycling within the modal
  overlay.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const focusable = overlay.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    }
  });

  // Category tab navigation
  document.querySelectorAll<HTMLElement>(".help-cat").forEach(btn => {
    btn.addEventListener("click", () => {
      const target = document.getElementById("hcat-" + btn.dataset.cat);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      document.querySelectorAll<HTMLElement>(".help-cat").forEach(b =>
        b.classList.toggle("on", b === btn));
    });
  });

  // Collapsible section toggle
  document.querySelectorAll<HTMLElement>(".help-t").forEach(title => {
    title.addEventListener("click", () => {
      const body = title.nextElementSibling as HTMLElement;
      if (body?.classList.contains("help-sec-body")) {
        body.classList.toggle("hidden");
        title.classList.toggle("collapsed");
      }
    });
  });
}

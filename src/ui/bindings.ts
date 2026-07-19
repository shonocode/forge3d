import { state, E, isMobile, status } from "../state";
import { addMorph, captureMorph } from "../tools/morph";
import { duplicateSelected, deleteSelected } from "../tools/actions";
import { clearPaintTexture } from "../tools/texture-paint";
import { clearSculptMask } from "../tools/sculpt";
import { createSkeleton, assignSkeletonToMesh, deleteBone, solveIKForBone, mirrorBoneChain, getIKPoleSuggestion } from "../tools/skeleton-tool";
import { initWeightData, showWeightOverlay, hideWeightOverlay, hasWeightData, refreshWeightOverlay } from "../tools/weight-paint";
import { applyAutoWeights } from "../tools/auto-weights";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import {
  createClip, getActiveClip, deleteClip, setActiveClip,
  captureKeyframe, captureAllKeyframes, deleteKeyframe,
  captureMorphKeyframes, deleteMorphKeys,
  scrubToFrame, playPreview, stopPreview, exportClipAsJSON,
  copyKeyframe, pasteKeyframe, setKeyframeEasing,
  setPlaybackTickCallback, updateIkTargetMarker, notifyPoseEdited,
} from "../tools/animation-tool";
import { EASING_TYPES } from "../tools/easing";
import type { EasingType } from "../tools/easing";
import { findBoneById, selectBone as selectBoneFn, setPoseEditedHandler } from "../tools/skeleton-tool";
import { drawGraphEditor } from "../tools/graph-editor";
import { drawDopesheet } from "../tools/dopesheet";
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

/** Sync the timeline sliders / loop select to the active clip (clip switch, create, delete). */
function syncClipControls(): void {
  const clip = getActiveClip();
  if (!clip) return;
  (E("animFps") as HTMLInputElement).value = String(clip.frameRate);
  E("fpsV").textContent = String(clip.frameRate);
  (E("animMaxFrames") as HTMLInputElement).value = String(clip.maxFrames);
  E("mfV").textContent = String(clip.maxFrames);
  E("afMax").textContent = String(clip.maxFrames);
  const frameEl = E("animFrame") as HTMLInputElement;
  frameEl.max = String(clip.maxFrames);
  frameEl.value = String(state.currentFrame);
  E("afV").textContent = String(state.currentFrame);
  (E("animLoop") as HTMLSelectElement).value = clip.loopMode;
}

export function bindActionButtons(): void {
  registerScrubCallback(scrubToFrame);

  // Sync timeline slider + label as playback advances frames.
  setPlaybackTickCallback((frame) => {
    const f = Math.floor(frame);
    const slider = E("animFrame") as HTMLInputElement;
    slider.value = String(f);
    E("afV").textContent = String(f);
    state.currentFrame = f;
    // Move the yellow playhead in both timeline views each tick.
    // Both renderers are cheap — see their top-of-file notes for why
    // this is safe per-frame.
    drawGraphEditor();
    drawDopesheet();
  });

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
  E("btnSave").addEventListener("click", async () => {
    const { saveToLibrary } = await import("../export/gltf-exporter");
    void saveToLibrary();
  });
  E("btnLoad").addEventListener("click", async () => {
    const { loadModelFromFile } = await import("../export/gltf-exporter");
    void loadModelFromFile();
  });
  E("btnExportProj").addEventListener("click", async () => {
    const { exportProject } = await import("../export/project-io");
    void exportProject();
  });
  E("btnOpenProj").addEventListener("click", async () => {
    const { openProjectDialog } = await import("../export/project-io");
    openProjectDialog();
  });
  E("btnDup").addEventListener("click", duplicateSelected);
  E("btnDel").addEventListener("click", deleteSelected);
  E("btnAddMorph").addEventListener("click", addMorph);
  E("btnCapMorph").addEventListener("click", captureMorph);

  // Brush sliders
  bindSlider("brushSize", "bsV", (v) => { state.sculptConfig.radius = v; });
  bindSlider("brushStr", "btV", (v) => { state.sculptConfig.strength = v; });
  bindSlider("brushFall", "bfV", (v) => { state.sculptConfig.falloff = v; });

  // Sculpt symmetry / dyntopo / mask
  E("symX").addEventListener("change", function () { state.sculptConfig.symX = (this as HTMLInputElement).checked; });
  E("symY").addEventListener("change", function () { state.sculptConfig.symY = (this as HTMLInputElement).checked; });
  E("symZ").addEventListener("change", function () { state.sculptConfig.symZ = (this as HTMLInputElement).checked; });
  E("dyntopo").addEventListener("change", function () { state.sculptConfig.dyntopo = (this as HTMLInputElement).checked; });
  bindSlider("dyntopoDetail", "dtV", (v) => { state.sculptConfig.detail = v; }, (v) => v.toFixed(2));
  E("btnClearMask").addEventListener("click", () => {
    const m = lastSelected();
    if (m) clearSculptMask(m);
  });

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
  E("btnMirrorBone").addEventListener("click", () => {
    if (!state.selectedBoneId) {
      status("⚠ Select the bone to mirror first");
      return;
    }
    mirrorBoneChain(state.selectedBoneId, "x");
    updateBoneUI();
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
  // Auto-Key / dirty-pose hook (registered here to avoid an import cycle
  // between skeleton-tool and animation-tool).
  setPoseEditedHandler(notifyPoseEdited);
  E("autoKey").addEventListener("change", function () {
    state.autoKey = (this as HTMLInputElement).checked;
    status("Auto-Key: " + (state.autoKey ? "ON" : "OFF"));
  });
  E("animClipSel").addEventListener("change", function () {
    setActiveClip((this as HTMLSelectElement).value);
    syncClipControls();
    updateAnimUI();
  });
  E("btnNewClip").addEventListener("click", () => {
    createClip();
    syncClipControls();
    updateAnimUI();
  });
  E("btnDelClip").addEventListener("click", () => {
    const clip = getActiveClip();
    if (clip) {
      deleteClip(clip.id);
      syncClipControls();
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
  E("btnRecordMorphs").addEventListener("click", () => {
    captureMorphKeyframes();
    updateAnimUI();
  });
  E("btnDeleteKF").addEventListener("click", () => {
    deleteKeyframe();
    updateAnimUI();
  });
  E("btnDeleteMorphKF").addEventListener("click", () => {
    deleteMorphKeys();
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

  // Bone Edit / Pose mode toggle. Switching modes detaches the current
  // gizmo and re-attaches with the new gizmo flavor by re-running
  // selectBone() on the active selection (if any). Without the
  // re-select, the gizmo would stay frozen on the previous mode until
  // the user clicked another bone.
  const setBoneMode = (mode: "edit" | "pose"): void => {
    state.boneEditMode = mode;
    E("btnBoneModeEdit").classList.toggle("on", mode === "edit");
    E("btnBoneModePose").classList.toggle("on", mode === "pose");
    if (state.selectedBoneId) {
      // Re-select to swap gizmo type. selectBone() handles cleanup of the
      // previous mode's drag observer internally.
      selectBoneFn(state.selectedBoneId);
    }
    status(mode === "pose" ? "Bone: Pose Mode (rotate)" : "Bone: Edit Mode (position)");
  };
  E("btnBoneModeEdit").addEventListener("click", () => setBoneMode("edit"));
  E("btnBoneModePose").addEventListener("click", () => setBoneMode("pose"));

  // Bone display controls — size slider + X-ray toggle.
  // Async import keeps the bone-tool dependency outside the bindings critical
  // path; the controls aren't wired until first use anyway.
  const boneSize = E("boneSize") as HTMLInputElement;
  const boneSizeV = E("boneSizeV");
  const boneXray = E("boneXray") as HTMLInputElement;
  boneSize.value = String(state.boneDisplay.size);
  boneSizeV.textContent = state.boneDisplay.size.toFixed(2);
  boneXray.checked = state.boneDisplay.xray;
  boneSize.addEventListener("input", () => {
    const v = parseFloat(boneSize.value);
    state.boneDisplay.size = v;
    boneSizeV.textContent = v.toFixed(2);
    void import("../tools/skeleton-tool").then((mod) => mod.applyBoneDisplayConfig());
  });
  boneXray.addEventListener("change", () => {
    state.boneDisplay.xray = boneXray.checked;
    void import("../tools/skeleton-tool").then((mod) => mod.applyBoneDisplayConfig());
  });

  // IK controls
  E("ikEnabled").addEventListener("change", function () {
    if (!state.selectedBoneId) return;
    const bd = findBoneById(state.selectedBoneId);
    if (!bd) return;
    const on = (this as HTMLInputElement).checked;
    if (on) {
      // Default target to the bone's current tip position so enabling
      // IK doesn't snap the chain to world origin (jarring + makes the
      // feature look broken). User can drag the target afterward.
      const p = bd.visual?.position;
      const tx = p?.x ?? 0, ty = p?.y ?? 0, tz = p?.z ?? 0;
      bd.ikConstraint = {
        enabled: true,
        chainLength: +(E("ikChainLen") as HTMLInputElement).value,
        targetX: tx, targetY: ty, targetZ: tz,
      };
      (E("ikTargetX") as HTMLInputElement).value = tx.toFixed(3);
      (E("ikTargetY") as HTMLInputElement).value = ty.toFixed(3);
      (E("ikTargetZ") as HTMLInputElement).value = tz.toFixed(3);
    } else {
      bd.ikConstraint = undefined;
    }
    updateIkTargetMarker();
  });
  E("ikChainLen").addEventListener("input", function () {
    const v = +(this as HTMLInputElement).value;
    E("ikChainV").textContent = String(v);
    if (!state.selectedBoneId) return;
    const bd = findBoneById(state.selectedBoneId);
    if (bd?.ikConstraint) bd.ikConstraint.chainLength = v;
  });

  // Target XYZ — typed numeric inputs. Each writes through to the
  // selected bone's ikConstraint and refreshes the IK target marker so
  // the user sees where the chain is being pulled.
  const wireIkTargetField = (id: "ikTargetX" | "ikTargetY" | "ikTargetZ", axis: "X" | "Y" | "Z"): void => {
    E(id).addEventListener("input", function () {
      const v = +(this as HTMLInputElement).value;
      if (Number.isNaN(v)) return;
      if (!state.selectedBoneId) return;
      const bd = findBoneById(state.selectedBoneId);
      if (!bd?.ikConstraint) return;
      bd.ikConstraint[`target${axis}` as "targetX" | "targetY" | "targetZ"] = v;
      updateIkTargetMarker();
    });
  };
  wireIkTargetField("ikTargetX", "X");
  wireIkTargetField("ikTargetY", "Y");
  wireIkTargetField("ikTargetZ", "Z");

  // Pole vector — steers which way the chain bends (elbow/knee direction).
  E("ikPoleEnabled").addEventListener("change", function () {
    if (!state.selectedBoneId) return;
    const bd = findBoneById(state.selectedBoneId);
    if (!bd?.ikConstraint) return;
    bd.ikConstraint.poleEnabled = (this as HTMLInputElement).checked;
  });
  const wireIkPoleField = (id: "ikPoleX" | "ikPoleY" | "ikPoleZ", axis: "X" | "Y" | "Z"): void => {
    E(id).addEventListener("input", function () {
      const v = +(this as HTMLInputElement).value;
      if (Number.isNaN(v)) return;
      if (!state.selectedBoneId) return;
      const bd = findBoneById(state.selectedBoneId);
      if (!bd?.ikConstraint) return;
      bd.ikConstraint[`pole${axis}` as "poleX" | "poleY" | "poleZ"] = v;
    });
  };
  wireIkPoleField("ikPoleX", "X");
  wireIkPoleField("ikPoleY", "Y");
  wireIkPoleField("ikPoleZ", "Z");

  // Max bend per joint (degrees; 0 = unconstrained).
  E("ikMaxBend").addEventListener("input", function () {
    const v = +(this as HTMLInputElement).value;
    if (Number.isNaN(v)) return;
    if (!state.selectedBoneId) return;
    const bd = findBoneById(state.selectedBoneId);
    if (!bd?.ikConstraint) return;
    bd.ikConstraint.maxBendDeg = Math.max(0, Math.min(180, v));
  });

  // "Snap to Bend" — drop the pole at the current mid-joint (pushed outward)
  // so enabling the pole preserves the present bend direction.
  E("btnIkSnapPole").addEventListener("click", () => {
    if (!state.selectedBoneId) return;
    const bd = findBoneById(state.selectedBoneId);
    if (!bd?.ikConstraint) {
      status("⚠ Enable IK and select a bone first");
      return;
    }
    const p = getIKPoleSuggestion(state.selectedBoneId);
    if (!p) return;
    bd.ikConstraint.poleEnabled = true;
    bd.ikConstraint.poleX = p.x;
    bd.ikConstraint.poleY = p.y;
    bd.ikConstraint.poleZ = p.z;
    (E("ikPoleEnabled") as HTMLInputElement).checked = true;
    (E("ikPoleX") as HTMLInputElement).value = p.x.toFixed(3);
    (E("ikPoleY") as HTMLInputElement).value = p.y.toFixed(3);
    (E("ikPoleZ") as HTMLInputElement).value = p.z.toFixed(3);
    status("IK pole snapped to bend");
  });

  // "Snap to Bone" — convenience: drop the IK target onto the currently
  // selected bone's tip so enabling IK doesn't yank the chain to the
  // origin. Without this the default (0,0,0) target makes IK feel
  // broken on first toggle.
  E("btnIkSnapTarget").addEventListener("click", () => {
    if (!state.selectedBoneId) return;
    const bd = findBoneById(state.selectedBoneId);
    if (!bd?.ikConstraint || !bd.visual) {
      status("⚠ Enable IK and select a bone first");
      return;
    }
    const p = bd.visual.position;
    bd.ikConstraint.targetX = p.x;
    bd.ikConstraint.targetY = p.y;
    bd.ikConstraint.targetZ = p.z;
    (E("ikTargetX") as HTMLInputElement).value = p.x.toFixed(3);
    (E("ikTargetY") as HTMLInputElement).value = p.y.toFixed(3);
    (E("ikTargetZ") as HTMLInputElement).value = p.z.toFixed(3);
    updateIkTargetMarker();
    status("IK target snapped to bone");
  });

  // "Solve IK Now" — one-shot, undo-able solve toward the selected bone's
  // target. Works whether or not the live per-frame constraint is enabled.
  E("btnSolveIK").addEventListener("click", () => {
    if (!state.selectedBoneId) {
      status("⚠ Select the chain's tip bone first");
      return;
    }
    const bd = findBoneById(state.selectedBoneId);
    const ik = bd?.ikConstraint;
    if (!ik) {
      status("⚠ Enable IK on this bone first");
      return;
    }
    solveIKForBone(state.selectedBoneId, new Vector3(ik.targetX, ik.targetY, ik.targetZ));
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

  E("btnAutoWeight").addEventListener("click", () => {
    const m = lastSelected();
    if (!m) {
      status("⚠ Select the skinned mesh first");
      return;
    }
    const geodesic = (E("autoWeightGeodesic") as HTMLInputElement).checked;
    applyAutoWeights(m, { geodesic });
    updateWeightInfo();
    if (state.weightOverlayActive) refreshWeightOverlay();
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

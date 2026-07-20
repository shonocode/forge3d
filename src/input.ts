import { state, E, status, isMobile } from "./state";
import type { ToolId } from "./state";
import { selectMesh, deselect, updateGizmo, lastSelected } from "./tools/selection";
import { sculptAt, captureGeometry, restoreGeometry, applySculptDelta } from "./tools/sculpt";
import type { GeoSnapshot } from "./tools/sculpt";
import { diffAttribute } from "./tools/sculpt-delta";
import { paintAt, hasUVs, beginPaintStroke, getStrokeTarget } from "./tools/texture-paint";
import { duplicateSelected, deleteSelected, cleanupMesh } from "./tools/actions";
import { updateHierarchy, updateProperties } from "./ui/panels";
import { handleBonePointerDown, isBoneVisual, setBoneVisualsVisible, areBoneVisualsVisible, deselectBone } from "./tools/skeleton-tool";
import { paintWeightAt, hasWeightData, showWeightOverlay, hideWeightOverlay } from "./tools/weight-paint";
import { stopPreview } from "./tools/animation-tool";
import { applyCameraPreset, toggleOrthographic, PRESETS } from "./viewport/camera-presets";
import { applySnapToGizmos } from "./tools/snap";
import { addMeasurePoint, clearMeasurements } from "./tools/measure";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { toggleEditMode, setComponentMode, selectAllComponents, clearComponentSelection, isEditMode, handleEditModePointerDown, startBoxSelect, extrudeSelection, deleteSelection, insetSelection, bevelSelection, loopCutSelection, knifeSelection, markSeamSelection, unwrapMesh, edgeSlideSelection, mergeSelection, bridgeSelection, setEditGizmoMode, vertexSlideSelection, startKnifeCut, trisToQuadsSelection, quadsToTrisSelection, subdivideSelection, markCreaseSelection } from "./tools/edit-mode";

const TOOL_TABS: Partial<Record<ToolId, string>> = {
  sculpt: "sculpt", paint: "paint", bone: "bone", weight: "weight", anim: "anim",
};
const BONE_TOOLS: ReadonlySet<ToolId> = new Set(["bone", "weight", "anim"]);

export function setTool(t: ToolId): void {
  const prev = state.tool;
  if (prev === t) return;

  cleanupTool(prev);
  state.tool = t;
  updateToolUI(t);
  initTool(t);
}

function cleanupTool(prev: ToolId): void {
  if (prev === "anim") stopPreview();
  if (prev === "weight" && state.weightOverlayActive) {
    const mesh = lastSelected();
    if (mesh) hideWeightOverlay(mesh);
  }
  // Reset touch modifiers
  state.touchModifiers.ctrl = false;
  state.touchModifiers.shift = false;
  document.querySelectorAll<HTMLElement>(".touch-mod").forEach((b) => b.classList.remove("on"));
}

function updateToolUI(t: ToolId): void {
  document.querySelectorAll<HTMLElement>(".pill").forEach((b) =>
    b.classList.toggle("on", b.dataset.tool === t)
  );
  document.querySelectorAll<HTMLElement>(".gfab-btn").forEach((b) =>
    b.classList.toggle("on", b.dataset.tool === t)
  );
  E("modeL").textContent =
    t === "sculpt" ? "SCULPT" : t === "paint" ? "PAINT" : t === "bone" ? "BONE" : t === "weight" ? "WEIGHT" : t === "anim" ? "ANIM" : "OBJECT";
  const tab = TOOL_TABS[t];
  if (tab) switchTab(tab);
}

function initTool(t: ToolId): void {
  updateGizmo();
  applySnapToGizmos();
  if (BONE_TOOLS.has(t)) {
    setBoneVisualsVisible(true);
  } else {
    setBoneVisualsVisible(false);
    deselectBone();
  }
  if (t === "weight") {
    const mesh = lastSelected();
    if (mesh?.skeleton && state.selectedBoneId) showWeightOverlay(mesh);
  }
  if (t === "paint") {
    const mesh = lastSelected();
    if (mesh && !mesh.isVerticesDataPresent(VertexBuffer.UVKind)) {
      status("⚠ UVがないメッシュはペイントできません");
    }
  }
}

export function switchTab(id: string): void {
  document.querySelectorAll<HTMLElement>(".tb").forEach((b) => {
    const isActive = b.dataset.tab === id;
    b.classList.toggle("on", isActive);
    b.setAttribute("aria-selected", isActive ? "true" : "false");
  });
  document.querySelectorAll<HTMLElement>(".tbody").forEach((b) =>
    b.classList.toggle("on", b.id === "tb-" + id)
  );
}

export function togglePanel(which: "lp" | "rp"): void {
  const lp = E("lpanel");
  const rp = E("rpanel");
  const ov = E("overlay");
  if (which === "lp") {
    const open = lp.classList.toggle("open");
    rp.classList.remove("open");
    ov.classList.toggle("open", open);
  } else {
    const open = rp.classList.toggle("open");
    lp.classList.remove("open");
    ov.classList.toggle("open", open);
  }
}

export function closeAllPanels(): void {
  E("lpanel").classList.remove("open");
  E("rpanel").classList.remove("open");
  E("overlay").classList.remove("open");
}

export function initInput(): void {
  const { canvas } = state;

  // Keyboard
  document.addEventListener("keydown", (e) => {
    state.keysDown.add(e.key);
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target as HTMLElement).isContentEditable) return;

    // Edit Mode: Tab toggle + component mode keys. Handled before the regular
    // shortcut switch so 1/2/3/B/A don't collide with Object Mode bindings.
    if (e.key === "Tab") {
      e.preventDefault();
      toggleEditMode();
      return;
    }
    if (isEditMode()) {
      if (e.key === "1" && !e.code.startsWith("Numpad")) { setComponentMode("vertex"); return; }
      if (e.key === "2" && !e.code.startsWith("Numpad")) { setComponentMode("edge"); return; }
      if (e.key === "3" && !e.code.startsWith("Numpad")) { setComponentMode("face"); return; }
      if (e.key.toLowerCase() === "b" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); startBoxSelect(); return; }
      if (e.key.toLowerCase() === "a" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); selectAllComponents(); return; }
      if (e.key.toLowerCase() === "e" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); extrudeSelection(); return; }
      if (e.key.toLowerCase() === "i" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); insetSelection(); return; }
      if (e.key.toLowerCase() === "b" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); bevelSelection(); return; }
      if (e.key.toLowerCase() === "r" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); loopCutSelection(); return; }
      if (e.key.toLowerCase() === "k" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); startKnifeCut(); return; }
      if (e.key.toLowerCase() === "f" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); knifeSelection(); return; }
      if (e.key.toLowerCase() === "g" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); edgeSlideSelection(); return; }
      if (e.key.toLowerCase() === "v" && e.shiftKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); vertexSlideSelection(); return; }
      if (e.key.toLowerCase() === "m" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); mergeSelection(); return; }
      if (e.key.toLowerCase() === "j" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); trisToQuadsSelection(); return; }
      if (e.key.toLowerCase() === "t" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); quadsToTrisSelection(); return; }
      if (e.key.toLowerCase() === "d" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); subdivideSelection(); return; }
      if (e.key.toLowerCase() === "t" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); setEditGizmoMode("move"); return; }
      if (e.key.toLowerCase() === "r" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); setEditGizmoMode("rotate"); return; }
      if (e.key.toLowerCase() === "s" && !e.shiftKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); setEditGizmoMode("scale"); return; }
      if (e.key.toLowerCase() === "e" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); bridgeSelection(); return; }
      if (e.key.toLowerCase() === "s" && e.shiftKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); markSeamSelection(); return; }
      if (e.key.toLowerCase() === "e" && e.shiftKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); markCreaseSelection(); return; }
      if (e.key.toLowerCase() === "u" && !e.ctrlKey && !e.metaKey && !e.shiftKey) { e.preventDefault(); unwrapMesh(); return; }
      if (e.key.toLowerCase() === "x" || e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelection(); return; }
      if (e.key === "Escape") { e.preventDefault(); clearComponentSelection(); return; }
      // Allow undo/redo to pass through; everything else is suppressed so
      // Object Mode tool-switch keys don't change the tool while editing.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) state.history.redo();
        else state.history.undo();
        return;
      }
      return;
    }

    switch (e.key.toLowerCase()) {
      case "z":
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          if (e.shiftKey) state.history.redo();
          else state.history.undo();
        }
        break;
      case "v": setTool("select"); break;
      case "g": setTool("move"); break;
      case "r": if (!e.ctrlKey) setTool("rotate"); break;
      case "s": if (!e.ctrlKey) setTool("scale"); break;
      case "d":
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); duplicateSelected(); }
        else setTool("sculpt");
        break;
      case "p": setTool("paint"); break;
      case "b": setTool("bone"); break;
      case "w": if (!e.ctrlKey) setTool("weight"); break;
      case "a":
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          // Select all meshes
          for (const m of state.allMeshes) selectMesh(m, true);
          status(state.allMeshes.length + " meshes selected");
        } else {
          setTool("anim");
        }
        break;
      case "n":
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          if (state.allMeshes.length === 0 || confirm("Clear scene? Unsaved changes will be lost.")) {
            stopPreview();
            const toRemove = [...state.allMeshes];
            for (const m of toRemove) cleanupMesh(m);
            state.selectedMeshes = [];
            state.meshCounter = 0;
            state.colorIndex = 0;
            state.paintTextureMap.clear();
            state.morphMap.clear();
            state.modifierMap.clear();
            state.originalGeometryMap.clear();
            state.skeletonMap.clear();
            state.activeSkeletonId = null;
            state.selectedBoneId = null;
            state.boneCounter = 0;
            state.skeletonCounter = 0;
            state.animClips = [];
            state.activeClipId = null;
            for (const ag of state.importedAnimGroups) {
              try { ag.stop(); } catch { /* ignore */ }
              try { ag.dispose(); } catch { /* ignore */ }
            }
            state.importedAnimGroups = [];
            state.lightMap.clear();
            state.selectedLightId = null;
            state.lightCounter = 0;
            state.mapInstances = [];
            clearMeasurements();
            state.history.clear();
            updateGizmo();
            updateHierarchy();
            updateProperties();
            status("New scene");
          }
        }
        break;
      case "f":
        if (!e.ctrlKey && !e.metaKey) {
          // Focus/frame selected mesh
          const sel = lastSelected();
          if (sel) {
            const bounds = sel.getBoundingInfo().boundingSphere;
            state.camera.setTarget(bounds.centerWorld);
            state.camera.radius = Math.max(bounds.radiusWorld * 3, 2);
            status("Focus: " + sel.name);
          }
        }
        break;
      case "h":
        // Blender-style hide toggles for animation work:
        //   H        → toggle all meshes
        //   Shift+H  → toggle bones (overrides the auto-toggle from initTool;
        //              switching tools will re-apply auto behaviour, which is
        //              intentional — manual override is per-session, not sticky).
        // Skip when modifiers (other than Shift) are held to avoid clashing
        // with browser shortcuts.
        if (e.ctrlKey || e.metaKey || e.altKey) break;
        if (e.shiftKey) {
          if (state.skeletonMap.size === 0) {
            status("No skeleton to toggle");
            break;
          }
          const newVisible = !areBoneVisualsVisible();
          setBoneVisualsVisible(newVisible);
          status(newVisible ? "Bones shown" : "Bones hidden");
        } else {
          if (state.allMeshes.length === 0) {
            status("No meshes to toggle");
            break;
          }
          // Use first mesh's state as the toggle reference (matches Blender's
          // "if any visible → hide all; else show all" intuition closely enough
          // for the common case where everything is in sync).
          const first = state.allMeshes[0]!;
          const newVisible = !first.isVisible;
          for (const m of state.allMeshes) m.isVisible = newVisible;
          status(newVisible ? "Meshes shown" : "Meshes hidden");
        }
        break;
      case "delete":
      case "backspace":
        if (e.target === document.body) deleteSelected();
        break;
      case "escape":
        if (BONE_TOOLS.has(state.tool) && state.selectedBoneId) {
          deselectBone();
        } else {
          deselect();
        }
        break;
      // Numpad camera presets
      case "1": if (e.code.startsWith("Numpad")) { e.preventDefault(); applyCameraPreset((e.ctrlKey || e.metaKey) ? PRESETS.back! : PRESETS.front!); } break;
      case "3": if (e.code.startsWith("Numpad")) { e.preventDefault(); applyCameraPreset((e.ctrlKey || e.metaKey) ? PRESETS.left! : PRESETS.right!); } break;
      case "7": if (e.code.startsWith("Numpad")) { e.preventDefault(); applyCameraPreset((e.ctrlKey || e.metaKey) ? PRESETS.bottom! : PRESETS.top!); } break;
      case "5": if (e.code.startsWith("Numpad")) { e.preventDefault(); toggleOrthographic(); } break;
    }
  });

  document.addEventListener("keyup", (e) => state.keysDown.delete(e.key));
  window.addEventListener("blur", () => state.keysDown.clear());

  // Undo snapshot state for brush strokes
  let sculptSnapshot: { mesh: import("@babylonjs/core").AbstractMesh; before: GeoSnapshot } | null = null;
  let paintSnapshot: {
    mesh: import("@babylonjs/core").AbstractMesh;
    canvas: OffscreenCanvas;
    recomposite: () => void;
    before: ImageData;
    halfCanvas: OffscreenCanvas;
  } | null = null;
  const SNAP_SIZE = 512; // Downscaled snapshot size (1/4 memory of 1024)
  let weightSnapshot: { mesh: import("@babylonjs/core").AbstractMesh; before: Float32Array } | null = null;

  // Pointer events
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;

    // Edit Mode (component-level): intercept before any other tool handler.
    if (isEditMode()) {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const consumed = handleEditModePointerDown(x, y, e.ctrlKey || e.metaKey || state.multiSelectMode);
      if (consumed) return;
    }

    // Sculpt mode
    if (state.tool === "sculpt" && state.selectedMeshes.length) {
      // Capture full geometry + mask snapshot for topology-aware per-stroke undo
      const target = state.selectedMeshes[state.selectedMeshes.length - 1]!;
      const geo = captureGeometry(target);
      sculptSnapshot = geo ? { mesh: target, before: geo } : null;

      state.sculpting = true;
      state.camera.detachControl();
      canvas.setPointerCapture(e.pointerId);
      try {
        const pk = state.scene.pick(
          state.scene.pointerX,
          state.scene.pointerY,
          (m) => state.selectedMeshes.includes(m)
        );
        if (pk?.hit) sculptAt(pk.pickedMesh!, pk);
      } catch (err) {
        console.warn("Sculpt error:", err);
        state.sculpting = false;
        canvas.releasePointerCapture(e.pointerId);
        if (!state.cameraLocked) state.camera.attachControl(canvas, true);
      }
      return;
    }

    // Paint mode
    if (state.tool === "paint" && state.selectedMeshes.length) {
      const pk = state.scene.pick(
        state.scene.pointerX,
        state.scene.pointerY,
        (m) => state.selectedMeshes.includes(m)
      );
      if (pk?.hit) {
        if (!hasUVs(pk.pickedMesh!)) {
          status("UV座標なし — ペイント不可");
          return;
        }
        // Capture a downscaled snapshot of the stroke target for undo
        // (512×512): albedo → active layer canvas, roughness / metallic →
        // that channel's canvas. Composites are derived, canvases are truth.
        const target = pk.pickedMesh!;
        const strokeTarget = getStrokeTarget(target);
        if (strokeTarget) {
          const halfCanvas = new OffscreenCanvas(SNAP_SIZE, SNAP_SIZE);
          const hCtx = halfCanvas.getContext("2d")!;
          hCtx.clearRect(0, 0, SNAP_SIZE, SNAP_SIZE);
          hCtx.drawImage(strokeTarget.canvas, 0, 0, SNAP_SIZE, SNAP_SIZE);
          paintSnapshot = {
            mesh: target,
            canvas: strokeTarget.canvas,
            recomposite: strokeTarget.recomposite,
            before: hCtx.getImageData(0, 0, SNAP_SIZE, SNAP_SIZE),
            halfCanvas,
          };
        } else {
          paintSnapshot = null;
        }

        state.painting = true;
        state.camera.detachControl();
        canvas.setPointerCapture(e.pointerId);
        try {
          beginPaintStroke();
          paintAt(pk.pickedMesh!, pk);
        } catch (err) {
          state.painting = false;
          canvas.releasePointerCapture(e.pointerId);
          if (!state.cameraLocked) state.camera.attachControl(canvas, true);
        }
      }
      return;
    }

    // Bone mode
    if (state.tool === "bone") {
      const pk = state.scene.pick(
        state.scene.pointerX,
        state.scene.pointerY,
        (m) => isBoneVisual(m) || state.allMeshes.includes(m)
      );
      if (pk?.hit) {
        handleBonePointerDown(pk);
      }
      return;
    }

    // Anim mode — bone selection for posing
    if (state.tool === "anim") {
      const pk = state.scene.pick(
        state.scene.pointerX,
        state.scene.pointerY,
        (m) => isBoneVisual(m)
      );
      if (pk?.hit) {
        handleBonePointerDown(pk);
      }
      return;
    }

    // Weight paint mode
    if (state.tool === "weight" && state.selectedMeshes.length) {
      if (!state.selectedBoneId) {
        status("⚠ Select a bone first");
        return;
      }
      const mesh = state.selectedMeshes[state.selectedMeshes.length - 1]!;
      if (!mesh.skeleton) {
        status("⚠ Assign skeleton to mesh first");
        return;
      }
      if (!hasWeightData(mesh)) {
        status("⚠ Initialize weight data first");
        return;
      }
      const pk = state.scene.pick(
        state.scene.pointerX,
        state.scene.pointerY,
        (m) => state.selectedMeshes.includes(m)
      );
      if (pk?.hit) {
        // Capture weight data snapshot for undo
        const wData = mesh.getVerticesData(VertexBuffer.MatricesWeightsKind);
        weightSnapshot = wData ? { mesh, before: new Float32Array(wData) } : null;

        state.weightPainting = true;
        state.camera.detachControl();
        canvas.setPointerCapture(e.pointerId);
        try {
          paintWeightAt(pk.pickedMesh!, pk);
        } catch (err) {
          state.weightPainting = false;
          canvas.releasePointerCapture(e.pointerId);
          if (!state.cameraLocked) state.camera.attachControl(canvas, true);
        }
      }
      return;
    }

    // Measure mode
    if (state.measuringActive) {
      const pk = state.scene.pick(
        state.scene.pointerX,
        state.scene.pointerY,
      );
      if (pk?.hit && pk.pickedPoint) {
        addMeasurePoint(pk.pickedPoint);
      }
      return;
    }

    // Pick
    const pk = state.scene.pick(
      state.scene.pointerX,
      state.scene.pointerY,
      (m) => state.allMeshes.includes(m)
    );
    if (pk?.hit) {
      selectMesh(pk.pickedMesh!, e.ctrlKey || e.metaKey || state.multiSelectMode);
    } else if (!e.ctrlKey && !e.metaKey && !state.multiSelectMode && !state.gizmoManager.isHovered) {
      deselect();
    }
  });

  // Brush cursor config: tool → cursor size + drag action
  const BRUSH_TOOLS: { tool: ToolId; getSize: () => number; isDragging: () => boolean; onDrag: () => void }[] = [
    {
      tool: "sculpt",
      getSize: () => state.sculptConfig.radius * 55,
      isDragging: () => state.sculpting && state.selectedMeshes.length > 0,
      onDrag: () => { const pk = pickSelected(); if (pk?.hit) sculptAt(pk.pickedMesh!, pk); },
    },
    {
      tool: "paint",
      getSize: () => state.paintConfig.size * 0.06,
      isDragging: () => state.painting && state.selectedMeshes.length > 0,
      onDrag: () => { const pk = pickSelected(); if (pk?.hit) paintAt(pk.pickedMesh!, pk); },
    },
    {
      tool: "weight",
      getSize: () => state.weightConfig.radius * 55,
      isDragging: () => state.weightPainting && state.selectedMeshes.length > 0,
      onDrag: () => { const pk = pickSelected(); if (pk?.hit) paintWeightAt(pk.pickedMesh!, pk); },
    },
  ];

  function pickSelected() {
    return state.scene.pick(state.scene.pointerX, state.scene.pointerY, (m) => state.selectedMeshes.includes(m));
  }

  // Debounce cursor DOM updates with rAF; drag actions fire immediately
  let cursorRafId = 0;
  canvas.addEventListener("pointermove", (e) => {
    const cfg = BRUSH_TOOLS.find((b) => b.tool === state.tool);
    if (cfg) {
      // Execute drag action immediately (not debounced) for responsive brushing
      if (cfg.isDragging()) cfg.onDrag();
      // Debounce visual cursor position updates
      const cx = e.clientX, cy = e.clientY;
      if (!cursorRafId) {
        cursorRafId = requestAnimationFrame(() => {
          cursorRafId = 0;
          const cur = E("scur");
          cur.style.display = "block";
          const rect = canvas.getBoundingClientRect();
          cur.style.left = (cx - rect.left) + "px";
          cur.style.top = (cy - rect.top) + "px";
          const sz = cfg.getSize();
          cur.style.width = sz + "px";
          cur.style.height = sz + "px";
        });
      }
    } else {
      if (cursorRafId) { cancelAnimationFrame(cursorRafId); cursorRafId = 0; }
      E("scur").style.display = "none";
    }
  });

  canvas.addEventListener("pointerup", (e) => {
    const wasSculpting = state.sculpting;
    const wasPainting = state.painting;
    const wasWeightPainting = state.weightPainting;
    state.sculpting = false;
    state.painting = false;
    state.weightPainting = false;
    if (wasSculpting || wasPainting || wasWeightPainting) {
      canvas.releasePointerCapture(e.pointerId);
      if (!state.cameraLocked) state.camera.attachControl(canvas, true);
    }

    // Push sculpt undo. Topology-changing strokes (dyntopo split) need full
    // geometry snapshots; plain deform/mask strokes retain only the changed
    // vertices (sparse delta) — full before+after snapshots at 50 history
    // entries were a realistic OOM vector on tablets.
    if (wasSculpting && sculptSnapshot) {
      const { mesh, before } = sculptSnapshot;
      const after = captureGeometry(mesh);
      if (after) {
        const topologyChanged =
          before.positions.length !== after.positions.length ||
          before.indices.length !== after.indices.length;
        if (topologyChanged) {
          state.history.push({
            label: "Sculpt",
            undo() { restoreGeometry(mesh, before); },
            redo() { restoreGeometry(mesh, after); },
          });
        } else {
          const posDelta = diffAttribute(before.positions, after.positions, 3);
          const bothMasks = before.mask && after.mask;
          const maskDelta = bothMasks ? diffAttribute(before.mask!, after.mask!, 1) : null;
          // Mask created (or removed) mid-stroke → wholesale swap per side.
          const maskSwapped = !bothMasks && before.mask !== after.mask;
          const posChanged = !!posDelta && posDelta.indices.length > 0;
          const maskChanged = (!!maskDelta && maskDelta.indices.length > 0) || maskSwapped;
          if (posChanged || maskChanged) {
            const undoMaskFull = maskSwapped ? before.mask : undefined;
            const redoMaskFull = maskSwapped ? after.mask : undefined;
            state.history.push({
              label: "Sculpt",
              undo() { applySculptDelta(mesh, posDelta, maskDelta, undoMaskFull, "before"); },
              redo() { applySculptDelta(mesh, posDelta, maskDelta, redoMaskFull, "after"); },
            });
          }
          // No-op stroke (nothing moved): push nothing.
        }
      }
      sculptSnapshot = null;
    }

    // Push paint undo (downscaled 512×512 snapshots of the stroke target)
    if (wasPainting && paintSnapshot) {
      const { canvas, recomposite, before, halfCanvas } = paintSnapshot;
      {
        const hCtx = halfCanvas.getContext("2d")!;
        hCtx.clearRect(0, 0, SNAP_SIZE, SNAP_SIZE);
        hCtx.drawImage(canvas, 0, 0, SNAP_SIZE, SNAP_SIZE);
        const after = hCtx.getImageData(0, 0, SNAP_SIZE, SNAP_SIZE);
        const beforeData = before, afterData = after;
        const restore = (data: ImageData): void => {
          const c = canvas.getContext("2d");
          if (!c) return;
          const sz = canvas.width;
          const tmp = new OffscreenCanvas(SNAP_SIZE, SNAP_SIZE);
          const tc = tmp.getContext("2d")!;
          tc.putImageData(data, 0, 0);
          c.save();
          c.globalCompositeOperation = "copy"; // replace incl. transparency
          c.drawImage(tmp, 0, 0, sz, sz);
          c.restore();
          recomposite();
        };
        state.history.push({
          label: "Paint",
          undo() { restore(beforeData); },
          redo() { restore(afterData); },
        });
      }
      paintSnapshot = null;
    }

    // Push weight paint undo
    if (wasWeightPainting && weightSnapshot) {
      const { mesh, before } = weightSnapshot;
      const after = mesh.getVerticesData(VertexBuffer.MatricesWeightsKind);
      if (after) {
        const afterCopy = new Float32Array(after);
        const beforeCopy = before;
        state.history.push({
          label: "Weight Paint",
          undo() { mesh.setVerticesData(VertexBuffer.MatricesWeightsKind, beforeCopy, true); },
          redo() { mesh.setVerticesData(VertexBuffer.MatricesWeightsKind, afterCopy, true); },
        });
      }
      weightSnapshot = null;
    }
  });

  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  // Panel toggles
  E("btnLP").addEventListener("click", () => togglePanel("lp"));
  E("btnRP").addEventListener("click", () => togglePanel("rp"));
  E("overlay").addEventListener("click", closeAllPanels);

  // Swipe to close panels
  initSwipeToClose();

  // Scroll fade hints for horizontally-scrollable areas
  for (const sel of [".pills", ".tabs", ".mob-bottom"]) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) initScrollFade(el);
  }

  // Drag & drop file import
  let dragCounter = 0;
  const dropZone = E("dropZone");

  canvas.addEventListener("dragenter", (e) => { e.preventDefault(); dragCounter++; dropZone.classList.add("active"); });
  canvas.addEventListener("dragleave", (e) => { e.preventDefault(); if (--dragCounter <= 0) { dragCounter = 0; dropZone.classList.remove("active"); } });
  canvas.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer!.dropEffect = "copy"; });
  canvas.addEventListener("drop", async (e) => {
    e.preventDefault(); dragCounter = 0; dropZone.classList.remove("active");
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (!["glb", "gltf", "obj", "stl"].includes(ext)) { status("\u26a0 Unsupported: ." + ext); return; }
    const { loadFileDirectly } = await import("./export/gltf-exporter");
    await loadFileDirectly(file);
  });

  // Resize
  window.addEventListener("resize", () => {
    state.engine.resize();
    if (!isMobile()) closeAllPanels();
  });
}

function initSwipeToClose(): void {
  const THRESHOLD = 60;

  for (const [panelId, direction] of [["lpanel", -1], ["rpanel", 1]] as const) {
    const panel = E(panelId);
    let startX = 0;
    let startY = 0;
    panel.addEventListener("touchstart", (e) => {
      const t = e.touches[0];
      if (!t) return;
      startX = t.clientX;
      startY = t.clientY;
    }, { passive: true });
    panel.addEventListener("touchend", (e) => {
      const t = e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - startX;
      const dy = Math.abs(t.clientY - startY);
      if (dy < 100 && dx * direction > THRESHOLD) {
        closeAllPanels();
      }
    }, { passive: true });
  }
}

function initScrollFade(el: HTMLElement): void {
  el.classList.add("scroll-fade");
  const update = () => {
    const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 2;
    const atStart = el.scrollLeft > 2;
    el.classList.toggle("scroll-end", atEnd);
    el.classList.toggle("scroll-start", atStart);
  };
  el.addEventListener("scroll", update, { passive: true });
  // Initial check after layout
  requestAnimationFrame(update);
}

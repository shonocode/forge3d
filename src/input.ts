import { state, E, status } from "./state";
import type { ToolId } from "./state";
import { selectMesh, deselect, updateGizmo, lastSelected } from "./tools/selection";
import { sculptAt, captureGeometry, restoreGeometry, applySculptDelta } from "./tools/sculpt";
import type { GeoSnapshot } from "./tools/sculpt";
import { diffAttribute } from "./tools/sculpt-delta";
import { paintAt, hasUVs, beginPaintStroke, getStrokeTarget } from "./tools/texture-paint";
import { duplicateSelected, deleteSelected, cleanupMesh } from "./tools/actions";
import { handleBonePointerDown, isBoneVisual, setBoneVisualsVisible, deselectBone } from "./tools/skeleton-tool";
import { paintWeightAt, hasWeightData, showWeightOverlay, hideWeightOverlay } from "./tools/weight-paint";
import { stopPreview } from "./tools/animation-tool";
import { applyCameraPreset, toggleOrthographic, PRESETS } from "./viewport/camera-presets";
import { applySnapToGizmos } from "./tools/snap";

/**
 * Redraw the panels that read `state.selectedBoneId`.
 *
 * Clicking a bone in the viewport used to change the selection and nothing
 * else: `selectBone` swaps the visual's material and attaches the gizmo, and
 * no caller on this path refreshed the UI. So the marker turned yellow while
 * the Bone panel, the keyframe list and the graph editor all kept saying
 * "ボーンを選択" — the app telling you to do the thing you had just done.
 *
 * The screen reads the selection from the state, so telling the store is
 * enough (ADR-014) — the frame fingerprint would catch it a frame later, this
 * makes it immediate.
 */
function refreshAfterBoneSelection(): void {
  store.notify();
}
import { addMeasurePoint, clearMeasurements } from "./tools/measure";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { toggleEditMode, setComponentMode, selectAllComponents, clearComponentSelection, isEditMode, handleEditModePointerDown, startBoxSelect, extrudeSelection, deleteSelection, insetSelection, bevelSelection, loopCutSelection, unwrapMesh, edgeSlideSelection, mergeSelection, bridgeSelection, setEditGizmoMode, vertexSlideSelection, startKnifeCut, trisToQuadsSelection, quadsToTrisSelection, markCreaseSelection, setCreaseSelection, fillSelection } from "./tools/edit-mode";
import { actionFor, type ActionId } from "./keymap";
import { store } from "./store";

const BONE_TOOLS: ReadonlySet<ToolId> = new Set(["bone", "weight", "anim"]);

export function setTool(t: ToolId): void {
  const prev = state.tool;
  if (prev === t) return;

  cleanupTool(prev);
  state.tool = t;
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


function initTool(t: ToolId): void {
  if (BONE_TOOLS.has(t)) {
    setBoneVisualsVisible(true);
  } else {
    setBoneVisualsVisible(false);
    // Before updateGizmo: deselectBone detaches the gizmo unconditionally, and
    // run after it, switching from Select to Move with a mesh selected left the
    // mesh without its arrows until it was clicked again.
    deselectBone();
  }
  updateGizmo();
  applySnapToGizmos();
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




export function initInput(): void {
  const { canvas } = state;

  // Keyboard
  document.addEventListener("keydown", (e) => {
    state.keysDown.add(e.key);
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target as HTMLElement).isContentEditable) return;

    // Every key goes through the one table in keymap.ts (Blender's keymap).
    const context = isEditMode() ? "edit" : "object";
    const action = actionFor(e, context);
    if (!action) return;
    e.preventDefault();
    runKeyAction(action);
  });

  /** G twice within this many ms is Blender's G G: slide instead of move. */
  const DOUBLE_TAP_MS = 400;
  let lastEditMoveAt = -Infinity;

  const runKeyAction = (action: ActionId): void => {
    switch (action) {
      case "history.undo": state.history.undo(); return;
      case "history.redo": state.history.redo(); return;
      case "mode.editToggle": toggleEditMode(); return;
      case "view.front": applyCameraPreset(PRESETS.front!); return;
      case "view.back": applyCameraPreset(PRESETS.back!); return;
      case "view.right": applyCameraPreset(PRESETS.right!); return;
      case "view.left": applyCameraPreset(PRESETS.left!); return;
      case "view.top": applyCameraPreset(PRESETS.top!); return;
      case "view.bottom": applyCameraPreset(PRESETS.bottom!); return;
      case "view.ortho": toggleOrthographic(); return;

      // ── Object Mode ──
      case "tool.select": setTool("select"); return;
      case "tool.move": setTool("move"); return;
      case "tool.rotate": setTool("rotate"); return;
      case "tool.scale": setTool("scale"); return;
      case "select.all":
        if (isEditMode()) { selectAllComponents(); return; }
        for (const m of state.allMeshes) if (m.isVisible) selectMesh(m, true);
        status(state.selectedMeshes.length + " meshes selected");
        return;
      case "select.none":
      case "select.cancel":
        if (isEditMode()) { clearComponentSelection(); return; }
        if (BONE_TOOLS.has(state.tool) && state.selectedBoneId) deselectBone();
        else deselect();
        return;
      case "object.duplicate": duplicateSelected(); return;
      case "object.delete": deleteSelected(); return;
      case "view.hide": {
        const sel = [...state.selectedMeshes];
        if (!sel.length) { status("Nothing selected to hide"); return; }
        for (const m of sel) m.isVisible = false;
        deselect();
        status(`Hidden: ${sel.length}`);
        return;
      }
      case "view.hideUnselected": {
        const keep = new Set(state.selectedMeshes);
        let n = 0;
        for (const m of state.allMeshes) if (!keep.has(m) && m.isVisible) { m.isVisible = false; n++; }
        status(`Hidden: ${n}`);
        return;
      }
      case "view.reveal": {
        let n = 0;
        for (const m of state.allMeshes) if (!m.isVisible) { m.isVisible = true; n++; }
        status(`Revealed: ${n}`);
        return;
      }
      case "view.selected": {
        const sel = lastSelected();
        if (!sel) { status("Nothing selected"); return; }
        const bounds = sel.getBoundingInfo().boundingSphere;
        state.camera.setTarget(bounds.centerWorld);
        state.camera.radius = Math.max(bounds.radiusWorld * 3, 2);
        status("Frame Selected: " + sel.name);
        return;
      }
      case "view.all": {
        const shown = state.allMeshes.filter((m) => m.isVisible);
        if (!shown.length) { status("Nothing to frame"); return; }
        let min = shown[0]!.getBoundingInfo().boundingBox.minimumWorld.clone();
        let max = shown[0]!.getBoundingInfo().boundingBox.maximumWorld.clone();
        for (const m of shown) {
          const bb = m.getBoundingInfo().boundingBox;
          min = Vector3.Minimize(min, bb.minimumWorld);
          max = Vector3.Maximize(max, bb.maximumWorld);
        }
        state.camera.setTarget(min.add(max).scale(0.5));
        state.camera.radius = Math.max(Vector3.Distance(min, max) * 1.5, 2);
        status("Frame All");
        return;
      }
      case "file.new":
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
        store.notify();
        status("New scene");
      }
        return;

      // ── Edit Mode ──
      case "comp.vertex": setComponentMode("vertex"); return;
      case "comp.edge": setComponentMode("edge"); return;
      case "comp.face": setComponentMode("face"); return;
      case "select.box": startBoxSelect(); return;
      case "edit.move": {
        // Blender's G G: the second G slides along the edges instead.
        const now = performance.now();
        const again = now - lastEditMoveAt < DOUBLE_TAP_MS;
        lastEditMoveAt = again ? -Infinity : now;
        if (!again) { setEditGizmoMode("move"); return; }
        if (state.editSelection.mode === "edge") edgeSlideSelection();
        else if (state.editSelection.mode === "vertex") vertexSlideSelection();
        return;
      }
      case "edit.rotate": setEditGizmoMode("rotate"); return;
      case "edit.scale": setEditGizmoMode("scale"); return;
      case "edit.extrude": extrudeSelection(); return;
      case "edit.inset": insetSelection(); return;
      case "edit.bevel": bevelSelection(); return;
      case "edit.loopCut": loopCutSelection(); return;
      case "edit.knife": startKnifeCut(); return;
      case "edit.fill": fillSelection(); return;
      case "edit.vertexSlide": vertexSlideSelection(); return;
      case "edit.merge": mergeSelection(); return;
      case "edit.bridge": bridgeSelection(); return;
      case "edit.markCrease": markCreaseSelection(); return;
      case "edit.setCrease": setCreaseSelection(); return;
      case "edit.trisToQuads": trisToQuadsSelection(); return;
      case "edit.quadsToTris": quadsToTrisSelection(); return;
      case "edit.unwrap": unwrapMesh(); return;
      case "edit.delete": deleteSelection(); return;
    }
  };

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
        refreshAfterBoneSelection();
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
        refreshAfterBoneSelection();
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
  });
}



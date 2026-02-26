import { state, E, status, isMobile } from "./state";
import type { ToolId } from "./state";
import { selectMesh, deselect, updateGizmo, lastSelected } from "./tools/selection";
import { sculptAt } from "./tools/sculpt";
import { paintAt, hasUVs } from "./tools/texture-paint";
import { duplicateSelected, deleteSelected } from "./tools/actions";
import { handleBonePointerDown, isBoneVisual, setBoneVisualsVisible, deselectBone } from "./tools/skeleton-tool";
import { paintWeightAt, hasWeightData, showWeightOverlay, hideWeightOverlay } from "./tools/weight-paint";
import { stopPreview } from "./tools/animation-tool";
import { applyCameraPreset, toggleOrthographic, PRESETS } from "./viewport/camera-presets";
import { applySnapToGizmos } from "./tools/snap";
import { addMeasurePoint } from "./tools/measure";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";

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
  if (prev === "anim" && state.isPlaying) stopPreview();
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
}

export function switchTab(id: string): void {
  document.querySelectorAll<HTMLElement>(".tb").forEach((b) =>
    b.classList.toggle("on", b.dataset.tab === id)
  );
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
    if ((e.target as HTMLElement).tagName === "INPUT") return;
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
      case "a": if (!e.ctrlKey) setTool("anim"); break;
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
  let sculptSnapshot: { mesh: import("@babylonjs/core").AbstractMesh; before: Float32Array } | null = null;
  let paintSnapshot: { mesh: import("@babylonjs/core").AbstractMesh; before: ImageData; halfCanvas: OffscreenCanvas } | null = null;
  const SNAP_SIZE = 512; // Downscaled snapshot size (1/4 memory of 1024)
  let weightSnapshot: { mesh: import("@babylonjs/core").AbstractMesh; before: Float32Array } | null = null;

  // Pointer events
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;

    // Sculpt mode
    if (state.tool === "sculpt" && state.selectedMeshes.length) {
      // Capture position snapshot for undo
      const target = state.selectedMeshes[state.selectedMeshes.length - 1]!;
      const posData = target.getVerticesData(VertexBuffer.PositionKind);
      sculptSnapshot = posData ? { mesh: target, before: new Float32Array(posData) } : null;

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
        state.camera.attachControl(canvas, true);
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
        // Capture downscaled paint texture snapshot for undo (512×512 = 1MB vs 4MB)
        const target = pk.pickedMesh!;
        const paintTex = state.paintTextureMap.get(target.uniqueId);
        if (paintTex) {
          const ctx = paintTex.getContext() as CanvasRenderingContext2D | null;
          if (ctx) {
            const halfCanvas = new OffscreenCanvas(SNAP_SIZE, SNAP_SIZE);
            const hCtx = halfCanvas.getContext("2d")!;
            hCtx.drawImage(ctx.canvas, 0, 0, SNAP_SIZE, SNAP_SIZE);
            paintSnapshot = { mesh: target, before: hCtx.getImageData(0, 0, SNAP_SIZE, SNAP_SIZE), halfCanvas };
          }
        } else {
          paintSnapshot = null;
        }

        state.painting = true;
        state.camera.detachControl();
        canvas.setPointerCapture(e.pointerId);
        try {
          paintAt(pk.pickedMesh!, pk);
        } catch (err) {
          state.painting = false;
          canvas.releasePointerCapture(e.pointerId);
          state.camera.attachControl(canvas, true);
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
          state.camera.attachControl(canvas, true);
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
    } else if (!e.ctrlKey && !e.metaKey && !state.multiSelectMode) {
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

  canvas.addEventListener("pointermove", (e) => {
    const cur = E("scur");
    const cfg = BRUSH_TOOLS.find((b) => b.tool === state.tool);
    if (cfg) {
      cur.style.display = "block";
      const rect = canvas.getBoundingClientRect();
      cur.style.left = (e.clientX - rect.left) + "px";
      cur.style.top = (e.clientY - rect.top) + "px";
      const sz = cfg.getSize();
      cur.style.width = sz + "px";
      cur.style.height = sz + "px";
      if (cfg.isDragging()) cfg.onDrag();
    } else {
      cur.style.display = "none";
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
      state.camera.attachControl(canvas, true);
    }

    // Push sculpt undo
    if (wasSculpting && sculptSnapshot) {
      const { mesh, before } = sculptSnapshot;
      const after = mesh.getVerticesData(VertexBuffer.PositionKind);
      if (after) {
        const afterCopy = new Float32Array(after);
        const beforeCopy = before;
        state.history.push({
          label: "Sculpt",
          undo() { mesh.updateVerticesData(VertexBuffer.PositionKind, beforeCopy); },
          redo() { mesh.updateVerticesData(VertexBuffer.PositionKind, afterCopy); },
        });
      }
      sculptSnapshot = null;
    }

    // Push paint undo (downscaled 512×512 snapshots)
    if (wasPainting && paintSnapshot) {
      const { mesh, before, halfCanvas } = paintSnapshot;
      const paintTex = state.paintTextureMap.get(mesh.uniqueId);
      if (paintTex) {
        const ctx = paintTex.getContext() as CanvasRenderingContext2D | null;
        if (ctx) {
          const hCtx = halfCanvas.getContext("2d")!;
          hCtx.drawImage(ctx.canvas, 0, 0, SNAP_SIZE, SNAP_SIZE);
          const after = hCtx.getImageData(0, 0, SNAP_SIZE, SNAP_SIZE);
          const m = mesh, beforeData = before, afterData = after;
          state.history.push({
            label: "Paint",
            undo() {
              const t = state.paintTextureMap.get(m.uniqueId);
              if (!t) return;
              const c = t.getContext() as CanvasRenderingContext2D | null;
              if (!c) return;
              const tmp = new OffscreenCanvas(SNAP_SIZE, SNAP_SIZE);
              const tc = tmp.getContext("2d")!;
              tc.putImageData(beforeData, 0, 0);
              c.drawImage(tmp, 0, 0, 1024, 1024);
              t.update();
            },
            redo() {
              const t = state.paintTextureMap.get(m.uniqueId);
              if (!t) return;
              const c = t.getContext() as CanvasRenderingContext2D | null;
              if (!c) return;
              const tmp = new OffscreenCanvas(SNAP_SIZE, SNAP_SIZE);
              const tc = tmp.getContext("2d")!;
              tc.putImageData(afterData, 0, 0);
              c.drawImage(tmp, 0, 0, 1024, 1024);
              t.update();
            },
          });
        }
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

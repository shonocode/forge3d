import { E, isMobile, state, status } from "../state";
import type { ToolId } from "../state";
import { addPrimitive, PRIMS } from "../tools/primitives";
import { BRUSHES, setBrush } from "../tools/sculpt";
import { doCSG, type CSGOp } from "../tools/csg";
import { duplicateSelected, deleteSelected } from "../tools/actions";
import { setTool, switchTab, closeAllPanels, togglePanel } from "../input";
import { lastSelected, applyGizmoAxisConstraint } from "../tools/selection";
import {
  recalcNormals, flipNormals, weldVertices, centerOrigin,
  snapshotVertexData, restoreVertexData,
} from "../tools/mesh-utils";

export function buildToolPills(): void {
  const mobile = isMobile();
  const TOOLS: { id: ToolId; label: string; key: string; aria: string }[] = [
    { id: "select", label: "SEL", key: "V", aria: "Select tool" },
    { id: "move", label: "MOV", key: "G", aria: "Move tool" },
    { id: "rotate", label: "ROT", key: "R", aria: "Rotate tool" },
    { id: "scale", label: "SCL", key: "S", aria: "Scale tool" },
    { id: "sculpt", label: "SCP", key: "D", aria: "Sculpt tool" },
    { id: "paint", label: "PNT", key: "P", aria: "Paint tool" },
    { id: "bone", label: "BONE", key: "B", aria: "Bone tool" },
    { id: "weight", label: "WGT", key: "W", aria: "Weight paint tool" },
    { id: "anim", label: "ANM", key: "A", aria: "Animation tool" },
  ];
  const el = E("pills");
  for (const t of TOOLS) {
    const b = document.createElement("button");
    b.className = "pill" + (t.id === "select" ? " on" : "");
    b.dataset.tool = t.id;
    b.innerHTML = mobile
      ? t.label
      : `${t.label}<span style="opacity:.4;font-size:8px;margin-left:2px">${t.key}</span>`;
    b.title = t.label + " [" + t.key + "]";
    b.setAttribute("aria-label", t.aria);
    b.addEventListener("click", () => setTool(t.id));
    el.appendChild(b);
  }
}

export function buildPrimitiveGrid(): void {
  const el = E("primGrid");
  for (const p of PRIMS) {
    const b = document.createElement("button");
    b.className = "pbtn";
    b.innerHTML = `<span class="ic">${p.icon}</span>${p.label}`;
    b.setAttribute("aria-label", "Add " + p.label);
    b.addEventListener("click", () => {
      addPrimitive(p.id);
      if (isMobile()) closeAllPanels();
    });
    el.appendChild(b);
  }
}

export function buildCSGButtons(): void {
  const el = E("csgBtns");
  const ops: { op: CSGOp; sym: string; label: string }[] = [
    { op: "union", sym: "\u222a", label: "Union \u7d50\u5408" },
    { op: "subtract", sym: "\u2212", label: "Subtract \u5dee\u5206" },
    { op: "intersect", sym: "\u2229", label: "Intersect \u4ea4\u5dee" },
  ];
  for (const { op, sym, label } of ops) {
    const b = document.createElement("button");
    b.className = "cbtn";
    b.innerHTML = `<span class="sy">${sym}</span>${label}`;
    b.setAttribute("aria-label", label);
    b.addEventListener("click", () => doCSG(op));
    el.appendChild(b);
  }
}

export function buildTabs(): void {
  const TAB_LIST = [
    { id: "xform", label: "Transform" },
    { id: "mat", label: "Material" },
    { id: "morph", label: "Morph" },
    { id: "sculpt", label: "Sculpt" },
    { id: "paint", label: "Paint" },
    { id: "bone", label: "Bone" },
    { id: "weight", label: "Weight" },
    { id: "anim", label: "Anim" },
    { id: "map", label: "Map" },
    { id: "scene", label: "Scene" },
  ];
  const el = E("tabBar");
  el.setAttribute("role", "tablist");
  for (const [i, t] of TAB_LIST.entries()) {
    const b = document.createElement("button");
    b.className = "tb" + (i === 0 ? " on" : "");
    b.dataset.tab = t.id;
    b.textContent = t.label;
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", i === 0 ? "true" : "false");
    b.setAttribute("aria-controls", "tb-" + t.id);
    b.id = "tab-" + t.id;
    b.addEventListener("click", () => switchTab(t.id));
    el.appendChild(b);
  }
  // Set tabpanel roles on content containers
  for (const t of TAB_LIST) {
    const panel = document.getElementById("tb-" + t.id);
    if (panel) {
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", "tab-" + t.id);
    }
  }
}

export function buildBrushButtons(): void {
  const el = E("brushBtns");
  el.innerHTML = '<div class="pgt">Mode</div>';
  for (const br of BRUSHES) {
    const b = document.createElement("button");
    b.className = "abtn bon" + (br.id === "push" ? " on" : "");
    b.id = "sb_" + br.id;
    b.textContent = br.label;
    b.setAttribute("aria-label", br.label);
    b.addEventListener("click", () => setBrush(br.id));
    el.appendChild(b);
  }

  if (isMobile()) {
    // Touch modifier toggles — substitute for Ctrl/Shift
    const modWrap = document.createElement("div");
    modWrap.style.cssText = "display:flex;gap:6px;margin-top:8px;";
    const mods: { label: string; key: "ctrl" | "shift" }[] = [
      { label: "⇅ Invert", key: "ctrl" },
      { label: "〜 Smooth", key: "shift" },
    ];
    for (const mod of mods) {
      const b = document.createElement("button");
      b.className = "abtn touch-mod";
      b.textContent = mod.label;
      b.addEventListener("click", () => {
        const on = !state.touchModifiers[mod.key];
        // Mutually exclusive
        state.touchModifiers.ctrl = false;
        state.touchModifiers.shift = false;
        modWrap.querySelectorAll<HTMLElement>(".touch-mod").forEach((x) => x.classList.remove("on"));
        state.touchModifiers[mod.key] = on;
        if (on) b.classList.add("on");
      });
      modWrap.appendChild(b);
    }
    el.appendChild(modWrap);
    el.insertAdjacentHTML(
      "beforeend",
      '<div style="margin-top:6px;font-size:10px;color:var(--t4);line-height:1.6;">Invert/Smoothトグルでモード切替</div>'
    );
  } else {
    el.insertAdjacentHTML(
      "beforeend",
      '<div style="margin-top:6px;font-size:9px;color:var(--t4);line-height:1.6;">Ctrl+drag: 反転<br>Shift+drag: Smooth</div>'
    );
  }
}

export function buildMeshToolButtons(): void {
  const el = E("meshToolBtns");
  const tools: { label: string; action: (m: import("@babylonjs/core").AbstractMesh) => boolean }[] = [
    { label: "Recalc Normals", action: recalcNormals },
    { label: "Flip Normals", action: flipNormals },
    { label: "Weld Vertices", action: (m) => weldVertices(m) },
    { label: "Center Origin", action: centerOrigin },
  ];
  for (const tool of tools) {
    const b = document.createElement("button");
    b.className = "cbtn";
    b.textContent = tool.label;
    b.setAttribute("aria-label", tool.label);
    b.addEventListener("click", () => {
      const m = lastSelected();
      if (!m) { status("メッシュを選択"); return; }
      const snap = snapshotVertexData(m);
      const ok = tool.action(m);
      if (!ok) { status("変更なし"); return; }
      if (snap) {
        state.history.push({
          label: tool.label,
          undo() { restoreVertexData(m, snap); },
          redo() { tool.action(m); },
        });
      }
      status(tool.label + " 完了");
    });
    el.appendChild(b);
  }
}

export function buildMobileBar(): void {
  const el = E("mobBar");
  const items: { label: string; cls?: string; handler: () => void }[] = [
    { label: "\uff0b Prim", handler: () => togglePanel("lp") },
    { label: "\u21b6 Undo", handler: () => state.history.undo() },
    { label: "\u2398 Dup", handler: duplicateSelected },
    { label: "\u2715 Del", cls: "dan", handler: deleteSelected },
    { label: "\u2b07 Export", cls: "pri", handler: () => {
      void import("../export/gltf-exporter").then(m => m.exportGLB());
    }},
    { label: "\ud83d\udcbe Save", handler: () => {
      void import("../export/gltf-exporter").then(m => m.saveToLibrary());
    }},
    { label: "\ud83d\udcc2 Load", handler: () => {
      void import("../export/gltf-exporter").then(m => m.loadModelFromFile());
    }},
  ];
  for (const item of items) {
    const b = document.createElement("button");
    b.className = "mbtn" + (item.cls ? " " + item.cls : "");
    b.textContent = item.label;
    b.setAttribute("aria-label", item.label);
    b.addEventListener("click", item.handler);
    el.appendChild(b);
  }

  // Camera lock toggle
  const camLock = document.createElement("button");
  camLock.className = "mbtn";
  camLock.id = "btnCamLock";
  camLock.textContent = "\ud83d\udd12 Cam";
  camLock.addEventListener("click", () => {
    state.cameraLocked = !state.cameraLocked;
    camLock.classList.toggle("on", state.cameraLocked);
    if (state.cameraLocked) {
      state.camera.detachControl();
      status("Camera locked");
    } else {
      state.camera.attachControl(state.canvas, true);
      status("Camera unlocked");
    }
  });
  el.appendChild(camLock);

  // Multi-select toggle
  const multi = document.createElement("button");
  multi.className = "mbtn";
  multi.id = "btnMulti";
  multi.textContent = "\u229a Multi";
  multi.addEventListener("click", () => {
    state.multiSelectMode = !state.multiSelectMode;
    multi.classList.toggle("on", state.multiSelectMode);
  });
  el.appendChild(multi);

  // Axis constraint buttons (visible only in transform modes)
  const axisWrap = document.createElement("div");
  axisWrap.id = "axisConstraint";
  axisWrap.className = "axis-btns";
  const axisItems: { label: string; value: "all" | "x" | "y" | "z" }[] = [
    { label: "ALL", value: "all" },
    { label: "X", value: "x" },
    { label: "Y", value: "y" },
    { label: "Z", value: "z" },
  ];
  for (const item of axisItems) {
    const b = document.createElement("button");
    b.className = "mbtn axis-btn" + (item.value === "all" ? " on" : "");
    b.textContent = item.label;
    b.dataset.axis = item.value;
    b.addEventListener("click", () => {
      state.gizmoAxis = item.value;
      axisWrap.querySelectorAll<HTMLElement>(".axis-btn").forEach((x) =>
        x.classList.toggle("on", x === b)
      );
      applyGizmoAxisConstraint();
    });
    axisWrap.appendChild(b);
  }
  el.appendChild(axisWrap);
}

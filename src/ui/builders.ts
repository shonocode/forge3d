import { E, isMobile, state, status } from "../state";
import type { ToolId } from "../state";
import { addPrimitive, PRIMS } from "../tools/primitives";
import { BRUSHES, setBrush } from "../tools/sculpt";
import { doCSG, type CSGOp } from "../tools/csg";
import { duplicateSelected, deleteSelected } from "../tools/actions";
import { setTool, switchTab, closeAllPanels, togglePanel } from "../input";
import { exportGLB, saveToLibrary, loadGLBFromFile } from "../export/gltf-exporter";
import { lastSelected } from "../tools/selection";
import {
  recalcNormals, flipNormals, weldVertices, centerOrigin,
  snapshotVertexData, restoreVertexData,
} from "../tools/mesh-utils";

export function buildToolPills(): void {
  const TOOLS: { id: ToolId; label: string }[] = [
    { id: "select", label: "SEL" },
    { id: "move", label: "MOV" },
    { id: "rotate", label: "ROT" },
    { id: "scale", label: "SCL" },
    { id: "sculpt", label: "SCP" },
    { id: "paint", label: "PNT" },
    { id: "bone", label: "BONE" },
    { id: "weight", label: "WGT" },
    { id: "anim", label: "ANM" },
  ];
  const el = E("pills");
  for (const t of TOOLS) {
    const b = document.createElement("button");
    b.className = "pill" + (t.id === "select" ? " on" : "");
    b.dataset.tool = t.id;
    b.textContent = t.label;
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
  for (const [i, t] of TAB_LIST.entries()) {
    const b = document.createElement("button");
    b.className = "tb" + (i === 0 ? " on" : "");
    b.dataset.tab = t.id;
    b.textContent = t.label;
    b.addEventListener("click", () => switchTab(t.id));
    el.appendChild(b);
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
    { label: "\u2b07 Export", cls: "pri", handler: () => void exportGLB() },
    { label: "\ud83d\udcbe Save", handler: () => void saveToLibrary() },
    { label: "\ud83d\udcc2 Load", handler: () => void loadGLBFromFile() },
    { label: "\u2398 Dup", handler: duplicateSelected },
    { label: "\u2715 Del", cls: "dan", handler: deleteSelected },
  ];
  for (const item of items) {
    const b = document.createElement("button");
    b.className = "mbtn" + (item.cls ? " " + item.cls : "");
    b.textContent = item.label;
    b.addEventListener("click", item.handler);
    el.appendChild(b);
  }

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
}

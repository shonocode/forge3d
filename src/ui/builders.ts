import { E, isMobile, state, status } from "../state";
import type { ToolId } from "../state";
import { addPrimitive, PRIMS } from "../tools/primitives";
import { BRUSHES, setBrush } from "../tools/sculpt";
import { doCSG, type CSGOp } from "../tools/csg";
import { duplicateSelected, deleteSelected } from "../tools/actions";
import { setTool, switchTab, closeAllPanels, togglePanel } from "../input";
import { lastSelected } from "../tools/selection";
import {
  recalcNormals, flipNormals, weldVertices, centerOrigin, applyShading,
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
    { id: "edit", label: "Edit" },
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
  const tools: { label: string; title?: string; action: (m: import("@babylonjs/core").AbstractMesh) => boolean }[] = [
    { label: "Recalc Normals", action: recalcNormals },
    { label: "Flip Normals", action: flipNormals },
    {
      label: "Shade Smooth",
      title: "全面をなめらかにシェーディング（頂点法線を平均化）",
      action: (m) => applyShading(m, Math.PI),
    },
    {
      label: "Shade Flat",
      title: "面ごとのフラットシェーディング（ハードエッジで頂点分割）",
      action: (m) => applyShading(m, 0.02),
    },
    {
      label: "Auto Smooth ∠",
      title: "下の角度より急な折り目だけハードエッジに（Blender の Auto Smooth 相当）",
      action: (m) => {
        const inp = document.getElementById("autoSmoothAngle") as HTMLInputElement | null;
        const deg = inp ? parseFloat(inp.value) : 30;
        const clamped = Number.isNaN(deg) ? 30 : Math.max(1, Math.min(180, deg));
        return applyShading(m, (clamped * Math.PI) / 180);
      },
    },
    { label: "Weld Vertices", action: (m) => weldVertices(m) },
    { label: "Center Origin", action: centerOrigin },
  ];
  for (const tool of tools) {
    const b = document.createElement("button");
    b.className = "cbtn";
    b.textContent = tool.label;
    b.setAttribute("aria-label", tool.label);
    if (tool.title) b.title = tool.title;
    b.addEventListener("click", () => {
      const m = lastSelected();
      if (!m) { status("メッシュを選択"); return; }
      const snap = snapshotVertexData(m);
      const ok = tool.action(m);
      if (!ok) { status("変更なし（モーフ付きメッシュはシェーディング変更不可）"); return; }
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

    // Angle input rides directly under its button.
    if (tool.label === "Auto Smooth ∠") {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:4px;margin:2px 0 4px;";
      const lab = document.createElement("span");
      lab.textContent = "角度°";
      lab.style.cssText = "font-size:9px;color:var(--t4);";
      const inp = document.createElement("input");
      inp.type = "number";
      inp.id = "autoSmoothAngle";
      inp.value = "30";
      inp.min = "1";
      inp.max = "180";
      inp.step = "5";
      inp.setAttribute("aria-label", "Auto smooth angle (degrees)");
      inp.style.cssText = "flex:1;font-size:10px;background:var(--bg2);color:var(--t1);border:1px solid var(--bg3);border-radius:3px;padding:1px 4px;";
      row.appendChild(lab);
      row.appendChild(inp);
      el.appendChild(row);
    }
  }
}

/**
 * Build the Edit Mode tools panel. Lives under the "Edit" tab and shows the
 * current component mode (V/E/F), per-op action buttons, and parameter
 * sliders for the operators that have tunable values.
 *
 * Buttons are grouped by mode applicability — operators only valid in a
 * specific mode (Inset = face, Bevel/Loop Cut = edge, Knife = vertex) are
 * disabled when the current mode doesn't match. We don't hide them so users
 * can see the full op palette and discover what each mode unlocks.
 */
export function buildEditToolsPanel(): void {
  const el = E("tb-edit");
  el.innerHTML = "";

  // Component mode selector (V/E/F)
  const modeSection = document.createElement("div");
  modeSection.className = "pg";
  modeSection.innerHTML = '<div class="pgt">Component Mode</div>';
  const modeRow = document.createElement("div");
  modeRow.style.cssText = "display:flex;gap:4px;";
  const MODES: { id: "vertex" | "edge" | "face"; label: string; key: string }[] = [
    { id: "vertex", label: "Vertex", key: "1" },
    { id: "edge",   label: "Edge",   key: "2" },
    { id: "face",   label: "Face",   key: "3" },
  ];
  for (const m of MODES) {
    const b = document.createElement("button");
    b.className = "abtn em-mode-btn";
    b.dataset.editMode = m.id;
    b.textContent = `${m.label} (${m.key})`;
    b.style.flex = "1";
    b.setAttribute("aria-label", `${m.label} mode`);
    b.addEventListener("click", () => {
      void import("../tools/edit-mode").then(({ setComponentMode, isEditMode }) => {
        if (!isEditMode()) {
          status("⚠ Enter Edit Mode (Tab) first");
          return;
        }
        setComponentMode(m.id);
        refreshEditToolsUI();
      });
    });
    modeRow.appendChild(b);
  }
  modeSection.appendChild(modeRow);
  el.appendChild(modeSection);

  // Gizmo transform mode (Move / Rotate / Scale)
  const gizmoSection = document.createElement("div");
  gizmoSection.className = "pg";
  gizmoSection.innerHTML = '<div class="pgt">Transform</div>';
  const gizmoRow = document.createElement("div");
  gizmoRow.style.cssText = "display:flex;gap:4px;";
  const GIZMO_MODES: { id: "move" | "rotate" | "scale"; label: string; key: string }[] = [
    { id: "move",   label: "Move",   key: "T" },
    { id: "rotate", label: "Rotate", key: "R" },
    { id: "scale",  label: "Scale",  key: "S" },
  ];
  for (const m of GIZMO_MODES) {
    const b = document.createElement("button");
    b.className = "abtn em-gizmo-btn" + (m.id === "move" ? " on" : "");
    b.dataset.gizmoMode = m.id;
    b.textContent = `${m.label} (${m.key})`;
    b.style.flex = "1";
    b.setAttribute("aria-label", `Gizmo ${m.label} mode`);
    b.addEventListener("click", () => {
      void import("../tools/edit-mode").then(({ setEditGizmoMode, isEditMode }) => {
        if (!isEditMode()) {
          status("⚠ Enter Edit Mode (Tab) first");
          return;
        }
        setEditGizmoMode(m.id);
      });
    });
    gizmoRow.appendChild(b);
  }
  gizmoSection.appendChild(gizmoRow);
  // Proportional editing toggle — applies to all three transforms.
  const propRow = document.createElement("label");
  propRow.style.cssText = "display:flex;align-items:center;gap:4px;font-size:10px;margin-top:6px;";
  const propChk = document.createElement("input");
  propChk.type = "checkbox";
  propChk.id = "em-proportional";
  propChk.checked = state.editConfig.proportional;
  propChk.setAttribute("aria-label", "Proportional editing");
  propChk.addEventListener("change", () => {
    state.editConfig.proportional = propChk.checked;
  });
  propRow.appendChild(propChk);
  propRow.appendChild(document.createTextNode(" ◉ Proportional (周辺も追従)"));
  propRow.title = "選択の周囲 Radius 内の頂点も減衰しながら一緒に動く (Blender の O)";
  gizmoSection.appendChild(propRow);
  gizmoSection.appendChild(
    makeSlider("Prop. Radius", "em-prop-radius", state.editConfig.proportionalRadius, 0.05, 3, 0.05, (v) => {
      state.editConfig.proportionalRadius = v;
    }),
  );
  el.appendChild(gizmoSection);

  // Operator buttons section
  const opSection = document.createElement("div");
  opSection.className = "pg";
  opSection.innerHTML = '<div class="pgt">Operators</div>';

  type Op = {
    label: string;
    key: string;
    modes: Array<"vertex" | "edge" | "face">;
    action: () => Promise<void>;
  };
  const ops: Op[] = [
    {
      label: "Extrude",
      key: "E",
      modes: ["face", "edge"],
      action: async () => (await import("../tools/edit-mode")).extrudeSelection(),
    },
    {
      label: "Inset",
      key: "I",
      modes: ["face"],
      action: async () => (await import("../tools/edit-mode")).insetSelection(),
    },
    {
      label: "Bevel",
      key: "Ctrl+B",
      modes: ["edge"],
      action: async () => (await import("../tools/edit-mode")).bevelSelection(),
    },
    {
      label: "Loop Cut",
      key: "Ctrl+R",
      modes: ["edge"],
      action: async () => (await import("../tools/edit-mode")).loopCutSelection(),
    },
    {
      label: "Knife",
      key: "K",
      modes: ["vertex", "edge", "face"],
      action: async () => { (await import("../tools/edit-mode")).startKnifeCut(); },
    },
    {
      // 実態は隣接 2 三角形の対角線フリップ（本物のカットは Knife）。
      label: "Flip Diagonal",
      key: "F",
      modes: ["vertex"],
      action: async () => (await import("../tools/edit-mode")).knifeSelection(),
    },
    {
      label: "Edge Slide",
      key: "G",
      modes: ["edge"],
      action: async () => (await import("../tools/edit-mode")).edgeSlideSelection(),
    },
    {
      label: "Vertex Slide",
      key: "Shift+V",
      modes: ["vertex"],
      action: async () => (await import("../tools/edit-mode")).vertexSlideSelection(),
    },
    {
      label: "Merge",
      key: "M",
      modes: ["vertex", "edge"],
      action: async () => (await import("../tools/edit-mode")).mergeSelection(),
    },
    {
      label: "Bridge Loops",
      key: "Ctrl+E",
      modes: ["edge"],
      action: async () => (await import("../tools/edit-mode")).bridgeSelection(),
    },
    {
      label: "Mark Seam",
      key: "Shift+S",
      modes: ["edge"],
      action: async () => (await import("../tools/edit-mode")).markSeamSelection(),
    },
    {
      label: "Mark Crease",
      key: "Shift+E",
      modes: ["edge"],
      action: async () => (await import("../tools/edit-mode")).markCreaseSelection(),
    },
    {
      label: "Tris to Quads",
      key: "J",
      modes: ["vertex", "edge", "face"],
      action: async () => (await import("../tools/edit-mode")).trisToQuadsSelection(),
    },
    {
      label: "Quads to Tris",
      key: "Ctrl+T",
      modes: ["vertex", "edge", "face"],
      action: async () => (await import("../tools/edit-mode")).quadsToTrisSelection(),
    },
    {
      label: "Subdivide (CC)",
      key: "Ctrl+D",
      modes: ["vertex", "edge", "face"],
      action: async () => (await import("../tools/edit-mode")).subdivideSelection(),
    },
    {
      label: "Delete",
      key: "X",
      modes: ["vertex", "edge", "face"],
      action: async () => (await import("../tools/edit-mode")).deleteSelection(),
    },
  ];

  for (const op of ops) {
    const b = document.createElement("button");
    b.className = "abtn em-op-btn";
    b.dataset.editModes = op.modes.join(",");
    b.dataset.editOp = op.label;
    b.innerHTML = `<span>${op.label}</span><span style="float:right;color:var(--t4);font-size:9px">${op.key}</span>`;
    b.setAttribute("aria-label", `${op.label} (${op.key})`);
    b.style.cssText = "text-align:left;display:block;width:100%;";
    b.addEventListener("click", () => { void op.action(); });
    opSection.appendChild(b);
  }
  el.appendChild(opSection);

  // Selection helpers
  const selSection = document.createElement("div");
  selSection.className = "pg";
  selSection.innerHTML = '<div class="pgt">Selection</div>';
  for (const [label, key, handler] of [
    ["Select All", "A", "selectAllComponents"],
    ["Box Select", "B", "startBoxSelect"],
    ["Clear",      "Esc", "clearComponentSelection"],
  ] as const) {
    const b = document.createElement("button");
    b.className = "abtn";
    b.innerHTML = `<span>${label}</span><span style="float:right;color:var(--t4);font-size:9px">${key}</span>`;
    b.style.cssText = "text-align:left;display:block;width:100%;";
    b.addEventListener("click", () => {
      void import("../tools/edit-mode").then((mod) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (mod as any)[handler]?.();
      });
    });
    selSection.appendChild(b);
  }
  el.appendChild(selSection);

  // UV Unwrap section — sits outside the mode-gated op list because Unwrap
  // operates on the whole mesh regardless of which component mode is active.
  const uvSection = document.createElement("div");
  uvSection.className = "pg";
  uvSection.innerHTML = '<div class="pgt">UV Unwrap</div>';
  const unwrapBtn = document.createElement("button");
  unwrapBtn.className = "abtn";
  unwrapBtn.innerHTML = '<span>Smart UV Project</span><span style="float:right;color:var(--t4);font-size:9px">U</span>';
  unwrapBtn.style.cssText = "text-align:left;display:block;width:100%;";
  unwrapBtn.addEventListener("click", () => {
    void import("../tools/edit-mode").then((mod) => mod.unwrapMesh());
  });
  uvSection.appendChild(unwrapBtn);
  const uvEditorBtn = document.createElement("button");
  uvEditorBtn.className = "abtn";
  uvEditorBtn.innerHTML = "<span>🗺 UV Editor</span>";
  uvEditorBtn.title = "2D UV ビューで島の移動 / 回転 / 拡縮、頂点編集、ストレッチ可視化";
  uvEditorBtn.style.cssText = "text-align:left;display:block;width:100%;";
  uvEditorBtn.addEventListener("click", () => {
    void import("./uv-editor").then((mod) => mod.openUVEditor());
  });
  uvSection.appendChild(uvEditorBtn);
  const seamHelp = document.createElement("div");
  seamHelp.style.cssText = "font-size:9px;color:var(--t4);line-height:1.5;margin-top:6px;";
  seamHelp.innerHTML = "Edge mode で辺を選び <b>Mark Seam</b> でシーム指定 → <b>Smart UV Project</b><br>" +
    "展開後は <b>🗺 UV Editor</b> でレイアウト調整<br>" +
    "<span style=\"color:var(--red)\">⚠ rig 済みメッシュには使えない</span>";
  uvSection.appendChild(seamHelp);
  el.appendChild(uvSection);

  // Parameter sliders
  const paramSection = document.createElement("div");
  paramSection.className = "pg";
  paramSection.innerHTML = '<div class="pgt">Parameters</div>';

  paramSection.appendChild(
    makeSlider("Inset Amount", "em-inset-amount", state.editConfig.insetAmount, 0, 0.5, 0.01, (v) => {
      state.editConfig.insetAmount = v;
    }),
  );
  paramSection.appendChild(
    makeSlider("Bevel Width", "em-bevel-width", state.editConfig.bevelWidth, 0, 0.49, 0.01, (v) => {
      state.editConfig.bevelWidth = v;
    }),
  );
  paramSection.appendChild(
    makeSlider("Slide Amount", "em-slide-amount", state.editConfig.slideAmount, -0.95, 0.95, 0.05, (v) => {
      state.editConfig.slideAmount = v;
    }),
  );
  paramSection.appendChild(
    makeSlider("Crease Weight", "em-crease-weight", state.editConfig.creaseWeight, 0, 4, 0.5, (v) => {
      state.editConfig.creaseWeight = v;
    }),
  );
  el.appendChild(paramSection);

  // Help footer
  const help = document.createElement("div");
  help.style.cssText = "margin-top:8px;font-size:9px;color:var(--t4);line-height:1.6;padding:6px;";
  help.innerHTML =
    "<b>Tab</b> ↔ Object Mode<br>" +
    "<b>Click</b>: select · <b>Ctrl+click</b>: add<br>" +
    "<b>Ctrl+Z / Shift+Ctrl+Z</b>: undo / redo";
  el.appendChild(help);

  refreshEditToolsUI();
}

function makeSlider(
  label: string,
  id: string,
  initial: number,
  min: number,
  max: number,
  step: number,
  onChange: (v: number) => void,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "sr";
  const lab = document.createElement("label");
  const valSpan = document.createElement("span");
  valSpan.textContent = initial.toFixed(2);
  lab.appendChild(document.createTextNode(label + " "));
  lab.appendChild(valSpan);
  wrap.appendChild(lab);

  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(initial);
  input.id = id;
  input.setAttribute("aria-label", label);
  input.addEventListener("input", () => {
    const v = parseFloat(input.value);
    valSpan.textContent = v.toFixed(2);
    onChange(v);
  });
  wrap.appendChild(input);
  return wrap;
}

/**
 * Update the Edit Tools UI to reflect the current state — disable ops that
 * don't match the active component mode, highlight the current mode button.
 * Safe to call from anywhere; no-op if the panel hasn't been built yet.
 */
export function refreshEditToolsUI(): void {
  // Component-mode buttons
  const currentMode = state.editSelection.mode;
  for (const b of document.querySelectorAll<HTMLElement>(".em-mode-btn")) {
    b.classList.toggle("on", b.dataset.editMode === currentMode);
  }
  // Gizmo transform-mode buttons
  void import("../tools/edit-mode").then(({ getEditGizmoMode }) => {
    const gm = getEditGizmoMode();
    for (const b of document.querySelectorAll<HTMLElement>(".em-gizmo-btn")) {
      b.classList.toggle("on", b.dataset.gizmoMode === gm);
    }
  });
  // Operator buttons: enable only those matching current mode (when in Edit Mode)
  const inEdit = state.editMesh !== null;
  for (const b of document.querySelectorAll<HTMLButtonElement>(".em-op-btn")) {
    const modes = (b.dataset.editModes ?? "").split(",");
    const enabled = inEdit && modes.includes(currentMode);
    b.disabled = !enabled;
    b.style.opacity = enabled ? "1" : "0.4";
  }
}

export function buildGizmoFAB(): void {
  const el = E("gizmoFab");
  const GIZMO_TOOLS: { id: ToolId; icon: string; aria: string }[] = [
    { id: "select", icon: "\u2196", aria: "Select tool" },
    { id: "move",   icon: "\u2725", aria: "Move tool" },
    { id: "rotate", icon: "\u21bb", aria: "Rotate tool" },
    { id: "scale",  icon: "\u2921", aria: "Scale tool" },
  ];
  for (const t of GIZMO_TOOLS) {
    const b = document.createElement("button");
    b.className = "gfab-btn" + (t.id === "select" ? " on" : "");
    b.dataset.tool = t.id;
    b.textContent = t.icon;
    b.setAttribute("aria-label", t.aria);
    b.addEventListener("click", () => setTool(t.id));
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

  // Edit Mode toggle \u2014 the desktop equivalent is Tab, which mobile keyboards
  // either lack entirely or hide behind multiple submenus. A dedicated button
  // is the only practical entrypoint to component editing on touch devices.
  const editBtn = document.createElement("button");
  editBtn.className = "mbtn";
  editBtn.id = "btnMobEdit";
  editBtn.textContent = "\u270e Edit";
  editBtn.setAttribute("aria-label", "Toggle Edit Mode");
  editBtn.addEventListener("click", () => {
    void import("../tools/edit-mode").then((mod) => mod.toggleEditMode());
  });
  el.appendChild(editBtn);
}

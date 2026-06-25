import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { state, status } from "../state";
import { openFileDialog } from "./file-input";
import { serializeGraph, deserializeGraph } from "../materials/graph-io";
import {
  NODE_DEFS,
  addNode,
  removeNode,
  connect,
  disconnect,
  type PortKind,
} from "../materials/graph-ops";
import {
  makeNoiseGraph,
  type ProceduralGraph,
  type ProcNode,
  type ProcNodeType,
  type ProcParams,
} from "../materials/procedural-graph";
import {
  getProceduralGraph,
  getProceduralPreset,
  bakeProceduralToMesh,
  captureProceduralSnapshot,
  restoreProceduralSnapshot,
  type MatSnapshot,
} from "../materials/procedural-material";

/**
 * Visual node-graph editor for procedural materials. A full-screen overlay
 * with draggable node boxes, drag-to-wire ports, and live re-bake onto the
 * selected mesh. Graph mutation rules (incl. cycle prevention) live in the
 * pure `graph-ops` module; this file is the DOM/interaction layer only.
 *
 * Editing happens on a draft clone. Live preview bakes the draft onto the mesh
 * with no undo; Apply pushes a single undo entry (restoring the pre-edit
 * state), Cancel reverts to it.
 */

const NODE_W = 168;
const HEADER_H = 24;
const ROW_H = 20;
const PORT_R = 5;

const PORT_COLOR: Record<PortKind, string> = { float: "#9fd0a0", color: "#e0c060" };

interface ParamSpec {
  key: keyof ProcParams;
  label: string;
  type: "range" | "number" | "color" | "check" | "select";
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
}

const PARAM_SPECS: Partial<Record<ProcNodeType, ParamSpec[]>> = {
  mapping: [
    { key: "scale", label: "Scale", type: "range", min: 0.2, max: 16, step: 0.1 },
    { key: "offsetX", label: "Off X", type: "number", step: 0.05 },
    { key: "offsetY", label: "Off Y", type: "number", step: 0.05 },
    { key: "rotation", label: "Rot", type: "range", min: -3.14, max: 3.14, step: 0.01 },
  ],
  noise: [
    { key: "scale", label: "Scale", type: "range", min: 1, max: 48, step: 1 },
    { key: "contrast", label: "Contrast", type: "range", min: 0.5, max: 6, step: 0.1 },
    { key: "seed", label: "Seed", type: "number" },
  ],
  voronoi: [
    { key: "scale", label: "Scale", type: "range", min: 1, max: 32, step: 1 },
    { key: "contrast", label: "Contrast", type: "range", min: 0.5, max: 6, step: 0.1 },
    { key: "seed", label: "Seed", type: "number" },
  ],
  brick: [
    { key: "scale", label: "Rows", type: "range", min: 1, max: 24, step: 1 },
    { key: "contrast", label: "Mortar", type: "range", min: 0.02, max: 0.4, step: 0.01 },
  ],
  checker: [{ key: "scale", label: "Scale", type: "range", min: 1, max: 32, step: 1 }],
  gradient: [{ key: "axis", label: "Vertical", type: "check" }],
  colorRamp: [
    { key: "colorA", label: "A", type: "color" },
    { key: "colorB", label: "B", type: "color" },
  ],
  constColor: [{ key: "colorA", label: "Color", type: "color" }],
  constFloat: [{ key: "value", label: "Value", type: "range", min: 0, max: 1, step: 0.01 }],
  mix: [{ key: "op", label: "Mode", type: "select", options: ["Mix", "Add", "Multiply", "Screen"] }],
  math: [
    { key: "op", label: "Op", type: "select", options: ["Add", "Subtract", "Multiply", "Min", "Max", "Average"] },
    { key: "value", label: "B (if unwired)", type: "range", min: 0, max: 2, step: 0.05 },
  ],
};

function cloneGraph(g: ProceduralGraph): ProceduralGraph {
  return JSON.parse(JSON.stringify(g)) as ProceduralGraph;
}

/** Assign columnar positions to any node missing x/y, by dependency depth. */
function autoLayout(graph: ProceduralGraph): void {
  if (graph.nodes.every((n) => n.x != null && n.y != null)) return;
  const depth = new Map<string, number>();
  const visit = (id: string, d: number): void => {
    const cur = depth.get(id);
    if (cur != null && cur >= d) return;
    depth.set(id, d);
    const node = graph.nodes.find((n) => n.id === id);
    if (!node?.inputs) return;
    for (const src of Object.values(node.inputs)) if (src) visit(src, d + 1);
  };
  visit(graph.outputId, 0);
  const maxD = Math.max(0, ...depth.values());
  const colCount = new Map<number, number>();
  for (const n of graph.nodes) {
    if (n.x != null && n.y != null) continue;
    const d = depth.get(n.id) ?? maxD + 1;
    const col = maxD - d; // output (d=0) is rightmost
    const row = colCount.get(col) ?? 0;
    colCount.set(col, row + 1);
    n.x = 24 + col * (NODE_W + 56);
    n.y = 24 + row * 150;
  }
}

const inputPortPos = (n: ProcNode, i: number): [number, number] => [
  (n.x ?? 0),
  (n.y ?? 0) + HEADER_H + i * ROW_H + ROW_H / 2,
];
const outputPortPos = (n: ProcNode): [number, number] => [(n.x ?? 0) + NODE_W, (n.y ?? 0) + HEADER_H / 2];

/** Open the node editor for `mesh`. Self-contained; manages its own overlay. */
export function openNodeEditor(mesh: AbstractMesh): void {
  const original = getProceduralGraph(mesh);
  const originalPreset = getProceduralPreset(mesh);
  const snap: MatSnapshot | null = captureProceduralSnapshot(mesh);
  const draft: ProceduralGraph = cloneGraph(original ?? makeNoiseGraph({}));
  autoLayout(draft);

  const preview = (): void => bakeProceduralToMesh(mesh, cloneGraph(draft), { node: true });

  // ── overlay scaffold ──
  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:9999;background:rgba(10,12,16,0.82);display:flex;flex-direction:column;font-family:inherit;";

  const bar = document.createElement("div");
  bar.style.cssText =
    "display:flex;align-items:center;gap:6px;padding:8px 12px;background:var(--bg2,#1a1d24);border-bottom:1px solid var(--bg3,#2a2e38);flex-wrap:wrap;";
  bar.innerHTML = `<strong style="font-size:12px;margin-right:8px">Node Editor</strong>`;

  const palette = document.createElement("div");
  palette.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;flex:1";
  for (const [type, def] of Object.entries(NODE_DEFS)) {
    if (!def.addable) continue;
    const b = document.createElement("button");
    b.className = "abtn";
    b.style.cssText = "padding:2px 7px;font-size:10px;min-width:0";
    b.textContent = "+ " + def.title;
    b.addEventListener("click", () => {
      const n = addNode(draft, type as ProcNodeType, 40 + scroll.scrollLeft + 20, 40 + scroll.scrollTop + 20);
      // nudge so stacked adds don't overlap perfectly
      n.y = (n.y ?? 40) + (draft.nodes.length % 5) * 12;
      render();
      preview();
    });
    palette.appendChild(b);
  }
  bar.appendChild(palette);

  const exportBtn = document.createElement("button");
  exportBtn.className = "abtn";
  exportBtn.style.cssText = "font-size:11px";
  exportBtn.textContent = "⬇ Export";
  exportBtn.title = "Download this graph as JSON";
  exportBtn.addEventListener("click", () => {
    const blob = new Blob([serializeGraph(draft)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "material-graph.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const importBtn = document.createElement("button");
  importBtn.className = "abtn";
  importBtn.style.cssText = "font-size:11px";
  importBtn.textContent = "📂 Import";
  importBtn.title = "Load a graph from JSON";
  importBtn.addEventListener("click", () => {
    openFileDialog("application/json,.json", async (file) => {
      try {
        const g = deserializeGraph(await file.text());
        draft.nodes = g.nodes;
        draft.outputId = g.outputId;
        draft.resolution = g.resolution;
        autoLayout(draft);
        render();
        preview();
        status("Graph imported");
      } catch (e) {
        status("⚠ Import failed: " + (e instanceof Error ? e.message : "invalid file"));
      }
    });
  });
  bar.appendChild(exportBtn);
  bar.appendChild(importBtn);

  const applyBtn = document.createElement("button");
  applyBtn.className = "abtn pri";
  applyBtn.style.cssText = "font-size:11px";
  applyBtn.textContent = "Apply & Close";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "abtn";
  cancelBtn.style.cssText = "font-size:11px";
  cancelBtn.textContent = "Cancel";
  bar.appendChild(applyBtn);
  bar.appendChild(cancelBtn);
  overlay.appendChild(bar);

  // Scrollable canvas region.
  const scroll = document.createElement("div");
  scroll.style.cssText = "position:relative;flex:1;overflow:auto;";
  const canvas = document.createElement("div");
  canvas.style.cssText = "position:relative;width:2400px;height:1600px;";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("style", "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;");
  canvas.appendChild(svg);
  scroll.appendChild(canvas);
  overlay.appendChild(scroll);
  document.body.appendChild(overlay);

  // ── interaction state ──
  let dragNode: { node: ProcNode; offX: number; offY: number } | null = null;
  let wireDrag: { sourceId: string; tempPath: SVGPathElement } | null = null;

  const close = (): void => {
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
    overlay.remove();
  };

  applyBtn.addEventListener("click", () => {
    const finalGraph = cloneGraph(draft);
    bakeProceduralToMesh(mesh, finalGraph, { node: true });
    state.history.push({
      label: "Edit Node Graph",
      undo() {
        if (original) bakeProceduralToMesh(mesh, original, originalPreset);
        else if (snap) restoreProceduralSnapshot(mesh, snap);
      },
      redo() {
        bakeProceduralToMesh(mesh, finalGraph, { node: true });
      },
    });
    close();
  });
  cancelBtn.addEventListener("click", () => {
    if (original) bakeProceduralToMesh(mesh, original, originalPreset);
    else if (snap) restoreProceduralSnapshot(mesh, snap);
    close();
  });

  // ── rendering ──
  function wirePath(x1: number, y1: number, x2: number, y2: number): string {
    const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`;
  }

  function renderWires(): void {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    for (const node of draft.nodes) {
      const def = NODE_DEFS[node.type];
      def.inputs.forEach((port, i) => {
        const srcId = node.inputs?.[port.name];
        if (!srcId) return;
        const src = draft.nodes.find((n) => n.id === srcId);
        if (!src) return;
        const [sx, sy] = outputPortPos(src);
        const [tx, ty] = inputPortPos(node, i);
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", wirePath(sx, sy, tx, ty));
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", PORT_COLOR[port.kind]);
        path.setAttribute("stroke-width", "2");
        path.setAttribute("opacity", "0.85");
        svg.appendChild(path);
      });
    }
  }

  function makePort(kind: PortKind, side: "in" | "out"): HTMLElement {
    const dot = document.createElement("div");
    dot.style.cssText = `position:absolute;${side === "in" ? "left" : "right"}:-${PORT_R}px;width:${PORT_R * 2}px;height:${PORT_R * 2}px;border-radius:50%;background:${PORT_COLOR[kind]};border:1px solid #0008;cursor:crosshair;transform:translateY(-50%);`;
    return dot;
  }

  function buildParamControls(node: ProcNode): HTMLElement {
    const wrap = document.createElement("div");
    wrap.style.cssText = "padding:4px 8px;display:flex;flex-direction:column;gap:3px;";
    const specs = PARAM_SPECS[node.type] ?? [];
    if (!node.params) node.params = {};
    for (const spec of specs) {
      const row = document.createElement("label");
      row.style.cssText = "display:flex;align-items:center;gap:5px;font-size:9px;color:var(--t3,#9aa);";
      const lab = document.createElement("span");
      lab.textContent = spec.label;
      lab.style.cssText = "min-width:42px";
      row.appendChild(lab);
      const params = node.params as Record<string, unknown>;
      if (spec.type === "select") {
        const sel = document.createElement("select");
        sel.style.cssText = "flex:1;min-width:0;font-size:9px";
        (spec.options ?? []).forEach((opt, idx) => {
          const o = document.createElement("option");
          o.value = String(idx);
          o.textContent = opt;
          sel.appendChild(o);
        });
        sel.value = String((params[spec.key as string] as number) ?? 0);
        sel.addEventListener("change", () => { params[spec.key as string] = +sel.value; preview(); });
        row.appendChild(sel);
        wrap.appendChild(row);
        continue;
      }
      const inp = document.createElement("input");
      if (spec.type === "color") {
        inp.type = "color";
        inp.value = (params[spec.key as string] as string) ?? "#808080";
        inp.style.cssText = "flex:1;min-height:18px;padding:0;border:none;background:none";
        inp.addEventListener("input", () => { params[spec.key as string] = inp.value; preview(); });
      } else if (spec.type === "check") {
        inp.type = "checkbox";
        inp.checked = (params[spec.key as string] as number) === 1;
        inp.style.marginLeft = "auto";
        inp.addEventListener("change", () => { params[spec.key as string] = inp.checked ? 1 : 0; preview(); });
      } else {
        inp.type = spec.type === "range" ? "range" : "number";
        if (spec.min != null) inp.min = String(spec.min);
        if (spec.max != null) inp.max = String(spec.max);
        if (spec.step != null) inp.step = String(spec.step);
        inp.value = String((params[spec.key as string] as number) ?? 0);
        inp.style.cssText = "flex:1;min-width:0";
        inp.addEventListener("input", () => {
          const v = +inp.value;
          if (!Number.isNaN(v)) { params[spec.key as string] = v; preview(); }
        });
      }
      row.appendChild(inp);
      wrap.appendChild(row);
    }
    return wrap;
  }

  function render(): void {
    // Clear node divs (keep the svg).
    for (const child of Array.from(canvas.children)) {
      if (child !== svg) canvas.removeChild(child);
    }
    for (const node of draft.nodes) {
      const def = NODE_DEFS[node.type];
      const el = document.createElement("div");
      el.style.cssText = `position:absolute;left:${node.x ?? 0}px;top:${node.y ?? 0}px;width:${NODE_W}px;background:var(--bg2,#1a1d24);border:1px solid var(--bg3,#39414f);border-radius:5px;box-shadow:0 2px 8px #0006;font-size:10px;`;

      // Header (drag handle + delete).
      const header = document.createElement("div");
      header.style.cssText = `height:${HEADER_H}px;display:flex;align-items:center;padding:0 6px;background:var(--bg3,#2a2f3a);border-radius:5px 5px 0 0;cursor:move;font-weight:600;`;
      const title = document.createElement("span");
      title.textContent = def.title;
      title.style.flex = "1";
      header.appendChild(title);
      if (node.id !== draft.outputId) {
        const del = document.createElement("button");
        del.textContent = "✕";
        del.title = "Delete node";
        del.style.cssText = "background:none;border:none;color:#e88;cursor:pointer;font-size:10px;padding:0 2px;";
        del.addEventListener("pointerdown", (e) => e.stopPropagation());
        del.addEventListener("click", () => { removeNode(draft, node.id); render(); preview(); });
        header.appendChild(del);
      }
      header.addEventListener("pointerdown", (e) => {
        dragNode = { node, offX: e.clientX - (node.x ?? 0), offY: e.clientY - (node.y ?? 0) };
        e.preventDefault();
      });
      // Output port on the header (right-center).
      if (def.out) {
        const op = makePort(def.out, "out");
        op.style.top = `${HEADER_H / 2}px`;
        op.title = "Drag to an input to connect";
        op.addEventListener("pointerdown", (e) => {
          e.stopPropagation();
          startWire(node.id);
        });
        el.appendChild(op);
      }
      el.appendChild(header);

      // Input ports + labels.
      def.inputs.forEach((port) => {
        const row = document.createElement("div");
        row.style.cssText = `position:relative;height:${ROW_H}px;display:flex;align-items:center;padding-left:10px;color:var(--t3,#9aa);`;
        const ip = makePort(port.kind, "in");
        ip.style.top = `${ROW_H / 2}px`;
        const connected = !!node.inputs?.[port.name];
        ip.title = connected ? "Click to disconnect" : "Drop a wire here";
        ip.dataset.nodeId = node.id;
        ip.dataset.input = port.name;
        ip.classList.add("ne-inport");
        if (connected) ip.style.outline = "2px solid #fff6";
        ip.addEventListener("click", () => {
          if (node.inputs?.[port.name]) { disconnect(draft, node.id, port.name); render(); preview(); }
        });
        row.appendChild(ip);
        const lab = document.createElement("span");
        lab.textContent = port.name;
        row.appendChild(lab);
        el.appendChild(row);
      });

      el.appendChild(buildParamControls(node));
      canvas.appendChild(el);
    }
    renderWires();
  }

  // ── wire dragging ──
  function startWire(sourceId: string): void {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "#fff");
    path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-dasharray", "4 3");
    svg.appendChild(path);
    wireDrag = { sourceId, tempPath: path };
  }

  function canvasPoint(e: PointerEvent): [number, number] {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function onPointerMove(e: PointerEvent): void {
    if (dragNode) {
      dragNode.node.x = e.clientX - dragNode.offX;
      dragNode.node.y = e.clientY - dragNode.offY;
      render();
      return;
    }
    if (wireDrag) {
      const src = draft.nodes.find((n) => n.id === wireDrag!.sourceId);
      if (!src) return;
      const [sx, sy] = outputPortPos(src);
      const [mx, my] = canvasPoint(e);
      wireDrag.tempPath.setAttribute("d", wirePath(sx, sy, mx, my));
    }
  }

  function onPointerUp(e: PointerEvent): void {
    if (dragNode) { dragNode = null; return; }
    if (wireDrag) {
      const target = (e.target as HTMLElement)?.closest?.(".ne-inport") as HTMLElement | null;
      if (target?.dataset.nodeId && target.dataset.input) {
        connect(draft, wireDrag.sourceId, target.dataset.nodeId, target.dataset.input);
      }
      wireDrag.tempPath.remove();
      wireDrag = null;
      render();
      preview();
    }
  }

  document.addEventListener("pointermove", onPointerMove);
  document.addEventListener("pointerup", onPointerUp);

  render();
  preview();
}

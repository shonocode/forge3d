import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { state, status } from "../state";
import { lastSelected } from "../tools/selection";
import { escapeHtml } from "./escape";
import {
  computeFaceStretch,
  computeUVIslands,
  faceAtUVPoint,
  rotateUVs,
  scaleUVs,
  stretchToColor,
  translateUVs,
  uvBounds,
  type UVIslands,
} from "../tools/edit-mode/uv-edit";

/**
 * 2D UV editor (F-M9) — full-screen overlay with a canvas view of the UV
 * layout. Island mode drags whole islands (Move / Rotate / Scale, keys
 * G / R / S), vertex mode drags individual UV verts. A stretch heat overlay
 * (blue = uniform, red = distorted) can be toggled at any time.
 *
 * Editing happens on a draft copy of the mesh's UV buffer, live-previewed on
 * the mesh each drag. Apply pushes one undo entry; Cancel / Esc restores the
 * original buffer. Pure math (islands, transforms, stretch) lives in
 * `tools/edit-mode/uv-edit.ts`; this file is the DOM/canvas layer only.
 */

type EditorMode = "island" | "vertex";
type XformMode = "move" | "rotate" | "scale";

const VERTEX_PICK_PX = 9;

export function openUVEditor(): void {
  const mesh = (state.editMesh?.source ?? lastSelected()) as Mesh | undefined;
  if (!mesh || !("getVerticesData" in mesh) || typeof mesh.getVerticesData !== "function") {
    status("⚠ UV Editor: メッシュを選択してから開く");
    return;
  }
  const rawUV = mesh.getVerticesData(VertexBuffer.UVKind);
  const rawPos = mesh.getVerticesData(VertexBuffer.PositionKind);
  const rawIdx = mesh.getIndices();
  if (!rawUV || !rawPos || !rawIdx || rawIdx.length === 0) {
    status("⚠ UV Editor: UV がない — 先に Smart UV Project を実行");
    return;
  }

  const positions = new Float32Array(rawPos);
  const indices: number[] = Array.from(rawIdx);
  const orig = new Float32Array(rawUV);
  const draft = new Float32Array(rawUV);
  const vertexCount = orig.length / 2;
  const islandData: UVIslands = computeUVIslands(indices, vertexCount);

  // Replace the UV buffer with an updatable copy so drags can live-preview.
  mesh.setVerticesData(VertexBuffer.UVKind, draft, true);
  const preview = (): void => {
    mesh.updateVerticesData(VertexBuffer.UVKind, draft);
  };

  // ── editor state ──
  let editorMode: EditorMode = "island";
  let xform: XformMode = "move";
  let stretchOn = false;
  let faceStretch: Float32Array | null = null;
  let selIsland = -1;
  const selVerts = new Set<number>();

  // View transform: screen = (ox + u·viewScale, oy − v·viewScale).
  let viewScale = 400;
  let ox = 0;
  let oy = 0;

  // Drag state.
  let drag: {
    verts: number[];
    snap: Float32Array; // uv pairs parallel to verts
    startU: number;
    startV: number;
    pivotU: number;
    pivotV: number;
  } | null = null;
  let pan: { x: number; y: number } | null = null;

  // ── overlay scaffold ──
  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:9999;background:rgba(10,12,16,0.92);display:flex;flex-direction:column;font-family:inherit;";

  const bar = document.createElement("div");
  bar.style.cssText =
    "display:flex;align-items:center;gap:6px;padding:8px 12px;background:var(--bg2,#1a1d24);border-bottom:1px solid var(--bg3,#2a2e38);flex-wrap:wrap;";
  bar.innerHTML = `<strong style="font-size:12px">UV Editor</strong><span style="font-size:10px;color:var(--t4)">${escapeHtml(mesh.name)}</span>`;

  const makeToggle = (label: string, title: string): HTMLButtonElement => {
    const b = document.createElement("button");
    b.className = "abtn bon";
    b.style.cssText = "width:auto;padding:3px 9px;font-size:10px;";
    b.textContent = label;
    b.title = title;
    return b;
  };

  const modeBtns: Record<EditorMode, HTMLButtonElement> = {
    island: makeToggle("Island", "島単位で選択・変形 (I)"),
    vertex: makeToggle("Vertex", "UV 頂点を個別に移動 (V)"),
  };
  const xformBtns: Record<XformMode, HTMLButtonElement> = {
    move: makeToggle("Move", "ドラッグで島を移動 (G)"),
    rotate: makeToggle("Rotate", "ピボット周りに回転 (R)"),
    scale: makeToggle("Scale", "ピボット基準で拡縮 (S)"),
  };
  const syncToggles = (): void => {
    (Object.keys(modeBtns) as EditorMode[]).forEach((m) => modeBtns[m].classList.toggle("on", editorMode === m));
    (Object.keys(xformBtns) as XformMode[]).forEach((m) => {
      xformBtns[m].classList.toggle("on", xform === m);
      // Rotate / Scale only make sense on whole islands.
      xformBtns[m].disabled = editorMode === "vertex" && m !== "move";
      xformBtns[m].style.opacity = xformBtns[m].disabled ? "0.4" : "1";
    });
  };
  const setEditorMode = (m: EditorMode): void => {
    editorMode = m;
    if (m === "vertex") xform = "move";
    else selVerts.clear();
    syncToggles();
    draw();
  };
  const setXform = (m: XformMode): void => {
    if (editorMode === "vertex" && m !== "move") return;
    xform = m;
    syncToggles();
  };
  modeBtns.island.addEventListener("click", () => setEditorMode("island"));
  modeBtns.vertex.addEventListener("click", () => setEditorMode("vertex"));
  xformBtns.move.addEventListener("click", () => setXform("move"));
  xformBtns.rotate.addEventListener("click", () => setXform("rotate"));
  xformBtns.scale.addEventListener("click", () => setXform("scale"));

  const group = (els: HTMLElement[]): HTMLElement => {
    const g = document.createElement("div");
    g.style.cssText = "display:flex;gap:3px;margin-left:8px;";
    for (const el of els) g.appendChild(el);
    return g;
  };
  bar.appendChild(group([modeBtns.island, modeBtns.vertex]));
  bar.appendChild(group([xformBtns.move, xformBtns.rotate, xformBtns.scale]));

  const stretchRow = document.createElement("label");
  stretchRow.style.cssText = "display:flex;align-items:center;gap:4px;font-size:10px;margin-left:10px;color:var(--t3,#9aa);cursor:pointer;";
  const stretchChk = document.createElement("input");
  stretchChk.type = "checkbox";
  stretchChk.addEventListener("change", () => {
    stretchOn = stretchChk.checked;
    if (stretchOn) faceStretch = computeFaceStretch(positions, draft, indices);
    draw();
  });
  stretchRow.appendChild(stretchChk);
  stretchRow.appendChild(document.createTextNode("🌡 ストレッチ表示 (青=均一 / 赤=歪み)"));
  bar.appendChild(stretchRow);

  const spacer = document.createElement("div");
  spacer.style.flex = "1";
  bar.appendChild(spacer);

  const help = document.createElement("span");
  help.style.cssText = "font-size:9px;color:var(--t4);";
  help.textContent = "ホイール: ズーム · 中/右ドラッグ: パン · Esc: キャンセル";
  bar.appendChild(help);

  const applyBtn = document.createElement("button");
  applyBtn.className = "abtn pri";
  applyBtn.style.cssText = "width:auto;font-size:11px;";
  applyBtn.textContent = "Apply & Close";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "abtn";
  cancelBtn.style.cssText = "width:auto;font-size:11px;";
  cancelBtn.textContent = "Cancel";
  bar.appendChild(applyBtn);
  bar.appendChild(cancelBtn);
  overlay.appendChild(bar);

  const canvasWrap = document.createElement("div");
  canvasWrap.style.cssText = "position:relative;flex:1;overflow:hidden;";
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;cursor:crosshair;touch-action:none;";
  canvasWrap.appendChild(canvas);
  overlay.appendChild(canvasWrap);
  document.body.appendChild(overlay);
  const ctx = canvas.getContext("2d")!;

  // ── view helpers ──
  const uvToScreen = (u: number, v: number): [number, number] => [ox + u * viewScale, oy - v * viewScale];
  const screenToUV = (x: number, y: number): [number, number] => [(x - ox) / viewScale, (oy - y) / viewScale];

  const fitView = (): void => {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    viewScale = Math.max(50, Math.min(w, h) - 90);
    ox = (w - viewScale) / 2;
    oy = h - (h - viewScale) / 2; // v=0 at the bottom
  };

  const resize = (): void => {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  };

  // ── drawing ──
  function draw(): void {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);

    // Unit-box checker backdrop.
    const [bx0, by1] = uvToScreen(0, 0);
    const [bx1, by0] = uvToScreen(1, 1);
    const n = 8;
    const cell = (bx1 - bx0) / n;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        ctx.fillStyle = (i + j) % 2 === 0 ? "#191d26" : "#20242f";
        ctx.fillRect(bx0 + i * cell, by0 + j * cell, cell, cell);
      }
    }
    ctx.strokeStyle = "#3a4152";
    ctx.lineWidth = 1;
    ctx.strokeRect(bx0, by0, bx1 - bx0, by1 - by0);

    // Face fills (stretch overlay).
    if (stretchOn && faceStretch) {
      for (let f = 0; f < faceStretch.length; f++) {
        const a = indices[f * 3]!, b = indices[f * 3 + 1]!, c = indices[f * 3 + 2]!;
        const [x0, y0] = uvToScreen(draft[a * 2]!, draft[a * 2 + 1]!);
        const [x1, y1] = uvToScreen(draft[b * 2]!, draft[b * 2 + 1]!);
        const [x2, y2] = uvToScreen(draft[c * 2]!, draft[c * 2 + 1]!);
        const [r, g, bl] = stretchToColor(faceStretch[f]!);
        ctx.fillStyle = `rgba(${r},${g},${bl},0.72)`;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Wireframe — selected island on top in accent color.
    for (const pass of [0, 1]) {
      ctx.strokeStyle = pass === 0 ? "#5a6272" : "#ffd24d";
      ctx.lineWidth = pass === 0 ? 1 : 1.5;
      ctx.beginPath();
      for (let f = 0; f < indices.length / 3; f++) {
        const isl = islandData.islandOfVert[indices[f * 3]!]!;
        const selected = editorMode === "island" && isl === selIsland;
        if ((pass === 1) !== selected) continue;
        const a = indices[f * 3]!, b = indices[f * 3 + 1]!, c = indices[f * 3 + 2]!;
        const [x0, y0] = uvToScreen(draft[a * 2]!, draft[a * 2 + 1]!);
        const [x1, y1] = uvToScreen(draft[b * 2]!, draft[b * 2 + 1]!);
        const [x2, y2] = uvToScreen(draft[c * 2]!, draft[c * 2 + 1]!);
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.closePath();
      }
      ctx.stroke();
    }

    // Vertex dots.
    if (editorMode === "vertex") {
      for (let v = 0; v < vertexCount; v++) {
        if (islandData.islandOfVert[v]! < 0) continue;
        const [x, y] = uvToScreen(draft[v * 2]!, draft[v * 2 + 1]!);
        ctx.fillStyle = selVerts.has(v) ? "#ffd24d" : "#9fb0c8";
        ctx.beginPath();
        ctx.arc(x, y, selVerts.has(v) ? 4 : 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  const refreshStretch = (): void => {
    if (stretchOn) {
      faceStretch = computeFaceStretch(positions, draft, indices);
    }
  };

  // ── picking ──
  const pickVertexAt = (x: number, y: number): number => {
    const maxDistSq = VERTEX_PICK_PX * VERTEX_PICK_PX;
    let best = -1;
    let bestSq = maxDistSq;
    for (let v = 0; v < vertexCount; v++) {
      if (islandData.islandOfVert[v]! < 0) continue;
      const [sx, sy] = uvToScreen(draft[v * 2]!, draft[v * 2 + 1]!);
      const dsq = (sx - x) * (sx - x) + (sy - y) * (sy - y);
      if (dsq < bestSq) {
        bestSq = dsq;
        best = v;
      }
    }
    return best;
  };

  const beginDrag = (verts: number[], u: number, v: number): void => {
    const snap = new Float32Array(verts.length * 2);
    verts.forEach((vi, i) => {
      snap[i * 2] = draft[vi * 2]!;
      snap[i * 2 + 1] = draft[vi * 2 + 1]!;
    });
    const bb = uvBounds(draft, verts);
    drag = {
      verts,
      snap,
      startU: u,
      startV: v,
      pivotU: (bb.minU + bb.maxU) / 2,
      pivotV: (bb.minV + bb.maxV) / 2,
    };
  };

  // ── pointer interaction ──
  const onPointerDown = (e: PointerEvent): void => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (e.button === 1 || e.button === 2) {
      pan = { x, y };
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    const [u, v] = screenToUV(x, y);

    if (editorMode === "island") {
      const f = faceAtUVPoint(draft, indices, u, v);
      if (f >= 0) {
        selIsland = islandData.islandOfVert[indices[f * 3]!]!;
        beginDrag(islandData.islands[selIsland]!.slice(), u, v);
      } else {
        selIsland = -1;
      }
    } else {
      const hit = pickVertexAt(x, y);
      if (hit >= 0) {
        if (e.ctrlKey || e.metaKey) {
          if (selVerts.has(hit)) selVerts.delete(hit);
          else selVerts.add(hit);
        } else if (!selVerts.has(hit)) {
          selVerts.clear();
          selVerts.add(hit);
        }
        if (selVerts.has(hit)) beginDrag([...selVerts], u, v);
      } else if (!e.ctrlKey && !e.metaKey) {
        selVerts.clear();
      }
    }
    canvas.setPointerCapture(e.pointerId);
    draw();
  };

  const onPointerMove = (e: PointerEvent): void => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (pan) {
      ox += x - pan.x;
      oy += y - pan.y;
      pan = { x, y };
      draw();
      return;
    }
    if (!drag) return;
    const [u, v] = screenToUV(x, y);

    // Restore the snapshot, then apply the full gesture delta — keeps rotate
    // and scale exact instead of accumulating per-move increments.
    drag.verts.forEach((vi, i) => {
      draft[vi * 2] = drag!.snap[i * 2]!;
      draft[vi * 2 + 1] = drag!.snap[i * 2 + 1]!;
    });
    const mode: XformMode = editorMode === "vertex" ? "move" : xform;
    if (mode === "move") {
      translateUVs(draft, drag.verts, u - drag.startU, v - drag.startV);
    } else if (mode === "rotate") {
      const a0 = Math.atan2(drag.startV - drag.pivotV, drag.startU - drag.pivotU);
      const a1 = Math.atan2(v - drag.pivotV, u - drag.pivotU);
      rotateUVs(draft, drag.verts, a1 - a0, drag.pivotU, drag.pivotV);
    } else {
      const d0 = Math.hypot(drag.startU - drag.pivotU, drag.startV - drag.pivotV);
      const d1 = Math.hypot(u - drag.pivotU, v - drag.pivotV);
      const factor = d0 > 1e-6 ? Math.max(1e-3, d1 / d0) : 1;
      scaleUVs(draft, drag.verts, factor, drag.pivotU, drag.pivotV);
    }
    preview();
    refreshStretch();
    draw();
  };

  const onPointerUp = (e: PointerEvent): void => {
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    pan = null;
    if (drag) {
      drag = null;
      refreshStretch();
      draw();
    }
  };

  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const factor = Math.exp(-e.deltaY * 0.0012);
    const clamped = Math.min(20000, Math.max(30, viewScale * factor)) / viewScale;
    // Zoom around the cursor.
    ox = x - (x - ox) * clamped;
    oy = y - (y - oy) * clamped;
    viewScale *= clamped;
    draw();
  };

  // ── keyboard (capture-phase so 3D viewport shortcuts don't fire) ──
  const onKeyDown = (e: KeyboardEvent): void => {
    if (!overlay.isConnected) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" && (e.target as HTMLInputElement).type !== "checkbox") return;
    e.stopPropagation();
    const k = e.key.toLowerCase();
    if (e.key === "Escape") {
      cancel();
    } else if (k === "g") setXform("move");
    else if (k === "r") setXform("rotate");
    else if (k === "s") setXform("scale");
    else if (k === "i") setEditorMode("island");
    else if (k === "v") setEditorMode("vertex");
    else return;
    e.preventDefault();
  };

  // ── apply / cancel ──
  const close = (): void => {
    document.removeEventListener("keydown", onKeyDown, true);
    ro.disconnect();
    overlay.remove();
  };

  const apply = (): void => {
    const final = new Float32Array(draft);
    const before = new Float32Array(orig);
    mesh.updateVerticesData(VertexBuffer.UVKind, final);
    state.history.push({
      label: "Edit UVs",
      undo() {
        if (!mesh.isDisposed()) mesh.updateVerticesData(VertexBuffer.UVKind, new Float32Array(before));
      },
      redo() {
        if (!mesh.isDisposed()) mesh.updateVerticesData(VertexBuffer.UVKind, new Float32Array(final));
      },
    });
    close();
    status("UV edits applied");
  };

  const cancel = (): void => {
    mesh.updateVerticesData(VertexBuffer.UVKind, new Float32Array(orig));
    close();
    status("UV edits cancelled");
  };

  applyBtn.addEventListener("click", apply);
  cancelBtn.addEventListener("click", cancel);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  document.addEventListener("keydown", onKeyDown, true);

  const ro = new ResizeObserver(resize);
  ro.observe(canvasWrap);

  syncToggles();
  fitView();
  resize();
  status(`UV Editor — ${islandData.islands.length} island(s)`);
}

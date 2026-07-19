/**
 * Navigation gizmo — a small clickable axis-orientation widget in the
 * viewport corner (Blender's nav gizmo / navigation cube stand-in).
 *
 * Shows where world ±X/±Y/±Z point relative to the current camera; clicking
 * an axis dot snaps to the matching orthographic-style camera preset. This
 * matters most on tablets, where the numpad view shortcuts don't exist.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { state } from "../state";
import { applyCameraPreset, PRESETS } from "./camera-presets";

const SIZE = 84;
const R = SIZE / 2 - 10; // axis arm length in px
const DOT_R = 7;

interface AxisDot {
  dir: Vector3;
  label: string;
  color: string;
  /** Camera preset key to apply on click (see camera-presets PRESETS). */
  preset: string;
}

// Preset mapping follows the app's convention: the "Front" preset places the
// camera on +X (alpha 0), so clicking the +X dot = look from +X = Front.
const AXES: AxisDot[] = [
  { dir: new Vector3(1, 0, 0), label: "X", color: "#e4556a", preset: "front" },
  { dir: new Vector3(-1, 0, 0), label: "", color: "#e4556a", preset: "back" },
  { dir: new Vector3(0, 1, 0), label: "Y", color: "#78c93f", preset: "top" },
  { dir: new Vector3(0, -1, 0), label: "", color: "#78c93f", preset: "bottom" },
  { dir: new Vector3(0, 0, 1), label: "Z", color: "#4a90e2", preset: "right" },
  { dir: new Vector3(0, 0, -1), label: "", color: "#4a90e2", preset: "left" },
];

let _canvas: HTMLCanvasElement | null = null;
let _ctx: CanvasRenderingContext2D | null = null;
/** Last projected dot positions for click hit-testing: [x, y, axisIndex]. */
let _dotHits: Array<[number, number, number]> = [];

export function initNavGizmo(): void {
  if (_canvas || !state.canvas || !state.scene) return;

  const host = state.canvas.parentElement;
  if (!host) return;
  if (getComputedStyle(host).position === "static") host.style.position = "relative";

  _canvas = document.createElement("canvas");
  _canvas.width = SIZE;
  _canvas.height = SIZE;
  _canvas.style.cssText =
    "position:absolute;top:10px;right:10px;width:" + SIZE + "px;height:" + SIZE + "px;" +
    "z-index:5;cursor:pointer;opacity:0.85;touch-action:none;";
  _canvas.setAttribute("aria-label", "View orientation gizmo");
  host.appendChild(_canvas);
  _ctx = _canvas.getContext("2d");

  _canvas.addEventListener("pointerdown", (e) => {
    const rect = _canvas!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    for (const [dx, dy, idx] of _dotHits) {
      if ((x - dx) ** 2 + (y - dy) ** 2 <= (DOT_R + 4) ** 2) {
        const preset = PRESETS[AXES[idx]!.preset];
        if (preset) applyCameraPreset(preset);
        e.stopPropagation();
        return;
      }
    }
  });

  state.scene.onAfterRenderObservable.add(draw);
  draw();
}

function draw(): void {
  if (!_ctx || !_canvas) return;
  const ctx = _ctx;
  ctx.clearRect(0, 0, SIZE, SIZE);
  _dotHits = [];

  const view = state.camera.getViewMatrix();
  const c = SIZE / 2;

  // Project each world axis into view space; x/y become screen offsets
  // (screen y grows downward), z orders front/back.
  const projected = AXES.map((axis, i) => {
    const v = Vector3.TransformNormal(axis.dir, view);
    return { axis, i, x: c + v.x * R, y: c - v.y * R, z: v.z };
  });
  // Back-facing dots first so front dots draw (and hit-test) on top.
  projected.sort((a, b) => a.z - b.z);

  for (const p of projected) {
    const front = p.z <= 0;
    // Axis arm — only for the positive (labeled) ends, keeps the widget clean.
    if (p.axis.label) {
      ctx.strokeStyle = p.axis.color;
      ctx.globalAlpha = front ? 0.9 : 0.35;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(c, c);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
    ctx.globalAlpha = front ? 1 : 0.45;
    ctx.beginPath();
    ctx.arc(p.x, p.y, DOT_R, 0, Math.PI * 2);
    if (p.axis.label) {
      ctx.fillStyle = p.axis.color;
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = "bold 9px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(p.axis.label, p.x, p.y + 0.5);
    } else {
      // Negative ends: hollow dot.
      ctx.fillStyle = "rgba(20,20,20,0.75)";
      ctx.fill();
      ctx.strokeStyle = p.axis.color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    _dotHits.push([p.x, p.y, p.i]);
  }
  ctx.globalAlpha = 1;
}

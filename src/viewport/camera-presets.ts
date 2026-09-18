import { Camera } from "@babylonjs/core/Cameras/camera";
import { Animation } from "@babylonjs/core/Animations/animation";
import { state, status } from "../state";

export interface CameraPreset {
  name: string;
  alpha: number;
  beta: number;
}

/**
 * Camera positions, named for what the viewer ends up looking at.
 *
 * **The alphas are a quarter turn from the obvious ones, on purpose.**
 * Babylon's `ArcRotateCamera` places the camera at
 * `(cos α · sin β, cos β, sin α · sin β)`, so `α = 0` puts it on **+X** — off
 * to the model's side. A character faces down Z, so `α = 0` is a flank and
 * `α = π/2` is the one that shows the face.
 *
 * They were the obvious ones until 2026-09-18, which left every horizontal
 * button mislabelled by 90°: **F** gave a side view and **R** gave the face.
 * Confusing alone, and worse next to the glTF loader's mirrored root — "the
 * front view shows the back" and "left and right are swapped" are the two
 * conclusions it invites, and neither was true.
 *
 * Verified by screenshot after the change: **F** shows the face square on,
 * **L** the tail. Front/back is the pair worth re-checking if these ever move
 * again — the character is near enough symmetric that left/right cannot be
 * read off a picture, only off the arithmetic (`α = 0` is +X, and `rightHand`
 * lives at +x).
 */
export const PRESETS: Record<string, CameraPreset> = {
  front:  { name: "Front",  alpha: Math.PI / 2,  beta: Math.PI / 2 },
  back:   { name: "Back",   alpha: -Math.PI / 2, beta: Math.PI / 2 },
  right:  { name: "Right",  alpha: 0,            beta: Math.PI / 2 },
  left:   { name: "Left",   alpha: Math.PI,      beta: Math.PI / 2 },
  // Looking straight down or up, `alpha` only decides which way "up" falls on
  // screen. Matching `front` keeps the model's face toward the bottom of the
  // frame in both, so the two read as a pair.
  top:    { name: "Top",    alpha: Math.PI / 2,  beta: 0.01 },
  bottom: { name: "Bottom", alpha: Math.PI / 2,  beta: Math.PI - 0.01 },
};

const ANIM_FRAMES = 10;
const ANIM_FPS = 30;

export function applyCameraPreset(preset: CameraPreset): void {
  const cam = state.camera;

  // Animate alpha
  Animation.CreateAndStartAnimation(
    "camAlpha", cam, "alpha", ANIM_FPS, ANIM_FRAMES,
    cam.alpha, preset.alpha, Animation.ANIMATIONLOOPMODE_CONSTANT,
  );
  // Animate beta
  Animation.CreateAndStartAnimation(
    "camBeta", cam, "beta", ANIM_FPS, ANIM_FRAMES,
    cam.beta, preset.beta, Animation.ANIMATIONLOOPMODE_CONSTANT,
  );

  // Highlight active preset button
  document.querySelectorAll<HTMLElement>(".cam-btn").forEach((b) => {
    b.classList.toggle("on", b.dataset.preset === preset.name.toLowerCase());
  });

  status(preset.name + " view");
}

export function toggleOrthographic(): void {
  const cam = state.camera;
  state.isOrthographic = !state.isOrthographic;

  if (state.isOrthographic) {
    updateOrthoFrustum();
    cam.mode = Camera.ORTHOGRAPHIC_CAMERA;
    status("Orthographic");
  } else {
    cam.mode = Camera.PERSPECTIVE_CAMERA;
    status("Perspective");
  }

  // Update button visual
  const btn = document.getElementById("btnOrtho");
  if (btn) btn.classList.toggle("on", state.isOrthographic);
}

export function updateOrthoFrustum(): void {
  if (!state.isOrthographic) return;
  const cam = state.camera;
  const aspect = state.canvas.width / state.canvas.height;
  const halfHeight = cam.radius * 0.5;
  const halfWidth = halfHeight * aspect;
  cam.orthoLeft = -halfWidth;
  cam.orthoRight = halfWidth;
  cam.orthoTop = halfHeight;
  cam.orthoBottom = -halfHeight;
}

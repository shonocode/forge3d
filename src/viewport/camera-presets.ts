import { Camera } from "@babylonjs/core/Cameras/camera";
import { Animation } from "@babylonjs/core/Animations/animation";
import { state, status } from "../state";

export interface CameraPreset {
  name: string;
  alpha: number;
  beta: number;
}

export const PRESETS: Record<string, CameraPreset> = {
  front:  { name: "Front",  alpha: 0,            beta: Math.PI / 2 },
  back:   { name: "Back",   alpha: Math.PI,      beta: Math.PI / 2 },
  right:  { name: "Right",  alpha: Math.PI / 2,  beta: Math.PI / 2 },
  left:   { name: "Left",   alpha: -Math.PI / 2, beta: Math.PI / 2 },
  top:    { name: "Top",    alpha: 0,            beta: 0.01 },
  bottom: { name: "Bottom", alpha: 0,            beta: Math.PI - 0.01 },
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

import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { LinesMesh } from "@babylonjs/core/Meshes/linesMesh";
import { state } from "../state";
import type { BoneTrack, KeyframeData } from "../state";
import { getActiveSkeleton } from "./skeleton-tool";

// ── Onion skin (F-M7) ────────────────────────────────────────
//
// Ghost skeleton overlays at ±N frames around the playhead, so an
// animator can see where the pose is coming from and going to without
// scrubbing back and forth. Classic 2D onion-skinning applied to the
// rig: the *previous* ghost renders green, the *next* one red (the de
// facto industry color code).
//
// Ghost poses are computed purely from the clip's keyframe data — the
// live skeleton is never touched, so scrubbing/playback and the ghosts
// can't fight over bone matrices. Bones without a track (or without
// keys) fall back to their current local matrix, matching how the
// scrubber leaves unkeyed bones alone.
//
// The pure pose-composition part (computeGhostSegments) is
// Vitest-covered; only the LinesSystem drawing below touches the scene.

/** Minimal bone description for ghost pose composition. */
export interface GhostBone {
  id: string;
  parentId: string | null;
  /** Local matrix to use when `evalPose` has nothing for this bone. */
  fallbackLocal: Matrix;
}

/** Evaluated local pose for one bone at the ghost frame (euler + pos). */
export type GhostPoseEval = (
  boneId: string
) => { rotation: { x: number; y: number; z: number }; position: { x: number; y: number; z: number } } | null;

/**
 * Compose world head positions for every bone from local poses, walking
 * parents before children. Pure — no scene access.
 */
export function computeGhostJoints(
  bones: readonly GhostBone[],
  evalPose: GhostPoseEval
): Map<string, Vector3> {
  const byId = new Map(bones.map((b) => [b.id, b]));
  const worlds = new Map<string, Matrix>();

  const worldOf = (bone: GhostBone): Matrix => {
    const cached = worlds.get(bone.id);
    if (cached) return cached;

    const pose = evalPose(bone.id);
    const local = pose
      ? Matrix.Compose(
          new Vector3(1, 1, 1),
          Quaternion.FromEulerAngles(pose.rotation.x, pose.rotation.y, pose.rotation.z),
          new Vector3(pose.position.x, pose.position.y, pose.position.z)
        )
      : bone.fallbackLocal;

    const parent = bone.parentId ? byId.get(bone.parentId) : undefined;
    // Babylon Matrix.multiply is row-vector order: local first, then parent.
    const world = parent ? local.multiply(worldOf(parent)) : local.clone();
    worlds.set(bone.id, world);
    return world;
  };

  const joints = new Map<string, Vector3>();
  for (const b of bones) {
    const m = worldOf(b);
    joints.set(b.id, new Vector3(m.m[12]!, m.m[13]!, m.m[14]!));
  }
  return joints;
}

/**
 * Parent→child line segments of the ghost skeleton at the evaluated
 * pose — the same wire representation the live hierarchy lines use.
 */
export function computeGhostSegments(
  bones: readonly GhostBone[],
  evalPose: GhostPoseEval
): Vector3[][] {
  const joints = computeGhostJoints(bones, evalPose);
  const lines: Vector3[][] = [];
  for (const b of bones) {
    if (!b.parentId) continue;
    const head = joints.get(b.parentId);
    const tail = joints.get(b.id);
    if (head && tail) lines.push([head, tail]);
  }
  return lines;
}

// ── Scene glue ──

const GHOST_PAST_COLOR = new Color3(0.25, 0.75, 0.4);
const GHOST_FUTURE_COLOR = new Color3(0.85, 0.35, 0.35);

interface GhostSlot {
  mesh: LinesMesh | null;
  lineCount: number;
}
const _slots: { past: GhostSlot; future: GhostSlot } = {
  past: { mesh: null, lineCount: 0 },
  future: { mesh: null, lineCount: 0 },
};

function clearSlot(slot: GhostSlot): void {
  if (slot.mesh) {
    slot.mesh.dispose();
    slot.mesh = null;
    slot.lineCount = 0;
  }
}

/** Remove all ghost meshes (used on disable / skeleton disposal). */
export function clearOnionSkin(): void {
  clearSlot(_slots.past);
  clearSlot(_slots.future);
}

function drawSlot(
  slot: GhostSlot,
  name: string,
  lines: Vector3[][],
  color: Color3
): void {
  if (lines.length === 0) {
    clearSlot(slot);
    return;
  }
  if (slot.mesh && slot.lineCount === lines.length) {
    // In-place update — no GC churn during playback (same pattern as
    // the live hierarchy lines).
    MeshBuilder.CreateLineSystem(name, { lines, instance: slot.mesh }, state.scene);
    return;
  }
  clearSlot(slot);
  const mesh = MeshBuilder.CreateLineSystem(name, { lines, updatable: true }, state.scene);
  mesh.color = color;
  mesh.alpha = 0.55;
  mesh.isPickable = false;
  mesh.renderingGroupId = state.boneDisplay.xray ? 1 : 0;
  slot.mesh = mesh;
  slot.lineCount = lines.length;
}

/**
 * Redraw the onion-skin ghosts for the current frame.
 *
 * `evalTrack` is injected (it's `animation-tool.interpolateTrack`) so this
 * module doesn't import animation-tool — animation-tool imports *us* to
 * refresh ghosts from `scrubToFrame`, and a static import back would be a
 * cycle. Clears the ghosts when disabled / no clip / no skeleton.
 */
export function updateOnionSkin(
  clip: { tracks: BoneTrack[]; maxFrames: number } | null,
  evalTrack: (track: BoneTrack, frame: number) => KeyframeData | null
): void {
  const cfg = state.onionSkin;
  const skel = getActiveSkeleton();
  if (!cfg.enabled || !clip || !skel || clip.tracks.length === 0) {
    clearOnionSkin();
    return;
  }

  const bones: GhostBone[] = skel.bones.map((b) => ({
    id: b.id,
    parentId: b.parentId,
    fallbackLocal: b.bone.getLocalMatrix(),
  }));
  const trackByBoneId = new Map(clip.tracks.map((t) => [t.boneId, t]));

  const evalAt = (frame: number): GhostPoseEval => (boneId) => {
    const track = trackByBoneId.get(boneId);
    if (!track || track.keyframes.length === 0) return null;
    return evalTrack(track, frame);
  };

  const offset = Math.max(1, Math.round(cfg.offset));
  const past = Math.max(0, state.currentFrame - offset);
  const future = Math.min(clip.maxFrames, state.currentFrame + offset);

  if (past !== state.currentFrame) {
    drawSlot(_slots.past, "onion_past", computeGhostSegments(bones, evalAt(past)), GHOST_PAST_COLOR);
  } else {
    clearSlot(_slots.past);
  }
  if (future !== state.currentFrame) {
    drawSlot(_slots.future, "onion_future", computeGhostSegments(bones, evalAt(future)), GHOST_FUTURE_COLOR);
  } else {
    clearSlot(_slots.future);
  }
}

import { Vector3, Quaternion, Matrix } from "@babylonjs/core/Maths/math.vector";
import { Animation } from "@babylonjs/core/Animations/animation";
import { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { state, status } from "../state";
import type { AnimClipData, BoneTrack, KeyframeData } from "../state";
import { getActiveSkeleton, findBoneById } from "./skeleton-tool";

// Scratch vectors for decomposition
const _scratchScale = new Vector3();
const _scratchRotQuat = new Quaternion();
const _scratchPosition = new Vector3();
const _scratchEuler = new Vector3();

// ── Clip management ──

export function createClip(name?: string): AnimClipData {
  state.animClipCounter++;
  const id = "clip_" + state.animClipCounter;
  const clip: AnimClipData = {
    id,
    name: name ?? "Clip_" + state.animClipCounter,
    frameRate: 30,
    maxFrames: 60,
    loopMode: "cycle",
    tracks: [],
  };
  state.animClips.push(clip);
  state.activeClipId = id;
  state.currentFrame = 0;
  status("Clip created: " + clip.name);
  return clip;
}

export function getActiveClip(): AnimClipData | null {
  if (!state.activeClipId) return null;
  return state.animClips.find((c) => c.id === state.activeClipId) ?? null;
}

export function deleteClip(clipId: string): void {
  const idx = state.animClips.findIndex((c) => c.id === clipId);
  if (idx === -1) return;
  state.animClips.splice(idx, 1);
  if (state.activeClipId === clipId) {
    state.activeClipId = state.animClips.length > 0 ? state.animClips[0]!.id : null;
  }
  status("Clip deleted");
}

/** Insert or replace a keyframe in a track, maintaining sort order by frame. */
function upsertKeyframe(track: BoneTrack, kf: KeyframeData): void {
  const existIdx = track.keyframes.findIndex((k) => k.frame === kf.frame);
  if (existIdx !== -1) {
    track.keyframes[existIdx] = kf;
  } else {
    track.keyframes.push(kf);
    track.keyframes.sort((a, b) => a.frame - b.frame);
  }
}

// ── Bone pose capture ──

/**
 * Extract rotation (euler) and position from a bone's local matrix.
 */
function getBonePose(boneId: string): { rotation: { x: number; y: number; z: number }; position: { x: number; y: number; z: number } } | null {
  const bd = findBoneById(boneId);
  if (!bd) return null;

  const localMatrix = bd.bone.getLocalMatrix();
  localMatrix.decompose(_scratchScale, _scratchRotQuat, _scratchPosition);
  _scratchRotQuat.toEulerAnglesToRef(_scratchEuler);

  return {
    rotation: { x: _scratchEuler.x, y: _scratchEuler.y, z: _scratchEuler.z },
    position: { x: _scratchPosition.x, y: _scratchPosition.y, z: _scratchPosition.z },
  };
}

/**
 * Capture keyframe for the currently selected bone at the current frame.
 */
export function captureKeyframe(): void {
  const clip = getActiveClip();
  if (!clip) {
    status("⚠ No active clip");
    return;
  }
  if (!state.selectedBoneId) {
    status("⚠ Select a bone first");
    return;
  }

  const bd = findBoneById(state.selectedBoneId);
  if (!bd) return;

  const pose = getBonePose(state.selectedBoneId);
  if (!pose) return;

  const kf: KeyframeData = {
    frame: state.currentFrame,
    rotation: pose.rotation,
    position: pose.position,
  };

  // Find or create track for this bone
  let track = clip.tracks.find((t) => t.boneId === state.selectedBoneId);
  if (!track) {
    track = { boneId: state.selectedBoneId, boneName: bd.name, keyframes: [] };
    clip.tracks.push(track);
  }

  upsertKeyframe(track, kf);

  status("Keyframe recorded: " + bd.name + " @ frame " + state.currentFrame);
}

/**
 * Capture keyframes for ALL bones at the current frame.
 */
export function captureAllKeyframes(): void {
  const clip = getActiveClip();
  if (!clip) {
    status("⚠ No active clip");
    return;
  }

  const skelData = getActiveSkeleton();
  if (!skelData || !skelData.bones.length) {
    status("⚠ No bones");
    return;
  }

  for (const bd of skelData.bones) {
    const pose = getBonePose(bd.id);
    if (!pose) continue;

    const kf: KeyframeData = {
      frame: state.currentFrame,
      rotation: pose.rotation,
      position: pose.position,
    };

    let track = clip.tracks.find((t) => t.boneId === bd.id);
    if (!track) {
      track = { boneId: bd.id, boneName: bd.name, keyframes: [] };
      clip.tracks.push(track);
    }

    upsertKeyframe(track, kf);
  }

  status("All keyframes recorded @ frame " + state.currentFrame);
}

/**
 * Delete keyframe for selected bone at current frame.
 */
export function deleteKeyframe(): void {
  const clip = getActiveClip();
  if (!clip || !state.selectedBoneId) return;

  const track = clip.tracks.find((t) => t.boneId === state.selectedBoneId);
  if (!track) return;

  const idx = track.keyframes.findIndex((k) => k.frame === state.currentFrame);
  if (idx !== -1) {
    track.keyframes.splice(idx, 1);
    status("Keyframe deleted @ frame " + state.currentFrame);
  }

  // Remove empty tracks
  if (track.keyframes.length === 0) {
    const ti = clip.tracks.indexOf(track);
    if (ti !== -1) clip.tracks.splice(ti, 1);
  }
}

// ── Timeline scrubbing ──

/**
 * Set all bones to interpolated poses at the given frame.
 */
export function scrubToFrame(frame: number): void {
  state.currentFrame = frame;

  const clip = getActiveClip();
  if (!clip) return;

  const skelData = getActiveSkeleton();
  if (!skelData) return;

  for (const track of clip.tracks) {
    const bd = skelData.bones.find((b) => b.id === track.boneId);
    if (!bd) continue;

    const pose = interpolateTrack(track, frame);
    if (!pose) continue;

    // Set bone local matrix from interpolated pose
    const rotQuat = Quaternion.FromEulerAngles(pose.rotation.x, pose.rotation.y, pose.rotation.z);
    const mat = Matrix.Compose(
      new Vector3(1, 1, 1),
      rotQuat,
      new Vector3(pose.position.x, pose.position.y, pose.position.z)
    );
    bd.bone.getLocalMatrix().copyFrom(mat);

    // Sync visual
    if (bd.visual) {
      bd.visual.position.set(pose.position.x, pose.position.y, pose.position.z);
    }
  }
}

function interpolateTrack(track: BoneTrack, frame: number): KeyframeData | null {
  const kfs = track.keyframes;
  if (kfs.length === 0) return null;
  if (kfs.length === 1) return kfs[0]!;

  // Before first keyframe
  if (frame <= kfs[0]!.frame) return kfs[0]!;
  // After last keyframe
  if (frame >= kfs[kfs.length - 1]!.frame) return kfs[kfs.length - 1]!;

  // Find surrounding keyframes
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i]!;
    const b = kfs[i + 1]!;
    if (frame >= a.frame && frame <= b.frame) {
      if (a.frame === b.frame) return a;
      const t = (frame - a.frame) / (b.frame - a.frame);
      return {
        frame,
        rotation: {
          x: a.rotation.x + (b.rotation.x - a.rotation.x) * t,
          y: a.rotation.y + (b.rotation.y - a.rotation.y) * t,
          z: a.rotation.z + (b.rotation.z - a.rotation.z) * t,
        },
        position: {
          x: a.position.x + (b.position.x - a.position.x) * t,
          y: a.position.y + (b.position.y - a.position.y) * t,
          z: a.position.z + (b.position.z - a.position.z) * t,
        },
      };
    }
  }
  return kfs[kfs.length - 1]!;
}

// ── Preview playback ──

export function playPreview(): void {
  const clip = getActiveClip();
  if (!clip || clip.tracks.length === 0) {
    status("⚠ No keyframes to play");
    return;
  }

  stopPreview();

  const group = buildAnimationGroup(clip);
  if (!group) return;

  state.animPreviewGroup = group;
  state.isPlaying = true;
  group.start(clip.loopMode === "cycle");
  status("Playing: " + clip.name);
}

export function stopPreview(): void {
  if (state.animPreviewGroup) {
    state.animPreviewGroup.stop();
    state.animPreviewGroup.dispose();
    state.animPreviewGroup = null;
  }
  state.isPlaying = false;
}

function buildAnimationGroup(clip: AnimClipData): AnimationGroup | null {
  const skelData = getActiveSkeleton();
  if (!skelData) return null;

  const group = new AnimationGroup(clip.name, state.scene);
  const loopMode = clip.loopMode === "cycle"
    ? Animation.ANIMATIONLOOPMODE_CYCLE
    : Animation.ANIMATIONLOOPMODE_CONSTANT;

  for (const track of clip.tracks) {
    const bd = skelData.bones.find((b) => b.id === track.boneId);
    if (!bd || track.keyframes.length === 0) continue;

    // Rotation animation
    const rotAnim = new Animation(
      track.boneName + "_rotation",
      "rotation",
      clip.frameRate,
      Animation.ANIMATIONTYPE_VECTOR3,
      loopMode
    );
    rotAnim.setKeys(
      track.keyframes.map((kf) => ({
        frame: kf.frame,
        value: new Vector3(kf.rotation.x, kf.rotation.y, kf.rotation.z),
      }))
    );
    group.addTargetedAnimation(rotAnim, bd.bone);

    // Position animation
    const posAnim = new Animation(
      track.boneName + "_position",
      "position",
      clip.frameRate,
      Animation.ANIMATIONTYPE_VECTOR3,
      loopMode
    );
    posAnim.setKeys(
      track.keyframes.map((kf) => ({
        frame: kf.frame,
        value: new Vector3(kf.position.x, kf.position.y, kf.position.z),
      }))
    );
    group.addTargetedAnimation(posAnim, bd.bone);
  }

  return group;
}

// ── Export ──

/**
 * Export the active clip as AnimationDataBase-compatible JSON and trigger download.
 */
export function exportClipAsJSON(): void {
  const clip = getActiveClip();
  if (!clip) {
    status("⚠ No active clip");
    return;
  }

  const skelData = getActiveSkeleton();
  if (!skelData) return;

  const loopModeNum = clip.loopMode === "cycle"
    ? 1  // Animation.ANIMATIONLOOPMODE_CYCLE
    : 2; // Animation.ANIMATIONLOOPMODE_CONSTANT

  const boneAnimations: Array<{
    name: string;
    boneName: string;
    property: string;
    fps: number;
    type: number;
    loopMode: number;
    keys: Array<{ frame: number; value: { x: number; y: number; z: number } }>;
  }> = [];

  for (const track of clip.tracks) {
    if (track.keyframes.length === 0) continue;

    // Rotation track
    boneAnimations.push({
      name: track.boneName + "_rotation",
      boneName: track.boneName,
      property: "rotation",
      fps: clip.frameRate,
      type: 2, // Animation.ANIMATIONTYPE_VECTOR3
      loopMode: loopModeNum,
      keys: track.keyframes.map((kf) => ({
        frame: kf.frame,
        value: { x: kf.rotation.x, y: kf.rotation.y, z: kf.rotation.z },
      })),
    });

    // Position track
    boneAnimations.push({
      name: track.boneName + "_position",
      boneName: track.boneName,
      property: "position",
      fps: clip.frameRate,
      type: 2,
      loopMode: loopModeNum,
      keys: track.keyframes.map((kf) => ({
        frame: kf.frame,
        value: { x: kf.position.x, y: kf.position.y, z: kf.position.z },
      })),
    });
  }

  const data = {
    animationName: clip.name,
    frameRate: clip.frameRate,
    loopMode: loopModeNum,
    boneAnimations,
  };

  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = clip.name + ".json";
  a.click();
  URL.revokeObjectURL(url);
  status("Animation exported: " + clip.name + ".json");
}

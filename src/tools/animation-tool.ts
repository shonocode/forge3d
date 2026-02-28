import { Vector3, Quaternion, Matrix } from "@babylonjs/core/Maths/math.vector";
import { Animation } from "@babylonjs/core/Animations/animation";
import { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { state, status } from "../state";
import type { AnimClipData, BoneTrack, KeyframeData } from "../state";
import { getActiveSkeleton, findBoneById } from "./skeleton-tool";
import { getEasingFunction } from "./easing";
import type { EasingType } from "./easing";

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
  if (state.currentFrame < 0 || state.currentFrame > clip.maxFrames) {
    status("\u26a0 Frame out of range (0-" + clip.maxFrames + ")");
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
  const clip = getActiveClip();
  if (clip) {
    frame = Math.max(0, Math.min(frame, clip.maxFrames));
  }
  state.currentFrame = frame;

  if (!clip) return;

  const skelData = getActiveSkeleton();
  if (!skelData) return;

  // First pass: set all bone local matrices
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
  }

  // Recompute absolute transforms after all local matrices are set
  skelData.skeleton.computeAbsoluteTransforms();

  // Second pass: sync visuals from absolute transforms (correct for child bones)
  for (const track of clip.tracks) {
    const bd = skelData.bones.find((b) => b.id === track.boneId);
    if (!bd?.visual) continue;
    const abs = bd.bone.getAbsoluteTransform();
    bd.visual.position.set(abs.m[12]!, abs.m[13]!, abs.m[14]!);
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
      let t = (frame - a.frame) / (b.frame - a.frame);
      // Apply easing from keyframe a
      if (a.easing) t = getEasingFunction(a.easing)(t);
      // Use quaternion slerp for rotation to avoid gimbal lock
      const quatA = Quaternion.FromEulerAngles(a.rotation.x, a.rotation.y, a.rotation.z);
      const quatB = Quaternion.FromEulerAngles(b.rotation.x, b.rotation.y, b.rotation.z);
      const quatInterp = Quaternion.Slerp(quatA, quatB, t);
      const eulerInterp = quatInterp.toEulerAngles();
      return {
        frame,
        rotation: { x: eulerInterp.x, y: eulerInterp.y, z: eulerInterp.z },
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
    try { state.animPreviewGroup.stop(); } catch { /* scene may be disposed */ }
    try { state.animPreviewGroup.dispose(); } catch { /* ignore */ }
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

    // Single matrix animation targeting bone's local matrix
    const matAnim = new Animation(
      track.boneName + "_localMatrix",
      "_matrix",
      clip.frameRate,
      Animation.ANIMATIONTYPE_MATRIX,
      loopMode
    );
    matAnim.setKeys(
      track.keyframes.map((kf) => ({
        frame: kf.frame,
        value: Matrix.Compose(
          new Vector3(1, 1, 1),
          Quaternion.FromEulerAngles(kf.rotation.x, kf.rotation.y, kf.rotation.z),
          new Vector3(kf.position.x, kf.position.y, kf.position.z)
        ),
      }))
    );
    group.addTargetedAnimation(matAnim, bd.bone);
  }

  return group;
}

// ── Keyframe Copy/Paste/Easing ──

export function copyKeyframe(): void {
  const clip = getActiveClip();
  if (!clip || !state.selectedBoneId) { status("⚠ ボーンを選択"); return; }
  const track = clip.tracks.find((t) => t.boneId === state.selectedBoneId);
  const kf = track?.keyframes.find((k) => k.frame === state.currentFrame);
  if (!kf) { status("⚠ キーフレームなし"); return; }
  state.keyframeClipboard = { ...kf };
  status("Copied keyframe @ F" + kf.frame);
}

export function pasteKeyframe(): void {
  const clip = getActiveClip();
  if (!clip || !state.selectedBoneId || !state.keyframeClipboard) {
    status("⚠ コピー元なし"); return;
  }
  const bd = findBoneById(state.selectedBoneId);
  if (!bd) return;

  const kf: KeyframeData = {
    ...state.keyframeClipboard,
    frame: state.currentFrame,
  };

  let track = clip.tracks.find((t) => t.boneId === state.selectedBoneId);
  if (!track) {
    track = { boneId: state.selectedBoneId, boneName: bd.name, keyframes: [] };
    clip.tracks.push(track);
  }
  upsertKeyframe(track, kf);
  status("Pasted keyframe @ F" + state.currentFrame);
}

export function setKeyframeEasing(easingType: EasingType): void {
  const clip = getActiveClip();
  if (!clip || !state.selectedBoneId) return;
  const track = clip.tracks.find((t) => t.boneId === state.selectedBoneId);
  const kf = track?.keyframes.find((k) => k.frame === state.currentFrame);
  if (kf) {
    kf.easing = easingType;
    status("Easing: " + easingType);
  }
}

export function getKeyframeEasing(): EasingType {
  const clip = getActiveClip();
  if (!clip || !state.selectedBoneId) return "linear";
  const track = clip.tracks.find((t) => t.boneId === state.selectedBoneId);
  const kf = track?.keyframes.find((k) => k.frame === state.currentFrame);
  return kf?.easing ?? "linear";
}

// ── Simple 2-Bone IK (FABRIK) ──

export function solveIK(boneId: string): void {
  const skelData = getActiveSkeleton();
  if (!skelData) return;
  const bd = skelData.bones.find((b) => b.id === boneId);
  if (!bd?.ikConstraint?.enabled) return;

  const chainLen = bd.ikConstraint.chainLength;
  const target = new Vector3(bd.ikConstraint.targetX, bd.ikConstraint.targetY, bd.ikConstraint.targetZ);

  // Collect chain from tip to root
  const chain: typeof skelData.bones[0][] = [];
  let cur: typeof skelData.bones[0] | undefined = bd;
  for (let i = 0; i <= chainLen && cur; i++) {
    chain.push(cur);
    cur = cur.parentId ? skelData.bones.find((b) => b.id === cur!.parentId) : undefined;
  }
  if (chain.length < 2) return;

  const mesh = skelData.assignedMesh;
  if (!mesh) {
    status("\u26a0 Skeleton not assigned to mesh");
    return;
  }
  // Get joint positions
  const positions = chain.map((b) => b.bone.getAbsolutePosition(mesh).clone());

  // FABRIK iterations
  for (let iter = 0; iter < 10; iter++) {
    // Forward reaching (from tip to root)
    positions[0]!.copyFrom(target);
    for (let i = 1; i < positions.length; i++) {
      const segLen = Vector3.Distance(positions[i - 1]!, positions[i]!);
      if (segLen < 0.0001) continue;
      const dir = positions[i]!.subtract(positions[i - 1]!).normalize();
      const boneLen = chain[i - 1]!.bone.length || Vector3.Distance(
        chain[i - 1]!.bone.getAbsolutePosition(mesh),
        chain[i]!.bone.getAbsolutePosition(mesh)
      );
      positions[i]!.copyFrom(positions[i - 1]!.add(dir.scale(boneLen)));
    }

    // Backward reaching (from root to tip)
    const rootPos = chain[chain.length - 1]!.bone.getAbsolutePosition(mesh);
    positions[positions.length - 1]!.copyFrom(rootPos);
    for (let i = positions.length - 2; i >= 0; i--) {
      const segLen = Vector3.Distance(positions[i]!, positions[i + 1]!);
      if (segLen < 0.0001) continue;
      const dir = positions[i]!.subtract(positions[i + 1]!).normalize();
      const boneLen = chain[i]!.bone.length || Vector3.Distance(
        chain[i]!.bone.getAbsolutePosition(mesh),
        chain.length > i + 1 ? chain[i + 1]!.bone.getAbsolutePosition(mesh) : chain[i]!.bone.getAbsolutePosition(mesh)
      );
      positions[i]!.copyFrom(positions[i + 1]!.add(dir.scale(boneLen)));
    }
  }

  // Apply positions back to bone visuals
  for (let i = 0; i < chain.length; i++) {
    if (chain[i]!.visual) chain[i]!.visual!.position.copyFrom(positions[i]!);
  }
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

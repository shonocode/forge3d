import { Vector3, Quaternion, Matrix } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { Observer } from "@babylonjs/core/Misc/observable";
import type { Scene } from "@babylonjs/core/scene";
import type { Nullable } from "@babylonjs/core/types";
import { state, status } from "../state";
import type { AnimClipData, BoneTrack, KeyframeData } from "../state";
import { getActiveSkeleton, findBoneById, updateHierarchyVisualization, applyIKChain } from "./skeleton-tool";
import { getEasingFunction } from "./easing";
import type { EasingType } from "./easing";
import { evaluateBezierSegment } from "./bezier";
import type { AnimChannel } from "../state";

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

/**
 * Switch the active clip (clip selector UI). Stops any running preview,
 * clamps the playhead into the new clip's range, and applies its pose.
 */
export function setActiveClip(clipId: string): void {
  const clip = state.animClips.find((c) => c.id === clipId);
  if (!clip || state.activeClipId === clipId) return;
  stopPreview();
  state.activeClipId = clipId;
  scrubToFrame(Math.min(state.currentFrame, clip.maxFrames));
  status("Clip: " + clip.name);
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

// ── Undoable keyframe capture ──

function cloneKf(kf: KeyframeData): KeyframeData {
  const out: KeyframeData = {
    frame: kf.frame,
    rotation: { ...kf.rotation },
    position: { ...kf.position },
  };
  if (kf.easing !== undefined) out.easing = kf.easing;
  if (kf.tangents) out.tangents = structuredClone(kf.tangents);
  return out;
}

interface CaptureRecord {
  boneId: string;
  boneName: string;
  trackExisted: boolean;
  prevKf: KeyframeData | null;
  afterKf: KeyframeData;
}

/** Record the bone's current pose as a keyframe; returns undo bookkeeping. */
function recordBoneKeyframe(
  clip: AnimClipData,
  boneId: string,
  boneName: string,
  frame: number,
): CaptureRecord | null {
  const pose = getBonePose(boneId);
  if (!pose) return null;
  let track = clip.tracks.find((t) => t.boneId === boneId);
  const trackExisted = !!track;
  const existing = track?.keyframes.find((k) => k.frame === frame) ?? null;
  const prevKf = existing ? cloneKf(existing) : null;
  const kf: KeyframeData = { frame, rotation: pose.rotation, position: pose.position };
  if (!track) {
    track = { boneId, boneName, keyframes: [] };
    clip.tracks.push(track);
  }
  upsertKeyframe(track, kf);
  return { boneId, boneName, trackExisted, prevKf, afterKf: cloneKf(kf) };
}

/** Push a single history entry that reverses/replays a set of capture records. */
function pushCaptureUndo(
  label: string,
  clip: AnimClipData,
  frame: number,
  records: CaptureRecord[],
): void {
  if (!records.length) return;
  state.history.push({
    label,
    undo() {
      for (const r of records) {
        const ti = clip.tracks.findIndex((t) => t.boneId === r.boneId);
        if (ti === -1) continue;
        const track = clip.tracks[ti]!;
        if (!r.trackExisted) {
          clip.tracks.splice(ti, 1);
          continue;
        }
        const ki = track.keyframes.findIndex((k) => k.frame === frame);
        if (r.prevKf) {
          if (ki !== -1) track.keyframes[ki] = cloneKf(r.prevKf);
          else upsertKeyframe(track, cloneKf(r.prevKf));
        } else if (ki !== -1) {
          track.keyframes.splice(ki, 1);
        }
      }
      scrubToFrame(state.currentFrame);
    },
    redo() {
      for (const r of records) {
        let track = clip.tracks.find((t) => t.boneId === r.boneId);
        if (!track) {
          track = { boneId: r.boneId, boneName: r.boneName, keyframes: [] };
          clip.tracks.push(track);
        }
        upsertKeyframe(track, cloneKf(r.afterKf));
      }
      scrubToFrame(state.currentFrame);
    },
  });
}

/**
 * Called after a pose edit (rotation gizmo drag end in Pose Mode). With
 * Auto-Key on and an active clip, the edited bone is keyed immediately
 * (undoable). Otherwise the pose is flagged dirty so the next scrub can warn
 * that the unkeyed pose is being discarded.
 */
export function notifyPoseEdited(boneId: string): void {
  const clip = getActiveClip();
  if (state.autoKey && clip) {
    const bd = findBoneById(boneId);
    if (!bd) return;
    const rec = recordBoneKeyframe(clip, boneId, bd.name, state.currentFrame);
    if (rec) {
      pushCaptureUndo("Auto-Key", clip, state.currentFrame, [rec]);
      status("Auto-Key: " + bd.name + " @ " + state.currentFrame);
    }
  } else {
    state.poseDirty = true;
  }
}

/**
 * Capture keyframe for the currently selected bone at the current frame.
 * Undoable.
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

  const rec = recordBoneKeyframe(clip, bd.id, bd.name, state.currentFrame);
  if (!rec) return;
  pushCaptureUndo("Record Key", clip, state.currentFrame, [rec]);
  state.poseDirty = false;

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

  const records: CaptureRecord[] = [];
  for (const bd of skelData.bones) {
    const rec = recordBoneKeyframe(clip, bd.id, bd.name, state.currentFrame);
    if (rec) records.push(rec);
  }
  pushCaptureUndo("Record All Keys", clip, state.currentFrame, records);
  state.poseDirty = false;

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

  // Unkeyed pose edits are about to be overwritten by the clip pose — warn
  // once so the user knows to Record (or turn Auto-Key on) next time.
  if (state.poseDirty && clip.tracks.length) {
    status("⚠ 未キーのポーズをスクラブで破棄 — Record するか Auto-Key を ON に");
  }
  state.poseDirty = false;

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

  syncBoneVisuals();
}

/**
 * Recompute the active skeleton's absolute transforms and copy each bone's
 * world position into its associated visual gizmo. Call this whenever
 * something external (own clip playback, imported AnimationGroup, IK solve)
 * has mutated the skeleton's bone matrices.
 */
export function syncBoneVisuals(): void {
  const skelData = getActiveSkeleton();
  if (!skelData) return;
  skelData.skeleton.computeAbsoluteTransforms();
  for (const bd of skelData.bones) {
    if (!bd.visual) continue;
    const abs = bd.bone.getAbsoluteTransform();
    bd.visual.position.set(abs.m[12]!, abs.m[13]!, abs.m[14]!);
  }
  // Connector lines between bones — must follow each frame too.
  updateHierarchyVisualization(skelData);
}

/**
 * Read a scalar channel value from a keyframe via short channel id.
 * Centralized here so Bezier evaluation can look up "what is `rx` on
 * this key" without each call site duplicating the switch.
 */
function channelValue(kf: KeyframeData, ch: AnimChannel): number {
  switch (ch) {
    case "px": return kf.position.x;
    case "py": return kf.position.y;
    case "pz": return kf.position.z;
    case "rx": return kf.rotation.x;
    case "ry": return kf.rotation.y;
    case "rz": return kf.rotation.z;
  }
}

/**
 * Pick the interpolated value of one channel on the segment from
 * `a` to `b` at the given frame.
 *
 * Priority:
 *   1. If both ends have tangents for this channel → cubic Bezier
 *      (full per-channel curve control).
 *   2. Otherwise → linear lerp on the channel, with `t` shaped by
 *      `a.easing` if present. This matches the V1 behavior.
 *
 * Returning a scalar per call instead of pre-allocating a result
 * vector keeps this branch-friendly and avoids per-frame allocations
 * during real-time playback.
 */
function interpolateChannel(a: KeyframeData, b: KeyframeData, ch: AnimChannel, frame: number): number {
  const va = channelValue(a, ch);
  const vb = channelValue(b, ch);

  const aTan = a.tangents?.[ch];
  const bTan = b.tangents?.[ch];
  if (aTan && bTan) {
    return evaluateBezierSegment(
      frame,
      a.frame, va,
      aTan.out[0], aTan.out[1],
      b.frame, vb,
      bTan.in[0], bTan.in[1],
    );
  }

  // Easing fallback (matches V1 path).
  if (a.frame === b.frame) return va;
  let t = (frame - a.frame) / (b.frame - a.frame);
  if (a.easing) t = getEasingFunction(a.easing)(t);
  return va + (vb - va) * t;
}

export function interpolateTrack(track: BoneTrack, frame: number): KeyframeData | null {
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

      // If any rotation channel has Bezier tangents on either end, we
      // can't use a single quaternion slerp — interpolate each Euler
      // axis independently. This trades the slerp's gimbal-lock
      // resistance for the user's explicit per-channel control. Bones
      // doing big sweeps that need slerp should leave their rotation
      // tangents off and stick with easing mode.
      const hasRotTangent = ["rx", "ry", "rz"].some((ch) =>
        a.tangents?.[ch as AnimChannel] || b.tangents?.[ch as AnimChannel],
      );

      let rx: number, ry: number, rz: number;
      if (hasRotTangent) {
        rx = interpolateChannel(a, b, "rx", frame);
        ry = interpolateChannel(a, b, "ry", frame);
        rz = interpolateChannel(a, b, "rz", frame);
      } else {
        // V1 path: shared `t` from easing, quaternion slerp.
        let t = (frame - a.frame) / (b.frame - a.frame);
        if (a.easing) t = getEasingFunction(a.easing)(t);
        const quatA = Quaternion.FromEulerAngles(a.rotation.x, a.rotation.y, a.rotation.z);
        const quatB = Quaternion.FromEulerAngles(b.rotation.x, b.rotation.y, b.rotation.z);
        const quatInterp = Quaternion.Slerp(quatA, quatB, t);
        const eulerInterp = quatInterp.toEulerAngles();
        rx = eulerInterp.x;
        ry = eulerInterp.y;
        rz = eulerInterp.z;
      }

      return {
        frame,
        rotation: { x: rx, y: ry, z: rz },
        position: {
          x: interpolateChannel(a, b, "px", frame),
          y: interpolateChannel(a, b, "py", frame),
          z: interpolateChannel(a, b, "pz", frame),
        },
      };
    }
  }
  return kfs[kfs.length - 1]!;
}

// ── Preview playback ──
//
// Drives playback by advancing `state.currentFrame` in real time and
// calling `scrubToFrame()` each render tick. This keeps a single source
// of truth for bone pose evaluation (interpolation + easing + visual
// gizmo sync) instead of duplicating it in a Babylon AnimationGroup.

let _playObserver: Nullable<Observer<Scene>> = null;
let _playStartFrame = 0;
let _playStartTimeMs = 0;
let _playbackTickCb: ((frame: number) => void) | null = null;

/** UI registers here to be notified of frame advances during playback. */
export function setPlaybackTickCallback(cb: ((frame: number) => void) | null): void {
  _playbackTickCb = cb;
}

export function playPreview(): void {
  const clip = getActiveClip();
  if (!clip || clip.tracks.length === 0) {
    status("⚠ No keyframes to play");
    return;
  }
  if (!state.scene) {
    status("⚠ Scene not ready");
    return;
  }

  stopPreview();

  // Resume from current frame; if at/past end, restart from 0.
  _playStartFrame = state.currentFrame >= clip.maxFrames ? 0 : state.currentFrame;
  _playStartTimeMs = performance.now();
  state.isPlaying = true;
  status("Playing: " + clip.name);

  _playObserver = state.scene.onBeforeRenderObservable.add(_tickPlayback);
}

export function stopPreview(): void {
  if (_playObserver && state.scene) {
    state.scene.onBeforeRenderObservable.remove(_playObserver);
  }
  _playObserver = null;
  state.isPlaying = false;
}

function _tickPlayback(): void {
  const clip = getActiveClip();
  if (!clip || !state.isPlaying) return;

  const elapsedSec = (performance.now() - _playStartTimeMs) / 1000;
  let frame = _playStartFrame + elapsedSec * clip.frameRate;

  if (frame >= clip.maxFrames) {
    if (clip.loopMode === "cycle") {
      const range = clip.maxFrames > 0 ? clip.maxFrames : 1;
      frame = ((frame % range) + range) % range;
    } else {
      frame = clip.maxFrames;
      scrubToFrame(frame);
      _playbackTickCb?.(frame);
      stopPreview();
      return;
    }
  }

  scrubToFrame(frame);
  _playbackTickCb?.(frame);
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

// ── IK constraint evaluation (per-frame) ──

/**
 * Evaluate the IK constraint on `boneId` for this frame. Delegates to the
 * shared FABRIK core in skeleton-tool, which writes the solved pose onto the
 * actual bone matrices (so the skinned mesh deforms) and cascades visuals —
 * not just the gizmo spheres. No-op unless the bone has IK enabled.
 *
 * No undo is pushed: this runs from the render hook and animation playback
 * where per-frame history churn is unwanted. The interactive, undo-able solve
 * lives in `skeleton-tool.solveIKForBone`.
 */
export function solveIK(boneId: string): void {
  const bd = findBoneById(boneId);
  const ik = bd?.ikConstraint;
  if (!ik?.enabled) return;
  const target = new Vector3(ik.targetX, ik.targetY, ik.targetZ);
  applyIKChain(boneId, target);
}

/**
 * Iterate every bone with an enabled IK constraint and run {@link solveIK}.
 * Cheap when no bones have IK (early-out per skeleton). Designed to be
 * called from the per-frame render observable — see {@link installIkRenderHook}.
 */
export function solveAllIKConstraints(): void {
  for (const [, skel] of state.skeletonMap) {
    for (const bd of skel.bones) {
      if (bd.ikConstraint?.enabled) solveIK(bd.id);
    }
  }
}

let _ikRenderObserver: Nullable<Observer<Scene>> = null;

/**
 * Subscribe {@link solveAllIKConstraints} to the scene's pre-render hook.
 * Idempotent — calling twice is safe (re-subscribes after disposing the
 * previous observer). Call once during scene bootstrap.
 */
export function installIkRenderHook(scene: Scene): void {
  if (_ikRenderObserver) {
    scene.onBeforeRenderObservable.remove(_ikRenderObserver);
    _ikRenderObserver = null;
  }
  _ikRenderObserver = scene.onBeforeRenderObservable.add(() => {
    solveAllIKConstraints();
    updateIkTargetMarker();
  });
}

// ── IK target visual marker ──
//
// A small magenta sphere shows where the selected bone's IK target sits
// in world space. Visible only while the selected bone has IK enabled;
// otherwise hidden. The mesh is created lazily on first need and reused
// — disposing/recreating it per selection would thrash GPU buffers.

let _ikTargetMarker: Mesh | null = null;

/**
 * Reposition (and show/hide) the IK target marker based on the currently
 * selected bone's IK constraint. No-op if no bone is selected or IK isn't
 * enabled. Lazy-creates the marker mesh on first call that needs it.
 */
export function updateIkTargetMarker(): void {
  const sceneRef = state.scene;
  if (!sceneRef) return;

  let bd = null;
  if (state.selectedBoneId) bd = findBoneById(state.selectedBoneId);
  const ik = bd?.ikConstraint;

  if (!ik?.enabled) {
    if (_ikTargetMarker) _ikTargetMarker.isVisible = false;
    return;
  }

  if (!_ikTargetMarker) {
    _ikTargetMarker = MeshBuilder.CreateSphere("__ikTargetMarker", { diameter: 0.08 }, sceneRef);
    const mat = new StandardMaterial("__ikTargetMarkerMat", sceneRef);
    mat.emissiveColor = new Color3(1, 0.2, 1);
    mat.disableLighting = true;
    _ikTargetMarker.material = mat;
    _ikTargetMarker.isPickable = false;
    _ikTargetMarker.renderingGroupId = 1; // draw on top of geometry
  }

  _ikTargetMarker.isVisible = true;
  _ikTargetMarker.position.set(ik.targetX, ik.targetY, ik.targetZ);
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

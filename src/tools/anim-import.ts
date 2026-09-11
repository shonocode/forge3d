/**
 * Turn animation loaded from a glTF into clips the editor can edit.
 *
 * Importing a GLB already builds an editable skeleton — bones, hierarchy,
 * visuals — but its animation stops at `state.importedAnimGroups`, which the
 * UI can only play and re-export. So a clip authored elsewhere can be watched
 * in forge3d and never opened: the dopesheet and the graph editor work on
 * `state.animClips`, and nothing writes to it. That is the whole gap between
 * "forge3d has an animation editor" and "forge3d can tune the game's punch".
 *
 * ## Two shapes to reconcile
 *
 * glTF animates *nodes* with separate translation and rotation samplers, and
 * its rotations are quaternions. The editor keys *bones*, bundles position and
 * rotation into one keyframe, and stores rotation as euler angles. So the
 * conversion has three jobs: match node names to bones, union the frames the
 * two samplers were keyed at, and convert quaternions to the euler convention
 * `animation-tool` uses (`Quaternion.FromEulerAngles`, i.e. Y·X·Z).
 *
 * Unioning matters. A track keyed at frames 0/6/12 for rotation and 0/12 for
 * position has to come back as keyframes at 0, 6 and 12 with *both* channels
 * filled, because a `KeyframeData` carries both. The missing position at frame
 * 6 is sampled off its own curve rather than left at the previous key, so the
 * round trip does not quietly introduce a hold.
 *
 * ## Structure
 *
 * {@link clipFromTracks} is pure and takes plain numbers, so the whole
 * conversion is testable without a scene. {@link tracksFromAnimationGroup} is
 * the thin Babylon adapter that feeds it.
 */
import { Quaternion } from "@babylonjs/core/Maths/math.vector";
import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import type { AnimClipData, BoneTrack, KeyframeData, AnimLoopMode } from "../state";

/** One sampler key: a frame and its raw components (3 for a vector, 4 for a quaternion). */
export interface SourceKey {
  frame: number;
  value: readonly number[];
}

/** Which of a node's transform channels a sampler drives. */
export type SourceChannel = "position" | "rotation" | "rotationQuaternion";

/** One glTF sampler, flattened. */
export interface SourceTrack {
  /** Node name, matched against bone names. */
  targetName: string;
  channel: SourceChannel;
  frameRate: number;
  keys: SourceKey[];
}

/** Resolves a glTF node name to a bone in the editor's skeleton. */
export type BoneResolver = (name: string) => { boneId: string; boneName: string } | null;

const ZERO = { x: 0, y: 0, z: 0 };

/** Linear sample of a vector track. Outside the keyed range it holds the end. */
function sampleVector(keys: readonly SourceKey[], frame: number): { x: number; y: number; z: number } {
  if (keys.length === 0) return { ...ZERO };
  const first = keys[0]!;
  if (frame <= first.frame) return vec(first.value);
  const last = keys[keys.length - 1]!;
  if (frame >= last.frame) return vec(last.value);

  for (let i = 0; i + 1 < keys.length; i++) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    if (frame >= a.frame && frame <= b.frame) {
      const span = b.frame - a.frame;
      const t = span === 0 ? 0 : (frame - a.frame) / span;
      return {
        x: lerp(a.value[0], b.value[0], t),
        y: lerp(a.value[1], b.value[1], t),
        z: lerp(a.value[2], b.value[2], t),
      };
    }
  }
  return vec(last.value);
}

/**
 * Spherical sample of a quaternion track, converted to euler.
 *
 * Slerp rather than component lerp, because that is what glTF's LINEAR
 * interpolation means for a rotation sampler — and what Babylon will do when
 * the same file is played back in the game.
 */
function sampleQuaternionAsEuler(
  keys: readonly SourceKey[],
  frame: number,
): { x: number; y: number; z: number } {
  if (keys.length === 0) return { ...ZERO };

  const at = (k: SourceKey): Quaternion =>
    new Quaternion(k.value[0] ?? 0, k.value[1] ?? 0, k.value[2] ?? 0, k.value[3] ?? 1);

  const first = keys[0]!;
  if (frame <= first.frame) return euler(at(first));
  const last = keys[keys.length - 1]!;
  if (frame >= last.frame) return euler(at(last));

  for (let i = 0; i + 1 < keys.length; i++) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    if (frame >= a.frame && frame <= b.frame) {
      const span = b.frame - a.frame;
      const t = span === 0 ? 0 : (frame - a.frame) / span;
      return euler(Quaternion.Slerp(at(a), at(b), t));
    }
  }
  return euler(at(last));
}

function euler(q: Quaternion): { x: number; y: number; z: number } {
  const e = q.toEulerAngles();
  return { x: e.x, y: e.y, z: e.z };
}

function vec(value: readonly number[]): { x: number; y: number; z: number } {
  return { x: value[0] ?? 0, y: value[1] ?? 0, z: value[2] ?? 0 };
}

const lerp = (a: number | undefined, b: number | undefined, t: number): number =>
  (a ?? 0) + ((b ?? 0) - (a ?? 0)) * t;

/**
 * Build one editable clip from a set of flattened samplers.
 *
 * Tracks whose target does not resolve to a bone are dropped — a glTF may
 * animate nodes that are not part of the skeleton, and silently keying a bone
 * that happens to share a name would be worse than losing the track.
 */
export function clipFromTracks(
  name: string,
  tracks: readonly SourceTrack[],
  resolve: BoneResolver,
  id: string,
): AnimClipData {
  const byTarget = new Map<string, SourceTrack[]>();
  for (const track of tracks) {
    const list = byTarget.get(track.targetName);
    if (list) list.push(track);
    else byTarget.set(track.targetName, [track]);
  }

  const boneTracks: BoneTrack[] = [];
  let maxFrames = 0;
  let frameRate = 0;

  for (const [targetName, group] of byTarget) {
    const bone = resolve(targetName);
    if (!bone) continue;

    const position = group.find((t) => t.channel === "position");
    const quaternion = group.find((t) => t.channel === "rotationQuaternion");
    const eulerTrack = group.find((t) => t.channel === "rotation");

    // Every frame either sampler was keyed at. A KeyframeData carries both
    // channels, so each one has to be filled from its own curve.
    const frames = new Set<number>();
    for (const track of group) for (const key of track.keys) frames.add(key.frame);
    if (frames.size === 0) continue;

    const ordered = [...frames].sort((a, b) => a - b);
    const keyframes: KeyframeData[] = ordered.map((frame) => ({
      frame,
      position: position ? sampleVector(position.keys, frame) : { ...ZERO },
      rotation: quaternion
        ? sampleQuaternionAsEuler(quaternion.keys, frame)
        : eulerTrack
          ? sampleVector(eulerTrack.keys, frame)
          : { ...ZERO },
    }));

    boneTracks.push({ boneId: bone.boneId, boneName: bone.boneName, keyframes });
    maxFrames = Math.max(maxFrames, ordered[ordered.length - 1]!);
    frameRate = frameRate || group[0]!.frameRate;
  }

  return {
    id,
    name,
    frameRate: frameRate || 60,
    // A clip that ends on its last key has nothing to scrub into, and the
    // editor treats maxFrames as the timeline length rather than the index of
    // the final key.
    maxFrames: Math.max(1, Math.ceil(maxFrames)),
    loopMode: "cycle" as AnimLoopMode,
    tracks: boneTracks,
  };
}

/** Babylon's `targetProperty` strings, narrowed to the channels we carry. */
function channelOf(property: string): SourceChannel | null {
  if (property === "position" || property === "rotation" || property === "rotationQuaternion") {
    return property;
  }
  return null;
}

/**
 * Flatten a Babylon `AnimationGroup` into plain samplers.
 *
 * Scaling and every other animated property is dropped: the editor's keyframe
 * model has no room for them, and pretending otherwise would lose them on the
 * next export without saying so.
 */
export function tracksFromAnimationGroup(group: AnimationGroup): SourceTrack[] {
  const out: SourceTrack[] = [];

  for (const targeted of group.targetedAnimations) {
    const animation = targeted.animation;
    const channel = channelOf(animation.targetProperty);
    if (!channel) continue;

    const target = targeted.target as { name?: string } | null;
    const targetName = target?.name;
    if (!targetName) continue;

    const keys: SourceKey[] = animation.getKeys().map((key) => {
      const v = key.value as { x?: number; y?: number; z?: number; w?: number };
      return {
        frame: key.frame,
        value:
          channel === "rotationQuaternion"
            ? [v.x ?? 0, v.y ?? 0, v.z ?? 0, v.w ?? 1]
            : [v.x ?? 0, v.y ?? 0, v.z ?? 0],
      };
    });
    if (keys.length === 0) continue;

    out.push({
      targetName,
      channel,
      frameRate: animation.framePerSecond || 60,
      keys,
    });
  }

  return out;
}

/** Convert every imported group into an editable clip. */
export function clipsFromAnimationGroups(
  groups: readonly AnimationGroup[],
  resolve: BoneResolver,
  makeId: (index: number) => string,
): AnimClipData[] {
  return groups.map((group, i) =>
    clipFromTracks(group.name, tracksFromAnimationGroup(group), resolve, makeId(i)),
  );
}

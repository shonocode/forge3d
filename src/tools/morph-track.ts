/**
 * Morph (blend-shape) animation tracks — pure keyframe math.
 *
 * A MorphTrack keys one morph target's influence over time, in parallel with
 * the bone tracks of a clip. Interpolation matches the bone-track behavior:
 * clamp before the first / after the last key, and ease between neighboring
 * keys using the LEFT key's easing (same convention as interpolateTrack).
 *
 * Headless-testable: no Babylon, no DOM.
 */

import type { MorphKeyframe, MorphTrack } from "../state";
import { getEasingFunction } from "./easing";
import { evaluateBezierSegment } from "./bezier";

/** Evaluate a track's influence at `frame`. Returns null for empty tracks. */
export function evalMorphTrack(track: MorphTrack, frame: number): number | null {
  const kfs = track.keyframes;
  if (kfs.length === 0) return null;
  if (frame <= kfs[0]!.frame) return kfs[0]!.value;
  const last = kfs[kfs.length - 1]!;
  if (frame >= last.frame) return last.value;

  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i]!;
    const b = kfs[i + 1]!;
    if (frame < a.frame || frame > b.frame) continue;
    const span = b.frame - a.frame;
    if (span <= 0) return b.value;
    // Bezier segment when both surrounding keys carry tangents (same rule
    // as bone channels); influence stays clamped to [0, 1] even if the
    // handles overshoot.
    if (a.tangents && b.tangents) {
      const v = evaluateBezierSegment(
        frame,
        a.frame, a.value, a.tangents.out[0], a.tangents.out[1],
        b.frame, b.value, b.tangents.in[0], b.tangents.in[1],
      );
      return v < 0 ? 0 : v > 1 ? 1 : v;
    }
    const t = (frame - a.frame) / span;
    const eased = getEasingFunction(a.easing ?? "linear")(t);
    return a.value + (b.value - a.value) * eased;
  }
  return last.value;
}

/** Insert or replace a keyframe, keeping the track sorted by frame. */
export function upsertMorphKey(track: MorphTrack, kf: MorphKeyframe): void {
  const idx = track.keyframes.findIndex((k) => k.frame === kf.frame);
  if (idx !== -1) {
    track.keyframes[idx] = kf;
  } else {
    track.keyframes.push(kf);
    track.keyframes.sort((a, b) => a.frame - b.frame);
  }
}

/**
 * Remove the keyframe at `frame` (exact match). Returns the removed keyframe,
 * or null if none existed.
 */
export function removeMorphKeyAt(track: MorphTrack, frame: number): MorphKeyframe | null {
  const idx = track.keyframes.findIndex((k) => k.frame === frame);
  if (idx === -1) return null;
  return track.keyframes.splice(idx, 1)[0] ?? null;
}

/** Stable identity for a morph track within a clip. */
export function morphTrackKey(meshUniqueId: number, targetIndex: number): string {
  return meshUniqueId + ":" + targetIndex;
}

/** Find a clip's track for (mesh, target), if present. */
export function findMorphTrack(
  tracks: readonly MorphTrack[] | undefined,
  meshUniqueId: number,
  targetIndex: number,
): MorphTrack | null {
  if (!tracks) return null;
  return tracks.find((t) => t.meshUniqueId === meshUniqueId && t.targetIndex === targetIndex) ?? null;
}

import { describe, it, expect } from "vitest";
import { Quaternion } from "@babylonjs/core/Maths/math.vector";

import { clipFromTracks, type SourceTrack, type BoneResolver } from "./anim-import";

const resolveAll: BoneResolver = (name) => ({ boneId: `id:${name}`, boneName: name });
const resolveNone: BoneResolver = () => null;

/** Quaternion components for a rotation stated as euler, editor convention. */
function q(x: number, y: number, z: number): number[] {
  const r = Quaternion.FromEulerAngles(x, y, z);
  return [r.x, r.y, r.z, r.w];
}

function rotationTrack(target: string, keys: { frame: number; value: number[] }[]): SourceTrack {
  return { targetName: target, channel: "rotationQuaternion", frameRate: 60, keys };
}

describe("clipFromTracks", () => {
  it("test_quaternion_keys_come_back_as_the_euler_they_were_built_from", () => {
    const clip = clipFromTracks(
      "Punch",
      [rotationTrack("rightUpperArm", [
        { frame: 0, value: q(0, 0, 0) },
        { frame: 9, value: q(-Math.PI / 2.6, 0, Math.PI / 2.6) },
      ])],
      resolveAll,
      "clip0",
    );

    const keys = clip.tracks[0]!.keyframes;
    expect(keys).toHaveLength(2);
    expect(keys[1]!.rotation.x).toBeCloseTo(-Math.PI / 2.6, 5);
    expect(keys[1]!.rotation.z).toBeCloseTo(Math.PI / 2.6, 5);
  });

  it("test_position_and_rotation_keyed_at_different_frames_are_unioned", () => {
    const clip = clipFromTracks(
      "Punch",
      [
        rotationTrack("hip", [
          { frame: 0, value: q(0, 0, 0) },
          { frame: 6, value: q(0, 0, 0) },
          { frame: 12, value: q(0, 0, 0) },
        ]),
        {
          targetName: "hip",
          channel: "position",
          frameRate: 60,
          keys: [
            { frame: 0, value: [0, 0, 0] },
            { frame: 12, value: [0, 1.2, 0] },
          ],
        },
      ],
      resolveAll,
      "clip0",
    );

    const keys = clip.tracks[0]!.keyframes;
    expect(keys.map((k) => k.frame)).toEqual([0, 6, 12]);
    // Frame 6 has no position key of its own; it is sampled off the position
    // curve rather than held at the previous value.
    expect(keys[1]!.position.y).toBeCloseTo(0.6, 5);
  });

  it("test_rotation_between_keys_is_slerped_not_component_lerped", () => {
    // A 180 degree turn about Y, sampled at the midpoint. Slerp gives 90
    // degrees; lerping the quaternion components would not.
    const clip = clipFromTracks(
      "Turn",
      [
        rotationTrack("spine", [
          { frame: 0, value: q(0, 0, 0) },
          { frame: 10, value: q(0, Math.PI * 0.9, 0) },
        ]),
        {
          targetName: "spine",
          channel: "position",
          frameRate: 60,
          keys: [{ frame: 5, value: [0, 0, 0] }],
        },
      ],
      resolveAll,
      "clip0",
    );

    const mid = clip.tracks[0]!.keyframes.find((k) => k.frame === 5)!;
    expect(mid.rotation.y).toBeCloseTo(Math.PI * 0.45, 4);
  });

  it("test_tracks_whose_target_is_not_a_bone_are_dropped", () => {
    const clip = clipFromTracks(
      "Punch",
      [rotationTrack("someLightNode", [{ frame: 0, value: q(0, 0, 0) }])],
      resolveNone,
      "clip0",
    );
    expect(clip.tracks).toHaveLength(0);
  });

  it("test_clip_length_covers_the_last_key", () => {
    const clip = clipFromTracks(
      "Punch",
      [rotationTrack("neck", [
        { frame: 0, value: q(0, 0, 0) },
        { frame: 30, value: q(0, 0, 0) },
      ])],
      resolveAll,
      "clip0",
    );
    expect(clip.maxFrames).toBe(30);
    expect(clip.frameRate).toBe(60);
    expect(clip.name).toBe("Punch");
    expect(clip.id).toBe("clip0");
  });

  it("test_an_empty_group_still_produces_a_usable_clip", () => {
    const clip = clipFromTracks("Empty", [], resolveAll, "clip0");
    expect(clip.tracks).toHaveLength(0);
    // A zero-length timeline cannot be scrubbed, so it clamps to one frame.
    expect(clip.maxFrames).toBe(1);
    expect(clip.frameRate).toBe(60);
  });

  it("test_a_euler_rotation_track_is_taken_when_there_is_no_quaternion", () => {
    // Babylon's own procedural clips key `rotation` as a Vector3. A GLB never
    // does, but a clip built in-engine and handed over does.
    const clip = clipFromTracks(
      "Procedural",
      [{
        targetName: "rightForeArm",
        channel: "rotation",
        frameRate: 30,
        keys: [
          { frame: 0, value: [0, 0, 0] },
          { frame: 4, value: [Math.PI / 2, 0, 0] },
        ],
      }],
      resolveAll,
      "clip0",
    );

    const keys = clip.tracks[0]!.keyframes;
    expect(keys[1]!.rotation.x).toBeCloseTo(Math.PI / 2, 5);
    expect(clip.frameRate).toBe(30);
  });
});

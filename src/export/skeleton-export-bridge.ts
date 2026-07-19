import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Vector3, Quaternion } from "@babylonjs/core/Maths/math.vector";
import { Animation } from "@babylonjs/core/Animations/animation";
import { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import type { Scene } from "@babylonjs/core/scene";
import type { SkeletonData, AnimClipData } from "../state";
import { state } from "../state";

/**
 * Bridge that prepares a forge3d skeleton + clips for GLB export and tears
 * the rig back down afterwards.
 *
 * Babylon's GLTF2 exporter only emits bones that have a linked TransformNode
 * (`Bone.linkTransformNode(...)`), since glTF expresses skeletons through
 * the standard node hierarchy with a `skin` reference. forge3d historically
 * built bare `Bone`s with no TransformNode, which produced the
 * "Exporting a bone without a linked transform node is currently
 * unsupported" warning and dropped the skeleton from the GLB.
 *
 * Likewise, user-authored clips live in {@link state.animClips} as a
 * forge3d-native structure rather than as Babylon Animations attached to
 * scene objects, so they are invisible to the exporter unless we
 * synthesise AnimationGroups that target the linked TransformNodes.
 *
 * Use {@link prepareExportRig} immediately before invoking the exporter,
 * and {@link disposeExportRig} in a `finally` block to undo the link and
 * dispose the temporary nodes/groups regardless of whether the export
 * threw.
 */
export interface ExportRig {
  transformNodes: TransformNode[];
  /** boneId → its linked TransformNode (lookup convenience). */
  tnByBoneId: Map<string, TransformNode>;
  /** AnimationGroups synthesised from `state.animClips`. */
  animationGroups: AnimationGroup[];
}

const _scratchScale = new Vector3();
const _scratchRot = new Quaternion();
const _scratchPos = new Vector3();

/**
 * Build linked TransformNodes mirroring the bone hierarchy and synthesise
 * AnimationGroups for each authored clip.
 *
 * Bones are processed in iteration order of `skelData.bones`. For this to
 * produce the correct parent→child node parenting, parents must appear
 * before their children in the array. forge3d's `addBoneAtPoint` always
 * pushes new bones at the tail and only allows attaching to an existing
 * bone, so this invariant holds for any skeleton authored in-app. If a
 * future feature reorders bones, sort topologically before linking.
 */
export function prepareExportRig(
  skelData: SkeletonData | null,
  scene: Scene,
): ExportRig {
  const transformNodes: TransformNode[] = [];
  const tnByBoneId = new Map<string, TransformNode>();

  // Refresh absolute transforms so we link with the current resting pose.
  // skelData may be null for morph-only scenes — clips still export their
  // morph influence animations below.
  skelData?.skeleton.computeAbsoluteTransforms();

  for (const bd of skelData?.bones ?? []) {
    const tn = new TransformNode("boneTN_" + bd.id, scene);

    // Decompose the bone's local matrix into the TransformNode so the
    // exported node has TRS that round-trips to glTF cleanly.
    const localMat = bd.bone.getLocalMatrix();
    localMat.decompose(_scratchScale, _scratchRot, _scratchPos);
    tn.position.copyFrom(_scratchPos);
    tn.rotationQuaternion = _scratchRot.clone();
    tn.scaling.copyFrom(_scratchScale);

    // Parent within the TN tree.
    if (bd.parentId) {
      const parentTn = tnByBoneId.get(bd.parentId);
      if (parentTn) tn.parent = parentTn;
    } else if (skelData?.assignedMesh) {
      // Root bones hang under the skinned mesh so the GLTF exporter walks
      // the rig from a known scene root.
      tn.parent = skelData.assignedMesh;
    }

    bd.bone.linkTransformNode(tn);
    transformNodes.push(tn);
    tnByBoneId.set(bd.id, tn);
  }

  const animationGroups: AnimationGroup[] = [];
  for (const clip of state.animClips) {
    const group = buildClipAnimationGroup(clip, tnByBoneId, scene);
    if (group) animationGroups.push(group);
  }

  return { transformNodes, tnByBoneId, animationGroups };
}

/**
 * Restore the skeleton to its un-linked state and free temporary resources.
 * Safe to call even if `prepareExportRig` threw partway through.
 */
export function disposeExportRig(
  skelData: SkeletonData | null,
  rig: ExportRig,
): void {
  for (const bd of skelData?.bones ?? []) {
    bd.bone.linkTransformNode(null);
  }
  for (const group of rig.animationGroups) {
    try { group.stop(); } catch { /* may already be stopped */ }
    try { group.dispose(); } catch { /* ignore */ }
  }
  for (const tn of rig.transformNodes) {
    try { tn.dispose(); } catch { /* ignore */ }
  }
}

/**
 * Convert a forge3d clip into a Babylon AnimationGroup whose targeted
 * animations write to the linked TransformNodes' `position` and
 * `rotationQuaternion`. Returns null if the clip has no usable tracks.
 */
function buildClipAnimationGroup(
  clip: AnimClipData,
  tnByBoneId: Map<string, TransformNode>,
  scene: Scene,
): AnimationGroup | null {
  const group = new AnimationGroup(clip.name, scene);
  let added = 0;

  const loopMode = clip.loopMode === "cycle"
    ? Animation.ANIMATIONLOOPMODE_CYCLE
    : Animation.ANIMATIONLOOPMODE_CONSTANT;

  for (const track of clip.tracks) {
    if (track.keyframes.length === 0) continue;
    const tn = tnByBoneId.get(track.boneId);
    if (!tn) continue;

    // Position
    const posAnim = new Animation(
      track.boneName + "_pos",
      "position",
      clip.frameRate,
      Animation.ANIMATIONTYPE_VECTOR3,
      loopMode,
    );
    posAnim.setKeys(track.keyframes.map((kf) => ({
      frame: kf.frame,
      value: new Vector3(kf.position.x, kf.position.y, kf.position.z),
    })));
    group.addTargetedAnimation(posAnim, tn);

    // Rotation as quaternion to avoid gimbal/wraparound issues in glTF.
    const rotAnim = new Animation(
      track.boneName + "_rot",
      "rotationQuaternion",
      clip.frameRate,
      Animation.ANIMATIONTYPE_QUATERNION,
      loopMode,
    );
    rotAnim.setKeys(track.keyframes.map((kf) => ({
      frame: kf.frame,
      value: Quaternion.FromEulerAngles(kf.rotation.x, kf.rotation.y, kf.rotation.z),
    })));
    group.addTargetedAnimation(rotAnim, tn);

    added += 2;
  }

  // Morph (blend-shape) tracks — animate MorphTarget.influence directly.
  // Babylon's glTF exporter turns these into standard glTF morph-weight
  // animation channels, so facial animation survives the round trip.
  for (const track of clip.morphTracks ?? []) {
    if (track.keyframes.length === 0) continue;
    const morph = state.morphMap.get(track.meshUniqueId);
    const target = morph?.targets[track.targetIndex];
    if (!target) continue;

    const infAnim = new Animation(
      track.targetName + "_influence",
      "influence",
      clip.frameRate,
      Animation.ANIMATIONTYPE_FLOAT,
      loopMode,
    );
    infAnim.setKeys(track.keyframes.map((kf) => ({ frame: kf.frame, value: kf.value })));
    group.addTargetedAnimation(infAnim, target);
    added += 1;
  }

  if (added === 0) {
    group.dispose();
    return null;
  }
  return group;
}

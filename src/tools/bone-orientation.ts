import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";

/**
 * Pure bone-orientation math for the F-M6 rig-quality work: rest orientation
 * (roll) computation, parent-space translation conversion, and IK-chain
 * translation rebuilds that survive rotated local matrices.
 *
 * Headless and deterministic — no scene / skeleton dependency — so every
 * formula here is pinned by Vitest. The scene-touching integration lives in
 * `skeleton-tool.ts`.
 *
 * Quaternion convention: Babylon's `q1.multiply(q2)` is the Hamilton product
 * — the rotation that applies **q2 first, then q1** (the opposite of
 * `Matrix.multiply`'s row-vector left-to-right order). All compositions in
 * this file are written against that convention:
 *
 *   worldRot = parentAbsRot.multiply(localRot)   // local first, then parent
 */

/** The bone's primary axis in its own space (Blender convention: +Y). */
export const BONE_PRIMARY_AXIS = new Vector3(0, 1, 0);

/**
 * Direction from a bone toward its "tail" (usually the first child), used as
 * the bone's primary axis in world space. Falls back to +Y when the two
 * points coincide (isolated bone), so downstream orientation math always has
 * a valid unit vector.
 */
export function boneDirection(head: Vector3, tail: Vector3): Vector3 {
  const d = tail.subtract(head);
  const len = d.length();
  if (len < 1e-8) return BONE_PRIMARY_AXIS.clone();
  return d.scaleInPlace(1 / len);
}

/**
 * Rest orientation for a bone: the rotation that carries the bone's primary
 * axis (+Y) onto `dir`, followed by `roll` radians of twist about `dir`.
 *
 * The +Y→dir alignment uses the shortest arc; when `dir` is (numerically)
 * opposite to +Y — where the shortest arc is ambiguous — we pin the flip to a
 * 180° turn about +Z so the result is deterministic (mirroring Blender's
 * stable handling in `vec_roll_to_mat3`). Roll is then always well-defined
 * relative to that canonical frame.
 */
export function boneRestQuaternion(dir: Vector3, roll: number): Quaternion {
  const d = dir.normalizeToNew();
  const dot = Vector3.Dot(BONE_PRIMARY_AXIS, d);

  let align: Quaternion;
  if (dot < -0.999999) {
    // dir ≈ −Y: any axis in the XZ plane works; pick +Z for determinism.
    align = Quaternion.RotationAxis(new Vector3(0, 0, 1), Math.PI);
  } else if (dot > 0.999999) {
    align = Quaternion.Identity();
  } else {
    const axis = Vector3.Cross(BONE_PRIMARY_AXIS, d);
    axis.normalize();
    align = Quaternion.RotationAxis(axis, Math.acos(Math.min(1, Math.max(-1, dot))));
  }

  if (roll === 0) return align;
  // Twist about the (world-space) bone axis after alignment. Rotating about
  // `dir` post-align equals rolling about the bone's own +Y.
  const twist = Quaternion.RotationAxis(d, roll);
  return twist.multiply(align); // align first, then twist
}

/**
 * Convert a world position into a parent-relative local translation:
 * `t = inv(parentRot) · (world − parentPos)`. With an identity parent
 * rotation this degrades to the plain subtraction the V1 translation-only
 * model used, so existing rigs keep byte-identical local matrices.
 */
export function worldToParentLocal(
  parentRot: Quaternion,
  parentPos: Vector3,
  world: Vector3
): Vector3 {
  const delta = world.subtract(parentPos);
  const inv = Quaternion.Inverse(parentRot);
  const out = new Vector3();
  delta.rotateByQuaternionToRef(inv, out);
  return out;
}

/**
 * Rebuild the local translations of an IK chain from solved world joint
 * positions, honoring each bone's (unchanged) local rotation.
 *
 * `positions` are the solved joint positions root-first. `baseAbsRot` is the
 * chain base's absolute rotation, and `localRots[i]` is bone i's local
 * rotation (index 0 is unused — the base bone is held fixed). The absolute
 * rotation is accumulated down the chain, so a rotated bone mid-chain
 * expresses its child's offset in the correctly twisted parent frame.
 *
 * @returns local translations for bones 1..n−1 (length `positions.length − 1`).
 */
export function chainLocalTranslations(
  positions: Vector3[],
  baseAbsRot: Quaternion,
  localRots: Quaternion[]
): Vector3[] {
  const out: Vector3[] = [];
  let parentRot = baseAbsRot.clone();
  for (let i = 1; i < positions.length; i++) {
    out.push(worldToParentLocal(parentRot, positions[i - 1]!, positions[i]!));
    // Bone i's absolute rotation feeds bone i+1's parent frame.
    parentRot = parentRot.multiply(localRots[i] ?? Quaternion.Identity());
  }
  return out;
}

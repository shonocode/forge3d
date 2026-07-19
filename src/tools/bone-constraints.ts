import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { boneDirection, boneRestQuaternion } from "./bone-orientation";

/**
 * Pure bone-constraint math — F-M6 constraint pass, batch 1:
 *
 * - **Limit Rotation** — clamp a bone's local euler rotation per axis
 *   (Blender's "Limit Rotation" constraint).
 * - **Aim** — point the bone's primary axis (+Y, twisted by roll) at a world
 *   target (Blender's "Damped Track" / "Track To" in its simplest form).
 *
 * Headless and deterministic — no scene / skeleton dependency — so every
 * formula is pinned by Vitest. The scene-touching enforcement pass lives in
 * `skeleton-tool.ts` (`applyAllBoneConstraints`), run per-frame like IK.
 *
 * Quaternion convention (same as bone-orientation.ts): Babylon's
 * `q1.multiply(q2)` applies **q2 first, then q1**, so
 * `worldRot = parentAbsRot.multiply(localRot)`.
 */

/**
 * Per-axis local-rotation clamp. Axes opt in individually (Blender-style):
 * an axis with its `limit` flag off passes through untouched. Angles are
 * degrees in the constraint (UI/serialization friendly) but the clamped
 * rotation itself is radians.
 */
export interface LimitRotationConstraint {
  enabled: boolean;
  limitX?: boolean;
  minXDeg?: number;
  maxXDeg?: number;
  limitY?: boolean;
  minYDeg?: number;
  maxYDeg?: number;
  limitZ?: boolean;
  minZDeg?: number;
  maxZDeg?: number;
}

/** Point the bone's +Y (roll-twisted) axis at a world-space target. */
export interface AimConstraint {
  enabled: boolean;
  targetX: number;
  targetY: number;
  targetZ: number;
}

const DEG = Math.PI / 180;
const EPS = 1e-9;

function clampAxis(
  value: number,
  limit: boolean | undefined,
  minDeg: number | undefined,
  maxDeg: number | undefined
): number {
  if (!limit) return value;
  const lo = (minDeg ?? 0) * DEG;
  const hi = (maxDeg ?? 0) * DEG;
  // A reversed range (min > max) clamps to the nearer bound rather than
  // silently swapping — matches how the UI validates, and keeps the
  // function total.
  if (lo > hi) return Math.abs(value - lo) <= Math.abs(value - hi) ? lo : hi;
  return Math.min(hi, Math.max(lo, value));
}

/**
 * Clamp a local euler rotation (radians) against a Limit Rotation
 * constraint. Returns the clamped rotation and whether anything moved —
 * callers skip the matrix rewrite entirely when `changed` is false, which
 * keeps the per-frame enforcement pass free for unconstrained rigs.
 */
export function clampEulerRotation(
  rotation: { x: number; y: number; z: number },
  c: LimitRotationConstraint
): { rotation: { x: number; y: number; z: number }; changed: boolean } {
  const out = {
    x: clampAxis(rotation.x, c.limitX, c.minXDeg, c.maxXDeg),
    y: clampAxis(rotation.y, c.limitY, c.minYDeg, c.maxYDeg),
    z: clampAxis(rotation.z, c.limitZ, c.minZDeg, c.maxZDeg),
  };
  const changed =
    Math.abs(out.x - rotation.x) > EPS ||
    Math.abs(out.y - rotation.y) > EPS ||
    Math.abs(out.z - rotation.z) > EPS;
  return { rotation: out, changed };
}

/**
 * Local rotation that aims the bone's primary axis (+Y, twisted by `roll`)
 * from `headWorld` toward `targetWorld`, given the parent's absolute
 * rotation:
 *
 *   worldRot = boneRestQuaternion(dir, roll)
 *   localRot = inv(parentAbsRot) · worldRot
 *
 * Only the bone's *rotation* is produced — translation/scale are the
 * caller's to preserve. Returns `null` when the target (numerically)
 * coincides with the head, where the aim direction is undefined; callers
 * should leave the bone's rotation untouched in that case.
 */
export function aimLocalRotation(
  parentAbsRot: Quaternion,
  headWorld: Vector3,
  targetWorld: Vector3,
  roll: number
): Quaternion | null {
  if (Vector3.DistanceSquared(headWorld, targetWorld) < 1e-16) return null;
  const dir = boneDirection(headWorld, targetWorld);
  const worldRot = boneRestQuaternion(dir, roll);
  return Quaternion.Inverse(parentAbsRot).multiply(worldRot);
}

import { Vector3 } from "@babylonjs/core/Maths/math.vector";

/**
 * Pure helpers for mirroring a bone chain. The scene-touching integration
 * (creating the mirrored bones, undo) lives in `skeleton-tool.mirrorBoneChain`;
 * this module is just the deterministic, unit-testable geometry + naming so
 * the side-swap rules are pinned by tests.
 */

export type MirrorAxis = "x" | "y" | "z";

/**
 * Reflect a world position across the plane through the origin perpendicular
 * to `axis` (the usual character-rig mirror: `x` flips left↔right).
 */
export function reflectPosition(p: Vector3, axis: MirrorAxis): Vector3 {
  return new Vector3(
    axis === "x" ? -p.x : p.x,
    axis === "y" ? -p.y : p.y,
    axis === "z" ? -p.z : p.z
  );
}

/** Euler rotation triple (radians) as stored in keyframes / decomposed poses. */
export interface EulerRotation { x: number; y: number; z: number }

/**
 * Mirror a local-pose rotation across the plane perpendicular to `axis`.
 *
 * Reflecting a rotation R by S gives S·R·S; for an axis-aligned reflection
 * conjugating each single-axis factor keeps the angle about the mirror
 * normal and negates the other two — and because conjugation distributes
 * over the product, the same rule holds for the composed XYZ euler triple:
 * X-mirror maps (x, y, z) → (x, −y, −z).
 *
 * Valid for poses expressed in mirror-symmetric parent frames (forge3d's
 * default: identity rest orientation on both sides), which is exactly the
 * paste-flipped use case.
 */
export function mirrorPoseRotation(rot: EulerRotation, axis: MirrorAxis): EulerRotation {
  if (axis === "x") return { x: rot.x, y: -rot.y, z: -rot.z };
  if (axis === "y") return { x: -rot.x, y: rot.y, z: -rot.z };
  return { x: -rot.x, y: -rot.y, z: rot.z };
}

/**
 * Mirror a parent-relative local translation across the plane perpendicular
 * to `axis` — the component along the mirror normal flips sign.
 */
export function mirrorLocalTranslation(pos: EulerRotation, axis: MirrorAxis): EulerRotation {
  return {
    x: axis === "x" ? -pos.x : pos.x,
    y: axis === "y" ? -pos.y : pos.y,
    z: axis === "z" ? -pos.z : pos.z,
  };
}

const WORD_FLIP: Record<string, string> = {
  Left: "Right",
  Right: "Left",
  left: "right",
  right: "left",
  LEFT: "RIGHT",
  RIGHT: "LEFT",
};

const LETTER_FLIP: Record<string, string> = { L: "R", R: "L", l: "r", r: "l" };

/**
 * Ordered side-token recognizers. The first whose pattern matches the name
 * wins and every occurrence it matches is flipped; later patterns are not
 * tried. Ordering matters so that, e.g., a separator-bounded `_L_` is handled
 * before the camelCase fallbacks.
 */
const SIDE_PATTERNS: Array<{ re: RegExp; flip: (m: string, ...g: string[]) => string }> = [
  // Words: Left / Right (matching case).
  {
    re: /Left|Right|left|right|LEFT|RIGHT/g,
    flip: (m) => WORD_FLIP[m] ?? m,
  },
  // Separator-bounded single letter: arm_L_upper, hand_R, foot.L, leg-r-lower.
  {
    re: /(^|[ ._-])([LRlr])(?=[ ._-]|$)/g,
    flip: (_m, sep, side) => sep + (LETTER_FLIP[side!] ?? side!),
  },
  // camelCase trailing: armL, handR, index2L (lowercase/digit, then L/R at a
  // word boundary — end of string or an uppercase letter).
  {
    re: /([a-z0-9])([LR])(?=[A-Z]|$)/g,
    flip: (_m, prev, side) => prev + (LETTER_FLIP[side!] ?? side!),
  },
  // camelCase leading: LArm, RHand (start or after an uppercase letter, then
  // L/R immediately before another uppercase letter).
  {
    re: /(^|[A-Z])([LR])(?=[A-Z])/g,
    flip: (_m, prev, side) => prev + (LETTER_FLIP[side!] ?? side!),
  },
];

/**
 * Produce the mirrored counterpart of a bone name by flipping its side token.
 *
 * Recognized side markers, in priority order:
 *  - the words `Left`/`Right` (matching case)
 *  - a single `L`/`R` (or lowercase) bounded by a separator (`_ . - space`)
 *    or a string end — e.g. `arm_L_upper` ↔ `arm_R_upper`, `hand_R` ↔ `hand_L`
 *  - a camelCase side letter — `armL` ↔ `armR`, `LArm` ↔ `RArm`
 *
 * A letter that is part of a longer word (`Lever`, `Ball`, `Bone_LR`) is left
 * alone. When no side token is present the name gets a `_mirror` suffix so the
 * new bone never collides with the original.
 */
export function mirrorBoneName(name: string): string {
  for (const { re, flip } of SIDE_PATTERNS) {
    // Fresh lastIndex each call since these are shared /g regexes.
    re.lastIndex = 0;
    if (re.test(name)) {
      re.lastIndex = 0;
      return name.replace(re, flip);
    }
  }
  return name + "_mirror";
}

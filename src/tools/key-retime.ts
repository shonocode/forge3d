/**
 * Pure keyframe-retiming math — F-M7 dopesheet / graph-editor key moves.
 *
 * Generic over the key shape (`{ frame: number }`), so the same function
 * retimes bone keyframes ({@link import("../state").KeyframeData}) and morph
 * keyframes ({@link import("../state").MorphKeyframe}).
 *
 * Semantics (Blender-style):
 * - The move is **rigid**: every selected key shifts by the same delta, so
 *   relative spacing within the selection is preserved. The delta is clamped
 *   so the whole selection stays inside `[0, maxFrames]`.
 * - An unselected key sitting on a destination frame is **overwritten**
 *   (dropped) — the moved key wins, matching how dropping a key on another
 *   behaves in every mainstream dopesheet.
 * - Result is sorted by frame (interpolators assume ascending order).
 *
 * Headless and deterministic — pinned by Vitest.
 */

export interface RetimeResult<T extends { frame: number }> {
  /** New key list, sorted by frame. Selected keys are the same object
   *  references with `frame` rewritten; callers relying on identity
   *  (e.g. a live drag preview) can keep pointing at them. */
  keys: T[];
  /** The delta actually applied after clamping to `[0, maxFrames]`. */
  appliedDelta: number;
  /** Unselected keys dropped because a moved key landed on their frame. */
  removed: T[];
}

/**
 * Shift the keys whose frames are in `selected` by `delta` frames (rounded
 * to integers). Returns the rebuilt list plus what actually happened —
 * callers use `appliedDelta` for status feedback and `removed` for undo
 * bookkeeping.
 */
export function retimeKeys<T extends { frame: number }>(
  keys: readonly T[],
  selected: ReadonlySet<number>,
  delta: number,
  maxFrames: number
): RetimeResult<T> {
  const sel = keys.filter((k) => selected.has(k.frame));
  let d = Math.round(delta);
  if (sel.length === 0 || d === 0) {
    return { keys: [...keys].sort((a, b) => a.frame - b.frame), appliedDelta: 0, removed: [] };
  }

  // Rigid clamp: the whole selection must stay inside [0, maxFrames].
  let minSel = Infinity;
  let maxSel = -Infinity;
  for (const k of sel) {
    if (k.frame < minSel) minSel = k.frame;
    if (k.frame > maxSel) maxSel = k.frame;
  }
  if (minSel + d < 0) d = -minSel;
  if (maxSel + d > maxFrames) d = maxFrames - maxSel;
  if (d === 0) {
    return { keys: [...keys].sort((a, b) => a.frame - b.frame), appliedDelta: 0, removed: [] };
  }

  const destinations = new Set<number>();
  for (const k of sel) destinations.add(k.frame + d);

  const removed: T[] = [];
  const kept: T[] = [];
  for (const k of keys) {
    if (selected.has(k.frame)) {
      kept.push(k);
    } else if (destinations.has(k.frame)) {
      removed.push(k); // overwritten by a moved key
    } else {
      kept.push(k);
    }
  }
  for (const k of sel) k.frame += d;

  kept.sort((a, b) => a.frame - b.frame);
  return { keys: kept, appliedDelta: d, removed };
}

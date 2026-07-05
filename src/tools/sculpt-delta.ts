/**
 * Sparse per-stroke undo deltas for sculpting.
 *
 * A brush stroke touches only the vertices inside the brush path, but the
 * previous undo model retained TWO full geometry snapshots per stroke
 * (before + after ≈ 12 MB at 100k verts) × up to 50 history entries — a
 * realistic out-of-memory vector on tablets. When a stroke does NOT change
 * topology (no dyntopo split), we retain only the changed vertices instead.
 * Full snapshots remain the fallback for topology-changing strokes.
 *
 * Pure and headless-testable: operates on plain arrays.
 */

export interface SparseDelta {
  /** Element indices (per-vertex slots) whose values changed. */
  indices: Uint32Array;
  /** Value before the stroke, `comps` numbers per changed slot. */
  before: Float32Array;
  /** Value after the stroke, `comps` numbers per changed slot. */
  after: Float32Array;
  /** Components per slot (3 for positions, 1 for mask). */
  comps: number;
}

/**
 * Diff two equal-length attribute arrays into a sparse delta.
 * Returns null when the lengths differ (topology changed — caller must fall
 * back to a full snapshot). Returns an empty delta (indices.length === 0)
 * when nothing changed.
 */
export function diffAttribute(
  before: ArrayLike<number>,
  after: ArrayLike<number>,
  comps: number,
): SparseDelta | null {
  if (before.length !== after.length) return null;
  const slots = before.length / comps;
  const changed: number[] = [];
  for (let s = 0; s < slots; s++) {
    for (let k = 0; k < comps; k++) {
      if (before[s * comps + k] !== after[s * comps + k]) {
        changed.push(s);
        break;
      }
    }
  }
  const idx = new Uint32Array(changed.length);
  const b = new Float32Array(changed.length * comps);
  const a = new Float32Array(changed.length * comps);
  for (let i = 0; i < changed.length; i++) {
    const s = changed[i]!;
    idx[i] = s;
    for (let k = 0; k < comps; k++) {
      b[i * comps + k] = before[s * comps + k]!;
      a[i * comps + k] = after[s * comps + k]!;
    }
  }
  return { indices: idx, before: b, after: a, comps };
}

/**
 * Write one side of a delta back into a full attribute array (in place).
 * `side: "before"` restores the pre-stroke values (undo), `"after"` re-applies
 * the stroke (redo). Out-of-range slots are ignored defensively.
 */
export function applyDelta(
  target: Float32Array,
  delta: SparseDelta,
  side: "before" | "after",
): void {
  const src = side === "before" ? delta.before : delta.after;
  const comps = delta.comps;
  const slots = target.length / comps;
  for (let i = 0; i < delta.indices.length; i++) {
    const s = delta.indices[i]!;
    if (s >= slots) continue;
    for (let k = 0; k < comps; k++) {
      target[s * comps + k] = src[i * comps + k]!;
    }
  }
}

/** Retained bytes of a delta (rough, for diagnostics/tests). */
export function deltaByteSize(delta: SparseDelta): number {
  return delta.indices.byteLength + delta.before.byteLength + delta.after.byteLength;
}

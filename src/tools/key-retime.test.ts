import { describe, it, expect } from "vitest";
import { retimeKeys } from "./key-retime";

interface K { frame: number; tag?: string }
const k = (frame: number, tag?: string): K => ({ frame, tag });
const frames = (r: { keys: K[] }): number[] => r.keys.map((x) => x.frame);

describe("retimeKeys", () => {
  it("shifts selected keys rigidly, leaving others in place", () => {
    const keys = [k(0), k(10, "a"), k(20, "b"), k(40)];
    const r = retimeKeys(keys, new Set([10, 20]), 5, 60);
    expect(r.appliedDelta).toBe(5);
    expect(frames(r)).toEqual([0, 15, 25, 40]);
    expect(r.removed).toEqual([]);
    // Selected keys keep identity (live drag previews point at them).
    expect(r.keys[1]!.tag).toBe("a");
    expect(r.keys[2]!.tag).toBe("b");
  });

  it("clamps the delta so the selection stays within [0, maxFrames]", () => {
    const keys = [k(5), k(10)];
    const low = retimeKeys(keys, new Set([5, 10]), -8, 60);
    expect(low.appliedDelta).toBe(-5);
    expect(frames(low)).toEqual([0, 5]);

    const keys2 = [k(50), k(55)];
    const high = retimeKeys(keys2, new Set([50, 55]), 20, 60);
    expect(high.appliedDelta).toBe(5);
    expect(frames(high)).toEqual([55, 60]);
  });

  it("overwrites an unselected key at the destination frame", () => {
    const keys = [k(0), k(10, "moving"), k(15, "victim"), k(30)];
    const r = retimeKeys(keys, new Set([10]), 5, 60);
    expect(frames(r)).toEqual([0, 15, 30]);
    expect(r.removed.map((x) => x.tag)).toEqual(["victim"]);
    expect(r.keys[1]!.tag).toBe("moving");
  });

  it("returns unchanged (sorted) for empty selection or zero delta", () => {
    const keys = [k(20), k(0)];
    const none = retimeKeys(keys, new Set(), 10, 60);
    expect(none.appliedDelta).toBe(0);
    expect(frames(none)).toEqual([0, 20]);

    const zero = retimeKeys(keys, new Set([20]), 0, 60);
    expect(zero.appliedDelta).toBe(0);
    expect(frames(zero)).toEqual([0, 20]);
  });

  it("preserves intra-selection spacing when clamped", () => {
    const keys = [k(2), k(4), k(9)];
    const r = retimeKeys(keys, new Set([2, 4]), -10, 60);
    expect(r.appliedDelta).toBe(-2);
    expect(frames(r)).toEqual([0, 2, 9]);
  });

  it("rounds fractional deltas to whole frames", () => {
    const keys = [k(10)];
    const r = retimeKeys(keys, new Set([10]), 2.6, 60);
    expect(r.appliedDelta).toBe(3);
    expect(frames(r)).toEqual([13]);
  });

  it("a selected key can pass over an unselected key without removing it", () => {
    // Moving 10 → 25 passes over 15 but only frame-25 collisions matter.
    const keys = [k(10, "moving"), k(15, "bystander")];
    const r = retimeKeys(keys, new Set([10]), 15, 60);
    expect(frames(r)).toEqual([15, 25]);
    expect(r.removed).toEqual([]);
    expect(r.keys[0]!.tag).toBe("bystander");
  });
});

import { describe, it, expect } from "vitest";
import { diffAttribute, applyDelta, deltaByteSize } from "./sculpt-delta";

describe("diffAttribute", () => {
  it("returns null when lengths differ (topology changed)", () => {
    expect(diffAttribute([0, 0, 0], [0, 0, 0, 1, 1, 1], 3)).toBeNull();
  });

  it("returns an empty delta when nothing changed", () => {
    const d = diffAttribute([1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6], 3)!;
    expect(d.indices.length).toBe(0);
  });

  it("captures only the changed slots", () => {
    const before = [0, 0, 0, 1, 1, 1, 2, 2, 2];
    const after = [0, 0, 0, 9, 9, 9, 2, 2, 2]; // only vertex 1 moved
    const d = diffAttribute(before, after, 3)!;
    expect(Array.from(d.indices)).toEqual([1]);
    expect(Array.from(d.before)).toEqual([1, 1, 1]);
    expect(Array.from(d.after)).toEqual([9, 9, 9]);
  });

  it("detects a change in any single component", () => {
    const d = diffAttribute([1, 2, 3], [1, 2.5, 3], 3)!;
    expect(Array.from(d.indices)).toEqual([0]);
  });

  it("works with 1-component arrays (mask)", () => {
    const d = diffAttribute([0, 0.5, 1], [0, 0.7, 1], 1)!;
    expect(Array.from(d.indices)).toEqual([1]);
    expect(d.before[0]!).toBeCloseTo(0.5, 6);
    expect(d.after[0]!).toBeCloseTo(0.7, 6);
  });
});

describe("applyDelta", () => {
  const before = [0, 0, 0, 1, 1, 1, 2, 2, 2];
  const after = [0, 0, 0, 9, 9, 9, 5, 5, 5];

  it("round-trips: apply(before) then apply(after) restores each state", () => {
    const d = diffAttribute(before, after, 3)!;
    const work = new Float32Array(after);
    applyDelta(work, d, "before");
    expect(Array.from(work)).toEqual(before);
    applyDelta(work, d, "after");
    expect(Array.from(work)).toEqual(after);
  });

  it("ignores out-of-range slots (defensive against mismatched buffers)", () => {
    const d = diffAttribute(before, after, 3)!;
    const short = new Float32Array(3); // only 1 vertex
    applyDelta(short, d, "after");
    expect(Array.from(short)).toEqual([0, 0, 0]); // slots 1,2 skipped
  });
});

describe("memory", () => {
  it("retains far less than a full snapshot for a localized stroke", () => {
    // 10k verts, only 100 moved.
    const n = 10000;
    const before = new Float32Array(n * 3);
    const after = new Float32Array(n * 3);
    for (let i = 0; i < 100; i++) after[i * 3] = 1;
    const d = diffAttribute(before, after, 3)!;
    expect(d.indices.length).toBe(100);
    const fullSnapshotBytes = before.byteLength * 2;
    expect(deltaByteSize(d)).toBeLessThan(fullSnapshotBytes / 20);
  });
});

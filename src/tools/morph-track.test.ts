import { describe, it, expect } from "vitest";
import { evalMorphTrack, upsertMorphKey, removeMorphKeyAt, findMorphTrack } from "./morph-track";
import type { MorphTrack } from "../state";

function track(keyframes: MorphTrack["keyframes"]): MorphTrack {
  return { meshUniqueId: 1, meshName: "face", targetIndex: 0, targetName: "smile", keyframes };
}

describe("evalMorphTrack", () => {
  it("returns null for an empty track", () => {
    expect(evalMorphTrack(track([]), 5)).toBeNull();
  });

  it("clamps before the first and after the last key", () => {
    const t = track([{ frame: 10, value: 0.2 }, { frame: 20, value: 0.8 }]);
    expect(evalMorphTrack(t, 0)).toBeCloseTo(0.2, 6);
    expect(evalMorphTrack(t, 100)).toBeCloseTo(0.8, 6);
  });

  it("interpolates linearly between keys by default", () => {
    const t = track([{ frame: 0, value: 0 }, { frame: 10, value: 1 }]);
    expect(evalMorphTrack(t, 5)).toBeCloseTo(0.5, 6);
    expect(evalMorphTrack(t, 2.5)).toBeCloseTo(0.25, 6);
  });

  it("applies the left key's easing", () => {
    const linear = track([{ frame: 0, value: 0 }, { frame: 10, value: 1 }]);
    const eased = track([{ frame: 0, value: 0, easing: "easeInQuad" }, { frame: 10, value: 1 }]);
    const lin = evalMorphTrack(linear, 5)!;
    const ein = evalMorphTrack(eased, 5)!;
    expect(ein).toBeLessThan(lin); // ease-in lags at midpoint
  });

  it("returns exact values on keyframes", () => {
    const t = track([{ frame: 0, value: 0.1 }, { frame: 10, value: 0.9 }]);
    expect(evalMorphTrack(t, 10)).toBeCloseTo(0.9, 6);
  });
});

describe("upsertMorphKey", () => {
  it("inserts sorted and replaces same-frame keys", () => {
    const t = track([]);
    upsertMorphKey(t, { frame: 10, value: 0.5 });
    upsertMorphKey(t, { frame: 0, value: 0.1 });
    upsertMorphKey(t, { frame: 10, value: 0.7 }); // replace
    expect(t.keyframes.map((k) => k.frame)).toEqual([0, 10]);
    expect(t.keyframes[1]!.value).toBeCloseTo(0.7, 6);
  });
});

describe("removeMorphKeyAt", () => {
  it("removes and returns the key at the exact frame; null otherwise", () => {
    const t = track([{ frame: 5, value: 0.3 }]);
    expect(removeMorphKeyAt(t, 4)).toBeNull();
    const removed = removeMorphKeyAt(t, 5);
    expect(removed?.value).toBeCloseTo(0.3, 6);
    expect(t.keyframes.length).toBe(0);
  });
});

describe("findMorphTrack", () => {
  it("matches on (meshUniqueId, targetIndex) and handles undefined", () => {
    const a = track([]);
    expect(findMorphTrack(undefined, 1, 0)).toBeNull();
    expect(findMorphTrack([a], 1, 0)).toBe(a);
    expect(findMorphTrack([a], 1, 1)).toBeNull();
    expect(findMorphTrack([a], 2, 0)).toBeNull();
  });
});

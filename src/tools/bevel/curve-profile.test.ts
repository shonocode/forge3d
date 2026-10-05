/**
 * The curve profile's samples (compat-backlog C35). The numbers are Blender's: `CurveProfile.segments` read back from Blender 5.1.1
 * (`tools/modeling/parity/probe-curve-profile.py`) — 390 sample sets, presets and random profiles, all equal to float32 rounding.
 */
import { describe, it, expect } from "vitest";
import { curveProfileSegments, curveProfilePresetPoints } from "./curve-profile";

const near = (a: number[][], b: number[][]): void => {
  expect(a.length).toBeGreaterThanOrEqual(b.length);
  b.forEach((p, i) => {
    expect(a[i]![0]).toBeCloseTo(p[0]!, 4);
    expect(a[i]![1]).toBeCloseTo(p[1]!, 4);
  });
};

describe("curveProfileSegments", () => {
  it("the line preset is evenly spaced chords of the diagonal", () => {
    near(curveProfileSegments({ preset: "LINE" }, 4), [[1.0, 0.0], [0.733947, 0.266053], [0.5, 0.5], [0.266053, 0.733947]]);
  });

  it("the cornice preset at 6 segments (fewer segments than edges: the curviest edges are sampled)", () => {
    near(curveProfileSegments({ preset: "CORNICE" }, 6), [[1.0, 0.125], [0.92, 0.16], [0.8, 0.25], [0.733, 0.433], [0.582, 0.522], [0.289, 0.727]]);
  });

  it("the crown preset at 5 segments", () => {
    near(curveProfileSegments({ preset: "CROWN" }, 5), [[0.75, 0.325], [0.925, 0.4], [0.975, 0.5], [0.85, 0.75], [0.75, 0.875]]);
  });

  it("the supports preset with even-length sampling", () => {
    near(curveProfileSegments({ preset: "SUPPORTS", sampleEvenLengths: true }, 4), [[1.0, 0.0], [0.981165, 0.529338], [0.706287, 0.945724], [0.471988, 1.011603]]);
  });

  it("the steps preset, with straight edges sampled", () => {
    near(curveProfileSegments({ preset: "STEPS", sampleStraightEdges: true }, 8), [[1.0, 0.0], [0.875, 0.125], [0.75, 0.25], [0.5, 0.5], [0.375, 0.5], [0.375, 0.625], [0.25, 0.625], [0.0, 0.875]]);
  });

  it("a profile of explicit points with mixed handle types", () => {
    near(curveProfileSegments({ points: [{ x: 1.0, y: 0.0, handle1: 'VECTOR', handle2: 'VECTOR' }, { x: 0.6623599529266357, y: 0.26968684792518616, handle1: 'VECTOR', handle2: 'VECTOR' }, { x: 0.5770056843757629, y: 0.3197903037071228, handle1: 'VECTOR', handle2: 'VECTOR' }, { x: 0.4348330795764923, y: 0.45786595344543457, handle1: 'VECTOR', handle2: 'VECTOR' }, { x: 0.3327324390411377, y: 0.6790949702262878, handle1: 'VECTOR', handle2: 'VECTOR' }, { x: 0.23536284267902374, y: 0.7649415135383606, handle1: 'AUTO', handle2: 'AUTO' }, { x: 0.0, y: 1.0, handle1: 'AUTO', handle2: 'AUTO' }] }, 6), [[1.0, 0.0], [0.66236, 0.269687], [0.577006, 0.31979], [0.434833, 0.457866], [0.332732, 0.679095], [0.235363, 0.764942]]);
  });

  it("the presets' points are the ones Blender builds", () => {
    expect(curveProfilePresetPoints("CORNICE").length).toBe(13);
    expect(curveProfilePresetPoints("CROWN").length).toBe(11);
    expect(curveProfilePresetPoints("SUPPORTS").length).toBe(5);
    expect(curveProfilePresetPoints("STEPS").length).toBe(17);
  });
});

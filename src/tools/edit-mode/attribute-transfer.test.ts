import { describe, it, expect } from "vitest";
import {
  closestPointOnTriangleBary,
  transferAttribute,
  transferSkinWeights,
} from "./attribute-transfer";

// Unit right triangle in z=0: A(0,0,0) B(1,0,0) C(0,1,0)
const TRI = [0, 0, 0, 1, 0, 0, 0, 1, 0] as const;
const bary = (px: number, py: number, pz: number) =>
  closestPointOnTriangleBary(px, py, pz, ...TRI);

describe("closestPointOnTriangleBary", () => {
  it("returns exact corner weights at vertices", () => {
    expect(bary(0, 0, 0)).toMatchObject({ u: 1, v: 0, w: 0, dist2: 0 });
    expect(bary(1, 0, 0)).toMatchObject({ u: 0, v: 1, w: 0, dist2: 0 });
    expect(bary(0, 1, 0)).toMatchObject({ u: 0, v: 0, w: 1, dist2: 0 });
  });

  it("returns midpoint weights on an edge", () => {
    const r = bary(0.5, 0, 0); // midpoint of AB
    expect(r.u).toBeCloseTo(0.5, 6);
    expect(r.v).toBeCloseTo(0.5, 6);
    expect(r.w).toBeCloseTo(0, 6);
    expect(r.dist2).toBeCloseTo(0, 10);
  });

  it("projects an off-surface point onto the face with correct distance", () => {
    const r = bary(0.25, 0.25, 2); // above interior
    expect(r.u + r.v + r.w).toBeCloseTo(1, 6);
    expect(r.dist2).toBeCloseTo(4, 6); // z-offset only
    expect(r.u).toBeCloseTo(0.5, 6);
    expect(r.v).toBeCloseTo(0.25, 6);
    expect(r.w).toBeCloseTo(0.25, 6);
  });

  it("clamps points outside the triangle to the nearest edge/corner", () => {
    const r = bary(2, -1, 0); // beyond B, below AB
    expect(r.u).toBeCloseTo(0, 6);
    expect(r.v).toBeCloseTo(1, 6); // corner B
    expect(r.w).toBeCloseTo(0, 6);
  });
});

describe("transferAttribute", () => {
  // Old mesh: single triangle with UVs matching XY.
  const oldPos = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  const oldIdx = [0, 1, 2];
  const oldUV = [0, 0, 1, 0, 0, 1];

  it("copies original vertices verbatim", () => {
    const newPos = [...oldPos, 0.5, 0, 0]; // one new vert on edge AB
    const out = transferAttribute(oldPos, oldIdx, oldUV, newPos, 2);
    expect(Array.from(out.slice(0, 6))).toEqual(oldUV);
  });

  it("interpolates the attribute for a new vertex on an edge", () => {
    const newPos = [...oldPos, 0.5, 0, 0];
    const out = transferAttribute(oldPos, oldIdx, oldUV, newPos, 2);
    expect(out[6]!).toBeCloseTo(0.5, 6); // u midway between A(0) and B(1)
    expect(out[7]!).toBeCloseTo(0, 6);
  });

  it("gives an exact copy for a new vertex coincident with an old one (extrude cap)", () => {
    const newPos = [...oldPos, 1, 0, 0]; // duplicate of B
    const out = transferAttribute(oldPos, oldIdx, oldUV, newPos, 2);
    expect(out[6]!).toBeCloseTo(1, 6);
    expect(out[7]!).toBeCloseTo(0, 6);
  });

  it("interpolates across the face interior", () => {
    const newPos = [...oldPos, 0.25, 0.25, 0];
    const out = transferAttribute(oldPos, oldIdx, oldUV, newPos, 2);
    expect(out[6]!).toBeCloseTo(0.25, 6);
    expect(out[7]!).toBeCloseTo(0.25, 6);
  });
});

describe("transferSkinWeights", () => {
  const oldPos = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  const oldIdx = [0, 1, 2];
  // Vertex 0 → bone 0 fully; vertex 1 → bone 1 fully; vertex 2 → bones 2+3 evenly.
  const oldMI = [0, 0, 0, 0, 1, 0, 0, 0, 2, 3, 0, 0];
  const oldMW = [1, 0, 0, 0, 1, 0, 0, 0, 0.5, 0.5, 0, 0];

  it("copies original vertices verbatim", () => {
    const newPos = [...oldPos, 0.5, 0, 0];
    const r = transferSkinWeights(oldPos, oldIdx, oldMI, oldMW, newPos);
    expect(Array.from(r.matricesWeights.slice(0, 12))).toEqual(oldMW);
    expect(Array.from(r.matricesIndices.slice(0, 12))).toEqual(oldMI);
  });

  it("blends two corners 50/50 for an edge midpoint and normalizes", () => {
    const newPos = [...oldPos, 0.5, 0, 0]; // midpoint AB
    const r = transferSkinWeights(oldPos, oldIdx, oldMI, oldMW, newPos);
    const mi = Array.from(r.matricesIndices.slice(12, 16));
    const mw = Array.from(r.matricesWeights.slice(12, 16));
    const byBone = new Map<number, number>();
    mi.forEach((b, k) => { if (mw[k]! > 0) byBone.set(b, (byBone.get(b) ?? 0) + mw[k]!); });
    expect(byBone.get(0)!).toBeCloseTo(0.5, 6);
    expect(byBone.get(1)!).toBeCloseTo(0.5, 6);
    expect(mw.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });

  it("keeps the strongest 4 influences when corners contribute more than 4 bones", () => {
    // Centroid touches all three corners → bones {0, 1, 2, 3} (exactly 4 here,
    // with bone 0/1 at 1/3 and bones 2/3 at 1/6 each).
    const newPos = [...oldPos, 1 / 3, 1 / 3, 0];
    const r = transferSkinWeights(oldPos, oldIdx, oldMI, oldMW, newPos);
    const mw = Array.from(r.matricesWeights.slice(12, 16));
    expect(mw.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(mw.filter((w) => w > 0).length).toBe(4);
  });

  it("gives full single-bone weight for a vertex coincident with a corner", () => {
    const newPos = [...oldPos, 0, 1, 0]; // duplicate of C
    const r = transferSkinWeights(oldPos, oldIdx, oldMI, oldMW, newPos);
    const mi = Array.from(r.matricesIndices.slice(12, 16));
    const mw = Array.from(r.matricesWeights.slice(12, 16));
    const byBone = new Map<number, number>();
    mi.forEach((b, k) => { if (mw[k]! > 0) byBone.set(b, (byBone.get(b) ?? 0) + mw[k]!); });
    expect(byBone.get(2)!).toBeCloseTo(0.5, 6);
    expect(byBone.get(3)!).toBeCloseTo(0.5, 6);
  });
});

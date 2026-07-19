import { describe, it, expect } from "vitest";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import {
  boneDirection,
  boneRestQuaternion,
  worldToParentLocal,
  chainLocalTranslations,
} from "./bone-orientation";

function rotate(v: Vector3, q: Quaternion): Vector3 {
  const out = new Vector3();
  v.rotateByQuaternionToRef(q, out);
  return out;
}

function expectVec(actual: Vector3, x: number, y: number, z: number, eps = 1e-6): void {
  expect(actual.x).toBeCloseTo(x, 5);
  expect(actual.y).toBeCloseTo(y, 5);
  expect(actual.z).toBeCloseTo(z, 5);
  void eps;
}

describe("boneDirection", () => {
  it("returns the normalized head→tail direction", () => {
    const d = boneDirection(new Vector3(1, 1, 1), new Vector3(1, 1, 3));
    expectVec(d, 0, 0, 1);
  });

  it("falls back to +Y for coincident points", () => {
    const d = boneDirection(new Vector3(2, 2, 2), new Vector3(2, 2, 2));
    expectVec(d, 0, 1, 0);
  });
});

describe("boneRestQuaternion", () => {
  it("is identity for dir=+Y, roll=0", () => {
    const q = boneRestQuaternion(new Vector3(0, 1, 0), 0);
    expectVec(rotate(new Vector3(1, 0, 0), q), 1, 0, 0);
    expectVec(rotate(new Vector3(0, 1, 0), q), 0, 1, 0);
  });

  it("carries +Y onto an arbitrary direction", () => {
    const dir = new Vector3(1, 2, -0.5).normalize();
    const q = boneRestQuaternion(dir, 0);
    expectVec(rotate(new Vector3(0, 1, 0), q), dir.x, dir.y, dir.z);
  });

  it("handles dir≈−Y deterministically (180° about +Z)", () => {
    const q = boneRestQuaternion(new Vector3(0, -1, 0), 0);
    expectVec(rotate(new Vector3(0, 1, 0), q), 0, -1, 0);
    // 180° about +Z sends +X to −X (not +X, which a Z-less flip could give).
    expectVec(rotate(new Vector3(1, 0, 0), q), -1, 0, 0);
  });

  it("roll twists about the bone axis without moving it", () => {
    const dir = new Vector3(0, 0, 1);
    const q = boneRestQuaternion(dir, Math.PI / 2);
    // Bone axis unchanged by roll.
    expectVec(rotate(new Vector3(0, 1, 0), q), 0, 0, 1);
    // Secondary axis rotated 90° about the bone axis. With roll=0 the
    // alignment (+Y→+Z, axis +X) sends +X→+X; rolling 90° about +Z (LH)
    // then carries +X to a quarter-turn around the axis.
    const x0 = rotate(new Vector3(1, 0, 0), boneRestQuaternion(dir, 0));
    const x90 = rotate(new Vector3(1, 0, 0), q);
    // Perpendicularity relations pin the quarter turn without hardcoding
    // handedness: x90 ⟂ x0 and both ⟂ dir.
    expect(Vector3.Dot(x0, x90)).toBeCloseTo(0, 5);
    expect(Vector3.Dot(x90, dir)).toBeCloseTo(0, 5);
    expect(x90.length()).toBeCloseTo(1, 5);
  });

  it("full-turn roll returns to the roll-less orientation", () => {
    const dir = new Vector3(1, 1, 0).normalize();
    const a = boneRestQuaternion(dir, 0);
    const b = boneRestQuaternion(dir, Math.PI * 2);
    expectVec(rotate(new Vector3(1, 0, 0), b), ...([
      rotate(new Vector3(1, 0, 0), a).x,
      rotate(new Vector3(1, 0, 0), a).y,
      rotate(new Vector3(1, 0, 0), a).z,
    ] as [number, number, number]));
  });
});

describe("worldToParentLocal", () => {
  it("degrades to plain subtraction with identity parent rotation", () => {
    const t = worldToParentLocal(
      Quaternion.Identity(),
      new Vector3(1, 2, 3),
      new Vector3(2, 4, 6)
    );
    expectVec(t, 1, 2, 3);
  });

  it("expresses the offset in the rotated parent frame", () => {
    // Parent rotated 90° about Z: parent's local +X maps to world +Y-ish
    // (LH). A child sitting at world +Y from the parent must therefore have
    // its local translation on the axis that maps onto +Y.
    const parentRot = Quaternion.RotationAxis(new Vector3(0, 0, 1), Math.PI / 2);
    const t = worldToParentLocal(parentRot, Vector3.Zero(), new Vector3(0, 1, 0));
    // Round-trip: rotating the local offset by the parent rotation must
    // reproduce the world offset.
    expectVec(rotate(t, parentRot), 0, 1, 0);
    expect(t.length()).toBeCloseTo(1, 5);
    // And it must NOT be the naive subtraction (0,1,0).
    expect(Math.abs(t.y - 1)).toBeGreaterThan(0.5);
  });
});

describe("chainLocalTranslations", () => {
  it("returns plain deltas for an unrotated chain", () => {
    const positions = [new Vector3(0, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 2, 1)];
    const rots = [Quaternion.Identity(), Quaternion.Identity(), Quaternion.Identity()];
    const t = chainLocalTranslations(positions, Quaternion.Identity(), rots);
    expect(t).toHaveLength(2);
    expectVec(t[0]!, 0, 1, 0);
    expectVec(t[1]!, 0, 1, 1);
  });

  it("accumulates rotations down the chain", () => {
    const qz = Quaternion.RotationAxis(new Vector3(0, 0, 1), Math.PI / 2);
    const positions = [new Vector3(0, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 2, 0)];
    // Base bone absolute rotation = 90° about Z, middle bone local rotation
    // also 90° about Z → the tip's parent frame is rotated 180° total.
    const rots = [Quaternion.Identity(), qz, Quaternion.Identity()];
    const t = chainLocalTranslations(positions, qz, rots);
    expect(t).toHaveLength(2);
    // Verify by reconstruction: world_i = world_{i-1} + parentAbsRot · t_i
    let abs = qz.clone();
    const rebuilt0 = positions[0]!.add(rotate(t[0]!, abs));
    expectVec(rebuilt0, 0, 1, 0);
    abs = abs.multiply(rots[1]!);
    const rebuilt1 = rebuilt0.add(rotate(t[1]!, abs));
    expectVec(rebuilt1, 0, 2, 0);
  });
});

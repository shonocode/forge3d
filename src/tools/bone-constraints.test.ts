import { describe, it, expect } from "vitest";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import {
  clampEulerRotation,
  aimLocalRotation,
  type LimitRotationConstraint,
} from "./bone-constraints";

const DEG = Math.PI / 180;

function limitAll(minDeg: number, maxDeg: number): LimitRotationConstraint {
  return {
    enabled: true,
    limitX: true, minXDeg: minDeg, maxXDeg: maxDeg,
    limitY: true, minYDeg: minDeg, maxYDeg: maxDeg,
    limitZ: true, minZDeg: minDeg, maxZDeg: maxDeg,
  };
}

describe("clampEulerRotation", () => {
  it("returns unchanged when all axes are within limits", () => {
    const r = { x: 10 * DEG, y: -20 * DEG, z: 0 };
    const { rotation, changed } = clampEulerRotation(r, limitAll(-45, 45));
    expect(changed).toBe(false);
    expect(rotation.x).toBeCloseTo(r.x, 10);
    expect(rotation.y).toBeCloseTo(r.y, 10);
    expect(rotation.z).toBeCloseTo(r.z, 10);
  });

  it("clamps above max and below min", () => {
    const { rotation, changed } = clampEulerRotation(
      { x: 90 * DEG, y: -90 * DEG, z: 0 },
      limitAll(-30, 30)
    );
    expect(changed).toBe(true);
    expect(rotation.x).toBeCloseTo(30 * DEG, 10);
    expect(rotation.y).toBeCloseTo(-30 * DEG, 10);
    expect(rotation.z).toBeCloseTo(0, 10);
  });

  it("leaves axes with their limit flag off untouched", () => {
    const c: LimitRotationConstraint = {
      enabled: true,
      limitX: true, minXDeg: -10, maxXDeg: 10,
      // Y/Z unlimited
    };
    const { rotation, changed } = clampEulerRotation(
      { x: 45 * DEG, y: 170 * DEG, z: -170 * DEG },
      c
    );
    expect(changed).toBe(true);
    expect(rotation.x).toBeCloseTo(10 * DEG, 10);
    expect(rotation.y).toBeCloseTo(170 * DEG, 10);
    expect(rotation.z).toBeCloseTo(-170 * DEG, 10);
  });

  it("treats missing min/max as 0 (Blender default)", () => {
    const c: LimitRotationConstraint = { enabled: true, limitZ: true };
    const { rotation, changed } = clampEulerRotation({ x: 0, y: 0, z: 1 }, c);
    expect(changed).toBe(true);
    expect(rotation.z).toBeCloseTo(0, 10);
  });

  it("clamps to the nearer bound when the range is reversed (min > max)", () => {
    const c: LimitRotationConstraint = {
      enabled: true,
      limitX: true, minXDeg: 40, maxXDeg: -40,
    };
    const hi = clampEulerRotation({ x: 35 * DEG, y: 0, z: 0 }, c);
    expect(hi.rotation.x).toBeCloseTo(40 * DEG, 10);
    const lo = clampEulerRotation({ x: -35 * DEG, y: 0, z: 0 }, c);
    expect(lo.rotation.x).toBeCloseTo(-40 * DEG, 10);
  });
});

describe("aimLocalRotation", () => {
  const rotate = (q: Quaternion, v: Vector3): Vector3 => {
    const out = new Vector3();
    v.rotateByQuaternionToRef(q, out);
    return out;
  };

  it("is identity when the target already lies along +Y of an unrotated parent", () => {
    const q = aimLocalRotation(
      Quaternion.Identity(),
      new Vector3(0, 0, 0),
      new Vector3(0, 2, 0),
      0
    );
    expect(q).not.toBeNull();
    const y = rotate(q!, new Vector3(0, 1, 0));
    expect(y.x).toBeCloseTo(0, 6);
    expect(y.y).toBeCloseTo(1, 6);
    expect(y.z).toBeCloseTo(0, 6);
  });

  it("carries +Y onto the world aim direction (identity parent)", () => {
    const q = aimLocalRotation(
      Quaternion.Identity(),
      new Vector3(1, 1, 1),
      new Vector3(4, 1, 1), // aim = +X
      0
    );
    const y = rotate(q!, new Vector3(0, 1, 0));
    expect(y.x).toBeCloseTo(1, 6);
    expect(y.y).toBeCloseTo(0, 6);
    expect(y.z).toBeCloseTo(0, 6);
  });

  it("compensates a rotated parent so world aim still hits the target", () => {
    // Parent rotated 90° about Z: parent's frame is twisted, the local
    // rotation must undo that so parentAbs · local still points +Y at dir.
    const parent = Quaternion.RotationAxis(new Vector3(0, 0, 1), Math.PI / 2);
    const q = aimLocalRotation(
      parent,
      new Vector3(0, 0, 0),
      new Vector3(0, 0, 3), // aim = +Z
      0
    );
    const world = parent.multiply(q!); // local first, then parent
    const y = rotate(world, new Vector3(0, 1, 0));
    expect(y.x).toBeCloseTo(0, 6);
    expect(y.y).toBeCloseTo(0, 6);
    expect(y.z).toBeCloseTo(1, 6);
  });

  it("roll twists about the aim axis without changing the aim direction", () => {
    const dir = new Vector3(1, 0, 0);
    const q0 = aimLocalRotation(Quaternion.Identity(), Vector3.Zero(), dir, 0)!;
    const q1 = aimLocalRotation(Quaternion.Identity(), Vector3.Zero(), dir, Math.PI / 2)!;
    // Aim axis identical…
    const y0 = rotate(q0, new Vector3(0, 1, 0));
    const y1 = rotate(q1, new Vector3(0, 1, 0));
    expect(y1.x).toBeCloseTo(y0.x, 6);
    expect(y1.y).toBeCloseTo(y0.y, 6);
    expect(y1.z).toBeCloseTo(y0.z, 6);
    // …but a perpendicular axis has twisted 90° about it.
    const x0 = rotate(q0, new Vector3(1, 0, 0));
    const x1 = rotate(q1, new Vector3(1, 0, 0));
    const angle = Math.acos(Math.min(1, Math.max(-1, Vector3.Dot(x0, x1))));
    expect(angle).toBeCloseTo(Math.PI / 2, 6);
  });

  it("returns null when target coincides with the head", () => {
    const q = aimLocalRotation(
      Quaternion.Identity(),
      new Vector3(1, 2, 3),
      new Vector3(1, 2, 3),
      0
    );
    expect(q).toBeNull();
  });
});

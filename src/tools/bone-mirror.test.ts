import { describe, it, expect } from "vitest";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { mirrorBoneName, reflectPosition, mirrorPoseRotation, mirrorLocalTranslation } from "./bone-mirror";

describe("reflectPosition", () => {
  it("flips X for an x-axis mirror, leaving Y/Z", () => {
    const r = reflectPosition(new Vector3(2, 3, 4), "x");
    expect(r.x).toBe(-2);
    expect(r.y).toBe(3);
    expect(r.z).toBe(4);
  });

  it("flips Y for a y-axis mirror", () => {
    const r = reflectPosition(new Vector3(2, 3, 4), "y");
    expect(r.equalsWithEpsilon(new Vector3(2, -3, 4))).toBe(true);
  });

  it("does not mutate the input", () => {
    const p = new Vector3(1, 1, 1);
    reflectPosition(p, "z");
    expect(p.equalsWithEpsilon(new Vector3(1, 1, 1))).toBe(true);
  });
});

describe("mirrorBoneName", () => {
  it("swaps an underscore-delimited L/R in the middle", () => {
    expect(mirrorBoneName("arm_L_upper")).toBe("arm_R_upper");
    expect(mirrorBoneName("arm_R_upper")).toBe("arm_L_upper");
  });

  it("swaps a trailing side suffix", () => {
    expect(mirrorBoneName("hand_R")).toBe("hand_L");
    expect(mirrorBoneName("hand_L")).toBe("hand_R");
  });

  it("swaps a leading side token", () => {
    expect(mirrorBoneName("L_clavicle")).toBe("R_clavicle");
  });

  it("handles dot and dash separators", () => {
    expect(mirrorBoneName("foot.L")).toBe("foot.R");
    expect(mirrorBoneName("leg-r-lower")).toBe("leg-l-lower");
  });

  it("swaps the words Left/Right preserving case", () => {
    expect(mirrorBoneName("LeftArm")).toBe("RightArm");
    expect(mirrorBoneName("upper right leg")).toBe("upper left leg");
  });

  it("appends _mirror when there is no side token", () => {
    expect(mirrorBoneName("spine")).toBe("spine_mirror");
    expect(mirrorBoneName("Bone_1")).toBe("Bone_1_mirror");
  });

  it("swaps a camelCase trailing side letter", () => {
    expect(mirrorBoneName("armL")).toBe("armR");
    expect(mirrorBoneName("handR")).toBe("handL");
    expect(mirrorBoneName("armLUpper")).toBe("armRUpper");
  });

  it("swaps a camelCase leading side letter", () => {
    expect(mirrorBoneName("LArm")).toBe("RArm");
    expect(mirrorBoneName("RHand")).toBe("LHand");
  });

  it("does not treat an L inside a word as a side token", () => {
    // No bounded/camel side letter in any of these.
    expect(mirrorBoneName("pelvis")).toBe("pelvis_mirror");
    expect(mirrorBoneName("Bone_LR")).toBe("Bone_LR_mirror");
    expect(mirrorBoneName("Lever")).toBe("Lever_mirror");
    expect(mirrorBoneName("Ball")).toBe("Ball_mirror");
  });

  it("is an involution for side-tokened names (mirror twice = original)", () => {
    for (const n of ["arm_L_upper", "hand_R", "foot.L", "LeftArm", "armL", "LArm", "armRUpper"]) {
      expect(mirrorBoneName(mirrorBoneName(n))).toBe(n);
    }
  });
});

describe("mirrorPoseRotation", () => {
  it("x-mirror keeps rx, negates ry/rz", () => {
    const m = mirrorPoseRotation({ x: 0.3, y: 0.5, z: -0.7 }, "x");
    expect(m).toEqual({ x: 0.3, y: -0.5, z: 0.7 });
  });

  it("y-mirror keeps ry, negates rx/rz", () => {
    const m = mirrorPoseRotation({ x: 0.3, y: 0.5, z: -0.7 }, "y");
    expect(m).toEqual({ x: -0.3, y: 0.5, z: 0.7 });
  });

  it("z-mirror keeps rz, negates rx/ry", () => {
    const m = mirrorPoseRotation({ x: 0.3, y: 0.5, z: -0.7 }, "z");
    expect(m).toEqual({ x: -0.3, y: -0.5, z: -0.7 });
  });

  it("is an involution (mirror twice = original)", () => {
    const rot = { x: 0.1, y: -0.2, z: 0.3 };
    expect(mirrorPoseRotation(mirrorPoseRotation(rot, "x"), "x")).toEqual(rot);
  });
});

describe("mirrorLocalTranslation", () => {
  it("negates only the mirror-normal component", () => {
    expect(mirrorLocalTranslation({ x: 1, y: 2, z: 3 }, "x")).toEqual({ x: -1, y: 2, z: 3 });
    expect(mirrorLocalTranslation({ x: 1, y: 2, z: 3 }, "y")).toEqual({ x: 1, y: -2, z: 3 });
    expect(mirrorLocalTranslation({ x: 1, y: 2, z: 3 }, "z")).toEqual({ x: 1, y: 2, z: -3 });
  });
});

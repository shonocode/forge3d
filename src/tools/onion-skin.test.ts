import { describe, it, expect } from "vitest";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { computeGhostJoints, computeGhostSegments, type GhostBone } from "./onion-skin";

const T = (x: number, y: number, z: number): Matrix => Matrix.Translation(x, y, z);

describe("computeGhostJoints", () => {
  it("uses fallback local matrices when no pose is evaluated", () => {
    const bones: GhostBone[] = [
      { id: "root", parentId: null, fallbackLocal: T(0, 1, 0) },
      { id: "child", parentId: "root", fallbackLocal: T(0, 2, 0) },
    ];
    const joints = computeGhostJoints(bones, () => null);
    expect(joints.get("root")!.y).toBeCloseTo(1, 6);
    expect(joints.get("child")!.y).toBeCloseTo(3, 6); // 1 + 2, composed
  });

  it("applies evaluated poses (translation + rotation) down the chain", () => {
    const bones: GhostBone[] = [
      { id: "root", parentId: null, fallbackLocal: T(0, 0, 0) },
      { id: "child", parentId: "root", fallbackLocal: T(0, 1, 0) },
    ];
    // Root rotated 90° about Z: child's +Y offset becomes −X in world.
    const joints = computeGhostJoints(bones, (id) =>
      id === "root"
        ? { rotation: { x: 0, y: 0, z: Math.PI / 2 }, position: { x: 0, y: 0, z: 0 } }
        : null
    );
    const child = joints.get("child")!;
    expect(child.x).toBeCloseTo(-1, 5);
    expect(child.y).toBeCloseTo(0, 5);
  });

  it("handles out-of-order bone arrays (child listed before parent)", () => {
    const bones: GhostBone[] = [
      { id: "child", parentId: "root", fallbackLocal: T(1, 0, 0) },
      { id: "root", parentId: null, fallbackLocal: T(0, 5, 0) },
    ];
    const joints = computeGhostJoints(bones, () => null);
    expect(joints.get("child")!.x).toBeCloseTo(1, 6);
    expect(joints.get("child")!.y).toBeCloseTo(5, 6);
  });
});

describe("computeGhostSegments", () => {
  it("builds one parent→child segment per parented bone", () => {
    const bones: GhostBone[] = [
      { id: "a", parentId: null, fallbackLocal: T(0, 0, 0) },
      { id: "b", parentId: "a", fallbackLocal: T(0, 1, 0) },
      { id: "c", parentId: "b", fallbackLocal: T(0, 1, 0) },
    ];
    const segs = computeGhostSegments(bones, () => null);
    expect(segs).toHaveLength(2);
    expect(segs[0]![0]).toEqual(new Vector3(0, 0, 0));
    expect(segs[0]![1]!.y).toBeCloseTo(1, 6);
    expect(segs[1]![1]!.y).toBeCloseTo(2, 6);
  });

  it("returns no segments for a root-only skeleton", () => {
    const bones: GhostBone[] = [{ id: "a", parentId: null, fallbackLocal: T(0, 0, 0) }];
    expect(computeGhostSegments(bones, () => null)).toEqual([]);
  });
});

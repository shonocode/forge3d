import { describe, it, expect } from "vitest";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { solveFabrik } from "./ik-solver";

/** Total length of a polyline through the given points. */
function chainLength(points: Vector3[]): number {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += Vector3.Distance(points[i]!, points[i + 1]!);
  }
  return total;
}

/** Per-segment lengths of a polyline. */
function segmentLengths(points: Vector3[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    out.push(Vector3.Distance(points[i]!, points[i + 1]!));
  }
  return out;
}

describe("solveFabrik", () => {
  it("reaches a target within the chain's reach", () => {
    const joints = [
      new Vector3(0, 0, 0),
      new Vector3(1, 0, 0),
      new Vector3(2, 0, 0),
    ];
    const target = new Vector3(1, 1, 0);
    const result = solveFabrik(joints, target);

    expect(result.reached).toBe(true);
    const end = result.positions[result.positions.length - 1]!;
    expect(Vector3.Distance(end, target)).toBeLessThan(1e-3);
  });

  it("preserves every segment length while solving", () => {
    const joints = [
      new Vector3(0, 0, 0),
      new Vector3(1, 0, 0),
      new Vector3(2, 0, 0),
      new Vector3(3, 0, 0),
    ];
    const before = segmentLengths(joints);
    const result = solveFabrik(joints, new Vector3(1.5, 1.5, 0.5));
    const after = segmentLengths(result.positions);

    expect(after).toHaveLength(before.length);
    for (let i = 0; i < before.length; i++) {
      expect(after[i]!).toBeCloseTo(before[i]!, 4);
    }
  });

  it("keeps the root anchored when fixedRoot is set", () => {
    const joints = [
      new Vector3(0, 0, 0),
      new Vector3(1, 0, 0),
      new Vector3(2, 0, 0),
    ];
    const result = solveFabrik(joints, new Vector3(0, 2, 0), { fixedRoot: true });
    const root = result.positions[0]!;
    expect(Vector3.Distance(root, new Vector3(0, 0, 0))).toBeLessThan(1e-6);
  });

  it("stretches straight toward an unreachable target and reports reached=false", () => {
    const joints = [
      new Vector3(0, 0, 0),
      new Vector3(1, 0, 0),
      new Vector3(2, 0, 0),
    ];
    const reach = chainLength(joints); // 2.0
    const target = new Vector3(10, 0, 0); // far beyond reach
    const result = solveFabrik(joints, target);

    expect(result.reached).toBe(false);
    // End effector lands at full reach along the root→target direction.
    const end = result.positions[result.positions.length - 1]!;
    expect(Vector3.Distance(end, new Vector3(0, 0, 0))).toBeCloseTo(reach, 4);
    expect(end.y).toBeCloseTo(0, 6);
    expect(end.z).toBeCloseTo(0, 6);
  });

  it("does not mutate the input joint vectors", () => {
    const joints = [
      new Vector3(0, 0, 0),
      new Vector3(1, 0, 0),
      new Vector3(2, 0, 0),
    ];
    const snapshot = joints.map((j) => j.clone());
    solveFabrik(joints, new Vector3(1, 1, 1));
    for (let i = 0; i < joints.length; i++) {
      expect(joints[i]!.equalsWithEpsilon(snapshot[i]!, 1e-9)).toBe(true);
    }
  });

  it("is a no-op for a degenerate chain of fewer than two joints", () => {
    const single = [new Vector3(1, 2, 3)];
    const result = solveFabrik(single, new Vector3(5, 5, 5));
    expect(result.reached).toBe(false);
    expect(result.iterations).toBe(0);
    expect(result.positions).toHaveLength(1);
    expect(result.positions[0]!.equalsWithEpsilon(new Vector3(1, 2, 3))).toBe(true);
  });

  it("steers the bend toward a pole target without breaking reach or lengths", () => {
    // A 3-joint chain lying along X. Bend it to a target above, with a pole
    // that pulls the middle joint toward +Z.
    const joints = [
      new Vector3(0, 0, 0),
      new Vector3(1, 0, 0),
      new Vector3(2, 0, 0),
    ];
    const before = segmentLengths(joints);
    const target = new Vector3(1, 1, 0);
    const pole = new Vector3(1, 0, 5); // strongly +Z

    const result = solveFabrik(joints, target, { pole });

    // Middle joint should now sit on the +Z side of the root→tip axis.
    expect(result.positions[1]!.z).toBeGreaterThan(0.1);
    // Tip still reaches the target.
    expect(Vector3.Distance(result.positions[2]!, target)).toBeLessThan(1e-2);
    // Bone lengths preserved by the rigid pole rotation.
    const after = segmentLengths(result.positions);
    for (let i = 0; i < before.length; i++) {
      expect(after[i]!).toBeCloseTo(before[i]!, 4);
    }
  });

  it("flips the bend side when the pole moves to the opposite side", () => {
    const make = () => [
      new Vector3(0, 0, 0),
      new Vector3(1, 0, 0),
      new Vector3(2, 0, 0),
    ];
    const target = new Vector3(1, 1, 0);
    const plusZ = solveFabrik(make(), target, { pole: new Vector3(1, 0, 5) });
    const minusZ = solveFabrik(make(), target, { pole: new Vector3(1, 0, -5) });
    expect(plusZ.positions[1]!.z).toBeGreaterThan(0.1);
    expect(minusZ.positions[1]!.z).toBeLessThan(-0.1);
  });

  it("keeps every joint within the bend limit", () => {
    // A 4-joint chain along X, pulled to a target that would fold it sharply.
    const joints = [
      new Vector3(0, 0, 0),
      new Vector3(1, 0, 0),
      new Vector3(2, 0, 0),
      new Vector3(3, 0, 0),
    ];
    const maxBendDeg = 30;
    const result = solveFabrik(joints, new Vector3(0.5, 0.5, 0), { maxBendDeg, maxIterations: 32 });

    const p = result.positions;
    // Bend angle at each interior joint = turn between consecutive bones.
    for (let i = 1; i < p.length - 1; i++) {
      const a = p[i]!.subtract(p[i - 1]!).normalize();
      const b = p[i + 1]!.subtract(p[i]!).normalize();
      const turn = Math.acos(Math.min(1, Math.max(-1, a.x * b.x + a.y * b.y + a.z * b.z)));
      const turnDeg = (turn * 180) / Math.PI;
      expect(turnDeg).toBeLessThanOrEqual(maxBendDeg + 0.5);
    }
  });

  it("still preserves bone lengths under a bend limit", () => {
    const joints = [
      new Vector3(0, 0, 0),
      new Vector3(1, 0, 0),
      new Vector3(2, 0, 0),
      new Vector3(3, 0, 0),
    ];
    const before = segmentLengths(joints);
    const result = solveFabrik(joints, new Vector3(1, 2, 0), { maxBendDeg: 45 });
    const after = segmentLengths(result.positions);
    for (let i = 0; i < before.length; i++) {
      expect(after[i]!).toBeCloseTo(before[i]!, 4);
    }
  });

  it("is deterministic — same input yields identical output", () => {
    const make = () => [
      new Vector3(0, 0, 0),
      new Vector3(0, 1, 0),
      new Vector3(0, 2, 0),
    ];
    const target = new Vector3(1.2, 1.4, 0.3);
    const a = solveFabrik(make(), target);
    const b = solveFabrik(make(), target);
    expect(a.iterations).toBe(b.iterations);
    expect(a.reached).toBe(b.reached);
    for (let i = 0; i < a.positions.length; i++) {
      expect(a.positions[i]!.equalsWithEpsilon(b.positions[i]!, 1e-12)).toBe(true);
    }
  });
});

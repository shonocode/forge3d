import { Vector3 } from "@babylonjs/core/Maths/math.vector";

/**
 * Inverse Kinematics solver (FABRIK).
 *
 * Pure, headless math — no Babylon scene, mesh, or skeleton dependency — so
 * it can be unit-tested deterministically. The skeleton integration that
 * reads/writes bone transforms lives in `skeleton-tool.ts`
 * (`solveIKForBone`); this module only does the geometry.
 *
 * FABRIK (Forward And Backward Reaching Inverse Kinematics) is chosen over
 * CCD because it converges in fewer iterations for typical limb chains,
 * never introduces flips, and operates purely on joint *positions* — which
 * maps directly onto forge3d's translation-only bone model (bones are
 * positioned joints, segment lengths are implicit from parent→child offset).
 */

export interface FabrikOptions {
  /** End-effector distance to target at which the chain is "reached". */
  tolerance?: number;
  /** Hard cap on iterations (each iteration = one backward + forward pass). */
  maxIterations?: number;
  /** Keep `joints[0]` anchored to its start position (default true). */
  fixedRoot?: boolean;
  /**
   * Optional pole (a.k.a. knee/elbow) target. After the chain is solved, the
   * intermediate joints are rigidly rotated about the root→tip axis so the
   * bend points toward this world position — without changing the tip or the
   * bone lengths. Resolves FABRIK's bend-direction ambiguity for limbs.
   * Ignored for chains shorter than 3 joints (nothing in between to steer).
   */
  pole?: Vector3;
  /**
   * Optional per-joint bend limit, in **degrees**. Each bone's direction is
   * clamped so it never turns more than this from the previous bone during
   * the forward pass — preventing sharp kinks / hyperextension. A tight limit
   * reduces reachability (the tip may not reach a target it otherwise could),
   * which is expected. `undefined` or `<= 0` disables the limit.
   */
  maxBendDeg?: number;
}

export interface FabrikResult {
  /** New joint world positions, root-first. Same length as input `joints`. */
  positions: Vector3[];
  /** Iterations actually run (0 when target was unreachable or trivial). */
  iterations: number;
  /** True when the end effector landed within `tolerance` of the target. */
  reached: boolean;
}

/**
 * Solve a joint chain so its last joint (the end effector) reaches `target`,
 * preserving every segment's original length.
 *
 * @param joints Root-first joint positions. The bone between `joints[i]` and
 *   `joints[i+1]` keeps its starting length throughout the solve.
 * @param target World position the end effector should reach.
 * @returns New positions plus convergence info. The input vectors are never
 *   mutated — every returned position is a fresh clone.
 *
 * When the target is farther than the chain can stretch, the chain is laid
 * out straight toward the target (the closest reachable pose) and `reached`
 * is `false`.
 */
export function solveFabrik(
  joints: Vector3[],
  target: Vector3,
  options: FabrikOptions = {}
): FabrikResult {
  const tolerance = options.tolerance ?? 1e-3;
  const maxIterations = options.maxIterations ?? 16;
  const fixedRoot = options.fixedRoot ?? true;
  const maxBendRad =
    options.maxBendDeg != null && options.maxBendDeg > 0
      ? (options.maxBendDeg * Math.PI) / 180
      : null;

  const n = joints.length;
  const p = joints.map((j) => j.clone());

  // A chain needs at least one segment to solve.
  if (n < 2) {
    return { positions: p, iterations: 0, reached: false };
  }

  // Precompute segment lengths (these are the constraints FABRIK preserves).
  const lengths: number[] = new Array(n - 1);
  let totalLength = 0;
  for (let i = 0; i < n - 1; i++) {
    const d = Vector3.Distance(p[i]!, p[i + 1]!);
    lengths[i] = d;
    totalLength += d;
  }

  const rootStart = p[0]!.clone();

  // Target out of reach → stretch the chain straight toward it. This is the
  // closest the end effector can get, so we report reached=false.
  if (Vector3.Distance(rootStart, target) > totalLength) {
    const dir = target.subtract(rootStart);
    const dl = dir.length();
    if (dl > 1e-9) dir.scaleInPlace(1 / dl);
    for (let i = 1; i < n; i++) {
      p[i] = p[i - 1]!.add(dir.scale(lengths[i - 1]!));
    }
    return { positions: p, iterations: 0, reached: false };
  }

  let iterations = 0;
  let reached = false;

  for (let iter = 0; iter < maxIterations; iter++) {
    if (Vector3.Distance(p[n - 1]!, target) <= tolerance) {
      reached = true;
      break;
    }
    iterations++;

    // Backward pass: pin the end effector to the target, then walk toward the
    // root re-projecting each joint onto its segment length.
    p[n - 1] = target.clone();
    for (let i = n - 2; i >= 0; i--) {
      const dir = p[i]!.subtract(p[i + 1]!);
      const dl = dir.length();
      if (dl > 1e-9) dir.scaleInPlace(1 / dl);
      p[i] = p[i + 1]!.add(dir.scale(lengths[i]!));
    }

    // Forward pass: snap the root back to its anchor, then walk to the end
    // effector re-projecting each joint. This is what preserves the base.
    if (fixedRoot) p[0] = rootStart.clone();
    let prevDir: Vector3 | null = null;
    for (let i = 1; i < n; i++) {
      const dir = p[i]!.subtract(p[i - 1]!);
      const dl = dir.length();
      if (dl > 1e-9) dir.scaleInPlace(1 / dl);
      // Clamp the turn at the joint to the bend limit (no limit on bone 1,
      // which has no preceding bone to measure against).
      const used: Vector3 =
        maxBendRad != null && prevDir ? clampBendDirection(prevDir, dir, maxBendRad) : dir;
      p[i] = p[i - 1]!.add(used.scale(lengths[i - 1]!));
      prevDir = used;
    }
  }

  if (!reached && Vector3.Distance(p[n - 1]!, target) <= tolerance) {
    reached = true;
  }

  if (options.pole && n >= 3) {
    applyPoleConstraint(p, options.pole);
  }

  return { positions: p, iterations, reached };
}

/**
 * Rotate the intermediate joints of an already-solved chain rigidly about the
 * root→tip axis so the bend faces `pole`. Because the rotation axis passes
 * through both the root and the tip (both lie on it), the tip and every bone
 * length are preserved exactly; only the bend direction changes.
 *
 * Mutates `p` in place. No-op when the chain is straight (no perpendicular
 * offset to steer) or the pole sits on the axis.
 */
function applyPoleConstraint(p: Vector3[], pole: Vector3): void {
  const n = p.length;
  const root = p[0]!;
  const tip = p[n - 1]!;

  const axis = tip.subtract(root);
  const axisLen = axis.length();
  if (axisLen < 1e-9) return;
  axis.scaleInPlace(1 / axisLen);

  // Reference bend direction: the most off-axis intermediate joint.
  let refIdx = -1;
  let refPerpLen = 0;
  const perpOf = (q: Vector3): Vector3 => {
    const v = q.subtract(root);
    const along = Vector3.Dot(v, axis);
    return v.subtract(axis.scale(along));
  };
  for (let i = 1; i < n - 1; i++) {
    const perpLen = perpOf(p[i]!).length();
    if (perpLen > refPerpLen) {
      refPerpLen = perpLen;
      refIdx = i;
    }
  }
  if (refIdx < 0 || refPerpLen < 1e-9) return;

  const curPerp = perpOf(p[refIdx]!);
  const polePerp = perpOf(pole);
  if (polePerp.length() < 1e-9) return;

  // Signed angle from current bend to pole direction about the axis.
  const from = curPerp.normalize();
  const to = polePerp.normalize();
  const cross = Vector3.Cross(from, to);
  const angle = Math.atan2(Vector3.Dot(cross, axis), Vector3.Dot(from, to));
  if (Math.abs(angle) < 1e-9) return;

  for (let i = 1; i < n - 1; i++) {
    p[i] = rotateAroundAxis(p[i]!, root, axis, angle);
  }
}

/**
 * Clamp `dir` so it turns no more than `maxRad` away from `prevDir`. Both are
 * assumed unit length; the result is unit length. When the requested turn is
 * within the limit, `dir` is returned unchanged; otherwise it is slerped back
 * toward `prevDir` to sit exactly on the limit.
 */
function clampBendDirection(prevDir: Vector3, dir: Vector3, maxRad: number): Vector3 {
  const d = Math.min(1, Math.max(-1, Vector3.Dot(prevDir, dir)));
  const ang = Math.acos(d);
  if (ang <= maxRad) return dir;

  const sinAng = Math.sin(ang);
  if (sinAng < 1e-6) {
    // (Anti)parallel — no stable slerp plane. Rotate prevDir by maxRad about
    // an arbitrary perpendicular so the result still respects the limit.
    const ref = Math.abs(prevDir.x) < 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
    const perp = Vector3.Cross(prevDir, ref);
    perp.normalize();
    return rotateAroundAxis(prevDir, new Vector3(0, 0, 0), perp, maxRad);
  }

  const t = maxRad / ang;
  const a = Math.sin((1 - t) * ang) / sinAng;
  const b = Math.sin(t * ang) / sinAng;
  return prevDir.scale(a).add(dir.scale(b));
}

/** Rodrigues rotation of `point` about the line through `pivot` along unit `axis`. */
function rotateAroundAxis(point: Vector3, pivot: Vector3, axis: Vector3, angle: number): Vector3 {
  const v = point.subtract(pivot);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dot = Vector3.Dot(axis, v);
  const cross = Vector3.Cross(axis, v);
  // v*cosθ + (axis×v)*sinθ + axis*(axis·v)*(1-cosθ)
  const rotated = v.scale(c).add(cross.scale(s)).add(axis.scale(dot * (1 - c)));
  return pivot.add(rotated);
}

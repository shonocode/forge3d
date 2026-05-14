// ── Cubic Bezier evaluation for animation curves ──────────────
//
// Given a segment from keyframe A (frame fA, value vA) to B (fB, vB)
// with A.outTangent and B.inTangent (each a `[deltaFrame, deltaValue]`
// from their respective keyframe), this module computes the value at
// any frame in [fA, fB].
//
// Geometry:
//
//     P0 = (fA, vA)
//     P1 = P0 + A.out     = (fA + outDx,  vA + outDy)
//     P2 = P3 + B.in      = (fB + inDx,   vB + inDy)    // inDx is usually negative
//     P3 = (fB, vB)
//
// A standard cubic Bezier B(t) = (1-t)³P0 + 3(1-t)²t P1 + 3(1-t)t² P2 + t³P3,
// parameterized by t ∈ [0, 1]. For animation, we have a target X
// (frame) and want the curve's Y (value) at that X. Since the X side
// is also a cubic in t, we solve for t numerically (bisection — fast
// enough for animation, robust to handle degenerate handles).
//
// Bisection over Newton-Raphson because:
//   - Bisection is unconditionally stable; Newton can overshoot when
//     handles produce a steep slope or cause the X-cubic to be
//     non-monotonic. With "weak" handle constraints (we do NOT enforce
//     monotonicity at the data layer; users can drag freely), Newton
//     can diverge or oscillate.
//   - For animation we sample at fixed pixel columns or per-frame,
//     so a few extra iterations of bisection (< 30) is negligible.
//
// X-monotonicity caveat: if the user drags A.outTangent past B (i.e.,
// `outDx > (fB - fA)`), the curve folds back on itself and there's
// no unique t for some X values. We clamp out-tangent x-extent in
// the editor UI, so this module assumes the input is well-formed.
// On the unlikely chance it isn't, bisection still returns _a_ valid
// t, just maybe not the "right" one — graceful degradation.

/**
 * Evaluate a cubic Bezier segment at a given frame.
 *
 * @param frame     Frame to sample at. Must lie in `[fA, fB]`. If
 *                  outside, the result is the closest endpoint value
 *                  (callers shouldn't pass out-of-range frames; this
 *                  is a defense-in-depth fallback).
 * @param fA        Start keyframe frame.
 * @param vA        Start keyframe value.
 * @param outDx     A.outTangent[0] (delta frame from A, positive).
 * @param outDy     A.outTangent[1] (delta value from A).
 * @param fB        End keyframe frame.
 * @param vB        End keyframe value.
 * @param inDx      B.inTangent[0] (delta frame from B, typically negative).
 * @param inDy      B.inTangent[1] (delta value from B).
 * @returns         Interpolated value at `frame`.
 */
export function evaluateBezierSegment(
  frame: number,
  fA: number,
  vA: number,
  outDx: number,
  outDy: number,
  fB: number,
  vB: number,
  inDx: number,
  inDy: number,
): number {
  if (frame <= fA) return vA;
  if (frame >= fB) return vB;

  const p0x = fA, p0y = vA;
  const p1x = fA + outDx, p1y = vA + outDy;
  const p2x = fB + inDx, p2y = vB + inDy;
  const p3x = fB, p3y = vB;

  // Bisection on t to find where Bx(t) == frame. The X-component of
  // a cubic Bezier is also a cubic in t.
  let lo = 0;
  let hi = 1;
  let t = 0.5;
  // 30 iterations of bisection gives ~1e-9 precision in t — overkill
  // for animation but cheap. We exit early if we converge below 1e-5
  // in x (sub-pixel for any reasonable graph editor zoom).
  for (let i = 0; i < 30; i++) {
    t = (lo + hi) * 0.5;
    const x = bezierAxis(t, p0x, p1x, p2x, p3x);
    const dx = x - frame;
    if (Math.abs(dx) < 1e-5) break;
    if (dx < 0) lo = t;
    else hi = t;
  }

  return bezierAxis(t, p0y, p1y, p2y, p3y);
}

/**
 * Evaluate a cubic Bezier on a single axis (X or Y) at parameter `t`.
 * Inlined here as a 1-D helper because the caller needs separate X
 * and Y evaluations and doing it as `Vector2` would allocate.
 */
function bezierAxis(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const u = 1 - t;
  return u * u * u * p0
       + 3 * u * u * t * p1
       + 3 * u * t * t * p2
       + t * t * t * p3;
}

/**
 * Compute a sensible default tangent pair for a keyframe given its
 * neighbors. Used when "Convert to Bezier" is invoked on a key with
 * no prior tangents — picks Catmull-Rom-like tangents (direction
 * along the line from prev to next, length 1/3 of segment) so the
 * initial curve looks identical to the previous straight-line
 * interpolation and the user can then refine.
 *
 * Edge keys (no prev or no next) get zero handles on the missing
 * side, which makes that side behave like a flat hold until the
 * user drags it.
 *
 * @param prevFrame   Previous key's frame, or `null` if this is the first key.
 * @param prevValue   Previous key's value on this channel.
 * @param frame       This key's frame.
 * @param value       This key's value on this channel.
 * @param nextFrame   Next key's frame, or `null` if this is the last key.
 * @param nextValue   Next key's value on this channel.
 */
export function autoTangentsFor(
  prevFrame: number | null,
  prevValue: number,
  frame: number,
  value: number,
  nextFrame: number | null,
  nextValue: number,
): { in: [number, number]; out: [number, number] } {
  // Direction = average slope of the two surrounding segments, length
  // = 1/3 of each segment's frame extent. This is the standard
  // "auto Bezier" defaults used by Blender / Maya. When a side is
  // missing, only use the present side's slope (creates a soft
  // ease in/out at endpoints).
  let inDx = 0, inDy = 0, outDx = 0, outDy = 0;

  if (prevFrame !== null) {
    const segFrames = frame - prevFrame;
    const segValues = value - prevValue;
    inDx = -segFrames / 3;
    inDy = -segValues / 3;
  }

  if (nextFrame !== null) {
    const segFrames = nextFrame - frame;
    const segValues = nextValue - value;
    outDx = segFrames / 3;
    outDy = segValues / 3;
  }

  // If both sides are present, average the slopes so the tangent runs
  // smoothly across the key (no kink). Length stays anchored to each
  // segment so the curve doesn't overshoot.
  if (prevFrame !== null && nextFrame !== null) {
    const totalDx = (frame - prevFrame) + (nextFrame - frame);
    const totalDy = nextValue - prevValue;
    const slope = totalDy / totalDx;
    inDy = inDx * slope;
    outDy = outDx * slope;
  }

  return {
    in: [inDx, inDy],
    out: [outDx, outDy],
  };
}

/**
 * Moving every vertex by a formula — Blender's deform modifiers.
 *
 * `displace.ts` is the irregular half of this job (noise, seeds, "make it read
 * as a stone"). These are the regular half: twist a column, bend a rail, taper
 * a leg, cast a rough shape onto a sphere. Topology never changes, so a mesh
 * that was quads stays quads and `catmullClark` still wants it.
 *
 * Every rule here was read off Blender rather than assumed — the numbers are on
 * each function, and each has a row in `tools/modeling/parity`.
 *
 * Pure and headless.
 */
import type { MeshData } from "../lib/mesh";
import type { Vec3 } from "./generate";
import { falloffWeight, type ProportionalFalloff } from "./edit-mode/proportional";

/** Which axis a deformation is measured along or turns about. */
export type DeformAxis = "x" | "y" | "z";

const AXIS_INDEX: Record<DeformAxis, number> = { x: 0, y: 1, z: 2 };

/** The other two axes, in cyclic order: z gives (x, y). */
function perpendicular(axis: DeformAxis): [number, number] {
  const a = AXIS_INDEX[axis];
  return [(a + 1) % 3, (a + 2) % 3];
}

/**
 * A deformed copy: new positions, and its own polygons, creases and seams.
 *
 * Spreading `...data` shares the creases `Map` and the seams `Set` with the
 * input, so creasing the result would crease the original too. None of the
 * parity rows could see that — the contents are identical either way — which
 * is exactly why it wants to be in one place.
 */
function deformed(data: MeshData, positions: Float32Array): MeshData {
  return {
    positions,
    polys: data.polys.map((p) => [...p]),
    creases: data.creases ? new Map(data.creases) : undefined,
    seams: data.seams ? new Set(data.seams) : undefined,
  };
}

export interface CastOptions {
  /** Default `"sphere"`. Blender's `cast_type`. */
  shape?: "sphere" | "cylinder" | "cuboid";
  /** How far toward the shape, 0..1. Blender's `factor`. Default 0.5. */
  factor?: number;
  /**
   * The shape's size. **0 means auto, and auto is two different rules.**
   *
   * `sphere` and `cylinder` take the *mean distance of the vertices from the
   * centre* — measured, not guessed: a 5×5 grid spanning ±1 gives 0.93718,
   * which is exactly that mean. `cuboid` takes the **bounding box**, one
   * half-extent per axis, so its box is not a cube unless the mesh is.
   *
   * A non-zero value is a cube (or sphere, or cylinder) of that size in every
   * axis.
   */
  size?: number;
  /** The shape's centre. Blender uses the object origin. Default [0, 0, 0]. */
  at?: Vec3;
  /** Which axes may move. Blender's `use_x` / `use_y` / `use_z`. Default all. */
  axes?: { x?: boolean; y?: boolean; z?: boolean };
}

/**
 * Pull the mesh toward a sphere, cylinder or box — Blender's **Cast** modifier.
 *
 * The cheap way to round something off without subdividing it: a chamfered
 * box cast 30% toward a sphere reads as a worn stone, and a cylinder cast
 * keeps the height while regularising the section.
 *
 * ## The three shapes, measured
 *
 * | shape | where a vertex is aimed |
 * |---|---|
 * | `sphere` | `dir(v) · size` — the whole vector normalised |
 * | `cylinder` | the same, but **only in the two axes across the cylinder**; the third is left alone |
 * | `cuboid` | scaled until the **first** axis reaches its face of the box: `k = min(half[i] / abs(v[i]))` |
 *
 * The result is `lerp(v, aim, factor)`. A vertex exactly on the centre has no
 * direction and stays.
 *
 * **The auto size is not one rule.** `sphere` and `cylinder` use the mean
 * distance from the centre; `cuboid` uses the bounding box, one half-extent
 * per axis. A sphere cannot tell those apart — all three half-extents equal
 * the mean — so it agreed while a squashed sphere was 100 mm out.
 *
 * `cylinder`'s axis is Z, which is Blender's — the cylinder stands along the
 * object's Z and the cast leaves Z alone.
 */
export function cast(data: MeshData, opts: CastOptions = {}): MeshData {
  const shape = opts.shape ?? "sphere";
  const factor = opts.factor ?? 0.5;
  const [cx, cy, cz] = opts.at ?? [0, 0, 0];
  const useX = opts.axes?.x ?? true;
  const useY = opts.axes?.y ?? true;
  const useZ = opts.axes?.z ?? true;

  const P = data.positions;
  const count = P.length / 3;

  let size = opts.size ?? 0;
  if (size === 0) {
    // Auto: the mean distance from the centre. The same number for the sphere
    // and the cylinder — the cylinder does **not** use a 2D mean, which is the
    // part that had to be measured rather than reasoned about.
    let sum = 0;
    for (let v = 0; v < count; v++)
      sum += Math.hypot(P[v * 3]! - cx, P[v * 3 + 1]! - cy, P[v * 3 + 2]! - cz);
    size = count > 0 ? sum / count : 0;
  }

  // The cuboid's auto size is **not** that mean: it is the bounding box, one
  // half-extent per axis. On a sphere the two are the same number in all three
  // axes, which is why a sphere could not tell them apart — a squashed sphere
  // can, and does.
  const half: [number, number, number] = [size, size, size];
  if (shape === "cuboid" && (opts.size ?? 0) === 0) {
    half[0] = 0;
    half[1] = 0;
    half[2] = 0;
    for (let v = 0; v < count; v++) {
      half[0] = Math.max(half[0], Math.abs(P[v * 3]! - cx));
      half[1] = Math.max(half[1], Math.abs(P[v * 3 + 1]! - cy));
      half[2] = Math.max(half[2], Math.abs(P[v * 3 + 2]! - cz));
    }
  }

  const out = new Float32Array(P);
  for (let v = 0; v < count; v++) {
    const x = P[v * 3]! - cx;
    const y = P[v * 3 + 1]! - cy;
    const z = P[v * 3 + 2]! - cz;

    let ax = x;
    let ay = y;
    let az = z;
    if (shape === "sphere") {
      const len = Math.hypot(x, y, z);
      if (len < 1e-12) continue;
      ax = (x / len) * size;
      ay = (y / len) * size;
      az = (z / len) * size;
    } else if (shape === "cylinder") {
      const len = Math.hypot(x, y);
      if (len < 1e-12) continue;
      ax = (x / len) * size;
      ay = (y / len) * size;
      az = z; // the axis is left where it is
    } else {
      // Scale until the **first** axis reaches its face of the box — the
      // smallest of the three ratios, not the largest component. The two are
      // the same when the box is a cube, which is how a unit sphere agreed
      // while a squashed one was 100 mm out and the arm came back inside out.
      let k = Infinity;
      for (let i = 0; i < 3; i++) {
        const c = i === 0 ? x : i === 1 ? y : z;
        if (Math.abs(c) < 1e-12) continue;
        k = Math.min(k, half[i]! / Math.abs(c));
      }
      if (!Number.isFinite(k)) continue;
      ax = x * k;
      ay = y * k;
      az = z * k;
    }

    if (useX) out[v * 3] = cx + x + (ax - x) * factor;
    if (useY) out[v * 3 + 1] = cy + y + (ay - y) * factor;
    if (useZ) out[v * 3 + 2] = cz + z + (az - z) * factor;
  }

  return deformed(data, out);
}

export interface SimpleDeformOptions {
  /** Blender's `deform_method`. */
  mode: "twist" | "bend" | "taper" | "stretch";
  /** Blender's `deform_axis`. Default `"z"`. */
  axis?: DeformAxis;
  /** Radians. `twist` and `bend` use this; the other two use `factor`. */
  angle?: number;
  /** `taper` and `stretch` use this; the other two use `angle`. */
  factor?: number;
}

/**
 * Twist, bend, taper or stretch — Blender's **Simple Deform** modifier.
 *
 * Four formulas that come up constantly in hard-surface work: a twisted
 * baluster, a bent rail, a tapered leg, a stretched finial.
 *
 * ## What each one does, measured
 *
 * Let `t` be the vertex's axis coordinate divided by the mesh's extent along
 * that axis — **measured from the origin, not from the low end**. Three strips
 * two units long settled it: z ∈ [−1, 1] gives t ∈ [−0.5, 0.5], z ∈ [0, 2]
 * gives [0, 1], z ∈ [2, 4] gives [1, 2]. A mesh centred on the origin cannot
 * tell those apart, which is why `cube` and `body` agreed while `arm` — the
 * one part that sits away from the origin — came back rotated as a whole.
 *
 * `u` and `v` are the other two axes in cyclic order (`z` gives `x`, `y`).
 *
 * | mode | rule | check |
 * |---|---|---|
 * | `twist` | rotate `(u, v)` by `angle · t` | 45° on a ±1 grid puts the `z = −1` corners at −22.5° |
 * | `bend` | wrap around a cylinder of radius `R = extentOfU / angle`: with `φ = u / R` and `r = R − v`, the vertex lands at `(r sin φ, R − r cos φ)` | all eight corners of a cube exact to six places |
 * | `taper` | scale `(u, v)` by `1 + factor · t`; the axis is untouched | `factor` 0.5 → the ends are 0.75 and 1.25 across |
 * | `stretch` | **not implemented** — the axis is `z + factor · t`, but the perpendicular scale depends on the bounding box in a way six extents did not pin down | refuses, with the measured table in the message |
 *
 * `stretch` is the one that would not resolve. Its perpendicular scale is a
 * parabola in the axis coordinate whose coefficients move with the bounding
 * box: at `factor` 0.5 an end vertex scales by 0.0625, 0.625, 1.0, 1.2083,
 * 1.375 and 1.9375 for extents 0.5, 1, 2, 3, 4 and 8. Three points fit many
 * curves and six still did not choose one, so it refuses rather than guess —
 * the same treatment `remove_doubles` and `unsubdivide` get.
 *
 * `bend` is parameterised by `u`, not by the axis: the deform axis is what the
 * mesh bends **around**, so the length being bent lies across it. That is why
 * a 45° bend about Z moves every vertex of a flat grid by the same amount in
 * Y regardless of its Z.
 */
export function simpleDeform(data: MeshData, opts: SimpleDeformOptions): MeshData {
  const axis = opts.axis ?? "z";
  const a = AXIS_INDEX[axis];
  const [u, v] = perpendicular(axis);
  const angle = opts.angle ?? 0;
  const factor = opts.factor ?? 0;

  const P = data.positions;
  const count = P.length / 3;
  const out = new Float32Array(P);
  if (count === 0) return deformed(data, out);

  const range = (i: number): [number, number] => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < count; k++) {
      const value = P[k * 3 + i]!;
      if (value < lo) lo = value;
      if (value > hi) hi = value;
    }
    return [lo, hi];
  };

  if (opts.mode === "stretch")
    throw new Error(
      `simpleDeform: "stretch" is not implemented — Blender's rule for it was ` +
        `measured and could not be read. The axis is simple (z gains ` +
        `factor · z / extent, confirmed on four extents), but the perpendicular ` +
        `scale depends on the bounding box in a way six extents did not pin ` +
        `down: with factor 0.5 an end vertex is scaled by 0.0625, 0.625, 1.0, ` +
        `1.2083, 1.375, 1.9375 for extents 0.5, 1, 2, 3, 4, 8. Guessing a curve ` +
        `through those would be inventing compatibility. "twist", "bend" and ` +
        `"taper" are exact.`,
    );

  if (opts.mode === "bend") {
    const [lo, hi] = range(u);
    const extent = hi - lo;
    if (extent < 1e-12 || Math.abs(angle) < 1e-12)
      return deformed(data, out);
    // The mesh wraps around a cylinder of this radius, and a vertex's own
    // distance from the axis is `radius - v` — that second term is what the
    // first attempt left out, and without it the arm came back inside out.
    const radius = extent / angle;
    for (let k = 0; k < count; k++) {
      const phi = P[k * 3 + u]! / radius;
      const r = radius - P[k * 3 + v]!;
      out[k * 3 + u] = r * Math.sin(phi);
      out[k * 3 + v] = radius - r * Math.cos(phi);
    }
    return deformed(data, out);
  }

  const [lo, hi] = range(a);
  const extent = hi - lo;
  for (let k = 0; k < count; k++) {
    // **From the origin, not from the low end.** Measured on three strips two
    // units long: z ∈ [−1, 1] gives t ∈ [−0.5, 0.5], z ∈ [0, 2] gives [0, 1],
    // z ∈ [2, 4] gives [1, 2]. A mesh centred on the origin cannot tell the
    // two readings apart, which is why `cube` and `body` agreed while `arm`
    // — the one part that sits away from the origin — was 55 mm out with the
    // same area and volume, a whole-body rotation.
    const t = extent < 1e-12 ? 0 : P[k * 3 + a]! / extent;
    if (opts.mode === "twist") {
      const th = angle * t;
      const c = Math.cos(th);
      const s = Math.sin(th);
      const pu = P[k * 3 + u]!;
      const pv = P[k * 3 + v]!;
      out[k * 3 + u] = pu * c - pv * s;
      out[k * 3 + v] = pu * s + pv * c;
    } else {
      const scale = 1 + factor * t;
      out[k * 3 + u] = P[k * 3 + u]! * scale;
      out[k * 3 + v] = P[k * 3 + v]! * scale;
    }
  }

  return deformed(data, out);
}

export interface WaveOptions {
  /**
   * How far the ridge lifts the surface at its crest — Blender's `height`.
   * Default 0.5, Blender's own.
   */
  height?: number;
  /**
   * Half the width of the band the ridge occupies. Outside `±width` of the
   * front the surface is left exactly alone, and the ridge is lowered by
   * `exp(-(width·narrowness)²)` so it meets zero at that edge rather than
   * stepping. Default 1.5.
   */
  width?: number;
  /**
   * How tight the crest is — the Gaussian's scale. Bigger is narrower.
   * Default 1.5.
   */
  narrowness?: number;
  /** How far the front travels per unit of `time`. Default 0.25. */
  speed?: number;
  /**
   * Where the front has got to: the displacement uses `(time − timeOffset) ·
   * speed`. Blender reads this off the frame number, so its own default view
   * at frame 1 is `time: 1`. Default 0 — the front at the start position.
   */
  time?: number;
  /** Subtracted from `time`, in the same units. Default 0. */
  timeOffset?: number;
  /**
   * Where the ripple starts, in the two plane axes in the order
   * `perpendicular(up)` gives them — for the default `up: "z"` that is
   * (x, y). Default [0, 0].
   */
  start?: [number, number];
  /**
   * Whether the wave is circular or straight. `"xy"` (default) measures the
   * distance from `start` in both plane axes and gives rings; `"x"` and `"y"`
   * use one **signed** coordinate and give a straight ridge. The names are the
   * plane's first and second axis, not world x and y, so with `up: "y"` they
   * mean z and x.
   */
  along?: "x" | "y" | "xy";
  /**
   * Repeat the ridge every `2·width`. **Measured, and it is not symmetric** —
   * Blender wraps with C's `fmod`, which keeps the sign of its left operand,
   * so the repeats appear on the near side of the front and not beyond it.
   * A line at `speed 0`, width 1.5, gets crests at 0, −3, −6… and nothing at
   * +3. Default false.
   */
  cyclic?: boolean;
  /**
   * Fade the ridge out linearly over this distance from `start`, measured
   * **from the start position and not from the travelled front** — a wave that
   * has moved out past the radius flattens rather than carrying its fade along
   * with it. 0 (default) means no fade.
   */
  falloff?: number;
  /** The axis the ridge pushes along. Default `"z"`, Blender's. */
  up?: DeformAxis;
}

/**
 * A ripple — Blender's **Wave** modifier, evaluated at one moment.
 *
 * Blender's version is an animation modifier and this one is not: `time` is a
 * parameter rather than a clock, which is the whole of the difference. For a
 * library that generates assets that is the useful half — corrugated sheet, a
 * ripple pressed into a pond surface, the ridges on a roof tile, a shallow
 * dish of concentric rings — and it is deterministic, so a build script gets
 * the same mesh every run.
 *
 * Topology never changes, so a mesh that was quads stays quads. Vertices that
 * sit outside the band are not touched at all, which means a wave can be
 * aimed at part of a mesh without selecting anything.
 *
 * ## The rule, measured
 *
 * With `d` the distance from `start` and `t = (time − timeOffset)·speed`:
 *
 * ```text
 * a = d − t                                (wrapped into ±width when cyclic)
 * if |a| < width:
 *   up += height · falloffFac · (exp(−(a·narrowness)²) − exp(−(width·narrowness)²))
 * ```
 *
 * Every term was read off Blender 5.1.1 on a 5×5 grid and a 17-point line.
 * The three that a first guess gets wrong:
 *
 * - **the pedestal** `exp(−(width·narrowness)²)` is subtracted, so at the
 *   default width 1.5 / narrowness 1.5 the crest is `0.99367·height`, not
 *   `height`
 * - **`along: "x"` is signed**, not an absolute value — the ridge ahead of the
 *   start and the ridge behind it are different parts of the same curve —
 *   while the **falloff distance is absolute**
 * - **the falloff is measured from `start`**, not from where the front has
 *   travelled to
 *
 * Not implemented, and not guessed: `damping_time` / `lifetime` (a fade in
 * time, which a single evaluation has no use for) and `use_normal`
 * (displacement along the surface normal — `MeshData` carries no normals).
 */
export function wave(data: MeshData, opts: WaveOptions = {}): MeshData {
  const up = opts.up ?? "z";
  const a = AXIS_INDEX[up];
  const [u, v] = perpendicular(up);
  const height = opts.height ?? 0.5;
  const width = opts.width ?? 1.5;
  const narrowness = opts.narrowness ?? 1.5;
  const speed = opts.speed ?? 0.25;
  const along = opts.along ?? "xy";
  const cyclic = opts.cyclic ?? false;
  const falloff = opts.falloff ?? 0;
  const [su, sv] = opts.start ?? [0, 0];
  const travel = ((opts.time ?? 0) - (opts.timeOffset ?? 0)) * speed;

  const P = data.positions;
  const count = P.length / 3;
  const out = new Float32Array(P);
  // The pedestal: what the Gaussian is worth at the edge of the band. Blender
  // subtracts it so the ridge lands on zero there instead of stepping.
  const pedestal = Math.exp(-((width * narrowness) ** 2));

  for (let k = 0; k < count; k++) {
    const du = P[k * 3 + u]! - su;
    const dv = P[k * 3 + v]! - sv;
    const dist = along === "xy" ? Math.hypot(du, dv) : along === "x" ? du : dv;

    let amp = dist - travel;
    // `%` in JS keeps the sign of the left operand, which is what C's `fmod`
    // does and what Blender relies on — see the note on `cyclic`.
    if (cyclic && width > 0) amp = ((amp - width) % (2 * width)) + width;
    if (!(amp > -width && amp < width)) continue;

    let fac = 1;
    if (falloff !== 0) {
      // Absolute, and from `start` — both measured, both easy to get wrong.
      fac = 1 - Math.abs(dist) / falloff;
      if (fac <= 0) continue;
    }

    const n = amp * narrowness;
    out[k * 3 + a] = P[k * 3 + a]! + height * fac * (Math.exp(-(n * n)) - pedestal);
  }

  return deformed(data, out);
}

/**
 * One end of a `warp` — where an empty sits, and how it is turned and sized.
 *
 * The same three fields `transformMesh` takes, composed the same way (scale,
 * then X/Y/Z Euler, then translate), so a transform written for one works in
 * the other.
 */
export interface WarpTransform {
  /** Where it sits. Blender's object location. Default the origin. */
  at?: Vec3;
  /** Euler angles in radians, applied X then Y then Z — Blender's `XYZ`. */
  rotate?: Vec3;
  /** Per-axis scale, or one number for uniform. Default 1. */
  scale?: Vec3 | number;
}

export interface WarpOptions {
  /** Where the region is now, and the centre the falloff is measured from. */
  from: WarpTransform;
  /** Where it is being taken to. */
  to: WarpTransform;
  /**
   * How far the influence reaches from `from`'s position — Blender's
   * `falloff_radius`. **Zero moves nothing at all**, which is measured and not
   * what "no falloff" would suggest; for an unfaded move use a radius that
   * covers the mesh with `falloff: "constant"`.
   */
  radius: number;
  /** Which curve the influence follows. Default `"smooth"`, Blender's. */
  falloff?: ProportionalFalloff;
  /**
   * Scales the influence — Blender's `strength`. Default 1. **Above 1 it
   * overshoots**: at 2 a vertex at the centre travels twice as far as `to`,
   * measured, rather than being clamped.
   */
  strength?: number;
}

/** A 3×4 affine matrix, row-major: `[m00 m01 m02 tx, m10 … ]`. */
type Affine = number[];

/** Apply a `WarpTransform` to one point — the same sequence `transformMesh` uses. */
function place(t: WarpTransform, x0: number, y0: number, z0: number): Vec3 {
  const s =
    typeof t.scale === "number" ? ([t.scale, t.scale, t.scale] as Vec3) : (t.scale ?? [1, 1, 1]);
  const [rx, ry, rz] = t.rotate ?? [0, 0, 0];
  const [tx, ty, tz] = t.at ?? [0, 0, 0];
  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  const cz = Math.cos(rz);
  const sz = Math.sin(rz);

  let x = x0 * s[0];
  let y = y0 * s[1];
  let z = z0 * s[2];

  let a = y * cx - z * sx;
  let b = y * sx + z * cx;
  y = a;
  z = b;

  a = x * cy + z * sy;
  b = -x * sy + z * cy;
  x = a;
  z = b;

  a = x * cz - y * sz;
  b = x * sz + y * cz;
  x = a;
  y = b;

  return [x + tx, y + ty, z + tz];
}

/**
 * The matrix of a `WarpTransform`, read off its own action on the basis.
 *
 * Built this way rather than written out so it cannot drift from `place` — and
 * `place` is the sequence the rest of the library already uses.
 */
function affineOf(t: WarpTransform): Affine {
  const o = place(t, 0, 0, 0);
  const ex = place(t, 1, 0, 0);
  const ey = place(t, 0, 1, 0);
  const ez = place(t, 0, 0, 1);
  return [
    ex[0] - o[0], ey[0] - o[0], ez[0] - o[0], o[0],
    ex[1] - o[1], ey[1] - o[1], ez[1] - o[1], o[1],
    ex[2] - o[2], ey[2] - o[2], ez[2] - o[2], o[2],
  ];
}

/** The inverse, or null when the linear part is singular (a zero scale axis). */
function invert(m: Affine): Affine | null {
  const [a, b, c, tx, d, e, f, ty, g, h, i, tz] = m as [
    number, number, number, number, number, number,
    number, number, number, number, number, number,
  ];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-20) return null;
  const inv = [
    (e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det,
    (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det,
  ];
  return [
    inv[0]!, inv[1]!, inv[2]!, -(inv[0]! * tx + inv[1]! * ty + inv[2]! * tz),
    inv[3]!, inv[4]!, inv[5]!, -(inv[3]! * tx + inv[4]! * ty + inv[5]! * tz),
    inv[6]!, inv[7]!, inv[8]!, -(inv[6]! * tx + inv[7]! * ty + inv[8]! * tz),
  ];
}

/** `p · q` — apply `q` first, then `p`. */
function compose(p: Affine, q: Affine): Affine {
  const out: Affine = [];
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 4; c++) {
      let sum = c === 3 ? p[r * 4 + 3]! : 0;
      for (let k = 0; k < 3; k++) sum += p[r * 4 + k]! * q[k * 4 + c]!;
      out.push(sum);
    }
  return out;
}

/**
 * Move part of a mesh from one place to another, fading out with distance —
 * Blender's **Warp** modifier.
 *
 * Two empties in Blender; two transforms here. Everything within `radius` of
 * `from` is carried by the transform that takes `from` onto `to`, weighted by
 * how close it is. That covers the ordinary "grab this corner and pull",
 * but because both ends are full transforms it also twists and swells: a
 * `to` rotated about its own axis wrings the region, and a `to` scaled up
 * inflates it.
 *
 * Topology never changes. Nothing outside the radius is touched at all, so no
 * selection is needed — the radius is the selection.
 *
 * ## Measured, on Blender 5.1.1
 *
 * ```text
 * M   = matrix(to) · matrix(from)⁻¹
 * d   = |p − position(from)|
 * w   = strength · falloffWeight(1 − d/radius)      when d < radius, else 0
 * p' = p + w · (M·p − p)
 * ```
 *
 * The three that are not obvious:
 *
 * - **`radius: 0` moves nothing.** Not "no falloff" — every vertex comes back
 *   untouched.
 * - **`strength` is not clamped.** At 2 the centre travels twice as far as
 *   `to`; the weight is a plain multiplier on the interpolation.
 * - **the distance is to `from`'s position only** — its rotation and scale
 *   change the transform but not the sphere the falloff is measured in.
 *
 * `use_volume_preserve` is not implemented.
 */
export function warp(data: MeshData, opts: WarpOptions): MeshData {
  const radius = opts.radius;
  const strength = opts.strength ?? 1;
  const falloff = opts.falloff ?? "smooth";

  const P = data.positions;
  const out = new Float32Array(P);
  const same = deformed(data, out);
  // Measured: zero is "nothing moves", not "everything moves".
  if (!(radius > 0) || strength === 0) return same;

  const fromMat = affineOf(opts.from);
  const inv = invert(fromMat);
  if (inv === null)
    throw new Error(
      "warp: `from` has a zero scale on some axis, so there is no transform " +
        "from it to `to`.",
    );
  const M = compose(affineOf(opts.to), inv);
  const [fx, fy, fz] = opts.from.at ?? [0, 0, 0];

  for (let k = 0; k < P.length / 3; k++) {
    const x = P[k * 3]!;
    const y = P[k * 3 + 1]!;
    const z = P[k * 3 + 2]!;
    const d = Math.hypot(x - fx, y - fy, z - fz);
    if (d >= radius) continue;

    const w = strength * falloffWeight(1 - d / radius, falloff);
    if (w === 0) continue;

    for (let r = 0; r < 3; r++) {
      const moved = M[r * 4]! * x + M[r * 4 + 1]! * y + M[r * 4 + 2]! * z + M[r * 4 + 3]!;
      const here = r === 0 ? x : r === 1 ? y : z;
      out[k * 3 + r] = here + w * (moved - here);
    }
  }

  return same;
}

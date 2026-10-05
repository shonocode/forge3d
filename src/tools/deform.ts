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
import { withPositions, type MeshData } from "../lib/mesh";
import { vertexGroupWeights } from "./mesh-layers";
import type { Vec3 } from "./generate";
import { falloffWeight, type ProportionalFalloff } from "./edit-mode/proportional";
import { invert4, meshVertNormals, type V3 } from "./blender-math";
import { textureCoords } from "./displace";
import { textureValue, type ProceduralTexture } from "./texture/texture";

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
  // The corners are the same corners: every layer still applies.
  return withPositions(data, positions);
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
  /**
   * Blender's `vertex_group`: the modifier's strength at each vertex is multiplied by its weight, and a vertex
   * with weight 0 is left alone. No such group, or no vertex in any group, and it applies in full
   * (`MOD_get_vgroup`).
   */
  vertexGroup?: string;
  /** `invert_vertex_group`: `1 − weight`. */
  invertVertexGroup?: boolean;
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
  const vg = vertexGroupWeights(data, opts.vertexGroup, opts.invertVertexGroup);
  const groupWeights = vg && !vg.empty ? vg.weights : null;
  for (let v = 0; v < count; v++) {
    const x = P[v * 3]! - cx;
    const y = P[v * 3 + 1]! - cy;
    const z = P[v * 3 + 2]! - cz;
    const weight = groupWeights ? groupWeights[v]! : 1;
    if (weight === 0) continue;
    const fac = factor * weight;

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

    if (useX) out[v * 3] = cx + x + (ax - x) * fac;
    if (useY) out[v * 3 + 1] = cy + y + (ay - y) * fac;
    if (useZ) out[v * 3 + 2] = cz + z + (az - z) * fac;
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
  /**
   * Blender's `limits`: the part of the mesh that is deformed, as fractions of its extent along the axis the mode
   * works along (the deform axis; for `bend`, the axis it bends across). A vertex beyond a limit is
   * deformed as if it were on it and then carried along. Default `[0, 1]`.
   */
  limits?: [number, number];
  /**
   * Blender's `lock_x` / `lock_y` / `lock_z` (`taper`, `stretch`, `twist`): a locked axis is held at the origin during
   * the deformation — the vertex is flattened onto that plane and its distance from it added back after. Ignored for
   * the deform axis itself and for `bend`.
   */
  lockX?: boolean;
  lockY?: boolean;
  lockZ?: boolean;
  /**
   * Blender's `origin` object: a 4 × 4 row-major matrix (16 numbers) — the origin object's transform seen from the
   * mesh. The mesh is taken into the origin's space, deformed there and brought back, so the axes, the extent and the
   * zero of the deformation are the origin's. Default none (the mesh's own).
   */
  origin?: readonly number[];
  /**
   * Blender's `vertex_group`: the modifier's strength at each vertex is multiplied by its weight, and a vertex
   * with weight 0 is left alone. No such group, or no vertex in any group, and it applies in full
   * (`MOD_get_vgroup`).
   */
  vertexGroup?: string;
  /** `invert_vertex_group`: `1 − weight`. */
  invertVertexGroup?: boolean;
}

const applyMatrix4 = (m: readonly number[], x: number, y: number, z: number): [number, number, number] => [
  m[0]! * x + m[1]! * y + m[2]! * z + m[3]!,
  m[4]! * x + m[5]! * y + m[6]! * z + m[7]!,
  m[8]! * x + m[9]! * y + m[10]! * z + m[11]!,
];

/** `axis_map_table`: the deformations (bend apart) are written for Z, so the others turn the axes round to it. */
const AXIS_MAP: readonly (readonly [number, number, number])[] = [
  [1, 2, 0],
  [2, 0, 1],
  [0, 1, 2],
];
/** `FLT_EPSILON`. */
const FLT_EPSILON = 1.1920928955078125e-7;
/** `BEND_EPS`. */
const BEND_EPS = 0.000001;

/**
 * Twist, bend, taper or stretch — Blender's **Simple Deform** modifier, ported from `MOD_simpledeform.cc`.
 *
 * Four formulas that come up constantly in hard-surface work: a twisted
 * baluster, a bent rail, a tapered leg, a stretched finial.
 *
 * ## The rule
 *
 * The modifier works on a copy of each vertex with the axes turned so that the deform axis is Z (`axis_map_table`;
 * `bend` is the exception and keeps them). Along that axis the mesh has an extent `e = upper − lower`; `limits`
 * pick the part `[lower + e·l0, lower + e·l1]` that is deformed, and the factor is divided by that length. Every mode is then
 * a function of the **raw** coordinate `z` — "measured from the origin, not from the low end": z ∈ [−1, 1], [0, 2] and
 * [2, 4] deform differently, which is why a mesh centred on the origin could not tell the readings apart (`arm` could).
 *
 * | mode | rule (`f` = factor / limit length) |
 * |---|---|
 * | `twist` | rotate `(x, y)` by `z · f` |
 * | `taper` | scale `(x, y)` by `1 + z · f`; `z` untouched |
 * | `stretch` | scale `(x, y)` by `z² · f − f + 1`; `z` becomes `z · (1 + f)` |
 * | `bend` | `θ = f ·` the long coordinate; the vertex lands on a circle of radius `1 / f` |
 *
 * `bend` bends along the axis perpendicular to the deform axis (Z: along X, bending in X–Y; X and Y: along Z), so its extent
 * is measured there. A `bend` with `|f| < 10⁻⁶` changes nothing.
 *
 * A vertex outside the limits is clamped to the limit before the formula and the clamped-off part is added back after —
 * so a limited twist carries the rest of the mesh along rigidly. A locked axis (`taper` / `stretch` / `twist`, never the
 * deform axis) is held at 0 the same way.
 */
export function simpleDeform(data: MeshData, opts: SimpleDeformOptions): MeshData {
  const axis = opts.axis ?? "z";
  const deformAxis = AXIS_INDEX[axis];
  const mode = opts.mode;
  const P = data.positions;
  const count = P.length / 3;
  const out = new Float32Array(P);
  if (count === 0) return deformed(data, out);

  const lock = [opts.lockX ?? false, opts.lockY ?? false, opts.lockZ ?? false];
  if (mode === "bend") lock.fill(false);
  else lock[deformAxis] = false;

  const l1 = opts.limits?.[1] ?? 1;
  const l0 = Math.min(Math.min(Math.max(opts.limits?.[0] ?? 0, 0), 1), l1);

  const toOrigin = opts.origin ? invert4(opts.origin) : null;
  const fromOrigin = opts.origin ?? null;
  const into = (i: number): [number, number, number] =>
    toOrigin ? applyMatrix4(toOrigin, P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!) : [P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!];

  const limitAxis = mode === "bend" ? (deformAxis === 2 ? 0 : 2) : deformAxis;
  let lower = Infinity;
  let upper = -Infinity;
  for (let i = 0; i < count; i++) {
    const c = into(i)[limitAxis]!;
    if (c < lower) lower = c;
    if (c > upper) upper = c;
  }
  const limit1 = lower + (upper - lower) * l1;
  const limit0 = lower + (upper - lower) * l0;
  const base = mode === "twist" || mode === "bend" ? (opts.angle ?? 0) : (opts.factor ?? 0);
  const factor = base / Math.max(FLT_EPSILON, limit1 - limit0);
  if (mode === "bend" && Math.abs(factor) < BEND_EPS) return deformed(data, out);

  const map = AXIS_MAP[mode === "bend" ? 2 : deformAxis]!;
  const vg = vertexGroupWeights(data, opts.vertexGroup, opts.invertVertexGroup);
  const groupWeights = vg && !vg.empty ? vg.weights : null;
  for (let i = 0; i < count; i++) {
    const weight = groupWeights ? groupWeights[i]! : 1;
    if (weight === 0) continue;
    const co = into(i);
    const dcut: [number, number, number] = [0, 0, 0];
    const limit = (k: number, lo: number, hi: number): void => {
      const val = Math.min(hi, Math.max(lo, co[k]!));
      dcut[k] = co[k]! - val;
      co[k] = val;
    };
    for (let k = 0; k < 3; k++) if (lock[k]) limit(k, 0, 0);
    limit(limitAxis, limit0, limit1);

    const [x, y, z] = [co[map[0]]!, co[map[1]]!, co[map[2]]!];
    const d: [number, number, number] = [dcut[map[0]]!, dcut[map[1]]!, dcut[map[2]]!];
    const r: [number, number, number] = [x, y, z];
    if (mode === "twist") {
      const theta = z * factor;
      const sint = Math.sin(theta);
      const cost = Math.cos(theta);
      r[0] = x * cost - y * sint + d[0];
      r[1] = x * sint + y * cost + d[1];
      r[2] = z + d[2];
    } else if (mode === "taper") {
      const scale = z * factor;
      r[0] = x + x * scale + d[0];
      r[1] = y + y * scale + d[1];
      r[2] = z + d[2];
    } else if (mode === "stretch") {
      const scale = z * z * factor - factor + 1;
      r[0] = x * scale + d[0];
      r[1] = y * scale + d[1];
      r[2] = z * (1 + factor) + d[2];
    } else {
      // bend: no remapping, the axes are written out (and `d` is not remapped either).
      const theta = (deformAxis === 2 ? x : z) * factor;
      const sint = Math.sin(theta);
      const cost = Math.cos(theta);
      if (deformAxis === 0) {
        r[0] = x + d[0];
        r[1] = y * cost + (1 - cost) / factor + sint * d[2];
        r[2] = -(y - 1 / factor) * sint + cost * d[2];
      } else if (deformAxis === 1) {
        r[0] = x * cost + (1 - cost) / factor + sint * d[2];
        r[1] = y + d[1];
        r[2] = -(x - 1 / factor) * sint + cost * d[2];
      } else {
        r[0] = -(y - 1 / factor) * sint + cost * d[0];
        r[1] = y * cost + (1 - cost) / factor + sint * d[0];
        r[2] = z + d[2];
      }
    }
    const back: [number, number, number] = [0, 0, 0];
    for (let k = 0; k < 3; k++) back[map[k]!] = r[k]!;
    const world = fromOrigin ? applyMatrix4(fromOrigin, back[0], back[1], back[2]) : back;
    // `interp_v3_v3v3(vertexCos, vertexCos, co, weight)`: the weight blends the old and the deformed position.
    for (let k = 0; k < 3; k++) out[i * 3 + k] = weight === 1 ? world[k]! : P[i * 3 + k]! + (world[k]! - P[i * 3 + k]!) * weight;
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
  /**
   * Push along each vertex's normal instead of `up` — Blender's `use_normal`,
   * with `use_normal_x/y/z` as the three flags (all on when `true`). Only the
   * chosen components of the normal move the vertex. The normal is Blender's
   * (`Mesh::vert_normals`, corner-angle weighted).
   */
  normal?: boolean | { x?: boolean; y?: boolean; z?: boolean };
  /**
   * Blender's `lifetime`: after this much time past `timeOffset` the wave
   * starts to die away, reaching nothing `damping` later. 0 (default) lives
   * for ever.
   */
  lifetime?: number;
  /** Blender's `damping_time`. Default 10, Blender's (0 also reads as 10). */
  damping?: number;
  /**
   * Scale the ridge by a procedural texture read at each vertex — Blender's
   * `texture`: the push is multiplied by the texture's value (its intensity,
   * or the mean of its colour). Default none.
   */
  texture?: ProceduralTexture;
  /** Where the texture is read: `"local"` (default) or `"uv"`, as `textureDisplace`'s `coords`. */
  textureCoords?: "local" | "uv";
  /**
   * Blender's `vertex_group`: the modifier's strength at each vertex is multiplied by its weight, and a vertex
   * with weight 0 is left alone. No such group, or no vertex in any group, and it applies in full
   * (`MOD_get_vgroup`).
   */
  vertexGroup?: string;
  /** `invert_vertex_group`: `1 − weight`. */
  invertVertexGroup?: boolean;
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
 * `normal`, `lifetime` and `damping` came in on 2026-09-25, read from
 * `MOD_wave.cc`: past the lifetime the height becomes
 * `height · (1 − √((t − lifetime) / damping))`, and zero once that passes
 * `damping`; along the normal the push is `height·amplitude·n` on each chosen
 * axis. (`up` is then ignored.)
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
  const elapsed = (opts.time ?? 0) - (opts.timeOffset ?? 0);
  const travel = elapsed * speed;

  // `lifefac`: the height, faded after the lifetime.
  let lifefac = height;
  const lifetime = opts.lifetime ?? 0;
  const damping = opts.damping || 10;
  if (lifetime !== 0 && elapsed > lifetime) {
    const over = elapsed - lifetime;
    lifefac = over > damping ? 0 : height * (1 - Math.sqrt(over / damping));
  }
  const byNormal =
    opts.normal === true ? [true, true, true]
    : opts.normal ? [opts.normal.x ?? false, opts.normal.y ?? false, opts.normal.z ?? false]
    : null;

  const P = data.positions;
  const count = P.length / 3;
  const out = new Float32Array(P);
  if (lifefac === 0) return deformed(data, out);
  const pts: V3[] = [];
  for (let k = 0; k < count; k++) pts.push([P[k * 3]!, P[k * 3 + 1]!, P[k * 3 + 2]!]);
  const normals = byNormal ? meshVertNormals(pts, data.polys) : null;
  const texCo = opts.texture ? textureCoords(data, pts, opts.textureCoords ?? "local") : null;
  // The pedestal: what the Gaussian is worth at the edge of the band. Blender
  // subtracts it so the ridge lands on zero there instead of stepping.
  const pedestal = Math.exp(-((width * narrowness) ** 2));

  const vg = vertexGroupWeights(data, opts.vertexGroup, opts.invertVertexGroup);
  const groupWeights = vg && !vg.empty ? vg.weights : null;
  for (let k = 0; k < count; k++) {
    // A vertex that is not in the group is not deformed at all; the rest scale the ridge.
    const defWeight = groupWeights ? groupWeights[k]! : 1;
    if (defWeight === 0) continue;
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
    let ridge = Math.exp(-(n * n)) - pedestal;
    if (texCo) ridge *= textureValue(opts.texture!, texCo[k]!).intensity;
    const push = lifefac * fac * defWeight * ridge;
    if (normals) {
      for (let c = 0; c < 3; c++)
        if (byNormal![c]) out[k * 3 + c] = P[k * 3 + c]! + push * normals[k]![c]!;
    } else out[k * 3 + a] = P[k * 3 + a]! + push;
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
  /**
   * Blender's `vertex_group`: the modifier's strength at each vertex is multiplied by its weight, and a vertex
   * with weight 0 is left alone. No such group, or no vertex in any group, and it applies in full
   * (`MOD_get_vgroup`).
   */
  vertexGroup?: string;
  /** `invert_vertex_group`: `1 − weight`. */
  invertVertexGroup?: boolean;
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
  const vg = vertexGroupWeights(data, opts.vertexGroup, opts.invertVertexGroup);
  const groupWeights = vg && !vg.empty ? vg.weights : null;

  for (let k = 0; k < P.length / 3; k++) {
    const x = P[k * 3]!;
    const y = P[k * 3 + 1]!;
    const z = P[k * 3 + 2]!;
    const d = Math.hypot(x - fx, y - fy, z - fz);
    if (d >= radius) continue;

    // `weight = vertex weight · strength`; a vertex with none is skipped before the falloff is read.
    const vertexWeight = groupWeights ? groupWeights[k]! : 1;
    if (vertexWeight <= 0) continue;
    const w = strength * vertexWeight * falloffWeight(1 - d / radius, falloff);
    if (w === 0) continue;

    for (let r = 0; r < 3; r++) {
      const moved = M[r * 4]! * x + M[r * 4 + 1]! * y + M[r * 4 + 2]! * z + M[r * 4 + 3]!;
      const here = r === 0 ? x : r === 1 ? y : z;
      out[k * 3 + r] = here + w * (moved - here);
    }
  }

  return same;
}

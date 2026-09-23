/**
 * The two modifiers that write the UV layer — `UV_PROJECT` and `UV_WARP`.
 *
 * Cheap because the layer was already there: `MeshData.uvs`, one pair per face
 * corner, shaped like `polys`. Neither of these needs a new field, and neither
 * moves a vertex.
 *
 * ## `uvProject`
 *
 * For a projector that is not a camera the whole rule is
 *
 * ```
 * uv = (p.x, p.y) * 0.5 + 0.5,   p = inverse(projector) @ vertex
 * ```
 *
 * measured on a flat grid at the origin with the projector moved, scaled and
 * rotated 90° — four cases, exact — and then confirmed against
 * `MOD_uvproject.cc`, which builds `projmat = offsetmat @ inverse(projector)`
 * with `offsetmat` scaling by 0.5 and translating by 0.5. So the z coordinate
 * is dropped: an empty projects **orthographically**, and moving it along its
 * own z changes nothing.
 *
 * **With more than one projector the choice per face had to be read from the
 * source.** The measurement said the chosen projector was always the one
 * *perpendicular* to the face normal, which makes no sense for a projection —
 * and the reason is that "forward" for this test is the projector's **+Z**,
 * not the −Z a camera looks along. The rule is
 *
 * ```
 * best = argmax over projectors of dot(projector_+Z, face_normal)
 * ```
 *
 * with a strict `>` in the loop, so **a tie keeps the earlier projector**.
 * Both readings fit all six faces of a cube for two- and three-projector runs
 * once the projectors are given distinct translations — which they have to be,
 * because the first attempt used projectors whose answers happened to agree
 * and so could not see the choice at all.
 *
 * Two details from the source that a measurement would not show:
 *
 *   * the +Z axis is transformed by the projector's 3×3 and **not
 *     normalised**, so a scaled projector weighs more in the comparison;
 *   * Blender compares that **world-space** axis against the face's
 *     **object-space** normal. With an object transform those are different
 *     spaces; here there is no object transform, so the two agree.
 *
 * **Camera projectors are not offered**, and neither are `aspect_x/y` or
 * `scale_x/y`. Those four are camera-only — measured (they move nothing at all
 * on an empty) and confirmed in the source, where they appear solely inside
 * the `OB_CAMERA` branch. Reproducing them means reproducing
 * `BKE_camera_params_compute_viewplane`, which is a camera model, not a mesh
 * operator; the measurements are in `probe-uv-modifiers2.py` for whoever wants
 * it (lens 50 gives `0.5 + (p.x / -p.z) * lens / 36`, and an ortho camera is
 * `0.5 + p.x / ortho_scale`).
 *
 * ## `uvWarp`
 *
 * ```
 * d   = (uv + offset) - centre
 * d   = scale * (rotate(d))          // rotation first, then scale
 * p3  = a 3-vector with p3[axisU] = d.u, p3[axisV] = d.v, the third 0
 * p3  = inverse(to) @ from @ p3
 * uv' = (p3[axisU], p3[axisV]) + centre
 * ```
 *
 * Every stage of that is pinned by a case where the alternatives disagree:
 *
 *   * **the offset comes before the rotation.** With all three set the answer
 *     is `(1.5, 0.25)`; offsetting afterwards gives `(1.75, 0)`.
 *   * **the rotation comes before the scale.** The pair of corners `(0,0)` and
 *     `(1,0)` end up one apart, not two, so the non-uniform scale is applied
 *     to the rotated vector.
 *   * **the object pair comes last.** Adding a `to` translated by 0.25 in x
 *     shifts the *rotated* result along u, not the input.
 *   * **the default centre is `(0.5, 0.5)`**, not the origin — asking for that
 *     centre explicitly changes nothing, and a scale of 2 sends `(0, 0)` to
 *     `(-0.5, 0)`.
 *   * **the pair applies `inverse(to) @ from`**, so a `to` rotated by +90°
 *     turns the UVs by −90°: measured side by side with `rotation: +90°`,
 *     which turns them the other way.
 *   * **both halves of the pair are needed.** With only one set, Blender
 *     leaves the UVs alone.
 *
 * `axisU` / `axisV` do nothing without the pair, which is why the first probe
 * read them as inert: they name which plane of a 3D transform the UVs live in,
 * and with no transform there is no plane to name. Five combinations measured
 * once a moving `to` was there.
 */
import type { MeshData } from "../../lib/mesh";
import type { WarpTransform } from "../deform";

/** Which of a transform's three axes a UV coordinate rides on. */
export type UVWarpAxis = "x" | "y" | "z";

export interface UVProjectOptions {
  /**
   * Where the projectors sit, in the order Blender lists them — the order
   * matters, because a tie in the per-face choice keeps the **earlier** one.
   *
   * Each is an object transform in the same form `warp` takes. A projector
   * projects along its own z, and the mesh point's x and y in that space
   * become the UV.
   */
  projectors: readonly WarpTransform[];
}

export interface UVWarpOptions {
  /** Blender's `center`. **Default `[0.5, 0.5]`**, which is Blender's. */
  center?: readonly [number, number];
  /** Added to the UV **before** the rotation and scale. Default none. */
  offset?: readonly [number, number];
  /** Applied after the rotation, about `center`. Default `[1, 1]`. */
  scale?: readonly [number, number];
  /** Radians, about `center`, applied before the scale. Default 0. */
  rotation?: number;
  /** Which axis of the object pair's transform carries u. Default `"x"`. */
  axisU?: UVWarpAxis;
  /** Which axis carries v. Default `"y"`. */
  axisV?: UVWarpAxis;
  /**
   * Blender's `object_from` / `object_to`. The UVs are transformed by
   * `inverse(to) @ from`, so moving `to` moves them the other way.
   * **Both are needed**; with one alone Blender does nothing, and so does
   * this.
   */
  from?: WarpTransform;
  to?: WarpTransform;
}

type Vec3 = [number, number, number];
/** A 4×4 affine as 16 numbers, column-major like Blender's. */
type Mat4 = number[];

const AXIS: Record<UVWarpAxis, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };

/**
 * The object matrix of a `WarpTransform`: scale, then X/Y/Z Euler, then
 * translate — the same order `transformMesh` and `warp` compose, and Blender's
 * `XYZ` mode.
 */
function matrixOf(t: WarpTransform | undefined): Mat4 {
  const s =
    t === undefined
      ? ([1, 1, 1] as Vec3)
      : typeof t.scale === "number"
        ? ([t.scale, t.scale, t.scale] as Vec3)
        : ((t.scale ?? [1, 1, 1]) as Vec3);
  const [rx, ry, rz] = (t?.rotate ?? [0, 0, 0]) as Vec3;
  const [tx, ty, tz] = (t?.at ?? [0, 0, 0]) as Vec3;
  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  const cz = Math.cos(rz);
  const sz = Math.sin(rz);
  // R = Rz · Ry · Rx, which is what "X then Y then Z" composes to.
  const r = [
    cz * cy,
    cz * sy * sx - sz * cx,
    cz * sy * cx + sz * sx,
    sz * cy,
    sz * sy * sx + cz * cx,
    sz * sy * cx - cz * sx,
    -sy,
    cy * sx,
    cy * cx,
  ];
  // Column-major: columns are the transformed basis vectors, times the scale.
  return [
    r[0]! * s[0], r[3]! * s[0], r[6]! * s[0], 0,
    r[1]! * s[1], r[4]! * s[1], r[7]! * s[1], 0,
    r[2]! * s[2], r[5]! * s[2], r[8]! * s[2], 0,
    tx, ty, tz, 1,
  ];
}

/** `m @ p`, treating `p` as a point (w = 1). */
function applyPoint(m: Mat4, p: Vec3): Vec3 {
  return [
    m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!,
    m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!,
    m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!,
  ];
}

/** `m @ v`, treating `v` as a direction (w = 0) — the 3×3 part only. */
function applyDir(m: Mat4, v: Vec3): Vec3 {
  return [
    m[0]! * v[0] + m[4]! * v[1] + m[8]! * v[2],
    m[1]! * v[0] + m[5]! * v[1] + m[9]! * v[2],
    m[2]! * v[0] + m[6]! * v[1] + m[10]! * v[2],
  ];
}

/** General 4×4 inverse. Affine here, but written for any invertible matrix. */
function invert(m: Mat4): Mat4 {
  // 3×3 part, inverted by the adjugate, then the translation follows.
  const a = m[0]!, b = m[4]!, c = m[8]!;
  const d = m[1]!, e = m[5]!, f = m[9]!;
  const g = m[2]!, h = m[6]!, i = m[10]!;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-30)
    throw new Error("uv-modifiers: a transform with zero scale cannot be inverted");
  const inv = 1 / det;
  const r = [
    (e * i - f * h) * inv, (c * h - b * i) * inv, (b * f - c * e) * inv,
    (f * g - d * i) * inv, (a * i - c * g) * inv, (c * d - a * f) * inv,
    (d * h - e * g) * inv, (b * g - a * h) * inv, (a * e - b * d) * inv,
  ];
  const tx = m[12]!, ty = m[13]!, tz = m[14]!;
  return [
    r[0]!, r[3]!, r[6]!, 0,
    r[1]!, r[4]!, r[7]!, 0,
    r[2]!, r[5]!, r[8]!, 0,
    -(r[0]! * tx + r[1]! * ty + r[2]! * tz),
    -(r[3]! * tx + r[4]! * ty + r[5]! * tz),
    -(r[6]! * tx + r[7]! * ty + r[8]! * tz),
    1,
  ];
}

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row]! * b[col * 4 + k]!;
      out[col * 4 + row] = sum;
    }
  return out;
}

/** Newell's normal of a polygon, unit length. */
function faceNormal(P: Float32Array, poly: readonly number[]): Vec3 {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]! * 3;
    const b = poly[(i + 1) % poly.length]! * 3;
    nx += (P[a + 1]! - P[b + 1]!) * (P[a + 2]! + P[b + 2]!);
    ny += (P[a + 2]! - P[b + 2]!) * (P[a]! + P[b]!);
    nz += (P[a]! - P[b]!) * (P[a + 1]! + P[b + 1]!);
  }
  const len = Math.hypot(nx, ny, nz);
  return len > 1e-30 ? [nx / len, ny / len, nz / len] : [0, 0, 0];
}

function carry(data: MeshData, uvs: number[][][]): MeshData {
  const out: MeshData = {
    positions: Float32Array.from(data.positions),
    polys: data.polys.map((p) => [...p]),
    uvs,
  };
  if (data.creases) out.creases = new Map(data.creases);
  if (data.seams) out.seams = new Set(data.seams);
  if (data.sharp && data.sharp.size > 0) out.sharp = new Set(data.sharp);
  if (data.edges) out.edges = data.edges.map((e) => [...e]);
  if (data.colors) out.colors = data.colors.map((f) => f.map((c) => [...c]));
  if (data.normals) out.normals = data.normals.map((f) => f.map((c) => [...c]));
  return out;
}

/**
 * Project the mesh's UVs from one or more projector objects — Blender's
 * **UV Project** modifier with an empty (not a camera) in each slot.
 *
 * ```ts
 * uvProject(mesh, { projectors: [{}] });                       // down the z axis
 * uvProject(mesh, { projectors: [{ at: [0, 0, 2], scale: 2 }] });
 * uvProject(mesh, { projectors: [{}, { rotate: [0, Math.PI / 2, 0] }] });
 * ```
 *
 * The UVs it writes replace whatever was there; a mesh with no UV layer gets
 * one. With several projectors each face takes the one whose **+z** axis most
 * agrees with its normal, ties going to the earlier projector — see the note
 * at the top of this file, where that detail cost a probe.
 */
export function uvProject(data: MeshData, options: UVProjectOptions): MeshData {
  if (options.projectors.length === 0)
    throw new Error("uvProject: needs at least one projector");

  // Per projector: the matrix that takes a mesh point into UV space, and the
  // +z axis used for the per-face choice. Blender does not normalise that
  // axis, so a scaled projector weighs more — kept as it is.
  const prepared = options.projectors.map((t) => {
    const m = matrixOf(t);
    return { toUV: invert(m), axis: applyDir(m, [0, 0, 1]) };
  });

  const P = data.positions;
  const uvs = data.polys.map((poly) => {
    let best = 0;
    if (prepared.length > 1) {
      const n = faceNormal(P, poly);
      let bestDot = prepared[0]!.axis[0] * n[0] + prepared[0]!.axis[1] * n[1] +
        prepared[0]!.axis[2] * n[2];
      for (let i = 1; i < prepared.length; i++) {
        const a = prepared[i]!.axis;
        const dot = a[0] * n[0] + a[1] * n[1] + a[2] * n[2];
        // Strictly greater, so a tie keeps the earlier projector.
        if (dot > bestDot) {
          bestDot = dot;
          best = i;
        }
      }
    }
    const m = prepared[best]!.toUV;
    return poly.map((v) => {
      const p = applyPoint(m, [P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!]);
      return [p[0] * 0.5 + 0.5, p[1] * 0.5 + 0.5];
    });
  });
  return carry(data, uvs);
}

/**
 * Move, turn and scale the UVs that are already there — Blender's **UV Warp**
 * modifier.
 *
 * ```ts
 * uvWarp(mesh, { offset: [0.25, 0] });
 * uvWarp(mesh, { rotation: Math.PI / 2 });            // about (0.5, 0.5)
 * uvWarp(mesh, { from: {}, to: { at: [0.25, 0, 0] } });
 * ```
 *
 * The composition order is measured, not assumed — see the note at the top of
 * this file. A mesh with no UV layer comes back unchanged, because there is
 * nothing to warp.
 */
export function uvWarp(data: MeshData, options: UVWarpOptions = {}): MeshData {
  // Nothing to warp. Blender's modifier bails the same way when the mesh has
  // no UV layer — there is no layer for it to create, only one to transform.
  if (!data.uvs) {
    const out = carry(data, []);
    delete out.uvs;
    return out;
  }

  const [cu, cv] = options.center ?? [0.5, 0.5];
  const [ou, ov] = options.offset ?? [0, 0];
  const [su, sv] = options.scale ?? [1, 1];
  const rot = options.rotation ?? 0;
  const iu = AXIS[options.axisU ?? "x"];
  const iv = AXIS[options.axisV ?? "y"];
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);

  // The object pair, or nothing. Blender needs both; with one it does nothing.
  const pair =
    options.from !== undefined && options.to !== undefined
      ? multiply(invert(matrixOf(options.to)), matrixOf(options.from))
      : null;

  const uvs = data.uvs.map((face) =>
    face.map((corner) => {
      // Offset first, then about the centre: rotate, then scale.
      let du = corner[0]! + ou - cu;
      let dv = corner[1]! + ov - cv;
      const ru = du * cos - dv * sin;
      const rv = du * sin + dv * cos;
      du = ru * su;
      dv = rv * sv;
      if (pair) {
        const p: Vec3 = [0, 0, 0];
        p[iu] = du;
        p[iv] = dv;
        const q = applyPoint(pair, p);
        du = q[iu];
        dv = q[iv];
      }
      return [du + cu, dv + cv];
    }),
  );
  return carry(data, uvs);
}

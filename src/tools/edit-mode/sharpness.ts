/**
 * Mark the edges a shade should break across — Blender's
 * `bpy.ops.mesh.set_sharpness_by_angle(angle=, extend=)`.
 *
 * The flag itself is `MeshData.sharp`, added with this operator: a set of
 * edges, keyed the way `seams` and `creases` are keyed. It is not a crease —
 * a crease is Catmull-Clark's per-edge weighting, this is shading.
 *
 * ## The rule, measured
 *
 * Blender 5.1.1, `probe-sharpness.py` and `probe-sharpness2.py`. Five
 * questions, five answers, and two of them needed a second pass because the
 * first case could not see them:
 *
 * - **an edge is sharp when the angle between its two faces is at least the
 *   limit.** Hinged quads at 10, 30, 45, 60, 90 and 120 degrees, asked one
 *   degree either side of their own measured angle, and then swept in
 *   thousandths: an edge measuring 44.999996 degrees is sharp at a limit of
 *   44.999996 and not at 45.000996. Exact equality is therefore decided by
 *   float noise, like everything else in this project that compares two
 *   measured angles; nothing here depends on which way it falls.
 * - **`extend` defaults to false, and false *clears*.** A selected edge under
 *   the limit loses a flag it already had. With `extend: true` it keeps it.
 *   Measured on a strip whose two folds are 60 and 10 degrees, with the
 *   shallow one marked by hand and a limit of 30: `false` leaves only the
 *   steep fold, `true` leaves both. **The first probe missed this** because
 *   the edge it marked by hand was a boundary edge.
 * - **boundary edges are never marked** — one face, no angle — **and are
 *   never cleared either.** A hand-marked boundary edge survives `extend:
 *   false`.
 * - **wire edges are never marked.**
 * - **only the given edges are considered**, and the rest keep whatever they
 *   had. Selecting only a boundary edge of a 90-degree fold marks nothing.
 */
import type { MeshData } from "../../lib/mesh";

export interface SetSharpnessByAngleOptions {
  /** The limit, in radians. Blender's default is 30 degrees. */
  angle?: number;
  /**
   * Keep flags the angle rule does not set. **Blender's default is `false`,
   * which clears** — a selected edge under the limit loses its flag.
   */
  extend?: boolean;
  /**
   * Which edges to consider, keyed `"minVertex_maxVertex"`. Left out, every
   * edge of every face — which is `select_all` before the operator.
   */
  edges?: ReadonlySet<string>;
}

const key = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);

type Vec3 = [number, number, number];

/** Newell's normal, unit length, for any polygon. */
function faceNormal(positions: Float32Array, poly: readonly number[]): Vec3 {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]! * 3;
    const b = poly[(i + 1) % poly.length]! * 3;
    nx += (positions[a + 1]! - positions[b + 1]!) * (positions[a + 2]! + positions[b + 2]!);
    ny += (positions[a + 2]! - positions[b + 2]!) * (positions[a]! + positions[b]!);
    nz += (positions[a]! - positions[b]!) * (positions[a + 1]! + positions[b + 1]!);
  }
  const len = Math.hypot(nx, ny, nz);
  return len > 1e-30 ? [nx / len, ny / len, nz / len] : [0, 0, 0];
}

/**
 * Mark as sharp every edge whose two faces meet at `angle` or more.
 *
 * ```ts
 * const shaded = setSharpnessByAngle(mesh);                    // 30 degrees
 * const keep = setSharpnessByAngle(mesh, { angle: 0.7, extend: true });
 * ```
 *
 * Moves nothing and changes no face — the answer is entirely in
 * `MeshData.sharp`.
 */
export function setSharpnessByAngle(
  data: MeshData,
  options: SetSharpnessByAngleOptions = {},
): MeshData {
  const limit = options.angle ?? (30 * Math.PI) / 180;
  const extend = options.extend ?? false;
  const P = data.positions;

  // The faces on each edge. Two is an interior edge, one a boundary, and
  // anything else is neither marked nor cleared.
  const faces = new Map<string, number[]>();
  for (const [f, poly] of data.polys.entries())
    for (let i = 0; i < poly.length; i++) {
      const k = key(poly[i]!, poly[(i + 1) % poly.length]!);
      const list = faces.get(k);
      if (list) list.push(f);
      else faces.set(k, [f]);
    }

  const normals = data.polys.map((poly) => faceNormal(P, poly));
  const sharp = new Set(data.sharp ?? []);

  for (const [k, on] of faces) {
    if (options.edges && !options.edges.has(k)) continue;
    if (on.length !== 2) continue; // boundary or worse: left exactly as it was
    const a = normals[on[0]!]!;
    const b = normals[on[1]!]!;
    const cos = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
    if (Math.acos(cos) >= limit) sharp.add(k);
    else if (!extend) sharp.delete(k);
  }

  const out: MeshData = {
    positions: Float32Array.from(P),
    polys: data.polys.map((p) => [...p]),
  };
  if (sharp.size > 0) out.sharp = sharp;
  // **Marking an edge sharp materialises the corner normals**, which is not
  // something this operator's name suggests and was not in the first
  // measurement of it: the `set-sharpness` parity row went from 3/3 to 0/3
  // the day the harness learned to carry `vn`, reading `normals 0/24` —
  // Blender's mesh had the layer and this one did not.
  //
  // What is in it is the **face normal at every corner**, measured on a bent
  // fan at three limits and agreeing to 0.0000 degrees each time
  // (`probe-sharpness3.py`). The shading on a mesh with no per-face smooth
  // flag is the face normal, and the layer freezes exactly that.
  //
  // And it is **not** created when nothing ends up sharp: at a limit of 179
  // degrees, with no edge marked, `has_custom_normals` stays false. That is
  // the condition used here; the case of a mesh that already had sharp edges
  // and gains none is not measured.
  if (sharp.size > 0)
    out.normals = data.polys.map((poly) => {
      const n = faceNormal(P, poly);
      return poly.map(() => [...n]);
    });
  if (data.normals && sharp.size === 0) out.normals = data.normals.map((f) => f.map((c) => [...c]));
  if (data.creases) out.creases = new Map(data.creases);
  if (data.seams) out.seams = new Set(data.seams);
  if (data.edges) out.edges = data.edges.map((e) => [...e]);
  if (data.uvs) out.uvs = data.uvs.map((f) => f.map((c) => [...c]));
  if (data.colors) out.colors = data.colors.map((f) => f.map((c) => [...c]));
  return out;
}

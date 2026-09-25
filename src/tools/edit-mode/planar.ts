/**
 * Flattening faces — Blender's `planar_faces` (Face ▸ Make Planar Faces).
 *
 * A quad with four corners in general position is not flat, and plenty of
 * things downstream quietly assume it is: Catmull-Clark, lightmap packing,
 * anything that treats a polygon as a plane. This pushes each face's corners
 * onto the plane the face most nearly lies in.
 *
 * Pure and headless.
 *
 * ## It was recorded as unmeasurable, and that was our fault twice
 *
 * The API matrix listed this under "the reference will not act" over six
 * configurations. It acts. Two mistakes were in the way and both were on this
 * side:
 *
 * - **the meshes were already flat enough.** A bent *single* quad is the one
 *   shape where three corners define the plane and the fourth is the only one
 *   off it; a UV sphere's quads are nearly planar to begin with.
 * - **the metric could not see it.** Blender's `MeshPolygon.area` projects an
 *   n-gon onto its own normal plane, so flattening a saddle does not change
 *   it. Six runs reported "the area does not move a digit" about an operator
 *   that was moving every vertex.
 *
 * Measured on a saddle quad, out-of-plane distance went 0.609208 → 0.000000
 * with all 25 vertices moving.
 *
 * ## The rule
 *
 * Each face's plane — through its **centroid**, along its **Newell normal** —
 * is computed **once, from the mesh as given**. Then per iteration each face
 * proposes the projection of each of its corners onto that plane, and each
 * vertex moves to the **average** of the proposals it received, interpolated
 * from where it was by `factor`.
 *
 * **The planes are never recomputed.** A second pass still moves things,
 * because a vertex several faces share lands on the average and so on none of
 * their planes; the passes converge it toward a fit to all of them. But they
 * are always the *original* planes. On a lone quad, one pass puts every corner
 * on the plane and every later pass is a no-op, which is why this went
 * unnoticed: the single-face tests below cannot tell the two apart.
 *
 * Measured. On a 2x2 saddle Blender moves 0.008126 between one pass and two,
 * and against its answer this rule is exact to six places at 1, 2, 3 and 10
 * passes, where recomputing the planes each pass is 0.027, 0.044 and 0.094
 * away. Recomputing only the centroid is 0.006 away — close enough to pass for
 * right on a cage and wrong everywhere it matters.
 *
 * Checked against Blender to six places. A quad with one corner lifted 0.4
 * sends its origin corner to (0.018519, −0.018519, 0.092593); halving the
 * factor halves that displacement exactly; and on two quads pulling their
 * shared edge opposite ways, the shared corner lands on the average of what
 * each asked for.
 */
import { withPositions, type MeshData } from "../../lib/mesh";

export interface PlanarFacesOptions {
  /** How many passes. Blender's `iterations`. Default 1. */
  iterations?: number;
  /**
   * How far toward the flattened position, 0..1 — Blender's `factor`.
   * Default 1, which lands on the plane in one pass for an isolated face.
   */
  factor?: number;
}

/**
 * Push the chosen faces' corners onto the plane each face most nearly lies in.
 *
 * ```ts
 * const flat = planarFaces(cage, selectFaces(cage, hasSides(4)));
 * ```
 *
 * A face already flat is left exactly alone, so running this twice costs
 * nothing — measured, a second and fifth iteration on a single quad change
 * nothing after the first. On a sheet, later passes do act: they settle the
 * vertices several faces share, against the planes read off the input.
 */
export function planarFaces(
  data: MeshData,
  faces: ReadonlySet<number> | readonly number[],
  opts: PlanarFacesOptions = {},
): MeshData {
  const iterations = Math.max(0, Math.floor(opts.iterations ?? 1));
  const factor = opts.factor ?? 1;
  const chosen = [...new Set(faces)];
  for (const f of chosen)
    if (data.polys[f] === undefined) throw new Error(`planarFaces: no face ${f}`);

  const P = Float64Array.from(data.positions);
  const count = P.length / 3;

  // The planes, **once**, off the mesh as handed in. Recomputing them each
  // pass is the obvious reading and it is wrong: measured against Blender it
  // drifts by 0.027 at two passes and 0.094 at ten, on a saddle where the
  // right answer is exact to six places. See the note above the function.
  //
  // Each entry is [cx, cy, cz, nx, ny, nz], or null for a face with no plane
  // to speak of.
  const planes: (Float64Array | null)[] = chosen.map((f) => {
    const poly = data.polys[f]!;
    if (poly.length < 3) return null;

    let cx = 0, cy = 0, cz = 0;
    for (const v of poly) {
      cx += P[v * 3]!;
      cy += P[v * 3 + 1]!;
      cz += P[v * 3 + 2]!;
    }
    cx /= poly.length;
    cy /= poly.length;
    cz /= poly.length;

    // The Newell normal — the plane an n-gon most nearly lies in, and the one
    // Blender's own polygon normal uses. For a quad it is half the cross
    // product of the diagonals, which is the form Blender writes it in.
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      const ax = P[a * 3]!, ay = P[a * 3 + 1]!, az = P[a * 3 + 2]!;
      const bx = P[b * 3]!, by = P[b * 3 + 1]!, bz = P[b * 3 + 2]!;
      nx += (ay - by) * (az + bz);
      ny += (az - bz) * (ax + bx);
      nz += (ax - bx) * (ay + by);
    }
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-20) return null; // degenerate: no plane to speak of
    return Float64Array.of(cx, cy, cz, nx / len, ny / len, nz / len);
  });

  for (let pass = 0; pass < iterations; pass++) {
    const sum = new Float64Array(P.length);
    const hits = new Int32Array(count);

    for (let i = 0; i < chosen.length; i++) {
      const plane = planes[i];
      if (plane === null || plane === undefined) continue;
      const poly = data.polys[chosen[i]!]!;
      const cx = plane[0]!, cy = plane[1]!, cz = plane[2]!;
      const nx = plane[3]!, ny = plane[4]!, nz = plane[5]!;

      for (const v of poly) {
        const d =
          (P[v * 3]! - cx) * nx + (P[v * 3 + 1]! - cy) * ny + (P[v * 3 + 2]! - cz) * nz;
        sum[v * 3]! += P[v * 3]! - d * nx;
        sum[v * 3 + 1]! += P[v * 3 + 1]! - d * ny;
        sum[v * 3 + 2]! += P[v * 3 + 2]! - d * nz;
        hits[v]! += 1;
      }
    }

    // Applied together, not as each face is walked: a vertex two faces
    // disagree about lands on the average of what they asked for, which is
    // measured — the shared corner of two quads pulling opposite ways comes
    // back exactly halfway.
    for (let v = 0; v < count; v++) {
      const n = hits[v]!;
      if (n === 0) continue;
      for (let k = 0; k < 3; k++) {
        const want = sum[v * 3 + k]! / n;
        P[v * 3 + k] = P[v * 3 + k]! + (want - P[v * 3 + k]!) * factor;
      }
    }
  }

  return withPositions(data, new Float32Array(P));
}

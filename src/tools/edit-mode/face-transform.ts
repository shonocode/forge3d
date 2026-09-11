/**
 * Moving a face selection — the half of extrude that the editor gets from the
 * mouse.
 *
 * `extrudeFaces` duplicates the selection and stitches a skirt, then stops:
 * the new cap sits exactly on top of the old one and the user drags a gizmo to
 * pull it out. That works in the viewport and is useless from a build script,
 * where there is no drag — call `extrudeFaces` alone and nothing appears to
 * happen.
 *
 * These close the gap. {@link extrudeFacesBy} is the one most code wants: an
 * extrusion with a distance, the way it reads in a modelling instruction
 * ("inset 40mm, push back 6mm").
 *
 * ```ts
 * const em = meshFromData(box({ size: [0.44, 0.66, 0.019] }));
 * const front = facesFacing(em, [0, 0, 1])          // the door front
 * const field = insetFaces(em, front, 0.055);       // rails and stiles
 * offsetFaces(em, field, -0.006);                   // recess the panel
 * ```
 *
 * Pure and headless — Vitest-pinned.
 */
import { faceVerts, facePolyNormal, type EditMesh } from "./half-edge";
import { extrudeFaces, insetFaces } from "./operators";

/** Every distinct vertex used by the given faces. */
function vertsOf(em: EditMesh, faces: ReadonlySet<number>): Set<number> {
  const out = new Set<number>();
  for (const f of faces) for (const v of faceVerts(em, f)) out.add(v);
  return out;
}

/** Translate every vertex of `faces` by a vector. Shared vertices move once. */
export function moveFaces(
  em: EditMesh,
  faces: ReadonlySet<number>,
  dx: number,
  dy: number,
  dz: number,
): void {
  for (const v of vertsOf(em, faces)) {
    em.positions[v * 3] = em.positions[v * 3]! + dx;
    em.positions[v * 3 + 1] = em.positions[v * 3 + 1]! + dy;
    em.positions[v * 3 + 2] = em.positions[v * 3 + 2]! + dz;
  }
}

/**
 * Area-weighted average normal of a face selection.
 *
 * Weighting by area is what makes this usable on a selection that mixes a
 * large flat field with the slivers around it — an unweighted mean lets a
 * dozen tiny faces outvote the one that defines the direction.
 */
export function averageNormal(em: EditMesh, faces: ReadonlySet<number>): [number, number, number] {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (const f of faces) {
    // facePolyNormal returns Newell's normal normalised; recover the area
    // weight from the polygon itself.
    const n = facePolyNormal(em, f);
    const verts = faceVerts(em, f);
    let ax = 0;
    let ay = 0;
    let az = 0;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i]!;
      const b = verts[(i + 1) % verts.length]!;
      const x1 = em.positions[a * 3]!, y1 = em.positions[a * 3 + 1]!, z1 = em.positions[a * 3 + 2]!;
      const x2 = em.positions[b * 3]!, y2 = em.positions[b * 3 + 1]!, z2 = em.positions[b * 3 + 2]!;
      ax += y1 * z2 - z1 * y2;
      ay += z1 * x2 - x1 * z2;
      az += x1 * y2 - y1 * x2;
    }
    const area = Math.hypot(ax, ay, az) / 2;
    nx += n[0] * area;
    ny += n[1] * area;
    nz += n[2] * area;
  }
  const len = Math.hypot(nx, ny, nz);
  return len < 1e-12 ? [0, 0, 0] : [nx / len, ny / len, nz / len];
}

/**
 * Slide a face selection along its own normal.
 *
 * Negative pushes in — a recessed panel, a sunken worktop drainer. The whole
 * selection moves as one rigid piece along one averaged direction, so a ring
 * of coplanar faces stays coplanar.
 */
export function offsetFaces(em: EditMesh, faces: ReadonlySet<number>, distance: number): void {
  if (faces.size === 0 || distance === 0) return;
  const n = averageNormal(em, faces);
  moveFaces(em, faces, n[0] * distance, n[1] * distance, n[2] * distance);
}

/**
 * Scale a face selection about its own centre.
 *
 * The companion to {@link offsetFaces}: that one pushes a cap out, this one
 * tapers it. Together they turn a bare `extrudeFaces` into a limb segment —
 * push along the normal, narrow towards the tip — which is the shape of every
 * arm, leg and finger grown out of a body cage.
 */
export function scaleFaces(em: EditMesh, faces: ReadonlySet<number>, factor: number): void {
  const verts = vertsOf(em, faces);
  if (verts.size === 0 || factor === 1) return;

  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const v of verts) {
    cx += em.positions[v * 3]!;
    cy += em.positions[v * 3 + 1]!;
    cz += em.positions[v * 3 + 2]!;
  }
  cx /= verts.size;
  cy /= verts.size;
  cz /= verts.size;

  for (const v of verts) {
    em.positions[v * 3] = cx + (em.positions[v * 3]! - cx) * factor;
    em.positions[v * 3 + 1] = cy + (em.positions[v * 3 + 1]! - cy) * factor;
    em.positions[v * 3 + 2] = cz + (em.positions[v * 3 + 2]! - cz) * factor;
  }
}

/**
 * Faces whose normal points within `tolerance` radians of `direction`.
 *
 * Code has no click to select with. This is the usual substitute: "the front
 * of the door", "the top of the worktop". For anything that has to combine
 * with another condition — direction *and* height, say — reach for the
 * composable `facing` predicate in `tools/select` instead.
 */
export function facesFacing(
  em: EditMesh,
  direction: readonly [number, number, number],
  tolerance = 0.3,
): Set<number> {
  const len = Math.hypot(direction[0], direction[1], direction[2]);
  const d: [number, number, number] = [direction[0] / len, direction[1] / len, direction[2] / len];
  // Nudge the threshold outward. `Math.cos(Math.PI / 2)` is 6.1e-17 rather
  // than 0, so a face at exactly 90 degrees — every side of a box, relative to
  // its top — would fail a bare comparison. Asking for a right-angle tolerance
  // and not getting the perpendicular faces is a trap, not a nicety.
  const limit = Math.cos(tolerance) - 1e-9;
  const out = new Set<number>();
  for (let f = 0; f < em.faces.length; f++) {
    const n = facePolyNormal(em, f);
    if (n[0] * d[0] + n[1] * d[1] + n[2] * d[2] >= limit) out.add(f);
  }
  return out;
}

/**
 * Inset by a constant border width, in world units.
 *
 * `insetFaces` takes a fraction of the way to the centroid, which is the right
 * control under a mouse — drag further, inset more — but it scales with the
 * face. On a 440 x 660 cabinet door, one fraction gives a 24mm stile and a
 * 36mm rail. Real millwork has one width all the way round, so code that is
 * working from dimensions needs the border, not the ratio.
 *
 * Each vertex slides along its angle bisector far enough that the perpendicular
 * distance to both of its edges is exactly `width`, which is what a mitred
 * frame does. Planar convex faces (every panel, every worktop) are exact; a
 * concave face insets correctly until the offset would cross itself.
 *
 * Returns the new inner cap faces, like `insetFaces`.
 */
export function insetFacesByWidth(
  em: EditMesh,
  faces: ReadonlySet<number>,
  width: number,
): Set<number> {
  if (faces.size === 0 || width <= 0) return new Set(faces);

  // Work out every vertex's target before touching the mesh: insetFaces
  // rebuilds the polygon list, so face ids taken afterwards would be stale.
  const caps = insetFaces(em, faces, 1e-6);

  for (const f of caps) {
    const verts = faceVerts(em, f);
    const n = facePolyNormal(em, f);
    const moved: [number, number, number][] = [];

    for (let i = 0; i < verts.length; i++) {
      const prev = verts[(i - 1 + verts.length) % verts.length]!;
      const cur = verts[i]!;
      const next = verts[(i + 1) % verts.length]!;

      const e1 = unit([
        em.positions[cur * 3]! - em.positions[prev * 3]!,
        em.positions[cur * 3 + 1]! - em.positions[prev * 3 + 1]!,
        em.positions[cur * 3 + 2]! - em.positions[prev * 3 + 2]!,
      ]);
      const e2 = unit([
        em.positions[next * 3]! - em.positions[cur * 3]!,
        em.positions[next * 3 + 1]! - em.positions[cur * 3 + 1]!,
        em.positions[next * 3 + 2]! - em.positions[cur * 3 + 2]!,
      ]);

      // Inward edge normals, in the face plane.
      const m1 = unit(cross(n, e1));
      const m2 = unit(cross(n, e2));
      const b = unit([m1[0] + m2[0], m1[1] + m2[1], m1[2] + m2[2]]);
      // 1 / cos(half angle) — clamped, or a near-straight corner runs away.
      const reach = width / Math.max(0.2, b[0] * m1[0] + b[1] * m1[1] + b[2] * m1[2]);

      moved.push([
        em.positions[cur * 3]! + b[0] * reach,
        em.positions[cur * 3 + 1]! + b[1] * reach,
        em.positions[cur * 3 + 2]! + b[2] * reach,
      ]);
    }

    verts.forEach((v, i) => {
      const p = moved[i]!;
      em.positions[v * 3] = p[0];
      em.positions[v * 3 + 1] = p[1];
      em.positions[v * 3 + 2] = p[2];
    });
  }

  return caps;
}

const unit = (v: [number, number, number]): [number, number, number] => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l < 1e-12 ? [0, 0, 0] : [v[0] / l, v[1] / l, v[2] / l];
};

const cross = (
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): [number, number, number] => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/**
 * Extrude a face selection by a distance, in one call.
 *
 * Returns the new cap faces, so extrusions chain:
 * `extrudeFacesBy(em, extrudeFacesBy(em, top, 0.2), 0.1)`.
 */
export function extrudeFacesBy(
  em: EditMesh,
  faces: ReadonlySet<number>,
  distance: number,
): Set<number> {
  const caps = extrudeFaces(em, faces);
  offsetFaces(em, caps, distance);
  return caps;
}

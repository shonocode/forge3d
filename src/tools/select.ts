/**
 * Declarative face selection.
 *
 * The Edit Mode operators take a `Set<faceIndex>`, which is the natural shape
 * when a person is clicking faces in a viewport. From a build script it is the
 * wrong end of the problem: the caller knows *what* it wants ("the side of the
 * torso, level with the shoulder, facing right") and has no idea which integers
 * that is. Working it out by hand — walking `toPolygons`, averaging positions,
 * comparing normals — is the same twenty lines every time.
 *
 * These turn that description into the set. Predicates compose, so a selection
 * reads close to the sentence that motivated it:
 *
 * ```ts
 * const shoulder = selectFaces(em, and(
 *   facing([1, 0, 0], 50),
 *   centroidWhere((p) => p[1] > 0.28 && p[1] < 0.36),
 * ));
 * extrudeFacesBy(em, shoulder, 0.12);
 * ```
 *
 * Selection only. Once you have the set, `edit-mode/face-transform` moves it —
 * `extrudeFacesBy`, `offsetFaces`, `scaleFaces`.
 *
 * Pure and headless — no scene, no picking, no selection state.
 */
import type { EditMesh } from "./edit-mode/half-edge";
import { faceVerts, facePolyNormal } from "./edit-mode/half-edge";

export type Vec3 = readonly [number, number, number];

/** A test applied to one face. */
export type FacePredicate = (em: EditMesh, face: number) => boolean;

/** Average of a face's vertex positions. */
export function faceCentroid(em: EditMesh, face: number): Vec3 {
  const verts = faceVerts(em, face);
  let x = 0, y = 0, z = 0;
  for (const v of verts) {
    x += em.positions[v * 3]!;
    y += em.positions[v * 3 + 1]!;
    z += em.positions[v * 3 + 2]!;
  }
  const n = verts.length || 1;
  return [x / n, y / n, z / n];
}

/** Unit face normal. Zero-area faces come back as `[0, 0, 0]`. */
export function faceNormal(em: EditMesh, face: number): Vec3 {
  const [x, y, z] = facePolyNormal(em, face);
  const len = Math.hypot(x, y, z);
  return len === 0 ? [0, 0, 0] : [x / len, y / len, z / len];
}

/** Every face passing `predicate`. */
export function selectFaces(em: EditMesh, predicate: FacePredicate): Set<number> {
  const out = new Set<number>();
  for (let f = 0; f < em.faces.length; f++) {
    if (predicate(em, f)) out.add(f);
  }
  return out;
}

/**
 * Faces whose normal points within `withinDegrees` of `direction`.
 *
 * The workhorse: "the outward side", "the top", "everything facing the camera".
 */
export function facing(direction: Vec3, withinDegrees = 45): FacePredicate {
  const len = Math.hypot(...direction) || 1;
  const dx = direction[0] / len, dy = direction[1] / len, dz = direction[2] / len;
  // Nudge the threshold outward. `Math.cos(Math.PI / 2)` is 6.1e-17 rather
  // than 0, so a face at exactly 90 degrees — every side of a box, relative to
  // its top — fails a bare comparison. Asking for "within 90 degrees" and not
  // getting the perpendicular faces is a trap, not a nicety.
  const limit = Math.cos((withinDegrees * Math.PI) / 180) - 1e-9;

  return (em, face) => {
    const n = faceNormal(em, face);
    return n[0] * dx + n[1] * dy + n[2] * dz >= limit;
  };
}

/** Faces whose centroid satisfies an arbitrary test. */
export function centroidWhere(test: (p: Vec3) => boolean): FacePredicate {
  return (em, face) => test(faceCentroid(em, face));
}

/**
 * Faces whose centroid sits inside an axis-aligned box.
 *
 * `null` on a bound means "unconstrained on that axis", which is what most
 * real selections want — a height band across the whole mesh, say.
 */
export function withinBounds(
  min: readonly (number | null)[],
  max: readonly (number | null)[],
): FacePredicate {
  return centroidWhere((p) => {
    for (let i = 0; i < 3; i++) {
      const lo = min[i];
      const hi = max[i];
      if (lo != null && p[i]! < lo) return false;
      if (hi != null && p[i]! > hi) return false;
    }
    return true;
  });
}

/** Faces with `sides` vertices — quads, triangles, n-gons. */
export function hasSides(sides: number): FacePredicate {
  return (em, face) => faceVerts(em, face).length === sides;
}

export function and(...predicates: FacePredicate[]): FacePredicate {
  return (em, face) => predicates.every((p) => p(em, face));
}

export function or(...predicates: FacePredicate[]): FacePredicate {
  return (em, face) => predicates.some((p) => p(em, face));
}

export function not(predicate: FacePredicate): FacePredicate {
  return (em, face) => !predicate(em, face);
}

/**
 * The `count` faces closest to `point`, nearest first.
 *
 * Ranking, so it cannot be a predicate — but it is how you say "grow a limb
 * from about here" without knowing the topology.
 */
export function nearestFaces(
  em: EditMesh,
  point: Vec3,
  count = 1,
  predicate?: FacePredicate,
): number[] {
  const scored: { face: number; d2: number }[] = [];

  for (let f = 0; f < em.faces.length; f++) {
    if (predicate && !predicate(em, f)) continue;
    const c = faceCentroid(em, f);
    const dx = c[0] - point[0], dy = c[1] - point[1], dz = c[2] - point[2];
    scored.push({ face: f, d2: dx * dx + dy * dy + dz * dz });
  }

  scored.sort((a, b) => a.d2 - b.d2);
  return scored.slice(0, count).map((s) => s.face);
}

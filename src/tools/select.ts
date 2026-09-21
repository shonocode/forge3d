/**
 * Declarative selection — faces, and the edges at the bottom of the file.
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
 * Edges work the same way, except that the selection a modeller usually wants
 * is a *walk* rather than a predicate — "the loop around the rim", not "every
 * edge at this height". `nearestEdges` here names the one edge to start from
 * and `edit-mode/edge-walk` does the walking.
 *
 * Pure and headless — no scene, no picking, no selection state.
 */
import type { MeshData } from "../lib/mesh";
import type { EditMesh } from "./edit-mode/half-edge";
import {
  faceVerts,
  facePolyNormal,
  canonicalEdge,
  edgeEnd,
  edgeOrigin,
  forEachEdge,
} from "./edit-mode/half-edge";

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

// ── Edges ──────────────────────────────────────────────────────────────────

/** A test applied to one edge, identified by its canonical half-edge index. */
export type EdgePredicate = (em: EditMesh, edge: number) => boolean;

/** Midpoint of an edge's two vertices. */
export function edgeMidpoint(em: EditMesh, edge: number): Vec3 {
  const a = edgeOrigin(em, edge);
  const b = edgeEnd(em, edge);
  return [
    (em.positions[a * 3]! + em.positions[b * 3]!) / 2,
    (em.positions[a * 3 + 1]! + em.positions[b * 3 + 1]!) / 2,
    (em.positions[a * 3 + 2]! + em.positions[b * 3 + 2]!) / 2,
  ];
}

/**
 * Edges running within `withinDegrees` of `direction`, either way along it.
 *
 * The edge answer to `facing`, and the one that makes "click here" work on a
 * rim: at the lip of a bowl the nearest edge to any point near the rim is the
 * little one crossing the wall thickness, not the one running round. They
 * point in different directions, which is the only thing that separates them.
 */
export function edgeAlong(direction: Vec3, withinDegrees = 45): EdgePredicate {
  const len = Math.hypot(...direction) || 1;
  const dx = direction[0] / len, dy = direction[1] / len, dz = direction[2] / len;
  const limit = Math.cos((withinDegrees * Math.PI) / 180) - 1e-9;

  return (em, edge) => {
    const a = edgeOrigin(em, edge);
    const b = edgeEnd(em, edge);
    const ex = em.positions[b * 3]! - em.positions[a * 3]!;
    const ey = em.positions[b * 3 + 1]! - em.positions[a * 3 + 1]!;
    const ez = em.positions[b * 3 + 2]! - em.positions[a * 3 + 2]!;
    const elen = Math.hypot(ex, ey, ez);
    if (elen === 0) return false;
    // Unsigned: an edge has no direction of travel, only an axis.
    return Math.abs((ex * dx + ey * dy + ez * dz) / elen) >= limit;
  };
}

/** Every edge passing `predicate`, as canonical edge ids. */
export function selectEdges(em: EditMesh, predicate: EdgePredicate): Set<number> {
  const out = new Set<number>();
  forEachEdge(em, (he) => {
    const edge = canonicalEdge(em, he);
    if (predicate(em, edge)) out.add(edge);
  });
  return out;
}

/**
 * The `count` edges closest to `point`, nearest first.
 *
 * This is the missing half of `selectEdgeLoop`: a loop is named by one edge on
 * it, and in the editor that edge comes from a click. From code the nearest
 * thing to a click is a position — "the rim, out at the front" — and picking
 * by coordinate comparison instead is how `brazier/brazier.ts` ended up with a
 * rim selector that only works on shapes with exactly one ring at that height.
 */
export function nearestEdges(
  em: EditMesh,
  point: Vec3,
  count = 1,
  predicate?: EdgePredicate,
): number[] {
  const scored: { edge: number; d2: number }[] = [];
  forEachEdge(em, (he) => {
    const edge = canonicalEdge(em, he);
    if (predicate && !predicate(em, edge)) return;
    const m = edgeMidpoint(em, edge);
    const dx = m[0] - point[0], dy = m[1] - point[1], dz = m[2] - point[2];
    scored.push({ edge, d2: dx * dx + dy * dy + dz * dz });
  });

  scored.sort((a, b) => a.d2 - b.d2);
  return scored.slice(0, count).map((s) => s.edge);
}

export interface RegionExtendOptions {
  /**
   * Shrink instead of grow — Blender's `use_contract`. Default false.
   *
   * Growing returns the faces **outside** the selection that touch it;
   * shrinking returns the faces **inside** it that touch something outside.
   * Either way the answer is the *change*, not the new selection.
   */
  contract?: boolean;
  /**
   * Count a face that shares only a **vertex** as adjacent — Blender's
   * `use_face_step`. Default false, which counts only faces sharing an edge.
   *
   * Measured on the shrinking side too, which needed a case built for it: a
   * 3×3 block of a grid with one corner left out. Its middle face is
   * surrounded on all four edges but touches the missing corner at a point,
   * and that is the only arrangement that tells the two adjacencies apart.
   * With `faceStep` the middle face is dropped; without it, it stays.
   */
  faceStep?: boolean;
}

/**
 * Grow or shrink a face selection by one step — Blender's
 * `bmesh.ops.region_extend`, the Select ▸ Grow/Shrink of the UI.
 *
 * ```ts
 * const top = selectFaces(mesh, facing([0, 1, 0]));
 * const ring = regionExtend(mesh, top);                       // the band around it
 * const rim = regionExtend(mesh, top, { contract: true });     // its own border
 * ```
 *
 * The rest of this module picks faces by **description** — which way they
 * face, where their centre is, how many sides they have — and that vocabulary
 * cannot say "these, plus the ones touching them", because that is defined by
 * the mesh rather than by space. This is the operator for it, and it is why
 * the API matrix's old note that forge3d "has a predicate vocabulary instead"
 * was an argument about style rather than a reason to leave a hole.
 *
 * **Returns what changed**, matching Blender: the faces that would join the
 * selection, or the ones that would leave it. Union or subtract for the new
 * selection.
 *
 * ## Measured
 *
 * On a 4×4 grid, face `r*4 + c`:
 *
 * | selection | grow | grow, `faceStep` | shrink |
 * |---|---|---|---|
 * | face 5 | 1, 4, 6, 9 | 0, 1, 2, 4, 6, 8, 9, 10 | 5 |
 * | face 0, a corner | 1, 4 | 1, 4, 5 | 0 |
 * | faces 5, 6, 9, 10 | 1, 2, 4, 7, 8, 11, 13, 14 | + 0, 3, 12, 15 | all four |
 * | the whole grid | nothing | — | **nothing** |
 *
 * The last row is the one worth knowing: **shrinking the whole grid removes
 * nothing.** "Border" means the border of the *selection*, not of the mesh, so
 * a selection with nothing outside it has no border to lose.
 */
export function regionExtend(
  mesh: MeshData,
  faces: ReadonlySet<number>,
  opts: RegionExtendOptions = {},
): Set<number> {
  const contract = opts.contract ?? false;
  const faceStep = opts.faceStep ?? false;

  const atVertex = new Map<number, number[]>();
  const atEdge = new Map<string, number[]>();
  const edgeKey = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);

  for (let f = 0; f < mesh.polys.length; f++) {
    const poly = mesh.polys[f]!;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      const vs = atVertex.get(a);
      if (vs) vs.push(f);
      else atVertex.set(a, [f]);
      const key = edgeKey(a, b);
      const es = atEdge.get(key);
      if (es) es.push(f);
      else atEdge.set(key, [f]);
    }
  }

  const neighbours = (f: number): Set<number> => {
    const poly = mesh.polys[f]!;
    const out = new Set<number>();
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      if (faceStep) {
        for (const g of atVertex.get(a) ?? []) if (g !== f) out.add(g);
      } else {
        const b = poly[(i + 1) % poly.length]!;
        for (const g of atEdge.get(edgeKey(a, b)) ?? []) if (g !== f) out.add(g);
      }
    }
    return out;
  };

  const changed = new Set<number>();
  for (let f = 0; f < mesh.polys.length; f++) {
    const inside = faces.has(f);
    // Growing walks the faces that are out and asks whether anything in
    // touches them; shrinking walks the ones that are in and asks the
    // opposite. Both come down to "a neighbour on the other side".
    if (inside !== contract) continue;
    for (const g of neighbours(f))
      if (faces.has(g) !== inside) {
        changed.add(f);
        break;
      }
  }
  return changed;
}

/**
 * Making one face out of a set of vertices — Blender's **F** key
 * (`mesh.edge_face_add`).
 *
 * The rest of `refine.ts`'s fills take a *loop* and close it. This takes an
 * unordered set and works the ring out, which is the part a build script
 * cannot do for itself: it knows which vertices it wants joined, not which
 * order they go round in.
 *
 * Pure and headless.
 *
 * ## What was measured, and what could not be
 *
 * Read off Blender 5.1.1 with `tools/modeling/parity/probe-face-add*.py`.
 * Four things came out clean:
 *
 * - **The ring is the angular order about the selection's centroid**, in the
 *   plane the selection lies in. Six of seven cases matched, and the seventh
 *   had a vertex sitting exactly *on* the centroid, where the angle is not a
 *   number. The order the vertices are handed over in does not change the
 *   answer — the same four corners picked `[0,2,6,8]` and `[8,0,6,2]` gave the
 *   same face.
 * - **It refuses when the face already exists.** Selecting the four corners of
 *   a quad that is already there returns `CANCELLED` and changes nothing.
 * - **Two vertices make a wire edge**, not a face. `MeshData` grew somewhere
 *   to put one on 2026-09-22, so {@link edgeFaceAdd} now does it — before that
 *   it threw rather than doing something else that looked similar.
 * - **When the new face touches existing faces, the winding is the manifold
 *   one** — each shared edge is traversed opposite to the face already using
 *   it. Filling the hole in an open cube comes back agreeing with the shell;
 *   an L across a grid comes back reversed, and reversed is the consistent
 *   direction there.
 *
 * One thing did not come out. **For a face with no neighbours at all, which
 * side it ends up facing is not readable from seven measurements.** Blender's
 * choice follows the Newell normal of the selection in index order for the
 * three cases where that normal is not degenerate, and four of the seven are
 * degenerate (any set picked in ascending index order off a grid is), where
 * neither "the first three vertices" nor "the positive dominant axis" fits
 * what came back. So the free-standing winding here is forge3d's own,
 * deterministic and documented below, and **there is no parity row for it** —
 * the row covers the attached case, which is the one with an answer.
 * {@link recalcFaceNormals} is the fix if a free-standing face lands facing
 * the wrong way.
 */
import {
  rebuildPolygons,
  toPolygons,
  type EditMesh,
} from "./half-edge";

/** `p - q`, three components at a time out of a flat array. */
function sub(P: Float32Array, p: number, c: readonly number[]): [number, number, number] {
  return [P[p * 3]! - c[0]!, P[p * 3 + 1]! - c[1]!, P[p * 3 + 2]! - c[2]!];
}

function cross(
  a: readonly number[],
  b: readonly number[],
): [number, number, number] {
  return [
    a[1]! * b[2]! - a[2]! * b[1]!,
    a[2]! * b[0]! - a[0]! * b[2]!,
    a[0]! * b[1]! - a[1]! * b[0]!,
  ];
}

const dot = (a: readonly number[], b: readonly number[]): number =>
  a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

/**
 * The ring through a set of vertices: their angular order about their own
 * centroid, in the plane they lie in.
 *
 * The plane comes from the **largest** cross product between two spokes out of
 * the centroid, taking the first such pair in ascending index order when
 * several tie. Largest because it is the pair least sensitive to a nearly
 * collinear selection; first-in-index-order because something has to break the
 * tie and a tie is the common case — four corners of a grid produce four pairs
 * of equal magnitude. That tiebreak is **forge3d's, not a reading of
 * Blender's**; it is what reproduces the measured cases, and the module note
 * says where that stops being enough.
 *
 * Throws when the selection is collinear, which has no ring at all.
 */
export function ringOf(positions: Float32Array, verts: ReadonlySet<number>): number[] {
  const picked = [...verts].sort((a, b) => a - b);
  const c: [number, number, number] = [0, 0, 0];
  for (const v of picked) {
    c[0] += positions[v * 3]!;
    c[1] += positions[v * 3 + 1]!;
    c[2] += positions[v * 3 + 2]!;
  }
  for (let i = 0; i < 3; i++) c[i] = c[i]! / picked.length;

  let n: [number, number, number] = [0, 0, 0];
  let best = 0;
  for (let i = 0; i < picked.length; i++)
    for (let j = i + 1; j < picked.length; j++) {
      const x = cross(sub(positions, picked[i]!, c), sub(positions, picked[j]!, c));
      const mag = dot(x, x);
      if (mag > best * (1 + 1e-9)) {
        best = mag;
        n = x;
      }
    }
  if (best <= 1e-24)
    throw new Error(
      "edgeFaceAdd: the selected vertices are collinear (or coincident), so " +
        "there is no ring through them and no face to make.",
    );

  const len = Math.sqrt(dot(n, n));
  for (let i = 0; i < 3; i++) n[i] = n[i]! / len;

  // Any in-plane axis will do for measuring angles from; the ring is a cycle,
  // so where it starts does not matter. The first vertex furthest from the
  // centroid is used because a spoke of length ~0 makes a useless basis.
  let seed = picked[0]!;
  let far = -1;
  for (const v of picked) {
    const d = dot(sub(positions, v, c), sub(positions, v, c));
    if (d > far * (1 + 1e-9)) {
      far = d;
      seed = v;
    }
  }
  const s = sub(positions, seed, c);
  const proj = dot(s, n);
  const u: [number, number, number] = [s[0] - proj * n[0]!, s[1] - proj * n[1]!, s[2] - proj * n[2]!];
  const ulen = Math.sqrt(dot(u, u));
  for (let i = 0; i < 3; i++) u[i] = u[i]! / ulen;
  const w = cross(n, u);

  const angle = new Map<number, number>();
  for (const v of picked) {
    const d = sub(positions, v, c);
    angle.set(v, Math.atan2(dot(d, w), dot(d, u)));
  }
  // Ascending angle about `n`, then reversed — Blender's free-standing faces
  // came back clockwise in every case that had a readable plane.
  return picked.sort((a, b) => angle.get(a)! - angle.get(b)!).reverse();
}

/**
 * Make one face from a set of vertices — Blender's F key.
 *
 * ```ts
 * const em = meshFromData({ positions, polys });
 * edgeFaceAdd(em, new Set([4, 5, 6, 7]));   // lid on an open box
 * ```
 *
 * Returns the index of the face it made, or `null` when a face with exactly
 * those vertices was already there — which is what Blender does, and is why
 * the return is not a `Set` like the operators that touch several faces.
 *
 * With exactly **two** vertices it adds a wire edge instead and returns null —
 * no face was made. It refuses when those two already have an edge between
 * them, measured: Blender returns `CANCELLED` and changes nothing.
 *
 * Throws on fewer than two vertices and on a collinear selection of three or
 * more.
 *
 * The winding follows the faces the new one touches. See the module note for
 * the case where it touches none, which is the one Blender's own answer could
 * not be read for.
 */
export function edgeFaceAdd(em: EditMesh, verts: ReadonlySet<number>): number | null {
  if (verts.size < 2)
    throw new Error(
      `edgeFaceAdd: ${verts.size} vertices. Blender needs two to make an edge ` +
        `and three to make a face.`,
    );

  const polys = toPolygons(em);

  // Two vertices make a wire edge, and **only when there is not already an
  // edge between them** — measured: two adjacent corners of a grid come back
  // `CANCELLED` and the mesh is untouched, two opposite ones come back with a
  // new loose edge. Returns null because no face was made, which is also what
  // `bmesh.ops.contextual_create` reports (its `faces` list comes back empty).
  if (verts.size === 2) {
    const [a, b] = [...verts];
    const key = (x: number, y: number): string => (x < y ? `${x}_${y}` : `${y}_${x}`);
    const want = key(a!, b!);
    for (const poly of polys)
      for (let i = 0; i < poly.length; i++)
        if (key(poly[i]!, poly[(i + 1) % poly.length]!) === want) return null;
    for (const e of em.wireEdges ?? []) if (key(e[0]!, e[1]!) === want) return null;
    em.wireEdges = [...(em.wireEdges ?? []), [a!, b!]];
    return null;
  }
  for (const poly of polys)
    if (poly.length === verts.size && poly.every((v) => verts.has(v))) return null;

  const ring = ringOf(em.positions, verts);

  // Every directed edge the existing faces use. A new face sharing one has to
  // run the other way down it, or the surface disagrees with itself there.
  const directed = new Set<string>();
  for (const poly of polys)
    for (let i = 0; i < poly.length; i++)
      directed.add(`${poly[i]}_${poly[(i + 1) % poly.length]}`);

  let agree = 0;
  let clash = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    if (directed.has(`${b}_${a}`)) agree++;
    if (directed.has(`${a}_${b}`)) clash++;
  }
  if (clash > agree) ring.reverse();

  polys.push(ring);
  rebuildPolygons(em, em.positions, polys);
  return polys.length - 1;
}

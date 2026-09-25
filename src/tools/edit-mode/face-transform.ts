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
import { faceVerts, facePolyNormal, rebuildPolygons, toPolygons, type EditMesh, type ExplicitFace, type VertexOrigin } from "./half-edge";
import { extrudeFaces, insetFaces } from "./operators";
import { weldByMap } from "../remove-doubles";

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
 * This is exactly Blender's `bmesh.ops.inset_individual(thickness=width,
 * use_even_offset=True)` — measured, not assumed: on a cube face inset by 0.2,
 * even offset lands the ring at 0.8 where the default bisector offset lands it
 * at 0.8586 and relative offset at 0.7172. `width` is Blender's `thickness`.
 *
 * For the *region* form — one ring around a whole selection rather than one per
 * face — see `insetRegion`, which is what Blender's Inset tool does by default.
 *
 * Returns the new inner cap faces, like `insetFaces`.
 */
export function insetFacesByWidth(
  em: EditMesh,
  faces: ReadonlySet<number>,
  width: number,
  opts: { interpolate?: boolean } = {},
): Set<number> {
  if (faces.size === 0 || width <= 0) return new Set(faces);

  // Work out every vertex's target from the old face before touching the
  // mesh, and hand the ring to insetFaces — which needs the final positions
  // to interpolate the corner data at (`interpolate`, Blender's
  // `use_interpolate`; see `InsetFacesOptions`).
  const polys = toPolygons(em);
  const inner = new Map<number, number[]>();
  for (const f of faces) {
    const verts = polys[f]!;
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

    inner.set(f, moved.flat());
  }

  return insetFaces(em, faces, 1e-6, { inner, interpolate: opts.interpolate });
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

/**
 * Extrude the same faces again and again, each time moving the new cap by
 * the same vector — Blender's **Extrude Repeat** (`MESH_OT_extrude_repeat`).
 *
 * Blender's operator is exactly this loop: `steps` times, extrude the
 * selected region (`extrude_face_region`, originals removed) and translate
 * the new selection by `offset × scaleOffset`. A column of rings, a stack of
 * segments, a tentacle before it is bent.
 *
 * `offset` has no default here: Blender's falls back to the **view**
 * direction, which a function without a view does not have.
 *
 * The layers are carried as Blender's are (`extrude-repeat-layers`): each
 * step is the UI's region extrude, whose walls copy the face across
 * (`wallsFrom: "outside"`), and kept originals are the faces flipped.
 *
 * Returns the last cap.
 */
export function extrudeRepeat(
  em: EditMesh,
  faces: ReadonlySet<number>,
  opts: { steps: number; offset: readonly [number, number, number]; scaleOffset?: number },
): Set<number> {
  const k = opts.scaleOffset ?? 1;
  const usedBefore = usedVertices(em);
  const countBefore = em.positions.length / 3;
  let caps = new Set(faces);
  for (let i = 0; i < opts.steps; i++) {
    // `extrude_face_region` deletes the original faces only when the region
    // borders a face outside it. A region with no such neighbour — a whole
    // open sheet, a whole closed shell — keeps its originals, flipped, so a
    // plane extrudes into a solid (measured: a 4×4 grid, 25 → 50 vertices at
    // the first step, `probe-extrude-repeat2.py`). `extrudeFaces` always
    // re-points them, so the kept copies are put back here.
    const polysBefore = toPolygons(em);
    const edgeOwners = new Map<string, number>();
    polysBefore.forEach((p, f) => {
      if (caps.has(f)) return;
      for (let j = 0; j < p.length; j++) {
        const a = p[j]!;
        const b = p[(j + 1) % p.length]!;
        edgeOwners.set(a < b ? `${a}_${b}` : `${b}_${a}`, f);
      }
    });
    let bordersOutside = false;
    for (const f of caps) {
      const p = polysBefore[f]!;
      for (let j = 0; j < p.length && !bordersOutside; j++) {
        const a = p[j]!;
        const b = p[(j + 1) % p.length]!;
        if (edgeOwners.has(a < b ? `${a}_${b}` : `${b}_${a}`)) bordersOutside = true;
      }
    }
    // In the set's order — the order `extrudeFaces` appends their caps in.
    const keptFrom = bordersOutside ? [] : [...caps];
    const kept = keptFrom.map((f) => [...polysBefore[f]!].reverse());

    caps = extrudeFaces(em, caps, { wallsFrom: "outside" });
    if (kept.length > 0) {
      // The kept originals are the region's faces flipped
      // (`BM_face_normal_flip`): the same corners, in reverse. They are read
      // from the caps, which hold the originals' corners — `extrudeFaces`
      // appends one cap per region face, in the region's order.
      const now = toPolygons(em);
      const capList = [...caps];
      const stated: Array<ExplicitFace | undefined> = now.map(() => undefined);
      keptFrom.forEach((f, i) => {
        const n = polysBefore[f]!.length;
        const cap = capList[i]!;
        stated.push({ corners: Array.from({ length: n }, (_, j) => [[cap, n - 1 - j, 1]]), material: cap });
      });
      rebuildPolygons(em, em.positions, [...now, ...kept], { faces: stated });
    }
    moveFaces(em, caps, opts.offset[0] * k, opts.offset[1] * k, opts.offset[2] * k);
  }
  // Blender's extrude takes the region's edges along, so the vertices inside
  // the old region go with its faces; `extrudeFaces` leaves them loose.
  // Measured: on `body`, 40 per step — each step's cap becomes the next
  // step's interior. Loose vertices that were loose before are the caller's
  // and stay.
  const used = usedVertices(em);
  const polys = toPolygons(em);
  const count = em.positions.length / 3;
  const remap = new Int32Array(count).fill(-1);
  const positions: number[] = [];
  for (let v = 0; v < count; v++) {
    const callersLoose = v < countBefore && !usedBefore.has(v);
    if (!used.has(v) && !callersLoose) continue;
    remap[v] = positions.length / 3;
    positions.push(em.positions[v * 3]!, em.positions[v * 3 + 1]!, em.positions[v * 3 + 2]!);
  }
  if (positions.length !== em.positions.length)
    rebuildPolygons(em, Float32Array.from(positions), polys.map((p) => p.map((v) => remap[v]!)), {
      sameCorners: true,
      vertexMap: remap,
    });
  return caps;
}

/** Vertices some face uses. */
function usedVertices(em: EditMesh): Set<number> {
  const out = new Set<number>();
  for (const p of toPolygons(em)) for (const v of p) out.add(v);
  return out;
}

/**
 * Extrude a face region and move it, keeping the mesh manifold — Blender's
 * **Extrude Manifold** (`MESH_OT_extrude_manifold`), which is
 * `extrude_region(use_dissolve_ortho_edges=True)` then a translate.
 *
 * The difference from a plain extrude is at the region's rim: where the face
 * outside a rim edge stands **perpendicular** to the region (the region's
 * averaged normal against that face's, `|dot| ≤ 0.0001`), no side wall is
 * built — the outside face is stretched to take the wall in, and an original
 * rim vertex left between just two edges is folded into its copy. Pushing a
 * corner face of a box in or out therefore changes the box's sides instead of
 * adding walls against them (`bmo_extrude.cc`, `probe-extrude-manifold.py`).
 *
 * Then the translate's **auto-merge and split**: moved vertices that land on
 * unmoved ones weld to them, and edges with a vertex lying on them are split
 * there and welded — so a face pushed in until it meets the far side cuts the
 * column out, as Blender's does (`extrude-manifold-through`). Edges crossing
 * other edges mid-span are not split (see {@link automergeAndSplit}).
 *
 * The layers (`extrude-manifold-*-layers`): a wall copies the face across,
 * a folded wall adds the outside face's own corners to it, a copied vertex
 * keeps its source's groups, and the automerge's split points are linear
 * along their edge before the weld keeps the survivor's.
 *
 * Returns the moved faces.
 */
export function extrudeManifold(
  em: EditMesh,
  faces: ReadonlySet<number>,
  offset: readonly [number, number, number],
): Set<number> {
  const polys = toPolygons(em);
  const P = Array.from(em.positions);
  const count = P.length / 3;
  const k = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const normalOf = (p: readonly number[]): [number, number, number] => {
    let x = 0, y = 0, z = 0;
    for (let i = 0; i < p.length; i++) {
      const a = p[i]! * 3;
      const b = p[(i + 1) % p.length]! * 3;
      x += (P[a + 1]! - P[b + 1]!) * (P[a + 2]! + P[b + 2]!);
      y += (P[a + 2]! - P[b + 2]!) * (P[a]! + P[b]!);
      z += (P[a]! - P[b]!) * (P[a + 1]! + P[b + 1]!);
    }
    const l = Math.hypot(x, y, z);
    return l > 0 ? [x / l, y / l, z / l] : [0, 0, 0];
  };

  // The region's averaged normal (`average_normal`), and who owns each edge.
  let avg: [number, number, number] = [0, 0, 0];
  for (const f of faces) {
    const n = normalOf(polys[f]!);
    avg = [avg[0] + n[0], avg[1] + n[1], avg[2] + n[2]];
  }
  const al = Math.hypot(...avg);
  avg = al > 0 ? [avg[0] / al, avg[1] / al, avg[2] / al] : [0, 0, 1];
  const outsideOwner = new Map<string, number>();
  polys.forEach((p, f) => {
    if (faces.has(f)) return;
    for (let i = 0; i < p.length; i++) outsideOwner.set(k(p[i]!, p[(i + 1) % p.length]!), f);
  });

  // Duplicate the region's vertices; the region moves onto the copies.
  const copy = new Map<number, number>();
  for (const f of faces)
    for (const v of polys[f]!)
      if (!copy.has(v)) {
        copy.set(v, P.length / 3);
        P.push(P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!);
      }

  const out = polys.map((p) => [...p]);
  // Where each corner comes from, [old face, old corner], in step with the
  // faces through every splice below — for the per-corner layers.
  type Src = [number, number];
  const outSrc: Src[][] = polys.map((p, f) => p.map((_, i) => [f, i] as Src));
  const sides: number[][] = [];
  const sidesSrc: Src[][] = [];
  const tagged: number[] = [];
  for (const f of faces) {
    const p = polys[f]!;
    for (let i = 0; i < p.length; i++) {
      const a = p[i]!;
      const b = p[(i + 1) % p.length]!;
      const owner = outsideOwner.get(k(a, b));
      if (owner === undefined && [...faces].some((g) => g !== f && polys[g]!.includes(a) && polys[g]!.includes(b)))
        continue; // interior to the region
      const na = copy.get(a)!;
      const nb = copy.get(b)!;
      const perpendicular =
        owner !== undefined && Math.abs(avg[0] * normalOf(polys[owner]!)[0] + avg[1] * normalOf(polys[owner]!)[1] + avg[2] * normalOf(polys[owner]!)[2]) <= 0.0001;
      // A wall copies the face across (the UI's extrude, which passes the
      // edges too), or the region face on the mesh's rim.
      const o = owner ?? f;
      const ca: Src = [o, polys[o]!.indexOf(a)];
      const cb: Src = [o, polys[o]!.indexOf(b)];
      if (perpendicular) {
        // Join the wall into the outside face: its b→a becomes b→nb→na→a.
        // The wall's corners were the face's own, so the new ones repeat them.
        const F = out[owner!]!;
        const j = F.findIndex((v, x) => v === b && F[(x + 1) % F.length] === a);
        F.splice(j + 1, 0, nb, na);
        outSrc[owner!]!.splice(j + 1, 0, cb, ca);
        tagged.push(a, b);
      } else {
        sides.push([a, b, nb, na]);
        sidesSrc.push([ca, cb, cb, ca]);
      }
    }
  }
  for (const f of faces) out[f] = polys[f]!.map((v) => copy.get(v)!);

  // A rim vertex left between two edges folds into its copy.
  const regionFaces = new Set([...faces].map((f) => out[f]!));
  let all = [...out, ...sides];
  let allSrc = [...outSrc, ...sidesSrc];
  // The face each output face takes its material from.
  let allMat = [...out.map((_, f) => f), ...sidesSrc.map((s) => s[0]![0])];
  for (const v of new Set(tagged)) {
    const nbrs = new Set<number>();
    for (const p of all)
      for (let i = 0; i < p.length; i++) {
        if (p[i] !== v) continue;
        nbrs.add(p[(i + 1) % p.length]!);
        nbrs.add(p[(i + p.length - 1) % p.length]!);
      }
    if (nbrs.size !== 2) continue;
    all.forEach((p, x) => {
      const i = p.indexOf(v);
      if (i >= 0) {
        p.splice(i, 1);
        allSrc[x]!.splice(i, 1);
      }
    });
    const keep = all.map((p) => p.length >= 3);
    all = all.filter((_, x) => keep[x]);
    allSrc = allSrc.filter((_, x) => keep[x]);
    allMat = allMat.filter((_, x) => keep[x]);
  }

  // Vertices the old region used and nothing uses now go.
  const used = new Set(all.flat());
  const remap = new Int32Array(P.length / 3).fill(-1);
  const positions: number[] = [];
  for (let v = 0; v < P.length / 3; v++) {
    if (!used.has(v) && (v >= count || [...faces].some((f) => polys[f]!.includes(v)))) continue;
    remap[v] = positions.length / 3;
    positions.push(P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!);
  }
  const moved = new Set<number>();
  all.forEach((p, i) => {
    if (regionFaces.has(p)) moved.add(i);
  });
  // Built first with every vertex kept — a copy carries its source's vertex
  // data — and then compacted, which only renumbers.
  const origins = new Map<number, VertexOrigin>();
  for (const [v, c] of copy) origins.set(c, { from: [v], w: [1] });
  const stated: ExplicitFace[] = allSrc.map((s, x) => ({
    corners: s.map(([f, i]) => [[f, i, 1] as [number, number, number]]),
    material: allMat[x]!,
  }));
  rebuildPolygons(em, Float32Array.from(P), all, { origins, faces: stated });
  rebuildPolygons(
    em,
    Float32Array.from(positions),
    all.map((p) => p.map((v) => remap[v]!)),
    { sameCorners: true, vertexMap: remap },
  );
  moveFaces(em, moved, offset[0], offset[1], offset[2]);
  return automergeAndSplit(em, moved);
}

/**
 * The translate's `use_automerge_and_split` (`EDBM_automerge_and_split`),
 * for the moved faces' vertices, at Blender's default merge distance 0.001:
 *
 * 1. a moved vertex within reach of an unmoved one merges into it;
 * 2. a vertex lying on an edge it is not part of splits that edge there, and
 *    the split point is welded to it — a moved vertex on any edge, any vertex
 *    on an edge with a moved end. That removes the spike a pushed-in region
 *    leaves in the face beside it (`extrude-manifold-in`: the copy of a rim
 *    vertex lands on the side face's own edge), and after a push through,
 *    the wall edges that now pass through old vertices
 *    (`extrude-manifold-through`).
 *
 * Edges **crossing** edges (Blender's `BM_mesh_intersect_edges` also splits
 * those) are not ported; nothing a single push produces on these inputs
 * reaches that case, and it is left rather than guessed.
 */
function automergeAndSplit(em: EditMesh, moved: ReadonlySet<number>): Set<number> {
  const DIST = 0.001;
  const polys = toPolygons(em);
  const P = Array.from(em.positions);
  const movedVerts = new Set<number>();
  for (const f of moved) for (const v of polys[f]!) movedVerts.add(v);
  const count = P.length / 3;
  const co = (v: number): [number, number, number] => [P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!];
  const target = new Int32Array(count + 1024).map((_, i) => i);

  // 1. Onto the nearest unmoved vertex in reach (lowest index on a tie).
  for (const q of movedVerts) {
    const [x, y, z] = co(q);
    let best = -1;
    let bestD = DIST * DIST;
    for (let v = 0; v < count; v++) {
      if (movedVerts.has(v)) continue;
      const d = (P[v * 3]! - x) ** 2 + (P[v * 3 + 1]! - y) ** 2 + (P[v * 3 + 2]! - z) ** 2;
      if (d <= bestD && (best < 0 || d < bestD || v < best)) {
        best = v;
        bestD = d;
      }
    }
    if (best >= 0) target[q] = best;
  }

  // 2. Split edges a moved vertex lies on.
  const edges = new Map<string, [number, number]>();
  for (const p of polys)
    for (let i = 0; i < p.length; i++) {
      const a = p[i]!;
      const b = p[(i + 1) % p.length]!;
      edges.set(a < b ? `${a}_${b}` : `${b}_${a}`, [a, b]);
    }
  // Which vertices are tested against which edges: a moved vertex against
  // every edge, and any vertex against an edge that has a moved end — after
  // the merge, a wall edge running down to where the region landed can pass
  // through a vertex nobody moved (`extrude-manifold-through`).
  const endOf = (v: number): number => target[v]!;
  const touchesMoved = (a: number, b: number): boolean => movedVerts.has(a) || movedVerts.has(b);
  const splits = new Map<string, { t: number; s: number }[]>();
  for (let q = 0; q < count; q++) {
    if (target[q] !== q) continue;
    const pq = co(q);
    for (const [key, [a, b]] of edges) {
      if (a === q || b === q || endOf(a) === q || endOf(b) === q) continue;
      if (!movedVerts.has(q) && !touchesMoved(a, b)) continue;
      const pa = co(a);
      const pb = co(b);
      const d = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
      const len2 = d[0]! ** 2 + d[1]! ** 2 + d[2]! ** 2;
      if (len2 === 0) continue;
      const t = ((pq[0] - pa[0]) * d[0]! + (pq[1] - pa[1]) * d[1]! + (pq[2] - pa[2]) * d[2]!) / len2;
      if (t <= 0 || t >= 1) continue;
      const foot = [pa[0] + d[0]! * t, pa[1] + d[1]! * t, pa[2] + d[2]! * t];
      if ((foot[0]! - pq[0]) ** 2 + (foot[1]! - pq[1]) ** 2 + (foot[2]! - pq[2]) ** 2 > DIST * DIST) continue;
      const s = P.length / 3;
      P.push(foot[0]!, foot[1]!, foot[2]!);
      target[s] = q;
      const list = splits.get(key) ?? [];
      // t is measured from the lower-numbered end.
      list.push({ t: a < b ? t : 1 - t, s });
      splits.set(key, list);
    }
  }
  // Each split point's corner is `BM_edge_split`'s: linear along the edge
  // between the face's two corners.
  const layers = [em.loopUVs, em.loopColors, em.loopNormals].map((l) => (l?.length === polys.length ? l : undefined));
  const cornerLayers: number[][][][] = layers.map(() => []);
  const withSplits = polys.map((p, f) => {
    const out: number[] = [];
    const cs = layers.map(() => [] as number[][]);
    for (let i = 0; i < p.length; i++) {
      const a = p[i]!;
      const b = p[(i + 1) % p.length]!;
      out.push(a);
      layers.forEach((l, x) => l && cs[x]!.push([...l[f]![i]!]));
      const list = splits.get(a < b ? `${a}_${b}` : `${b}_${a}`);
      if (!list) continue;
      const sorted = [...list].sort((m, n) => m.t - n.t);
      for (const { s, t } of a < b ? sorted : sorted.reverse()) {
        out.push(s);
        const u = a < b ? t : 1 - t; // from a
        layers.forEach((l, x) => {
          if (!l) return;
          const ca = l[f]![i]!;
          const cb = l[f]![(i + 1) % p.length]!;
          cs[x]!.push(ca.map((c, j) => c + (cb[j]! - c) * u));
        });
      }
    }
    layers.forEach((l, x) => l && cornerLayers[x]!.push(cs[x]!));
    return out;
  });

  const materials = em.faceMaterials?.length === polys.length ? em.faceMaterials : undefined;
  const welded = weldByMap(
    {
      positions: Float32Array.from(P),
      polys: withSplits,
      ...(layers[0] ? { uvs: cornerLayers[0] } : {}),
      ...(layers[1] ? { colors: cornerLayers[1] } : {}),
      ...(layers[2] ? { normals: cornerLayers[2] } : {}),
      ...(materials ? { materials: [...materials] } : {}),
      ...(em.vertexGroups ? { groups: em.vertexGroups } : {}),
    },
    (v) => target[v]!,
  );
  // Laid down after the rebuild, which would read the welded faces as new.
  em.loopUVs = undefined;
  em.loopColors = undefined;
  em.loopNormals = undefined;
  em.faceMaterials = undefined;
  em.vertexGroups = undefined;
  rebuildPolygons(em, welded.positions, welded.polys);
  if (welded.uvs) em.loopUVs = welded.uvs;
  if (welded.colors) em.loopColors = welded.colors;
  if (welded.normals) em.loopNormals = welded.normals;
  if (welded.materials) em.faceMaterials = welded.materials;
  if (welded.groups && welded.groups.size > 0) em.vertexGroups = welded.groups;
  // The moved faces, found again: every corner a (surviving) moved vertex.
  const survivorOf = new Map<number, number>();
  let next = 0;
  for (let v = 0; v < P.length / 3; v++) if (target[v] === v) survivorOf.set(v, next++);
  const movedNow = new Set([...movedVerts].filter((v) => target[v] === v).map((v) => survivorOf.get(v)!));
  const out = new Set<number>();
  welded.polys.forEach((p, f) => {
    if (p.every((v) => movedNow.has(v))) out.add(f);
  });
  return out;
}

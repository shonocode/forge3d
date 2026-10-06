/**
 * Making generated geometry well-formed enough for the next stage.
 *
 * Everything here is a Blender operation, named as Blender names it. The first
 * two exist because `tools/modeling` had to write them itself:
 *
 * - {@link recalcFaceNormals} — `bmesh.ops.recalc_face_normals`. `raster.ts`
 *   had `orientOutward`, which flips the whole mesh when its signed volume
 *   comes out negative. That catches a shell built inside-out and misses a
 *   shell built *inconsistently*: flipping every face at once preserves the
 *   disagreement between the parts. `arch.ts`'s `box` wound inward for two
 *   rooms and nothing could see it.
 * - {@link connectVertsConcave} — `bmesh.ops.connect_verts_concave`. The
 *   roadmap records Catmull-Clark folding concave n-gons, with the note that
 *   "the caller splits until star-shaped". The parity harness later showed the
 *   fold is not a forge3d defect — Blender's output has the same wedge to
 *   0.0000mm — so the split is the right fix rather than a workaround, and it
 *   is an operation Blender ships.
 *
 * {@link deleteLoose} and {@link separateLoose} came later, from the parity
 * harness: five dissolve rows each carried a "Blender has fewer vertices"
 * footnote, and this is the operator that footnote was about.
 *
 * All of them work on {@link MeshData} rather than an `EditMesh`. Blender's
 * are BMesh operators, but the place these are needed is the generator's
 * output, before anything has been handed to the operator layer at all.
 *
 * Pure and headless — Vitest-pinned.
 */
import { withPositions, type MeshData } from "../lib/mesh";
import type { Vec3 } from "./generate";
import { carryFaceLayers, carryVertexLayers, defined, sameFaces, type FaceSource } from "./mesh-layers";

// ── Shared geometry ────────────────────────────────────────────────────────

/** Newell's normal for a polygon: robust for n-gons, area-weighted. */
function polyNormal(P: Float32Array, poly: readonly number[]): Vec3 {
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
  return [nx, ny, nz];
}

const edgeKey = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);

// ── recalcFaceNormals ──────────────────────────────────────────────────────

/** What {@link recalcFaceNormals} did, for callers that want to assert on it. */
export interface RecalcFaceNormalsReport {
  /** Faces whose winding was reversed. */
  flipped: number;
  /** Connected shells found. Each is made consistent and oriented on its own. */
  shells: number;
  /**
   * Shared edges that were traversed the same way by both their faces — the
   * signature of an inconsistently wound mesh. Zero on well-formed input.
   */
  inconsistentEdges: number;
  /** Shells with a boundary. They are turned outward all the same, as Blender does (compat-backlog C58). */
  openShells: number;
  /** Edges shared by three or more faces, which no winding can satisfy. */
  nonManifoldEdges: number;
}

/**
 * `recalc_face_normals_find_index`: is the shell wound inward? The centre is the area-weighted mean of the faces' weighted medians;
 * the furthest loop vertex from it (then, on a tie, the loop whose edges point most along the direction to it, then the one whose
 * own normal does) is where a ray from the centre would meet the surface first, so the face there must face away from the
 * centre. All in float32, in the order the C does it.
 */
function shellPointsInward(P: Float32Array, faces: readonly (readonly number[])[]): boolean {
  const f = Math.fround;
  const at = (v: number): number[] => [f(P[v * 3]!), f(P[v * 3 + 1]!), f(P[v * 3 + 2]!)];
  const sub3 = (a: number[], b: number[]): number[] => [f(a[0]! - b[0]!), f(a[1]! - b[1]!), f(a[2]! - b[2]!)];
  const dot3 = (a: number[], b: number[]): number => f(f(f(a[0]! * b[0]!) + f(a[1]! * b[1]!)) + f(a[2]! * b[2]!));
  const cross3 = (a: number[], b: number[]): number[] => [
    f(f(a[1]! * b[2]!) - f(a[2]! * b[1]!)),
    f(f(a[2]! * b[0]!) - f(a[0]! * b[2]!)),
    f(f(a[0]! * b[1]!) - f(a[1]! * b[0]!)),
  ];
  const lenSq = (a: number[]): number => dot3(a, a);
  /** `normalize_v3`: the length, with the vector scaled by its reciprocal (zero below 1e-35 squared). */
  const normalize = (a: number[]): number => {
    let d = lenSq(a);
    if (d > f(1.0e-35)) {
      d = f(Math.sqrt(d));
      const inv = f(1 / d);
      a[0] = f(a[0]! * inv);
      a[1] = f(a[1]! * inv);
      a[2] = f(a[2]! * inv);
    } else {
      a[0] = a[1] = a[2] = 0;
      d = 0;
    }
    return d;
  };
  const eps = f(1.1920929e-7);
  const n = faces.length;
  const centFac = f(1 / n);
  let cent = [0, 0, 0];
  let area = 0;
  const faceNo: number[][] = [];
  for (const face of faces) {
    const co = face.map(at);
    // `BM_face_calc_area`: Newell's sum, half its length.
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = 0; i < co.length; i++) {
      const a = co[i]!;
      const b = co[(i + 1) % co.length]!;
      nx = f(nx + f(f(a[1]! - b[1]!) * f(a[2]! + b[2]!)));
      ny = f(ny + f(f(a[2]! - b[2]!) * f(a[0]! + b[0]!)));
      nz = f(nz + f(f(a[0]! - b[0]!) * f(a[1]! + b[1]!)));
    }
    const nl = f(Math.sqrt(lenSq([nx, ny, nz])));
    const fArea = f(nl * f(0.5));
    // `BM_face_calc_center_median_weighted`: each vertex weighted by the two edges on it.
    let wPrev = f(Math.sqrt(lenSq(sub3(co[0]!, co[co.length - 1]!))));
    let totw = 0;
    const fc = [0, 0, 0];
    for (let i = 0; i < co.length; i++) {
      const wCurr = f(Math.sqrt(lenSq(sub3(co[(i + 1) % co.length]!, co[i]!))));
      const w = f(wCurr + wPrev);
      for (let k = 0; k < 3; k++) fc[k] = f(fc[k]! + f(co[i]![k]! * w));
      totw = f(totw + w);
      wPrev = wCurr;
    }
    if (totw !== 0) {
      const inv = f(1 / totw);
      for (let k = 0; k < 3; k++) fc[k] = f(fc[k]! * inv);
    }
    const wgt = f(centFac * fArea);
    for (let k = 0; k < 3; k++) cent[k] = f(cent[k]! + f(fc[k]! * wgt));
    area = f(area + fArea);
    // The face normal `BM_face_calc_normal` (Newell, normalized).
    const no = [nx, ny, nz];
    normalize(no);
    faceNo.push(no);
  }
  if (area !== 0) {
    const inv = f(1 / area);
    cent = cent.map((c) => f(c * inv));
  }

  let bestDist = eps;
  let bestEdge = -3.4028235e38;
  let bestLoop = -3.4028235e38;
  let isFlip = false;
  faces.forEach((face, fi) => {
    const m = face.length;
    for (let i = 0; i < m; i++) {
      const co = at(face[i]!);
      const dir = sub3(co, cent);
      const dist = lenSq(dir);
      const isBestDist = dist > bestDist;
      if (!(isBestDist || dist === bestDist)) continue;
      const inv = f(1 / f(Math.sqrt(dist)));
      for (let k = 0; k < 3; k++) dir[k] = f(dir[k]! * inv);
      const e0 = sub3(at(face[(i + 1) % m]!), co);
      const e1 = sub3(at(face[(i + m - 1) % m]!), co);
      if (!(normalize(e0) > eps && normalize(e1) > eps)) continue;
      const edgeDot = Math.max(dot3(dir, e0), dot3(dir, e1));
      const isBestEdge = edgeDot > bestEdge;
      if (!(isBestDist || isBestEdge || edgeDot === bestEdge)) continue;
      const loopDir = cross3(e0, e1);
      if (!(normalize(loopDir) > eps)) continue;
      if (dot3(loopDir, faceNo[fi]!) < 0) for (let k = 0; k < 3; k++) loopDir[k] = -loopDir[k]!;
      const loopDot = dot3(dir, loopDir);
      const test = Math.abs(loopDot);
      if (isBestDist || isBestEdge || test > bestLoop) {
        bestDist = dist;
        bestEdge = edgeDot;
        bestLoop = test;
        isFlip = loopDot < 0;
      }
    }
  });
  return isFlip;
}

/**
 * Make face windings consistent within each shell, then turn each shell
 * outward — Blender's `bmesh.ops.recalc_face_normals(faces=)`, Mesh > Normals >
 * Recalculate Outside.
 *
 * Two steps, and the first is the one a volume check cannot do:
 *
 * 1. **Consistency.** Walk each shell face to face across shared edges. Two
 *    faces agree when they traverse their shared edge in opposite directions;
 *    when they agree in the *same* direction, one of them is reversed. This is
 *    what catches a mesh whose caps and sides disagree — flipping everything at
 *    once, which is all a volume test can ask for, leaves that disagreement
 *    exactly where it was.
 * 2. **Direction.** A consistent shell is either entirely outward or entirely
 *    inward, which the furthest-vertex test reports. Reverse it if inward.
 *
 * **Open shells are turned outward too** (compat-backlog C58), by the same test as closed ones — Blender's, not a signed volume:
 * the furthest loop vertex from the shell's area-weighted centre, where a ray from the centre meets the surface first, must face
 * away from it (`recalc_face_normals_find_index`). Signed volume is only meaningful over a closed surface, and a recessed
 * cup has its centroid almost on its own surface, which is why this used to leave open shells alone; the furthest-vertex rule does not
 * have that trouble, and a spike is handled by looking at the loop rather than the face.
 *
 * Vertex indices are untouched, so creases and seams carry through unchanged.
 */
export function recalcFaceNormals(
  data: MeshData,
  report?: RecalcFaceNormalsReport,
): MeshData {
  const P = data.positions;
  const polys = data.polys.map((p) => [...p]);

  // edge -> the faces on it, with the direction each traverses it.
  const byEdge = new Map<string, Array<{ face: number; forward: boolean }>>();
  for (let f = 0; f < polys.length; f++) {
    const poly = polys[f]!;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      if (a === b) continue;
      const key = edgeKey(a, b);
      let list = byEdge.get(key);
      if (!list) byEdge.set(key, (list = []));
      list.push({ face: f, forward: a < b });
    }
  }

  let nonManifoldEdges = 0;
  for (const list of byEdge.values()) if (list.length > 2) nonManifoldEdges++;

  const flipped = new Array<boolean>(polys.length).fill(false);
  const seen = new Array<boolean>(polys.length).fill(false);
  let flippedCount = 0;
  let shells = 0;
  let inconsistentEdges = 0;
  let openShells = 0;

  /** The direction `face` traverses `key`, accounting for a pending flip. */
  const dirOf = (entry: { face: number; forward: boolean }): boolean =>
    flipped[entry.face]! ? !entry.forward : entry.forward;

  for (let seed = 0; seed < polys.length; seed++) {
    if (seen[seed]) continue;
    shells++;

    const shell: number[] = [];
    const queue = [seed];
    seen[seed] = true;
    let open = false;

    while (queue.length > 0) {
      const f = queue.pop()!;
      shell.push(f);
      const poly = polys[f]!;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i]!;
        const b = poly[(i + 1) % poly.length]!;
        if (a === b) continue;
        const list = byEdge.get(edgeKey(a, b))!;
        if (list.length === 1) {
          open = true;
          continue;
        }
        if (list.length > 2) continue; // no consistent answer; leave it be

        const self = list.find((e) => e.face === f)!;
        const other = list.find((e) => e.face !== f);
        if (!other) continue;

        if (!seen[other.face]) {
          seen[other.face] = true;
          // Neighbours agree by traversing the shared edge oppositely.
          if (dirOf(other) === dirOf(self)) {
            flipped[other.face] = true;
            flippedCount++;
            inconsistentEdges++;
          }
          queue.push(other.face);
        } else if (dirOf(other) === dirOf(self)) {
          // Already settled and still disagreeing: the shell cannot be made
          // consistent by flipping whole faces (a Möbius strip, or a seam the
          // walk closed on). Counted, not silently accepted.
          inconsistentEdges++;
        }
      }
    }

    for (const f of shell) if (flipped[f]!) polys[f]!.reverse();
    for (const f of shell) flipped[f] = false;

    if (open) openShells++;
    // Blender turns an open shell outward too, by the face furthest from the shell's centre (`recalc_face_normals_find_index`).
    if (shellPointsInward(P, shell.map((f) => polys[f]!))) {
      for (const f of shell) {
        polys[f]!.reverse();
        flippedCount++;
      }
    }
  }

  if (report) {
    report.flipped = flippedCount;
    report.shells = shells;
    report.inconsistentEdges = inconsistentEdges;
    report.openShells = openShells;
    report.nonManifoldEdges = nonManifoldEdges;
  }

  // Every layer (compat-backlog A3): a reversed face's corners follow their
  // vertices, as `BM_face_normal_flip` keeps each loop's data.
  return defined({
    ...withPositions(data, new Float32Array(P)),
    polys,
    ...carryFaceLayers(
      data,
      polys.map((p, f) => ({ face: f, corners: p.map((v) => data.polys[f]!.indexOf(v)) })),
    ),
  });
}

// ── connectVertsConcave ────────────────────────────────────────────────────

/** What {@link connectVertsConcave} did. */
export interface ConnectVertsConcaveReport {
  /** Faces that were concave and got split. */
  split: number;
  /** Convex pieces those faces became. */
  pieces: number;
  /**
   * Faces that are concave but could not be split — self-intersecting or
   * degenerate outlines, where no diagonal lies inside the polygon. Left
   * untouched rather than mangled.
   */
  failed: number;
}

/** 2D cross product of (b-a) and (c-b). */
const cross2 = (a: readonly [number, number], b: readonly [number, number], c: readonly [number, number]): number =>
  (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);

/**
 * How small a cross product counts as "straight", for this ring.
 *
 * It has to scale with the ring, and the reason is `positions` being a
 * `Float32Array`: a polygon carries ~1e-7 relative error, so a corner that is
 * exactly collinear in the source reads as ±2e-7 for a ring two units across.
 * An absolute threshold tight enough for unit-sized work (1e-12) calls that a
 * real corner, and then the same L-shape splits into two quads when it is
 * axis-aligned and three pieces when it is rotated — measured, before this
 * existed.
 *
 * Cross products here are areas, so the tolerance goes as the square of the
 * extent. 1e-6 of that sits three orders above float32 noise and three below
 * any corner a caller meant to draw.
 */
function straightEpsilon(ring: ReadonlyArray<readonly [number, number]>): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const extent = Math.max(maxX - minX, maxY - minY);
  return extent > 0 ? extent * extent * 1e-6 : 1e-12;
}

function isConvexRing(ring: ReadonlyArray<readonly [number, number]>, eps: number): boolean {
  const n = ring.length;
  if (n < 4) return true;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const c = cross2(ring[i]!, ring[(i + 1) % n]!, ring[(i + 2) % n]!);
    if (Math.abs(c) <= eps) continue;
    const s = c > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

function pointInTriangle(
  p: readonly [number, number],
  a: readonly [number, number],
  b: readonly [number, number],
  c: readonly [number, number],
  eps: number,
): boolean {
  const snap = (d: number): number => (Math.abs(d) <= eps ? 0 : d);
  const d1 = snap(cross2(a, b, p));
  const d2 = snap(cross2(b, c, p));
  const d3 = snap(cross2(c, a, p));
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/**
 * Ear-clip a CCW ring into triangles of its own indices.
 *
 * Returns null when no ear can be found, which means the outline is
 * self-intersecting or degenerate. A fan fallback would produce triangles that
 * cover the wrong area, so the caller is told instead.
 */
function earClip(ring: ReadonlyArray<readonly [number, number]>, eps: number): number[][] | null {
  const idx = ring.map((_, i) => i);
  const tris: number[][] = [];

  while (idx.length > 3) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length]!;
      const ib = idx[i]!;
      const ic = idx[(i + 1) % idx.length]!;
      const a = ring[ia]!;
      const b = ring[ib]!;
      const c = ring[ic]!;
      if (cross2(a, b, c) <= eps) continue; // reflex or straight — not an ear

      let contains = false;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        if (pointInTriangle(ring[j]!, a, b, c, eps)) {
          contains = true;
          break;
        }
      }
      if (contains) continue;

      tris.push([ia, ib, ic]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) return null;
  }
  tris.push([idx[0]!, idx[1]!, idx[2]!]);
  return tris;
}

/**
 * Merge triangles back across added diagonals while the result stays convex —
 * Hertel–Mehlhorn. Turns the ear-clip's triangle soup into the few convex
 * pieces the operation is supposed to produce.
 */
function mergeToConvex(
  pieces: number[][],
  ring: ReadonlyArray<readonly [number, number]>,
  boundary: ReadonlySet<string>,
  eps: number,
): number[][] {
  let work = pieces.map((p) => [...p]);
  let merged = true;

  while (merged) {
    merged = false;
    outer: for (let i = 0; i < work.length; i++) {
      for (let j = i + 1; j < work.length; j++) {
        const A = work[i]!;
        const B = work[j]!;
        // Find a shared edge that is a diagonal, not part of the outline.
        for (let x = 0; x < A.length; x++) {
          const a1 = A[x]!;
          const a2 = A[(x + 1) % A.length]!;
          if (boundary.has(edgeKey(a1, a2))) continue;
          const y = B.findIndex((v, k) => v === a2 && B[(k + 1) % B.length] === a1);
          if (y < 0) continue;

          // Splice B into A across the shared edge.
          const combined: number[] = [];
          for (let k = 1; k < A.length; k++) combined.push(A[(x + k) % A.length]!);
          for (let k = 1; k < B.length; k++) combined.push(B[(y + k) % B.length]!);

          if (!isConvexRing(combined.map((v) => ring[v]!), eps)) continue;

          work = work.filter((_, k) => k !== i && k !== j);
          work.push(combined);
          merged = true;
          break outer;
        }
      }
    }
  }
  return work;
}

/**
 * Split concave faces into convex ones — Blender's
 * `bmesh.ops.connect_verts_concave(faces=)`, Face > Split > Faces by Edges.
 *
 * Catmull-Clark places a face point at the average of a face's vertices and
 * spans quads from it to each edge. When the face is not star-shaped about that
 * point, the quads around the concavity fold through each other. The parity
 * harness measured the fold against Blender and found it identical to
 * 0.0000mm, which makes it a property of the subdivision rather than a bug to
 * fix: the surface to refine should be convex pieces, and this is what makes
 * them.
 *
 * Ear-clips each concave face, then merges the triangles back across the added
 * diagonals for as long as the merged piece stays convex (Hertel–Mehlhorn), so
 * a concave hexagon comes back as two quads rather than four triangles — which
 * matters, because quads are what Catmull-Clark wants next.
 *
 * No vertices are added, so creases and seams carry through untouched, and a
 * diagonal the split introduces is uncreased — the same as drawing it by hand.
 *
 * Blender's version takes a face selection. This takes the whole mesh and finds
 * the concave faces itself: at the generator stage there is no selection to
 * pass, and a convex face is returned unchanged anyway.
 */
export function connectVertsConcave(
  data: MeshData,
  report?: ConnectVertsConcaveReport,
): MeshData {
  const P = data.positions;
  const out: number[][] = [];
  let split = 0;
  let pieceCount = 0;
  let failed = 0;

  const sources: FaceSource[] = [];
  for (let fi = 0; fi < data.polys.length; fi++) {
    const poly = data.polys[fi]!;
    if (poly.length < 4) {
      { out.push([...poly]); sources.push({ face: fi, corners: poly.map((_, i) => i) }); }
      continue;
    }

    // Project into the face's own plane. The basis is built from the Newell
    // normal, so a correctly wound polygon comes out counter-clockwise here.
    const [nx, ny, nz] = polyNormal(P, poly);
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-20) {
      { out.push([...poly]); sources.push({ face: fi, corners: poly.map((_, i) => i) }); } // zero-area face — nothing to say about its shape
      continue;
    }
    const n: Vec3 = [nx / len, ny / len, nz / len];
    const seed: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const t: Vec3 = [
      seed[1] * n[2] - seed[2] * n[1],
      seed[2] * n[0] - seed[0] * n[2],
      seed[0] * n[1] - seed[1] * n[0],
    ];
    const tl = Math.hypot(t[0], t[1], t[2]);
    const tu: Vec3 = [t[0] / tl, t[1] / tl, t[2] / tl];
    const bu: Vec3 = [
      n[1] * tu[2] - n[2] * tu[1],
      n[2] * tu[0] - n[0] * tu[2],
      n[0] * tu[1] - n[1] * tu[0],
    ];

    const ring = poly.map((v): [number, number] => {
      const x = P[v * 3]!;
      const y = P[v * 3 + 1]!;
      const z = P[v * 3 + 2]!;
      return [x * tu[0] + y * tu[1] + z * tu[2], x * bu[0] + y * bu[1] + z * bu[2]];
    });

    const eps = straightEpsilon(ring);
    if (isConvexRing(ring, eps)) {
      { out.push([...poly]); sources.push({ face: fi, corners: poly.map((_, i) => i) }); }
      continue;
    }

    const tris = earClip(ring, eps);
    if (!tris) {
      failed++;
      { out.push([...poly]); sources.push({ face: fi, corners: poly.map((_, i) => i) }); }
      continue;
    }

    const boundary = new Set<string>();
    for (let i = 0; i < poly.length; i++) boundary.add(edgeKey(i, (i + 1) % poly.length));

    const pieces = mergeToConvex(tris, ring, boundary, eps);
    split++;
    pieceCount += pieces.length;
    for (const piece of pieces) {
      out.push(piece.map((i) => poly[i]!));
      sources.push({ face: fi, corners: piece });
    }
  }

  if (report) {
    report.split = split;
    report.pieces = pieceCount;
    report.failed = failed;
  }

  // Every layer (compat-backlog A3): each piece keeps its face's corners, as
  // `BM_face_split` does.
  return defined({ ...withPositions(data, new Float32Array(P)), polys: out, ...carryFaceLayers(data, sources) });
}

// ── Loose geometry ─────────────────────────────────────────────────────────

/**
 * Drop vertices that no polygon uses — Blender's **Delete Loose**.
 *
 * This is the other half of a difference this library has carried on purpose.
 * `dissolveFaces`, `dissolveEdges`, `dissolveVerts`, `deleteFaces` and
 * `collapseEdges` all leave the vertices they orphan where they are, and every
 * one of those parity rows records the gap — a dissolved cube comes back with
 * 8 vertices where Blender has 4. Keeping them is deliberate: compacting
 * shifts every index above the hole, which reaches into selections, undo and
 * skin weights, so it must be something the caller asks for rather than
 * something an operator does behind their back.
 *
 * This is how they ask. Run it at the end of a build, not between edits.
 *
 * Creases and seams are remapped across the compaction; one that named a
 * vertex which is going away is dropped with it.
 *
 * The three kinds are Blender's `use_faces` / `use_edges` / `use_verts` (`edbm_delete_loose_exec`, in that order, with everything
 * selected), and the defaults are Blender's too:
 *
 * - **faces** (off): a face whose every edge belongs to it alone. It goes with the edges and vertices nothing else uses
 *   (`DEL_FACES`) — a vertex a remaining face or wire edge still reaches stays.
 * - **edges** (on): every wire edge, whether or not its ends are used by faces. Its ends go with it unless a face uses them
 *   (`DEL_EDGES`) — so `edges` alone also removes the vertices of a wire chain.
 * - **verts** (on): a vertex with no edge at all — no face and no wire edge left. With `edges` off a vertex on a wire edge is not
 *   loose; with it on the wire edge goes first and its ends then are.
 */
export interface DeleteLooseOptions {
  verts?: boolean;
  edges?: boolean;
  faces?: boolean;
}

export function deleteLoose(data: MeshData, options: DeleteLooseOptions = {}): MeshData {
  const useVerts = options.verts ?? true;
  const useEdges = options.edges ?? true;
  const useFaces = options.faces ?? false;
  const count = data.positions.length / 3;
  const keep = new Set<number>();
  for (let v = 0; v < count; v++) keep.add(v);

  let polys = data.polys;
  let wire = data.edges ?? [];
  const usedBy = (ps: readonly (readonly number[])[], es: readonly (readonly number[])[]): Set<number> => {
    const used = new Set<number>();
    for (const p of ps) for (const v of p) used.add(v);
    for (const e of es) for (const v of e) used.add(v);
    return used;
  };

  if (useFaces) {
    const key = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);
    const uses = new Map<string, number>();
    for (const p of polys)
      for (let i = 0; i < p.length; i++) {
        const k = key(p[i]!, p[(i + 1) % p.length]!);
        uses.set(k, (uses.get(k) ?? 0) + 1);
      }
    const loose = polys.map((p) => p.every((v, i) => uses.get(key(v, p[(i + 1) % p.length]!)) === 1));
    const remaining = polys.filter((_, f) => !loose[f]);
    const still = usedBy(remaining, wire);
    polys.forEach((p, f) => {
      if (loose[f]) for (const v of p) if (!still.has(v)) keep.delete(v);
    });
    polys = remaining;
  }
  if (useEdges) {
    // `DEL_EDGES` takes the vertices only those edges used with them — measured: `use_edges` alone still removes a wire edge's ends.
    const still = usedBy(polys, []);
    for (const e of wire) for (const v of e) if (!still.has(v)) keep.delete(v);
    wire = [];
  }
  if (useVerts) {
    const used = usedBy(polys, wire);
    for (let v = 0; v < count; v++) if (!used.has(v)) keep.delete(v);
  }

  const { edges: _edges, ...rest } = data;
  void _edges;
  return compactMesh({ ...rest, polys, ...(wire.length ? { edges: wire } : {}) }, keep);
}

/**
 * Keep only the listed vertices, renumbering what is left.
 *
 * A polygon survives only when **every** one of its vertices does — the rule
 * Blender's Mask modifier uses, and the one {@link deleteLoose} needs as a
 * special case where nothing it drops is in a polygon anyway. A kept vertex
 * that no polygon uses stays: masking away the middle of a sheet leaves its
 * loose rim behind, which is measured, not assumed.
 *
 * Creases, seams **and wire edges** are carried through with the new
 * numbering, and a wire edge with an end that did not survive is dropped —
 * there is nothing for it to join to. Seams were not carried, until
 * 2026-09-21: `deleteLoose` renumbered the vertices and spread the
 * old `seams` set on unchanged, so every seam key pointed at whatever vertex
 * had taken that number. Nothing in the parity harness compares seams, so the
 * only thing that could catch it is this sentence.
 */
export function compactMesh(data: MeshData, keep: ReadonlySet<number>): MeshData {
  const count = data.positions.length / 3;

  const remap = new Map<number, number>();
  const source: number[] = [];
  const positions: number[] = [];
  for (let v = 0; v < count; v++) {
    if (!keep.has(v)) continue;
    remap.set(v, source.length);
    source.push(v);
    positions.push(data.positions[v * 3]!, data.positions[v * 3 + 1]!, data.positions[v * 3 + 2]!);
  }

  const faces: number[] = [];
  data.polys.forEach((poly, f) => {
    if (poly.every((v) => remap.has(v))) faces.push(f);
  });
  const polys = faces.map((f) => data.polys[f]!.map((v) => remap.get(v)!));
  // Every layer follows its vertex or face (compat-backlog A3): groups,
  // materials and the corner layers as well as the edge keys.
  return defined({
    positions: new Float32Array(positions),
    polys,
    ...carryVertexLayers(data, source),
    ...carryFaceLayers(data, sameFaces(faces, data)),
  });
}

/**
 * Split off a set of faces — Blender's **Separate ▸ Selection**
 * (`mesh_separate_tagged`).
 *
 * `part` is a copy of the chosen faces and every vertex and edge they use, in
 * the input's order. `rest` is what is left once those faces are deleted the
 * way Blender's `DEL_FACES` deletes them: a vertex or edge of a chosen face
 * goes too **unless** a remaining face or a remaining loose edge still uses
 * it — so the seam between the two keeps its vertices on both sides.
 *
 * Face materials (`materials`) travel with their faces.
 */
export function separateSelected(
  data: MeshData,
  faces: ReadonlySet<number>,
): { part: MeshData; rest: MeshData } {
  const count = data.positions.length / 3;
  const pick = (keep: (f: number) => boolean, keepLooseEdges: boolean): MeshData => {
    const used = new Uint8Array(count);
    const polys: number[][] = [];
    const materials: number[] = [];
    data.polys.forEach((p, f) => {
      if (!keep(f)) return;
      polys.push([...p]);
      materials.push(data.materials?.[f] ?? 0);
      for (const v of p) used[v] = 1;
    });
    const loose = keepLooseEdges ? (data.edges ?? []).map((e) => [...e]) : [];
    for (const e of loose) for (const v of e) used[v] = 1;
    if (keepLooseEdges) {
      // A vertex no chosen face touched, and no edge either, stays with the rest.
      const touched = new Uint8Array(count);
      data.polys.forEach((p, f) => {
        if (faces.has(f)) for (const v of p) touched[v] = 1;
      });
      for (let v = 0; v < count; v++) if (!touched[v]) used[v] = 1;
    }
    const remap = new Int32Array(count).fill(-1);
    const positions: number[] = [];
    for (let v = 0; v < count; v++) {
      if (!used[v]) continue;
      remap[v] = positions.length / 3;
      positions.push(data.positions[v * 3]!, data.positions[v * 3 + 1]!, data.positions[v * 3 + 2]!);
    }
    return {
      positions: Float32Array.from(positions),
      polys: polys.map((p) => p.map((v) => remap[v]!)),
      ...(loose.length > 0 ? { edges: loose.map((e) => e.map((v) => remap[v]!)) } : {}),
      ...(data.materials ? { materials } : {}),
    };
  };
  return {
    part: pick((f) => faces.has(f), false),
    rest: pick((f) => !faces.has(f), true),
  };
}

/**
 * Split a mesh by face material — Blender's **Separate ▸ By Material**.
 *
 * Blender takes the material of the **first** remaining face, separates every
 * face with it into a new object, and repeats; whatever is left when one
 * material remains stays in the original object. The pieces come back in that
 * order — each new object first, the original last — each keyed by the
 * material it holds.
 */
export function separateByMaterial(data: MeshData): { material: number; mesh: MeshData }[] {
  const out: { material: number; mesh: MeshData }[] = [];
  let current = data;
  for (;;) {
    if (current.polys.length === 0) break;
    const mat = current.materials?.[0] ?? 0;
    const chosen = new Set<number>();
    current.polys.forEach((_, f) => {
      if ((current.materials?.[f] ?? 0) === mat) chosen.add(f);
    });
    if (chosen.size === current.polys.length) {
      out.push({ material: mat, mesh: current });
      break;
    }
    const { part, rest } = separateSelected(current, chosen);
    out.push({ material: mat, mesh: part });
    current = rest;
  }
  return out;
}

/**
 * Split a mesh into its disconnected pieces — Blender's **Separate ▸ By Loose
 * Parts**.
 *
 * Two faces belong to the same piece when they share a vertex. A brazier built
 * as one `MeshData` — bowl, legs, chains, stones — comes back as the parts it
 * was always made of, which is what an exporter wants when each piece needs
 * its own object, and what a measurement wants when only one shell is in
 * question.
 *
 * Pieces come back in the order their lowest-numbered vertex appears, so the
 * result is stable across runs. Each is compacted, like {@link deleteLoose};
 * vertices no polygon uses are in no piece and are dropped.
 *
 * **No parity row.** The harness compares one mesh against one mesh, and this
 * returns several — the rule is checked by unit test instead, on a shape whose
 * pieces are known.
 */
export function separateLoose(data: MeshData): MeshData[] {
  const count = data.positions.length / 3;
  const parent = new Int32Array(count);
  for (let v = 0; v < count; v++) parent[v] = v;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r]!;
    while (parent[x] !== r) {
      const next = parent[x]!;
      parent[x] = r;
      x = next;
    }
    return r;
  };
  for (const poly of data.polys)
    for (let i = 1; i < poly.length; i++) {
      const ra = find(poly[0]!);
      const rb = find(poly[i]!);
      if (ra !== rb) parent[ra] = rb;
    }

  // Group the faces, keeping the order their roots are first seen.
  const order: number[] = [];
  const byRoot = new Map<number, number[][]>();
  for (const poly of data.polys) {
    const r = find(poly[0]!);
    let list = byRoot.get(r);
    if (!list) {
      list = [];
      byRoot.set(r, list);
      order.push(r);
    }
    list.push(poly);
  }

  return order.map((r) =>
    deleteLoose({ ...data, polys: byRoot.get(r)!.map((p) => [...p]) }, { edges: false }),
  );
}

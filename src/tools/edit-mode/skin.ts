/**
 * Wrap a wire skeleton in quads — Blender's `SKIN` modifier.
 *
 * The input is loose edges (`MeshData.edges`) and a radius per vertex; the
 * output is a closed quad mesh that follows them. The last "medium" modifier
 * on the map, and the one most useful for building characters out of
 * stick figures.
 *
 * ## Where the rules came from
 *
 * A first probe (`probe-skin.py`) read the shape of the answer — a square
 * cross-section, caps at the ends, one ring per degree-2 node, a hull at
 * degree 3 and up, and **extra rings along each edge whose count depends on
 * length over radius**. The constants behind that last part are code, not
 * geometry, so they were read from `MOD_skin.cc` and then checked against
 * the probe:
 *
 * | rule | from the source | measured |
 * |---|---|---|
 * | rings per edge | `int(L / (r̄₀ + r̄₁))`, `r̄` = mean of a vertex's two radii | L=1, r=0.25 → 2 ✓; r=0.5 → 1 ✓; L=√3 → 3 ✓ |
 * | where ring `j` of `n` sits | `t = ((j+1)/(n+1))^k`, `k = (r̄₁/r̄₀ + 1)/2` | radii 0.5 → 0.1: z = 0.65975 = 0.5^0.6 ✓ |
 * | its radius | `lerp(r₀, r₁, t)` | 0.2361 ✓ |
 *
 * The rest of the chain — how each edge's frame is oriented, how it turns at
 * a bend, how a cap decides its winding — is `build_edge_mats`,
 * `connection_node_frames`, `end_node_frames` and `connect_frames`, ported
 * line for line, including Blender's `angle_normalized_v3v3`.
 *
 * ## The root decides the answer
 *
 * Frames are oriented by a depth-first walk **from the root vertex**: an edge
 * leaving the root gets a fresh basis (its direction, then `z × x`), and every
 * edge after it inherits its parent's basis turned by the bend between them.
 * So the same skeleton with a different root is a different mesh — measured:
 * a straight chain of three is 28 vertices with the root at an end and 32
 * with it in the middle, where both edges leave the root and the node gets
 * two frames bridged together (Blender's `SEAM_FRAME`) instead of one.
 *
 * **The default root is not Blender's.** Blender marks vertex 0 and nothing
 * else (`BKE_mesh_ensure_skin_customdata`: "mark an arbitrary vertex as
 * root"), so every connected piece but the first has no root, its edges keep
 * a zero matrix, and its frames collapse to points. Here the default is the
 * lowest-numbered vertex of **each** piece. For a skeleton in one piece the
 * two agree.
 *
 * ## Branch nodes: a hull, then triangles merged into quads
 *
 * A vertex with three or more edges gets no frame of its own. Its
 * neighbours' frames are wrapped in a **convex hull** (Bullet's, ported in
 * `../hull/bullet-hull.ts`, because which of several equal hulls comes out is
 * decided by its integer grid), the two triangles filling each frame are cut
 * away, and afterwards every pair of triangles that makes a flat, convex,
 * X-symmetric quad is merged — greedily, best score first, from a heap.
 *
 * Which pair wins a tie depends on **the order BMesh keeps things in**: slots
 * reused last-freed-first, the newest face first around an edge, faces
 * deleted before edges. So this runs on a small BMesh (`skin-bmesh.ts`) that
 * keeps those orders, rather than on arrays.
 *
 * **Frames the hull swallows.** When a frame's corner ends up inside the
 * hull, or one of its sides is not a hull edge, Blender takes the frame off
 * the hull, picks the face its normal ray hits, and extrudes that face and
 * welds it onto the frame (`skin_fix_hull_topology`). That runs here as the
 * operators themselves — extrude, subdivide, weld — because with frames that
 * overlap, the weld collapses faces and a leftover edge tag later deletes
 * three more (see `bridgeFaceToFrame`); only the operators say which. Not
 * ported: a target face of five or more corners, which Blender first
 * collapses to four (`collapse_face_corners`); this caps the frame instead.
 *
 * **In float32.** Blender builds the frames in `float`, and at a branch that
 * decides the answer — see the note above the math helpers.
 */
import type { MeshData } from "../../lib/mesh";
import { type BEdge, type BFace, type BVert, HeapSimple, MiniBMesh, dotF, isQuadConvex } from "./skin-bmesh";

type Vec3 = [number, number, number];
type Mat3 = [Vec3, Vec3, Vec3];

export interface SkinOptions {
  /**
   * Blender's `skin_modifier_radius` — per vertex, `[x, y]` across the edge's
   * two cross axes. One number or one pair applies to every vertex; an array
   * gives one per input vertex. Default 0.25, Blender's.
   */
  radius?: number | readonly [number, number] | readonly (readonly [number, number])[];
  /**
   * Blender's `skin_modifier_root`. Default: the lowest-numbered vertex of
   * each connected piece — see the note at the top of this file for why that
   * is not quite Blender's default.
   */
  roots?: Iterable<number>;
  /**
   * Blender's `symmetry_axes` — `[x, y, z]`. A quad merged at a branch hull
   * that crosses one of these planes is kept only if it is mirror-symmetric
   * across it, and then preferred. Default X only, Blender's.
   */
  symmetry?: readonly [boolean, boolean, boolean];
}

// ── float32, in Blender's order ─────────────────────────────────────────────
//
// Blender builds the frames in `float`, and at a branch node that is not
// noise: the hull's four-sided faces are fanned from Bullet's first corner,
// and whether four corners are coplanar at all is decided on Bullet's integer
// grid. Computed in double, the tripod's hull split one quad along the other
// diagonal (measured on the `skin-branch` row). So every step below rounds
// to float32 where the C does, in the C's evaluation order.

const f32 = Math.fround;
const FLT_EPSILON = 1.1920929e-7;

const sub = (a: Vec3, b: Vec3): Vec3 => [f32(a[0] - b[0]), f32(a[1] - b[1]), f32(a[2] - b[2])];
const add = (a: Vec3, b: Vec3): Vec3 => [f32(a[0] + b[0]), f32(a[1] + b[1]), f32(a[2] + b[2])];
const scale = (a: Vec3, k: number): Vec3 => [f32(a[0] * k), f32(a[1] * k), f32(a[2] * k)];
const dot = (a: Vec3, b: Vec3): number => f32(f32(f32(a[0] * b[0]) + f32(a[1] * b[1])) + f32(a[2] * b[2]));
const cross = (a: Vec3, b: Vec3): Vec3 => [
  f32(f32(a[1] * b[2]) - f32(a[2] * b[1])),
  f32(f32(a[2] * b[0]) - f32(a[0] * b[2])),
  f32(f32(a[0] * b[1]) - f32(a[1] * b[0])),
];
const len = (a: Vec3): number => f32(Math.sqrt(dot(a, a)));

/** Blender's `normalize_v3`: times `1 / length`; a zero vector stays zero. */
function normalize(a: Vec3): Vec3 {
  const d = dot(a, a);
  return d > 1e-35 ? scale(a, f32(1 / f32(Math.sqrt(d)))) : [0, 0, 0];
}

/** `saasin`: `asinf`, clamped. */
const saasin = (x: number): number => (x <= -1 ? f32(-Math.PI / 2) : x >= 1 ? f32(Math.PI / 2) : f32(Math.asin(x)));

/**
 * Blender's `angle_normalized_v3v3` — the `asin` form, which is what keeps
 * nearly parallel vectors from losing precision the way `acos(dot)` does.
 */
function angleNormalized(a: Vec3, b: Vec3): number {
  if (dot(a, b) >= 0) return f32(2 * saasin(f32(len(sub(a, b)) / 2)));
  const nb: Vec3 = [-b[0], -b[1], -b[2]];
  return f32(f32(Math.PI) - f32(2 * saasin(f32(len(sub(a, nb)) / 2))));
}

/** Blender's `rotate_normalized_v3_v3v3fl` — Rodrigues about a unit axis. */
function rotate(p: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = f32(Math.cos(angle));
  const s = f32(Math.sin(angle));
  const [x, y, z] = axis;
  const k = f32(1 - c);
  const m = (u: number, v: number): number => f32(f32(k * u) * v);
  const row = (a: number, b: number, cc: number): number =>
    f32(f32(f32(a * p[0]) + f32(b * p[1])) + f32(cc * p[2]));
  return [
    row(f32(c + m(x, x)), f32(m(x, y) - f32(z * s)), f32(m(x, z) + f32(y * s))),
    row(f32(m(x, y) + f32(z * s)), f32(c + m(y, y)), f32(m(y, z) - f32(x * s))),
    row(f32(m(x, z) - f32(y * s)), f32(m(y, z) + f32(x * s)), f32(c + m(z, z))),
  ];
}

/** Blender's `normal_quad_v3`: the cross of the two diagonals. */
function normalQuad(a: Vec3, b: Vec3, c: Vec3, d: Vec3): Vec3 {
  return normalize(cross(sub(a, c), sub(b, d)));
}

/** `calc_edge_mat`: x along the edge, y = z_up × x, z = x × y. */
function edgeMat(a: Vec3, b: Vec3): Mat3 {
  const x = normalize(sub(b, a));
  const d = dot(x, [0, 0, 1]);
  if (d > f32(-1 + FLT_EPSILON) && d < f32(1 - FLT_EPSILON)) {
    const y = normalize(cross([0, 0, 1], x));
    const z = normalize(cross(x, y));
    return [x, y, z];
  }
  // Straight up or down: a fixed basis, as Blender does.
  return [x, [1, 0, 0], [0, 1, 0]];
}

const half = (r: readonly [number, number]): number => f32(f32(r[0] + r[1]) * 0.5);

/** The four corners of a frame, in Blender's `create_frame` order. */
function frame(co: Vec3, r: readonly [number, number], m: Mat3, offset: number): Vec3[] {
  const ry = scale(m[1], r[0]);
  const rz = scale(m[2], r[1]);
  const rx = scale(m[0], offset);
  return [
    add(sub(add(co, ry), rz), rx),
    add(sub(sub(co, ry), rz), rx),
    add(add(sub(co, ry), rz), rx),
    add(add(add(co, ry), rz), rx),
  ];
}

/** `interp_v3_v3v3`: `(1 − t)·a + t·b`. */
const lerp = (a: readonly number[], b: readonly number[], t: number): number[] => {
  const s = f32(1 - t);
  return a.map((x, i) => f32(f32(s * x) + f32(t * b[i]!)));
};

interface Skeleton {
  positions: Vec3[];
  radius: [number, number][];
  root: boolean[];
  edges: [number, number][];
}

/**
 * Blender's `subdivide_base`: extra vertices along each edge, appended after
 * the originals, and each edge replaced by the chain through them.
 */
function subdivide(sk: Skeleton): Skeleton {
  const n = sk.positions.length;
  const degree = new Array<number>(n).fill(0);
  for (const [a, b] of sk.edges) {
    degree[a]!++;
    degree[b]!++;
  }
  const positions = sk.positions.map((p) => p.map(f32) as Vec3);
  const radius = sk.radius.map((r) => r.map(f32) as [number, number]);
  const root = [...sk.root];
  const edges: [number, number][] = [];
  for (const [a, b] of sk.edges) {
    const branchA = degree[a]! > 2;
    const branchB = degree[b]! > 2;
    const avg = f32(half(radius[a]!) + half(radius[b]!));
    let count = 0;
    if (avg !== 0) count = Math.min(128, Math.trunc(f32(len(sub(positions[a]!, positions[b]!)) / avg)));
    // Two branch nodes need two frames between them (Blender's comment:
    // "avoids any special cases for sharing a frame between two hulls").
    if (count < 2 && branchA && branchB) count = 2;

    let k = f32(half(radius[b]!) / half(radius[a]!));
    k = Number.isFinite(k) ? f32(f32(k + 1) / 2) : 1;

    let u = a;
    for (let j = 0; j < count; j++) {
      const t = f32(Math.pow(f32((j + 1) / (count + 1)), k));
      positions.push(lerp(positions[a]!, positions[b]!, t) as Vec3);
      radius.push(lerp(radius[a]!, radius[b]!, t) as [number, number]);
      root.push(false);
      const v = positions.length - 1;
      edges.push([u, v]);
      u = v;
    }
    edges.push([u, b]);
  }
  return { positions, radius, root, edges };
}

interface EMat {
  mat: Mat3;
  origin: number;
}

/**
 * Blender's `build_edge_mats`: a depth-first walk from each root, with the
 * same stack discipline, so that which endpoint is an edge's origin — and so
 * which way its frame faces — comes out the same.
 */
function edgeMats(sk: Skeleton, emap: number[][]): EMat[] {
  const zero: Mat3 = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const emat: EMat[] = sk.edges.map(() => ({ mat: zero, origin: 0 }));
  const visited = new Array<boolean>(sk.edges.length).fill(false);
  const stack: { mat: Mat3; parent: number; e: number }[] = [];
  const other = (e: number, v: number): number => (sk.edges[e]![0] === v ? sk.edges[e]![1] : sk.edges[e]![0]);

  for (let v = 0; v < sk.positions.length; v++) {
    if (!sk.root[v] || emap[v]!.length === 0) continue;
    const mat = edgeMat(sk.positions[v]!, sk.positions[other(emap[v]![0]!, v)]!);
    for (const e of emap[v]!) stack.push({ mat, parent: v, e });
  }

  while (stack.length > 0) {
    const { mat: parentMat, parent, e } = stack.pop()!;
    if (visited[e]) continue;
    visited[e] = true;
    const branch = emap[parent]!.length > 2 || sk.root[parent];
    const v = other(e, parent);
    let mat: Mat3;
    if (branch) mat = edgeMat(sk.positions[parent]!, sk.positions[v]!);
    else {
      const x = normalize(sub(sk.positions[v]!, sk.positions[parent]!));
      const angle = angleNormalized(parentMat[0], x);
      const axis = normalize(cross(parentMat[0], x));
      mat = [x, rotate(parentMat[1], axis, angle), rotate(parentMat[2], axis, angle)];
    }
    emat[e] = { mat, origin: parent };
    for (const next of emap[v]!) stack.push({ mat, parent: v, e: next });
  }
  return emat;
}

/** Blender's `Frame`: four corners, and what the branch hulls did to them. */
interface Frame {
  co: Vec3[];
  verts: BVert[];
  /** A corner merged into another frame's corner shares its vertex. */
  merge: { frame: Frame | null; corner: number; isTarget: boolean }[];
  insideHull: boolean[];
  /** Some corner or side ended up inside a hull. */
  detached: boolean;
}

const newFrame = (co: Vec3[]): Frame => ({
  co,
  verts: [],
  merge: co.map(() => ({ frame: null, corner: 0, isTarget: false })),
  insideHull: [false, false, false, false],
  detached: false,
});

interface Node {
  frames: Frame[];
  capStart: boolean;
  capEnd: boolean;
  flipNormal: boolean;
  seam: boolean;
  seamEdges: [number, number];
}

function buildNodes(sk: Skeleton, emap: number[][], emat: EMat[]): Node[] {
  const nodes: Node[] = [];
  for (let v = 0; v < sk.positions.length; v++) {
    const node: Node = {
      frames: [],
      capStart: false,
      capEnd: false,
      flipNormal: false,
      seam: false,
      seamEdges: [-1, -1],
    };
    const co = sk.positions[v]!;
    const rad = sk.radius[v]!;
    const edges = emap[v]!;

    if (edges.length === 0) {
      // A lone vertex: a box, two frames on a fixed basis.
      const avg = half(rad);
      const m: Mat3 = [
        [0, 0, 1],
        [1, 0, 0],
        [0, 1, 0],
      ];
      node.frames = [newFrame(frame(co, rad, m, avg)), newFrame(frame(co, rad, m, -avg))];
      node.capStart = node.capEnd = true;
    } else if (edges.length === 1) {
      const e = emat[edges[0]!]!;
      const m: Mat3 = [
        e.origin !== v ? scale(e.mat[0], -1) : e.mat[0],
        e.mat[1],
        e.mat[2],
      ];
      const f = frame(co, rad, m, 0);
      node.frames = [newFrame(f)];
      node.capStart = true;
      // The cap's winding is chosen against the edge direction.
      if (dot(m[0], normalQuad(f[0]!, f[1]!, f[2]!, f[3]!)) < 0) node.flipNormal = true;
    } else if (edges.length === 2) {
      const e1 = emat[edges[0]!]!;
      const e2 = emat[edges[1]!]!;
      let ine: Mat3 | null = null;
      let oute: Mat3 | null = null;
      if (e1.origin !== v && e2.origin === v) {
        ine = e1.mat;
        oute = e2.mat;
      } else if (e1.origin === v && e2.origin !== v) {
        ine = e2.mat;
        oute = e1.mat;
      }
      if (ine && oute) {
        // Turn the incoming frame half-way toward the outgoing edge.
        const angle = f32(angleNormalized(ine[0], oute[0]) / 2);
        const axis = normalize(cross(ine[0], oute[0]));
        const m: Mat3 = [ine[0], rotate(ine[1], axis, angle), rotate(ine[2], axis, angle)];
        node.frames = [newFrame(frame(co, rad, m, 0))];
      } else {
        // Both edges leave (or both arrive) — the root in the middle of a
        // chain. Two frames, bridged to each other; Blender's `SEAM_FRAME`.
        const avg = half(rad);
        const m1: Mat3 = [e1.origin !== v ? scale(e1.mat[0], -1) : e1.mat[0], e1.mat[1], e1.mat[2]];
        const m2: Mat3 = [e2.origin !== v ? scale(e2.mat[0], -1) : e2.mat[0], e2.mat[1], e2.mat[2]];
        node.frames = [newFrame(frame(co, rad, m1, avg)), newFrame(frame(co, rad, m2, avg))];
        node.seam = true;
        node.seamEdges = [edges[0]!, edges[1]!];
      }
    }
    // Degree 3 and up: a branch node, no frame — its neighbours' are hulled.
    nodes.push(node);
  }
  return nodes;
}

/** Blender's `skin_choose_quad_bridge_order`: the rotation or reflection with the shortest total. */
function bridgeOrder(a: readonly Vec3[], b: readonly Vec3[]): number[] {
  let best: number[] = [0, 1, 2, 3];
  let shortest = Infinity;
  for (let i = 0; i < 8; i++) {
    const order = [0, 1, 2, 3].map((j) => (i < 4 ? (j + i) % 4 : 3 - ((j + (i - 4)) % 4)));
    let total = 0;
    for (let j = 0; j < 4; j++) {
      const d = sub(a[j]!, b[order[j]!]!);
      total = f32(total + dot(d, d));
    }
    if (total < shortest) {
      shortest = total;
      best = order;
    }
  }
  return best;
}

// ── branch hulls ────────────────────────────────────────────────────────────

/** `collect_hull_frames`: the first frame of each neighbour that has one. */
function hullFrames(v: number, nodes: readonly Node[], emap: readonly number[][], edges: readonly [number, number][]): Frame[] {
  const out: Frame[] = [];
  for (const e of emap[v]!) {
    const [a, b] = edges[e]!;
    const n = nodes[a === v ? b : a]!;
    if (n.frames.length > 0) out.push(n.frames[0]!);
  }
  return out;
}

/**
 * `merge_frame_corners`: corners of two frames closer than half the smaller
 * frame's side become one vertex, at their midpoint. A corner merged into
 * is never merged away, so there are no chains.
 */
function mergeFrameCorners(frames: readonly Frame[]): void {
  const sideOf = (fr: Frame): number => f32(f32(len(sub(fr.co[0]!, fr.co[1]!)) + len(sub(fr.co[1]!, fr.co[2]!))) * 0.5);
  for (let i = 0; i < frames.length; i++) {
    const a = frames[i]!;
    const sideA = sideOf(a);
    for (let j = 0; j < 4; j++) {
      if (a.merge[j]!.frame) continue;
      for (let k = i + 1; k < frames.length; k++) {
        const b = frames[k]!;
        const thresh = f32(Math.min(sideA, sideOf(b)) / 2);
        for (let l = 0; l < 4; l++) {
          if (b.merge[l]!.frame || b.merge[l]!.isTarget) continue;
          if (len(sub(a.co[j]!, b.co[l]!)) < thresh) {
            const mid = scale(add(a.co[j]!, b.co[l]!), 0.5);
            a.co[j] = mid;
            b.co[l] = [...mid];
            b.merge[l] = { frame: a, corner: j, isTarget: false };
            a.merge[j]!.isTarget = true;
            break;
          }
        }
      }
    }
  }
}

/**
 * `build_hull`: hull the frames' corners, find the frames that ended up
 * inside, and cut away the two triangles that fill each frame that did not.
 */
function buildHull(bm: MiniBMesh, frames: readonly Frame[]): boolean {
  for (const v of bm.verts) v.tag = false;
  for (const fr of frames) for (const v of fr.verts) v.tag = true;
  // `input=%hv` reads the tagged vertices in slot order.
  const hull = bm.convexHull([...bm.verts].filter((v) => v.tag));
  if (!hull) return false;

  for (const v of hull.interior)
    for (const fr of frames) {
      if (fr.detached) continue;
      const j = fr.verts.indexOf(v);
      if (j >= 0) {
        fr.insideHull[j] = true;
        fr.detached = true;
      }
    }
  for (const fr of frames) {
    if (fr.detached) continue;
    for (let j = 0; j < 4; j++) if (!bm.edgeExists(fr.verts[j]!, fr.verts[(j + 1) % 4]!)) fr.detached = true;
  }

  bm.clearTags();
  for (const fr of frames) {
    if (fr.detached) continue;
    const diag = bm.edgeExists(fr.verts[0]!, fr.verts[2]!) ?? bm.edgeExists(fr.verts[1]!, fr.verts[3]!);
    const pair = diag ? bm.edgeFacePair(diag) : null;
    if (pair) {
      pair[0].tag = true;
      pair[1].tag = true;
    } else fr.detached = true;
  }
  // An edge left with no face once the fill is gone goes too.
  for (const e of hull.geomEdges) if (bm.edgeFaces(e).every((face) => face.tag)) e.tag = true;
  bm.deleteTaggedEdgesFaces();
  return true;
}

// ── merging hull triangles into quads ──────────────────────────────────────

/** `quad_from_tris`: the first triangle's corners, the second's far corner slotted in across `e`. */
function quadFromTris(bm: MiniBMesh, e: BEdge, adj: [BFace, BFace]): BVert[] {
  const t0 = bm.faceVerts(adj[0]);
  const t1 = bm.faceVerts(adj[1]);
  const opp = t1.find((v) => !t0.includes(v))!;
  const out: BVert[] = [];
  for (let i = 0; i < 3; i++) {
    out.push(t0[i]!);
    const a = t0[i]!;
    const b = t0[(i + 1) % 3]!;
    if ((a === e.v1 || a === e.v2) && (b === e.v1 || b === e.v2)) out.push(opp);
  }
  return out;
}


/** `quad_crosses_symmetry_plane`. */
function crossesSymmetry(quad: readonly BVert[], axes: readonly boolean[]): boolean {
  for (let axis = 0; axis < 3; axis++) {
    if (!axes[axis]) continue;
    let left = false;
    let right = false;
    for (const v of quad) {
      if (v.co[axis]! < 0) left = true;
      else if (v.co[axis]! > 0) right = true;
      if (left && right) return true;
    }
  }
  return false;
}

/** `is_quad_symmetric`: corner 0 mirrors onto 1 and 2 onto 3, or 0 onto 3 and 2 onto 1. */
function isSymmetric(quad: readonly BVert[], axes: readonly boolean[]): boolean {
  const t2 = f32(f32(0.0001) * f32(0.0001));
  const mirrorClose = (p: BVert, q: BVert, axis: number): boolean => {
    const a = [...p.co];
    a[axis] = -a[axis]!;
    let d = 0;
    for (let i = 0; i < 3; i++) {
      const x = f32(a[i]! - q.co[i]!);
      d = f32(d + f32(x * x));
    }
    return d < t2;
  };
  for (let axis = 0; axis < 3; axis++) {
    if (!axes[axis]) continue;
    if (mirrorClose(quad[0]!, quad[1]!, axis)) {
      if (mirrorClose(quad[2]!, quad[3]!, axis)) return true;
    } else if (mirrorClose(quad[0]!, quad[3]!, axis)) {
      if (mirrorClose(quad[2]!, quad[1]!, axis)) return true;
    }
  }
  return false;
}

/**
 * `hull_merge_triangles`: every edge between two triangles is a candidate
 * quad, scored by area times how coplanar the two are (×10 if it is a
 * symmetric quad across a symmetry plane; dropped if it crosses one without
 * being symmetric, or is concave). Best first; a triangle is used once.
 */
function mergeTriangles(bm: MiniBMesh, axes: readonly boolean[]): void {
  const heap = new HeapSimple<BEdge>();
  for (const face of bm.faces) face.tag = false;
  for (const e of bm.edges) {
    const adj = bm.edgeFacePair(e);
    if (!adj || adj[0].len !== 3 || adj[1].len !== 3) continue;
    const quad = quadFromTris(bm, e, adj);
    let score = f32(f32(bm.faceArea(adj[0]) + bm.faceArea(adj[1])) * dotF(adj[0].no, adj[1].no));
    if (crossesSymmetry(quad, axes)) {
      if (isSymmetric(quad, axes)) score = f32(score * 10);
      else continue;
    }
    if (!isQuadConvex(quad[0]!.co, quad[1]!.co, quad[2]!.co, quad[3]!.co)) continue;
    heap.insert(-score, e);
  }
  while (!heap.isEmpty()) {
    const e = heap.popMin();
    const adj = bm.edgeFacePair(e);
    if (!adj || adj[0].tag || adj[1].tag || bm.faceShareFaceCheck(adj[0], adj[1])) continue;
    bm.faceCreateVerts(quadFromTris(bm, e, adj));
    adj[0].tag = true;
    adj[1].tag = true;
    e.tag = true;
  }
  bm.deleteTaggedEdgesFaces();
}

// ── frames the hull swallowed ──────────────────────────────────────────────

/** `len_squared_v3v3`. */
const lenSq = (a: Vec3, b: Vec3): number => {
  const d = sub(a, b);
  return dot(d, d);
};

/** `isect_ray_tri_v3`, in float: the distance along the ray, or null. */
function isectRayTri(o: Vec3, d: Vec3, v0: Vec3, v1: Vec3, v2: Vec3): number | null {
  const eps = f32(0.00000001);
  const e1 = sub(v1, v0);
  const e2 = sub(v2, v0);
  const p = cross(d, e2);
  const a = dotF(e1, p);
  if (a > -eps && a < eps) return null;
  const fa = f32(1 / a);
  const s = sub(o, v0);
  const u = f32(fa * dotF(s, p));
  if (u < 0 || u > 1) return null;
  const q = cross(s, e1);
  const v = f32(fa * dotF(d, q));
  if (v < 0 || f32(u + v) > 1) return null;
  const lambda = f32(fa * dotF(e2, q));
  return lambda < 0 ? null : lambda;
}

/**
 * `skin_hole_target_face`: the face the frame's normal ray hits first — or
 * the face whose centre is nearest, if that is much nearer than the hit.
 */
function holeTargetFace(bm: MiniBMesh, fr: Frame): BFace | null {
  const c = fr.verts.map((v) => v.co);
  let center: Vec3 = [f32(c[0]![0] + c[1]![0]), f32(c[0]![1] + c[1]![1]), f32(c[0]![2] + c[1]![2])];
  for (const k of [2, 3]) center = [f32(center[0] + c[k]![0]), f32(center[1] + c[k]![1]), f32(center[2] + c[k]![2])];
  center = [f32(center[0] * 0.25), f32(center[1] * 0.25), f32(center[2] * 0.25)];
  const normal = normalQuad(c[3]!, c[2]!, c[1]!, c[0]!);

  let isectFace: BFace | null = null;
  let centerFace: BFace | null = null;
  let bestIsect = 3.4028234663852886e38;
  let bestCenter = 3.4028234663852886e38;
  for (const face of bm.faces) {
    const vs = bm.faceVerts(face);
    // `isect_ray_poly`: a fan from the first corner, the nearest hit.
    let hit = 3.4028234663852886e38;
    let any = false;
    for (let k = 2; k < vs.length; k++) {
      const t = isectRayTri(center, normal, vs[0]!.co, vs[k - 1]!.co, vs[k]!.co);
      if (t !== null && t < hit) {
        hit = t;
        any = true;
      }
    }
    if (any && hit < bestIsect) {
      isectFace = face;
      bestIsect = hit;
    }
    // `BM_face_calc_center_median`
    let m: Vec3 = [0, 0, 0];
    for (const v of vs) m = [f32(m[0] + v.co[0]), f32(m[1] + v.co[1]), f32(m[2] + v.co[2])];
    const inv = f32(1 / vs.length);
    m = [f32(m[0] * inv), f32(m[1] * inv), f32(m[2] * inv)];
    const dist = f32(Math.sqrt(lenSq(center, m)));
    if (dist < bestCenter) {
      centerFace = face;
      bestCenter = dist;
    }
  }
  return !isectFace || bestCenter < f32(bestIsect / 2) ? centerFace : isectFace;
}

/**
 * `skin_fix_hole_no_good_verts`: extrude the target face, and weld the
 * extruded copy's corners onto the frame's — which leaves one side face per
 * rim edge, from the hull to the frame.
 *
 * Run as the operators themselves (`extrude_discrete_faces`,
 * `subdivide_edges`, `weld_verts` on the small BMesh), not as their usual
 * result: when frames overlap, a weld can collapse a side face or refuse to
 * make one and leave its edge loose, and only the operators say which.
 *
 * A triangle is given a fourth corner first: Blender splits the longest edge
 * of the **copy** (the last of the longest), so the midpoint is welded away
 * with the rest and one side face becomes a pentagon. False for a face of
 * five or more — Blender collapses its shortest edges first, not ported.
 */
function bridgeFaceToFrame(bm: MiniBMesh, fr: Frame, target: BFace): boolean {
  if (target.len > 4) return false;
  const face = bm.extrudeDiscreteFace(target);
  if (face.len === 3) {
    // `BM_face_find_longest_loop`
    let longest = bm.faceLoops(face)[0]!;
    let best = 0;
    for (const l of bm.faceLoops(face)) {
      const d = lenSq(l.v.co, l.next.v.co);
      if (d >= best) {
        best = d;
        longest = l;
      }
    }
    // Blender picks the edge for `subdivide_edges` by tagging it — and never
    // clears the tag. Both halves keep it, the weld hands it to the frame's
    // edges, and the last `hull_merge_triangles` deletes every tagged edge
    // with the faces on it. Kept, because that is Blender's mesh (measured
    // on `skelStar8`: three faces gone and one loose edge left).
    for (const e of bm.edges) e.tag = false;
    longest.e.tag = true;
    const a = longest.e.v1.co;
    const b = longest.e.v2.co;
    bm.edgeSplit(longest.e, [0, 1, 2].map((k) => f32(f32(0.5 * a[k]!) + f32(0.5 * b[k]!))));
  }
  const quad = bm.faceVerts(face);
  const order = bridgeOrder(quad.map((v) => v.co), fr.verts.map((v) => v.co));
  bm.faceKill(face);
  bm.weldVerts(new Map(quad.map((v, i) => [v, fr.verts[order[i]!]!])));
  return true;
}

/**
 * `skin_fix_hull_topology`: a frame with a corner or side inside its hull is
 * taken off the hull (its hull corners duplicated) and joined to the face it
 * looks at — or, failing that, just capped.
 */
function fixHullTopology(bm: MiniBMesh, nodes: readonly Node[]): void {
  for (const node of nodes)
    for (const fr of node.frames) {
      if (!fr.detached) continue;
      const target = holeTargetFace(bm, fr);
      // A hull corner the frame already shares would give a zero-length edge.
      const coincident =
        target !== null && !fr.insideHull.some(Boolean) && bm.faceVerts(target).some((v) => fr.verts.includes(v));
      // `skin_hole_detach_partially_attached_frame`
      for (let j = 0; j < 4; j++) if (!fr.insideHull[j]) fr.verts[j] = bm.vertCreate(fr.verts[j]!.co);
      if (target && !coincident && bridgeFaceToFrame(bm, fr, target)) continue;
      bm.faceCreateVerts(fr.verts);
    }
}

/**
 * Blender's `skin` modifier on a skeleton of loose edges.
 *
 * ```ts
 * skin({ positions, polys: [], edges: [[0, 1], [1, 2]] });
 * skin(skeleton, { radius: [[0.5, 0.5], [0.1, 0.1]] });
 * skin(skeleton, { roots: [1] });
 * ```
 *
 * Vertices with three or more edges are hulled. The result can carry loose
 * `edges` where Blender's does — only when frames at a branch overlap.
 */
export function skin(data: MeshData, options: SkinOptions = {}): MeshData {
  if (data.polys.length > 0)
    throw new Error("skin: the input should be a skeleton of loose edges, not a surface");
  const count = data.positions.length / 3;
  const positions: Vec3[] = [];
  for (let v = 0; v < count; v++)
    positions.push([data.positions[v * 3]!, data.positions[v * 3 + 1]!, data.positions[v * 3 + 2]!]);
  const edges = (data.edges ?? []).map((e) => [e[0]!, e[1]!] as [number, number]);

  const r = options.radius ?? 0.25;
  const radius: [number, number][] = [];
  for (let v = 0; v < count; v++) {
    if (typeof r === "number") radius.push([r, r]);
    else if (typeof r[0] === "number") radius.push([r[0] as number, r[1] as number]);
    else {
      const each = (r as readonly (readonly [number, number])[])[v];
      if (!each) throw new Error(`skin: no radius given for vertex ${v}`);
      radius.push([each[0], each[1]]);
    }
  }
  const axes = options.symmetry ?? [true, false, false];

  const root = new Array<boolean>(count).fill(false);
  if (options.roots) for (const v of options.roots) root[v] = true;
  else {
    // The lowest vertex of each connected piece.
    const parent = [...Array(count).keys()];
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)));
    for (const [a, b] of edges) {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
    }
    for (let v = 0; v < count; v++) if (find(v) === v) root[v] = true;
  }

  const sk = subdivide({ positions, radius, root, edges });
  const emap: number[][] = sk.positions.map(() => []);
  sk.edges.forEach(([a, b], e) => {
    emap[a]!.push(e);
    emap[b]!.push(e);
  });
  const emat = edgeMats(sk, emap);
  const nodes = buildNodes(sk, emap, emat);
  const isBranch = (v: number): boolean => nodes[v]!.frames.length === 0;

  // `build_skin`, step by step.
  const bm = new MiniBMesh();
  for (let v = 0; v < nodes.length; v++) if (isBranch(v)) mergeFrameCorners(hullFrames(v, nodes, emap, sk.edges));
  // `output_frames`: one vertex per corner, in node order, merged corners skipped.
  for (const node of nodes)
    for (const fr of node.frames)
      for (let j = 0; j < 4; j++) if (!fr.merge[j]!.frame) fr.verts[j] = bm.vertCreate(fr.co[j]!);
  // `skin_update_merged_vertices`
  for (const node of nodes)
    for (const fr of node.frames)
      for (let j = 0; j < 4; j++) {
        const m = fr.merge[j]!;
        if (m.frame) fr.verts[j] = m.frame.verts[m.corner]!;
      }

  for (let v = 0; v < nodes.length; v++) if (isBranch(v)) buildHull(bm, hullFrames(v, nodes, emap, sk.edges));
  // Merged first, so a swallowed frame has quads to join onto.
  mergeTriangles(bm, axes);
  fixHullTopology(bm, nodes);

  /** Blender's `connect_frames`: four quads, wound by the summed orientation. */
  const connect = (f1: readonly BVert[], f2: readonly BVert[]): void => {
    const q = [
      [f2[0]!, f2[1]!, f1[1]!, f1[0]!],
      [f2[1]!, f2[2]!, f1[2]!, f1[1]!],
      [f2[2]!, f2[3]!, f1[3]!, f1[2]!],
      [f2[3]!, f2[0]!, f1[0]!, f1[3]!],
    ];
    const mid4 = (quad: BVert[]): Vec3 => {
      let c: Vec3 = [0, 0, 0];
      for (const x of quad) c = add(c, x.co);
      return scale(c, 0.25);
    };
    const sides = q.map(mid4);
    const cent = scale(add(add(add(sides[0]!, sides[1]!), sides[2]!), sides[3]!), 0.25);
    let d = 0;
    for (let i = 0; i < 4; i++) {
      const n = normalQuad(q[i]![0]!.co, q[i]![1]!.co, q[i]![2]!.co, q[i]![3]!.co);
      d = f32(d + dot(n, sub(cent, sides[i]!)));
    }
    for (const quad of q) bm.faceCreateVerts(d > 0 ? [quad[3]!, quad[2]!, quad[1]!, quad[0]!] : quad);
  };

  // End nodes and seams — `skin_output_end_nodes`.
  for (const node of nodes) {
    const fv = node.frames.map((fr) => fr.verts);
    if (node.seam) {
      const order = bridgeOrder(fv[0]!.map((v) => v.co), fv[1]!.map((v) => v.co));
      connect(fv[0]!, order.map((i) => fv[1]![i]!));
    } else if (fv.length === 2) connect(fv[0]!, fv[1]!);
    if (node.capStart) {
      const x = fv[0]!;
      bm.faceCreateVerts(node.flipNormal ? [x[0]!, x[1]!, x[2]!, x[3]!] : [x[3]!, x[2]!, x[1]!, x[0]!]);
    }
    if (node.capEnd) {
      const x = fv[1]!;
      bm.faceCreateVerts([x[0]!, x[1]!, x[2]!, x[3]!]);
    }
  }

  // One tube segment per edge — `skin_output_connections`.
  sk.edges.forEach(([a, b], e) => {
    const na = nodes[a]!;
    const nb = nodes[b]!;
    if (na.frames.length === 0 || nb.frames.length === 0) return;
    if (na.seam || nb.seam) {
      const ia = na.seam && e !== na.seamEdges[0] ? 1 : 0;
      const ib = nb.seam && e !== nb.seamEdges[0] ? 1 : 0;
      const fa = na.frames[ia]!.verts;
      const fb = nb.frames[ib]!.verts;
      const order = bridgeOrder(fa.map((v) => v.co), fb.map((v) => v.co));
      connect(fa, order.map((i) => fb[i]!));
    } else connect(na.frames[0]!.verts, nb.frames[0]!.verts);
  });
  mergeTriangles(bm, axes);

  return bm.toMeshData();
}

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
 * ## Not yet: branch nodes
 *
 * A vertex with three or more edges gets no frame of its own. Blender builds a
 * **convex hull** of the neighbouring frames, merges its triangles into quads
 * with a symmetry heuristic, then repairs the topology where a frame ended up
 * inside the hull — about 800 lines of `MOD_skin.cc`. This file stops before
 * that and throws on degree ≥ 3, rather than returning something plausible.
 */
import type { MeshData } from "../../lib/mesh";

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
}

const FLT_EPSILON = 1.1920929e-7;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

/** Blender's `normalize_v3`: a zero vector stays zero. */
function normalize(a: Vec3): Vec3 {
  const l = len(a);
  return l > 1e-35 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

/**
 * Blender's `angle_normalized_v3v3` — the `asin` form, which is what keeps
 * nearly parallel vectors from losing precision the way `acos(dot)` does.
 */
function angleNormalized(a: Vec3, b: Vec3): number {
  if (dot(a, b) >= 0) return 2 * Math.asin(Math.min(1, len(sub(a, b)) / 2));
  return Math.PI - 2 * Math.asin(Math.min(1, len(add(a, b)) / 2));
}

/** Blender's `rotate_normalized_v3_v3v3fl` — Rodrigues about a unit axis. */
function rotate(p: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const [x, y, z] = axis;
  return [
    (c + (1 - c) * x * x) * p[0] + ((1 - c) * x * y - z * s) * p[1] + ((1 - c) * x * z + y * s) * p[2],
    ((1 - c) * x * y + z * s) * p[0] + (c + (1 - c) * y * y) * p[1] + ((1 - c) * y * z - x * s) * p[2],
    ((1 - c) * x * z - y * s) * p[0] + ((1 - c) * y * z + x * s) * p[1] + (c + (1 - c) * z * z) * p[2],
  ];
}

/** Blender's `normal_quad_v3`: the cross of the two diagonals. */
function normalQuad(a: Vec3, b: Vec3, c: Vec3, d: Vec3): Vec3 {
  return normalize(cross(sub(a, c), sub(b, d)));
}

/** `calc_edge_mat`: x along the edge, y = z_up × x, z = x × y. */
function edgeMat(a: Vec3, b: Vec3): Mat3 {
  const x = normalize(sub(b, a));
  const d = x[2];
  if (d > -1 + FLT_EPSILON && d < 1 - FLT_EPSILON) {
    const y = normalize(cross([0, 0, 1], x));
    const z = normalize(cross(x, y));
    return [x, y, z];
  }
  // Straight up or down: a fixed basis, as Blender does.
  return [x, [1, 0, 0], [0, 1, 0]];
}

const half = (r: readonly [number, number]): number => (r[0] + r[1]) * 0.5;

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
  const positions = sk.positions.map((p) => [...p] as Vec3);
  const radius = sk.radius.map((r) => [...r] as [number, number]);
  const root = [...sk.root];
  const edges: [number, number][] = [];
  for (const [a, b] of sk.edges) {
    const branchA = degree[a]! > 2;
    const branchB = degree[b]! > 2;
    const avg = half(sk.radius[a]!) + half(sk.radius[b]!);
    let count = 0;
    if (avg !== 0) count = Math.min(128, Math.trunc(len(sub(sk.positions[b]!, sk.positions[a]!)) / avg));
    // Two branch nodes need two frames between them (Blender's comment:
    // "avoids any special cases for sharing a frame between two hulls").
    if (count < 2 && branchA && branchB) count = 2;

    let k = half(sk.radius[b]!) / half(sk.radius[a]!);
    k = Number.isFinite(k) ? (k + 1) / 2 : 1;

    let u = a;
    for (let j = 0; j < count; j++) {
      const t = Math.pow((j + 1) / (count + 1), k);
      const pa = sk.positions[a]!;
      const pb = sk.positions[b]!;
      positions.push([pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t]);
      const ra = sk.radius[a]!;
      const rb = sk.radius[b]!;
      radius.push([ra[0] + (rb[0] - ra[0]) * t, ra[1] + (rb[1] - ra[1]) * t]);
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

interface Node {
  frames: Vec3[][];
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
      node.frames = [frame(co, rad, m, avg), frame(co, rad, m, -avg)];
      node.capStart = node.capEnd = true;
    } else if (edges.length === 1) {
      const e = emat[edges[0]!]!;
      const m: Mat3 = [
        e.origin !== v ? scale(e.mat[0], -1) : e.mat[0],
        e.mat[1],
        e.mat[2],
      ];
      const f = frame(co, rad, m, 0);
      node.frames = [f];
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
        const angle = angleNormalized(ine[0], oute[0]) / 2;
        const axis = normalize(cross(ine[0], oute[0]));
        const m: Mat3 = [ine[0], rotate(ine[1], axis, angle), rotate(ine[2], axis, angle)];
        node.frames = [frame(co, rad, m, 0)];
      } else {
        // Both edges leave (or both arrive) — the root in the middle of a
        // chain. Two frames, bridged to each other; Blender's `SEAM_FRAME`.
        const avg = half(rad);
        const m1: Mat3 = [e1.origin !== v ? scale(e1.mat[0], -1) : e1.mat[0], e1.mat[1], e1.mat[2]];
        const m2: Mat3 = [e2.origin !== v ? scale(e2.mat[0], -1) : e2.mat[0], e2.mat[1], e2.mat[2]];
        node.frames = [frame(co, rad, m1, avg), frame(co, rad, m2, avg)];
        node.seam = true;
        node.seamEdges = [edges[0]!, edges[1]!];
      }
    } else {
      throw new Error(
        `skin: vertex ${v} has ${edges.length} edges — branch nodes (degree 3 and up) are not ` +
          "implemented yet; Blender builds a convex hull there (see the note on this file)",
      );
    }
    nodes.push(node);
  }
  return nodes;
}

/** Blender's `skin_choose_quad_bridge_order`: the rotation or reflection with the shortest total. */
function bridgeOrder(a: Vec3[], b: Vec3[]): number[] {
  let best: number[] = [0, 1, 2, 3];
  let shortest = Infinity;
  for (let i = 0; i < 8; i++) {
    const order = [0, 1, 2, 3].map((j) => (i < 4 ? (j + i) % 4 : 3 - ((j + (i - 4)) % 4)));
    let total = 0;
    for (let j = 0; j < 4; j++) {
      const d = sub(a[j]!, b[order[j]!]!);
      total += dot(d, d);
    }
    if (total < shortest) {
      shortest = total;
      best = order;
    }
  }
  return best;
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
 * Throws on a vertex with three or more edges — see the note at the top.
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

  // Vertices in node order, four per frame — Blender's `output_frames`.
  const outPositions: number[] = [];
  const frameVerts: number[][][] = nodes.map((node) =>
    node.frames.map((f) =>
      f.map((co) => {
        outPositions.push(co[0], co[1], co[2]);
        return outPositions.length / 3 - 1;
      }),
    ),
  );
  const at = (i: number): Vec3 => [outPositions[i * 3]!, outPositions[i * 3 + 1]!, outPositions[i * 3 + 2]!];
  const polys: number[][] = [];

  /** Blender's `connect_frames`: four quads, wound by the summed orientation. */
  const connect = (f1: number[], f2: number[]): void => {
    const q = [
      [f2[0]!, f2[1]!, f1[1]!, f1[0]!],
      [f2[1]!, f2[2]!, f1[2]!, f1[1]!],
      [f2[2]!, f2[3]!, f1[3]!, f1[2]!],
      [f2[3]!, f2[0]!, f1[0]!, f1[3]!],
    ];
    const mid4 = (quad: number[]): Vec3 => {
      let c: Vec3 = [0, 0, 0];
      for (const i of quad) c = add(c, at(i));
      return scale(c, 0.25);
    };
    const sides = q.map(mid4);
    const cent = scale(add(add(sides[0]!, sides[1]!), add(sides[2]!, sides[3]!)), 0.25);
    let d = 0;
    for (let i = 0; i < 4; i++) {
      const n = normalQuad(at(q[i]![0]!), at(q[i]![1]!), at(q[i]![2]!), at(q[i]![3]!));
      d += dot(n, sub(cent, sides[i]!));
    }
    for (const quad of q) polys.push(d > 0 ? [quad[3]!, quad[2]!, quad[1]!, quad[0]!] : quad);
  };

  // End nodes and seams first — `skin_output_end_nodes`.
  nodes.forEach((node, v) => {
    const fv = frameVerts[v]!;
    if (node.seam) {
      const order = bridgeOrder(node.frames[0]!, node.frames[1]!);
      connect(fv[0]!, order.map((i) => fv[1]![i]!));
    } else if (node.frames.length === 2) connect(fv[0]!, fv[1]!);
    if (node.capStart) {
      const f = fv[0]!;
      polys.push(node.flipNormal ? [f[0]!, f[1]!, f[2]!, f[3]!] : [f[3]!, f[2]!, f[1]!, f[0]!]);
    }
    if (node.capEnd) {
      const f = fv[1]!;
      polys.push([f[0]!, f[1]!, f[2]!, f[3]!]);
    }
  });

  // Then one tube segment per edge — `skin_output_connections`.
  sk.edges.forEach(([a, b], e) => {
    const na = nodes[a]!;
    const nb = nodes[b]!;
    if (na.frames.length === 0 || nb.frames.length === 0) return;
    if (na.seam || nb.seam) {
      const ia = na.seam && e !== na.seamEdges[0] ? 1 : 0;
      const ib = nb.seam && e !== nb.seamEdges[0] ? 1 : 0;
      const order = bridgeOrder(na.frames[ia]!, nb.frames[ib]!);
      connect(frameVerts[a]![ia]!, order.map((i) => frameVerts[b]![ib]![i]!));
    } else connect(frameVerts[a]![0]!, frameVerts[b]![0]!);
  });

  return { positions: Float32Array.from(outPositions), polys };
}

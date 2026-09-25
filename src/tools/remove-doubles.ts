/**
 * Merge vertices closer than a distance — Blender's
 * `bmesh.ops.remove_doubles(verts=, dist=)`, ported so that the same vertices
 * survive.
 *
 * {@link weldMesh} does the same job and is what the generators use; it
 * claims neighbours in its own order and came out a few vertices apart from
 * Blender at larger distances (116 against 113 on the shipped cage at 0.05).
 * Which vertex survives a cluster is not geometry, it is this procedure —
 * `bmesh_find_doubles_by_distance_impl` and `kdtree_calc_duplicates_cb` in
 * Blender's source — so it is ported step by step:
 *
 * 1. The points go into a KD-tree, **balanced by Blender's quickselect** —
 *    the walk below visits the tree's node array in that order, so the
 *    balance decides who searches first.
 * 2. Walking the node array, each vertex not yet taken gathers every
 *    untaken vertex within `dist` (itself included), and then itself once
 *    more — so it counts twice in the cluster's centroid.
 * 3. The vertex nearest that centroid is kept (ties: the lower index); the
 *    rest of the cluster merges into it and does not move.
 * 4. `weld_verts` rebuilds the faces: consecutive repeats collapse, a face
 *    that would visit a corner twice or match an existing face is dropped,
 *    and the edges of a dropped face stay as loose edges.
 *
 * All distances in float32, as a `BMVert`'s coordinates are.
 */
import type { MeshData } from "../lib/mesh";
import { carryFaceLayers, type FaceSource } from "./mesh-layers";
import { calcEdges } from "./bmesh-lite";

const f = Math.fround;
type V3 = [number, number, number];

interface KDNode {
  co: V3;
  index: number;
  d: number;
  left: number;
  right: number;
}

const UNSET = -1;

/** `kdtree_balance`: quickselect around the median on one axis, then recurse. */
function balance(nodes: KDNode[], start: number, len: number, axis: number): number {
  if (len <= 0) return UNSET;
  if (len === 1) return start;
  let left = 0;
  let right = len - 1;
  const median = len >> 1;
  const at = (k: number): KDNode => nodes[start + k]!;
  const swap = (a: number, b: number): void => {
    // Only the head (co, index) moves; left/right/d are set afterwards.
    const na = at(a);
    const nb = at(b);
    const co = na.co;
    const index = na.index;
    na.co = nb.co;
    na.index = nb.index;
    nb.co = co;
    nb.index = index;
  };
  while (right > left) {
    const co = at(right).co[axis]!;
    let i = left - 1;
    let j = right;
    for (;;) {
      while (at(++i).co[axis]! < co);
      while (at(--j).co[axis]! > co && j > left);
      if (i >= j) break;
      swap(i, j);
    }
    swap(i, right);
    if (i >= median) right = i - 1;
    if (i <= median) left = i + 1;
  }
  const node = at(median);
  node.d = axis;
  const next = (axis + 1) % 3;
  node.left = balance(nodes, start, median, next);
  node.right = balance(nodes, start + median + 1, len - (median + 1), next);
  return start + median;
}

/** `math::distance_squared` on `float3`. */
function distSq(a: V3, b: V3): number {
  const x = f(a[0] - b[0]);
  const y = f(a[1] - b[1]);
  const z = f(a[2] - b[2]);
  return f(f(f(x * x) + f(y * y)) + f(z * z));
}

/** `kdtree_range_search_cb`: a stack walk, right child popped before left. */
function rangeSearch(nodes: KDNode[], root: number, co: V3, range: number, cb: (index: number) => void): void {
  const rangeSq = f(range * range);
  const stack = [root];
  while (stack.length > 0) {
    const node = nodes[stack.pop()!]!;
    if (f(co[node.d]! + range) < node.co[node.d]!) {
      if (node.left !== UNSET) stack.push(node.left);
    } else if (f(co[node.d]! - range) > node.co[node.d]!) {
      if (node.right !== UNSET) stack.push(node.right);
    } else {
      if (distSq(node.co, co) <= rangeSq) cb(node.index);
      if (node.left !== UNSET) stack.push(node.left);
      if (node.right !== UNSET) stack.push(node.right);
    }
  }
}

/**
 * Which vertex each one merges into — `bmesh_find_doubles_by_distance_impl`.
 * `-1` or itself means it stays.
 */
export function doublesByDistance(positions: Float32Array, dist: number): Int32Array {
  const n = positions.length / 3;
  const co = (i: number): V3 => [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];
  const nodes: KDNode[] = [];
  for (let i = 0; i < n; i++) nodes.push({ co: co(i), index: i, d: 0, left: UNSET, right: UNSET });
  const root = balance(nodes, 0, n, 0);
  const duplicates = new Int32Array(n).fill(-1);
  if (root === UNSET) return duplicates;
  const range = f(dist);

  /** The `deduplicate_target_calc_fn` callback: the most central, lowest index on a tie. */
  const target = (cluster: readonly number[]): number => {
    if (cluster.length === 2) return cluster[0]! < cluster[1]! ? 0 : 1;
    let c: V3 = [0, 0, 0];
    for (const v of cluster) {
      const p = co(v);
      c = [f(c[0] + p[0]), f(c[1] + p[1]), f(c[2] + p[2])];
    }
    const k = f(cluster.length);
    c = [f(c[0] / k), f(c[1] / k), f(c[2] / k)];
    const end = cluster.length - 1;
    let best = end;
    let bestD = distSq(c, co(cluster[best]!));
    for (let i = 0; i < end; i++) {
      const d = distSq(c, co(cluster[i]!));
      if (d > bestD) continue;
      if (d === bestD && cluster[i]! > cluster[best]!) continue;
      best = i;
      bestD = d;
    }
    return best;
  };

  for (const node of nodes) {
    const v = node.index;
    if (duplicates[v] !== -1) continue;
    const cluster: number[] = [];
    rangeSearch(nodes, root, node.co, range, (i) => {
      if (duplicates[i] === -1) cluster.push(i);
    });
    if (cluster.length === 0) continue;
    cluster.push(v);
    const t = cluster[target(cluster)]!;
    for (const i of cluster) duplicates[i] = t;
  }
  return duplicates;
}

const edgeKey = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);

/**
 * `bmesh.ops.remove_doubles(dist=)` on a mesh.
 *
 * ```ts
 * removeDoubles(mesh, 0.001); // close seams left by a generator
 * ```
 *
 * The kept vertex keeps its own position (no averaging), and keeps its order
 * among the survivors. Returns loose `edges` where a face collapsed away and
 * left its edges behind, as Blender's mesh has them.
 */
export function removeDoubles(data: MeshData, dist: number): MeshData {
  const dup = doublesByDistance(data.positions, dist);
  return weldByMap(data, (v) => (dup[v] === -1 || dup[v] === v ? v : dup[v]!));
}

export interface MergeByDistanceOptions {
  /**
   * Blender's Weld `mode`. `"all"` (default) merges any vertices within the
   * distance; `"connected"` only collapses **edges** shorter than it
   * (`mesh_merge_by_distance_connected`): the mesh's edges are walked in
   * order, an edge whose two clusters are within range merges the higher
   * cluster into the lower, and the cluster's centre moves by the weighted
   * mean — later edges are measured from that centre. Survivors still land on
   * the plain mean of the positions merged into them.
   */
  mode?: "all" | "connected";
  /** Blender's `loose_edges`: in `"connected"` mode, only collapse edges that belong to no face. */
  onlyLooseEdges?: boolean;
}

/**
 * Blender's **Weld** modifier and the Geometry Nodes *Merge by Distance* —
 * `mesh_merge_by_distance_all` (mode All; for Connected see the options). A different procedure from
 * {@link removeDoubles}, and a different answer:
 *
 * - **Clusters** (`kdtree_calc_duplicates_fast`, index order): vertices are
 *   visited by index, and each one not yet taken claims every untaken vertex
 *   within `dist`. The lowest index of a cluster survives — no centroid test.
 * - **The survivor moves to the cluster's mean** (`do_mix_data`: every
 *   attribute, position included, is interpolated over the sources).
 * - Faces are rebuilt by {@link weldByMap}, the `weld_verts` rules. Blender's
 *   weld has its own face pass (`weld_poly_split_recursive`, not ported); the
 *   two gave the same faces on all three cases of the `weld-mod` row
 *   (the production cage among them) and again at a distance wide enough to
 *   fold faces onto themselves (`weld-mod-wide`) — a measurement, not a proof.
 *
 * ```ts
 * const closed = mergeByDistance(mesh, 0.001); // the Weld modifier's answer
 * ```
 */
export function mergeByDistance(data: MeshData, dist: number, options: MergeByDistanceOptions = {}): MeshData {
  const n = data.positions.length / 3;
  const P = data.positions;
  const range = f(dist);
  const rangeSq = f(range * range);
  if (options.mode === "connected") return mergeConnected(data, rangeSq, options.onlyLooseEdges ?? false);
  const dest = new Int32Array(n).fill(-1);
  for (let v = 0; v < n; v++) {
    if (dest[v] !== -1 && dest[v] !== v) continue;
    const co: V3 = [P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!];
    for (let w = 0; w < n; w++) {
      if (w === v || dest[w] !== -1) continue;
      if (distSq([P[w * 3]!, P[w * 3 + 1]!, P[w * 3 + 2]!], co) <= rangeSq) {
        dest[w] = v;
        dest[v] = v;
      }
    }
  }
  const map = (v: number): number => (dest[v] === -1 ? v : dest[v]!);

  const sum = new Float64Array(n * 3);
  const count = new Uint32Array(n);
  for (let v = 0; v < n; v++) {
    const t = map(v);
    count[t] = count[t]! + 1;
    for (let k = 0; k < 3; k++) sum[t * 3 + k] = sum[t * 3 + k]! + P[v * 3 + k]!;
  }
  const moved = Float32Array.from(P);
  for (let v = 0; v < n; v++)
    if (count[v]! > 1) for (let k = 0; k < 3; k++) moved[v * 3 + k] = sum[v * 3 + k]! / count[v]!;
  return weldByMap({ ...data, positions: moved }, map, "weld");
}

/** `mesh_merge_by_distance_connected`, then the same mixing and face pass as mode All. */
function mergeConnected(data: MeshData, rangeSq: number, onlyLoose: boolean): MeshData {
  const n = data.positions.length / 3;
  const P = data.positions;
  const polys = data.polys.filter((p) => p.length >= 3);
  // The mesh's edges in `mesh_calc_edges` order, then the loose ones.
  const faceEdges = calcEdges(polys, polys.length < 1000 ? 1 : 8);
  const seen = new Set(faceEdges.map(([a, b]) => `${a}_${b}`));
  const loose: [number, number][] = [];
  for (const e of data.edges ?? []) {
    const a = Math.min(e[0]!, e[1]!);
    const b = Math.max(e[0]!, e[1]!);
    if (a === b || seen.has(`${a}_${b}`)) continue;
    seen.add(`${a}_${b}`);
    loose.push([a, b]);
  }
  const edges = onlyLoose ? loose : [...faceEdges, ...loose];

  const dest = Int32Array.from({ length: n }, (_, i) => i);
  const co: V3[] = Array.from({ length: n }, (_, i) => [P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!]);
  const merged = new Int32Array(n);
  let killed = 0;
  for (let [v1, v2] of edges) {
    while (v1 !== dest[v1]) v1 = dest[v1]!;
    while (v2 !== dest[v2]) v2 = dest[v2]!;
    if (v1 === v2) continue;
    if (v1 > v2) [v1, v2] = [v2, v1];
    const c1 = co[v1]!;
    const c2 = co[v2]!;
    const dir: V3 = [f(c2[0] - c1[0]), f(c2[1] - c1[1]), f(c2[2] - c1[2])];
    const d = f(f(f(dir[0] * dir[0]) + f(dir[1] * dir[1])) + f(dir[2] * dir[2]));
    if (d > rangeSq) continue;
    const influence = f((merged[v2]! + 1) / f(merged[v1]! + merged[v2]! + 2));
    for (let k = 0; k < 3; k++) c1[k] = f(c1[k]! + f(dir[k]! * influence));
    merged[v1] = merged[v1]! + merged[v2]! + 1;
    dest[v2] = v1;
    killed++;
  }
  if (killed === 0) return weldByMap(data, (v) => v);
  const root = (v: number): number => {
    while (dest[v] !== v) v = dest[v]!;
    return v;
  };
  const map = (v: number): number => root(v);
  // `do_mix_data`: each survivor at the plain mean of what merged into it.
  const sum = new Float64Array(n * 3);
  const count = new Uint32Array(n);
  for (let v = 0; v < n; v++) {
    const t = map(v);
    count[t] = count[t]! + 1;
    for (let k = 0; k < 3; k++) sum[t * 3 + k] = sum[t * 3 + k]! + P[v * 3 + k]!;
  }
  const moved = Float32Array.from(P);
  for (let v = 0; v < n; v++)
    if (count[v]! > 1) for (let k = 0; k < 3; k++) moved[v * 3 + k] = sum[v * 3 + k]! / count[v]!;
  return weldByMap({ ...data, positions: moved }, map, "weld");
}

/**
 * Blender's `weld_verts`: every vertex `map` sends elsewhere merges into its
 * target, which stays where it is. A face holding a vertex and its target
 * apart is split between them first; faces are rebuilt on the survivors —
 * consecutive repeats collapse, a face visiting a corner twice or matching an
 * existing face is dropped — and a dropped face's edges stay as loose edges.
 * Survivors keep their order.
 */
export function weldByMap(
  data: MeshData,
  map: (v: number) => number,
  mode: "bmesh" | "weld" | "array" = "bmesh",
): MeshData {
  const mix = mode !== "bmesh";
  const n = data.positions.length / 3;
  const merged = (v: number): boolean => map(v) !== v;

  // `remdoubles_splitface`: a face holding a vertex and its target apart is
  // split between them first, so each half can collapse on its own. Each
  // piece keeps which input face and corners it is, for the layers.
  interface Piece {
    face: number;
    corners: number[];
  }
  const split = (piece: Piece): Piece[] => {
    const src = data.polys[piece.face]!;
    const poly = piece.corners.map((c) => src[c]!);
    for (let i = 0; i < poly.length; i++) {
      const tar = map(poly[i]!);
      if (tar === poly[i]) continue;
      const j = poly.indexOf(tar);
      const k = poly.length;
      if (j < 0 || j === (i + 1) % k || i === (j + 1) % k) continue;
      const run = (a: number, b: number): Piece => {
        const out: number[] = [];
        for (let x = a; ; x = (x + 1) % k) {
          out.push(piece.corners[x]!);
          if (x === b) break;
        }
        return { face: piece.face, corners: out };
      };
      return [...split(run(j, i)), ...split(run(i, j))];
    }
    return [piece];
  };
  const pieces = data.polys.flatMap((p, face) => split({ face, corners: p.map((_, i) => i) }));
  const polys = pieces.map((pc) => pc.corners.map((c) => data.polys[pc.face]![c]!));

  // Edges, as `weld_verts` re-points them: the ones whose ends merge together
  // collapse, the rest move onto the survivors.
  const edges = new Map<string, [number, number]>();
  const collapsed = new Set<string>();
  const addEdge = (a: number, b: number): void => {
    const ma = map(a);
    const mb = map(b);
    if (ma === mb) {
      collapsed.add(edgeKey(a, b));
      return;
    }
    edges.set(edgeKey(ma, mb), [ma, mb]);
  };
  for (const p of polys) for (let i = 0; i < p.length; i++) addEdge(p[i]!, p[(i + 1) % p.length]!);
  for (const e of data.edges ?? []) addEdge(e[0]!, e[1]!);

  // Faces: untouched ones stay; touched ones are rebuilt on the survivors.
  const faceKey = (p: readonly number[]): string => {
    // A face "exists" as the same cycle either way round.
    const k = p.length;
    let best = "";
    for (let s = 0; s < k; s++)
      for (const dir of [1, -1]) {
        const seq: number[] = [];
        for (let i = 0; i < k; i++) seq.push(p[(s + dir * i + k * k) % k]!);
        const key = seq.join(",");
        if (best === "" || key < best) best = key;
      }
    return best;
  };
  const out: number[][] = [];
  const sources: FaceSource[] = [];
  const seen = new Set<string>();
  for (const p of polys) if (!p.some(merged)) seen.add(faceKey(p));
  for (let pi = 0; pi < polys.length; pi++) {
    const p = polys[pi]!;
    if (!p.some(merged)) {
      out.push(p);
      sources.push(pieces[pi]!);
      continue;
    }
    let collapse = 0;
    for (let i = 0; i < p.length; i++) if (collapsed.has(edgeKey(p[i]!, p[(i + 1) % p.length]!))) collapse++;
    if (p.length - collapse < 3) continue;
    // `remdoubles_createface`: each corner copies the loop it came from.
    const face: number[] = [];
    const corners: (number | number[])[] = [];
    let ok = true;
    for (let i = 0; i < p.length; i++) {
      const v = map(p[i]!);
      const w = map(p[(i + 1) % p.length]!);
      if (v === w) continue;
      if (face.includes(v)) {
        ok = false;
        break;
      }
      face.push(v);
      // Weld and Array: every loop of the piece that lands on `v` (`weld_iter_loop_of_poly_next`'s
      // group — mixed even when vertex data is not).
      corners.push(
        mix ? pieces[pi]!.corners.filter((c) => map(data.polys[pieces[pi]!.face]![c]!) === v) : pieces[pi]!.corners[i]!,
      );
    }
    if (!ok || face.length < 3) continue;
    const key = faceKey(face);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(face);
    sources.push({ face: pieces[pi]!.face, corners });
  }

  // Renumber the survivors in their own order.
  const index = new Int32Array(n).fill(-1);
  const positions: number[] = [];
  for (let v = 0; v < n; v++) {
    if (merged(v)) continue;
    index[v] = positions.length / 3;
    positions.push(data.positions[v * 3]!, data.positions[v * 3 + 1]!, data.positions[v * 3 + 2]!);
  }
  const used = new Set<string>();
  for (const p of out) for (let i = 0; i < p.length; i++) used.add(edgeKey(p[i]!, p[(i + 1) % p.length]!));
  const loose = [...edges.entries()].filter(([k]) => !used.has(k)).map(([, [a, b]]) => [index[a]!, index[b]!]);
  const outPolys = out.map((p) => p.map((v) => index[v]!));

  // The layers (compat-backlog A3), by the three callers' rules:
  //
  // - `bmesh` (`remove_doubles` / `weld_verts`): a survivor keeps its own
  //   vertex data (`BM_vert_splice`), each corner is the loop it came from,
  //   and edges that merge combine their flags (`BM_elem_flag_merge_ex`):
  //   seam OR, sharp AND (sharp is "no SMOOTH flag"), crease the survivor's.
  // - `weld` (the Weld modifier, `do_mix_data`): vertex, edge and corner
  //   data are the plain mean of what merged — a group missing from a vertex
  //   counts 0, a flag is on at a mean of 0.5.
  // - `array` (Array / Mirror merging, `mesh_merge_verts` without mixing):
  //   vertices and edges keep the survivor's, but corners are still the mean
  //   of the face's loops that collapse onto one vertex.
  const rename = (key: string): string | null => {
    const [a, b] = key.split("_").map(Number) as [number, number];
    const ma = index[map(a)]!;
    const mb = index[map(b)]!;
    return ma < 0 || mb < 0 || ma === mb ? null : edgeKey(ma, mb);
  };
  // Every original edge, by the edge it becomes.
  const edgeGroups = new Map<string, string[]>();
  const addOriginal = (a: number, b: number): void => {
    const k = edgeKey(a, b);
    const nk = rename(k);
    if (!nk) return;
    const l = edgeGroups.get(nk) ?? [];
    if (!l.includes(k)) l.push(k);
    edgeGroups.set(nk, l);
  };
  for (const p of data.polys) for (let i = 0; i < p.length; i++) addOriginal(p[i]!, p[(i + 1) % p.length]!);
  for (const e of data.edges ?? []) addOriginal(e[0]!, e[1]!);
  const survivorOf = (members: string[]): string =>
    members.find((k) => k.split("_").every((v) => !merged(Number(v)))) ?? members[0]!;
  const result: MeshData = {
    positions: Float32Array.from(positions),
    polys: outPolys,
    ...(loose.length > 0 ? { edges: loose } : {}),
    ...carryFaceLayers(data, sources),
  };
  if (data.creases) {
    const src = data.creases;
    result.creases = new Map();
    for (const [nk, members] of edgeGroups) {
      const w =
        mode === "weld"
          ? members.reduce((s, k) => s + (src.get(k) ?? 0), 0) / members.length
          : (src.get(survivorOf(members)) ?? 0);
      if (w !== 0) result.creases.set(nk, w);
    }
  }
  for (const layer of ["seams", "sharp"] as const) {
    const src = data[layer];
    if (!src) continue;
    const dst = new Set<string>();
    for (const [nk, members] of edgeGroups) {
      const on = members.filter((k) => src.has(k)).length;
      const flag =
        mode === "weld"
          ? on / members.length >= 0.5
          : mode === "array"
            ? src.has(survivorOf(members))
            : layer === "seams"
              ? on > 0
              : on === members.length;
      if (flag) dst.add(nk);
    }
    result[layer] = dst;
  }
  if (data.groups) {
    result.groups = new Map();
    for (const [name, g] of data.groups) {
      const ng = new Map<number, number>();
      if (mode !== "weld") {
        for (const [v, w] of g) if (!merged(v) && index[v]! >= 0) ng.set(index[v]!, w);
      } else {
        const sources = new Map<number, number[]>();
        for (let v = 0; v < n; v++) {
          const t = index[map(v)]!;
          if (t < 0) continue;
          const l = sources.get(t) ?? [];
          l.push(v);
          sources.set(t, l);
        }
        for (const [t, from] of sources) {
          // The plain mean over the merged vertices, a non-member counting 0;
          // a member of weight 0 still makes the survivor a member (measured:
          // the zero-skipping of `layerInterp_mdeformvert` lost 3 of 183).
          let sum = 0;
          let member = false;
          for (const v of from) {
            const w = g.get(v);
            if (w !== undefined) {
              member = true;
              sum += w / from.length;
            }
          }
          if (member) ng.set(t, sum);
        }
      }
      result.groups.set(name, ng);
    }
  }
  return result;
}

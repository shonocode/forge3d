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

/**
 * Blender's `weld_verts`: every vertex `map` sends elsewhere merges into its
 * target, which stays where it is. A face holding a vertex and its target
 * apart is split between them first; faces are rebuilt on the survivors —
 * consecutive repeats collapse, a face visiting a corner twice or matching an
 * existing face is dropped — and a dropped face's edges stay as loose edges.
 * Survivors keep their order.
 */
export function weldByMap(data: MeshData, map: (v: number) => number): MeshData {
  const n = data.positions.length / 3;
  const merged = (v: number): boolean => map(v) !== v;

  // `remdoubles_splitface`: a face holding a vertex and its target apart is
  // split between them first, so each half can collapse on its own.
  const split = (poly: number[]): number[][] => {
    for (let i = 0; i < poly.length; i++) {
      const tar = map(poly[i]!);
      if (tar === poly[i]) continue;
      const j = poly.indexOf(tar);
      const k = poly.length;
      if (j < 0 || j === (i + 1) % k || i === (j + 1) % k) continue;
      const run = (a: number, b: number): number[] => {
        const out: number[] = [];
        for (let x = a; ; x = (x + 1) % k) {
          out.push(poly[x]!);
          if (x === b) break;
        }
        return out;
      };
      return [...split(run(j, i)), ...split(run(i, j))];
    }
    return [poly];
  };
  const polys = data.polys.flatMap((p) => split([...p]));

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
  const seen = new Set<string>();
  for (const p of polys) if (!p.some(merged)) seen.add(faceKey(p));
  for (const p of polys) {
    if (!p.some(merged)) {
      out.push(p);
      continue;
    }
    let collapse = 0;
    for (let i = 0; i < p.length; i++) if (collapsed.has(edgeKey(p[i]!, p[(i + 1) % p.length]!))) collapse++;
    if (p.length - collapse < 3) continue;
    // `remdoubles_createface`
    const face: number[] = [];
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
    }
    if (!ok || face.length < 3) continue;
    const key = faceKey(face);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(face);
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
  return {
    positions: Float32Array.from(positions),
    polys: out.map((p) => p.map((v) => index[v]!)),
    ...(loose.length > 0 ? { edges: loose } : {}),
  };
}

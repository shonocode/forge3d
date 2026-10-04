/**
 * Blender's 3D k-d tree (`BLI_kdtree.hh`, tag v5.1.1): the balanced tree built
 * by quick-select around the median, and the range search that calls back for
 * each point in reach **in the order the tree is walked**.
 *
 * It exists for that order. `bm_edge_symmetry_map` (Decimate's symmetry) stops
 * at the first mirror edge the callback accepts, so when several edges lie in
 * reach — a fan of triangles whose mid-points coincide — which one is "first"
 * is the tree's doing, and a different search order pairs different edges.
 *
 * Coordinates are float32; the comparisons and the squared distance round as
 * the C does (`Math.fround` per operation).
 */

const f = Math.fround;
const UNSET = 0xffffffff;

export interface KdNode {
  co: [number, number, number];
  index: number;
  d: number;
  left: number;
  right: number;
}

export interface KdTree {
  nodes: KdNode[];
  root: number;
}

/** `kdtree_3d_insert` ×n then `kdtree_3d_balance`: the nodes are the points in insertion order, then reordered. */
export function kdBuild(points: ReadonlyArray<readonly [number, number, number]>): KdTree {
  const nodes: KdNode[] = points.map((p, i) => ({ co: [f(p[0]), f(p[1]), f(p[2])], index: i, d: 0, left: UNSET, right: UNSET }));
  const root = balance(nodes, 0, nodes.length, 0, 0);
  return { nodes, root };
}

/** `detail::kdtree_balance`: `nodes[base .. base + len)`, node numbers offset by `ofs` (the same thing here). */
function balance(nodes: KdNode[], base: number, len: number, axis: number, ofs: number): number {
  if (len <= 0) return UNSET;
  if (len === 1) return ofs;
  let left = 0;
  let right = len - 1;
  const median = Math.floor(len / 2);
  const at = (k: number): KdNode => nodes[base + k]!;
  // SWAP of KDTreeNode_head: the point and its index move, the tree links stay with the slot.
  const swap = (a: number, b: number): void => {
    const x = at(a);
    const y = at(b);
    [x.co, y.co] = [y.co, x.co];
    [x.index, y.index] = [y.index, x.index];
  };
  while (right > left) {
    const co = at(right).co[axis]!;
    let i = left - 1;
    let j = right;
    for (;;) {
      while (at(++i).co[axis]! < co) {
        /* pass */
      }
      while (at(--j).co[axis]! > co && j > left) {
        /* pass */
      }
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
  node.left = balance(nodes, base, median, next, ofs);
  node.right = balance(nodes, base + median + 1, len - (median + 1), next, median + 1 + ofs);
  return median + ofs;
}

/**
 * `kdtree_range_search_cb`: `cb(index, co, distSq)` for every point within `range` of `co`, in walk order;
 * a `false` return stops the search.
 */
export function kdRangeSearch(
  tree: KdTree,
  co: readonly [number, number, number],
  range: number,
  cb: (index: number, co: readonly [number, number, number], distSq: number) => boolean,
): void {
  if (tree.root === UNSET) return;
  const r = f(range);
  const rangeSq = f(r * r);
  const stack: number[] = [tree.root];
  while (stack.length) {
    const node = tree.nodes[stack.pop()!]!;
    const d = node.d;
    if (f(co[d]! + r) < node.co[d]!) {
      if (node.left !== UNSET) stack.push(node.left);
    } else if (f(co[d]! - r) > node.co[d]!) {
      if (node.right !== UNSET) stack.push(node.right);
    } else {
      const dx = f(node.co[0] - co[0]);
      const dy = f(node.co[1] - co[1]);
      const dz = f(node.co[2] - co[2]);
      const distSq = f(f(f(dx * dx) + f(dy * dy)) + f(dz * dz));
      if (distSq <= rangeSq && cb(node.index, node.co, distSq) === false) break;
      if (node.left !== UNSET) stack.push(node.left);
      if (node.right !== UNSET) stack.push(node.right);
    }
  }
}

/**
 * Float32 arithmetic in C's evaluation order, and `BLI_heap` — shared by the
 * ports that have to reproduce Blender's answers to the last bit
 * (`decimateCollapse`, `triangulate`).
 *
 * Every helper rounds after each operation with `Math.fround`, so a result
 * is the float Blender's C would have produced (no FMA — MSVC's default).
 * `BLI_heap` is ported with its tie behaviour: `heap_up` moves a node past a
 * parent of equal value, which decides the order of equal costs.
 */

export const f = Math.fround;
export const FLT_EPSILON = 1.1920928955078125e-7;
export const FLT_MAX = 3.4028234663852886e38;

// ── BLI_heap ───────────────────────────────────────────────────────────────

export interface HeapNode<T> {
  value: number;
  index: number;
  ptr: T;
}
export interface Heap<T> {
  tree: HeapNode<T>[];
}

export function heapSwap<T>(h: Heap<T>, i: number, j: number): void {
  const pi = h.tree[i]!;
  const pj = h.tree[j]!;
  pi.index = j;
  h.tree[j] = pi;
  pj.index = i;
  h.tree[i] = pj;
}
export function heapDown<T>(h: Heap<T>, i: number): void {
  const size = h.tree.length;
  for (;;) {
    const l = 2 * i + 1;
    const r = 2 * i + 2;
    let smallest = i;
    if (l < size && h.tree[l]!.value < h.tree[smallest]!.value) smallest = l;
    if (r < size && h.tree[r]!.value < h.tree[smallest]!.value) smallest = r;
    if (smallest === i) break;
    heapSwap(h, i, smallest);
    i = smallest;
  }
}
export function heapUp<T>(h: Heap<T>, i: number): void {
  // Ties move up: the loop only stops when the parent is strictly smaller.
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (h.tree[p]!.value < h.tree[i]!.value) break;
    heapSwap(h, p, i);
    i = p;
  }
}
export function heapInsert<T>(h: Heap<T>, value: number, ptr: T): HeapNode<T> {
  const node = { value: f(value), index: h.tree.length, ptr };
  h.tree.push(node);
  heapUp(h, node.index);
  return node;
}
export function heapPopMin<T>(h: Heap<T>): T {
  const ptr = h.tree[0]!.ptr;
  const size = h.tree.length - 1;
  if (size) heapSwap(h, 0, size);
  h.tree.pop();
  if (size) heapDown(h, 0);
  return ptr;
}
export function heapRemove<T>(h: Heap<T>, node: HeapNode<T>): void {
  let i = node.index;
  while (i > 0) {
    const p = (i - 1) >> 1;
    heapSwap(h, p, i);
    i = p;
  }
  heapPopMin(h);
}
export function heapUpdate<T>(h: Heap<T>, node: HeapNode<T>, value: number, ptr: T): void {
  node.ptr = ptr;
  value = f(value);
  if (value < node.value) {
    node.value = value;
    heapUp(h, node.index);
  } else if (value > node.value) {
    node.value = value;
    heapDown(h, node.index);
  }
}

// ── float vector helpers, C evaluation order ───────────────────────────────

export type V3 = number[];
export const sub = (a: V3, b: V3): V3 => [f(a[0]! - b[0]!), f(a[1]! - b[1]!), f(a[2]! - b[2]!)];
export const dot = (a: V3, b: V3): number => f(f(f(a[0]! * b[0]!) + f(a[1]! * b[1]!)) + f(a[2]! * b[2]!));
export const cross = (a: V3, b: V3): V3 => [
  f(f(a[1]! * b[2]!) - f(a[2]! * b[1]!)),
  f(f(a[2]! * b[0]!) - f(a[0]! * b[2]!)),
  f(f(a[0]! * b[1]!) - f(a[1]! * b[0]!)),
];
export const lenSq = (a: V3): number => dot(a, a);
/** `normalize_v3`: multiplies by the reciprocal. */
export function normalizeInPlace(n: V3): number {
  let d = lenSq(n);
  if (d > 1e-35) {
    d = f(Math.sqrt(d));
    const s = f(1 / d);
    for (let k = 0; k < 3; k++) n[k] = f(n[k]! * s);
    return d;
  }
  n[0] = n[1] = n[2] = 0;
  return 0;
}
/** `math::normalize`: divides by the length. */
export function mathNormalize(a: V3): V3 {
  const l2 = lenSq(a);
  if (l2 > 1e-35) {
    const l = f(Math.sqrt(l2));
    return [f(a[0]! / l), f(a[1]! / l), f(a[2]! / l)];
  }
  return [0, 0, 0];
}
export function normalTri(a: V3, b: V3, c: V3): V3 {
  const n1 = sub(a, b);
  const n2 = sub(b, c);
  const n = cross(n1, n2);
  normalizeInPlace(n);
  return n;
}
export function normalQuad(a: V3, b: V3, c: V3, d: V3): V3 {
  const n = cross(sub(a, c), sub(b, d));
  normalizeInPlace(n);
  return n;
}
/** `add_newell_cross_v3_v3v3` over a ring, starting from (last, first). */
export function newell(ring: V3[]): V3 {
  const n = [0, 0, 0];
  let prev = ring[ring.length - 1]!;
  for (const curr of ring) {
    n[0] = f(n[0]! + f(f(prev[1]! - curr[1]!) * f(prev[2]! + curr[2]!)));
    n[1] = f(n[1]! + f(f(prev[2]! - curr[2]!) * f(prev[0]! + curr[0]!)));
    n[2] = f(n[2]! + f(f(prev[0]! - curr[0]!) * f(prev[1]! + curr[1]!)));
    prev = curr;
  }
  return n;
}
export function safeAcosApprox(x: number): number {
  const fa = Math.abs(x);
  const m = fa < 1 ? f(1 - f(1 - fa)) : 1;
  const a = f(
    f(Math.sqrt(f(1 - m))) *
      f(
        f(1.5707963267) +
          f(m * f(f(-0.213300989) + f(m * f(f(0.077980478) + f(m * f(-0.02164095)))))),
      ),
  );
  return x < 0 ? f(f(Math.PI) - a) : a;
}


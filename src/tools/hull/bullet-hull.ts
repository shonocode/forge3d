/**
 * Bullet's `btConvexHullComputer` (Ole Kniemeyer's Preparata–Hong hull), the
 * convex hull behind Blender's `bmesh.ops.convex_hull` and the Skin modifier
 * (`plConvexHullCompute` → `btConvexHullComputer::compute`, shrink 0).
 * Ported function by function so that the same points give the same faces.
 *
 * What decides the answer, and why a port rather than any other hull:
 *
 * - The points are **snapped to an integer grid about 10216 wide** along the
 *   longest axis (`compute`), and the hull is built exactly on that grid.
 *   Points that differ by less than one grid step are one point; points that
 *   are nearly coplanar can become exactly coplanar. Which of them end up on
 *   the hull is the grid's answer, not the true hull's.
 * - Faces come back as **planar n-gons**, and their vertex order and first
 *   vertex follow Bullet's edge rings — which the caller fans into triangles.
 *
 * Blender builds Bullet with `BT_USE_DOUBLE_PRECISION`, so `btScalar` is a
 * double, as here. `int64_t` arithmetic is BigInt (products reach ~3·10^16);
 * `int32_t` stays in numbers, where every product used fits.
 *
 * Not ported: `shrink` / `shiftFace` (Blender passes 0), and with them the
 * 128-bit rational points of new vertices.
 */

interface P32 {
  x: number;
  y: number;
  z: number;
  index: number;
}

interface P64 {
  x: bigint;
  y: bigint;
  z: bigint;
}

const sub32 = (a: P32, b: P32): P32 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z, index: -1 });
const eq32 = (a: P32, b: P32): boolean => a.x === b.x && a.y === b.y && a.z === b.z;
const cross32 = (a: P32, b: P32): P64 => ({
  x: BigInt(a.y * b.z - a.z * b.y),
  y: BigInt(a.z * b.x - a.x * b.z),
  z: BigInt(a.x * b.y - a.y * b.x),
});
const cross32x64 = (a: P32, b: P64): P64 => ({
  x: BigInt(a.y) * b.z - BigInt(a.z) * b.y,
  y: BigInt(a.z) * b.x - BigInt(a.x) * b.z,
  z: BigInt(a.x) * b.y - BigInt(a.y) * b.x,
});
const dot32 = (a: P32, b: P32): bigint => BigInt(a.x * b.x + a.y * b.y + a.z * b.z);
const dot32x64 = (a: P32, b: P64): bigint => BigInt(a.x) * b.x + BigInt(a.y) * b.y + BigInt(a.z) * b.z;
const dot64 = (a: P64, b: P64): bigint => a.x * b.x + a.y * b.y + a.z * b.z;

/** `Rational64`: sign, and the magnitudes of numerator and denominator. */
class Rational64 {
  num: bigint;
  den: bigint;
  sign: number;

  constructor(numerator: bigint, denominator: bigint) {
    if (numerator > 0n) {
      this.sign = 1;
      this.num = numerator;
    } else if (numerator < 0n) {
      this.sign = -1;
      this.num = -numerator;
    } else {
      this.sign = 0;
      this.num = 0n;
    }
    if (denominator > 0n) this.den = denominator;
    else if (denominator < 0n) {
      this.sign = -this.sign;
      this.den = -denominator;
    } else this.den = 0n;
  }

  isNegativeInfinity(): boolean {
    return this.sign < 0 && this.den === 0n;
  }

  isNaN(): boolean {
    return this.sign === 0 && this.den === 0n;
  }

  compare(b: Rational64): number {
    if (this.sign !== b.sign) return this.sign - b.sign;
    if (this.sign === 0) return 0;
    const l = this.num * b.den;
    const r = this.den * b.num;
    return this.sign * (l < r ? -1 : l > r ? 1 : 0);
  }
}

interface Vertex {
  next: Vertex | null;
  prev: Vertex | null;
  edges: Edge | null;
  point: P32;
  copy: number;
}

interface Edge {
  next: Edge | null;
  prev: Edge | null;
  reverse: Edge | null;
  target: Vertex | null;
  copy: number;
}

interface IntermediateHull {
  minXy: Vertex | null;
  maxXy: Vertex | null;
  minYx: Vertex | null;
  maxYx: Vertex | null;
}

const newHull = (): IntermediateHull => ({ minXy: null, maxXy: null, minYx: null, maxYx: null });

const NONE = 0;
const CLOCKWISE = 1;
const COUNTER_CLOCKWISE = 2;

const link = (e: Edge, n: Edge): void => {
  e.next = n;
  n.prev = e;
};

/** `btAlignedObjectArray::quickSort`: middle pivot, Hoare partition. Not stable. */
function btQuickSort<T>(a: T[], less: (x: T, y: T) => boolean): void {
  const sort = (lo: number, hi: number): void => {
    let i = lo;
    let j = hi;
    const x = a[(lo + hi) >> 1]!;
    do {
      while (less(a[i]!, x)) i++;
      while (less(x, a[j]!)) j--;
      if (i <= j) {
        [a[i], a[j]] = [a[j]!, a[i]!];
        i++;
        j--;
      }
    } while (i <= j);
    if (lo < j) sort(lo, j);
    if (i < hi) sort(i, hi);
  };
  if (a.length > 1) sort(0, a.length - 1);
}

class ConvexHullInternal {
  scaling = [0, 0, 0];
  center = [0, 0, 0];
  originalVertices: Vertex[] = [];
  mergeStamp = -3;
  minAxis = 0;
  medAxis = 0;
  maxAxis = 0;
  vertexList: Vertex | null = null;

  private newEdgePair(from: Vertex, to: Vertex): Edge {
    const e: Edge = { next: null, prev: null, reverse: null, target: to, copy: this.mergeStamp };
    const r: Edge = { next: null, prev: null, reverse: e, target: from, copy: this.mergeStamp };
    e.reverse = r;
    return e;
  }

  private removeEdgePair(edge: Edge): void {
    let n = edge.next!;
    const r = edge.reverse!;
    if (n !== edge) {
      n.prev = edge.prev;
      edge.prev!.next = n;
      r.target!.edges = n;
    } else r.target!.edges = null;
    n = r.next!;
    if (n !== r) {
      n.prev = r.prev;
      r.prev!.next = n;
      edge.target!.edges = n;
    } else edge.target!.edges = null;
  }

  private static getOrientation(prev: Edge, next: Edge, s: P32, t: P32): number {
    if (prev.next === next) {
      if (prev.prev === next) {
        const n = cross32(t, s);
        const base = next.reverse!.target!.point;
        const m = cross32(sub32(prev.target!.point, base), sub32(next.target!.point, base));
        return dot64(n, m) > 0n ? COUNTER_CLOCKWISE : CLOCKWISE;
      }
      return COUNTER_CLOCKWISE;
    }
    if (prev.prev === next) return CLOCKWISE;
    return NONE;
  }

  private findMaxAngle(ccw: boolean, start: Vertex, s: P32, rxs: P64, sxrxs: P64): { edge: Edge | null; minCot: Rational64 } {
    let minEdge: Edge | null = null;
    let minCot = new Rational64(0n, 0n);
    const e0 = start.edges;
    if (e0) {
      let e = e0;
      do {
        if (e.copy > this.mergeStamp) {
          const t = sub32(e.target!.point, start.point);
          const cot = new Rational64(dot32x64(t, sxrxs), dot32x64(t, rxs));
          if (!cot.isNaN()) {
            let cmp: number;
            if (minEdge === null) {
              minCot = cot;
              minEdge = e;
            } else if ((cmp = cot.compare(minCot)) < 0) {
              minCot = cot;
              minEdge = e;
            } else if (cmp === 0 && ccw === (ConvexHullInternal.getOrientation(minEdge, e, s, t) === COUNTER_CLOCKWISE)) {
              minEdge = e;
            }
          }
        }
        e = e.next!;
      } while (e !== start.edges);
    }
    return { edge: minEdge, minCot };
  }

  /** `findEdgeForCoplanarFaces`; e0 / e1 are in-out. */
  private findEdgeForCoplanarFaces(c0: Vertex, c1: Vertex, ref: { e0: Edge | null; e1: Edge | null }, stop0: Vertex | null, stop1: Vertex | null): void {
    const start0 = ref.e0;
    const start1 = ref.e1;
    let et0 = start0 ? start0.target!.point : c0.point;
    let et1 = start1 ? start1.target!.point : c1.point;
    const s = sub32(c1.point, c0.point);
    const normal = cross32x64(sub32((start0 ?? start1)!.target!.point, c0.point), { x: BigInt(s.x), y: BigInt(s.y), z: BigInt(s.z) });
    const dist = dot32x64(c0.point, normal);
    const perp = cross32x64(s, normal);

    let maxDot0 = dot32x64(et0, perp);
    if (ref.e0) {
      while (ref.e0.target !== stop0) {
        const e: Edge = ref.e0.reverse!.prev!;
        if (dot32x64(e.target!.point, normal) < dist) break;
        if (e.copy === this.mergeStamp) break;
        const dot = dot32x64(e.target!.point, perp);
        if (dot <= maxDot0) break;
        maxDot0 = dot;
        ref.e0 = e;
        et0 = e.target!.point;
      }
    }
    let maxDot1 = dot32x64(et1, perp);
    if (ref.e1) {
      while (ref.e1.target !== stop1) {
        const e: Edge = ref.e1.reverse!.next!;
        if (dot32x64(e.target!.point, normal) < dist) break;
        if (e.copy === this.mergeStamp) break;
        const dot = dot32x64(e.target!.point, perp);
        if (dot <= maxDot1) break;
        maxDot1 = dot;
        ref.e1 = e;
        et1 = e.target!.point;
      }
    }

    let dx = maxDot1 - maxDot0;
    if (dx > 0n) {
      for (;;) {
        const dy = dot32(sub32(et1, et0), s);
        if (ref.e0 && ref.e0.target !== stop0) {
          const f0 = ref.e0.next!.reverse!;
          if (f0.copy > this.mergeStamp) {
            const d = sub32(f0.target!.point, et0);
            const dx0 = dot32x64(d, perp);
            const dy0 = dot32(d, s);
            if (dx0 === 0n ? dy0 < 0n : dx0 < 0n && new Rational64(dy0, dx0).compare(new Rational64(dy, dx)) >= 0) {
              et0 = f0.target!.point;
              dx = dot32x64(sub32(et1, et0), perp);
              ref.e0 = ref.e0 === start0 ? null : f0;
              continue;
            }
          }
        }
        if (ref.e1 && ref.e1.target !== stop1) {
          const f1 = ref.e1.reverse!.next!;
          if (f1.copy > this.mergeStamp) {
            const d1 = sub32(f1.target!.point, et1);
            if (dot32x64(d1, normal) === 0n) {
              const dx1 = dot32x64(d1, perp);
              const dy1 = dot32(d1, s);
              const dxn = dot32x64(sub32(f1.target!.point, et0), perp);
              if (dxn > 0n && (dx1 === 0n ? dy1 < 0n : dx1 < 0n && new Rational64(dy1, dx1).compare(new Rational64(dy, dx)) > 0)) {
                ref.e1 = f1;
                et1 = f1.target!.point;
                dx = dxn;
                continue;
              }
            }
          }
        }
        break;
      }
    } else if (dx < 0n) {
      for (;;) {
        const dy = dot32(sub32(et1, et0), s);
        if (ref.e1 && ref.e1.target !== stop1) {
          const f1 = ref.e1.prev!.reverse!;
          if (f1.copy > this.mergeStamp) {
            const d = sub32(f1.target!.point, et1);
            const dx1 = dot32x64(d, perp);
            const dy1 = dot32(d, s);
            if (dx1 === 0n ? dy1 > 0n : dx1 < 0n && new Rational64(dy1, dx1).compare(new Rational64(dy, dx)) <= 0) {
              et1 = f1.target!.point;
              dx = dot32x64(sub32(et1, et0), perp);
              ref.e1 = ref.e1 === start1 ? null : f1;
              continue;
            }
          }
        }
        if (ref.e0 && ref.e0.target !== stop0) {
          const f0 = ref.e0.reverse!.prev!;
          if (f0.copy > this.mergeStamp) {
            const d0 = sub32(f0.target!.point, et0);
            if (dot32x64(d0, normal) === 0n) {
              const dx0 = dot32x64(d0, perp);
              const dy0 = dot32(d0, s);
              const dxn = dot32x64(sub32(et1, f0.target!.point), perp);
              if (dxn < 0n && (dx0 === 0n ? dy0 > 0n : dx0 < 0n && new Rational64(dy0, dx0).compare(new Rational64(dy, dx)) < 0)) {
                ref.e0 = f0;
                et0 = f0.target!.point;
                dx = dxn;
                continue;
              }
            }
          }
        }
        break;
      }
    }
  }

  private mergeProjection(h0: IntermediateHull, h1: IntermediateHull): { ok: boolean; c0: Vertex; c1: Vertex } {
    let v0 = h0.maxYx!;
    let v1 = h1.minYx!;
    if (v0.point.x === v1.point.x && v0.point.y === v1.point.y) {
      const v1p = v1.prev!;
      if (v1p === v1) {
        const c0 = v0;
        if (v1.edges) v1 = v1.edges.target!;
        return { ok: false, c0, c1: v1 };
      }
      const v1n = v1.next!;
      v1p.next = v1n;
      v1n.prev = v1p;
      if (v1 === h1.minXy) {
        h1.minXy = v1n.point.x < v1p.point.x || (v1n.point.x === v1p.point.x && v1n.point.y < v1p.point.y) ? v1n : v1p;
      }
      if (v1 === h1.maxXy) {
        h1.maxXy = v1n.point.x > v1p.point.x || (v1n.point.x === v1p.point.x && v1n.point.y > v1p.point.y) ? v1n : v1p;
      }
    }

    v0 = h0.maxXy!;
    v1 = h1.maxXy!;
    let v00: Vertex | null = null;
    let v10: Vertex | null = null;
    let sign = 1;
    for (let side = 0; side <= 1; side++) {
      let dx = (v1.point.x - v0.point.x) * sign;
      if (dx > 0) {
        for (;;) {
          const dy = v1.point.y - v0.point.y;
          const w0 = side ? v0.next! : v0.prev!;
          if (w0 !== v0) {
            const dx0 = (w0.point.x - v0.point.x) * sign;
            const dy0 = w0.point.y - v0.point.y;
            if (dy0 <= 0 && (dx0 === 0 || (dx0 < 0 && dy0 * dx <= dy * dx0))) {
              v0 = w0;
              dx = (v1.point.x - v0.point.x) * sign;
              continue;
            }
          }
          const w1 = side ? v1.next! : v1.prev!;
          if (w1 !== v1) {
            const dx1 = (w1.point.x - v1.point.x) * sign;
            const dy1 = w1.point.y - v1.point.y;
            const dxn = (w1.point.x - v0.point.x) * sign;
            if (dxn > 0 && dy1 < 0 && (dx1 === 0 || (dx1 < 0 && dy1 * dx < dy * dx1))) {
              v1 = w1;
              dx = dxn;
              continue;
            }
          }
          break;
        }
      } else if (dx < 0) {
        for (;;) {
          const dy = v1.point.y - v0.point.y;
          const w1 = side ? v1.prev! : v1.next!;
          if (w1 !== v1) {
            const dx1 = (w1.point.x - v1.point.x) * sign;
            const dy1 = w1.point.y - v1.point.y;
            if (dy1 >= 0 && (dx1 === 0 || (dx1 < 0 && dy1 * dx <= dy * dx1))) {
              v1 = w1;
              dx = (v1.point.x - v0.point.x) * sign;
              continue;
            }
          }
          const w0 = side ? v0.prev! : v0.next!;
          if (w0 !== v0) {
            const dx0 = (w0.point.x - v0.point.x) * sign;
            const dy0 = w0.point.y - v0.point.y;
            const dxn = (v1.point.x - w0.point.x) * sign;
            if (dxn < 0 && dy0 > 0 && (dx0 === 0 || (dx0 < 0 && dy0 * dx < dy * dx0))) {
              v0 = w0;
              dx = dxn;
              continue;
            }
          }
          break;
        }
      } else {
        const x = v0.point.x;
        let y0 = v0.point.y;
        let w0 = v0;
        let t: Vertex;
        while ((t = side ? w0.next! : w0.prev!) !== v0 && t.point.x === x && t.point.y <= y0) {
          w0 = t;
          y0 = t.point.y;
        }
        v0 = w0;
        let y1 = v1.point.y;
        let w1 = v1;
        while ((t = side ? w1.prev! : w1.next!) !== v1 && t.point.x === x && t.point.y >= y1) {
          w1 = t;
          y1 = t.point.y;
        }
        v1 = w1;
      }
      if (side === 0) {
        v00 = v0;
        v10 = v1;
        v0 = h0.minXy!;
        v1 = h1.minXy!;
        sign = -1;
      }
    }
    v0.prev = v1;
    v1.next = v0;
    v00!.next = v10;
    v10!.prev = v00;
    if (h1.minXy!.point.x < h0.minXy!.point.x) h0.minXy = h1.minXy;
    if (h1.maxXy!.point.x >= h0.maxXy!.point.x) h0.maxXy = h1.maxXy;
    h0.maxYx = h1.maxYx;
    return { ok: true, c0: v00!, c1: v10! };
  }

  computeInternal(start: number, end: number, result: IntermediateHull): void {
    const n = end - start;
    const single = (v: Vertex): void => {
      v.edges = null;
      v.next = v;
      v.prev = v;
      result.minXy = result.maxXy = result.minYx = result.maxYx = v;
    };
    switch (n) {
      case 0:
        result.minXy = result.maxXy = result.minYx = result.maxYx = null;
        return;
      case 2: {
        let v = this.originalVertices[start]!;
        let w = this.originalVertices[start + 1]!; // `v + 1` in the pool
        if (!eq32(v.point, w.point)) {
          const dx = v.point.x - w.point.x;
          const dy = v.point.y - w.point.y;
          if (dx === 0 && dy === 0) {
            if (v.point.z > w.point.z) [v, w] = [w, v];
            v.next = v;
            v.prev = v;
            result.minXy = result.maxXy = result.minYx = result.maxYx = v;
          } else {
            v.next = w;
            v.prev = w;
            w.next = v;
            w.prev = v;
            if (dx < 0 || (dx === 0 && dy < 0)) {
              result.minXy = v;
              result.maxXy = w;
            } else {
              result.minXy = w;
              result.maxXy = v;
            }
            if (dy < 0 || (dy === 0 && dx < 0)) {
              result.minYx = v;
              result.maxYx = w;
            } else {
              result.minYx = w;
              result.maxYx = v;
            }
          }
          let e = this.newEdgePair(v, w);
          link(e, e);
          v.edges = e;
          e = e.reverse!;
          link(e, e);
          w.edges = e;
          return;
        }
        single(this.originalVertices[start]!);
        return;
      }
      case 1:
        single(this.originalVertices[start]!);
        return;
    }
    const split0 = start + (n >> 1);
    const p = this.originalVertices[split0 - 1]!.point;
    let split1 = split0;
    while (split1 < end && eq32(this.originalVertices[split1]!.point, p)) split1++;
    this.computeInternal(start, split0, result);
    const hull1 = newHull();
    this.computeInternal(split1, end, hull1);
    this.merge(result, hull1);
  }

  private merge(h0: IntermediateHull, h1: IntermediateHull): void {
    if (!h1.maxXy) return;
    if (!h0.maxXy) {
      Object.assign(h0, h1);
      return;
    }
    this.mergeStamp--;
    let toPrev0: Edge | null = null;
    let firstNew0: Edge | null = null;
    let pendingHead0: Edge | null = null;
    let pendingTail0: Edge | null = null;
    let toPrev1: Edge | null = null;
    let firstNew1: Edge | null = null;
    let pendingHead1: Edge | null = null;
    let pendingTail1: Edge | null = null;
    let prevPoint: P32;

    const mp = this.mergeProjection(h0, h1);
    let c0 = mp.c0;
    let c1 = mp.c1;
    if (mp.ok) {
      const s = sub32(c1.point, c0.point);
      const down: P32 = { x: 0, y: 0, z: -1, index: -1 };
      const normal = cross32(down, s);
      const t = cross32x64(s, normal);
      let start0: Edge | null = null;
      let e = c0.edges;
      if (e) {
        do {
          const d = sub32(e.target!.point, c0.point);
          if (dot32x64(d, normal) === 0n && dot32x64(d, t) > 0n) {
            if (!start0 || ConvexHullInternal.getOrientation(start0, e, s, down) === CLOCKWISE) start0 = e;
          }
          e = e.next!;
        } while (e !== c0.edges);
      }
      let start1: Edge | null = null;
      e = c1.edges;
      if (e) {
        do {
          const d = sub32(e.target!.point, c1.point);
          if (dot32x64(d, normal) === 0n && dot32x64(d, t) > 0n) {
            if (!start1 || ConvexHullInternal.getOrientation(start1, e, s, down) === COUNTER_CLOCKWISE) start1 = e;
          }
          e = e.next!;
        } while (e !== c1.edges);
      }
      if (start0 || start1) {
        const ref = { e0: start0, e1: start1 };
        this.findEdgeForCoplanarFaces(c0, c1, ref, null, null);
        if (ref.e0) c0 = ref.e0.target!;
        if (ref.e1) c1 = ref.e1.target!;
      }
      prevPoint = { ...c1.point };
      prevPoint.z++;
    } else {
      prevPoint = { ...c1.point };
      prevPoint.x++;
    }

    const first0 = c0;
    const first1 = c1;
    let firstRun = true;
    for (;;) {
      const s = sub32(c1.point, c0.point);
      const r = sub32(prevPoint, c0.point);
      const rxs = cross32(r, s);
      const sxrxs = cross32x64(s, rxs);
      const m0 = this.findMaxAngle(false, c0, s, rxs, sxrxs);
      const m1 = this.findMaxAngle(true, c1, s, rxs, sxrxs);
      const min0 = m0.edge;
      const min1 = m1.edge;
      if (!min0 && !min1) {
        let e = this.newEdgePair(c0, c1);
        link(e, e);
        c0.edges = e;
        e = e.reverse!;
        link(e, e);
        c1.edges = e;
        return;
      }
      const cmp = !min0 ? 1 : !min1 ? -1 : m0.minCot.compare(m1.minCot);
      if (firstRun || (cmp >= 0 ? !m1.minCot.isNegativeInfinity() : !m0.minCot.isNegativeInfinity())) {
        let e = this.newEdgePair(c0, c1);
        if (pendingTail0) pendingTail0.prev = e;
        else pendingHead0 = e;
        e.next = pendingTail0;
        pendingTail0 = e;
        e = e.reverse!;
        if (pendingTail1) pendingTail1.next = e;
        else pendingHead1 = e;
        e.prev = pendingTail1;
        pendingTail1 = e;
      }
      const ref = { e0: min0, e1: min1 };
      if (cmp === 0) this.findEdgeForCoplanarFaces(c0, c1, ref, null, null);
      const e0 = ref.e0;
      const e1 = ref.e1;

      if (cmp >= 0 && e1) {
        if (toPrev1) {
          for (let e = toPrev1.next!, n: Edge | null = null; e !== min1; e = n!) {
            n = e.next;
            this.removeEdgePair(e);
          }
        }
        if (pendingTail1) {
          if (toPrev1) link(toPrev1, pendingHead1!);
          else {
            link(min1!.prev!, pendingHead1!);
            firstNew1 = pendingHead1;
          }
          link(pendingTail1, min1!);
          pendingHead1 = null;
          pendingTail1 = null;
        } else if (!toPrev1) firstNew1 = min1;
        prevPoint = c1.point;
        c1 = e1.target!;
        toPrev1 = e1.reverse;
      }
      if (cmp <= 0 && e0) {
        if (toPrev0) {
          for (let e = toPrev0.prev!, n: Edge | null = null; e !== min0; e = n!) {
            n = e.prev;
            this.removeEdgePair(e);
          }
        }
        if (pendingTail0) {
          if (toPrev0) link(pendingHead0!, toPrev0);
          else {
            link(pendingHead0!, min0!.next!);
            firstNew0 = pendingHead0;
          }
          link(min0!, pendingTail0);
          pendingHead0 = null;
          pendingTail0 = null;
        } else if (!toPrev0) firstNew0 = min0;
        prevPoint = c0.point;
        c0 = e0.target!;
        toPrev0 = e0.reverse;
      }

      if (c0 === first0 && c1 === first1) {
        if (toPrev0 === null) {
          link(pendingHead0!, pendingTail0!);
          c0.edges = pendingTail0;
        } else {
          for (let e = toPrev0.prev!, n: Edge | null = null; e !== firstNew0; e = n!) {
            n = e.prev;
            this.removeEdgePair(e);
          }
          if (pendingTail0) {
            link(pendingHead0!, toPrev0);
            link(firstNew0!, pendingTail0);
          }
        }
        if (toPrev1 === null) {
          link(pendingTail1!, pendingHead1!);
          c1.edges = pendingTail1;
        } else {
          for (let e = toPrev1.next!, n: Edge | null = null; e !== firstNew1; e = n!) {
            n = e.next;
            this.removeEdgePair(e);
          }
          if (pendingTail1) {
            link(toPrev1, pendingHead1!);
            link(pendingTail1, firstNew1!);
          }
        }
        return;
      }
      firstRun = false;
    }
  }

  compute(coords: readonly number[][]): void {
    const count = coords.length;
    const min = [1e30, 1e30, 1e30];
    const max = [-1e30, -1e30, -1e30];
    for (const p of coords)
      for (let k = 0; k < 3; k++) {
        if (p[k]! < min[k]!) min[k] = p[k]!;
        if (p[k]! > max[k]!) max[k] = p[k]!;
      }
    const s = [max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!];
    // btVector3::maxAxis / minAxis
    this.maxAxis = s[0]! < s[1]! ? (s[1]! < s[2]! ? 2 : 1) : s[0]! < s[2]! ? 2 : 0;
    this.minAxis = s[0]! < s[1]! ? (s[0]! < s[2]! ? 0 : 2) : s[1]! < s[2]! ? 1 : 2;
    if (this.minAxis === this.maxAxis) this.minAxis = (this.maxAxis + 1) % 3;
    this.medAxis = 3 - this.maxAxis - this.minAxis;
    for (let k = 0; k < 3; k++) s[k] = s[k]! / 10216;
    if ((this.medAxis + 1) % 3 !== this.maxAxis) for (let k = 0; k < 3; k++) s[k] = s[k]! * -1;
    this.scaling = [...s];
    for (let k = 0; k < 3; k++) if (s[k] !== 0) s[k] = 1 / s[k]!;
    this.center = [0, 1, 2].map((k) => (min[k]! + max[k]!) * 0.5);

    const points: P32[] = coords.map((p, i) => {
      const q = [0, 1, 2].map((k) => (p[k]! - this.center[k]!) * s[k]!);
      return { x: Math.trunc(q[this.medAxis]!), y: Math.trunc(q[this.maxAxis]!), z: Math.trunc(q[this.minAxis]!), index: i };
    });
    btQuickSort(points, (p, q) => p.y < q.y || (p.y === q.y && (p.x < q.x || (p.x === q.x && p.z < q.z))));
    this.originalVertices = points.map((point) => ({ next: null, prev: null, edges: null, point, copy: -1 }));
    this.mergeStamp = -3;
    const hull = newHull();
    this.computeInternal(0, count, hull);
    this.vertexList = hull.minXy;
  }
}

/** One edge of the output, as `btConvexHullComputer::Edge` (relative links). */
interface OutEdge {
  next: number;
  reverse: number;
  targetVertex: number;
}

export interface BulletHull {
  /** The input index of each hull vertex (`original_vertex_index`). */
  originalIndex: number[];
  /** Faces as hull-vertex indices, in Bullet's order and winding. */
  faces: number[][];
}

/**
 * `plConvexHullCompute` + `plConvexHullGetFaceVertices` for every face: the
 * hull of `coords` (float positions, as Blender passes them), each face a
 * planar polygon of hull-vertex indices.
 */
export function bulletConvexHull(coords: readonly number[][]): BulletHull {
  if (coords.length === 0) return { originalIndex: [], faces: [] };
  const hull = new ConvexHullInternal();
  hull.compute(coords.map((p) => p.map(Math.fround)));

  const originalIndex: number[] = [];
  const edges: OutEdge[] = [];
  const faces: number[] = [];
  const oldVertices: Vertex[] = [];
  const edgeCopy = new Map<Edge, number>();
  const getVertexCopy = (v: Vertex): number => {
    if (v.copy < 0) {
      v.copy = oldVertices.length;
      oldVertices.push(v);
    }
    return v.copy;
  };
  getVertexCopy(hull.vertexList!);
  let copied = 0;
  while (copied < oldVertices.length) {
    const v = oldVertices[copied]!;
    originalIndex.push(v.point.index);
    const firstEdge = v.edges;
    if (firstEdge) {
      let firstCopy = -1;
      let prevCopy = -1;
      let e = firstEdge;
      do {
        if (!edgeCopy.has(e)) {
          // Bullet reuses the `copy` field (a negative merge stamp until
          // here) for the output index; the index is kept apart instead.
          const s = edges.length;
          edges.push({ next: 0, reverse: 1, targetVertex: getVertexCopy(e.target!) });
          edges.push({ next: 0, reverse: -1, targetVertex: copied });
          edgeCopy.set(e, s);
          edgeCopy.set(e.reverse!, s + 1);
        }
        const ec = edgeCopy.get(e)!;
        if (prevCopy >= 0) edges[ec]!.next = prevCopy - ec;
        else firstCopy = ec;
        prevCopy = ec;
        e = e.next!;
      } while (e !== firstEdge);
      edges[firstCopy]!.next = prevCopy - firstCopy;
    }
    copied++;
  }
  const done = new Set<Edge>();
  for (let i = 0; i < copied; i++) {
    const firstEdge = oldVertices[i]!.edges;
    if (!firstEdge) continue;
    let e = firstEdge;
    do {
      if (!done.has(e)) {
        faces.push(edgeCopy.get(e)!);
        let f = e;
        do {
          done.add(f);
          f = f.reverse!.prev!;
        } while (f !== e);
      }
      e = e.next!;
    } while (e !== firstEdge);
  }

  // `plConvexHullGetFaceVertices`: walk `getNextEdgeOfFace` from each face's edge.
  const nextOfFace = (i: number): number => {
    const r = i + edges[i]!.reverse;
    return r + edges[r]!.next;
  };
  const out = faces.map((f0) => {
    const verts: number[] = [];
    let e = f0;
    do {
      verts.push(edges[e]!.targetVertex);
      e = nextOfFace(e);
    } while (e !== f0);
    return verts;
  });
  return { originalIndex, faces: out };
}

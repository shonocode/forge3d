/**
 * Tao Ju's dual contouring on an octree — Blender's `intern/dualcon`, which
 * the Remesh modifier runs for its Blocks, Smooth and Sharp modes. Ported
 * function by function (`octree.cpp`, `octree.h`, `Projections.cpp`,
 * `dualcon_c_api.cpp`) so that the same triangles give the same quads.
 *
 * What makes that possible: the triangles are snapped once to a 2^20 grid
 * (float → int64 truncation) and from there the scan conversion is integer
 * arithmetic — done here in BigInt, since the projections reach ~2^61. The
 * rest is float32, and Blender builds with `-ffp-contract=off` (no fused
 * multiply-add), so every float operation is emulated with `Math.fround`
 * in the order C evaluates it.
 *
 * Where the port departs from the C++ without changing a result:
 *
 * - **Nodes are mutated in place.** The C++ reallocates a node whenever its
 *   child or edge count changes, and re-links it with `updateParent`; with
 *   one object per node those re-links are no-ops.
 * - `char` is **unsigned**: Blender builds with `/J` / `-funsigned-char`, and
 *   the vertex count test `smask > 0 && smask < 255` depends on it.
 * - `use_manifold` is always off in Blender, so the manifold and marching
 *   cubes tables are not ported.
 */

const f = Math.fround;

const GRID_DIMENSION = 20;
const NUM_AXES = 13;

// ── tables (Projections.cpp, octree.cpp) ────────────────────────────────────

const vertmap = [
  [0, 0, 0], [0, 0, 1], [0, 1, 0], [0, 1, 1], [1, 0, 0], [1, 0, 1], [1, 1, 0], [1, 1, 1],
] as const;
const edgemap = [
  [0, 4], [1, 5], [2, 6], [3, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 1], [2, 3], [4, 5], [6, 7],
] as const;
const faceMap = [
  [4, 8, 5, 9], [6, 10, 7, 11], [0, 8, 1, 10], [2, 9, 3, 11], [0, 4, 2, 6], [1, 5, 3, 7],
] as const;
const cellProcFaceMask = [
  [0, 4, 0], [1, 5, 0], [2, 6, 0], [3, 7, 0], [0, 2, 1], [4, 6, 1],
  [1, 3, 1], [5, 7, 1], [0, 1, 2], [2, 3, 2], [4, 5, 2], [6, 7, 2],
] as const;
const cellProcEdgeMask = [
  [0, 1, 2, 3, 0], [4, 5, 6, 7, 0], [0, 4, 1, 5, 1], [2, 6, 3, 7, 1], [0, 2, 4, 6, 2], [1, 3, 5, 7, 2],
] as const;
const faceProcFaceMask = [
  [[4, 0, 0], [5, 1, 0], [6, 2, 0], [7, 3, 0]],
  [[2, 0, 1], [6, 4, 1], [3, 1, 1], [7, 5, 1]],
  [[1, 0, 2], [3, 2, 2], [5, 4, 2], [7, 6, 2]],
] as const;
const faceProcEdgeMask = [
  [[1, 4, 0, 5, 1, 1], [1, 6, 2, 7, 3, 1], [0, 4, 6, 0, 2, 2], [0, 5, 7, 1, 3, 2]],
  [[0, 2, 3, 0, 1, 0], [0, 6, 7, 4, 5, 0], [1, 2, 0, 6, 4, 2], [1, 3, 1, 7, 5, 2]],
  [[1, 1, 0, 3, 2, 0], [1, 5, 4, 7, 6, 0], [0, 1, 5, 0, 4, 1], [0, 3, 7, 2, 6, 1]],
] as const;
const edgeProcEdgeMask = [
  [[3, 2, 1, 0, 0], [7, 6, 5, 4, 0]],
  [[5, 1, 4, 0, 1], [7, 3, 6, 2, 1]],
  [[6, 4, 2, 0, 2], [7, 5, 3, 1, 2]],
] as const;
const processEdgeMask = [[3, 2, 1, 0], [7, 5, 6, 4], [11, 10, 9, 8]] as const;
const dirCell = [
  [[0, -1, -1], [0, -1, 0], [0, 0, -1], [0, 0, 0]],
  [[-1, 0, -1], [-1, 0, 0], [0, 0, -1], [0, 0, 0]],
  [[-1, -1, 0], [-1, 0, 0], [0, -1, 0], [0, 0, 0]],
] as const;
const dirEdge = [[3, 2, 1, 0], [7, 6, 5, 4], [11, 10, 9, 8]] as const;

// ── projections (Projections.cpp) ───────────────────────────────────────────

interface TriangleProjection {
  triProj: [bigint, bigint][];
  norm: [number, number, number];
  index: number;
}

interface CubeProjection {
  origin: bigint;
  edges: [bigint, bigint, bigint];
  min: bigint;
  max: bigint;
}

const bmax = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const bmin = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const cross64 = (a: bigint[], b: bigint[]): bigint[] => [
  a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!,
];
const dot64 = (a: bigint[], b: readonly bigint[]): bigint => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

class CubeTriangleIsect {
  inherit!: TriangleProjection;
  cubeProj!: CubeProjection[];

  /** From the whole grid cube and a triangle already on the grid. */
  static root(cube: bigint[][], tri: bigint[][], triind: number): CubeTriangleIsect {
    const r = new CubeTriangleIsect();
    const axes: bigint[][] = [[1n, 0n, 0n], [0n, 1n, 0n], [0n, 0n, 1n]];
    const triEdges = [0, 1, 2].map((i) => [0, 1, 2].map((j) => tri[(i + 1) % 3]![j]! - tri[i]![j]!));
    axes[3] = cross64(triEdges[0]!, triEdges[1]!);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) axes.push(cross64(axes[j]!, triEdges[i]!));

    // Normal in doubles, normalised.
    const t = tri.map((v) => v.map(Number));
    const d1 = [t[1]![0]! - t[0]![0]!, t[1]![1]! - t[0]![1]!, t[1]![2]! - t[0]![2]!];
    const d2 = [t[2]![0]! - t[1]![0]!, t[2]![1]! - t[1]![1]!, t[2]![2]! - t[1]![2]!];
    const n: [number, number, number] = [
      d1[1]! * d2[2]! - d1[2]! * d2[1]!,
      d1[2]! * d2[0]! - d1[0]! * d2[2]!,
      d1[0]! * d2[1]! - d1[1]! * d2[0]!,
    ];
    let mag = n[0] * n[0] + n[1] * n[1] + n[2] * n[2];
    if (mag > 0) {
      mag = Math.sqrt(mag);
      n[0] /= mag;
      n[1] /= mag;
      n[2] /= mag;
    }

    const cubeedge = [0, 1, 2].map((i) => [0, 1, 2].map((j) => (i === j ? cube[1]![i]! - cube[0]![i]! : 0n)));
    r.cubeProj = axes.map((axis) => {
      const origin = dot64(axis, cube[0]!);
      const edges = cubeedge.map((e) => dot64(axis, e)) as [bigint, bigint, bigint];
      let max = 0n;
      let min = 0n;
      for (let i = 1; i < 8; i++) {
        const proj =
          BigInt(vertmap[i]![0]) * edges[0] + BigInt(vertmap[i]![1]) * edges[1] + BigInt(vertmap[i]![2]) * edges[2];
        max = bmax(proj, max);
        min = bmin(proj, min);
      }
      return { origin, edges, min, max };
    });
    r.inherit = {
      index: triind,
      norm: n,
      triProj: axes.map((axis) => {
        const vts = tri.map((v) => dot64(axis, v));
        let lo = vts[0]!;
        let hi = vts[0]!;
        for (let i = 1; i < 3; i++) {
          lo = bmin(vts[i]!, lo);
          hi = bmax(vts[i]!, hi);
        }
        return [lo, hi];
      }),
    };
    return r;
  }

  /** The same triangle against a child cube: every cube projection halved. */
  static child(parent: CubeTriangleIsect): CubeTriangleIsect {
    const r = new CubeTriangleIsect();
    r.inherit = parent.inherit;
    r.cubeProj = parent.cubeProj.map((c) => ({
      origin: c.origin,
      edges: [c.edges[0] >> 1n, c.edges[1] >> 1n, c.edges[2] >> 1n],
      min: c.min >> 1n,
      max: c.max >> 1n,
    }));
    return r;
  }

  getBoxMask(): number {
    const bmask = [[0, 0], [0, 0], [0, 0]];
    const childLen = this.cubeProj[0]!.edges[0] >> 1n;
    for (let i = 0; i < 3; i++) {
      const mid = this.cubeProj[i]!.origin + childLen;
      if (mid >= this.inherit.triProj[i]![0]) bmask[i]![0] = 1;
      if (mid < this.inherit.triProj[i]![1]) bmask[i]![1] = 1;
    }
    let boxmask = 0;
    let ct = 0;
    for (let i = 0; i < 2; i++)
      for (let j = 0; j < 2; j++)
        for (let k = 0; k < 2; k++) {
          boxmask |= (bmask[0]![i]! & bmask[1]![j]! & bmask[2]![k]!) << ct;
          ct++;
        }
    return boxmask;
  }

  shift(off: readonly number[]): void {
    for (const c of this.cubeProj)
      c.origin += BigInt(off[0]!) * c.edges[0] + BigInt(off[1]!) * c.edges[1] + BigInt(off[2]!) * c.edges[2];
  }

  isIntersecting(): boolean {
    for (let i = 0; i < NUM_AXES; i++) {
      const c = this.cubeProj[i]!;
      const p0 = c.origin + c.min;
      const p1 = c.origin + c.max;
      if (p0 > this.inherit.triProj[i]![1] || p1 < this.inherit.triProj[i]![0]) return false;
    }
    return true;
  }

  isIntersectingPrimary(edgeInd: number): boolean {
    for (let i = 0; i < NUM_AXES; i++) {
      const c = this.cubeProj[i]!;
      const p0 = c.origin;
      const p1 = c.origin + c.edges[edgeInd]!;
      const [lo, hi] = this.inherit.triProj[i]!;
      if (p0 < p1) {
        if (p0 > hi || p1 < lo) return false;
      } else if (p1 > hi || p0 < lo) return false;
    }
    return true;
  }

  getIntersectionPrimary(edgeInd: number): number {
    const c = this.cubeProj[3]!;
    const p0 = c.origin;
    const p1 = c.origin + c.edges[edgeInd]!;
    const p2 = this.inherit.triProj[3]![1];
    const d = p1 - p0;
    let alpha: number;
    if (d === 0n) alpha = 0.5;
    else {
      alpha = Number(p2 - p0) / Number(d);
      if (alpha < 0 || alpha > 1) alpha = 0.5;
    }
    return f(alpha);
  }
}

// ── nodes ───────────────────────────────────────────────────────────────────

interface Internal {
  leaf: false;
  hasChild: number;
  childIsLeaf: number;
  /** Dense, in child-index order, as the C++ `children[]`. */
  children: Node[];
}

interface Leaf {
  leaf: true;
  /** 12 bits. */
  edgeParity: number;
  /** 3 bits: which primal edges (0, 4, 8) have a stored intersection. */
  primary: number;
  /** 8 bits, unsigned (`/J`). */
  signs: number;
  minimizerIndex: number;
  floodFill: number;
  /** 4 floats per stored intersection: offset, normal xyz. */
  edges: number[];
}

type Node = Internal | Leaf;

const popcount8 = (x: number): number => {
  let c = 0;
  for (let i = 0; i < 8; i++) c += (x >> i) & 1;
  return c;
};
const childCount = (n: Internal, index: number): number => popcount8(n.hasChild & ((1 << index) - 1));
const hasChild = (n: Internal, i: number): boolean => ((n.hasChild >> i) & 1) === 1;
const isChildLeaf = (n: Internal, i: number): boolean => ((n.childIsLeaf >> i) & 1) === 1;
const createInternal = (): Internal => ({ leaf: false, hasChild: 0, childIsLeaf: 0, children: [] });
const createLeaf = (): Leaf => ({ leaf: true, edgeParity: 0, primary: 0, signs: 0, minimizerIndex: 0, floodFill: 0, edges: [] });

/** `fill_children`: children by index (null where none), and which are leaves. */
function fillChildren(n: Internal): { chd: (Node | null)[]; leaf: boolean[] } {
  const chd: (Node | null)[] = [];
  const leaf: boolean[] = [];
  let count = 0;
  for (let i = 0; i < 8; i++) {
    if (hasChild(n, i)) {
      chd.push(n.children[count]!);
      leaf.push(isChildLeaf(n, i));
      count++;
    } else {
      chd.push(null);
      leaf.push(false);
    }
  }
  return { chd, leaf };
}

const childOrNull = (n: Node | null, isLeaf: boolean, i: number): Node | null =>
  !isLeaf && n && !n.leaf && hasChild(n, i) ? n.children[childCount(n, i)]! : null;
const childIsLeafOf = (n: Node | null, i: number): boolean => (n && !n.leaf ? isChildLeaf(n, i) : false);

// numEdgeTable / edgeCountTable
const numEdgeTable: number[] = [];
const edgeCountTable: number[][] = [];
for (let i = 0; i < 8; i++) {
  numEdgeTable[i] = 0;
  edgeCountTable[i] = [];
  let count = 0;
  for (let j = 0; j < 3; j++) {
    numEdgeTable[i]! += (i >> j) & 1;
    edgeCountTable[i]![j] = count;
    count += (i >> j) & 1;
  }
}

const getEdgeParity = (l: Leaf, i: number): number => (l.edgeParity >> i) & 1;
const getStoredEdgesParity = (l: Leaf, p: number): number => (l.primary >> p) & 1;
const getEdgeCount = (l: Leaf, index: number): number => edgeCountTable[l.primary]![index]!;
const primalEdgesMask2 = (l: Leaf): number =>
  ((l.edgeParity & 0x1) >> 0) | ((l.edgeParity & 0x10) >> 3) | ((l.edgeParity & 0x100) >> 6);
const getSign = (l: Leaf, i: number): number => (l.signs >> i) & 1;
const getFaceEdgeNum = (l: Leaf, index: number): number =>
  getEdgeParity(l, faceMap[index]![0]) +
  getEdgeParity(l, faceMap[index]![1]) +
  getEdgeParity(l, faceMap[index]![2]) +
  getEdgeParity(l, faceMap[index]![3]);

// ── paths ───────────────────────────────────────────────────────────────────

interface PathElement {
  pos: [number, number, number];
  next: PathElement | null;
}

interface PathList {
  head: PathElement | null;
  tail: PathElement | null;
  length: number;
  next: PathList | null;
}

const isEqual = (a: PathElement, b: PathElement): boolean =>
  a.pos[0] === b.pos[0] && a.pos[1] === b.pos[1] && a.pos[2] === b.pos[2];

// ── the octree ──────────────────────────────────────────────────────────────

export type DualConMode = "centroid" | "masspoint" | "sharp";

export interface DualConOutput {
  positions: number[];
  quads: [number, number, number, number][];
}

export class Octree {
  private root: Internal;
  private readonly dimen = 1 << GRID_DIMENSION;
  private readonly mindimen: number;
  private readonly minshift: number;
  private readonly maxDepth: number;
  private readonly origin: number[];
  private readonly range: number;
  private readonly useFloodFill: boolean;
  private readonly thresh: number;
  private readonly hermiteNum: number;
  private readonly mode: DualConMode;
  private out: DualConOutput = { positions: [], quads: [] };

  constructor(
    origin: number[],
    range: number,
    depth: number,
    mode: DualConMode,
    floodFill: boolean,
    threshold: number,
    sharpness: number,
  ) {
    this.origin = origin;
    this.range = range;
    this.maxDepth = depth;
    this.mindimen = this.dimen >> depth;
    this.minshift = GRID_DIMENSION - depth;
    this.mode = mode;
    this.useFloodFill = floodFill;
    this.thresh = f(threshold);
    this.hermiteNum = f(sharpness);
    this.root = createInternal();
  }

  /** `scanConvert`, with the triangles given up front. */
  run(triangles: number[][][]): DualConOutput {
    triangles.forEach((t, i) => this.addTriangle(t, i));
    this.cellProcParity(this.root, false, this.maxDepth);
    this.preparePrimalEdgesMask(this.root);
    this.trace();
    this.trace(); // "Check again"
    this.buildSigns();
    if (this.useFloodFill) {
      this.floodFill();
      this.buildSigns();
    }
    this.writeOut();
    return this.out;
  }

  // ── scan conversion ──

  private addTriangle(vt: number[][], triind: number): void {
    // Onto the grid: `dimen * (v - origin) / range`, in float, then truncated.
    const trig = vt.map((v) =>
      v.map((c, j) => BigInt(Math.trunc(f(f(this.dimen * f(c - this.origin[j]!)) / this.range)))),
    );
    const D = BigInt(this.dimen);
    const proj = CubeTriangleIsect.root([[0n, 0n, 0n], [D, D, D]], trig, triind);
    this.addTriangleNode(this.root, proj, this.maxDepth);
  }

  private addTriangleNode(node: Internal, p: CubeTriangleIsect, height: number): Internal {
    const vertdiff = [[0, 0, 0], [0, 0, 1], [0, 1, -1], [0, 0, 1], [1, -1, -1], [0, 0, 1], [0, 1, -1], [0, 0, 1]];
    const boxmask = p.getBoxMask();
    const subp = CubeTriangleIsect.child(p);
    let count = 0;
    const tempdiff = [0, 0, 0];
    for (let i = 0; i < 8; i++) {
      for (let k = 0; k < 3; k++) tempdiff[k]! += vertdiff[i]![k]!;
      if (boxmask & (1 << i)) {
        subp.shift(tempdiff);
        tempdiff.fill(0);
        if (subp.isIntersecting()) {
          if (!hasChild(node, i)) {
            if (height === 1) this.addLeafChild(node, i, count, createLeaf());
            else this.addInternalChild(node, i, count, createInternal());
          }
          const chd = node.children[count]!;
          if (isChildLeaf(node, i)) this.updateCell(chd as Leaf, subp);
          else this.addTriangleNode(chd as Internal, subp, height - 1);
        }
      }
      if (hasChild(node, i)) count++;
    }
    return node;
  }

  private addLeafChild(par: Internal, index: number, count: number, leaf: Leaf): void {
    par.children.splice(count, 0, leaf);
    par.hasChild |= 1 << index;
    par.childIsLeaf |= 1 << index;
  }

  private addInternalChild(par: Internal, index: number, count: number, node: Internal): void {
    par.children.splice(count, 0, node);
    par.hasChild |= 1 << index;
  }

  /** `addChild`: insert at the position of `index` among the existing children. */
  private addChild(node: Internal, index: number, child: Node, aLeaf: boolean): Internal {
    node.children.splice(childCount(node, index), 0, child);
    node.hasChild |= 1 << index;
    if (aLeaf) node.childIsLeaf |= 1 << index;
    return node;
  }

  /** `updateCell`: record the triangle's crossings of the cell's three primal edges. */
  private updateCell(node: Leaf, p: CubeTriangleIsect): void {
    const mask = [0, 4, 8];
    let oldc = 0;
    let newc = 0;
    const offs: number[] = [];
    const a: number[] = [];
    const b: number[] = [];
    const c: number[] = [];
    for (let i = 0; i < 3; i++) {
      if (!getEdgeParity(node, mask[i]!)) {
        if (p.isIntersectingPrimary(i)) {
          node.edgeParity |= 1 << mask[i]!;
          offs[newc] = p.getIntersectionPrimary(i);
          a[newc] = f(p.inherit.norm[0]);
          b[newc] = f(p.inherit.norm[1]);
          c[newc] = f(p.inherit.norm[2]);
          newc++;
        }
      } else {
        offs[newc] = node.edges[4 * oldc]!;
        a[newc] = node.edges[4 * oldc + 1]!;
        b[newc] = node.edges[4 * oldc + 2]!;
        c[newc] = node.edges[4 * oldc + 3]!;
        oldc++;
        newc++;
      }
    }
    if (newc > oldc) {
      const e: number[] = [];
      for (let i = 0; i < newc; i++) e.push(offs[i]!, a[i]!, b[i]!, c[i]!);
      node.edges = e;
    }
  }

  private preparePrimalEdgesMask(node: Internal): void {
    let count = 0;
    for (let i = 0; i < 8; i++) {
      if (!hasChild(node, i)) continue;
      const chd = node.children[count]!;
      if (isChildLeaf(node, i)) (chd as Leaf).primary = primalEdgesMask2(chd as Leaf);
      else this.preparePrimalEdgesMask(chd as Internal);
      count++;
    }
  }

  // ── minimal edges (cellProcParity) ──

  private processEdgeParity(node: Leaf[], dir: number): void {
    let con = false;
    for (let i = 0; i < 4; i++)
      if (getEdgeParity(node[i]!, processEdgeMask[dir]![i]!)) {
        con = true;
        break;
      }
    if (con) for (let i = 0; i < 4; i++) node[i]!.edgeParity |= 1 << processEdgeMask[dir]![i]!;
  }

  private edgeProcParity(node: (Node | null)[], leaf: boolean[], dir: number): void {
    if (!(node[0] && node[1] && node[2] && node[3])) return;
    if (leaf[0] && leaf[1] && leaf[2] && leaf[3]) {
      this.processEdgeParity(node as Leaf[], dir);
      return;
    }
    for (let i = 0; i < 2; i++) {
      const c = edgeProcEdgeMask[dir]![i]!;
      const ne: (Node | null)[] = [];
      const le: boolean[] = [];
      for (let j = 0; j < 4; j++) {
        if (leaf[j]) {
          le[j] = leaf[j]!;
          ne[j] = node[j]!;
        } else {
          le[j] = childIsLeafOf(node[j]!, c[j]!);
          ne[j] = childOrNull(node[j]!, leaf[j]!, c[j]!);
        }
      }
      this.edgeProcParity(ne, le, c[4]);
    }
  }

  private faceProcParity(node: (Node | null)[], leaf: boolean[], dir: number): void {
    if (!(node[0] && node[1])) return;
    if (leaf[0] && leaf[1]) return;
    for (let i = 0; i < 4; i++) {
      const c = faceProcFaceMask[dir]![i]!;
      const nf: (Node | null)[] = [];
      const lf: boolean[] = [];
      for (let j = 0; j < 2; j++) {
        if (leaf[j]) {
          lf[j] = leaf[j]!;
          nf[j] = node[j]!;
        } else {
          lf[j] = childIsLeafOf(node[j]!, c[j]!);
          nf[j] = childOrNull(node[j]!, leaf[j]!, c[j]!);
        }
      }
      this.faceProcParity(nf, lf, c[2]);
    }
    const orders = [[0, 0, 1, 1], [0, 1, 0, 1]];
    for (let i = 0; i < 4; i++) {
      const m = faceProcEdgeMask[dir]![i]!;
      const c = [m[1], m[2], m[3], m[4]];
      const order = orders[m[0]]!;
      const ne: (Node | null)[] = [];
      const le: boolean[] = [];
      for (let j = 0; j < 4; j++) {
        const o = order[j]!;
        if (leaf[o]) {
          le[j] = leaf[o]!;
          ne[j] = node[o]!;
        } else {
          le[j] = childIsLeafOf(node[o]!, c[j]!);
          ne[j] = childOrNull(node[o]!, leaf[o]!, c[j]!);
        }
      }
      this.edgeProcParity(ne, le, m[5]);
    }
  }

  private cellProcParity(node: Node | null, leaf: boolean, depth: number): void {
    if (node === null || leaf) return;
    const n = node as Internal;
    const chd = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => childOrNull(n, false, i));
    for (let i = 0; i < 8; i++) this.cellProcParity(chd[i]!, isChildLeaf(n, i), depth - 1);
    for (let i = 0; i < 12; i++) {
      const c = cellProcFaceMask[i]!;
      this.faceProcParity([chd[c[0]]!, chd[c[1]]!], [isChildLeaf(n, c[0]), isChildLeaf(n, c[1])], c[2]);
    }
    for (let i = 0; i < 6; i++) {
      const c = cellProcEdgeMask[i]!;
      this.edgeProcParity(
        [chd[c[0]]!, chd[c[1]]!, chd[c[2]]!, chd[c[3]]!],
        [isChildLeaf(n, c[0]), isChildLeaf(n, c[1]), isChildLeaf(n, c[2]), isChildLeaf(n, c[3])],
        c[4],
      );
    }
  }

  // ── locating ──

  private locateLeaf(st: readonly number[]): Leaf {
    let node: Node = this.root;
    for (let i = GRID_DIMENSION - 1; i > GRID_DIMENSION - this.maxDepth - 1; i--) {
      const index = (((st[0]! >> i) & 1) << 2) | (((st[1]! >> i) & 1) << 1) | ((st[2]! >> i) & 1);
      node = (node as Internal).children[childCount(node as Internal, index)]!;
    }
    return node as Leaf;
  }

  private locateLeafIn(parent: Internal, len: number, st: readonly number[]): Leaf {
    let node: Node = parent;
    for (let i = len >> 1; i >= this.mindimen; i >>= 1) {
      const index = (st[0]! & i ? 4 : 0) | (st[1]! & i ? 2 : 0) | (st[2]! & i ? 1 : 0);
      node = (node as Internal).children[childCount(node as Internal, index)]!;
    }
    return node as Leaf;
  }

  private locateLeafCheck(st: readonly number[]): Leaf | null {
    let node: Node = this.root;
    for (let i = GRID_DIMENSION - 1; i > GRID_DIMENSION - this.maxDepth - 1; i--) {
      const index = (((st[0]! >> i) & 1) << 2) | (((st[1]! >> i) & 1) << 1) | ((st[2]! >> i) & 1);
      if (!hasChild(node as Internal, index)) return null;
      node = (node as Internal).children[childCount(node as Internal, index)]!;
    }
    return node as Leaf;
  }

  // ── edges on leaves ──

  /** `flipEdge(leaf, index, alpha)`: flip, and store an intersection on a new primal crossing. */
  private flipEdgeAlpha(leaf: Leaf, index: number, alpha: number): void {
    leaf.edgeParity ^= 1 << index;
    if ((index & 3) === 0) {
      const ind = index >> 2;
      if (getEdgeParity(leaf, index) && !getStoredEdgesParity(leaf, ind)) {
        leaf.primary |= 1 << ind;
        const count = getEdgeCount(leaf, ind);
        leaf.edges.splice(4 * count, 0, alpha, 0, 0, 0);
      }
    }
  }

  /** `getEdgeIntersectionByIndex(st, index, pt, check)`. */
  private edgeIntersectionAt(st: readonly number[], index: number, check: boolean): number[] | null {
    const leaf = check ? this.locateLeafCheck(st) : this.locateLeaf(st);
    if (leaf && getStoredEdgesParity(leaf, index)) {
      const off = leaf.edges[4 * getEdgeCount(leaf, index)]!;
      const pt = [f(st[0]!), f(st[1]!), f(st[2]!)];
      pt[index] = f(pt[index]! + f(off * this.mindimen));
      return pt;
    }
    return null;
  }

  /** `getEdgeIntersectionByIndex(leaf, index, st, len, pt, nm)`. */
  private leafEdgeIntersection(leaf: Leaf, index: number, st: readonly number[], len: number): { pt: number[]; nm: number[] } {
    const count = getEdgeCount(leaf, index);
    const off = leaf.edges[4 * count]!;
    const pt = [f(st[0]!), f(st[1]!), f(st[2]!)];
    pt[index] = f(pt[index]! + f(off * len));
    return { pt, nm: [leaf.edges[4 * count + 1]!, leaf.edges[4 * count + 2]!, leaf.edges[4 * count + 3]!] };
  }

  // ── trace: find the open rings on the dual surface ──

  private numRings = 0;

  private trace(): void {
    this.numRings = 0;
    const paths: { v: PathList | null } = { v: null };
    this.traceNode(this.root, [0, 0, 0], this.dimen, this.maxDepth, paths);
  }

  private traceNode(node: Internal, st: number[], len: number, depth: number, paths: { v: PathList | null }): void {
    len >>= 1;
    const chdpaths: (PathList | null)[] = [];
    const nst: number[][] = [];
    let { chd, leaf: chdleaf } = fillChildren(node);
    for (let i = 0; i < 8; i++) {
      nst[i] = [0, 1, 2].map((j) => st[j]! + len * vertmap[i]![j]!);
      if (chd[i] === null || isChildLeaf(node, i)) chdpaths[i] = null;
      else {
        const r = { v: null as PathList | null };
        this.traceNode(chd[i] as Internal, nst[i]!, len, depth - 1, r);
        chdpaths[i] = r.v;
      }
    }
    ({ chd, leaf: chdleaf } = fillChildren(node));
    const conn: (PathList | null)[] = [];
    for (let i = 0; i < 12; i++) {
      const c = cellProcFaceMask[i]!;
      const r = { v: null as PathList | null };
      this.findPaths(
        [chd[c[0]]!, chd[c[1]]!],
        [chdleaf[c[0]]!, chdleaf[c[1]]!],
        [depth - 1, depth - 1],
        [nst[c[0]]!, nst[c[1]]!],
        depth - 1,
        c[2],
        r,
      );
      conn[i] = r.v;
    }
    const rings = { v: null as PathList | null };
    const cp = (a: number, b: number | null, k: number): void => {
      const l1 = { v: chdpaths[a]! };
      const l2 = b === null ? null : chdpaths[b]!;
      this.combinePaths(l1, l2, conn[k]!, rings);
      chdpaths[a] = l1.v;
    };
    cp(0, 1, 8);
    cp(2, 3, 9);
    cp(4, 5, 10);
    cp(6, 7, 11);
    cp(0, 2, 4);
    cp(4, 6, 5);
    cp(0, null, 6);
    cp(4, null, 7);
    cp(0, 4, 0);
    cp(0, null, 1);
    cp(0, null, 2);
    cp(0, null, 3);
    if (rings.v) {
      for (let t: PathList | null = rings.v; t; t = t.next) this.numRings++;
      this.patch(node, st, len << 1, rings.v);
    }
    paths.v = chdpaths[0]!;
  }

  private findPaths(
    node: (Node | null)[],
    leaf: boolean[],
    depth: number[],
    st: number[][],
    maxdep: number,
    dir: number,
    paths: { v: PathList | null },
  ): void {
    if (!(node[0] && node[1])) return;
    if (!(leaf[0] && leaf[1])) {
      const chd: (Node | null)[][] = [[], []];
      const chdleaf: boolean[][] = [[], []];
      const nst: number[][][] = [[], []];
      for (let j = 0; j < 2; j++) {
        if (leaf[j]) continue;
        const fc = fillChildren(node[j] as Internal);
        chd[j] = fc.chd;
        chdleaf[j] = fc.leaf;
        const len = this.dimen >> (this.maxDepth - depth[j]! + 1);
        for (let i = 0; i < 8; i++) nst[j]![i] = [0, 1, 2].map((k) => st[j]![k]! + len * vertmap[i]![k]!);
      }
      for (let i = 0; i < 4; i++) {
        const c = faceProcFaceMask[dir]![i]!;
        const nf: (Node | null)[] = [];
        const lf: boolean[] = [];
        const df: number[] = [];
        const nstf: number[][] = [];
        for (let j = 0; j < 2; j++) {
          if (leaf[j]) {
            lf[j] = leaf[j]!;
            nf[j] = node[j]!;
            df[j] = depth[j]!;
            nstf[j] = st[j]!;
          } else {
            lf[j] = chdleaf[j]![c[j]!]!;
            nf[j] = chd[j]![c[j]!]!;
            df[j] = depth[j]! - 1;
            nstf[j] = nst[j]![c[j]!]!;
          }
        }
        this.findPaths(nf, lf, df, nstf, maxdep - 1, c[2], paths);
      }
    } else {
      const ind = depth[0] === maxdep ? 0 : 1;
      const fcind = 2 * dir + (1 - ind);
      if (getFaceEdgeNum(node[ind] as Leaf, fcind) & 1) {
        const ele2: PathElement = { pos: [st[1]![0]!, st[1]![1]!, st[1]![2]!], next: null };
        const ele1: PathElement = { pos: [st[0]![0]!, st[0]![1]!, st[0]![2]!], next: ele2 };
        paths.v = { head: ele1, tail: ele2, length: 2, next: paths.v };
      }
    }
  }

  /**
   * `combinePaths`. `list1` is a reference (the C++ `PathList *&`); every
   * `combineSinglePath` call there passes the connector through **two**
   * references to the same variable, which this unrolls.
   */
  private combinePaths(
    list1: { v: PathList | null },
    list2: PathList | null,
    paths: PathList | null,
    rings: { v: PathList | null },
  ): void {
    let nlist: PathList | null = null;
    let tpaths = paths;
    const l2 = { v: list2 };
    const nl: { v: PathList | null } = { v: nlist };
    while (tpaths) {
      let singlist: PathList = tpaths;
      tpaths = tpaths.next;
      singlist.next = null;
      for (const head of [list1, l2, nl]) {
        let tlist = head.v;
        let pre: PathList | null = null;
        while (tlist) {
          const joined = this.combineSinglePath(tlist, singlist);
          if (joined) {
            // deletePath(head1, pre1, list1): tlist moves on, unlinked.
            const nextT: PathList | null = tlist.next;
            if (pre === null) head.v = nextT;
            else pre.next = nextT;
            tlist = nextT;
            singlist = joined;
            continue;
          }
          pre = tlist;
          tlist = tlist.next;
        }
      }
      if (isEqual(singlist.head!, singlist.tail!)) {
        const temp = singlist.head!;
        singlist.head = temp.next;
        singlist.length--;
        singlist.tail!.next = singlist.head;
        singlist.next = rings.v;
        rings.v = singlist;
      } else {
        singlist.next = nl.v;
        nl.v = singlist;
      }
    }
    nlist = nl.v;
    const list2v = l2.v;
    // Append list2 and nlist to the end of list1.
    let tlist = list1.v;
    if (tlist !== null) {
      while (tlist.next !== null) tlist = tlist.next;
      tlist.next = list2v;
    } else {
      tlist = list2v;
      list1.v = list2v;
    }
    if (tlist !== null) {
      while (tlist.next !== null) tlist = tlist.next;
      tlist.next = nlist;
    } else {
      list1.v = nlist;
    }
  }

  /** `combineSinglePath`, for its one call pattern: a new joined list, or null. */
  private combineSinglePath(list1: PathList, list2: PathList): PathList | null {
    const reverse = (l: PathList): void => {
      let prev = l.head!;
      let next = prev.next;
      prev.next = null;
      while (next !== null) {
        const tnext: PathElement | null = next.next;
        next.next = prev;
        prev = next;
        next = tnext;
      }
      l.tail = l.head;
      l.head = prev;
    };
    if (isEqual(list1.head!, list2.head!) || isEqual(list1.tail!, list2.tail!)) {
      if (list1.length < list2.length) reverse(list1);
      else reverse(list2);
    }
    if (isEqual(list1.head!, list2.tail!)) {
      const temp = list1.head!.next;
      list2.tail!.next = temp;
      return { length: list1.length + list2.length - 1, head: list2.head, tail: list1.tail, next: null };
    }
    if (isEqual(list1.tail!, list2.head!)) {
      const temp = list2.head!.next;
      list1.tail!.next = temp;
      return { length: list1.length + list2.length - 1, head: list1.head, tail: list2.tail, next: null };
    }
    return null;
  }

  // ── patch: fill the rings ──

  private patch(node: Internal, st: number[], len: number, rings: PathList | null): void {
    if (len === this.mindimen) throw new Error("dualcon: a ring reached the finest level");
    const xlists = this.patchSplit(node, st, len, rings, 0);
    const y0 = this.patchSplit(node, st, len, xlists[0], 1);
    const y1 = this.patchSplit(node, st, len, xlists[1], 1);
    const z = [
      ...this.patchSplit(node, st, len, y0[0], 2),
      ...this.patchSplit(node, st, len, y0[1], 2),
      ...this.patchSplit(node, st, len, y1[0], 2),
      ...this.patchSplit(node, st, len, y1[1], 2),
    ];
    len >>= 1;
    let count = 0;
    for (let i = 0; i < 8; i++) {
      if (z[i] !== null) {
        const nori = [0, 1, 2].map((k) => st[k]! + len * vertmap[i]![k]!);
        this.patch(node.children[count] as Internal, nori, len, z[i]!);
      }
      if (hasChild(node, i)) count++;
    }
  }

  private patchSplit(node: Internal, st: number[], len: number, rings: PathList | null, dir: number): [PathList | null, PathList | null] {
    const n1 = { v: null as PathList | null };
    const n2 = { v: null as PathList | null };
    for (let r = rings; r !== null; r = r.next) this.patchSplitSingle(node, st, len, r.head, dir, n1, n2);
    return [n1.v, n2.v];
  }

  private patchSplitSingle(
    node: Internal,
    st: number[],
    len: number,
    head: PathElement | null,
    dir: number,
    n1: { v: PathList | null },
    n2: { v: PathList | null },
  ): void {
    if (head === null) return;
    const pair = this.findPair(head, st[dir]! + (len >> 1), dir);
    if (pair.side !== 0) {
      const nring: PathList = { head, tail: null, length: 0, next: null };
      if (pair.side === -1) {
        nring.next = n1.v;
        n1.v = nring;
      } else {
        nring.next = n2.v;
        n2.v = nring;
      }
      return;
    }
    let pre1: PathElement | null = pair.pre1!;
    let pre2: PathElement | null = pair.pre2!;
    const nxt1 = pre1.next;
    const nxt2 = pre2.next;
    pre1.next = nxt2;
    pre2.next = nxt1;
    this.connectFace(node, st, len, dir, pre1, pre2);
    if (isEqual(pre1, pre1.next!)) {
      if (pre1 === pre1.next) pre1 = null;
      else pre1.next = pre1.next!.next;
    }
    if (isEqual(pre2, pre2.next!)) {
      if (pre2 === pre2.next) pre2 = null;
      else pre2.next = pre2.next!.next;
    }
    pre1 = this.compressRing(pre1);
    pre2 = this.compressRing(pre2);
    this.patchSplitSingle(node, st, len, pre1, dir, n1, n2);
    this.patchSplitSingle(node, st, len, pre2, dir, n1, n2);
  }

  private findPair(head: PathElement, pos: number, dir: number): { side: number; pre1?: PathElement; pre2?: PathElement } {
    const getSide = (e: PathElement): number => (e.pos[dir]! < pos ? -1 : 1);
    let side = getSide(head);
    let cur: PathElement = head;
    const anchor = cur;
    let ppre1 = cur;
    cur = cur.next!;
    while (cur !== anchor && getSide(cur) === side) {
      ppre1 = cur;
      cur = cur.next!;
    }
    if (cur === anchor) return { side };
    side = getSide(cur);
    let ppre2 = cur;
    cur = cur.next!;
    while (getSide(cur) === side) {
      ppre2 = cur;
      cur = cur.next!;
    }
    if (side === -1) [ppre1, ppre2] = [ppre2, ppre1];
    return { side: 0, pre1: ppre1, pre2: ppre2 };
  }

  private compressRing(ring: PathElement | null): PathElement | null {
    if (ring === null) return null;
    let cur = ring.next!.next!;
    let pre = ring.next!;
    let prepre = ring;
    let anchor: PathElement | null = prepre;
    do {
      while (isEqual(cur, prepre)) {
        if (cur === prepre) {
          anchor = null;
          break;
        }
        prepre.next = cur.next;
        pre = prepre.next!;
        cur = pre.next!;
        anchor = prepre;
      }
      if (anchor === null) break;
      prepre = pre;
      pre = cur;
      cur = cur.next!;
    } while (prepre !== anchor);
    return anchor;
  }

  private getFacePoint(leaf: PathElement, dir: number): { x: number; y: number; p: number; q: number } {
    const avg = [0, 0, 0];
    let num = 0;
    for (let i = 0; i < 4; i++) {
      const edgeind = faceMap[dir * 2]![i]!;
      const nst = [0, 1, 2].map((j) => leaf.pos[j]! + this.mindimen * vertmap[edgemap[edgeind]![0]]![j]!);
      const off = this.edgeIntersectionAt(nst, edgeind >> 2, true);
      if (off) {
        for (let k = 0; k < 3; k++) avg[k] = f(avg[k]! + off[k]!);
        num++;
      }
    }
    if (num === 0) {
      for (let k = 0; k < 3; k++) avg[k] = f(leaf.pos[k]!);
    } else for (let k = 0; k < 3; k++) avg[k] = f(avg[k]! / num);
    const xdir = (dir + 1) % 3;
    const ydir = (dir + 2) % 3;
    return {
      x: leaf.pos[xdir]! >> this.minshift,
      y: leaf.pos[ydir]! >> this.minshift,
      p: f(f(avg[xdir]! - leaf.pos[xdir]!) / this.mindimen),
      q: f(f(avg[ydir]! - leaf.pos[ydir]!) / this.mindimen),
    };
  }

  /** `connectFace`: walk the face between the two halves of a ring, adding crossings. */
  private connectFace(node: Internal, st: number[], len: number, dir: number, f1: PathElement, f2: PathElement): void {
    const pos = st[dir]! + (len >> 1);
    const xdir = (dir + 1) % 3;
    const ydir = (dir + 2) % 3;
    const a = this.getFacePoint(f2.next!, dir);
    const b = this.getFacePoint(f2, dir);
    const [x1, y1, p1, q1] = [a.x, a.y, a.p, a.q];
    const [x2, y2, p2, q2] = [b.x, b.y, b.p, b.q];
    const dx = f(f(f(x2 + p2) - x1) - p1);
    const dy = f(f(f(y2 + q2) - y1) - q1);
    let rx = p1;
    let ry = q1;
    let incx = 1;
    let incy = 1;
    let lx = x1;
    let ly = y1;
    let hx = x2;
    let hy = y2;
    if (x2 < x1) {
      incx = -1;
      rx = f(1 - rx);
      lx = x2;
      hx = x1;
    }
    if (y2 < y1) {
      incy = -1;
      ry = f(1 - ry);
      ly = y2;
      hy = y1;
    }
    const sx = f(dx * incx);
    const sy = f(dy * incy);
    const ori = [0, 0, 0];
    ori[dir] = Math.trunc(pos / this.mindimen);
    ori[xdir] = x1;
    ori[ydir] = y1;
    let curEleN: PathElement = f1;
    let curEleP: PathElement = f2.next!;
    while (ori[xdir] !== x2 || ori[ydir] !== y2) {
      let next: number;
      let choice: number;
      if (f(sy * f(1 - rx)) > f(sx * f(1 - ry))) {
        choice = 1;
        next = ori[ydir]! + incy;
        if (next < ly || next > hy) {
          choice = 4;
          next = ori[xdir]! + incx;
        }
      } else {
        choice = 2;
        next = ori[xdir]! + incx;
        if (next < lx || next > hx) {
          choice = 3;
          next = ori[ydir]! + incy;
        }
      }
      let walkdir: number;
      let inc: number;
      let alpha: number;
      if (choice & 1) {
        ori[ydir] = next;
        if (choice === 1) {
          rx = f(rx + (sy === 0 ? 0 : f(f(f(1 - ry) * sx) / sy)));
          ry = 0;
        }
        walkdir = 2;
        inc = incy;
        alpha = x2 < x1 ? f(1 - rx) : rx;
      } else {
        ori[xdir] = next;
        if (choice === 2) {
          ry = f(ry + (sx === 0 ? 0 : f(f(f(1 - rx) * sy) / sx)));
          rx = 0;
        }
        walkdir = 1;
        inc = incx;
        alpha = y2 < y1 ? f(1 - ry) : ry;
      }
      const nori = ori.map((o) => o * this.mindimen);
      const N = this.locateCell(node, st, len, nori, dir, 1);
      const Pc = this.locateCell(node, st, len, nori, dir, 0);

      if (curEleN.pos[0] !== N.st[0] || curEleN.pos[1] !== N.st[1] || curEleN.pos[2] !== N.st[2]) {
        let newEleN: PathElement;
        const nx = curEleN.next!;
        if (nx.pos[0] !== N.st[0] || nx.pos[1] !== N.st[1] || nx.pos[2] !== N.st[2]) {
          newEleN = { pos: [N.st[0]!, N.st[1]!, N.st[2]!], next: nx };
          curEleN.next = newEleN;
        } else newEleN = nx;
        this.patchAdjacent(node, len, curEleN.pos, newEleN.pos, N.leaf, walkdir, inc, dir, 1, alpha);
        curEleN = newEleN;
      }
      if (curEleP.pos[0] !== Pc.st[0] || curEleP.pos[1] !== Pc.st[1] || curEleP.pos[2] !== Pc.st[2]) {
        let newEleP: PathElement;
        if (f2.pos[0] !== Pc.st[0] || f2.pos[1] !== Pc.st[1] || f2.pos[2] !== Pc.st[2]) {
          newEleP = { pos: [Pc.st[0]!, Pc.st[1]!, Pc.st[2]!], next: curEleP };
          f2.next = newEleP;
        } else newEleP = f2;
        this.patchAdjacent(node, len, curEleP.pos, newEleP.pos, Pc.leaf, walkdir, inc, dir, 0, alpha);
        curEleP = newEleP;
      }
    }
  }

  /**
   * `patchAdjacent`: flip the crossed edge on both cells. The first cell is
   * found again from its position — the C++ threads the pointer through, and
   * in place the two agree.
   */
  private patchAdjacent(
    node: Internal,
    len: number,
    st1: readonly number[],
    st2: readonly number[],
    leaf2: Leaf,
    walkdir: number,
    inc: number,
    dir: number,
    side: number,
    alpha: number,
  ): void {
    const edgedir = (dir + (3 - walkdir)) % 3;
    const incdir = (dir + walkdir) % 3;
    const ind1 = edgedir === 1 ? ((dir + 3 - edgedir) % 3) - 1 : 2 - ((dir + 3 - edgedir) % 3);
    const ind2 = edgedir === 1 ? ((incdir + 3 - edgedir) % 3) - 1 : 2 - ((incdir + 3 - edgedir) % 3);
    const eind1 = (edgedir << 2) | (side << ind1) | ((inc > 0 ? 1 : 0) << ind2);
    const eind2 = (edgedir << 2) | (side << ind1) | ((inc > 0 ? 0 : 1) << ind2);
    const leaf1 = this.locateLeafIn(node, len, st1);
    this.flipEdgeAlpha(leaf1, eind1, alpha);
    void st2;
    this.flipEdgeAlpha(leaf2, eind2, alpha);
  }

  /** `locateCell`: the cell on one side of the face at `ori`, created if missing. */
  private locateCell(node: Internal, st: readonly number[], len: number, ori: readonly number[], dir: number, side: number): { leaf: Leaf; st: number[] } {
    len >>= 1;
    let ind = 0;
    for (let i = 0; i < 3; i++) {
      ind <<= 1;
      if (i === dir && side === 1) ind |= ori[i]! <= st[i]! + len ? 0 : 1;
      else ind |= ori[i]! < st[i]! + len ? 0 : 1;
    }
    const rst = [0, 1, 2].map((k) => st[k]! + vertmap[ind]![k]! * len);
    if (hasChild(node, ind)) {
      const chd = node.children[childCount(node, ind)]!;
      if (isChildLeaf(node, ind)) return { leaf: chd as Leaf, st: rst };
      return this.locateCell(chd as Internal, rst, len, ori, dir, side);
    }
    if (len === this.mindimen) {
      const chd = createLeaf();
      this.addChild(node, ind, chd, true);
      return { leaf: chd, st: rst };
    }
    const chd = createInternal();
    const r = this.locateCell(chd, rst, len, ori, dir, side);
    this.addChild(node, ind, chd, false);
    return r;
  }

  // ── signs ──

  private buildSigns(): void {
    const table = new Uint8Array(1 << 12);
    for (let i = 0; i < 256; i++) {
      let ind = 0;
      for (let j = 11; j >= 0; j--) {
        ind <<= 1;
        if (((i >> edgemap[j]![0]) & 1) ^ ((i >> edgemap[j]![1]) & 1)) ind |= 1;
      }
      table[ind] = i;
    }
    this.buildSignsNode(table, this.root, false, 1);
  }

  private buildSignsNode(table: Uint8Array, node: Node | null, isLeaf: boolean, sg: number): number[] {
    if (node === null) return [sg, sg, sg, sg, sg, sg, sg, sg];
    if (!isLeaf) {
      const { chd, leaf } = fillChildren(node as Internal);
      const rvalue = [sg];
      const oris = this.buildSignsNode(table, chd[0]!, leaf[0]!, sg);
      for (let i = 1; i < 8; i++) rvalue[i] = this.buildSignsNode(table, chd[i]!, leaf[i]!, oris[i]!)[i]!;
      return rvalue;
    }
    const l = node as Leaf;
    l.signs = table[l.edgeParity]!;
    if ((sg ^ l.signs) & 1) l.signs = ~l.signs & 0xff;
    return [0, 1, 2, 3, 4, 5, 6, 7].map((i) => getSign(l, i));
  }

  // ── flood fill: remove small components ──

  private floodFill(): void {
    this.clearProcessBits(this.root, this.maxDepth);
    let threshold = this.floodFillNode(this.root, [0, 0, 0], this.dimen, this.maxDepth, 0);
    // `threshold *= thresh` — int *= float: float product, truncated.
    threshold = Math.trunc(f(threshold * this.thresh));
    this.clearProcessBits(this.root, this.maxDepth);
    this.floodFillNode(this.root, [0, 0, 0], this.dimen, this.maxDepth, threshold);
  }

  private clearProcessBits(node: Node, height: number): void {
    if (height === 0) {
      (node as Leaf).floodFill &= ~0xfff;
      return;
    }
    for (const c of (node as Internal).children) this.clearProcessBits(c, height - 1);
  }

  private setInProcessAll(st: readonly number[], dir: number): void {
    for (let i = 0; i < 4; i++) {
      const nst = [0, 1, 2].map((k) => st[k]! + dirCell[dir]![i]![k]! * this.mindimen);
      const cell = this.locateLeafCheck(nst)!;
      cell.floodFill |= 1 << dirEdge[dir]![i]!;
    }
  }

  private flipParityAll(st: readonly number[], dir: number): void {
    for (let i = 0; i < 4; i++) {
      const nst = [0, 1, 2].map((k) => st[k]! + dirCell[dir]![i]![k]! * this.mindimen);
      this.locateLeaf(nst).edgeParity ^= 1 << dirEdge[dir]![i]!;
    }
  }

  /** The measuring pass of `floodFill(leaf, …)`: component size, marking edges in process. */
  private floodFillMeasure(mst: number[], mdir: number, len: number): number {
    // `mst` was already marked and would be pushed first.
    const queue: [number[], number][] = [[mst, mdir]];
    let total = 1;
    this.walkComponent(queue, len, (l, e) => getEdgeParity(l, e) === 1, (cs, e, est, edir) => {
      if (((cs.floodFill >> e) & 1) === 0) {
        this.setInProcessAll(est, edir);
        queue.push([est, edir]);
        total++;
      }
    });
    return total;
  }

  /** The removing pass: flip the parity of every edge of the component. */
  private floodFillRemove(mst: number[], mdir: number, len: number): void {
    this.flipParityAll(mst, mdir);
    const queue: [number[], number][] = [[mst, mdir]];
    this.walkComponent(queue, len, (l, e) => ((l.floodFill >> e) & 1) === 1, (cs, e, est, edir) => {
      if (getEdgeParity(cs, e) === 1) {
        this.flipParityAll(est, edir);
        queue.push([est, edir]);
      }
    });
  }

  private walkComponent(
    queue: [number[], number][],
    len: number,
    test: (l: Leaf, e: number) => boolean,
    visit: (cell: Leaf, edge: number, est: number[], edir: number) => void,
  ): void {
    const fcCells = [1, 0, 1, 0];
    const fcEdges = [
      [[9, 2, 11], [8, 1, 10], [5, 1, 7], [4, 2, 6]],
      [[10, 6, 11], [8, 5, 9], [1, 5, 3], [0, 6, 2]],
      [[6, 10, 7], [4, 9, 5], [2, 9, 3], [0, 10, 1]],
    ];
    while (queue.length > 0) {
      const [nst, dir] = queue.shift()!;
      const stMask = [[0, -len, -len], [-len, 0, -len], [-len, -len, 0]];
      const cst = [nst, [0, 1, 2].map((j) => nst[j]! + stMask[dir]![j]!)];
      const cs = cst.map((c) => this.locateLeaf(c));
      const s = getSign(cs[0]!, 0);
      for (let find = 0; find < 4; find++) {
        const cind = fcCells[find]!;
        let eind: number;
        let edge = 0;
        if (s === 0) {
          for (eind = 0; eind < 3; eind++) {
            edge = fcEdges[dir]![find]![eind]!;
            if (test(cs[cind]!, edge)) break;
          }
        } else {
          for (eind = 2; eind >= 0; eind--) {
            edge = fcEdges[dir]![find]![eind]!;
            if (test(cs[cind]!, edge)) break;
          }
        }
        if (eind === 3 || eind === -1) continue;
        const est = [0, 1, 2].map((k) => cst[cind]![k]! + vertmap[edgemap[edge]![0]]![k]! * len);
        visit(cs[cind]!, edge, est, edge >> 2);
      }
    }
  }

  private floodFillNode(node: Node, st: number[], len: number, height: number, threshold: number): number {
    if (height === 0) return this.floodFillLeafEntry(node as Leaf, st, len, threshold);
    let maxtotal = 0;
    len >>= 1;
    let count = 0;
    const n = node as Internal;
    for (let i = 0; i < 8; i++) {
      if (!hasChild(n, i)) continue;
      const nst = [0, 1, 2].map((k) => st[k]! + vertmap[i]![k]! * len);
      maxtotal = Math.max(this.floodFillNode(n.children[count]!, nst, len, height - 1, threshold), maxtotal);
      count++;
    }
    return maxtotal;
  }

  /** `floodFill(LeafNode *…)`: each unvisited crossing edge seeds one component. */
  private floodFillLeafEntry(leaf: Leaf, st: readonly number[], len: number, threshold: number): number {
    let maxtotal = 0;
    for (let i = 0; i < 12; i++) {
      if (!(getEdgeParity(leaf, i) === 1 && ((leaf.floodFill >> i) & 1) === 0)) continue;
      const mst = [0, 1, 2].map((k) => st[k]! + vertmap[edgemap[i]![0]]![k]! * len);
      const mdir = i >> 2;
      this.setInProcessAll(mst, mdir);
      const total = this.floodFillMeasure(mst, mdir, len);
      if (threshold === 0) {
        maxtotal = Math.max(total, maxtotal);
        continue;
      }
      if (total >= threshold) continue;
      this.floodFillRemove(mst, mdir, len);
    }
    return maxtotal;
  }

  // ── output ──

  private writeOut(): void {
    this.out = { positions: [], quads: [] };
    const offset = { v: 0 };
    this.generateMinimizer(this.root, [0, 0, 0], this.dimen, this.maxDepth, offset);
    this.cellProcContour(this.root, false, this.maxDepth);
  }

  /** `fillEdgeIntersections` (the stored-parity form). */
  private fillEdgeIntersections(leaf: Leaf, st: readonly number[], len: number): { pts: number[][]; norms: number[][]; parity: number[] } {
    const pts: number[][] = [];
    const norms: number[][] = [];
    const parity = new Array<number>(12).fill(0);
    const pmask = [0, 4, 8];
    for (let i = 0; i < 3; i++)
      if (getStoredEdgesParity(leaf, i)) {
        const r = this.leafEdgeIntersection(leaf, i, st, len);
        pts[pmask[i]!] = r.pt;
        norms[pmask[i]!] = r.nm;
        parity[pmask[i]!] = 1;
      }
    const fmask = [[6, 10], [2, 9], [1, 5]];
    const femask = [[1, 2], [0, 2], [0, 1]];
    for (let i = 0; i < 3; i++) {
      const nst = [st[0]!, st[1]!, st[2]!];
      nst[i]! += len;
      const node = this.locateLeafCheck(nst);
      if (node === null) continue;
      for (let k = 0; k < 2; k++)
        if (getStoredEdgesParity(node, femask[i]![k]!)) {
          const r = this.leafEdgeIntersection(node, femask[i]![k]!, nst, len);
          pts[fmask[i]![k]!] = r.pt;
          norms[fmask[i]![k]!] = r.nm;
          parity[fmask[i]![k]!] = 1;
        }
    }
    const emask = [3, 7, 11];
    for (let i = 0; i < 3; i++) {
      const nst = [st[0]! + len, st[1]! + len, st[2]! + len];
      nst[i]! -= len;
      const node = this.locateLeafCheck(nst);
      if (node === null) continue;
      if (getStoredEdgesParity(node, i)) {
        const r = this.leafEdgeIntersection(node, i, nst, len);
        pts[emask[i]!] = r.pt;
        norms[emask[i]!] = r.nm;
        parity[emask[i]!] = 1;
      }
    }
    return { pts, norms, parity };
  }

  private computeMinimizer(leaf: Leaf, st: readonly number[], len: number, rvalue: number[]): void {
    const { pts, norms, parity } = this.fillEdgeIntersections(leaf, st, len);
    const half = len >> 1;
    if (this.mode === "centroid") {
      for (let k = 0; k < 3; k++) rvalue[k] = f(st[k]! + half);
      return;
    }
    if (this.mode === "masspoint") {
      rvalue[0] = rvalue[1] = rvalue[2] = 0;
      massPoint(rvalue, pts, parity);
      return;
    }
    const mp = [0, 0, 0];
    minimize(rvalue, mp, pts, norms, parity);
    const nh1 = f(this.hermiteNum * len);
    const nh2 = f(f(1 + this.hermiteNum) * len);
    if (
      rvalue[0]! < f(st[0]! - nh1) || rvalue[1]! < f(st[1]! - nh1) || rvalue[2]! < f(st[2]! - nh1) ||
      rvalue[0]! > f(st[0]! + nh2) || rvalue[1]! > f(st[1]! + nh2) || rvalue[2]! > f(st[2]! + nh2)
    ) {
      rvalue[0] = mp[0]!;
      rvalue[1] = mp[1]!;
      rvalue[2] = mp[2]!;
    }
  }

  private generateMinimizer(node: Node, st: number[], len: number, height: number, offset: { v: number }): void {
    if (height === 0) {
      const leaf = node as Leaf;
      const half = len >> 1;
      const rvalue = [f(st[0]! + half), f(st[1]! + half), f(st[2]! + half)];
      this.computeMinimizer(leaf, st, len, rvalue);
      for (let j = 0; j < 3; j++) rvalue[j] = f(f(f(rvalue[j]! * this.range) / this.dimen) + this.origin[j]!);
      const smask = leaf.signs;
      const mult = smask > 0 && smask < 255 ? 1 : 0;
      for (let j = 0; j < mult; j++) this.out.positions.push(rvalue[0]!, rvalue[1]!, rvalue[2]!);
      leaf.minimizerIndex = offset.v;
      offset.v += mult;
      return;
    }
    const n = node as Internal;
    len >>= 1;
    let count = 0;
    for (let i = 0; i < 8; i++) {
      if (!hasChild(n, i)) continue;
      const nst = [0, 1, 2].map((k) => st[k]! + vertmap[i]![k]! * len);
      this.generateMinimizer(n.children[count]!, nst, len, height - 1, offset);
      count++;
    }
  }

  private processEdgeWrite(node: Leaf[], dir: number): void {
    const edgeind = processEdgeMask[dir]![3]!;
    if (!getEdgeParity(node[3]!, edgeind)) return;
    const flip = getSign(node[3]!, edgemap[edgeind]![1]) > 0;
    const m = node.map((l) => l.minimizerIndex);
    this.out.quads.push(flip ? [m[2]!, m[3]!, m[1]!, m[0]!] : [m[0]!, m[1]!, m[3]!, m[2]!]);
  }

  private edgeProcContour(node: (Node | null)[], leaf: boolean[], dir: number): void {
    if (!(node[0] && node[1] && node[2] && node[3])) return;
    if (leaf[0] && leaf[1] && leaf[2] && leaf[3]) {
      this.processEdgeWrite(node as Leaf[], dir);
      return;
    }
    for (let i = 0; i < 2; i++) {
      const c = edgeProcEdgeMask[dir]![i]!;
      const ne: (Node | null)[] = [];
      const le: boolean[] = [];
      for (let j = 0; j < 4; j++) {
        if (leaf[j]) {
          le[j] = leaf[j]!;
          ne[j] = node[j]!;
        } else {
          le[j] = childIsLeafOf(node[j]!, c[j]!);
          ne[j] = childOrNull(node[j]!, leaf[j]!, c[j]!);
        }
      }
      this.edgeProcContour(ne, le, c[4]);
    }
  }

  private faceProcContour(node: (Node | null)[], leaf: boolean[], dir: number): void {
    if (!(node[0] && node[1])) return;
    if (leaf[0] && leaf[1]) return;
    for (let i = 0; i < 4; i++) {
      const c = faceProcFaceMask[dir]![i]!;
      const nf: (Node | null)[] = [];
      const lf: boolean[] = [];
      for (let j = 0; j < 2; j++) {
        if (leaf[j]) {
          lf[j] = leaf[j]!;
          nf[j] = node[j]!;
        } else {
          lf[j] = childIsLeafOf(node[j]!, c[j]!);
          nf[j] = childOrNull(node[j]!, leaf[j]!, c[j]!);
        }
      }
      this.faceProcContour(nf, lf, c[2]);
    }
    const orders = [[0, 0, 1, 1], [0, 1, 0, 1]];
    for (let i = 0; i < 4; i++) {
      const m = faceProcEdgeMask[dir]![i]!;
      const c = [m[1], m[2], m[3], m[4]];
      const order = orders[m[0]]!;
      const ne: (Node | null)[] = [];
      const le: boolean[] = [];
      for (let j = 0; j < 4; j++) {
        const o = order[j]!;
        if (leaf[o]) {
          le[j] = leaf[o]!;
          ne[j] = node[o]!;
        } else {
          le[j] = childIsLeafOf(node[o]!, c[j]!);
          ne[j] = childOrNull(node[o]!, leaf[o]!, c[j]!);
        }
      }
      this.edgeProcContour(ne, le, m[5]);
    }
  }

  private cellProcContour(node: Node | null, leaf: boolean, depth: number): void {
    if (node === null || leaf) return;
    const n = node as Internal;
    const chd = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => childOrNull(n, false, i));
    for (let i = 0; i < 8; i++) this.cellProcContour(chd[i]!, isChildLeaf(n, i), depth - 1);
    for (let i = 0; i < 12; i++) {
      const c = cellProcFaceMask[i]!;
      this.faceProcContour([chd[c[0]]!, chd[c[1]]!], [isChildLeaf(n, c[0]), isChildLeaf(n, c[1])], c[2]);
    }
    for (let i = 0; i < 6; i++) {
      const c = cellProcEdgeMask[i]!;
      this.edgeProcContour(
        [chd[c[0]]!, chd[c[1]]!, chd[c[2]]!, chd[c[3]]!],
        [isChildLeaf(n, c[0]), isChildLeaf(n, c[1]), isChildLeaf(n, c[2]), isChildLeaf(n, c[3])],
        c[4],
      );
    }
  }
}

/** `mass_point`: the average of the crossings, in float. */
function massPoint(mp: number[], pts: number[][], parity: number[]): void {
  let ec = 0;
  for (let i = 0; i < 12; i++)
    if (parity[i]) {
      for (let k = 0; k < 3; k++) mp[k] = f(mp[k]! + pts[i]![k]!);
      ec++;
    }
  if (ec === 0) return;
  for (let k = 0; k < 3; k++) mp[k] = f(mp[k]! / ec);
}

/** `minimize`: the QEF and its least-squares solution (Sharp mode). */
function minimize(rvalue: number[], mp: number[], pts: number[][], norms: number[][], parity: number[]): void {
  const ata = [0, 0, 0, 0, 0, 0];
  const atb = [0, 0, 0];
  let ec = 0;
  for (let i = 0; i < 12; i++) {
    if (!parity[i]) continue;
    const n = norms[i]!;
    const p = pts[i]!;
    ata[0] = f(ata[0]! + f(n[0]! * n[0]!));
    ata[1] = f(ata[1]! + f(n[0]! * n[1]!));
    ata[2] = f(ata[2]! + f(n[0]! * n[2]!));
    ata[3] = f(ata[3]! + f(n[1]! * n[1]!));
    ata[4] = f(ata[4]! + f(n[1]! * n[2]!));
    ata[5] = f(ata[5]! + f(n[2]! * n[2]!));
    const pn = f(f(f(p[0]! * n[0]!) + f(p[1]! * n[1]!)) + f(p[2]! * n[2]!));
    atb[0] = f(atb[0]! + f(n[0]! * pn));
    atb[1] = f(atb[1]! + f(n[1]! * pn));
    atb[2] = f(atb[2]! + f(n[2]! * pn));
    for (let k = 0; k < 3; k++) mp[k] = f(mp[k]! + p[k]!);
    ec++;
  }
  if (ec === 0) return;
  for (let k = 0; k < 3; k++) mp[k] = f(mp[k]! / ec);
  solveLeastSquares(ata, atb, mp, rvalue);
}

/**
 * `solve_least_squares`: pseudo-inverse of the symmetric 3×3 through a
 * singular value decomposition, singular values under 0.1 dropped. Blender
 * uses Eigen's `JacobiSVD` in float; this is the same two-sided Jacobi
 * (`svd.ts`), but not bit-for-bit Eigen — Sharp is compared with a tolerance.
 */
function solveLeastSquares(halfA: number[], b: number[], midpoint: number[], rvalue: number[]): void {
  const A = [
    [halfA[0]!, halfA[1]!, halfA[2]!],
    [halfA[1]!, halfA[3]!, halfA[4]!],
    [halfA[2]!, halfA[4]!, halfA[5]!],
  ];
  const pinv = pseudoInverse(A, 0.1);
  const b2 = [0, 1, 2].map((i) => f(b[i]! + f(f(f(A[i]![0]! * -midpoint[0]!) + f(A[i]![1]! * -midpoint[1]!)) + f(A[i]![2]! * -midpoint[2]!))));
  for (let i = 0; i < 3; i++)
    rvalue[i] = f(f(f(f(pinv[i]![0]! * b2[0]!) + f(pinv[i]![1]! * b2[1]!)) + f(pinv[i]![2]! * b2[2]!)) + midpoint[i]!);
}

/** Pseudo-inverse by two-sided Jacobi SVD, in float. */
function pseudoInverse(a: number[][], tolerance: number): number[][] {
  const { U, S, V } = jacobiSvd3(a);
  const inv = S.map((s) => (Math.abs(s) > tolerance ? f(1 / s) : 0));
  const r: number[][] = [];
  for (let i = 0; i < 3; i++) {
    r[i] = [];
    for (let j = 0; j < 3; j++) {
      let acc = 0;
      for (let k = 0; k < 3; k++) acc = f(acc + f(f(V[i]![k]! * inv[k]!) * U[j]![k]!));
      r[i]![j] = acc;
    }
  }
  return r;
}

/**
 * Eigen's `JacobiSVD` for a real 3×3 (no preconditioner is used for square
 * matrices): sweep the off-diagonal pairs with 2×2 SVDs until they vanish,
 * then make the singular values positive and sort them descending.
 */
function jacobiSvd3(m: number[][]): { U: number[][]; S: number[]; V: number[][] } {
  const n = 3;
  let scale = 0;
  for (const row of m) for (const x of row) scale = Math.max(scale, Math.abs(x));
  if (scale === 0) scale = 1;
  const w = m.map((row) => row.map((x) => f(x / scale)));
  const U = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const considerAsZero = 1.1754943508222875e-38; // FLT_MIN
  const precision = f(2 * 1.1920928955078125e-7); // 2 * epsilon
  let maxDiag = Math.max(Math.abs(w[0]![0]!), Math.abs(w[1]![1]!), Math.abs(w[2]![2]!));
  let finished = false;
  for (let sweep = 0; !finished && sweep < 100; sweep++) {
    finished = true;
    for (let p = 1; p < n; p++)
      for (let q = 0; q < p; q++) {
        const threshold = Math.max(considerAsZero, f(precision * maxDiag));
        if (Math.abs(w[p]![q]!) > threshold || Math.abs(w[q]![p]!) > threshold) {
          finished = false;
          const { left, right } = real2x2Jacobi(w, p, q);
          applyLeft(w, p, q, left);
          applyRightT(U, p, q, left);
          applyRight(w, p, q, right);
          applyRight(V, p, q, right);
          maxDiag = Math.max(maxDiag, Math.abs(w[p]![p]!), Math.abs(w[q]![q]!));
        }
      }
  }
  const S = [0, 1, 2].map((i) => {
    const a = w[i]![i]!;
    if (a < 0) for (let r = 0; r < 3; r++) U[r]![i] = f(-U[r]![i]!);
    return f(Math.abs(a) * scale);
  });
  // Sort descending, swapping columns of U and V along.
  for (let i = 0; i < n; i++) {
    let best = i;
    for (let j = i + 1; j < n; j++) if (S[j]! > S[best]!) best = j;
    if (best !== i) {
      [S[i], S[best]] = [S[best]!, S[i]!];
      for (let r = 0; r < 3; r++) {
        [U[r]![i], U[r]![best]] = [U[r]![best]!, U[r]![i]!];
        [V[r]![i], V[r]![best]] = [V[r]![best]!, V[r]![i]!];
      }
    }
  }
  return { U, S, V };
}

type Rot = { c: number; s: number };

/** Eigen's `real_2x2_jacobi_svd`. */
function real2x2Jacobi(m: number[][], p: number, q: number): { left: Rot; right: Rot } {
  const m00 = m[p]![p]!;
  const m01 = m[p]![q]!;
  const m10 = m[q]![p]!;
  const m11 = m[q]![q]!;
  // First make the 2×2 symmetric with a rotation.
  let rot1: Rot;
  const t = f(m00 + m11);
  const d = f(m10 - m01);
  if (Math.abs(d) < 1.1754943508222875e-38) rot1 = { c: 1, s: 0 };
  else {
    const u = f(t / d);
    const tmp = f(Math.sqrt(f(1 + f(u * u))));
    rot1 = { s: f(1 / tmp), c: f(u / tmp) };
  }
  // rot1 applied on the left of the 2×2.
  const a00 = f(f(rot1.c * m00) + f(rot1.s * m10));
  const a01 = f(f(rot1.c * m01) + f(rot1.s * m11));
  const a11 = f(f(-rot1.s * m01) + f(rot1.c * m11));
  const right = makeJacobi(a00, a01, a11);
  // left = rot1 * right.transpose()
  const left: Rot = {
    c: f(f(rot1.c * right.c) + f(rot1.s * right.s)),
    s: f(f(rot1.s * right.c) - f(rot1.c * right.s)),
  };
  return { left, right };
}

/** Eigen's `JacobiRotation::makeJacobi(x, y, z)` for a symmetric [[x, y], [y, z]]. */
function makeJacobi(x: number, y: number, z: number): Rot {
  const deno = f(2 * Math.abs(y));
  if (deno < 1.1754943508222875e-38) return { c: 1, s: 0 };
  const tau = f(f(x - z) / deno);
  const w = f(Math.sqrt(f(f(tau * tau) + 1)));
  const t = tau > 0 ? f(1 / f(tau + w)) : f(1 / f(tau - w));
  const sign = t > 0 ? 1 : -1;
  const n = f(1 / f(Math.sqrt(f(f(t * t) + 1))));
  return { s: f(-sign * f(f(y / Math.abs(y)) * f(Math.abs(t) * n))), c: n };
}

/** Rows p, q of `m` ← J applied on the left (Eigen `applyOnTheLeft(p, q, j)`). */
function applyLeft(m: number[][], p: number, q: number, j: Rot): void {
  for (let k = 0; k < 3; k++) {
    const x = m[p]![k]!;
    const y = m[q]![k]!;
    m[p]![k] = f(f(j.c * x) + f(j.s * y));
    m[q]![k] = f(f(-j.s * x) + f(j.c * y));
  }
}

/** Columns p, q of `m` ← J applied on the right (`applyOnTheRight(p, q, j)`). */
function applyRight(m: number[][], p: number, q: number, j: Rot): void {
  for (let k = 0; k < 3; k++) {
    const x = m[k]![p]!;
    const y = m[k]![q]!;
    m[k]![p] = f(f(j.c * x) - f(j.s * y));
    m[k]![q] = f(f(j.s * x) + f(j.c * y));
  }
}

/** `applyOnTheRight(p, q, j.transpose())`. */
function applyRightT(m: number[][], p: number, q: number, j: Rot): void {
  applyRight(m, p, q, { c: j.c, s: -j.s });
}

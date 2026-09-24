/**
 * Blender's `bmesh.ops.triangle_fill` — `bmo_triangle_fill_exec` over
 * `BLI_scanfill` (`blenlib/intern/scanfill.cc`), ported function by
 * function: the whole edge selection is projected onto one plane and filled
 * by a sweep line, holes and all, then wound to agree with the faces already
 * on the boundary.
 *
 * Float32 throughout, `Math.fround` after every operation in C's order
 * (Blender builds without fused multiply-add). Blender's own argument order
 * in `testvertexnearedge` — `dist_squared_to_line_v2(eed.v1, eed.v2, eve)`,
 * the distance from `eed.v1` to the line through `eed.v2` and `eve` — is
 * kept as written.
 *
 * Two places where C leaves an order unspecified take the stable order here:
 * `qsort` of the vertices (only equal positions tie) and of the normals by
 * length (only equal lengths tie).
 */
import { toPolygons as toPolygonsOf, type EditMesh } from "./half-edge";

const f = Math.fround;

const SF_EPSILON = f(0.00003);
const SF_EPSILON_SQ = f(SF_EPSILON * SF_EPSILON);
const SF_VERT_NEW = 0;
const SF_VERT_AVAILABLE = 1;
const SF_EDGE_NEW = 0;
const SF_EDGE_INTERNAL = 2;
const SF_POLY_NEW = 0;
const SF_POLY_VALID = 1;
const SF_POLY_UNSET = 0xffff;

const CALC_POLYS = 1 << 2;
const CALC_HOLES = 1 << 3;
const CALC_LOOSE = 1 << 4;

interface SFVert {
  next: SFVert | null;
  prev: SFVert | null;
  /** The caller's vertex. */
  id: number;
  co: number[];
  xy: [number, number];
  polyNr: number;
  edgeCount: number;
  f: number;
}

interface SFEdge {
  next: SFEdge | null;
  prev: SFEdge | null;
  v1: SFVert;
  v2: SFVert;
  polyNr: number;
  f: number;
}

interface Linked {
  next: Linked | null;
  prev: Linked | null;
}

class List<T extends Linked> {
  first: T | null = null;
  last: T | null = null;

  addtail(x: T): void {
    x.next = null;
    x.prev = this.last;
    if (this.last) this.last.next = x;
    else this.first = x;
    this.last = x;
  }

  remlink(x: T): void {
    if (x.next) x.next.prev = x.prev;
    if (x.prev) x.prev.next = x.next;
    if (this.last === x) this.last = x.prev as T | null;
    if (this.first === x) this.first = x.next as T | null;
  }

  /** `BLI_insertlinkbefore(list, nextlink, newlink)`. */
  insertBefore(nextlink: T | null, x: T): void {
    if (nextlink === null) {
      this.addtail(x);
      return;
    }
    if (this.first === nextlink) this.first = x;
    x.next = nextlink;
    x.prev = nextlink.prev;
    nextlink.prev = x;
    if (x.prev) x.prev.next = x;
  }

  /** `BLI_movelisttolist(this, src)`: append all of `src`, leaving it empty. */
  moveFrom(src: List<T>): void {
    if (src.first === null) return;
    if (this.first === null) {
      this.first = src.first;
      this.last = src.last;
    } else {
      this.last!.next = src.first;
      src.first.prev = this.last;
      this.last = src.last;
    }
    src.first = src.last = null;
  }

  isEmpty(): boolean {
    return this.first === null;
  }

  *[Symbol.iterator](): Generator<T> {
    // `items_mutable`: the next link is read before the body runs.
    for (let x = this.first; x; ) {
      const n = x.next as T | null;
      yield x;
      x = n;
    }
  }
}

interface PolyFill {
  edges: number;
  verts: number;
  minXy: [number, number];
  maxXy: [number, number];
  nr: number;
  f: number;
}

interface ScanFillVertLink {
  vert: SFVert;
  edges: List<SFEdge>;
}

class ScanFill {
  readonly verts = new List<SFVert>();
  readonly edges = new List<SFEdge>();
  readonly faces: [SFVert, SFVert, SFVert][] = [];

  addVert(co: number[], id: number): SFVert {
    const v: SFVert = { next: null, prev: null, id, co: co.map(f), xy: [0, 0], polyNr: SF_POLY_UNSET, edgeCount: 0, f: SF_VERT_NEW };
    this.verts.addtail(v);
    return v;
  }

  addEdge(v1: SFVert, v2: SFVert): SFEdge {
    const e: SFEdge = { next: null, prev: null, v1, v2, polyNr: SF_POLY_UNSET, f: SF_EDGE_NEW };
    this.edges.addtail(e);
    return e;
  }

  // ── BLI_scanfill_calc_ex ──

  calc(flag: number, norProj: number[]): number {
    for (const e of this.edges) {
      e.v1.f = SF_VERT_AVAILABLE;
      e.v2.f = SF_VERT_AVAILABLE;
    }
    let available = false;
    for (const v of this.verts)
      if (v.f === SF_VERT_AVAILABLE) {
        available = true;
        break;
      }
    if (!available) return 0;

    const n = norProj.map(f);
    if (normalizeV3(n) === 0) return 0;
    const mat = axisDominantNegate(n);

    // STEP 1: count polys ("a sort of select connected").
    let poly = 0;
    if (flag & CALC_POLYS) {
      for (const eve of this.verts) {
        eve.xy = projectXY(mat, eve.co);
        if (eve.polyNr !== SF_POLY_UNSET) continue;
        let toggle = 0;
        let ok = true;
        eve.polyNr = poly;
        while (ok) {
          ok = false;
          toggle++;
          for (let eed = toggle & 1 ? this.edges.first : this.edges.last; eed; eed = toggle & 1 ? eed.next : eed.prev) {
            if (eed.v1.polyNr === SF_POLY_UNSET && eed.v2.polyNr === poly) {
              eed.v1.polyNr = poly;
              eed.polyNr = poly;
              ok = true;
            } else if (eed.v2.polyNr === SF_POLY_UNSET && eed.v1.polyNr === poly) {
              eed.v2.polyNr = poly;
              eed.polyNr = poly;
              ok = true;
            } else if (eed.polyNr === SF_POLY_UNSET && eed.v1.polyNr === poly && eed.v2.polyNr === poly) {
              eed.polyNr = poly;
              ok = true;
            }
          }
        }
        poly++;
      }
    }

    // STEP 2: remove loose edges and strings of edges.
    if (flag & CALC_LOOSE) {
      for (const eed of this.edges) {
        if (eed.v1.edgeCount++ > 250 || eed.v2.edgeCount++ > 250) return 0;
      }
      this.testVertexNearEdge();
      let ok = true;
      let toggle = 0;
      while (ok) {
        ok = false;
        toggle++;
        let eed = toggle & 1 ? this.edges.first : this.edges.last;
        while (eed) {
          const eedNext: SFEdge | null = toggle & 1 ? eed.next : eed.prev;
          if (eed.v1.edgeCount === 1) {
            eed.v2.edgeCount--;
            this.verts.remlink(eed.v1);
            this.edges.remlink(eed);
            ok = true;
          } else if (eed.v2.edgeCount === 1) {
            eed.v1.edgeCount--;
            this.verts.remlink(eed.v2);
            this.edges.remlink(eed);
            ok = true;
          }
          eed = eedNext;
        }
      }
      if (this.edges.isEmpty()) return 0;
    } else {
      for (const eed of this.edges) {
        eed.v1.edgeCount++;
        eed.v2.edgeCount++;
      }
    }

    // STEP 3: the PolyFill structs.
    const pflist: PolyFill[] = [];
    for (let a = 0; a < poly; a++)
      pflist.push({ edges: 0, verts: 0, minXy: [f(1e20), f(1e20)], maxXy: [f(-1e20), f(-1e20)], f: SF_POLY_NEW, nr: a });
    for (const eed of this.edges) pflist[eed.polyNr]!.edges++;
    for (const eve of this.verts) {
      const pf = pflist[eve.polyNr]!;
      pf.verts++;
      pf.minXy[0] = pf.minXy[0] < eve.xy[0] ? pf.minXy[0] : eve.xy[0];
      pf.minXy[1] = pf.minXy[1] < eve.xy[1] ? pf.minXy[1] : eve.xy[1];
      pf.maxXy[0] = pf.maxXy[0] > eve.xy[0] ? pf.maxXy[0] : eve.xy[0];
      pf.maxXy[1] = pf.maxXy[1] > eve.xy[1] ? pf.maxXy[1] : eve.xy[1];
      if (eve.edgeCount > 2) pf.f = SF_POLY_VALID;
    }

    // STEP 4: join polys whose bounds touch (holes).
    if (flag & CALC_HOLES && poly > 1) {
      const target = pflist.map((_, i) => i);
      const recurse = (pfTarget: number, pfTest: number): void => {
        const a = pflist[pfTest]!;
        for (let b = pfTarget + 1; b < poly; b++) {
          if (target[b] !== b) continue;
          if (boundisect(a, pflist[b]!)) {
            target[b] = pfTarget;
            recurse(pfTarget, b);
          }
        }
      };
      for (let a = 0; a < poly; a++) if (target[a] === a) recurse(a, a);
      for (let a = 0; a < poly; a++) if (target[a] !== a) this.mergePolys(pflist[target[a]!]!, pflist[a]!);
    }

    // STEP 5: triangles.
    const tempve = new List<SFVert>();
    const temped = new List<SFEdge>();
    tempve.moveFrom(this.verts);
    temped.moveFrom(this.edges);
    let totfaces = 0;
    for (const pf of pflist) {
      if (pf.edges > 1) {
        this.splitList(tempve, temped, pf.nr);
        totfaces += this.scanfill(pf, flag);
      }
    }
    this.verts.moveFrom(tempve);
    this.edges.moveFrom(temped);
    return totfaces;
  }

  private mergePolys(pf1: PolyFill, pf2: PolyFill): void {
    for (const eve of this.verts) if (eve.polyNr === pf2.nr) eve.polyNr = pf1.nr;
    for (const eed of this.edges) if (eed.polyNr === pf2.nr) eed.polyNr = pf1.nr;
    pf1.verts += pf2.verts;
    pf1.edges += pf2.edges;
    pf1.maxXy[0] = Math.max(pf1.maxXy[0], pf2.maxXy[0]);
    pf1.maxXy[1] = Math.max(pf1.maxXy[1], pf2.maxXy[1]);
    pf1.minXy[0] = Math.min(pf1.minXy[0], pf2.minXy[0]);
    pf1.minXy[1] = Math.min(pf1.minXy[1], pf2.minXy[1]);
    pf1.f = pf1.f | pf2.f;
    pf2.verts = pf2.edges = 0;
  }

  private splitList(tempve: List<SFVert>, temped: List<SFEdge>, nr: number): void {
    tempve.moveFrom(this.verts);
    temped.moveFrom(this.edges);
    for (const eve of tempve)
      if (eve.polyNr === nr) {
        tempve.remlink(eve);
        this.verts.addtail(eve);
      }
    for (const eed of temped)
      if (eed.polyNr === nr) {
        temped.remlink(eed);
        this.edges.addtail(eed);
      }
  }

  private testVertexNearEdge(): void {
    for (const eve of this.verts) {
      if (eve.edgeCount !== 1) continue;
      let ed1 = this.edges.first!;
      while (!(ed1.v1 === eve || ed1.v2 === eve)) ed1 = ed1.next!;
      if (ed1.v1 === eve) {
        ed1.v1 = ed1.v2;
        ed1.v2 = eve;
      }
      for (const eed of this.edges) {
        if (eve === eed.v1 || eve === eed.v2 || eve.polyNr !== eed.polyNr) continue;
        if (compareV2(eve.xy, eed.v1.xy, SF_EPSILON)) {
          ed1.v2 = eed.v1;
          eed.v1.edgeCount++;
          eve.edgeCount = 0;
          break;
        }
        if (compareV2(eve.xy, eed.v2.xy, SF_EPSILON)) {
          ed1.v2 = eed.v2;
          eed.v2.edgeCount++;
          eve.edgeCount = 0;
          break;
        }
        if (boundinsideEV(eed, eve)) {
          // Blender's argument order, kept: the distance from eed.v1 to the
          // line through eed.v2 and eve.
          if (distSquaredToLineV2(eed.v1.xy, eed.v2.xy, eve.xy) < SF_EPSILON_SQ) {
            const ne = this.addEdge(eed.v1, eve);
            ne.polyNr = eed.polyNr;
            eed.v1 = eve;
            eve.edgeCount = 3;
            break;
          }
        }
      }
    }
  }

  /** `scanfill(sf_ctx, pf, flag)`. */
  private scanfill(pf: PolyFill, flag: number): number {
    const nr = pf.nr;
    let twoconnected = false;

    // STEP 1: the sorted vertex links.
    const scdata: ScanFillVertLink[] = [];
    for (const eve of this.verts)
      if (eve.polyNr === nr) {
        eve.f = SF_VERT_NEW;
        scdata.push({ vert: eve, edges: new List<SFEdge>() });
      }
    crtQsort(scdata, (a, b) => vergscdata(a.vert, b.vert));
    const verts = scdata.length;
    for (const eed of this.edges) {
      this.edges.remlink(eed);
      if (eed.v1 !== eed.v2) addEdgeToScanList(scdata, eed);
    }

    // STEP 2: the fill loop.
    if (pf.f === SF_POLY_NEW) twoconnected = true;
    let totface = 0;
    const maxface = flag & CALC_HOLES ? 2 * verts : verts - 2;

    for (let a = 0; a < verts; a++) {
      const sc = scdata[a]!;
      for (const ed1 of sc.edges) {
        if (ed1.v1.edgeCount === 1 || ed1.v2.edgeCount === 1) {
          sc.edges.remlink(ed1);
          this.edges.addtail(ed1);
          if (ed1.v1.edgeCount > 1) ed1.v1.edgeCount--;
          if (ed1.v2.edgeCount > 1) ed1.v2.edgeCount--;
        } else ed1.v2.f = SF_VERT_AVAILABLE;
      }
      while (sc.edges.first) {
        const ed1 = sc.edges.first;
        const ed2 = ed1.next;
        if (totface >= maxface) {
          a = verts;
          break;
        }
        if (ed2 === null) {
          sc.edges.first = sc.edges.last = null;
          this.edges.addtail(ed1);
          ed1.v2.f = SF_VERT_NEW;
          ed1.v1.edgeCount--;
          ed1.v2.edgeCount--;
        } else {
          let bestSc: ScanFillVertLink | null = null;
          let angleBestCos = -1;
          let firsttime = false;
          const v1 = ed1.v2;
          const v2 = ed1.v1;
          const v3 = ed2.v2;
          if (v1 === v2 || v2 === v3) break;
          const miny = Math.min(v1.xy[1], v3.xy[1]);
          for (let b = a + 1; b < verts; b++) {
            const sc1 = scdata[b]!;
            if (sc1.vert.f !== SF_VERT_NEW) continue;
            if (sc1.vert.xy[1] <= miny) break;
            if (
              testEdgeSide(v1.xy, v2.xy, sc1.vert.xy) &&
              testEdgeSide(v2.xy, v3.xy, sc1.vert.xy) &&
              testEdgeSide(v3.xy, v1.xy, sc1.vert.xy)
            ) {
              if (bestSc === null) bestSc = sc1;
              else {
                if (!firsttime) {
                  angleBestCos = cosV2v2v2(v2.xy, v1.xy, bestSc.vert.xy);
                  firsttime = true;
                }
                const c = cosV2v2v2(v2.xy, v1.xy, sc1.vert.xy);
                if (c > angleBestCos) {
                  bestSc = sc1;
                  angleBestCos = c;
                }
              }
            }
          }
          if (bestSc) {
            const ed3 = this.addEdge(v2, bestSc.vert);
            this.edges.remlink(ed3);
            sc.edges.insertBefore(ed2, ed3);
            ed3.v2.f = SF_VERT_AVAILABLE;
            ed3.f = SF_EDGE_INTERNAL;
            ed3.v1.edgeCount++;
            ed3.v2.edgeCount++;
          } else {
            this.faces.push([v1, v2, v3]);
            totface++;
            sc.edges.remlink(ed1);
            this.edges.addtail(ed1);
            ed1.v2.f = SF_VERT_NEW;
            ed1.v1.edgeCount--;
            ed1.v2.edgeCount--;
            if (ed2.f === SF_EDGE_NEW && twoconnected) {
              sc.edges.remlink(ed2);
              this.edges.addtail(ed2);
              ed2.v2.f = SF_VERT_NEW;
              ed2.v1.edgeCount--;
              ed2.v2.edgeCount--;
            }
            const ed3 = this.addEdge(v1, v3);
            this.edges.remlink(ed3);
            ed3.f = SF_EDGE_INTERNAL;
            ed3.v1.edgeCount++;
            ed3.v2.edgeCount++;
            const sc1 = addEdgeToScanList(scdata, ed3);
            if (sc1) {
              ed3.v1.edgeCount--;
              ed3.v2.edgeCount--;
              for (let e = sc1.edges.first; e; e = e.next) {
                if ((e.v1 === v1 && e.v2 === v3) || (e.v1 === v3 && e.v2 === v1)) {
                  if (twoconnected) {
                    sc1.edges.remlink(e);
                    this.edges.addtail(e);
                    e.v1.edgeCount--;
                    e.v2.edgeCount--;
                  }
                  break;
                }
              }
            }
          }
        }
        // Loose edges.
        for (const e of sc.edges) {
          if (e.v1.edgeCount < 2 || e.v2.edgeCount < 2) {
            sc.edges.remlink(e);
            this.edges.addtail(e);
            if (e.v1.edgeCount > 1) e.v1.edgeCount--;
            if (e.v2.edgeCount > 1) e.v2.edgeCount--;
          }
        }
      }
    }
    return totface;
  }
}

/**
 * The C runtime's `qsort` as the Windows build of Blender has it (UCRT):
 * quicksort with median-of-three, and a selection sort (`shortsort`) for 8
 * elements or fewer. **Not stable** — which element of a tie comes first is
 * this algorithm's answer, and `triangle_fill` reads it: with every edge the
 * same length, the first of the sorted normals sets the projection's sign.
 */
export function crtQsort<T>(a: T[], cmp: (x: T, y: T) => number): void {
  const swap = (i: number, j: number): void => {
    if (i !== j) [a[i], a[j]] = [a[j]!, a[i]!];
  };
  const shortsort = (lo: number, hi: number): void => {
    while (hi > lo) {
      let max = lo;
      for (let p = lo + 1; p <= hi; p++) if (cmp(a[p]!, a[max]!) > 0) max = p;
      swap(max, hi);
      hi--;
    }
  };
  if (a.length < 2) return;
  const lostk: number[] = [];
  const histk: number[] = [];
  let lo = 0;
  let hi = a.length - 1;
  for (;;) {
    const size = hi - lo + 1;
    if (size <= 8) shortsort(lo, hi);
    else {
      let mid = lo + (size >> 1);
      if (cmp(a[lo]!, a[mid]!) > 0) swap(lo, mid);
      if (cmp(a[lo]!, a[hi]!) > 0) swap(lo, hi);
      if (cmp(a[mid]!, a[hi]!) > 0) swap(mid, hi);
      let loguy = lo;
      let higuy = hi;
      for (;;) {
        if (mid > loguy) {
          do loguy++;
          while (loguy < mid && cmp(a[loguy]!, a[mid]!) <= 0);
        }
        if (mid <= loguy) {
          do loguy++;
          while (loguy <= hi && cmp(a[loguy]!, a[mid]!) <= 0);
        }
        do higuy--;
        while (higuy > mid && cmp(a[higuy]!, a[mid]!) > 0);
        if (higuy < loguy) break;
        swap(loguy, higuy);
        if (mid === higuy) mid = loguy;
      }
      higuy++;
      if (mid < higuy) {
        do higuy--;
        while (higuy > mid && cmp(a[higuy]!, a[mid]!) === 0);
      }
      if (mid >= higuy) {
        do higuy--;
        while (higuy > lo && cmp(a[higuy]!, a[mid]!) === 0);
      }
      if (higuy - lo >= hi - loguy) {
        if (lo < higuy) {
          lostk.push(lo);
          histk.push(higuy);
        }
        if (loguy < hi) {
          lo = loguy;
          continue;
        }
      } else {
        if (loguy < hi) {
          lostk.push(loguy);
          histk.push(hi);
        }
        if (lo < higuy) {
          hi = higuy;
          continue;
        }
      }
    }
    if (lostk.length === 0) return;
    lo = lostk.pop()!;
    hi = histk.pop()!;
  }
}

function vergscdata(a: SFVert, b: SFVert): number {
  if (a.xy[1] < b.xy[1]) return 1;
  if (a.xy[1] > b.xy[1]) return -1;
  if (a.xy[0] > b.xy[0]) return 1;
  if (a.xy[0] < b.xy[0]) return -1;
  return 0;
}

function boundisect(pf2: PolyFill, pf1: PolyFill): boolean {
  if (pf1.edges === 0 || pf2.edges === 0) return false;
  if (pf2.maxXy[0] < pf1.minXy[0]) return false;
  if (pf2.maxXy[1] < pf1.minXy[1]) return false;
  if (pf2.minXy[0] > pf1.maxXy[0]) return false;
  if (pf2.minXy[1] > pf1.maxXy[1]) return false;
  return true;
}

/** Is v3 to the right of v1–v2? Except when v3 is v1 or v2. */
function testEdgeSide(v1: number[], v2: number[], v3: number[]): boolean {
  const inp = f(f(f(v2[0]! - v1[0]!) * f(v1[1]! - v3[1]!)) + f(f(v1[1]! - v2[1]!) * f(v1[0]! - v3[0]!)));
  if (inp < 0) return false;
  if (inp === 0) {
    if (v1[0] === v3[0] && v1[1] === v3[1]) return false;
    if (v2[0] === v3[0] && v2[1] === v3[1]) return false;
  }
  return true;
}

/** `addedgetoscanvert`: insert before the first edge to its right; false if the edge exists. */
function addEdgeToScanVert(sc: ScanFillVertLink, eed: SFEdge): boolean {
  if (sc.edges.first === null) {
    sc.edges.first = sc.edges.last = eed;
    eed.prev = eed.next = null;
    return true;
  }
  const x = eed.v1.xy[0];
  const y = eed.v1.xy[1];
  let fac1 = f(eed.v2.xy[1] - y);
  if (fac1 === 0) fac1 = f(1e10 * f(eed.v2.xy[0] - x));
  else fac1 = f(f(x - eed.v2.xy[0]) / fac1);
  let ed: SFEdge | null;
  for (ed = sc.edges.first; ed; ed = ed.next) {
    if (ed.v2 === eed.v2) return false;
    let fac = f(ed.v2.xy[1] - y);
    if (fac === 0) fac = f(1e10 * f(ed.v2.xy[0] - x));
    else fac = f(f(x - ed.v2.xy[0]) / fac);
    if (fac > fac1) break;
  }
  if (ed) sc.edges.insertBefore(ed, eed);
  else sc.edges.addtail(eed);
  return true;
}

/** `addedgetoscanlist`: returns the vertex link when the edge already exists there. */
function addEdgeToScanList(scdata: ScanFillVertLink[], eed: SFEdge): ScanFillVertLink | null {
  if (eed.v1.xy[1] === eed.v2.xy[1]) {
    if (eed.v1.xy[0] > eed.v2.xy[0]) [eed.v1, eed.v2] = [eed.v2, eed.v1];
  } else if (eed.v1.xy[1] < eed.v2.xy[1]) [eed.v1, eed.v2] = [eed.v2, eed.v1];
  // bsearch on the sorted links.
  let lo = 0;
  let hi = scdata.length - 1;
  let sc: ScanFillVertLink | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = vergscdata(eed.v1, scdata[mid]!.vert);
    if (c === 0) {
      sc = scdata[mid]!;
      break;
    }
    if (c < 0) hi = mid - 1;
    else lo = mid + 1;
  }
  if (sc === null) return null; // "Error in search edge"
  if (!addEdgeToScanVert(sc, eed)) return sc;
  return null;
}

function boundinsideEV(eed: SFEdge, eve: SFVert): boolean {
  const [minx, maxx] = eed.v1.xy[0] < eed.v2.xy[0] ? [eed.v1.xy[0], eed.v2.xy[0]] : [eed.v2.xy[0], eed.v1.xy[0]];
  if (eve.xy[0] >= minx && eve.xy[0] <= maxx) {
    const [miny, maxy] = eed.v1.xy[1] < eed.v2.xy[1] ? [eed.v1.xy[1], eed.v2.xy[1]] : [eed.v2.xy[1], eed.v1.xy[1]];
    if (eve.xy[1] >= miny && eve.xy[1] <= maxy) return true;
  }
  return false;
}

const compareV2 = (a: number[], b: number[], limit: number): boolean =>
  Math.abs(f(a[0]! - b[0]!)) <= limit && Math.abs(f(a[1]! - b[1]!)) <= limit;

/** `dist_squared_to_line_v2(p, l1, l2)`. */
function distSquaredToLineV2(p: number[], l1: number[], l2: number[]): number {
  const u = [f(l2[0]! - l1[0]!), f(l2[1]! - l1[1]!)];
  const h = [f(p[0]! - l1[0]!), f(p[1]! - l1[1]!)];
  const denom = f(f(u[0]! * u[0]!) + f(u[1]! * u[1]!));
  let c: number[];
  if (denom === 0) c = [l1[0]!, l1[1]!];
  else {
    const lambda = f(f(f(u[0]! * h[0]!) + f(u[1]! * h[1]!)) / denom);
    c = [f(l1[0]! + f(u[0]! * lambda)), f(l1[1]! + f(u[1]! * lambda))];
  }
  const dx = f(c[0]! - p[0]!);
  const dy = f(c[1]! - p[1]!);
  return f(f(dx * dx) + f(dy * dy));
}

function normalizeV2(v: number[]): void {
  const d = f(f(v[0]! * v[0]!) + f(v[1]! * v[1]!));
  if (d > 1e-35) {
    const s = f(1 / f(Math.sqrt(d)));
    v[0] = f(v[0]! * s);
    v[1] = f(v[1]! * s);
  } else {
    v[0] = 0;
    v[1] = 0;
  }
}

/** `cos_v2v2v2(p1, p2, p3)`: the cosine of the angle at p2. */
function cosV2v2v2(p1: number[], p2: number[], p3: number[]): number {
  const a = [f(p2[0]! - p1[0]!), f(p2[1]! - p1[1]!)];
  const b = [f(p2[0]! - p3[0]!), f(p2[1]! - p3[1]!)];
  normalizeV2(a);
  normalizeV2(b);
  return f(f(a[0]! * b[0]!) + f(a[1]! * b[1]!));
}

function normalizeV3(n: number[]): number {
  let d = f(f(f(n[0]! * n[0]!) + f(n[1]! * n[1]!)) + f(n[2]! * n[2]!));
  if (d > 1e-35) {
    d = f(Math.sqrt(d));
    const s = f(1 / d);
    for (let k = 0; k < 3; k++) n[k] = f(n[k]! * s);
    return d;
  }
  n[0] = n[1] = n[2] = 0;
  return 0;
}

/** `axis_dominant_v3_to_m3_negate`: the two projection rows. */
function axisDominantNegate(n: number[]): [number[], number[]] {
  const m = n.map((c) => -c);
  const len2 = f(f(m[0]! * m[0]!) + f(m[1]! * m[1]!));
  if (len2 > 1.1920928955078125e-7) {
    const d = f(1 / f(Math.sqrt(len2)));
    const r0 = [f(m[1]! * d), f(-m[0]! * d), 0];
    const r1 = [f(-m[2]! * r0[1]!), f(m[2]! * r0[0]!), f(f(m[0]! * r0[1]!) - f(m[1]! * r0[0]!))];
    return [r0, r1];
  }
  return [[m[2]! < 0 ? -1 : 1, 0, 0], [0, 1, 0]];
}

const projectXY = (mat: [number[], number[]], co: number[]): [number, number] => {
  const dot = (r: number[]): number => f(f(f(r[0]! * co[0]!) + f(r[1]! * co[1]!)) + f(r[2]! * co[2]!));
  return [dot(mat[0]), dot(mat[1])];
};

/**
 * Fill the selected edges of `em` with triangles, as Blender's
 * `bmesh.ops.triangle_fill(use_beauty=False, use_dissolve=False)`.
 * `edges` are half-edge indices, one per edge, in selection order. Returns
 * the new triangles as vertex triples.
 */
export function scanfillTriangles(em: EditMesh, selected: readonly number[]): [number, number, number][] {
  const P = em.positions;
  const co = (v: number): number[] => [P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!];
  const sf = new ScanFill();
  const sfVert = new Map<number, SFVert>();
  const marked = new Map<string, number>(); // edge key → the selected half-edge
  const key = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);
  // Blender's edges run from the lower vertex to the higher, in the order a
  // Mesh made from these polygons numbers them: face by face, each face's
  // closing edge (last corner → first) first, then round in order, new edges
  // only (measured, `probe-edge-order.py`). That order is the order of the
  // selection and of the edges around each vertex (the disk cycle) — and with
  // edges of equal length it decides the sign of the projection normal below,
  // hence the diagonals.
  const edgeIndex = new Map<string, number>();
  for (const poly of toPolygonsOf(em))
    for (let i = 0; i < poly.length; i++) {
      const k = key(poly[(i - 1 + poly.length) % poly.length]!, poly[i]!);
      if (!edgeIndex.has(k)) edgeIndex.set(k, edgeIndex.size);
    }
  const endsOf = (he: number): [number, number] => {
    const a = em.halfEdges[he]!.v;
    const b = em.halfEdges[em.halfEdges[he]!.next]!.v;
    return a < b ? [a, b] : [b, a];
  };
  const idx = (he: number): number => edgeIndex.get(key(...endsOf(he))) ?? Infinity;
  const edges = [...selected].sort((x, y) => idx(x) - idx(y));
  let calcWinding = false;
  for (const he of edges) {
    const [a, b] = endsOf(he);
    marked.set(key(a, b), he);
    if (em.halfEdges[he]!.twin < 0) calcWinding = true;
    const vs = [a, b].map((v) => {
      let s = sfVert.get(v);
      if (!s) {
        s = sf.addVert(co(v), v);
        sfVert.set(v, s);
      }
      return s;
    });
    sf.addEdge(vs[0]!, vs[1]!);
  }

  // The projection normal: each vertex with exactly two marked edges gives
  // the cross product of its two edge directions; the longest leads, the rest
  // are turned to agree with it and summed.
  // `edges` is already in disk-cycle order, so each vertex's list is too.
  const incident = new Map<number, number[]>();
  for (const he of edges) {
    const [a, b] = endsOf(he);
    for (const [v, o] of [[a, b], [b, a]] as const) (incident.get(v) ?? incident.set(v, []).get(v)!).push(o);
  }
  const nors: { value: number; no: number[] }[] = [];
  let degenerate = true;
  for (const s of sf.verts) {
    const others = incident.get(s.id) ?? [];
    if (others.length !== 2) {
      nors.push({ value: -1, no: [0, 0, 0] });
      continue;
    }
    degenerate = false;
    const v = co(s.id).map(f);
    const da = co(others[0]!).map((c, k) => f(v[k]! - f(c)));
    const db = co(others[1]!).map((c, k) => f(v[k]! - f(c)));
    let no = [
      f(f(da[1]! * db[2]!) - f(da[2]! * db[1]!)),
      f(f(da[2]! * db[0]!) - f(da[0]! * db[2]!)),
      f(f(da[0]! * db[1]!) - f(da[1]! * db[0]!)),
    ];
    const len2 = (x: number[]): number => f(f(f(x[0]! * x[0]!) + f(x[1]! * x[1]!)) + f(x[2]! * x[2]!));
    const value = len2(no);
    if (len2(da) > len2(db)) no = no.map((c) => -c);
    nors.push({ value, no });
  }
  let normal = [0, 0, 0];
  if (!degenerate) {
    // `BLI_sortutil_cmp_float_reverse`: larger values first.
    const sorted = [...nors];
    crtQsort(sorted, (a, b) => (a.value < b.value ? 1 : a.value > b.value ? -1 : 0));
    normal = [...sorted[0]!.no];
    for (const nn of sorted) {
      if (nn.value === -1) break;
      let v = nn.no;
      if (f(f(f(normal[0]! * v[0]!) + f(normal[1]! * v[1]!)) + f(normal[2]! * v[2]!)) < 0) v = v.map((c) => -c);
      for (let k = 0; k < 3; k++) normal[k] = f(normal[k]! + v[k]!);
    }
    normalizeV3(normal);
  }
  if (normalizeV3(normal) === 0) normal = [0, 0, 1];

  sf.calc(CALC_HOLES | CALC_POLYS | CALC_LOOSE, normal);

  let tris = sf.faces.map(([a, b, c]) => [a.id, b.id, c.id] as [number, number, number]);
  if (calcWinding) {
    // Wind like the faces already on the boundary.
    let votes = 0;
    for (const t of tris)
      for (let i = 0, ip = 2; i < 3; ip = i++) {
        const he = marked.get(key(t[i]!, t[ip]!));
        if (he === undefined || em.halfEdges[he]!.twin >= 0) continue;
        votes += em.halfEdges[he]!.v === t[i] ? 1 : -1;
      }
    if (votes < 0) tris = tris.map(([a, b, c]) => [a, c, b]);
  }
  return tris;
}

/**
 * Spin — Blender's `bmesh.ops.spin` (`bmo_spin_exec`, `bmesh/operators/bmo_dupe.cc`,
 * Blender 5.1.1), over any vertices, edges and faces of a mesh, about any
 * centre and axis.
 *
 * Each step extrudes what the last one made (`extrude_face_region`,
 * `bmo_extrude.cc`) and turns it about the axis — or, with `useDuplicate`,
 * copies the input (`duplicate`, `bmo_mesh_copy`) and turns the copy. Both
 * are ported here on `bmesh-lite`, so the faces, their winding, the walls'
 * corner data and the region-edge flags come out as Blender's do. The
 * **order** of the output does not: Blender makes the walls in the order of
 * a pointer hash (`boundary_map.out`), and its mempools reuse the slots
 * earlier steps freed.
 */
import type { MeshData } from "../lib/mesh";
import { f, type V3 } from "./blender-math";
import {
  bmFromMesh, bmLayers, bmToMesh, diskEdges, edgeCreate, edgeExists, edgeKill, edgeSplice, faceCreate,
  faceKill, faceLoops, liveEdges, liveFaces, radialLoops, vertCreate, vertKill, vertSplice,
  type BE, type BF, type BL, type BM, type BV,
} from "./bmesh-lite";
import { seamKey } from "./edit-mode/half-edge";

export interface SpinOptions {
  /** `cent`. Default the origin. */
  center?: readonly [number, number, number];
  /** `axis`; normalised. */
  axis: readonly [number, number, number];
  /** `angle`: the whole turn, radians. The editor's Spin passes its angle negated. */
  angle: number;
  /** `steps`. */
  steps: number;
  /** `dvec`: a translation per step, itself turned with each step's rotation. Default none. */
  dvec?: readonly [number, number, number];
  /** `use_merge`: weld the last step back onto the first (with 3 steps or more). Default false. */
  useMerge?: boolean;
  /** `use_normal_flip`: wind the first step's walls the other way. Default false. */
  useNormalFlip?: boolean;
  /** `use_duplicate`: copies, not a surface. Default false. */
  useDuplicate?: boolean;
}

/** Which elements to spin — `geom`. Edges as vertex pairs, faces as indices into `data.polys`. */
export interface SpinGeom {
  verts?: Iterable<number>;
  edges?: Iterable<readonly [number, number]>;
  faces?: Iterable<number>;
}

interface Geom {
  V: Set<BV>;
  E: Set<BE>;
  F: Set<BF>;
}

/** Per-vertex and per-edge data the BMesh does not hold. */
interface Side {
  /** The input vertex whose data (groups) a vertex has. */
  vsrc: Map<BV, number>;
  /** The step-0 vertex a copy stands for — the "index in the normal" of `bmo_spin_exec`. */
  vorig: Map<BV, BV>;
  crease: Map<BE, number>;
  seam: Set<BE>;
  sharp: Set<BE>;
}

function copyEdgeData(s: Side, from: BE, to: BE): void {
  const c = s.crease.get(from);
  if (c !== undefined) s.crease.set(to, c);
  if (s.seam.has(from)) s.seam.add(to);
  if (s.sharp.has(from)) s.sharp.add(to);
}

/** `duplicate` (`bmo_mesh_copy`), in the mesh's order, with its maps. */
function duplicate(bm: BM, g: Geom, s: Side) {
  const vmap = new Map<BV, BV>();
  const emap = new Map<BE, BE>();
  const boundary: [BE, BE][] = [];
  const isovert: [BV, BV][] = [];
  const out = { V: new Set<BV>(), E: new Set<BE>(), F: new Set<BF>() };

  const copyVert = (v: BV): BV => {
    const v2 = vertCreate(bm, v.co);
    v2.no = [...v.no];
    vmap.set(v, v2);
    s.vsrc.set(v2, s.vsrc.get(v) ?? -1);
    s.vorig.set(v2, s.vorig.get(v) ?? v);
    out.V.add(v2);
    return v2;
  };
  const copyEdge = (e: BE): BE => {
    let rlen = 0;
    for (const l of radialLoops(e)) if (g.F.has(l.f)) rlen++;
    const e2 = edgeCreate(bm, vmap.get(e.v1)!, vmap.get(e.v2)!);
    emap.set(e, e2);
    if (rlen < 2) boundary.push([e, e2]);
    copyEdgeData(s, e, e2);
    out.E.add(e2);
    return e2;
  };

  const verts = bm.verts.filter((v): v is BV => !!v);
  for (const v of verts) {
    if (!g.V.has(v) || vmap.has(v)) continue;
    const v2 = copyVert(v);
    let isolated = true;
    for (const e of diskEdges(v)) {
      if (radialLoops(e).some((l) => g.F.has(l.f))) {
        isolated = false;
        break;
      }
    }
    if (isolated) for (const e of diskEdges(v)) if (g.E.has(e)) isolated = false;
    if (isolated) isovert.push([v, v2]);
  }
  for (const e of liveEdges(bm)) {
    if (!g.E.has(e) || emap.has(e)) continue;
    if (!vmap.has(e.v1)) copyVert(e.v1);
    if (!vmap.has(e.v2)) copyVert(e.v2);
    copyEdge(e);
  }
  for (const x of liveFaces(bm)) {
    if (!g.F.has(x)) continue;
    const loops = faceLoops(x);
    for (const l of loops) if (!vmap.has(l.v)) copyVert(l.v);
    for (const l of loops) if (!emap.has(l.e!)) copyEdge(l.e!);
    const x2 = faceCreate(
      bm,
      loops.map((l) => vmap.get(l.v)!),
      loops.map((l) => emap.get(l.e!)!),
      { no: x.no, tag: false, src: x.src },
    );
    faceLoops(x2).forEach((l, k) => (l.src = loops[k]!.src));
    out.F.add(x2);
  }
  return { vmap, emap, boundary, isovert, out };
}

/** `BM_edge_other_loop`: the loop of the other face on `e`, at `l`'s vertex. */
function otherLoop(e: BE, l: BL): BL {
  let o = l.e === e ? l : l.prev;
  o = o.rn!;
  if (o.v !== l.v && o.next.v === l.v) o = o.next;
  return o;
}

/** `bm_extrude_region_edge_flag`: seam if any face-held edge at `v` has one, sharp if any is sharp. */
function regionEdgeFlags(v: BV, s: Side): { seam: boolean; sharp: boolean } | null {
  let ok = false;
  let seam = false;
  let sharp = false;
  for (const e of diskEdges(v)) {
    if (e.l && e.l.rn !== e.l) {
      ok = true;
      if (s.seam.has(e)) seam = true;
      if (s.sharp.has(e)) sharp = true;
    }
  }
  return ok ? { seam, sharp } : null;
}

/** `extrude_face_region` with `skip_input_flip` (as spin calls it). Returns the copies. */
function extrudeRegion(
  bm: BM,
  g: Geom,
  s: Side,
  opts: { keepOrig: boolean; normalFlip: boolean; fromAdjacent: boolean },
): Geom {
  // EXT_INPUT is the edges and faces; EXT_DEL what the originals lose.
  const edel = new Set<BE>();
  let delorig = false;
  if (!opts.keepOrig)
    for (const e of liveEdges(bm)) {
      if (!g.E.has(e)) continue;
      let found = false;
      let tot = 0;
      for (const l of radialLoops(e)) {
        if (!g.F.has(l.f)) {
          found = true;
          delorig = true;
          break;
        }
        tot++;
      }
      if (tot > 1 && !found) edel.add(e);
    }
  const vdel = new Set<BV>();
  for (const v of bm.verts) {
    if (!v || !v.e) continue;
    let found = diskEdges(v).some((e) => !g.E.has(e) || !edel.has(e));
    if (!found) found = diskEdges(v).some((e) => radialLoops(e).some((l) => !g.F.has(l.f)));
    if (!found) vdel.add(v);
  }

  const dup = duplicate(bm, g, s);

  if (delorig) {
    for (const x of g.F) if (x.first) faceKill(bm, x);
    for (const e of edel) if (bm.edges.items[e.slot] === e) edgeKill(bm, e);
    for (const v of vdel) if (bm.verts[v.index] === v) vertKill(bm, v);
  }

  for (const [e, eNew] of dup.boundary) {
    if (bm.edges.items[e.slot] !== e) continue;
    let edgeNormalFlip: boolean;
    if (!opts.fromAdjacent) edgeNormalFlip = !(eNew.l ? eNew.l.v === eNew.v1 : !e.l || !(e.l.v === e.v1));
    else edgeNormalFlip = !(e.l && e.v1 !== e.l.v);
    const fv =
      edgeNormalFlip === opts.normalFlip ? [e.v1, e.v2, eNew.v2, eNew.v1] : [e.v2, e.v1, eNew.v1, eNew.v2];
    const side = (a: BV, b: BV, flagsFrom: BV): BE => {
      const found = edgeExists(a, b);
      if (found) return found;
      const flags = regionEdgeFlags(flagsFrom, s);
      const made = edgeCreate(bm, a, b);
      if (flags?.seam) s.seam.add(made);
      if (flags?.sharp) s.sharp.add(made);
      return made;
    };
    const e1 = side(fv[1]!, fv[2]!, fv[2]!);
    const e3 = side(fv[3]!, fv[0]!, fv[3]!);
    const wall = faceCreate(bm, fv, [e, e1, eNew, e3], null);
    // bm_extrude_copy_face_loop_attributes: from the face across the old edge.
    const l0 = wall.first!;
    if (l0.rn !== l0) {
      const o0 = otherLoop(l0.e!, l0);
      const o1 = otherLoop(l0.e!, l0.next);
      wall.src = o0.f.src;
      wall.no = [...o0.f.no];
      const ls = faceLoops(wall);
      ls[0]!.src = o0.src;
      ls[3]!.src = o0.src;
      ls[1]!.src = o1.src;
      ls[2]!.src = o1.src;
    }
  }

  for (let [v, v2] of dup.isovert) {
    // BM_vert_is_wire_endpoint: one edge, and it holds no face.
    if (v.e && !v.e.l && diskEdges(v).length === 1 && v.e.v1 === v) [v, v2] = [v2, v];
    if (!edgeExists(v, v2)) edgeCreate(bm, v, v2);
  }
  return dup.out;
}

/**
 * `BM_face_find_double`: a face on the radial cycle of `x`'s first loop with
 * the same edges in turn — from a loop at the same vertex forwards, or from
 * any other backwards.
 */
function findDoubleFace(x: BF): BF | null {
  const first = x.first!;
  for (let li = first.rn!; li !== first; li = li.rn!) {
    if (li.f.len !== x.len) continue;
    let a = first;
    let b = li;
    let same = true;
    do {
      if (a.e !== b.e) {
        same = false;
        break;
      }
      a = li.v === first.v ? a.next : a.prev;
      b = b.next;
    } while (b !== li);
    if (same) return li.f;
  }
  return null;
}

/** `axis_angle_normalized_to_mat3`, as rows, each entry rounded to float. */
function rotation(axis: V3, angle: number): number[][] {
  const [x, y, z] = axis as [number, number, number];
  const c = f(Math.cos(angle));
  const sn = f(Math.sin(angle));
  const t = f(1 - c);
  return [
    [f(t * x * x + c), f(t * x * y - sn * z), f(t * x * z + sn * y)],
    [f(t * x * y + sn * z), f(t * y * y + c), f(t * y * z - sn * x)],
    [f(t * x * z - sn * y), f(t * y * z + sn * x), f(t * z * z + c)],
  ];
}
const mul = (m: number[][], v: readonly number[]): V3 =>
  [0, 1, 2].map((i) => f(m[i]![0]! * v[0]! + m[i]![1]! * v[1]! + m[i]![2]! * v[2]!)) as V3;

/**
 * Spin `geom` about `center` and `axis`: `bmesh.ops.spin`.
 *
 * - **Extrude** (default): each step extrudes the last step's copy
 *   (`extrude_face_region`) and turns it by one step — a profile of edges
 *   sweeps a surface, faces sweep a solid. A region with no face outside it
 *   keeps its originals as the start cap; one bordered by other faces loses
 *   them (the walls take their place).
 * - **`useDuplicate`**: `steps` turned copies of the input, unjoined.
 * - **`useMerge`** (3 steps or more): the last step's copy is welded onto the
 *   input instead of turned, so a full turn closes. Blender checks the angle
 *   only in the editor's operator; so does this — the caller does.
 * - **`dvec`**: after each step, the step's copy moves by `dvec`, which is
 *   first turned by that step's whole rotation — cumulatively, as Blender
 *   writes the turned vector back.
 *
 * Every layer comes through: copies keep their source's vertex groups, edge
 * flags, corners and material; a wall's corners and material come from the
 * face across the edge it grew from; a new side edge takes seam and sharp
 * from the face-held edges at its new vertex (`USE_EDGE_REGION_FLAGS`).
 * **Custom normals are copied as the vectors they were** — a turned copy's
 * do not turn. Blender stores them as angles in each corner's own space, so
 * there they turn with it (`spin-geom-custom-normals`, recorded different).
 * `space` (the object matrix) is not taken: the geometry is in its own space.
 */
export function spin(data: MeshData, geom: SpinGeom, opts: SpinOptions): MeshData {
  const bm = bmFromMesh(data);
  const byIndex = new Map<number, BV>();
  for (const v of bm.verts) if (v) byIndex.set(v.index, v);
  const s: Side = { vsrc: new Map(), vorig: new Map(), crease: new Map(), seam: new Set(), sharp: new Set() };
  for (const v of byIndex.values()) {
    s.vsrc.set(v, v.index);
    s.vorig.set(v, v);
  }
  for (const e of liveEdges(bm)) {
    const k = seamKey(e.v1.index, e.v2.index);
    const c = data.creases?.get(k);
    if (c !== undefined) s.crease.set(e, c);
    if (data.seams?.has(k)) s.seam.add(e);
    if (data.sharp?.has(k)) s.sharp.add(e);
  }

  const input: Geom = { V: new Set(), E: new Set(), F: new Set() };
  for (const v of geom.verts ?? []) input.V.add(byIndex.get(v)!);
  for (const [a, b] of geom.edges ?? []) {
    const e = edgeExists(byIndex.get(a)!, byIndex.get(b)!);
    if (!e) throw new Error(`spin: no edge joins ${a} and ${b}`);
    input.E.add(e);
  }
  const faceOf = new Map<number, BF>();
  for (const x of liveFaces(bm)) faceOf.set(x.src, x);
  for (const i of geom.faces ?? []) input.F.add(faceOf.get(i)!);
  // geom=%hvef in the editor, a buffer here: the duplicate and extrude read
  // what is given, and a face's edges and vertices come with it.

  const len = Math.hypot(opts.axis[0], opts.axis[1], opts.axis[2]);
  if (!(len > 0)) throw new Error("spin: the axis is zero");
  const axis: V3 = [f(opts.axis[0] / len), f(opts.axis[1] / len), f(opts.axis[2] / len)];
  const cent = opts.center ?? [0, 0, 0];
  let dvec: V3 = [...(opts.dvec ?? [0, 0, 0])];
  const useDvec = dvec.some((x) => x !== 0);
  const steps = Math.max(0, Math.floor(opts.steps));
  const useMerge = !!opts.useMerge && steps >= 3;
  const turn = (verts: Iterable<BV>, m: number[][]): void => {
    for (const v of verts) {
      const d = [f(v.co[0]! - cent[0]), f(v.co[1]! - cent[1]), f(v.co[2]! - cent[2])];
      const r = mul(m, d);
      v.co = [f(r[0]! + cent[0]), f(r[1]! + cent[1]), f(r[2]! + cent[2])];
    }
  };

  let last: Geom = input;
  for (let a = 0; a < steps; a++) {
    const rmat = rotation(axis, f(opts.angle * f((a + 1) / steps)));
    if (opts.useDuplicate) {
      const dup = duplicate(bm, input, s);
      turn(dup.out.V, rmat);
      last = dup.out;
    } else {
      const out = extrudeRegion(bm, last, s, {
        keepOrig: useMerge,
        normalFlip: !!opts.useNormalFlip && a === 0,
        fromAdjacent: a !== 0,
      });
      if (!(useMerge && a === steps - 1)) {
        const prev = f(opts.angle * f(a / steps));
        const curr = f(opts.angle * f((a + 1) / steps));
        turn(out.V, rotation(axis, f(curr - prev)));
        last = out;
      } else {
        // Weld the copies onto the vertices they began as, then drop the
        // edges and faces that now double others.
        for (const v of out.V) {
          const dst = s.vorig.get(v)!;
          if (dst !== v && bm.verts[v.index] === v) vertSplice(bm, dst, v);
        }
        for (const e of out.E) {
          if (bm.edges.items[e.slot] !== e) continue;
          // BM_edge_find_double: the first edge after `e` round `e.v1`'s disk
          // that also holds `e.v2`.
          const disk = diskEdges(e.v1);
          const at = disk.indexOf(e);
          let dbl: BE | null = null;
          for (let k = 1; k < disk.length && !dbl; k++) {
            const o = disk[(at + k) % disk.length]!;
            if (o.v1 === e.v2 || o.v2 === e.v2) dbl = o;
          }
          if (dbl) edgeSplice(bm, dbl, e);
        }
        for (const x of out.F) {
          if (!x.first) continue;
          if (findDoubleFace(x)) faceKill(bm, x);
        }
      }
    }
    if (useDvec) {
      dvec = mul(rmat, dvec);
      for (const v of last.V) v.co = [f(v.co[0]! + dvec[0]!), f(v.co[1]! + dvec[1]!), f(v.co[2]! + dvec[2]!)];
    }
  }

  // Back to a mesh: vertices in order, the layers through `src`, groups and
  // edge flags through the side tables.
  const mesh = bmToMesh(bm);
  const index = new Map<BV, number>();
  let n = 0;
  for (const v of bm.verts) if (v) index.set(v, n++);
  const out: MeshData = { ...mesh, ...bmLayers(bm, data) };
  if (data.groups) {
    out.groups = new Map();
    for (const [name, g] of data.groups) {
      const ng = new Map<number, number>();
      for (const [v, i] of index) {
        const w = g.get(s.vsrc.get(v) ?? -1);
        if (w !== undefined) ng.set(i, w);
      }
      out.groups.set(name, ng);
    }
  }
  const creases = new Map<string, number>();
  const seams = new Set<string>();
  const sharp = new Set<string>();
  for (const e of liveEdges(bm)) {
    const k = seamKey(index.get(e.v1)!, index.get(e.v2)!);
    const c = s.crease.get(e);
    if (c !== undefined) creases.set(k, c);
    if (s.seam.has(e)) seams.add(k);
    if (s.sharp.has(e)) sharp.add(k);
  }
  if (data.creases || creases.size) out.creases = creases;
  if (data.seams || seams.size) out.seams = seams;
  if (data.sharp || sharp.size) out.sharp = sharp;
  return out;
}

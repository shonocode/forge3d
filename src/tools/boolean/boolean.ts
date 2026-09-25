/**
 * Boolean union, difference and intersection of two parts of one mesh —
 * Blender's `bpy.ops.mesh.intersect_boolean` with the exact solver
 * (`blenlib/intern/mesh_boolean.cc`, `boolean_trimesh`). ADR-012's stage 2.
 *
 * The triangles come from stage 1 (`subdivide` in `intersect.ts`): every
 * input triangle cut wherever the other part passes through it. From there
 * it is Zhou et al.'s *Mesh Arrangements for Solid Geometry*, as Blender
 * wrote it, ported function by function:
 *
 * 1. **Patches** — triangles joined across edges that exactly two triangles
 *    share (`find_patches`). Patches meet only along the cut lines.
 * 2. **Cells** — the volumes between patches, found by sorting the
 *    triangles around every cut edge (`sort_tris_around_edge`,
 *    `find_cells_from_edge`).
 * 3. **Nesting** — pieces that do not touch are separate components; each
 *    one's outside is merged into the cell of whichever other component
 *    contains it (`finish_patch_cell_graph`).
 * 4. **Winding numbers** — from the cell outside everything, crossing a
 *    patch adds or removes one for the part it belongs to
 *    (`propagate_windings_and_in_output_volume`); the operation says which
 *    cells are in the result (`apply_bool_op`).
 * 5. **Extraction** — keep the triangles between a cell in the result and
 *    one out of it, facing out of the result (`extract_from_in_output_volume_diffs`),
 *    with stacks of identical triangles reduced to one or none.
 *
 * The triangles are then merged back into polygons exactly as `intersect`
 * does (`mergePieces`).
 *
 * Blender's own quirks are kept where they can change the answer — they are
 * marked where they occur (`mergeCells`, `findCellsFromEdge`).
 *
 * **Parts that are not closed** ("not PWN" — some edge's triangles do not
 * cancel) have no cells to speak of. Blender then casts rays instead
 * (`raycast_patches_boolean`, or per triangle with `holeTolerant` —
 * `raycast_tris_boolean`): from just above a test triangle, six slightly
 * tilted axis rays, counting signed crossings of the other part; "inside"
 * when at least 1 in 10 of them says so, or half when the answer must be
 * sure (the cutter in a difference, and intersection). Ported as it is,
 * the ray–triangle test in float with its `FLT_EPSILON` margin. Blender
 * finds the candidates with a BVH; every triangle is tried here, which the
 * BVH only prunes.
 *
 * ## Not yet
 *
 * - Two input vertices at exactly the same position are one vertex to
 *   Blender (`add_or_find_vert`) and two here.
 */
import type { MeshData } from "../../lib/mesh";
import { add, cmp, div, fromDouble, mul, neg, orient3dExact, q, q3Cross, q3Dot, q3Sub, sign, sub, type Q, type Q3 } from "./exact";
import { mergePieces, subdivide, toMeshData, type Piece } from "./intersect";
import { interpWeightsPoly } from "../edit-mode/interp";

export type BooleanOperation = "union" | "difference" | "intersect";

export interface BooleanOptions {
  /** What to keep: the union, part A minus part B, or where both are. */
  operation: BooleanOperation;
  /**
   * The faces of part **B** — Blender's selected faces. Every other face is
   * part A. `"difference"` is A − B. Give this or {@link parts}.
   */
  set?: ReadonlySet<number>;
  /**
   * A part number per face, for **more than two** parts — the BOOLEAN
   * modifier with a Collection operand, where the modified object is part 0
   * and each object in the collection its own part. `"difference"` is part 0
   * minus all the others; `"union"` and `"intersect"` are over all of them.
   */
  parts?: readonly number[];
  /**
   * For parts that are not closed: decide each triangle by ray casting on
   * its own rather than each patch at once (Blender's "Hole Tolerant",
   * `raycast_tris_boolean`). Slower; right more often on messy input.
   * No effect when both parts are closed.
   */
  holeTolerant?: boolean;
  /**
   * Let a part intersect **itself** — Blender's `use_self` ("Self
   * Intersection"). Every pair of triangles is cut against each other, the
   * same part's included (`trimesh_self_intersect` instead of the two-part
   * `trimesh_nary_intersect`), so a part made of overlapping pieces is
   * resolved before the boolean. Default false, as Blender's.
   *
   * **Except the two triangles of one face.** Edit-mode `intersect` cuts a
   * bent quad's halves against each other; the modifier path does not —
   * measured, `boolean-mod-union-self` on the UV sphere and the bent cage
   * came out 10 and more faces apart until those pairs were skipped.
   */
  useSelf?: boolean;
}

/**
 * Union, difference or intersection of the two parts of `data`.
 *
 * ```ts
 * booleanMesh(twoCubes, { operation: "difference", set: new Set([6, 7, 8, 9, 10, 11]) });
 * ```
 *
 * **Layers** (compat-backlog A7): UVs, colours, materials, vertex groups and
 * edge flags, as the exact solver carries them (`boolean-*-layers`): each
 * output face takes its input face's slot and copies its corners, or
 * interpolates them (mean value) at a vertex the cut made; input vertices
 * keep their groups. The BOOLEAN modifier with an object operand drops that
 * operand's groups (measured); this takes one mesh, as edit mode does.
 * Custom normals are dropped.
 */
export function booleanMesh(data: MeshData, options: BooleanOptions): MeshData {
  const partOfFace: (face: number) => number = options.parts
    ? (face) => options.parts![face] ?? 0
    : (face) => (options.set?.has(face) ? 1 : 0);
  if (!options.parts && !options.set) throw new Error("booleanMesh: give `set` (two parts) or `parts`");
  const nshapes = options.parts ? Math.max(1, ...options.parts) + 1 : 2;
  const { verts, pieces } = subdivide(data, options.useSelf ? null : partOfFace, !options.useSelf);
  const coOf = (v: number): Q3 => verts[v]!.exact;
  const shapeOf = (t: number): number => partOfFace(pieces[t]!.face);
  const coD = (v: number): readonly number[] => verts[v]!.co;
  const kept = booleanTrimesh(pieces, coOf, coD, options.operation, nshapes, shapeOf, options.holeTolerant ?? false);
  const merged = mergePieces(kept, data, verts);
  // `apply_mesh_output_to_bmesh`: a face whose vertices another face already
  // has is that face (`BM_face_exists`), so it appears once.
  const seen = new Set<string>();
  const faces = merged.filter((f) => {
    const k = [...f.vert].sort((a, b) => a - b).join(",");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const polys = faces.map((f) => f.vert);
  return { ...toMeshData(polys, verts), ...booleanLayers(data, faces, verts) };
}

/**
 * The layers of a boolean's result, as `mesh_boolean_convert` carries them.
 * Every output face came from one input face (`face`): it takes that face's
 * slot, and each of its corners copies the input face's corner at the same
 * input vertex, or — at a vertex the cut made — the mean-value interpolation
 * over the input face at that point (`copy_or_interp_loop_attributes`).
 * Input vertices keep their groups; edges between two input vertices that
 * were input edges keep their flags.
 */
function booleanLayers(
  data: MeshData,
  faces: readonly { vert: number[]; face: number }[],
  verts: readonly { co: readonly [number, number, number] }[],
): Partial<MeshData> {
  const nv = data.positions.length / 3;
  // `toMeshData`'s renumbering: the used vertices, in order.
  const used = new Set<number>(faces.flatMap((f) => f.vert));
  const remap = new Map<number, number>();
  verts.forEach((_, i) => {
    if (used.has(i)) remap.set(i, remap.size);
  });

  const out: Partial<MeshData> = {};
  const weightsFor = new Map<string, number[]>();
  const cornerOf = (f: { vert: number[]; face: number }, v: number): [number, number][] => {
    const poly = data.polys[f.face]!;
    const i = v < nv ? poly.indexOf(v) : -1;
    if (i >= 0) return [[i, 1]];
    const key = `${f.face}|${v}`;
    let w = weightsFor.get(key);
    if (!w) {
      const P = data.positions;
      let nx = 0, ny = 0, nz = 0;
      for (let k = 0; k < poly.length; k++) {
        const a = poly[k]! * 3;
        const b = poly[(k + 1) % poly.length]! * 3;
        nx += (P[a + 1]! - P[b + 1]!) * (P[a + 2]! + P[b + 2]!);
        ny += (P[a + 2]! - P[b + 2]!) * (P[a]! + P[b]!);
        nz += (P[a]! - P[b]!) * (P[a + 1]! + P[b + 1]!);
      }
      const len = Math.hypot(nx, ny, nz) || 1;
      w = interpWeightsPoly(P, poly, [nx / len, ny / len, nz / len], verts[v]!.co as [number, number, number]);
      weightsFor.set(key, w);
    }
    return w.map((x, k) => [k, x] as [number, number]);
  };
  const layer = (src: number[][][] | undefined, clamp: boolean): number[][][] | undefined => {
    if (!src || src.length !== data.polys.length) return undefined;
    return faces.map((f) =>
      f.vert.map((v) => {
        const mix = cornerOf(f, v);
        const corners = src[f.face]!;
        const r = corners[mix[0]![0]]!.map(() => 0);
        for (const [k, w] of mix) corners[k]!.forEach((x, j) => (r[j] = r[j]! + w * x));
        return clamp ? r.map((x) => Math.min(1, Math.max(0, x))) : r;
      }),
    );
  };
  const uvs = layer(data.uvs, false);
  if (uvs) out.uvs = uvs;
  const colors = layer(data.colors, true);
  if (colors) out.colors = colors;
  if (data.materials && data.materials.length === data.polys.length)
    out.materials = faces.map((f) => data.materials![f.face]!);
  if (data.groups) {
    out.groups = new Map(
      [...data.groups].map(([name, g]) => [
        name,
        new Map([...g].filter(([v]) => remap.has(v)).map(([v, w]) => [remap.get(v)!, w] as [number, number])),
      ]),
    );
  }
  const edgeKeys = new Set<string>();
  for (const f of faces)
    for (let i = 0; i < f.vert.length; i++) {
      const a = f.vert[i]!;
      const b = f.vert[(i + 1) % f.vert.length]!;
      if (a < nv && b < nv) edgeKeys.add(a < b ? `${a}_${b}` : `${b}_${a}`);
    }
  const keep = (k: string): string | null => {
    if (!edgeKeys.has(k)) return null;
    const [a, b] = k.split("_").map(Number) as [number, number];
    const ra = remap.get(a)!;
    const rb = remap.get(b)!;
    return ra < rb ? `${ra}_${rb}` : `${rb}_${ra}`;
  };
  for (const name of ["creases", "seams", "sharp"] as const) {
    const src = data[name];
    if (!src) continue;
    if (src instanceof Map) {
      const m = new Map<string, number>();
      for (const [k, x] of src) {
        const nk = keep(k);
        if (nk) m.set(nk, x);
      }
      (out as Record<string, unknown>)[name] = m;
    } else {
      const s = new Set<string>();
      for (const k of src) {
        const nk = keep(k);
        if (nk) s.add(nk);
      }
      (out as Record<string, unknown>)[name] = s;
    }
  }
  return out;
}

// ── topology ────────────────────────────────────────────────────────────────

/** An edge with its ends ordered by vertex id, as Blender's `Edge`. */
type Edge = readonly [number, number];
const mkEdge = (a: number, b: number): Edge => (a <= b ? [a, b] : [b, a]);
const ekey = (e: Edge): string => `${e[0]},${e[1]}`;

class Topology {
  /** Triangles having each edge, either way round, in the order met. */
  readonly edgeTris = new Map<string, number[]>();
  readonly edgeOf = new Map<string, Edge>();
  /** Edges leaving each vertex (as the tail in some triangle), in the order met. */
  readonly vertEdges = new Map<number, Edge[]>();

  constructor(tris: readonly (readonly number[])[]) {
    tris.forEach((tri, t) => {
      for (let i = 0; i < 3; i++) {
        const v = tri[i]!;
        const e = mkEdge(v, tri[(i + 1) % 3]!);
        const k = ekey(e);
        const list = this.vertEdges.get(v) ?? this.vertEdges.set(v, []).get(v)!;
        if (!list.some((x) => x[0] === e[0] && x[1] === e[1])) list.push(e);
        const ts = this.edgeTris.get(k);
        if (!ts) {
          this.edgeTris.set(k, [t]);
          this.edgeOf.set(k, e);
        } else if (!ts.includes(t)) ts.push(t);
      }
    });
  }

  otherTriIfManifold(e: Edge, t: number): number {
    const ts = this.edgeTris.get(ekey(e));
    if (ts && ts.length === 2) return ts[0] === t ? ts[1]! : ts[0]!;
    return -1;
  }
}

/** `is_pwn`: every edge's triangles use it as often one way as the other. */
function isPwn(tris: readonly (readonly number[])[], topo: Topology): boolean {
  for (const [k, ts] of topo.edgeTris) {
    const e = topo.edgeOf.get(k)!;
    let tot = 0;
    for (const t of ts) {
      const f = tris[t]!;
      for (let i = 0; i < 3; i++)
        if (f[i] === e[0]) tot += f[(i + 1) % 3] === e[1] ? 1 : -1;
    }
    if (tot !== 0) return false;
  }
  return true;
}

// ── patches and cells ───────────────────────────────────────────────────────

interface Patch {
  tris: number[];
  cellAbove: number;
  cellBelow: number;
  component: number;
}

interface Cell {
  patches: Set<number>;
  winding: number[];
  mergedTo: number;
  windingAssigned: boolean;
  inOutput: boolean;
  zeroVolume: boolean;
}

const newCell = (): Cell => ({
  patches: new Set(),
  winding: [],
  mergedTo: -1,
  windingAssigned: false,
  inOutput: false,
  zeroVolume: false,
});

function addPatch(cell: Cell, p: number): void {
  cell.patches.add(p);
  cell.zeroVolume = false;
}

/** `find_flap_vert`: the vertex of `tri` not on `e`, and whether `tri` runs `e` backwards. */
function findFlap(tri: readonly number[], e: Edge): { flap: number; rev: boolean } | null {
  if (tri[0] === e[0]) {
    if (tri[1] === e[1]) return { flap: tri[2]!, rev: false };
    if (tri[2] !== e[1]) return null;
    return { flap: tri[1]!, rev: true };
  }
  if (tri[1] === e[0]) {
    if (tri[2] === e[1]) return { flap: tri[0]!, rev: false };
    if (tri[0] !== e[1]) return null;
    return { flap: tri[2]!, rev: true };
  }
  if (tri[2] !== e[0]) return null;
  if (tri[0] === e[1]) return { flap: tri[1]!, rev: false };
  if (tri[1] !== e[1]) return null;
  return { flap: tri[0]!, rev: true };
}

const EXTRA_TRI_INDEX = 2147483647;

/**
 * The machinery of `boolean_trimesh` over one triangle list. `triOf(t)` is
 * triangle `t` (or the dummy, for `EXTRA_TRI_INDEX`); `coOf(v)` a vertex.
 */
class Arrangement {
  readonly topo: Topology;
  readonly patches: Patch[] = [];
  readonly triPatch: number[];
  /** Patch pairs meeting along an edge, first found, in the order found. */
  readonly ppEdge = new Map<string, Edge>();
  readonly cells: Cell[] = [];
  private dummy: { tri: number[]; co: Q3 } | null = null;
  // Plain fields, not constructor parameter properties: the parity harness
  // runs this file through Node's type stripping, which cannot erase those.
  readonly tris: readonly (readonly number[])[];
  private readonly co: (v: number) => Q3;

  constructor(tris: readonly (readonly number[])[], co: (v: number) => Q3) {
    this.tris = tris;
    this.co = co;
    this.topo = new Topology(tris);
    this.triPatch = tris.map(() => -1);
  }

  coOf(v: number): Q3 {
    return v === -1 ? this.dummy!.co : this.co(v);
  }

  triOf(t: number): readonly number[] {
    return t === EXTRA_TRI_INDEX ? this.dummy!.tri : this.tris[t]!;
  }

  /** `find_patches`. */
  findPatches(): void {
    const tOthers = this.tris.map((tri, t) =>
      [0, 1, 2].map((i) => this.topo.otherTriIfManifold(mkEdge(tri[i]!, tri[(i + 1) % 3]!), t)),
    );
    for (let t = 0; t < this.tris.length; t++) {
      if (this.triPatch[t] !== -1) continue;
      const stack = [t];
      const cur = this.patches.length;
      this.patches.push({ tris: [], cellAbove: -1, cellBelow: -1, component: -1 });
      while (stack.length > 0) {
        const tc = stack.pop()!;
        if (this.triPatch[tc] !== -1) continue;
        this.triPatch[tc] = cur;
        this.patches[cur]!.tris.push(tc);
        const tri = this.tris[tc]!;
        for (let i = 0; i < 3; i++) {
          const e = mkEdge(tri[i]!, tri[(i + 1) % 3]!);
          const to = tOthers[tc]![i]!;
          if (to !== -1) {
            if (this.triPatch[to] === -1) stack.push(to);
            continue;
          }
          // Non-manifold: record the patch pairs we can.
          for (const other of this.topo.edgeTris.get(ekey(e)) ?? []) {
            if (other === tc || this.triPatch[other] === -1) continue;
            const po = this.triPatch[other]!;
            if (po === cur) continue;
            if (!this.ppEdge.has(`${cur},${po}`)) {
              this.ppEdge.set(`${cur},${po}`, e);
              this.ppEdge.set(`${po},${cur}`, e);
            }
          }
        }
      }
    }
  }

  /** `sort_tris_class`: 1 coplanar same side, 2 coplanar other side, 3 below, 4 above. */
  private sortTrisClass(tri: readonly number[], tri0: readonly number[], e: Edge): number {
    const f0 = findFlap(tri0, e)!;
    const f = findFlap(tri, e)!;
    // Blender's `orient3d` is Shewchuk's: positive when the point is *below*.
    const orient = -orient3dExact(this.coOf(tri0[0]!), this.coOf(tri0[1]!), this.coOf(tri0[2]!), this.coOf(f.flap));
    if (orient > 0) return f0.rev ? 4 : 3;
    if (orient < 0) return f0.rev ? 3 : 4;
    return f.flap === f0.flap ? 1 : 2;
  }

  private sortBySignedIndex(g: number[], e: Edge): void {
    const signed = g.map((t) => (findFlap(this.triOf(t), e)!.rev ? -t : t));
    signed.sort((a, b) => a - b);
    for (let i = 0; i < g.length; i++) g[i] = Math.abs(signed[i]!);
  }

  /** `sort_tris_around_edge`. */
  sortTrisAroundEdge(e: Edge, tris: readonly number[], t0: number): number[] {
    if (tris.length === 0) return [];
    const g: number[][] = [[tris[0]!], [], [], []];
    const triref = this.triOf(tris[0]!);
    for (let i = 1; i < tris.length; i++) g[this.sortTrisClass(this.triOf(tris[i]!), triref, e) - 1]!.push(tris[i]!);
    const [g1, g2, g3, g4] = g as [number[], number[], number[], number[]];
    if (g1.length > 1) this.sortBySignedIndex(g1, e);
    if (g2.length > 1) this.sortBySignedIndex(g2, e);
    const s3 = g3.length > 1 ? this.sortTrisAroundEdge(e, g3, t0) : g3;
    const s4 = g4.length > 1 ? this.sortTrisAroundEdge(e, g4, t0) : g4;
    return tris[0] === t0 ? [...g1, ...s4, ...g2, ...s3] : [...s3, ...g1, ...s4, ...g2];
  }

  private checkForZeroVolume(c: Cell): void {
    if (c.patches.size !== 2) return;
    const [p1, p2] = [...c.patches] as [number, number];
    const a = this.patches[p1]!;
    const b = this.patches[p2]!;
    if (a.tris.length === 1 && b.tris.length === 1) {
      const s = (t: number): string => [...this.tris[t]!].sort((x, y) => x - y).join(",");
      if (s(a.tris[0]!) === s(b.tris[0]!)) c.zeroVolume = true;
    }
  }

  private addCell(): number {
    this.cells.push(newCell());
    return this.cells.length - 1;
  }

  /**
   * `merge_cells`, **with Blender's aliasing kept**: when `mergeTo` was itself
   * merged away, `merge_to_cell = cinfo.cell(final)` copy-assigns through a
   * reference, so `mergeTo`'s slot becomes a copy of the final cell and
   * receives the patches — not the final cell.
   */
  mergeCells(mergeTo: number, mergeFrom: number): void {
    if (mergeTo === mergeFrom) return;
    const from = this.cells[mergeFrom]!;
    let final = mergeTo;
    while (this.cells[mergeTo]!.mergedTo !== -1) {
      final = this.cells[mergeTo]!.mergedTo;
      const src = this.cells[final]!;
      this.cells[mergeTo] = { ...src, patches: new Set(src.patches), winding: [...src.winding] };
    }
    const to = this.cells[mergeTo]!;
    for (const p of from.patches) {
      addPatch(to, p);
      const patch = this.patches[p]!;
      if (patch.cellAbove === mergeFrom) patch.cellAbove = mergeTo;
      if (patch.cellBelow === mergeFrom) patch.cellBelow = mergeTo;
    }
    from.mergedTo = final;
  }

  /** `find_cells_from_edge`. */
  private findCellsFromEdge(e: Edge): void {
    const edgeTris = this.topo.edgeTris.get(ekey(e))!;
    const sorted = this.sortTrisAroundEdge(e, edgeTris, edgeTris[0]!);
    const n = edgeTris.length;
    const edgePatches = sorted.map((t) => this.triPatch[t]!);
    for (let i = 0; i < n; i++) {
      const inext = (i + 1) % n;
      const ri = edgePatches[i]!;
      const rn = edgePatches[inext]!;
      const r = this.patches[ri]!;
      const rnext = this.patches[rn]!;
      const rFlipped = findFlap(this.tris[sorted[i]!]!, e)!.rev;
      const rnFlipped = findFlap(this.tris[sorted[inext]!]!, e)!.rev;
      const follow = rFlipped ? "cellBelow" : "cellAbove";
      const prev = rnFlipped ? "cellAbove" : "cellBelow";
      if (r[follow] === -1 && rnext[prev] === -1) {
        const c = this.addCell();
        r[follow] = c;
        rnext[prev] = c;
        const cell = this.cells[c]!;
        addPatch(cell, ri);
        addPatch(cell, rn);
        this.checkForZeroVolume(cell);
      } else if (r[follow] !== -1 && rnext[prev] === -1) {
        const c = r[follow];
        rnext[prev] = c;
        addPatch(this.cells[c]!, rn);
        this.checkForZeroVolume(this.cells[c]!);
      } else if (r[follow] === -1 && rnext[prev] !== -1) {
        const c = rnext[prev];
        r[follow] = c;
        addPatch(this.cells[c]!, ri);
        this.checkForZeroVolume(this.cells[c]!);
      } else if (r[follow] !== rnext[prev]) {
        // Blender merges only when the follow cell has at least as many
        // patches; the other way round it leaves both — kept as written.
        if (this.cells[r[follow]]!.patches.size >= this.cells[rnext[prev]]!.patches.size)
          this.mergeCells(r[follow], rnext[prev]);
      }
    }
  }

  /** `find_cells`. */
  findCells(): void {
    const processed = new Set<string>();
    for (const [pq, e] of this.ppEdge) {
      const [p, qq] = pq.split(",").map(Number) as [number, number];
      if (p < qq && !processed.has(ekey(e))) {
        processed.add(ekey(e));
        this.findCellsFromEdge(e);
      }
    }
    this.patches.forEach((patch, p) => {
      if (patch.cellAbove === -1) {
        patch.cellAbove = this.addCell();
        addPatch(this.cells[patch.cellAbove]!, p);
      }
      if (patch.cellBelow === -1) {
        patch.cellBelow = this.addCell();
        addPatch(this.cells[patch.cellBelow]!, p);
      }
    });
  }

  /** `find_patch_components`. */
  findPatchComponents(): number[][] {
    const cellDone = this.cells.map(() => false);
    const out: number[][] = [];
    this.patches.forEach((start, ps) => {
      if (start.component !== -1) return;
      const comp = out.length;
      out.push([ps]);
      start.component = comp;
      const stack = [ps];
      while (stack.length > 0) {
        const patch = this.patches[stack.pop()!]!;
        for (const c of [patch.cellAbove, patch.cellBelow]) {
          if (cellDone[c]) continue;
          cellDone[c] = true;
          for (const pn of this.cells[c]!.patches) {
            const nb = this.patches[pn]!;
            if (nb.component === -1) {
              nb.component = comp;
              stack.push(pn);
              out[comp]!.push(pn);
            }
          }
        }
      }
    });
    return out;
  }

  /** `patch_cell_graph_ok`. */
  graphOk(): boolean {
    for (const cell of this.cells) {
      if (cell.mergedTo !== -1) continue;
      if (cell.patches.size === 0) return false;
      for (const p of cell.patches) if (p >= this.patches.length) return false;
    }
    for (const p of this.patches) {
      if (p.cellAbove === -1 || p.cellBelow === -1) return false;
      if (p.cellAbove >= this.cells.length || p.cellBelow >= this.cells.length) return false;
    }
    return true;
  }

  /** `find_cell_for_point_near_edge`: sort a dummy triangle (e, p) in among e's triangles. */
  findCellForPointNearEdge(p: Q3, e: Edge): number {
    this.dummy = { tri: [e[0], e[1], -1], co: p };
    const edgeTris = [...this.topo.edgeTris.get(ekey(e))!, EXTRA_TRI_INDEX];
    const sorted = this.sortTrisAroundEdge(e, edgeTris, edgeTris[0]!);
    const i = sorted.indexOf(EXTRA_TRI_INDEX);
    const prevTri = i === 0 ? sorted[sorted.length - 1]! : sorted[i - 1]!;
    const prevPatch = this.patches[this.triPatch[prevTri]!]!;
    const flipped = findFlap(this.tris[prevTri]!, e)!.rev;
    this.dummy = null;
    return flipped ? prevPatch.cellBelow : prevPatch.cellAbove;
  }

  /** `find_ambient_cell`: past the vertex of largest x, along an edge on the hull. */
  findAmbientCell(componentPatches: readonly number[] | null): number {
    let vExtreme: number;
    const x = (v: number): Q => this.coOf(v)[0];
    if (componentPatches === null) {
      vExtreme = this.tris[0]![0]!;
      for (const tri of this.tris) for (const v of tri) if (cmp(x(v), x(vExtreme)) > 0) vExtreme = v;
    } else {
      vExtreme = this.tris[this.patches[componentPatches[0]!]!.tris[0]!]![0]!;
      for (const p of componentPatches)
        for (const t of this.patches[p]!.tris) for (const v of this.tris[t]!) if (cmp(x(v), x(vExtreme)) > 0) vExtreme = v;
    }
    const ex = this.coOf(vExtreme);
    let ehull: Edge | null = null;
    let maxSlope: Q | null = null;
    for (const e of this.topo.vertEdges.get(vExtreme) ?? []) {
      const o = this.coOf(e[0] === vExtreme ? e[1] : e[0]);
      const dx = sub(o[0], ex[0]);
      if (sign(dx) === 0) {
        ehull = e;
        break;
      }
      const s = absQ(div(sub(o[1], ex[1]), dx));
      if (maxSlope === null || cmp(s, maxSlope) > 0) {
        ehull = e;
        maxSlope = s;
      }
    }
    const pAmbient: Q3 = [add(ex[0], q(1n)), ex[1], ex[2]];
    return this.findCellForPointNearEdge(pAmbient, ehull!);
  }

  /** `find_good_sorting_edge`. */
  private findGoodSortingEdge(testCo: Q3, closestp: number): Edge {
    const cc = this.coOf(closestp);
    const abscissa = q3Sub(testCo, cc);
    let axis = 0;
    while (axis < 3 && sign(abscissa[axis]!) === 0) axis++;
    const an = (axis + 1) % 3;
    const ann = (an + 1) % 3;
    const ord: Q[] = [q(0n), q(0n), q(0n)];
    ord[axis] = abscissa[an]!;
    ord[an] = neg(abscissa[axis]!);
    ord[ann] = q(0n);
    const ordinate = ord as unknown as Q3;
    const normal = q3Cross(abscissa, ordinate);
    const nlen2 = q3Dot(normal, normal);
    let esort: Edge | null = null;
    let maxSlope: Q | null = null;
    for (const e of this.topo.vertEdges.get(closestp) ?? []) {
      const evec = q3Sub(this.coOf(e[0] === closestp ? e[1] : e[0]), cc);
      const k = div(q3Dot(evec, normal), nlen2);
      const proj: Q3 = [sub(evec[0], mul(k, normal[0])), sub(evec[1], mul(k, normal[1])), sub(evec[2], mul(k, normal[2]))];
      const a = q3Dot(proj, abscissa);
      const o = q3Dot(proj, ordinate);
      if (sign(a) === 0) {
        esort = e;
        break;
      }
      const s = absQ(div(o, a));
      if (maxSlope === null || cmp(s, maxSlope) > 0) {
        esort = e;
        maxSlope = s;
      }
    }
    return esort!;
  }

  /** `find_containing_cell`. */
  private findContainingCell(v: number, t: number, closeEdge: number, closeVert: number): number {
    const tri = this.tris[t]!;
    let etest: Edge | null = null;
    if (closeEdge === -1 && closeVert === -1) closeEdge = 0;
    if (closeEdge !== -1) {
      const v0 = tri[closeEdge]!;
      const v1 = tri[(closeEdge + 1) % 3]!;
      etest =
        (this.topo.vertEdges.get(v0) ?? []).find(
          (e) => (e[0] === v0 && e[1] === v1) || (e[0] === v1 && e[1] === v0),
        ) ?? null;
    } else {
      let vcv = tri[closeVert]!;
      if (vcv === v) vcv = tri[(closeVert + 1) % 3]!;
      etest = this.findGoodSortingEdge(this.coOf(v), vcv);
    }
    return this.findCellForPointNearEdge(this.coOf(v), etest!);
  }

  /** `finish_patch_cell_graph`: connect components by their nesting. */
  finishPatchCellGraph(): void {
    const components = this.findPatchComponents();
    if (components.length <= 1) return;
    const ambient = components.map((c) => this.findAmbientCell(c));
    // Bounding boxes per component, padded as Blender pads them.
    const bb = components.map(() => ({ lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] }));
    let maxAbs = 0;
    components.forEach((comp, c) => {
      for (const p of comp)
        for (const t of this.patches[p]!.tris)
          for (const v of this.tris[t]!) {
            const co = this.coOf(v).map(toNumber);
            for (let k = 0; k < 3; k++) {
              bb[c]!.lo[k] = Math.min(bb[c]!.lo[k]!, co[k]!);
              bb[c]!.hi[k] = Math.max(bb[c]!.hi[k]!, co[k]!);
              maxAbs = Math.max(maxAbs, Math.abs(co[k]!));
            }
          }
    });
    const FLT_EPSILON = 1.1920928955078125e-7;
    const pad = (maxAbs === 0 ? FLT_EPSILON : 2 * FLT_EPSILON * maxAbs) * 10;
    const overlap = (a: number, b: number): boolean =>
      [0, 1, 2].every((k) => bb[a]!.lo[k]! - pad <= bb[b]!.hi[k]! + pad && bb[b]!.lo[k]! - pad <= bb[a]!.hi[k]! + pad);

    // `find_component_containers`.
    const containers = components.map((comp, c) => {
      const out: { cell: number; d2: Q }[] = [];
      const testV = this.tris[this.patches[comp[0]!]!.tris[0]!]![0]!;
      const testCo = this.coOf(testV);
      components.forEach((other, co) => {
        if (co === c || !overlap(c, co)) return;
        let nearest = -1;
        let nearestD2: Q | null = null;
        let nEdge = -1;
        let nVert = -1;
        for (const p of other)
          for (const t of this.patches[p]!.tris) {
            const [a, b, cc] = this.tris[t]!.map((v) => this.coOf(v)) as [Q3, Q3, Q3];
            const r = closestOnTriToPoint(testCo, a, b, cc);
            if (nearest === -1 || cmp(r.d2, nearestD2!) < 0) {
              nearest = t;
              nearestD2 = r.d2;
              nEdge = r.edge;
              nVert = r.vert;
            }
          }
        const cell = this.findContainingCell(testV, nearest, nEdge, nVert);
        if (cell !== ambient[co]) out.push({ cell, d2: nearestD2! });
      });
      return out;
    });
    const outer: number[] = [];
    containers.forEach((list, c) => {
      if (list.length === 0) {
        outer.push(c);
        return;
      }
      let closest = list[0]!;
      for (const x of list) if (cmp(x.d2, closest.d2) < 0) closest = x;
      this.mergeCells(closest.cell, ambient[c]!);
    });
    for (let i = 1; i < outer.length; i++) this.mergeCells(ambient[outer[0]!]!, ambient[outer[i]!]!);
  }

  /** `propagate_windings_and_in_output_volume`. */
  propagateWindings(cAmbient: number, op: BooleanOperation, nshapes: number, shapeOf: (t: number) => number): void {
    for (const c of this.cells) c.winding = new Array<number>(nshapes).fill(0);
    const amb = this.cells[cAmbient]!;
    amb.winding.fill(0);
    amb.windingAssigned = true;
    const queue = [cAmbient];
    for (let head = 0; head < queue.length; head++) {
      const c = queue[head]!;
      const cell = this.cells[c]!;
      for (const p of cell.patches) {
        const patch = this.patches[p]!;
        const pAboveC = patch.cellBelow === c;
        const cn = pAboveC ? patch.cellAbove : patch.cellBelow;
        const nb = this.cells[cn]!;
        if (nb.windingAssigned) continue;
        nb.winding = [...cell.winding];
        const shape = shapeOf(patch.tris[0]!);
        if (shape >= 0) nb.winding[shape]! += pAboveC ? -1 : 1;
        nb.windingAssigned = true;
        nb.inOutput = applyBoolOp(op, nb.winding);
        queue.push(cn);
      }
    }
  }

  /** `extract_from_in_output_volume_diffs` (+ `extract_zero_volume_cell_tris`). */
  extract(): { t: number; flip: boolean }[] {
    const out: { t: number; flip: boolean }[] = [];
    let anyZero = false;
    this.tris.forEach((_, t) => {
      const patch = this.patches[this.triPatch[t]!]!;
      const above = this.cells[patch.cellAbove]!;
      const below = this.cells[patch.cellBelow]!;
      const adjZero = above.zeroVolume || below.zeroVolume;
      anyZero ||= adjZero;
      if (above.inOutput !== below.inOutput && !adjZero) out.push({ t, flip: above.inOutput });
    });
    if (!anyZero) return out;

    const adj = this.patches.map((p) => this.cells[p.cellAbove]!.zeroVolume || this.cells[p.cellBelow]!.zeroVolume);
    const allocated = this.patches.map(() => false);
    this.patches.forEach((_, p) => {
      if (!adj[p] || allocated[p]) return;
      const stack = [p];
      const flipped = [false];
      allocated[p] = true;
      const walk = (dir: "above" | "below"): Cell => {
        let pw = p;
        let c = dir === "above" ? this.patches[pw]!.cellAbove : this.patches[pw]!.cellBelow;
        let cell = this.cells[c]!;
        while (cell.zeroVolume) {
          const pother = [...cell.patches].find((x) => x !== pw)!;
          const po = this.patches[pother]!;
          const flip = dir === "above" ? po.cellAbove === c : po.cellBelow === c;
          flipped.push(flip);
          stack.push(pother);
          allocated[pother] = true;
          pw = pother;
          c = dir === "above" ? (flip ? po.cellBelow : po.cellAbove) : flip ? po.cellAbove : po.cellBelow;
          cell = this.cells[c]!;
        }
        return cell;
      };
      const aboveCell = walk("above");
      const belowCell = walk("below");
      if (aboveCell.inOutput !== belowCell.inOutput) {
        const needFlipped = aboveCell.inOutput;
        const i = flipped.findIndex((f) => f === needFlipped);
        if (i >= 0) out.push({ t: this.patches[stack[i]!]!.tris[0]!, flip: false });
        else out.push({ t: this.patches[p]!.tris[0]!, flip: true });
      }
    });
    return out;
  }
}

/** `apply_bool_op`. */
function applyBoolOp(op: BooleanOperation, w: readonly number[]): boolean {
  switch (op) {
    case "intersect":
      return w.every((x) => x !== 0);
    case "union":
      return w.some((x) => x !== 0);
    case "difference":
      if (w[0] === 0) return false;
      return w.slice(1).every((x) => x < 1);
  }
}

const absQ = (x: Q): Q => (sign(x) < 0 ? neg(x) : x);
const toNumber = (x: Q): number => Number(x.n) / Number(x.d);

/** `closest_on_tri_to_point`, exact: squared distance, and the vertex or edge it lands on. */
function closestOnTriToPoint(p: Q3, a: Q3, b: Q3, c: Q3): { d2: Q; edge: number; vert: number } {
  const d2of = (r: Q3): Q => {
    const d = q3Sub(p, r);
    return q3Dot(d, d);
  };
  const lerp = (o: Q3, dir: Q3, t: Q): Q3 => [add(o[0], mul(dir[0], t)), add(o[1], mul(dir[1], t)), add(o[2], mul(dir[2], t))];
  const ab = q3Sub(b, a);
  const ac = q3Sub(c, a);
  const ap = q3Sub(p, a);
  const d1 = q3Dot(ab, ap);
  const d2 = q3Dot(ac, ap);
  if (sign(d1) <= 0 && sign(d2) <= 0) return { d2: d2of(a), edge: -1, vert: 0 };
  const bp = q3Sub(p, b);
  const d3 = q3Dot(ab, bp);
  const d4 = q3Dot(ac, bp);
  if (sign(d3) >= 0 && cmp(d4, d3) <= 0) return { d2: d2of(b), edge: -1, vert: 1 };
  const vc = sub(mul(d1, d4), mul(d3, d2));
  if (sign(vc) <= 0 && sign(d1) >= 0 && sign(d3) <= 0)
    return { d2: d2of(lerp(a, ab, div(d1, sub(d1, d3)))), edge: 0, vert: -1 };
  const cp = q3Sub(p, c);
  const d5 = q3Dot(ab, cp);
  const d6 = q3Dot(ac, cp);
  if (sign(d6) >= 0 && cmp(d5, d6) <= 0) return { d2: d2of(c), edge: -1, vert: 2 };
  const vb = sub(mul(d5, d2), mul(d1, d6));
  if (sign(vb) <= 0 && sign(d2) >= 0 && sign(d6) <= 0)
    return { d2: d2of(lerp(a, ac, div(d2, sub(d2, d6)))), edge: 2, vert: -1 };
  const va = sub(mul(d3, d6), mul(d5, d4));
  const d43 = sub(d4, d3);
  const d56 = sub(d5, d6);
  if (sign(va) <= 0 && sign(d43) >= 0 && sign(d56) >= 0)
    return { d2: d2of(lerp(b, q3Sub(c, b), div(d43, add(d43, d56)))), edge: 1, vert: -1 };
  const denom = div(q(1n), add(add(va, vb), vc));
  const r = lerp(lerp(a, ab, mul(vb, denom)), ac, mul(vc, denom));
  return { d2: d2of(r), edge: -1, vert: -1 };
}

/**
 * `boolean_trimesh` after the intersection: the triangles to keep, in
 * Blender's order, flipped where they must face out of the result.
 */
function booleanTrimesh(
  pieces: Piece[],
  coOf: (v: number) => Q3,
  coD: (v: number) => readonly number[],
  op: BooleanOperation,
  nshapes: number,
  shapeOf: (t: number) => number,
  holeTolerant: boolean,
): Piece[] {
  const tris = pieces.map((p) => p.ids);
  if (tris.length === 0) return [];
  const arr = new Arrangement(tris, coOf);
  const flipPiece = (p: Piece): Piece => ({
    face: p.face,
    ids: [p.ids[0]!, p.ids[2]!, p.ids[1]!],
    kinds: [p.kinds[2]!, p.kinds[1]!, p.kinds[0]!],
  });
  if (!isPwn(tris, arr.topo)) {
    const rc = new Raycaster(tris, coD, shapeOf, nshapes);
    const out: Piece[] = [];
    const decide = (t: number, members: readonly number[]): void => {
      const shape = shapeOf(t);
      const inShape = rc.insideShapes(t);
      const winding = new Array<number>(nshapes).fill(0);
      const high = (op === "difference" && shape !== 0) || op === "intersect";
      for (let o = 0; o < nshapes; o++) if (o !== shape) winding[o] = inShape[o]! >= (high ? 0.5 : 0.1) ? 1 : 0;
      // `raycast_test_remove`
      winding[shape] = 0;
      const iv0 = applyBoolOp(op, winding);
      winding[shape] = 1;
      const iv1 = applyBoolOp(op, winding);
      if (iv0 === iv1) return;
      const flip = op === "difference" && shape !== 0;
      for (const m of members) out.push(flip ? flipPiece(pieces[m]!) : pieces[m]!);
    };
    if (holeTolerant) tris.forEach((_, t) => decide(t, [t]));
    else {
      arr.findPatches();
      // "choose one in the middle of patch list"
      for (const patch of arr.patches) decide(patch.tris[patch.tris.length >> 1]!, patch.tris);
    }
    return out;
  }
  arr.findPatches();
  arr.findCells();
  arr.finishPatchCellGraph();
  if (!arr.graphOk()) throw new Error("booleanMesh: the patch/cell graph is disconnected");
  const cAmbient = arr.findAmbientCell(null);
  arr.propagateWindings(cAmbient, op, nshapes, shapeOf);
  // A flipped piece is `{tri[0], tri[2], tri[1]}` with edges `{e[2], e[1], e[0]}`.
  return arr.extract().map(({ t, flip }) => (flip ? flipPiece(pieces[t]!) : pieces[t]!));
}

const fl = Math.fround;
const FLT_EPSILON = 1.1920928955078125e-7;

/** `isect_ray_tri_epsilon_v3`, in float. */
function isectRayTriEpsilon(o: number[], d: number[], v0: number[], v1: number[], v2: number[], eps: number): boolean {
  const subv = (a: number[], b: number[]): number[] => [fl(a[0]! - b[0]!), fl(a[1]! - b[1]!), fl(a[2]! - b[2]!)];
  const cross = (a: number[], b: number[]): number[] => [
    fl(fl(a[1]! * b[2]!) - fl(a[2]! * b[1]!)),
    fl(fl(a[2]! * b[0]!) - fl(a[0]! * b[2]!)),
    fl(fl(a[0]! * b[1]!) - fl(a[1]! * b[0]!)),
  ];
  const dot = (a: number[], b: number[]): number => fl(fl(fl(a[0]! * b[0]!) + fl(a[1]! * b[1]!)) + fl(a[2]! * b[2]!));
  const e1 = subv(v1, v0);
  const e2 = subv(v2, v0);
  const p = cross(d, e2);
  const a = dot(e1, p);
  if (a === 0) return false;
  const f = fl(1 / a);
  const s = subv(o, v0);
  const u = fl(f * dot(s, p));
  if (u < -eps || u > fl(1 + eps)) return false;
  const q = cross(s, e1);
  const v = fl(f * dot(d, q));
  if (v < -eps || fl(u + v) > fl(1 + eps)) return false;
  const lambda = fl(f * dot(e2, q));
  return lambda >= 0;
}

/** `test_tri_inside_shapes`, over every triangle (Blender prunes with a BVH). */
class Raycaster {
  private readonly ftris: number[][][];
  // Plain fields, not parameter properties: Node's type stripping (the
  // parity harness) cannot erase those.
  private readonly tris: readonly (readonly number[])[];
  private readonly coD: (v: number) => readonly number[];
  private readonly shapeOf: (t: number) => number;
  private readonly nshapes: number;

  constructor(
    tris: readonly (readonly number[])[],
    coD: (v: number) => readonly number[],
    shapeOf: (t: number) => number,
    nshapes: number,
  ) {
    this.tris = tris;
    this.coD = coD;
    this.shapeOf = shapeOf;
    this.nshapes = nshapes;
    this.ftris = tris.map((t) => t.map((v) => coD(v).map(fl)));
  }

  /** For each shape, the fraction of the six rays that say the triangle is inside it. */
  insideShapes(t: number): number[] {
    const shape = this.shapeOf(t);
    const [a, b, c] = this.tris[t]!.map((v) => this.coD(v)) as [readonly number[], readonly number[], readonly number[]];
    const test = [0, 1, 2].map((k) => a[k]! / 3 + b[k]! / 3 + c[k]! / 3);
    // `populate_plane(false)`: (v0 − v2) × (v1 − v2), then normalised.
    const u = [0, 1, 2].map((k) => a[k]! - c[k]!);
    const w = [0, 1, 2].map((k) => b[k]! - c[k]!);
    let n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
    const len = Math.sqrt(n[0]! * n[0]! + n[1]! * n[1]! + n[2]! * n[2]!);
    if (len > 0) n = n.map((x) => x / len);
    const co = [0, 1, 2].map((k) => fl(test[k]! + 1e-5 * n[k]!));
    const r1 = fl(0.9987025295199663);
    const ra = fl(0.04993512647599832);
    const rb = fl(0.009987025295199663);
    const rays = [[r1, ra, rb], [-r1, -ra, -rb], [rb, r1, ra], [-rb, -r1, -ra], [ra, rb, r1], [-ra, -rb, -r1]];
    const origin: Q3 = [fromNum(co[0]!), fromNum(co[1]!), fromNum(co[2]!)];
    const countInsides = new Array<number>(this.nshapes).fill(0);
    for (const dir of rays) {
      const parity = new Array<number>(this.nshapes).fill(0);
      this.tris.forEach((tri, i) => {
        const sh = this.shapeOf(i);
        const [f0, f1, f2] = this.ftris[i]!;
        if (!isectRayTriEpsilon(co, dir, f0!, f1!, f2!, FLT_EPSILON)) return;
        // `orient3d` on the doubles — Shewchuk's sign, positive below the plane.
        const [p0, p1, p2] = tri.map((v) => this.coD(v).map(fromNum) as unknown as Q3);
        parity[sh]! += -orient3dExact(p0!, p1!, p2!, origin);
      });
      for (let j = 0; j < this.nshapes; j++) if (j !== shape && parity[j]! > 0) countInsides[j]!++;
    }
    return countInsides.map((c, j) => (j === shape ? 1 : fl(c / 6)));
  }
}

/** A double as an exact rational. */
function fromNum(x: number): Q {
  return fromDouble(x);
}

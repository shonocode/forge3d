/**
 * Per-face-corner data — UVs and vertex colours — and the operators that
 * permute it.
 *
 * A "loop" in Blender is one corner of one face: a quad has four. Storing a UV
 * per loop rather than per vertex is what makes a seam possible at all, since
 * two faces meeting at an edge can then disagree about the UV along it.
 * `MeshData` had no such place, which blocked eight `bmesh.ops` together and
 * kept the compatibility matrix at 60/80.
 *
 * **They were not one problem.** Measured, four of the eight are a permutation
 * of each face's own loop list and need nothing but somewhere to put the
 * values; the other four move data between faces and are a different job. This
 * file is the four.
 *
 * Pure and headless. These take and return {@link MeshData}.
 *
 * ## The layer, and why it is shaped like this
 *
 * `uvs[f][i]` is the UV at corner `i` of polygon `f` — the same nesting as
 * `polys`, so a corner and its coordinate are always found the same way and
 * an operator that rebuilds `polys` cannot silently leave the layer behind
 * pointing at the old arity. Colours are `[r, g, b, a]` in the same shape.
 */
import type { MeshData } from "../../lib/mesh";

/** Which layer an operator works on. Blender has a separate op per layer. */
export type LoopLayer = "uv" | "color";

function layerOf(data: MeshData, layer: LoopLayer): number[][][] | undefined {
  return layer === "uv" ? data.uvs : data.colors;
}

function withLayer(data: MeshData, layer: LoopLayer, value: number[][][]): MeshData {
  const base: MeshData = {
    positions: new Float32Array(data.positions),
    polys: data.polys.map((p) => [...p]),
    ...(data.creases ? { creases: new Map(data.creases) } : {}),
    ...(data.seams ? { seams: new Set(data.seams) } : {}),
    ...(data.edges ? { edges: data.edges.map((e) => [...e]) } : {}),
    ...(data.uvs ? { uvs: data.uvs.map((f) => f.map((c) => [...c])) } : {}),
    ...(data.colors ? { colors: data.colors.map((f) => f.map((c) => [...c])) } : {}),
    ...(data.normals ? { normals: data.normals.map((f) => f.map((c) => [...c])) } : {}),
    ...(data.sharp ? { sharp: new Set(data.sharp) } : {}),
    ...(data.groups ? { groups: new Map([...data.groups].map(([k, g]) => [k, new Map(g)])) } : {}),
    ...(data.materials ? { materials: [...data.materials] } : {}),
  };
  if (layer === "uv") base.uvs = value;
  else base.colors = value;
  return base;
}

function requireLayer(data: MeshData, layer: LoopLayer, who: string): number[][][] {
  const found = layerOf(data, layer);
  if (found === undefined)
    throw new Error(`${who}: this mesh has no ${layer} layer — there is nothing to move.`);
  if (found.length !== data.polys.length)
    throw new Error(
      `${who}: the ${layer} layer has ${found.length} entries for ` +
        `${data.polys.length} polygons. One per polygon, each as long as its ` +
        `polygon.`,
    );
  for (let f = 0; f < data.polys.length; f++)
    if (found[f]!.length !== data.polys[f]!.length)
      throw new Error(
        `${who}: polygon ${f} has ${data.polys[f]!.length} corners but its ` +
          `${layer} entry has ${found[f]!.length}.`,
      );
  return found;
}

/**
 * Reverse each chosen face's loop data — Blender's `reverse_uvs` and
 * `reverse_colors`.
 *
 * The cheap fix for a face whose texture reads mirrored: its corners keep
 * their positions and their coordinates run the other way round.
 *
 * Measured on a quad whose corners carried 0.0, 0.1, 0.2, 0.3 — they come back
 * 0.3, 0.2, 0.1, 0.0, and a face that was not chosen is untouched. The colour
 * operator does the same thing to the colour layer and leaves the UVs alone;
 * that symmetry was checked rather than assumed.
 */
export function reverseLoopData(
  data: MeshData,
  faces: ReadonlySet<number> | readonly number[],
  layer: LoopLayer = "uv",
): MeshData {
  const chosen = new Set(faces);
  const current = requireLayer(data, layer, "reverseLoopData");
  const next = current.map((corners, f) =>
    chosen.has(f) ? [...corners].reverse().map((c) => [...c]) : corners.map((c) => [...c]),
  );
  return withLayer(data, layer, next);
}

/**
 * Rotate each chosen face's loop data by one corner — Blender's `rotate_uvs`
 * and `rotate_colors`.
 *
 * What you reach for when a tiled texture is a quarter-turn out on one face.
 *
 * `ccw` is Blender's `use_ccw` and it is the **direction the data moves**, not
 * the direction it comes from. Measured on 0.0, 0.1, 0.2, 0.3:
 *
 * | | result |
 * |---|---|
 * | `ccw: false` (the default) | 0.3, 0.0, 0.1, 0.2 — each corner takes its predecessor's |
 * | `ccw: true` | 0.1, 0.2, 0.3, 0.0 — each corner takes its successor's |
 *
 * Confirmed on a triangle as well, in case four corners were hiding a
 * symmetry: 0.0, 0.1, 0.2 goes to 0.2, 0.0, 0.1 and to 0.1, 0.2, 0.0.
 */
export function rotateLoopData(
  data: MeshData,
  faces: ReadonlySet<number> | readonly number[],
  opts: { ccw?: boolean; layer?: LoopLayer } = {},
): MeshData {
  const ccw = opts.ccw ?? false;
  const layer = opts.layer ?? "uv";
  const chosen = new Set(faces);
  const current = requireLayer(data, layer, "rotateLoopData");

  const next = current.map((corners, f) => {
    if (!chosen.has(f) || corners.length < 2) return corners.map((c) => [...c]);
    const n = corners.length;
    return corners.map((_, i) => [...corners[ccw ? (i + 1) % n : (i + n - 1) % n]!]);
  });
  return withLayer(data, layer, next);
}

/** Every (face, corner) that sits on vertex `v`. */
function cornersAt(data: MeshData, v: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let f = 0; f < data.polys.length; f++) {
    const poly = data.polys[f]!;
    for (let i = 0; i < poly.length; i++) if (poly[i] === v) out.push([f, i]);
  }
  return out;
}

/** Component-wise mean of some corner values. */
function meanOf(values: readonly (readonly number[])[]): number[] {
  const width = values[0]!.length;
  const out = new Array<number>(width).fill(0);
  for (const value of values) for (let k = 0; k < width; k++) out[k]! += value[k]!;
  return out.map((x) => x / values.length);
}

/** Component-wise midpoint of the range — **not** the mean. */
function midpointOf(values: readonly (readonly number[])[]): number[] {
  const width = values[0]!.length;
  const lo = [...values[0]!];
  const hi = [...values[0]!];
  for (const value of values)
    for (let k = 0; k < width; k++) {
      if (value[k]! < lo[k]!) lo[k] = value[k]!;
      if (value[k]! > hi[k]!) hi[k] = value[k]!;
    }
  return lo.map((x, k) => (x + hi[k]!) / 2);
}

/**
 * Flatten the seam along an edge — Blender's `collapse_uvs`.
 *
 * Within **each face** using the edge, its two corners on that edge are set to
 * their mean. The two faces are not brought together: a seam across the edge
 * survives, and what goes is the variation *along* it.
 *
 * Measured on a 2×2 grid of quads. For the shared edge 1-4, the face holding
 * 0.10 and 0.20 there comes back holding 0.15 twice, and the face holding
 * 1.00 and 1.30 comes back holding 1.15 twice — each face averaged its own
 * pair, and neither took anything from the other.
 *
 * `edges` are vertex pairs; order within a pair does not matter.
 */
export function collapseLoopData(
  data: MeshData,
  edges: readonly (readonly number[])[],
  layer: LoopLayer = "uv",
): MeshData {
  const current = requireLayer(data, layer, "collapseLoopData");
  const next = current.map((corners) => corners.map((c) => [...c]));

  for (const edge of edges) {
    const [a, b] = edge as [number, number];
    for (let f = 0; f < data.polys.length; f++) {
      const poly = data.polys[f]!;
      const ia = poly.indexOf(a);
      const ib = poly.indexOf(b);
      if (ia < 0 || ib < 0) continue;
      // Only when they really are neighbours around this face, or a diagonal
      // would count as an edge of it.
      const n = poly.length;
      if ((ia + 1) % n !== ib && (ib + 1) % n !== ia) continue;
      const mid = meanOf([next[f]![ia]!, next[f]![ib]!]);
      next[f]![ia] = [...mid];
      next[f]![ib] = [...mid];
    }
  }
  return withLayer(data, layer, next);
}

/**
 * Give every corner at the chosen vertices one value, taken from `snap` —
 * Blender's `pointmerge_facedata`.
 *
 * The value is the **mean** of the corners at `snap` alone, and it is written
 * to every corner at every vertex in `verts`. What the other vertices held
 * does not enter the average; they are written over.
 *
 * Measured: on a 2×2 grid, snapping vertices 1 and 4 to vertex 4 gives every
 * one of those six corners 1.65, which is the mean of vertex 4's own four
 * (0.20, 1.30, 2.10, 3.00) and not of all six. Confirmed per component on a
 * set whose mean and midpoint differ in both: (0,1) (1,8) (2,9) (9,10) gives
 * (3, 7), the mean.
 */
export function pointmergeLoopData(
  data: MeshData,
  verts: ReadonlySet<number> | readonly number[],
  snap: number,
  layer: LoopLayer = "uv",
): MeshData {
  const current = requireLayer(data, layer, "pointmergeLoopData");
  const next = current.map((corners) => corners.map((c) => [...c]));

  const source = cornersAt(data, snap);
  if (source.length === 0)
    throw new Error(`pointmergeLoopData: vertex ${snap} is on no polygon, so it has no value to give.`);
  const value = meanOf(source.map(([f, i]) => current[f]![i]!));

  for (const v of new Set(verts))
    for (const [f, i] of cornersAt(data, v)) next[f]![i] = [...value];
  return withLayer(data, layer, next);
}

/**
 * Flatten the corners at the chosen vertices to one value — Blender's
 * `average_vert_facedata`.
 *
 * **It is the midpoint of the range, not the mean**, and that is measured
 * rather than read: four corners holding 0.20, 1.30, 2.10 and 3.00 come back
 * holding **1.60**, where the mean is 1.65. Three earlier probes failed to
 * explain a 0.700 and a 0.650 by trying to read it as some average; both are
 * midpoints.
 *
 * It is also **one value for the whole selection**, not one per vertex: given
 * two vertices whose own midpoints are 0.55 and 1.60, every corner at both
 * comes back 1.55, the midpoint across all of them together.
 *
 * Per component, confirmed on a set where mean and midpoint differ in both:
 * (0,1) (1,8) (2,9) (9,10) gives (4.5, 5.5).
 *
 * The difference from {@link pointmergeLoopData}, which is a mean, is the kind
 * of asymmetry worth not assuming away — the two were measured separately on
 * the same arrangement and answered differently.
 */
export function averageVertLoopData(
  data: MeshData,
  verts: ReadonlySet<number> | readonly number[],
  layer: LoopLayer = "uv",
): MeshData {
  const current = requireLayer(data, layer, "averageVertLoopData");
  const next = current.map((corners) => corners.map((c) => [...c]));

  const touched: Array<[number, number]> = [];
  for (const v of new Set(verts)) touched.push(...cornersAt(data, v));
  if (touched.length === 0) return withLayer(data, layer, next);

  const value = midpointOf(touched.map(([f, i]) => current[f]![i]!));
  for (const [f, i] of touched) next[f]![i] = [...value];
  return withLayer(data, layer, next);
}

/**
 * Copy corner data onto the chosen faces from the ones around them — Blender's
 * `face_attribute_fill`.
 *
 * What it is for: a face that has no UVs yet, sitting against faces that do.
 * Filling it makes it agree with its neighbours along the edges they share,
 * rather than leaving a hole in the layer.
 *
 * ## The rule, ported from `bmo_fill_attribute.cc`
 *
 * **A flood fill in waves.** The first wave is every chosen face with an edge
 * against a face that was not chosen. As a face is filled it becomes a source,
 * and the chosen faces across its other edges make up the next wave — so a
 * block of chosen faces fills inward from its rim, and a face deep inside it
 * takes from a face that was filled a moment before, not from the original
 * neighbours. Chosen faces with no path to an unchosen one are left alone.
 *
 * **Within a face** (`BM_face_copy_shared`), the edges are walked from the
 * face's first corner. Edge `i` runs from corner `i` to corner `i + 1` and
 * writes both, from the face across it, if that face is already a source;
 * **the first write to a corner wins.** So corner `i` takes the edge coming
 * *into* it — except corner 0, which the first edge reaches before the last
 * one does, and so takes the edge going *out*.
 *
 * That is the "rule that did not come out" of seven measured arrangements
 * before this was read: filling each quad of a 2×2 grid, three took the edge
 * into their centre corner and the one whose centre corner is its first took
 * the edge out of it. Not the face index, not geometry — the corner walk.
 *
 * **Which face is "across"** is Blender's `radial_next`: on an edge with more
 * than two faces, the next face using it in index order, wrapping round
 * (`bmesh_radial_loop_append` builds the cycle in creation order). Within a
 * wave the pending corners come off a **stack**, last pushed first — that
 * order decides which chosen face fills first, and so what the next one can
 * take from.
 *
 * Not ported: `use_normals` (copying the neighbour's winding). This copies
 * the one corner layer; {@link faceAttributeFillAll} does every layer and the
 * material.
 */
export function faceAttributeFill(
  data: MeshData,
  faces: ReadonlySet<number> | readonly number[],
  layer: LoopLayer = "uv",
): MeshData {
  const current = requireLayer(data, layer, "faceAttributeFill");
  const plan = faceAttributeFillPlan(data.polys, faces);
  return withLayer(data, layer, applyFillPlan(current, plan));
}

/**
 * {@link faceAttributeFill} over **every** corner layer at once — UVs,
 * colours, custom normals — and the face's material from the face it filled
 * from, which is what Blender's `face_attribute_fill(use_data=True)` does
 * (`BM_elem_attrs_copy` of the face, `BM_face_copy_shared` of the loops).
 * `holes_fill` and `edgenet_fill` call it on the faces they make.
 */
export function faceAttributeFillAll(
  data: MeshData,
  faces: ReadonlySet<number> | readonly number[],
): MeshData {
  const plan = faceAttributeFillPlan(data.polys, faces);
  const out: MeshData = { ...data };
  const shaped = (l?: number[][][]) => l && l.length === data.polys.length;
  if (shaped(data.uvs)) out.uvs = applyFillPlan(data.uvs!, plan);
  if (shaped(data.colors)) out.colors = applyFillPlan(data.colors!, plan);
  if (shaped(data.normals)) out.normals = applyFillPlan(data.normals!, plan);
  if (data.materials && data.materials.length === data.polys.length) {
    const m = [...data.materials];
    // In fill order, so a face filled from a face filled a moment before
    // takes that face's new slot.
    for (const [g, from] of plan.faceFrom) m[g] = m[from]!;
    out.materials = m;
  }
  return out;
}

/**
 * The fill as a plan: for each filled corner, the corner it copied (in fill
 * order, so a later copy can read an earlier one), and for each filled face
 * the face it took its attributes from.
 */
interface FillPlan {
  corners: Array<[face: number, corner: number, fromFace: number, fromCorner: number]>;
  faceFrom: Array<[face: number, from: number]>;
}

function applyFillPlan(layer: number[][][], plan: FillPlan): number[][][] {
  const next = layer.map((corners) => corners.map((c) => [...c]));
  for (const [f, i, g, j] of plan.corners) next[f]![i] = [...next[g]![j]!];
  return next;
}

/** `bmesh_face_attribute_fill`, recording what it copies rather than copying. */
function faceAttributeFillPlan(
  polys: readonly (readonly number[])[],
  faces: ReadonlySet<number> | readonly number[],
): FillPlan {
  // Blender's BM_ELEM_TAG: still waiting to be filled.
  const tagged = new Set<number>();
  for (const f of faces) {
    if (polys[f] === undefined) throw new Error(`faceAttributeFill: no face ${f}`);
    tagged.add(f);
  }
  const plan: FillPlan = { corners: [], faceFrom: [] };

  type Loop = readonly [face: number, corner: number];
  const key = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const edgeKey = (f: number, i: number): string => {
    const poly = polys[f]!;
    return key(poly[i]!, poly[(i + 1) % poly.length]!);
  };

  // The radial cycle of each edge, in creation order — which is face order,
  // then corner order (`bmesh_radial_loop_append`).
  const radial = new Map<string, Loop[]>();
  for (let f = 0; f < polys.length; f++)
    for (let i = 0; i < polys[f]!.length; i++) {
      const k = edgeKey(f, i);
      const cycle = radial.get(k);
      if (cycle) cycle.push([f, i]);
      else radial.set(k, [[f, i]]);
    }
  /** The other loops on this loop's edge, starting at `radial_next`. */
  const othersAround = (f: number, i: number): Loop[] => {
    const cycle = radial.get(edgeKey(f, i))!;
    const at = cycle.findIndex(([g, j]) => g === f && j === i);
    const out: Loop[] = [];
    for (let s = 1; s < cycle.length; s++) out.push(cycle[(at + s) % cycle.length]!);
    return out;
  };

  // `BM_face_copy_shared` with the "source is not tagged" filter.
  const copyShared = (f: number): void => {
    const poly = polys[f]!;
    const n = poly.length;
    const written = new Array<boolean>(n).fill(false);
    for (let i = 0; i < n; i++) {
      const other = othersAround(f, i)[0];
      if (!other) continue; // boundary: radial_next is the loop itself
      const [g, j] = other;
      if (tagged.has(g)) continue;
      const gn = polys[g]!.length;
      // Match the two corners by vertex: the neighbour runs the edge the same
      // way or the other way round.
      const src =
        polys[g]![j] === poly[i] ? [j, (j + 1) % gn] : [(j + 1) % gn, j];
      const dst = [i, (i + 1) % n];
      for (let k = 0; k < 2; k++) {
        if (written[dst[k]!]) continue;
        plan.corners.push([f, dst[k]!, g, src[k]!]);
        written[dst[k]!] = true;
      }
    }
  };

  // `bmesh_face_attribute_fill`. The first wave: every corner of a tagged face
  // whose edge has an untagged face on it, in face and corner order.
  let prev: Loop[] = [];
  for (let f = 0; f < polys.length; f++) {
    if (!tagged.has(f)) continue;
    for (let i = 0; i < polys[f]!.length; i++)
      if (othersAround(f, i).some(([g]) => !tagged.has(g))) prev.push([f, i]);
  }
  while (prev.length > 0) {
    const nextWave: Loop[] = [];
    // A stack: last pushed, first filled.
    for (let loop = prev.pop(); loop; loop = prev.pop()) {
      const [f, i] = loop;
      if (!tagged.has(f)) continue;
      tagged.delete(f);
      const n = polys[f]!.length;
      // The face's other edges, from the one after this loop's round to it.
      for (let s = 1; s < n; s++)
        for (const [g, j] of othersAround(f, (i + s) % n))
          if (tagged.has(g)) nextWave.push([g, j]);
      // `bm_face_copy_shared_all`: the face's attributes from the first face
      // round this loop's edge that is not waiting (`BM_elem_attrs_copy`).
      const from = othersAround(f, i).find(([g]) => !tagged.has(g) && g !== f);
      if (from) plan.faceFrom.push([f, from[0]]);
      copyShared(f);
    }
    prev = nextWave;
  }
  return plan;
}

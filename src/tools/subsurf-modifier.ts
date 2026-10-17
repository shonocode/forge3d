/**
 * Blender's **Subdivision Surface modifier** (`subdivision_type = CATMULL_CLARK`) on a {@link MeshData}, with its layers
 * (compat-backlog C42) — what `catmullClark` is to a bare surface, this is to a mesh that carries edge attributes.
 *
 * The geometry is {@link catmullClark}'s, with `creases` read as Blender's `crease_edge` (0..1; OpenSubdiv gets `10 · crease²`).
 * What Blender does with the rest (`subdiv_mesh.cc`):
 *
 * - **Edge attributes** (crease, seam, sharp) are copied to **both child edges of every original edge**, at every level, and
 *   unchanged — the refined sharpness lives in OpenSubdiv's tables, not in the mesh. An edge made inside a face has none.
 * - **Faces** take their coarse face's material, face strength (`faceStrength`) and flat flag (`sharpFaces`).
 * - **Vertex groups** are interpolated from the **coarse face** a new vertex lies in (OpenSubdiv's ptex face; the lowest-numbered face
 *   for a vertex on an edge): its weight is the bilinear mix of that face's corners — which, level by level, is the average of the
 *   vertices it is made from — and it is in every group any corner of that face is in, a zero weight included.
 * - **UVs** are subdivided by `uvSmooth`, as `catmullClark` does.
 * - **Colours** (and every other corner attribute) are mixed linearly inside the coarse face: a corner made at an edge is
 *   the mean of the edge's two corners, one at the centre the mean of the face's (`subdiv_interpolate_corner_data`).
 * - **Vertex creases** come out mixed like any float point attribute (`subdiv_mesh.cc` skips only `position` and the
 *   vertex groups): an edge point is the mean of its ends, a face point the mean of the face's corners, absent counting 0.
 * - **Wire edges** (`edges`): their vertices are infinitely sharp for the surface (`subdiv_converter_mesh.cc` — a vertex
 *   where a wire meets the surface stays a corner). Each wire edge is cut into `2^levels` pieces whose points lie on the
 *   cubic B-spline through the edge and its neighbours (`mesh_interpolate_position_on_edge`) — the next vertex along when
 *   the end has exactly two edges, the end mirrored otherwise — and that includes the ends: a vertex between two wire
 *   edges moves to (prev + 4·self + next) / 6. The new vertices follow the input's, edge by edge; loose vertices stay
 *   where they are. A wire edge's crease, seam and sharp go to all its pieces.
 *
 * - **Vertex creases** (`vertexCreases`, Blender's `crease_vert`) are OpenSubdiv's vertex sharpness (`10 · crease²`, with
 *   the two-edge rule added on top), under `useCreases` as the edge creases are.
 *
 * **`subdivisionType: "SIMPLE"`** (OpenSubdiv's bilinear scheme) keeps the shape — each face cut at its edge midpoints and
 * its centre, level by level — and carries every layer above on the same path; its UVs are mixed linearly like the colours
 * (compat-backlog C89). Its wire edges are cut into `2^levels` straight pieces, the ends left where they are.
 *
 * Edge creases are carried whatever `useCreases` says (Blender copies every edge attribute); the flag gates the shape.
 *
 * Not carried: custom normals (two angles in each corner's normal space — compat-backlog C29).
 */
import type { MeshData } from "../lib/mesh";
import { catmullClark, subdivideOnce, type CatmullClarkOptions } from "./edit-mode/subdivide";
import { seamKey } from "./edit-mode/half-edge";

export interface SubsurfModifierOptions extends Omit<CatmullClarkOptions, "blenderCreases" | "limitSurface"> {
  /** `levels`. Default 1. */
  levels?: number;
  /**
   * `use_limit_surface` — **on by default, as in Blender's modifier** (`catmullClark` itself defaults to off, plain
   * refinement). See {@link CatmullClarkOptions.limitSurface}.
   */
  limitSurface?: boolean;
  /** `use_creases`. Default on. */
  useCreases?: boolean;
  /** `subdivision_type`. Default `CATMULL_CLARK`; `SIMPLE` cuts the faces without moving anything (compat-backlog C89). */
  subdivisionType?: "CATMULL_CLARK" | "SIMPLE";
}

export function subsurfModifier(data: MeshData, opts: SubsurfModifierOptions = {}): MeshData {
  const level = Math.max(0, Math.floor(opts.levels ?? 1));
  const useCreases = opts.useCreases ?? true;
  // At level 0 both schemes leave the mesh as it is (the CC path below does that, wires included).
  const simple = opts.subdivisionType === "SIMPLE" && level > 0;
  const { levels: _levels, useCreases: _use, subdivisionType: _type, ...cc } = opts;
  void _levels;
  void _use;
  void _type;
  const polys0 = data.polys.filter((p) => p.length >= 3);
  const keptFace = data.polys.map((p, i) => (p.length >= 3 ? i : -1)).filter((i) => i >= 0);
  // Wire edges: listed once, and only those no polygon uses.
  const faceEdges = new Set(polys0.flatMap((p) => p.map((v, i) => seamKey(v, p[(i + 1) % p.length]!))));
  const wires: [number, number][] = [];
  const wireKeys = new Set<string>();
  for (const e of data.edges ?? []) {
    const k = seamKey(e[0]!, e[1]!);
    if (e[0] === e[1] || faceEdges.has(k) || wireKeys.has(k)) continue;
    wireKeys.add(k);
    wires.push([e[0]!, e[1]!]);
  }
  // The refiner sees only the faces (`initialize_manifold_indices` drops loose vertices and edges): the infinitely sharp
  // vertices are the wire ends on a face, and a wire's crease is not the surface's.
  const faceVerts = new Set(polys0.flat());
  const sharpEnds = [...new Set(wires.flat())].filter((v) => faceVerts.has(v));
  const surfaceCreases =
    useCreases && data.creases ? (wires.length ? new Map([...data.creases].filter(([k]) => faceEdges.has(k))) : data.creases) : undefined;
  // SIMPLE's shape and polygons are made by the loop below, with the layers.
  const result = simple
    ? null
    : catmullClark(data.positions, polys0, level, surfaceCreases, data.uvs, {
        ...cc,
        limitSurface: opts.limitSurface ?? true,
        blenderCreases: true,
        ...(sharpEnds.length ? { infiniteSharpVertices: sharpEnds } : {}),
        ...(useCreases && data.vertexCreases?.size ? { vertexCreases: data.vertexCreases } : {}),
      });
  const out: MeshData = result ? { positions: result.positions, polys: result.polys } : { positions: data.positions, polys: polys0 };
  if (result?.uvs) out.uvs = result.uvs;
  // Level 0 leaves the mesh as it is, wires included.
  // SIMPLE's wires are cut after the loop, on its positions.
  let wired =
    wires.length && !simple
      ? level > 0
        ? subdivideWires(data.positions, out.positions, wires, faceEdges, level)
        : { positions: out.positions, edges: wires.map((e) => [...e]), inner: [] }
      : null;
  if (wired) {
    out.positions = wired.positions;
    out.edges = wired.edges;
  }

  // The layers ride the topology level by level; only the shape of the refinement matters, so the positions are the input's.
  let polys = polys0;
  // `crease_edge` is an edge attribute like any other: copied whatever `use_creases` says, which only gates the shape.
  let creases = data.creases ? new Map(data.creases) : null;
  let seams = data.seams ? new Set(data.seams) : null;
  let sharp = data.sharp ? new Set(data.sharp) : null;
  let mats: number[] | null = data.materials && data.materials.length === data.polys.length ? keptFace.map((f) => data.materials![f]!) : null;
  // An int face attribute: every child face keeps its coarse face's value (`subdiv_mesh_face`, compat-backlog C88).
  let strength: number[] | null =
    data.faceStrength && data.faceStrength.length === data.polys.length ? keptFace.map((f) => data.faceStrength![f]!) : null;
  let flat: boolean[] | null =
    data.sharpFaces && data.sharpFaces.length === data.polys.length ? keptFace.map((f) => data.sharpFaces![f]!) : null;
  let groups: Map<string, Map<number, number>> | null = data.groups ? new Map([...data.groups].map(([k, g]) => [k, new Map(g)])) : null;
  let positions = data.positions;
  let sigma = new Map<string, number>();
  // SIMPLE's positions, in double from level to level as the bilinear refinement adds them.
  let bilinear: number[] | null = simple ? Array.from(data.positions) : null;
  // Corner layers mixed linearly in the coarse face: the colours always, the UVs in SIMPLE (CC's come from `catmullClark`).
  const cornersOf = (layer: number[][][] | undefined): number[][][] | null =>
    layer && layer.length === data.polys.length ? keptFace.map((f) => layer[f]!.map((c) => [...c])) : null;
  let colors = cornersOf(data.colors);
  let linearUVs = simple ? cornersOf(data.uvs) : null;
  // Vertex creases as a float point attribute (absent = 0).
  let vcreases: Map<number, number> | null = data.vertexCreases?.size ? new Map(data.vertexCreases) : null;
  // The coarse face each vertex-making element belongs to: a face's own number, an edge's lowest face.
  let faceOwner: number[] = polys.map((_, i) => i);
  let edgeOwner = new Map<string, number>();
  polys.forEach((p, f) => {
    for (let i = 0; i < p.length; i++) {
      const k = seamKey(p[i]!, p[(i + 1) % p.length]!);
      if (!edgeOwner.has(k)) edgeOwner.set(k, f);
    }
  });
  const coarseGroups: Set<string>[] | null = groups
    ? polys.map((p) => new Set([...groups!].filter(([, g]) => p.some((v) => g.has(v))).map(([name]) => name)))
    : null;
  const preserveCorners = opts.boundarySmooth === "PRESERVE_CORNERS";
  for (let l = 0; l < level; l++) {
    const step = subdivideOnce(positions, polys, sigma, preserveCorners);
    const edgePoints = step.edgePoints!;
    const V = positions.length / 3;
    const F = polys.length;
    // Edge attributes: both child edges of an original edge.
    const carry = <T>(src: Map<string, T> | Set<string> | null): Map<string, T> | Set<string> | null => {
      if (!src) return null;
      const isMap = src instanceof Map;
      const next: Map<string, T> | Set<string> = isMap ? new Map<string, T>() : new Set<string>();
      for (const k of isMap ? src.keys() : src) {
        const [a, b] = k.split("_").map(Number) as [number, number];
        const ep = edgePoints.get(k);
        if (ep === undefined) continue;
        const k1 = seamKey(a, ep);
        const k2 = seamKey(ep, b);
        if (isMap) {
          (next as Map<string, T>).set(k1, (src as Map<string, T>).get(k)!);
          (next as Map<string, T>).set(k2, (src as Map<string, T>).get(k)!);
        } else {
          (next as Set<string>).add(k1);
          (next as Set<string>).add(k2);
        }
      }
      return next;
    };
    creases = carry(creases) as Map<string, number> | null;
    seams = carry(seams) as Set<string> | null;
    sharp = carry(sharp) as Set<string> | null;
    // Child quad `i` of a face is [corner i, edge i→i+1, centre, edge i−1→i] (`subdivideOnce`).
    const splitCorners = (layer: number[][][]): number[][][] =>
      layer.flatMap((c) => {
        const n = c.length;
        const centre = c[0]!.map((_, j) => c.reduce((s, x) => s + x[j]!, 0) / n);
        const mid = (a: number[], b: number[]) => a.map((x, j) => (x + b[j]!) / 2);
        return c.map((ci, i) => [[...ci], mid(ci, c[(i + 1) % n]!), [...centre], mid(c[(i - 1 + n) % n]!, ci)]);
      });
    if (colors) colors = splitCorners(colors);
    if (linearUVs) linearUVs = splitCorners(linearUVs);
    if (vcreases) {
      const next = new Map(vcreases);
      for (let f = 0; f < F; f++) {
        const p = polys[f]!;
        let sum = 0;
        for (const v of p) sum += vcreases.get(v) ?? 0;
        const c = Math.fround(sum / p.length);
        if (c !== 0) next.set(V + f, c);
      }
      for (const [k, ep] of edgePoints) {
        const [a, b] = k.split("_").map(Number) as [number, number];
        const c = Math.fround(((vcreases.get(a) ?? 0) + (vcreases.get(b) ?? 0)) / 2);
        if (c !== 0) next.set(ep, c);
      }
      vcreases = next;
    }
    if (bilinear) {
      const P = bilinear;
      const next = P.slice();
      polys.forEach((p) => {
        for (let k = 0; k < 3; k++) next.push(p.reduce((s, v) => s + P[v * 3 + k]!, 0) / p.length);
      });
      next.length = (V + F + edgePoints.size) * 3;
      for (const [key, ep] of edgePoints) {
        const [a, b] = key.split("_").map(Number) as [number, number];
        for (let k = 0; k < 3; k++) next[ep * 3 + k] = (P[a * 3 + k]! + P[b * 3 + k]!) / 2;
      }
      bilinear = next;
    }
    if (mats) mats = polys.flatMap((p, f) => p.map(() => mats![f]!));
    if (strength) strength = polys.flatMap((p, f) => p.map(() => strength![f]!));
    if (flat) flat = polys.flatMap((p, f) => p.map(() => flat![f]!));
    if (groups) {
      const next = new Map<string, Map<number, number>>();
      for (const [name, g] of groups) {
        const w = new Map(g);
        for (let f = 0; f < F; f++) {
          if (!coarseGroups![faceOwner[f]!]!.has(name)) continue;
          const p = polys[f]!;
          let sum = 0;
          for (const v of p) sum += g.get(v) ?? 0;
          w.set(V + f, Math.fround(sum / p.length));
        }
        for (const [k, ep] of edgePoints) {
          if (!coarseGroups![edgeOwner.get(k)!]!.has(name)) continue;
          const [a, b] = k.split("_").map(Number) as [number, number];
          w.set(ep, Math.fround(((g.get(a) ?? 0) + (g.get(b) ?? 0)) / 2));
        }
        next.set(name, w);
      }
      groups = next;
    }
    // The owners of the next level's faces and edges: a child edge keeps its parent's, an edge inside a face has that face's.
    const nextFaceOwner: number[] = [];
    const nextEdgeOwner = new Map<string, number>();
    polys.forEach((p, f) => {
      const owner = faceOwner[f]!;
      for (let i = 0; i < p.length; i++) {
        const a = p[i]!;
        const b = p[(i + 1) % p.length]!;
        const ep = edgePoints.get(seamKey(a, b))!;
        const parent = edgeOwner.get(seamKey(a, b))!;
        nextEdgeOwner.set(seamKey(a, ep), parent);
        nextEdgeOwner.set(seamKey(ep, b), parent);
      }
      for (let i = 0; i < p.length; i++) nextFaceOwner.push(owner);
    });
    step.polys.forEach((q, i) => {
      const owner = nextFaceOwner[i]!;
      for (let j = 0; j < q.length; j++) {
        const k = seamKey(q[j]!, q[(j + 1) % q.length]!);
        if (!nextEdgeOwner.has(k)) nextEdgeOwner.set(k, owner);
      }
    });
    faceOwner = nextFaceOwner;
    edgeOwner = nextEdgeOwner;
    positions = step.positions;
    polys = step.polys;
    sigma = step.creases;
  }
  if (bilinear) {
    out.positions = Float32Array.from(bilinear);
    out.polys = polys;
    if (wires.length) {
      wired = subdivideWires(data.positions, out.positions, wires, faceEdges, level, true);
      out.positions = wired.positions;
      out.edges = wired.edges;
    }
  }
  // A wire edge's crease, seam and sharp go to each of its pieces, as a face edge's do.
  // A wire's inner vertex mixes its ends' groups by (1 − u, u) (`mix_deform_verts`), every group either end is in.
  if (wired && groups)
    for (const g of groups.values())
      for (const { id, a, b, u } of wired.inner) {
        if (!g.has(a) && !g.has(b)) continue;
        g.set(id, f(f(f(1 - u) * (g.get(a) ?? 0)) + f(u * (g.get(b) ?? 0))));
      }
  if (wires.length && level > 0) {
    const per = (1 << level);
    wires.forEach(([a, b], w) => {
      const k = seamKey(a, b);
      const pieces = out.edges!.slice(w * per, (w + 1) * per).map(([x, y]) => seamKey(x!, y!));
      const c = data.creases?.get(k);
      if (c !== undefined) for (const q of pieces) (creases ??= new Map()).set(q, c);
      if (data.seams?.has(k)) for (const q of pieces) (seams ??= new Set()).add(q);
      if (data.sharp?.has(k)) for (const q of pieces) (sharp ??= new Set()).add(q);
    });
  }
  if (creases && creases.size) out.creases = creases;
  if (seams && seams.size) out.seams = seams;
  if (sharp && sharp.size) out.sharp = sharp;
  if (mats) out.materials = mats;
  if (strength) out.faceStrength = strength;
  if (flat) out.sharpFaces = flat;
  if (groups) out.groups = groups;
  if (colors) out.colors = colors;
  if (linearUVs) out.uvs = linearUVs;
  if (vcreases) {
    // A wire's inner vertex mixes its ends by (1 − u, u), as the groups do.
    if (wired)
      for (const { id, a, b, u } of wired.inner) {
        const c = f(f(f(1 - u) * (vcreases.get(a) ?? 0)) + f(u * (vcreases.get(b) ?? 0)));
        if (c !== 0) vcreases.set(id, c);
      }
    out.vertexCreases = vcreases;
  }
  return out;
}

const f = Math.fround;

/** `key_curve_position_weights(t, KEY_BSPLINE)`, in float. */
function bsplineWeights(t: number): [number, number, number, number] {
  const t2 = f(t * t);
  const t3 = f(t2 * t);
  return [
    f(f(f(f(f(-0.16666666) * t3) + f(0.5 * t2)) - f(0.5 * t)) + f(0.16666666)),
    f(f(f(0.5 * t3) - t2) + f(0.66666666)),
    f(f(f(f(-0.5 * t3) + f(0.5 * t2)) + f(0.5 * t)) + f(0.16666666)),
    f(f(0.16666666) * t3),
  ];
}

/**
 * The wire edges of Blender's Subdivision Surface (`subdiv_foreach_vertices_of_loose_edges_task` →
 * `mesh_interpolate_position_on_edge`): `2^level + 1` points per edge at u = i / 2^level on the B-spline through the
 * edge's ends and their neighbours, ends included. Returns the positions with the inner points appended and the pieces.
 */
function subdivideWires(
  coarse: Float32Array,
  refined: Float32Array,
  wires: [number, number][],
  faceEdges: Set<string>,
  level: number,
  linear = false,
): { positions: Float32Array; edges: number[][]; inner: { id: number; a: number; b: number; u: number }[] } {
  // `vert_to_edge_map` of the coarse mesh: every edge, the polygons' and the wires'.
  const edgesOf = new Map<number, [number, number][]>();
  const add = (a: number, b: number): void => {
    for (const v of [a, b]) {
      let list = edgesOf.get(v);
      if (!list) edgesOf.set(v, (list = []));
      list.push([a, b]);
    }
  };
  for (const k of faceEdges) {
    const [a, b] = k.split("_").map(Number) as [number, number];
    add(a, b);
  }
  for (const [a, b] of wires) add(a, b);
  const P = (v: number): number[] => [coarse[3 * v]!, coarse[3 * v + 1]!, coarse[3 * v + 2]!];
  const resolution = (1 << level) + 1;
  const inv = f(1 / (resolution - 1));
  const out = Array.from(refined);
  const edges: number[][] = [];
  const inner: { id: number; a: number; b: number; u: number }[] = [];
  let next = refined.length / 3;
  for (const [a, b] of wires) {
    // `find_edge_neighbors`: only a vertex with exactly two edges has one.
    const beyond = (v: number, other: number): number[] => {
      const list = edgesOf.get(v)!;
      if (list.length === 2) {
        const e = list[0]![0] === v && list[0]![1] === other || list[0]![1] === v && list[0]![0] === other ? list[1]! : list[0]!;
        return P(e[0] === v ? e[1] : e[0]);
      }
      const p = P(v);
      const q = P(other);
      return [f(f(p[0]! * 2) - q[0]!), f(f(p[1]! * 2) - q[1]!), f(f(p[2]! * 2) - q[2]!)];
    };
    const pts = [beyond(a, b), P(a), P(b), beyond(b, a)];
    const ids: number[] = [];
    for (let i = 0; i < resolution; i++) {
      const u = f(i * inv);
      const w = bsplineWeights(u);
      // SIMPLE (`is_simple` in `mesh_interpolate_position_on_edge`): straight along the edge, `interpolate(a, b, u)`.
      const co = linear
        ? [0, 1, 2].map((k) => f(f(pts[1]![k]! * f(1 - u)) + f(pts[2]![k]! * u)))
        : [0, 1, 2].map((k) =>
            f(f(f(f(pts[0]![k]! * w[0]) + f(pts[1]![k]! * w[1])) + f(pts[2]![k]! * w[2])) + f(pts[3]![k]! * w[3])),
          );
      const id = i === 0 ? a : i === resolution - 1 ? b : next++;
      if (i > 0 && i < resolution - 1) inner.push({ id, a, b, u });
      out[3 * id] = co[0]!;
      out[3 * id + 1] = co[1]!;
      out[3 * id + 2] = co[2]!;
      ids.push(id);
    }
    for (let i = 0; i + 1 < ids.length; i++) edges.push([ids[i]!, ids[i + 1]!]);
  }
  return { positions: Float32Array.from(out), edges, inner };
}

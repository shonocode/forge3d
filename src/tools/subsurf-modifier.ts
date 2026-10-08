/**
 * Blender's **Subdivision Surface modifier** (`subdivision_type = CATMULL_CLARK`) on a {@link MeshData}, with its layers
 * (compat-backlog C42) — what `catmullClark` is to a bare surface, this is to a mesh that carries edge attributes.
 *
 * The geometry is {@link catmullClark}'s, with `creases` read as Blender's `crease_edge` (0..1; OpenSubdiv gets `10 · crease²`).
 * What Blender does with the rest (`subdiv_mesh.cc`):
 *
 * - **Edge attributes** (crease, seam, sharp) are copied to **both child edges of every original edge**, at every level, and
 *   unchanged — the refined sharpness lives in OpenSubdiv's tables, not in the mesh. An edge made inside a face has none.
 * - **Faces** take their coarse face's material.
 * - **Vertex groups** are interpolated from the **coarse face** a new vertex lies in (OpenSubdiv's ptex face; the lowest-numbered face
 *   for a vertex on an edge): its weight is the bilinear mix of that face's corners — which, level by level, is the average of the
 *   vertices it is made from — and it is in every group any corner of that face is in, a zero weight included.
 * - **UVs** are subdivided by `uvSmooth`, as `catmullClark` does.
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
 * Not carried: vertex colours and custom normals (the latter are two angles in each corner's normal space — compat-backlog C29),
 * and the vertex creases themselves into the result.
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
}

export function subsurfModifier(data: MeshData, opts: SubsurfModifierOptions = {}): MeshData {
  const level = Math.max(0, Math.floor(opts.levels ?? 1));
  const useCreases = opts.useCreases ?? true;
  const { levels: _levels, useCreases: _use, ...cc } = opts;
  void _levels;
  void _use;
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
  const result = catmullClark(data.positions, polys0, level, surfaceCreases, data.uvs, {
    ...cc,
    limitSurface: opts.limitSurface ?? true,
    blenderCreases: true,
    ...(sharpEnds.length ? { infiniteSharpVertices: sharpEnds } : {}),
    ...(useCreases && data.vertexCreases?.size ? { vertexCreases: data.vertexCreases } : {}),
  });
  const out: MeshData = { positions: result.positions, polys: result.polys };
  if (result.uvs) out.uvs = result.uvs;
  // Level 0 leaves the mesh as it is, wires included.
  const wired = wires.length ? (level > 0 ? subdivideWires(data.positions, out.positions, wires, faceEdges, level) : { positions: out.positions, edges: wires.map((e) => [...e]), inner: [] }) : null;
  if (wired) {
    out.positions = wired.positions;
    out.edges = wired.edges;
  }

  // The layers ride the topology level by level; only the shape of the refinement matters, so the positions are the input's.
  let polys = polys0;
  let creases = useCreases && data.creases ? new Map(data.creases) : null;
  let seams = data.seams ? new Set(data.seams) : null;
  let sharp = data.sharp ? new Set(data.sharp) : null;
  let mats: number[] | null = data.materials && data.materials.length === data.polys.length ? keptFace.map((f) => data.materials![f]!) : null;
  let groups: Map<string, Map<number, number>> | null = data.groups ? new Map([...data.groups].map(([k, g]) => [k, new Map(g)])) : null;
  let positions = data.positions;
  let sigma = new Map<string, number>();
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
    if (mats) mats = polys.flatMap((p, f) => p.map(() => mats![f]!));
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
      const c = useCreases ? data.creases?.get(k) : undefined;
      if (c !== undefined) for (const q of pieces) (creases ??= new Map()).set(q, c);
      if (data.seams?.has(k)) for (const q of pieces) (seams ??= new Set()).add(q);
      if (data.sharp?.has(k)) for (const q of pieces) (sharp ??= new Set()).add(q);
    });
  }
  if (creases && creases.size) out.creases = creases;
  if (seams && seams.size) out.seams = seams;
  if (sharp && sharp.size) out.sharp = sharp;
  if (mats) out.materials = mats;
  if (groups) out.groups = groups;
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
      const co = [0, 1, 2].map((k) =>
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

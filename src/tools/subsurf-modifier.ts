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
 *
 * Not carried: vertex colours and custom normals (the latter are two angles in each corner's normal space — compat-backlog C29),
 * vertex creases (a `MeshData` has none), wire edges and loose vertices.
 */
import type { MeshData } from "../lib/mesh";
import { catmullClark, subdivideOnce, type CatmullClarkOptions } from "./edit-mode/subdivide";
import { seamKey } from "./edit-mode/half-edge";

export interface SubsurfModifierOptions extends Omit<CatmullClarkOptions, "blenderCreases"> {
  /** `levels`. Default 1. */
  levels?: number;
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
  const result = catmullClark(data.positions, polys0, level, useCreases ? data.creases : undefined, data.uvs, {
    ...cc,
    blenderCreases: true,
  });
  const out: MeshData = { positions: result.positions, polys: result.polys };
  if (result.uvs) out.uvs = result.uvs;

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
  if (creases && creases.size) out.creases = creases;
  if (seams && seams.size) out.seams = seams;
  if (sharp && sharp.size) out.sharp = sharp;
  if (mats) out.materials = mats;
  if (groups) out.groups = groups;
  return out;
}

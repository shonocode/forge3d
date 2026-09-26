/**
 * Delete vertices, edges and faces the way Blender's `bmesh.ops.delete`
 * does, one `context` at a time (`BMO_mesh_delete_oflag_context`,
 * `bmesh/intern/bmesh_delete.cc`, Blender 5.1.1).
 */
import type { MeshData } from "../lib/mesh";
import { seamKey } from "./edit-mode/half-edge";
import { carryFaceLayers, carryVertexLayers, defined, onlyEdgesOf, sameFaces } from "./mesh-layers";

/**
 * Blender's `bmesh.ops.delete` `context`:
 *
 * | context | removes |
 * |---|---|
 * | `VERTS` | the vertices, and every edge and face on them |
 * | `EDGES` | the edges and the faces on them, then any vertex of theirs (or given) left with no edge |
 * | `EDGES_FACES` | the edges and the faces on them — the vertices stay |
 * | `FACES_ONLY` | the faces — their edges and vertices stay, loose where nothing else uses them |
 * | `FACES` | the faces, and each of their edges and vertices that no remaining face or edge uses |
 * | `FACES_KEEP_BOUNDARY` | as `FACES`, but an edge on the mesh's rim stays, with its vertices |
 * | `TAGGED_ONLY` | exactly what is given, each face, edge and vertex (a vertex takes its edges and faces with it) |
 */
export type DeleteContext =
  | "VERTS"
  | "EDGES"
  | "EDGES_FACES"
  | "FACES_ONLY"
  | "FACES"
  | "FACES_KEEP_BOUNDARY"
  | "TAGGED_ONLY";

/** What `bmesh.ops.delete`'s `geom` holds: any mix of the three. */
export interface DeleteGeom {
  verts?: Iterable<number>;
  /** Edges as their two vertices, either order — a face's side or a wire edge. */
  edges?: Iterable<readonly [number, number]>;
  faces?: Iterable<number>;
}

/**
 * `bmesh.ops.delete(bm, geom=, context=)`, ported from
 * `BMO_mesh_delete_oflag_context`.
 *
 * Every context reads only the kinds it is written for, as Blender's does —
 * `EDGES_FACES` removes the given **edges** (and so their faces) but not a
 * face given on its own; `VERTS` ignores the edges and faces in `geom`. The
 * Delete menu in edit mode (`MESH_OT_delete`) is this with the selection
 * flushed down first — select faces, and their edges and vertices are
 * selected too — so "Delete ▸ Vertices" on a face selection removes the faces
 * **around** it as well (`delete-bpy-*` parity rows):
 *
 * | menu | context | `geom` |
 * |---|---|---|
 * | Vertices (default) | `VERTS` | the selected vertices |
 * | Edges | `EDGES` | the selected edges |
 * | Faces | `FACES` | the selected faces |
 * | Only Edges & Faces | `EDGES_FACES` | the selected edges and faces |
 * | Only Faces | `FACES_ONLY` | the selected faces |
 *
 * The result is renumbered as Blender's is: what survives keeps its order.
 * An edge left with no face becomes a wire edge (`edges`). Every layer
 * follows its element — groups their vertex, UVs / colours / custom normals /
 * materials their face, creases / seams / sharp their edge, and an edge
 * flag goes with its edge.
 */
export function deleteGeometry(data: MeshData, geom: DeleteGeom, context: DeleteContext): MeshData {
  const count = data.positions.length / 3;

  // Every edge, from the faces and the wire edges, with the faces on it.
  const edgeEnds = new Map<string, [number, number]>();
  const edgeFaces = new Map<string, number[]>();
  const edgeKeysOf: string[][] = data.polys.map((p, f) =>
    p.map((a, i) => {
      const b = p[(i + 1) % p.length]!;
      const k = seamKey(a, b);
      if (!edgeEnds.has(k)) edgeEnds.set(k, [a, b]);
      const l = edgeFaces.get(k);
      if (l) l.push(f);
      else edgeFaces.set(k, [f]);
      return k;
    }),
  );
  for (const e of data.edges ?? []) {
    const k = seamKey(e[0]!, e[1]!);
    if (!edgeEnds.has(k)) edgeEnds.set(k, [e[0]!, e[1]!]);
  }

  // The tags (`ELE_DEL`) — every element in `geom`, whatever the context.
  const tv = new Set<number>(geom.verts ?? []);
  const te = new Set<string>();
  for (const [a, b] of geom.edges ?? []) {
    const k = seamKey(a, b);
    if (edgeEnds.has(k)) te.add(k);
  }
  const tf = new Set<number>(geom.faces ?? []);

  let killV = new Set<number>();
  let killE = new Set<string>();
  let killF = new Set<number>();
  let looseV: Set<number> | null = null; // EDGES: tagged vertices removed only if left with no edge

  switch (context) {
    case "VERTS":
      killV = tv;
      break;
    case "EDGES":
      // "flush down to vert"
      for (const k of te) for (const v of edgeEnds.get(k)!) tv.add(v);
      killE = te;
      looseV = tv;
      break;
    case "EDGES_FACES":
      killE = te;
      break;
    case "FACES_ONLY":
      killF = tf;
      break;
    case "TAGGED_ONLY":
      killF = tf;
      killE = te;
      killV = tv;
      break;
    case "FACES":
    case "FACES_KEEP_BOUNDARY": {
      // Mark every edge and vertex of the faces …
      for (const f of tf) {
        if (f < 0 || f >= data.polys.length) continue;
        for (const v of data.polys[f]!) tv.add(v);
        for (const k of edgeKeysOf[f]!) te.add(k);
      }
      // … keep those of every other face …
      data.polys.forEach((p, f) => {
        if (tf.has(f)) return;
        for (const v of p) tv.delete(v);
        for (const k of edgeKeysOf[f]!) te.delete(k);
      });
      // … and the ends of every edge that stays (a rim edge, with the
      // exception, always stays).
      for (const [k, [a, b]] of edgeEnds) {
        if (context === "FACES_KEEP_BOUNDARY" && (edgeFaces.get(k)?.length ?? 0) === 1) te.delete(k);
        if (!te.has(k)) {
          tv.delete(a);
          tv.delete(b);
        }
      }
      killF = tf;
      killE = te;
      killV = tv;
      break;
    }
  }

  // What survives. A vertex takes its edges and faces; an edge its faces.
  const faceAlive = (f: number): boolean =>
    !killF.has(f) && !data.polys[f]!.some((v) => killV.has(v)) && !edgeKeysOf[f]!.some((k) => killE.has(k));
  const faces: number[] = [];
  data.polys.forEach((_, f) => {
    if (faceAlive(f)) faces.push(f);
  });
  const edgesAlive = new Set<string>();
  for (const [k, [a, b]] of edgeEnds) if (!killE.has(k) && !killV.has(a) && !killV.has(b)) edgesAlive.add(k);

  const keep = new Set<number>();
  const hasEdge = new Set<number>();
  for (const k of edgesAlive) for (const v of edgeEnds.get(k)!) hasEdge.add(v);
  for (let v = 0; v < count; v++) {
    if (killV.has(v)) continue;
    if (looseV && looseV.has(v) && !hasEdge.has(v)) continue;
    keep.add(v);
  }

  // Renumber, keeping order.
  const remap = new Int32Array(count).fill(-1);
  const source: number[] = [];
  const positions: number[] = [];
  for (let v = 0; v < count; v++) {
    if (!keep.has(v)) continue;
    remap[v] = source.length;
    source.push(v);
    positions.push(data.positions[v * 3]!, data.positions[v * 3 + 1]!, data.positions[v * 3 + 2]!);
  }
  const polys = faces.map((f) => data.polys[f]!.map((v) => remap[v]!));

  // A surviving edge that no surviving face uses is a wire edge.
  const onFace = new Set<string>();
  for (const f of faces) for (const k of edgeKeysOf[f]!) onFace.add(k);
  const wire: number[][] = [];
  for (const k of edgesAlive) {
    if (onFace.has(k)) continue;
    const [a, b] = edgeEnds.get(k)!;
    wire.push([remap[a]!, remap[b]!]);
  }

  const vertexLayers = carryVertexLayers(data, source);
  onlyEdgesOf(vertexLayers, polys, wire);
  return defined({
    positions: new Float32Array(positions),
    polys,
    ...vertexLayers,
    edges: wire.length > 0 ? wire : undefined,
    ...carryFaceLayers(data, sameFaces(faces, data)),
  });
}

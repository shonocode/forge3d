/**
 * Plain-data entry into the half-edge mesh.
 *
 * The editor builds an `EditMesh` from a Babylon mesh in the viewport. Code
 * generating geometry has no viewport and no scene — it has arrays. These are
 * the two functions that let the whole operator set be driven from arrays and
 * hand arrays back, with Babylon nowhere in the loop.
 *
 * Positions and polygons are the same representation `toPolygons` and
 * `rebuildPolygons` already use internally, so this is an entry point rather
 * than a conversion layer.
 */
import type { EditMesh } from "../tools/edit-mode/half-edge";
import {
  rebuildPolygons,
  toPolygons,
  triangulateFaces,
  seamKey,
} from "../tools/edit-mode/half-edge";

/** A mesh as plain data: positions, polygons, and optional edge attributes. */
export interface MeshData {
  /** Flat xyz triples. */
  positions: Float32Array;
  /** One array of vertex indices per polygon, CCW. Triangles, quads, n-gons. */
  polys: number[][];
  /** Catmull-Clark edge sharpness, keyed "minVertex_maxVertex". */
  creases?: Map<string, number>;
  /** UV seam edges, keyed "minVertex_maxVertex". */
  seams?: Set<string>;
  /**
   * Edges marked **sharp**, keyed "minVertex_maxVertex" — Blender's
   * `use_edge_sharp`, the flag that stops a smooth shade from being carried
   * across an edge.
   *
   * A separate thing from {@link creases}, which is Catmull-Clark's weighting
   * and has a value per edge: this is a flag and it is about shading. Added
   * 2026-09-23 for `setSharpnessByAngle`, which is the operator that computes
   * it from the geometry.
   */
  sharp?: Set<string>;
  /**
   * Edges that belong to no polygon — Blender's "loose" or wire edges.
   *
   * **Only the wire ones.** A polygon's own edges are read off `polys`, so an
   * edge listed here that a polygon also uses is a contradiction rather than a
   * duplicate; the rule is measured — build a face on a wire edge in Blender
   * and it stops being reported as loose.
   *
   * Optional, and absent means the same as empty. It exists because four
   * Blender operators produce edges with no face on them and had nowhere to
   * put them: `extrude_vert_indiv`, `edgenet_prepare`, `face_split_by_edges`,
   * and the F key when exactly two vertices are chosen. The API matrix called
   * that "a separate project"; it is one field.
   *
   * **`EditMesh` does not carry these.** A half-edge structure is about faces,
   * and threading wire edges through every operator would be a change to all
   * of them. `meshFromData` keeps them to one side and `meshToData` hands them
   * back unchanged, so an operator that renumbers vertices must remap them —
   * `compactMesh` does, and it is the shared path for the ones that renumber.
   */
  edges?: number[][];
  /**
   * UV per **face corner**, shaped like `polys`: `uvs[f][i]` belongs to corner
   * `i` of polygon `f`, as `[u, v]`.
   *
   * Per corner and not per vertex, which is the whole point — two faces
   * meeting at an edge can disagree about the UV along it, and that
   * disagreement is what a seam is. A per-vertex layer cannot express one.
   *
   * The same nesting as `polys` so a corner and its coordinate are found the
   * same way; {@link reverseLoopData} and the rest check the two agree and
   * refuse rather than guess when they do not.
   */
  uvs?: number[][][];
  /** Vertex colour per face corner, `[r, g, b, a]`, shaped like {@link uvs}. */
  colors?: number[][][];
  /**
   * An explicit normal per face **corner**, `[x, y, z]`, shaped like
   * {@link uvs} — Blender's custom normals, which live in a `custom_normal`
   * attribute and number 24 on a cube rather than 8.
   *
   * Absent means "work them out from the geometry", which is what every
   * renderer does by default. Present means the mesh carries an answer that
   * overrides it, and five Blender operators plus two modifiers exist to
   * compute one — see `tools/edit-mode/normals.ts`, added 2026-09-24 with
   * this field.
   *
   * **Sharp edges belong with this.** Averaging a normal across an edge is
   * exactly what {@link sharp} forbids, so the two layers are read together.
   */
  normals?: number[][][];
  /**
   * Vertex groups — a weight per vertex, keyed by group name, as Blender's
   * `vertex_groups` are.
   *
   * **A `Map` and not an array, because "not in the group" is a state.**
   * Blender distinguishes a vertex with weight 0 from a vertex that is not a
   * member at all, and the three `VERTEX_WEIGHT_*` modifiers exist largely to
   * move vertices across that line — `use_add` puts them in, `use_remove`
   * takes them out, and `mix_set` decides which side of it the mix touches. A
   * `Float32Array` per group would erase the distinction and quietly make
   * three of those options meaningless.
   *
   * Added 2026-09-24 with `tools/edit-mode/vertex-weight.ts`. The same shape
   * that wire edges, the loop layers and the custom normals had: one field,
   * several operators behind it.
   *
   * **`EditMesh` does not carry these, and that is deliberate.** Weights are
   * keyed by vertex index, so an operator that renumbers vertices would leave
   * them pointing at the wrong ones — `MeshData.edges` has the same exposure
   * and `compactMesh` remaps it. Rather than half-carry them and be silently
   * wrong, `meshFromData` drops them: a round trip through the half-edge
   * operators loses the groups **visibly**. The three operators that read and
   * write this field are pure `MeshData` functions and never go through
   * `EditMesh`.
   */
  groups?: Map<string, Map<number, number>>;
  /**
   * A material slot per **face**, aligned with {@link polys} — Blender's
   * `material_index`. Absent means every face uses slot 0.
   *
   * Added 2026-09-25 for `separateByMaterial` (Blender's Separate ▸ By
   * Material). Like {@link groups}, `meshFromData` does not carry it into an
   * `EditMesh`; the functions that read it are pure `MeshData` functions.
   */
  materials?: number[];
}

/**
 * Build an editable mesh from plain arrays.
 *
 * The result has no `source`, so viewport-only operations (commit, picking,
 * overlays, gizmos) will throw if called on it. Every geometry operator works.
 */
export function meshFromData(data: MeshData): EditMesh {
  const em: EditMesh = {
    source: null,
    vertices: [],
    faces: [],
    halfEdges: [],
    positions: new Float32Array(data.positions),
    seams: new Set(data.seams ?? []),
    creases: new Map(data.creases ?? []),
    triToFace: [],
  };

  rebuildPolygons(em, em.positions, data.polys);
  // Carried, not used. See the note on `MeshData.edges`: the operators never
  // look at these, and `meshToData` puts them back exactly as they came in.
  em.wireEdges = (data.edges ?? []).map((e) => [...e]);
  if (data.sharp) em.sharpEdges = new Set(data.sharp);
  if (data.normals) em.loopNormals = data.normals.map((f) => f.map((c) => [...c]));
  // The loop layers ride along the same way, with the same warning: an
  // operator that changes a face's arity leaves them describing the old one.
  // The four that permute them work on `MeshData` directly and never enter
  // here; anything else that wants to keep them has to say so.
  if (data.uvs) em.loopUVs = data.uvs.map((f) => f.map((c) => [...c]));
  if (data.colors) em.loopColors = data.colors.map((f) => f.map((c) => [...c]));

  const tri = triangulateFaces(em);
  em.triToFace = tri.triToFace;

  return em;
}

/** Read an editable mesh back out as plain arrays. */
export function meshToData(em: EditMesh): Required<MeshData> {
  return {
    positions: new Float32Array(em.positions),
    polys: toPolygons(em),
    creases: new Map(em.creases),
    seams: new Set(em.seams),
    edges: (em.wireEdges ?? []).map((e) => [...e]),
    uvs: (em.loopUVs ?? []).map((f) => f.map((c) => [...c])),
    colors: (em.loopColors ?? []).map((f) => f.map((c) => [...c])),
    sharp: new Set(em.sharpEdges ?? []),
    normals: (em.loopNormals ?? []).map((f) => f.map((c) => [...c])),
    // **Always empty, and that is the contract.** `EditMesh` does not carry
    // vertex groups, because their keys are vertex indices and an operator
    // that renumbers vertices would leave them pointing at the wrong ones. A
    // round trip through the half-edge operators loses the groups visibly
    // rather than silently mis-indexing them — see `MeshData.groups`.
    groups: new Map(),
    // Likewise per-face materials: face indices move under the operators.
    materials: [],
  };
}

/**
 * Triangle indices for a mesh, with the polygon each triangle came from.
 *
 * Renderers and glTF want triangles; the operators want polygons. This is the
 * bridge, and `triToFace` lets per-polygon data (material, selection) follow
 * through the conversion.
 */
export function meshToTriangles(em: EditMesh): { indices: number[]; triToFace: number[] } {
  return triangulateFaces(em);
}

/** Mark an edge as a Catmull-Clark crease. Sharpness sigma: 0 smooth, >=1 hard. */
export function setCrease(data: MeshData, v1: number, v2: number, sharpness: number): void {
  (data.creases ??= new Map()).set(seamKey(v1, v2), sharpness);
}

/** Mark an edge as a UV seam, which unwrapping will cut along. */
export function setSeam(data: MeshData, v1: number, v2: number): void {
  (data.seams ??= new Set()).add(seamKey(v1, v2));
}

/** Crease every edge of every polygon — the usual want for a hard-surface box. */
export function creaseAll(data: MeshData, sharpness: number): void {
  const creases = (data.creases ??= new Map());
  for (const poly of data.polys) {
    for (let i = 0; i < poly.length; i++) {
      creases.set(seamKey(poly[i]!, poly[(i + 1) % poly.length]!), sharpness);
    }
  }
}

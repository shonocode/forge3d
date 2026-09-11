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

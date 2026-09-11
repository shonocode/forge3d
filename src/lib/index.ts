/**
 * forge3d as a library.
 *
 * Everything exported here runs headless — no DOM, no editor state, no scene.
 * The audience is code that generates geometry: build scripts, asset
 * pipelines, and agents writing modelling code.
 *
 * ## What is and isn't here
 *
 * forge3d's `tools/` is about 18,000 lines, of which roughly 7,000 are pure
 * geometry and can be called from anywhere. The rest drive the editor —
 * selection, gizmos, undo, painting onto a canvas — and are deliberately not
 * re-exported. If something you want is missing, the question to ask is
 * whether its logic can be split from its editor plumbing, the way
 * `computeAutoWeights` is split from `applyAutoWeights`.
 *
 * ## Shape of the API
 *
 * Operators mutate an `EditMesh` and return the set of faces they touched.
 * Get one with `meshFromData`, read it back with `meshToData`. Pure maths
 * functions (subdivision, unwrapping, weights) take and return plain arrays
 * directly.
 *
 * ```ts
 * import { meshFromData, meshToData, extrudeFaces, catmullClark } from "forge3d";
 *
 * const em = meshFromData({ positions, polys });
 * extrudeFaces(em, new Set([topFace]));
 * const { positions: p, polys: f, creases } = meshToData(em);
 * const smooth = catmullClark(p, f, 2, creases);
 * ```
 */

// ── Mesh: plain data in, plain data out ────────────────────────────────────
export {
  meshFromData,
  meshToData,
  meshToTriangles,
  setCrease,
  setSeam,
  creaseAll,
  type MeshData,
} from "./mesh";

export type { EditMesh, HalfEdge, EditFace, EditVertex } from "../tools/edit-mode/half-edge";

// ── Mesh queries ───────────────────────────────────────────────────────────
// Navigating the half-edge structure: what a face is made of, which edges
// exist, where a vertex sits.
export {
  seamKey,
  isSeam,
  creaseOf,
  edgeOrigin,
  edgeEnd,
  canonicalEdge,
  forEachEdge,
  faceHalfEdges,
  faceVerts,
  faceVertexCount,
  faceVertices,
  facePolyNormal,
  hasNonTriFaces,
  getVertexPosition,
  setVertexPosition,
  toPolygons,
  toIndexArray,
  fanTriangulate,
} from "../tools/edit-mode/half-edge";

// ── Topology operators ─────────────────────────────────────────────────────
// Each mutates the mesh and returns the faces it created or touched.
export {
  extrudeFaces,
  extrudeEdges,
  insetFaces,
  bevelEdges,
  loopCut,
  knife,
  edgeSlide,
  vertexSlide,
  bridgeEdgeLoops,
  mergeAtCenter,
  collapseEdges,
  deleteFaces,
  deleteFacesByEdges,
  deleteFacesByVertices,
  trisToQuads,
  quadsToTris,
  subdivideCatmullClark,
} from "../tools/edit-mode/operators";

// ── Subdivision ────────────────────────────────────────────────────────────
// Pure: positions + polygons + creases in, refined surface out. Semi-sharp
// creases are how a box becomes a fillet with one parameter.
export { catmullClark, type SubdivResult } from "../tools/edit-mode/subdivide";

// ── UV ─────────────────────────────────────────────────────────────────────
export * from "../tools/edit-mode/uv-unwrap";
export * from "../tools/edit-mode/uv-pack";
export { computeLSCM, type LSCMResult, type LSCMOptions } from "../tools/edit-mode/lscm";

// ── Sculpt maths ───────────────────────────────────────────────────────────
// The brush falloffs and topology refinement, without the input handling.
export * from "../tools/dyntopo";
export * from "../tools/sculpt-delta";
export * from "../tools/sculpt-mask";
export * from "../tools/sculpt-symmetry";
export * from "../tools/edit-mode/proportional";

// ── Baking ─────────────────────────────────────────────────────────────────
export * from "../tools/ao-bake";
export * from "../tools/normal-bake";
export * from "../tools/bake-common";
export * from "../tools/auto-smooth";
export * from "../tools/edit-mode/attribute-transfer";

// ── Skinning ───────────────────────────────────────────────────────────────
// `computeAutoWeights` is the pure half of auto-weighting; the scene-side
// `applyAutoWeights` stays in the editor.
export {
  computeAutoWeights,
  distancePointToSegment,
  type BoneSegment,
  type AutoWeightOptions,
} from "../tools/auto-weights";
export {
  computeAutoWeightsGeodesic,
  buildMeshGraph,
  dijkstra,
  type MeshGraph,
} from "../tools/geodesic-weights";
export * from "../tools/ik-solver";
export * from "../tools/bone-mirror";
export * from "../tools/bone-orientation";

// ── Animation maths ────────────────────────────────────────────────────────
export * from "../tools/bezier";
export * from "../tools/easing";
export * from "../tools/key-retime";

// ── Texture painting maths ─────────────────────────────────────────────────
export * from "../tools/paint-brush";
export * from "../tools/paint-channels";
export * from "../tools/paint-layers";

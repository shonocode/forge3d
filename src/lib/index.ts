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

// ── Generators ─────────────────────────────────────────────────────────────
// Parameters in, quads out. Quads matter: these feed `catmullClark` directly,
// which is what `tools/primitives.ts` (MeshBuilder, triangles, scene-bound)
// cannot do.
export {
  box,
  plane,
  cylinder,
  sphere,
  revolve,
  sweep,
  type BoxOptions,
  type PlaneOptions,
  type CylinderOptions,
  type SphereOptions,
  type RevolveOptions,
  type SweepOptions,
  type Vec2,
  type Vec3,
} from "../tools/generate";

// ── Assembly ───────────────────────────────────────────────────────────────
// Placing, repeating and combining meshes, with creases and seams carried
// through so a creased box survives being mirrored into a scene.
export {
  mergeMeshes,
  transformMesh,
  mirrorMesh,
  arrayMesh,
  instanceMesh,
  radialArray,
  arrayAlongPath,
  weldMesh,
  boundsOf,
  solidify,
  symmetrize,
  convexHull,
  bisectPlane,
  type TransformOptions,
  type MirrorOptions,
  type RadialArrayOptions,
  type PathArrayOptions,
  type SolidifyOptions,
  type SymmetrizeOptions,
  type ConvexHullReport,
  type BisectPlaneOptions,
} from "../tools/mesh-ops";

// ── Topology operators ─────────────────────────────────────────────────────
// Each mutates the mesh and returns the faces it created or touched.
export {
  extrudeFaces,
  extrudeEdges,
  insetFaces,
  insetRegion,
  type InsetRegionOptions,
  bevelEdges,
  type BevelOptions,
  loopCut,
  rotateEdges,
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

// ── Choosing an edge selection ─────────────────────────────────────────────
// Bevel, bridge and loop cut take edges, and a build script has no way to know
// which integers those are. These are the two walks a modeller means by "the
// ring around the rim": through the vertices (loop) or across the faces
// (ring). Both match Blender 5.1.1 — the rules were measured, not read.
export {
  selectEdgeLoop,
  selectEdgeRing,
  walkEdgeRing,
  edgesAtVertex,
  type EdgeRingOptions,
} from "../tools/edit-mode/edge-walk";

// ── Dissolve ───────────────────────────────────────────────────────────────
// Taking edges away without leaving a hole. `dissolveLimit` is the one that
// earns its keep on generated geometry: a room built from boxes arrives with
// thousands of coplanar quads that exist because of how it was made.
export {
  dissolveFaces,
  dissolveEdges,
  dissolveLimit,
  type DissolveReport,
  type DissolveLimitOptions,
} from "../tools/edit-mode/dissolve";

// ── Refine ─────────────────────────────────────────────────────────────────
// Adding detail, relaxing it, closing what is left open. Three of the four
// have a Blender default that does the opposite of what a reader expects; the
// JSDoc on each says which.
export {
  poke,
  subdivideEdges,
  smoothVert,
  holesFill,
  type PokeOptions,
  type SubdivideEdgesOptions,
  type SmoothVertOptions,
  type HolesFillOptions,
} from "../tools/edit-mode/refine";

// ── Moving a face selection ────────────────────────────────────────────────
// `extrudeFaces` duplicates and stitches but does not move — in the editor the
// user drags a gizmo next. These supply the missing half for code, plus a way
// to pick faces by direction when there is no mouse to pick with.
export {
  moveFaces,
  offsetFaces,
  scaleFaces,
  averageNormal,
  facesFacing,
  extrudeFacesBy,
  insetFacesByWidth,
} from "../tools/edit-mode/face-transform";

// ── Choosing a face selection ──────────────────────────────────────────────
// The operators take a `Set<faceIndex>`, which is what a mouse produces and
// what a build script has no way to know. These turn a description — "the
// outward side of the torso, level with the shoulder" — into that set, and
// compose, so one selection can answer to several conditions at once.
export {
  selectFaces,
  faceCentroid,
  faceNormal,
  facing,
  centroidWhere,
  withinBounds,
  hasSides,
  and,
  or,
  not,
  nearestFaces,
  selectEdges,
  edgeMidpoint,
  edgeAlong,
  nearestEdges,
  type FacePredicate,
  type EdgePredicate,
} from "../tools/select";

// ── Displacement ───────────────────────────────────────────────────────────
// Pushing vertices around by something irregular — the step that makes a box
// read as a stone. No Blender reference (a texture-driven modifier and an
// editor RNG), so the guarantee is determinism: same seed, same mesh.
export {
  displace,
  valueNoise,
  hashNoise,
  type DisplaceOptions,
} from "../tools/displace";

// ── Repair ─────────────────────────────────────────────────────────────────
// Making generated geometry well-formed before the next stage sees it. Both
// are Blender operators, and both are here because a generator can emit a mesh
// that is wrong in a way nothing downstream reports: a shell wound inward, or
// a concave n-gon that Catmull-Clark will fold.
export {
  recalcFaceNormals,
  connectVertsConcave,
  type RecalcFaceNormalsReport,
  type ConnectVertsConcaveReport,
} from "../tools/mesh-repair";

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

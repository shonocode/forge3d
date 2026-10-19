/**
 * The E key — Blender's **Extrude** (`MESH_OT_extrude_context`, `edbm_extrude_mesh` in `editmesh_extrude.cc`), which picks
 * what to do from the selection (compat-backlog C126).
 *
 * Pure and headless — the editor calls it with its selection and takes the selection it returns.
 */
import { canonicalEdge, edgeEnd, edgeOrigin, faceHalfEdges, forEachEdge, toPolygons, type EditMesh } from "./half-edge";
import { extrudeEdges } from "./operators";
import { extrudeRegion } from "./face-transform";
import { extrudeVertIndiv } from "./wire";
import { assignFromData, meshToData } from "../../lib/mesh";

/** A selection in one mode, as the editor holds it: vertex ids, canonical half-edge ids, or face ids. */
export interface ExtrudeContextSelection {
  mode: "vertex" | "edge" | "face";
  indices: ReadonlySet<number>;
}

/** Which of `edbm_extrude_mesh`'s four answers the selection got. */
export type ExtrudeContextKind = "none" | "region" | "verts" | "edges";

/**
 * Extrude the selection the way the E key does, and return the selection Blender leaves (always in the same mode).
 *
 * The selection is first read the way Blender's flushed selection is: in vertex mode an edge counts when both its ends
 * are chosen and a face when all its corners are; in edge mode a face counts when all its edges are. Then
 * (`editmesh_extrude.cc` 357-420):
 *
 * - **vertex mode**: one vertex, or no edge → each vertex alone grows a wire edge (`extrude_vert_indiv`, kind `"verts"`);
 *   otherwise → the region (`"region"`)
 * - **edge mode**: no face → each edge alone grows a fin (`extrude_edge_only`, kind `"edges"`); otherwise → the region
 * - **face mode**: the region of the faces
 *
 * The region is `extrude_face_region` given the chosen faces, edges and (in vertex mode) vertices
 * ({@link extrudeRegion}): the faces extrude as a region, an edge on none of them grows a wall, a chosen wire edge
 * becomes a wall, a vertex on no chosen edge grows a wire edge — all on shared copies. Nothing moves; the copies are what comes back selected, so dragging them pulls the
 * extrusion out. In edge mode that is the new edges (not the fins — before C126 the editor selected the fins and
 * switched to face mode, so a drag took the original edge along).
 */
export function extrudeContext(em: EditMesh, sel: ExtrudeContextSelection): { kind: ExtrudeContextKind; selection: Set<number> } {
  const polys = toPolygons(em);
  const verts = new Set<number>();
  const edges = new Set<number>();
  const faces = new Set<number>();
  // Wire edges are edges to Blender's flush too (`totedgesel`); only vertex mode can choose one — the editor picks edges
  // by half-edge (compat-backlog C126 review).
  const wires: Array<[number, number]> = [];
  if (sel.mode === "vertex") {
    for (const v of sel.indices) verts.add(v);
    forEachEdge(em, (he) => {
      if (verts.has(edgeOrigin(em, he)) && verts.has(edgeEnd(em, he))) edges.add(canonicalEdge(em, he));
    });
    for (const [a, b] of em.wireEdges ?? []) if (verts.has(a!) && verts.has(b!)) wires.push([a!, b!]);
    polys.forEach((p, f) => {
      if (p.every((v) => verts.has(v))) faces.add(f);
    });
  } else if (sel.mode === "edge") {
    for (const he of sel.indices) edges.add(canonicalEdge(em, he));
    polys.forEach((_, f) => {
      if (faceHalfEdges(em, f).every((h) => edges.has(canonicalEdge(em, h)))) faces.add(f);
    });
  } else {
    for (const f of sel.indices) faces.add(f);
  }

  let kind: ExtrudeContextKind;
  if (sel.mode === "vertex") kind = verts.size === 0 ? "none" : verts.size === 1 || edges.size + wires.length === 0 ? "verts" : "region";
  else if (sel.mode === "edge") kind = edges.size === 0 ? "none" : faces.size === 0 ? "edges" : "region";
  else kind = faces.size === 0 ? "none" : "region";
  if (kind === "none") return { kind, selection: new Set(sel.indices) };

  const countBefore = em.positions.length / 3;
  let copies: number;
  if (kind === "verts") {
    assignFromData(em, extrudeVertIndiv(meshToData(em), verts));
    copies = verts.size;
  } else if (kind === "edges") {
    extrudeEdges(em, edges);
    copies = em.positions.length / 3 - countBefore;
  } else {
    // What the region does not already hold: edges on none of its faces, vertices on none of its edges.
    const onFaces = new Set<number>();
    const faceVerts = new Set<number>();
    for (const f of faces) {
      for (const h of faceHalfEdges(em, f)) onFaces.add(canonicalEdge(em, h));
      for (const v of polys[f]!) faceVerts.add(v);
    }
    const extraEdges = new Set([...edges].filter((he) => !onFaces.has(he)));
    const edgeVerts = new Set<number>(faceVerts);
    for (const he of extraEdges) (edgeVerts.add(edgeOrigin(em, he)), edgeVerts.add(edgeEnd(em, he)));
    for (const [a, b] of wires) (edgeVerts.add(a), edgeVerts.add(b));
    const extraVerts = new Set([...verts].filter((v) => !edgeVerts.has(v)));
    copies = edgeVerts.size + extraVerts.size;
    extrudeRegion(em, faces, { edges: extraEdges, verts: extraVerts, wires });
  }

  // The copies are appended after every vertex that stays, so they are the last `copies` vertices.
  const total = em.positions.length / 3;
  const made = new Set<number>();
  for (let v = total - copies; v < total; v++) made.add(v);
  const selection = new Set<number>();
  if (sel.mode === "vertex") for (const v of made) selection.add(v);
  else if (sel.mode === "edge")
    forEachEdge(em, (he) => {
      if (made.has(edgeOrigin(em, he)) && made.has(edgeEnd(em, he))) selection.add(canonicalEdge(em, he));
    });
  else
    toPolygons(em).forEach((p, f) => {
      if (p.every((v) => made.has(v))) selection.add(f);
    });
  return { kind, selection };
}

import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { PickingInfo } from "@babylonjs/core/Collisions/pickingInfo";
import { state, status, isMobile, type ComponentMode } from "../../state";
import { buildEditMesh, refreshLoopUVs } from "./build";
import { commitTopology, restorePart, restoreRender, restoreRenderBuffers, snapshotPart, snapshotRender, writeEdgeAttrMetadata, type PartSnapshot, type RenderSnapshot } from "./commit";
import { createOverlay, rebuildOverlay, type EditOverlay } from "./overlay";
import { createComponentGizmo, type ComponentGizmo, type EditGizmoMode } from "./component-gizmo";
import { pickEdge, pickFace, pickVertex } from "./picking";
import { collectBoxSelection } from "./box-select";
import { extrudeContext } from "./extrude-context";
import { bevelEdges, collapseEdges, edgeSlide, insetRegion, INSET_OPERATOR_DEFAULTS, flipDiagonalByVerts, loopCut, mergeAtCenter, subdivideCatmullClark, trisToQuads, triangulateEditFaces, vertexSlide } from "./operators";
import { setCreases, smartUVProject, toggleCreases, toggleSeams } from "./uv-unwrap";
import { planeCut } from "./knife";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { canonicalEdge, creaseOf, edgeEnd, edgeOrigin, faceHalfEdges, faceVerts, forEachEdge, hasNonTriFaces, type EditMesh, rebuildHalfEdges, rebuildPolygons, sourceMesh, toIndexArray, toPolygons, usedVertices } from "./half-edge";
import { deleteGeometryMapped, type DeleteContext, type DeleteGeom } from "../delete-geometry";
import { edgeFaceAdd } from "./face-add";
import { bridgeEditSelection } from "../bridge-selection";
import { assignFromData, meshFromData, meshToData } from "../../lib/mesh";
import { lastSelected, updateGizmo } from "../selection";
import { store } from "../../store";

/**
 * Edit Mode controller. Owns the per-session overlay, gizmo, and box-select
 * UI for the currently edited mesh.
 *
 * State invariants:
 *   state.editMesh !== null ⇔ Edit Mode is active
 *   When active, `currentOverlay` and `currentGizmo` are both non-null.
 */
let currentOverlay: EditOverlay | null = null;
let currentGizmo: ComponentGizmo | null = null;
let boxSelectDiv: HTMLDivElement | null = null;
let boxStart: { x: number; y: number } | null = null;

export function isEditMode(): boolean {
  return state.editMesh !== null;
}

export function toggleEditMode(): void {
  if (isEditMode()) {
    exitEditMode();
  } else {
    const sel = lastSelected();
    if (!sel) {
      status("⚠ Select a mesh before entering Edit Mode");
      return;
    }
    enterEditMode(sel);
  }
}

export function enterEditMode(mesh: AbstractMesh): void {
  // Edit Mode only supports concrete Babylon Meshes (skip bone visuals, lights,
  // ground, etc.) and requires Object Mode tools to be hidden.
  if (!("getVerticesData" in mesh) || typeof mesh.getVerticesData !== "function") {
    status("⚠ Mesh has no editable geometry");
    return;
  }
  const em = buildEditMesh(mesh as Mesh);
  if (!em) {
    status("⚠ Could not build half-edge for this mesh");
    return;
  }
  state.editMesh = em;
  state.editSelection.indices.clear();

  currentOverlay = createOverlay(state.scene, em);
  rebuildOverlay(state.scene, currentOverlay, em, state.editSelection);
  currentGizmo = createComponentGizmo(state.scene, em, state.editSelection, currentOverlay, restoreStale);
  currentGizmo.refresh(em, state.editSelection); // detaches gizmo when empty

  // Hide the object-mode gizmo while we're component-editing.
  updateGizmo();
  store.notify();
  status(isMobile() ? "Edit Mode — Editボタンで戻れる、1/2/3 をパネルから選択" : "Edit Mode — Tab to exit, 1/2/3 for V/E/F");
}

/**
 * After something outside Edit Mode rewrote the UVs of the mesh being edited — the UV editor's Apply, its undo and redo —
 * read them back onto the EditMesh's corners (compat-backlog C123: it holds the UVs per corner, so the next commit would
 * otherwise write the old ones back). In place: the EditMesh, the selection and every history entry that holds it stay
 * valid. No-op unless `mesh` is the one being edited.
 */
export function reloadEditMesh(mesh: AbstractMesh): void {
  if (!state.editMesh || state.editMesh.source !== mesh) return;
  refreshLoopUVs(state.editMesh);
}

/**
 * Undo or redo an Edit Mode entry whose EditMesh is no longer the one being edited — Edit Mode was left, or left and
 * entered again (compat-backlog C127). Every entry keeps the mesh as it was on each side, so it puts that back on the
 * mesh itself; if the mesh is being edited again, its EditMesh is built afresh from it. Until 2026-10-19 a topology
 * step's undo did nothing here (and was spent), and a seam, a crease or a drag wrote its old keys and indices into a
 * mesh another step had renumbered. (Blender goes back into Edit Mode to step through; this stays in the mode it is in.)
 */
function restoreStale(mesh: Mesh, snap: RenderSnapshot | PartSnapshot): void {
  const editing = state.editMesh?.source === mesh;
  if (editing) {
    // A drag held through Ctrl+Z would otherwise be recorded from inside this undo when the gizmo goes.
    currentGizmo?.cancelDrag();
    exitEditMode();
  }
  if ("part" in snap) restorePart(mesh, snap);
  else restoreRenderBuffers(mesh, snap);
  if (editing) enterEditMode(mesh);
  store.notify();
}

export function exitEditMode(): void {
  if (!state.editMesh) return;
  // Position buffer is already committed each drag; nothing more to write back.
  currentGizmo?.dispose();
  currentOverlay?.dispose();
  currentGizmo = null;
  currentOverlay = null;
  state.editMesh = null;
  state.editSelection.indices.clear();
  cleanupBoxSelect();
  updateGizmo();
  // The screen follows state.editMesh (tab, panel, button state) — ADR-014.
  store.notify();
  status("Object Mode");
}

/**
 * Switch the component gizmo between Move / Rotate / Scale (keys G / R / S
 * in Edit Mode). No-op outside Edit Mode.
 */
export function setEditGizmoMode(mode: EditGizmoMode): void {
  if (!state.editMesh || !currentGizmo) return;
  currentGizmo.setMode(mode);
  store.notify();
  status(`Gizmo: ${mode}`);
}

/** Current gizmo transform mode ("move" outside Edit Mode). */
export function getEditGizmoMode(): EditGizmoMode {
  return currentGizmo?.mode ?? "move";
}

export function setComponentMode(mode: ComponentMode): void {
  if (!state.editMesh || !currentOverlay || !currentGizmo) return;
  if (state.editSelection.mode === mode) return;
  state.editSelection.mode = mode;
  state.editSelection.indices.clear();
  rebuildOverlay(state.scene, currentOverlay, state.editMesh, state.editSelection);
  currentGizmo.refresh(state.editMesh, state.editSelection);
  store.notify();
}

export function selectAllComponents(): void {
  if (!state.editMesh || !currentOverlay || !currentGizmo) return;
  const sel = state.editSelection;
  sel.indices.clear();
  const em = state.editMesh;
  if (sel.mode === "vertex") {
    const used = usedVertices(em);
    for (let i = 0; i < em.vertices.length; i++) if (used[i]) sel.indices.add(i);
  } else if (sel.mode === "edge") {
    for (let i = 0; i < em.halfEdges.length; i++) {
      const twin = em.halfEdges[i]!.twin;
      if (twin < 0 || i < twin) sel.indices.add(i);
    }
  } else {
    for (let i = 0; i < em.faces.length; i++) sel.indices.add(i);
  }
  rebuildOverlay(state.scene, currentOverlay, em, sel);
  currentGizmo.refresh(em, sel);
  status(`Selected ${sel.indices.size} ${sel.mode}(s)`);
}

export function clearComponentSelection(): void {
  if (!state.editMesh || !currentOverlay || !currentGizmo) return;
  state.editSelection.indices.clear();
  rebuildOverlay(state.scene, currentOverlay, state.editMesh, state.editSelection);
  currentGizmo.refresh(state.editMesh, state.editSelection);
}

/**
 * Run a topology operator + commit to Babylon + rebuild overlay/gizmo + push
 * an undo entry. Used by Extrude / Delete / etc.
 *
 * The undo entry snapshots full geometry (positions + indices + selection)
 * which is heavy per entry but matches `state.history.maxSize = 50` so worst
 * case memory is bounded. Compaction can come later if it shows up in
 * profiles.
 */
function applyTopologyOp(label: string, op: () => Set<number>): void {
  if (!state.editMesh || !currentOverlay || !currentGizmo) return;
  const em = state.editMesh;
  // A topology commit renumbers the render buffer; per-target position buffers cannot follow (C123 review).
  if (sourceMesh(em).morphTargetManager?.numTargets) {
    status(`⚠ ${label}: このメッシュにはモーフターゲットがある ― 先に外す`);
    return;
  }
  // The whole EditMesh, every layer with it (UVs per corner, colours, groups, flags — compat-backlog C123: until then
  // the positions, polygons, seams, creases and wires only, so an undo re-read the UVs off whatever the buffer held).
  const before = { data: meshToData(em), render: snapshotRender(em), selection: new Set(state.editSelection.indices), mode: state.editSelection.mode };
  const newSel = op();
  state.editSelection.indices = newSel;
  commitTopology(em);
  rebuildOverlay(state.scene, currentOverlay, em, state.editSelection);
  currentGizmo.refresh(em, state.editSelection);
  store.notify();

  const after = { data: meshToData(em), render: snapshotRender(em), selection: new Set(state.editSelection.indices), mode: state.editSelection.mode };
  const overlayRef = currentOverlay;
  const gizmoRef = currentGizmo;
  const restore = (snap: typeof after): void => {
    if (state.editMesh !== em || !overlayRef || !gizmoRef) {
      restoreStale(sourceMesh(em), snap.render);
      return;
    }
    assignFromData(em, snap.data);
    // The buffer exactly as it was — not rendered again, which would number its vertices afresh.
    restoreRender(em, snap.render);
    state.editSelection.indices = new Set(snap.selection);
    state.editSelection.mode = snap.mode;
    rebuildOverlay(state.scene, overlayRef, em, state.editSelection);
    gizmoRef.refresh(em, state.editSelection);
    store.notify();
  };
  state.history.push({ label, undo: () => restore(before), redo: () => restore(after) });
  status(`${label} — ${newSel.size} selected`);
}

export function extrudeSelection(): void {
  const em = state.editMesh;
  if (!em) return;
  if (state.editSelection.indices.size === 0) {
    status("⚠ Select to extrude");
    return;
  }
  const sel = { mode: state.editSelection.mode, indices: new Set(state.editSelection.indices) };
  // The E key is Blender's Extrude (`MESH_OT_extrude_context`): vertices alone, edges alone into fins, or the region,
  // from the mode and the selection; the copies come back selected in the same mode (compat-backlog C126).
  applyTopologyOp("Extrude " + sel.mode, () => extrudeContext(em, sel).selection);
}

export function deleteSelection(): void {
  const em = state.editMesh;
  if (!em) return;
  if (state.editSelection.indices.size === 0) {
    status("⚠ Nothing selected");
    return;
  }
  const sel = new Set(state.editSelection.indices);
  const mode = state.editSelection.mode;
  // Blender's Delete menu by the select mode (`MESH_OT_delete`, `bmesh.ops.delete`): Vertices takes every edge and
  // face on them, Edges the faces on them and the vertices left with no edge, Faces the edges and vertices only they
  // used. The other edges of a removed face stay as wire edges. Done by `deleteGeometry` (the `delete-bpy-*` rows) and
  // put back without renumbering: the removed vertices stay in the arrays, unused, and are not drawn.
  const context: DeleteContext = mode === "vertex" ? "VERTS" : mode === "edge" ? "EDGES" : "FACES";
  const geom: DeleteGeom =
    mode === "vertex"
      ? { verts: sel }
      : mode === "edge"
        ? { edges: [...sel].map((he): [number, number] => [edgeOrigin(em, he), edgeEnd(em, he)]) }
        : { faces: sel };
  applyTopologyOp("Delete " + mode, () => {
    const { data, source } = deleteGeometryMapped(
      { positions: em.positions, polys: toPolygons(em), edges: (em.wireEdges ?? []).map((e) => [...e]) },
      geom,
      context,
    );
    rebuildPolygons(em, em.positions, data.polys.map((p) => p.map((v) => source[v]!)));
    em.wireEdges = (data.edges ?? []).map((e) => [source[e[0]!]!, source[e[1]!]!]);
    return new Set<number>();
  });
}

export function insetSelection(): void {
  const em = state.editMesh;
  if (!em) return;
  if (state.editSelection.mode !== "face") {
    status("⚠ Inset: face mode only");
    return;
  }
  if (state.editSelection.indices.size === 0) {
    status("⚠ Select faces to inset");
    return;
  }
  const sel = new Set(state.editSelection.indices);
  // The I key: Blender's Inset — one region, the amount a thickness in model units (compat-backlog C108).
  applyTopologyOp("Inset", () => insetRegion(em, sel, { ...INSET_OPERATOR_DEFAULTS, thickness: state.editConfig.insetAmount }));
}

export function flipDiagonalSelection(): void {
  const em = state.editMesh;
  if (!em) return;
  if (state.editSelection.mode !== "vertex") {
    status("⚠ Flip Diagonal: vertex mode only — pick 2 verts in adjacent tris");
    return;
  }
  if (state.editSelection.indices.size !== 2) {
    status("⚠ Flip Diagonal: select exactly 2 vertices");
    return;
  }
  const sel = new Set(state.editSelection.indices);
  applyTopologyOp("Flip Diagonal", () => {
    const result = flipDiagonalByVerts(em, sel);
    if (result.size === 0) {
      status("⚠ Flip Diagonal: verts must be the 3rd-verts of adjacent triangles");
      return new Set();
    }
    return result;
  });
}

// ── Knife V2 (freehand cut) ────────────────────────────────────────────────

let knifeSvg: SVGSVGElement | null = null;
let knifeLine: SVGLineElement | null = null;
let knifeStart: { x: number; y: number } | null = null;

/**
 * Arm the interactive Knife: the next drag on the viewport draws a cut line,
 * and on release every mesh edge crossing the camera-space cutting plane
 * (within the drawn segment's screen extent) is split — Blender's knife with
 * cut-through ON (front and back faces are cut alike; no occlusion test).
 * Returns true if Edit Mode swallowed the keystroke.
 */
export function startKnifeCut(): boolean {
  if (!state.editMesh) return false;
  const canvas = state.canvas;
  const onMove = (e: PointerEvent): void => {
    if (!knifeStart) return;
    if (!knifeSvg) {
      knifeSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      knifeSvg.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9999;";
      knifeLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
      knifeLine.setAttribute("stroke", "rgba(255,220,80,0.95)");
      knifeLine.setAttribute("stroke-width", "1.5");
      knifeLine.setAttribute("stroke-dasharray", "6 4");
      knifeSvg.appendChild(knifeLine);
      document.body.appendChild(knifeSvg);
    }
    knifeLine!.setAttribute("x1", String(knifeStart.x));
    knifeLine!.setAttribute("y1", String(knifeStart.y));
    knifeLine!.setAttribute("x2", String(e.clientX));
    knifeLine!.setAttribute("y2", String(e.clientY));
  };
  const onDown = (e: PointerEvent): void => {
    knifeStart = { x: e.clientX, y: e.clientY };
    canvas.addEventListener("pointermove", onMove);
  };
  const onUp = (e: PointerEvent): void => {
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointerup", onUp);
    const start = knifeStart;
    cleanupKnife();
    if (!start) return;
    const rect = state.canvas.getBoundingClientRect();
    executeKnifeCut(
      start.x - rect.left,
      start.y - rect.top,
      e.clientX - rect.left,
      e.clientY - rect.top,
    );
  };
  canvas.addEventListener("pointerdown", onDown, { once: true });
  canvas.addEventListener("pointerup", onUp);
  status("Knife — ドラッグで切断線を引く（表裏とも切れる）");
  return true;
}

function cleanupKnife(): void {
  knifeSvg?.remove();
  knifeSvg = null;
  knifeLine = null;
  knifeStart = null;
}

/**
 * Turn the drawn screen segment (canvas-relative px) into a local-space
 * cutting plane and run {@link planeCut} through the standard topology-op
 * pipeline. The plane is spanned by three unprojected points (near₁, far₁,
 * far₂) — valid for perspective and orthographic cameras alike — and mapped
 * into mesh-local space before cutting, which stays correct under any affine
 * mesh transform.
 */
function executeKnifeCut(x1: number, y1: number, x2: number, y2: number): void {
  const em = state.editMesh;
  if (!em || !currentOverlay || !currentGizmo) return;
  if (Math.hypot(x2 - x1, y2 - y1) < 8) {
    status("⚠ Knife: ドラッグで切断線を引く");
    return;
  }
  const scene = state.scene;
  const camera = scene.activeCamera;
  if (!camera) return;
  const engine = scene.getEngine();
  const w = engine.getRenderWidth();
  const h = engine.getRenderHeight();
  const view = scene.getViewMatrix();
  const proj = scene.getProjectionMatrix();
  const unproject = (sx: number, sy: number, z: number): Vector3 =>
    Vector3.Unproject(new Vector3(sx, sy, z), w, h, Matrix.Identity(), view, proj);

  // Plane through the eye containing both pick rays = through (near₁, far₁,
  // far₂). Mapped to local space point-by-point (affine maps keep planes flat).
  const invWorld = sourceMesh(em).getWorldMatrix().clone().invert();
  const a = Vector3.TransformCoordinates(unproject(x1, y1, 0), invWorld);
  const b = Vector3.TransformCoordinates(unproject(x1, y1, 1), invWorld);
  const c = Vector3.TransformCoordinates(unproject(x2, y2, 1), invWorld);
  const n = Vector3.Cross(b.subtract(a), c.subtract(a));
  if (n.lengthSquared() < 1e-18) {
    status("⚠ Knife: 切断線が不正 (線を引き直して)");
    return;
  }

  // Accept only cut points whose screen projection falls within the drawn
  // segment (±2% pad) — the plane itself is infinite.
  const worldMatrix = sourceMesh(em).getWorldMatrix();
  const vp = camera.viewport.toGlobal(w, h);
  const transform = scene.getTransformMatrix();
  const segDx = x2 - x1;
  const segDy = y2 - y1;
  const segLen2 = segDx * segDx + segDy * segDy;
  const tmp = new Vector3();
  const accept = (lx: number, ly: number, lz: number): boolean => {
    tmp.copyFromFloats(lx, ly, lz);
    const s = Vector3.Project(tmp, worldMatrix, transform, vp);
    if (s.z < 0 || s.z > 1) return false;
    const t = ((s.x - x1) * segDx + (s.y - y1) * segDy) / segLen2;
    return t >= -0.02 && t <= 1.02;
  };

  const hadPolys = hasNonTriFaces(em);
  applyTopologyOp("Knife", () => {
    const result = planeCut(em.positions, toIndexArray(em), [a.x, a.y, a.z], [n.x, n.y, n.z], accept);
    if (!result) {
      status("⚠ Knife: 切断線がメッシュの辺を横切っていない");
      return new Set(state.editSelection.indices);
    }
    // planeCut is triangle-based: quads / n-gons are fan-triangulated by the
    // cut (V2 limitation — undo restores them).
    if (hadPolys) status("Knife: 多角形面は三角形化して切断（Undo で戻る）");
    rebuildHalfEdges(em, result.positions, result.indices);
    // The fresh cut verts are the natural follow-up selection (drag the new
    // edge loop into shape) — switch to vertex mode.
    state.editSelection.mode = "vertex";
    return result.newVerts;
  });
}

/**
 * Toggle seam markers on the currently selected edges. Seams are visualized
 * as red lines and used by Unwrap to break face clusters.
 */
export function markSeamSelection(): void {
  const em = state.editMesh;
  if (!em || !currentOverlay) return;
  if (state.editSelection.mode !== "edge") {
    status("⚠ Mark Seam: edge mode only");
    return;
  }
  if (state.editSelection.indices.size === 0) {
    status("⚠ Select edges to mark/unmark as seams");
    return;
  }
  const sel = new Set(state.editSelection.indices);
  const before = new Set(em.seams);
  const renderBefore = snapshotPart(sourceMesh(em), []);
  toggleSeams(em, sel);
  const after = new Set(em.seams);
  writeEdgeAttrMetadata(em);
  const renderAfter = snapshotPart(sourceMesh(em), []);
  rebuildOverlay(state.scene, currentOverlay, em, state.editSelection);
  const restore = (keys: Set<string>, render: PartSnapshot): void => {
    if (state.editMesh !== em) return restoreStale(sourceMesh(em), render);
    em.seams.clear();
    for (const k of keys) em.seams.add(k);
    writeEdgeAttrMetadata(em);
    if (currentOverlay) rebuildOverlay(state.scene, currentOverlay, em, state.editSelection);
  };
  state.history.push({
    label: "Mark Seam",
    undo() { restore(before, renderBefore); },
    redo() { restore(after, renderAfter); },
  });
  status(`Seams: ${em.seams.size} edge(s)`);
}

/**
 * Toggle Catmull-Clark crease markers on the selected edges (Edge mode).
 * Creased edges stay sharp under Subdivide; visualized as cyan lines. Weight
 * comes from `editConfig.creaseWeight` (Blender's 0..1; 1 = sharp at every
 * subdivision level).
 */
export function markCreaseSelection(): void {
  const em = state.editMesh;
  if (!em || !currentOverlay) return;
  if (state.editSelection.mode !== "edge") {
    status("⚠ Mark Crease: edge mode only");
    return;
  }
  if (state.editSelection.indices.size === 0) {
    status("⚠ Select edges to mark/unmark as creases");
    return;
  }
  const sel = new Set(state.editSelection.indices);
  const before = new Map(em.creases);
  const renderBefore = snapshotPart(sourceMesh(em), []);
  toggleCreases(em, sel, state.editConfig.creaseWeight);
  const after = new Map(em.creases);
  writeEdgeAttrMetadata(em);
  const renderAfter = snapshotPart(sourceMesh(em), []);
  rebuildOverlay(state.scene, currentOverlay, em, state.editSelection);
  const restore = (m: Map<string, number>, render: PartSnapshot): void => {
    if (state.editMesh !== em) return restoreStale(sourceMesh(em), render);
    em.creases.clear();
    for (const [k, v] of m) em.creases.set(k, v);
    writeEdgeAttrMetadata(em);
    if (currentOverlay) rebuildOverlay(state.scene, currentOverlay, em, state.editSelection);
  };
  state.history.push({
    label: "Mark Crease",
    undo() { restore(before, renderBefore); },
    redo() { restore(after, renderAfter); },
  });
  status(`Creases: ${em.creases.size} edge(s)`);
}

/**
 * Assign the Crease slider value EXACTLY to the selected edges — unlike
 * Mark Crease (Shift+E, toggle) this overwrites their current crease, and 0
 * clears it. The precision tool for per-edge sharpness.
 */
export function setCreaseSelection(): void {
  const em = state.editMesh;
  if (!em || !currentOverlay) return;
  if (state.editSelection.mode !== "edge") {
    status("⚠ Set Crease: edge mode only");
    return;
  }
  if (state.editSelection.indices.size === 0) {
    status("⚠ Select edges to set the crease");
    return;
  }
  const crease = state.editConfig.creaseWeight;
  const sel = new Set(state.editSelection.indices);
  const before = new Map(em.creases);
  const renderBefore = snapshotPart(sourceMesh(em), []);
  setCreases(em, sel, crease);
  const after = new Map(em.creases);
  writeEdgeAttrMetadata(em);
  const renderAfter = snapshotPart(sourceMesh(em), []);
  rebuildOverlay(state.scene, currentOverlay, em, state.editSelection);
  const restore = (m: Map<string, number>, render: PartSnapshot): void => {
    if (state.editMesh !== em) return restoreStale(sourceMesh(em), render);
    em.creases.clear();
    for (const [k, v] of m) em.creases.set(k, v);
    writeEdgeAttrMetadata(em);
    if (currentOverlay) rebuildOverlay(state.scene, currentOverlay, em, state.editSelection);
  };
  state.history.push({
    label: "Set Crease",
    undo() { restore(before, renderBefore); },
    redo() { restore(after, renderAfter); },
  });
  status(crease > 0
    ? `Crease = ${crease}: ${sel.size} edge(s)`
    : `Crease cleared: ${sel.size} edge(s)`);
}

/**
 * Run Smart UV Project on the active EditMesh: the UVs go onto its face corners and the topology commit splits the render
 * buffer along the islands' edges (the EditMesh keeps its vertices). Skin weights are sampled across by the commit. Morph
 * targets abort — their per-target position buffers cannot survive the render vertex count changing.
 */
export function unwrapMesh(): void {
  const em = state.editMesh;
  if (!em || !currentOverlay || !currentGizmo) return;
  const mesh = sourceMesh(em);
  if (mesh.morphTargetManager) {
    status("⚠ Unwrap: mesh has morph targets — clear them first");
    return;
  }
  const result = smartUVProject(em, { method: state.editConfig.unwrapMethod });
  // The result is the input's faces, grouped by island, over split vertices (`faces` names each): each corner's UV is the
  // UV of its vertex there, and goes onto that face's corner. The commit splits the render buffer by them (compat-backlog
  // C123: until then this wrote its own buffer and renumbered the EditMesh to it, the seams and creases left on the old
  // numbers). The corners are in the face's own order — `faceVerts`, which the unwrap read them in.
  const uvs: number[][][] = em.faces.map((_, f) => faceVerts(em, f).map(() => [0, 0]));
  result.polys.forEach((p, k) => {
    uvs[result.faces[k]!] = p.map((v) => [result.uvs[v * 2]!, result.uvs[v * 2 + 1]!]);
  });
  applyTopologyOp("Unwrap", () => {
    em.loopUVs = uvs;
    return new Set<number>();
  });
  const methodLabel = state.editConfig.unwrapMethod === "conformal" ? "Conformal (LSCM)" : "Project";
  status(`Unwrap [${methodLabel}]: ${em.vertices.length} verts, ${em.faces.length} faces`);
}


/**
 * The faces a selection selects, as Blender flushes it (`EDBM_selectmode_flush`): in face mode the faces themselves; in
 * vertex mode every face all of whose corners are selected; in edge mode every face all of whose edges are.
 */
export function selectedFacesFlushed(em: EditMesh, mode: "vertex" | "edge" | "face", ids: ReadonlySet<number>): Set<number> {
  if (mode === "face") return new Set(ids);
  const out = new Set<number>();
  const edges = mode === "edge" ? new Set([...ids].map((he) => canonicalEdge(em, he))) : null;
  for (let f = 0; f < em.faces.length; f++) {
    const ok =
      mode === "vertex"
        ? faceVerts(em, f).every((v) => ids.has(v))
        : faceHalfEdges(em, f).every((he) => edges!.has(canonicalEdge(em, he)));
    if (ok) out.add(f);
  }
  return out;
}

/**
 * Run a face operator on the faces a selection selects, as Blender's Tris to Quads and Triangulate do: the faces only
 * (`faces=%hf`), and afterwards the select mode kept and its selection the old one plus the operator's output faces
 * (`faces.out`, flushed) — so a region picked by vertices stays picked. Returns the new selection's ids in `mode`, or
 * null when the operator changed nothing (`em` is then as it was). Edge ids come back canonical. Pure: the GUI runs it
 * on a copy and writes the copy back inside its undo step (compat-backlog C117).
 */
export function convertSelectedFaces(
  em: EditMesh,
  mode: "vertex" | "edge" | "face",
  ids: ReadonlySet<number>,
  op: (em: EditMesh, faces: ReadonlySet<number>) => Set<number>,
): Set<number> | null {
  const faces = selectedFacesFlushed(em, mode, ids);
  if (faces.size === 0) return null;
  const pair = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const faceKey = (f: number): string => [...faceVerts(em, f)].sort((x, y) => x - y).join(",");
  // The old selection, by vertices: the operators keep every vertex's number and renumber edges and faces.
  const before =
    mode === "vertex"
      ? new Set([...ids].map(String))
      : mode === "edge"
        ? new Set([...ids].map((he) => pair(edgeOrigin(em, he), edgeEnd(em, he))))
        : new Set([...ids].map(faceKey));
  const out = op(em, faces);
  if (out.size === 0) return null;
  const sel = new Set<number>();
  if (mode === "vertex") {
    for (const v of ids) sel.add(v);
    for (const f of out) for (const v of faceVerts(em, f)) sel.add(v);
  } else if (mode === "edge") {
    const fresh = new Set<string>();
    for (const f of out) for (const he of faceHalfEdges(em, f)) fresh.add(pair(edgeOrigin(em, he), edgeEnd(em, he)));
    forEachEdge(em, (he) => {
      const k = pair(edgeOrigin(em, he), edgeEnd(em, he));
      if (before.has(k) || fresh.has(k)) sel.add(canonicalEdge(em, he));
    });
  } else {
    for (let f = 0; f < em.faces.length; f++) if (out.has(f) || before.has(faceKey(f))) sel.add(f);
  }
  return sel;
}

/** Tris to Quads / Triangulate from the GUI: tried on a copy, so a selection that changes nothing leaves all as it was. */
function convertSelection(label: string, op: (em: EditMesh, faces: ReadonlySet<number>) => Set<number>, nothing: string): void {
  const em = state.editMesh;
  if (!em) return;
  const { mode, indices } = state.editSelection;
  if (selectedFacesFlushed(em, mode, indices).size === 0) {
    status(`⚠ ${label}: 面を選んでから（頂点・辺はそれが囲む面）`);
    return;
  }
  const trial = meshFromData(meshToData(em));
  const sel = convertSelectedFaces(trial, mode, indices, op);
  if (!sel) {
    status(`⚠ ${label}: ${nothing}`);
    return;
  }
  applyTopologyOp(label, () => {
    assignFromData(em, meshToData(trial));
    return sel;
  });
}

/**
 * Join adjacent coplanar triangles into quads (Blender's Tris to Quads) — on the selected faces only, as the operator
 * runs `join_triangles faces=%hf`; vertices and edges select the faces they enclose. Nothing selected: nothing happens
 * (compat-backlog C117; until 2026-10-15 anything but a face selection converted the whole mesh).
 */
export function trisToQuadsSelection(): void {
  convertSelection("Tris to Quads", trisToQuadsOperator, "結合できる三角形ペアがない（共面 + 凸の四角形のみ）");
}

/**
 * Tris to Quads with the operator's defaults: 40° face and shape thresholds — but with exactly two faces selected no
 * limit at all (`edbm_tris_convert_to_quads_exec`, `is_face_pair` → 180°, "useful for one off joins while editing").
 */
export function trisToQuadsOperator(em: EditMesh, faces: ReadonlySet<number>): Set<number> {
  return faces.size === 2 ? trisToQuads(em, faces, 180, 180) : trisToQuads(em, faces);
}

/**
 * Triangulate quads / n-gons (Blender's Triangulate Faces) — the selected faces only (`triangulate faces=%hf`), vertices
 * and edges selecting the faces they enclose; nothing selected, nothing happens (compat-backlog C117).
 */
export function quadsToTrisSelection(): void {
  convertSelection("Quads to Tris", (m, faces) => triangulateEditFaces(m, faces), "三角形化する多角形面がない");
}

/**
 * Catmull-Clark subdivision surface — one smooth level per press over the
 * whole mesh (repeat for more). Global by nature, so selection is ignored.
 * Guards against morph targets (vertex-count change would corrupt them).
 */
export function subdivideSelection(): void {
  const em = state.editMesh;
  if (!em) return;
  if (sourceMesh(em).morphTargetManager) {
    status("⚠ Subdivide: モーフターゲット付きは不可（頂点数が変わるため、モーフ作成前に）");
    return;
  }
  const beforeFaces = em.faces.length;
  if (beforeFaces > 20000) {
    status("⚠ Subdivide: 面数が多すぎる（2万面上限）— 先に Decimate / 分割数を下げて");
    return;
  }
  applyTopologyOp("Subdivide (Catmull-Clark)", () => {
    subdivideCatmullClark(em, 1);
    // All component ids are fresh after the rebuild — start clean.
    state.editSelection.mode = "face";
    return new Set<number>();
  });
  status(`Subdivide: ${beforeFaces} → ${em.faces.length} faces`);
}

export function loopCutSelection(): void {
  const em = state.editMesh;
  if (!em) return;
  if (state.editSelection.mode !== "edge") {
    status("⚠ Loop Cut: edge mode only");
    return;
  }
  if (state.editSelection.indices.size === 0) {
    status("⚠ Select a seed edge for Loop Cut");
    return;
  }
  // Take the first selected edge as the seed; the ring through it (quads
  // only, as Blender's) is what gets cut.
  const seed = state.editSelection.indices.values().next().value!;
  applyTopologyOp("Loop Cut", () => {
    const info: { innerEdges?: Set<number> } = {};
    const newVerts = loopCut(
      em,
      seed,
      { cuts: state.editConfig.loopCutCuts, smoothness: state.editConfig.loopCutSmoothness },
      info,
    );
    if (newVerts.size === 0) {
      status("⚠ Loop Cut: nothing to cut from this seed");
      return new Set();
    }
    // As Blender leaves it (`SUBDIV_SELECT_LOOPCUT`): the new loops' edges in
    // edge mode — Edge Slide moves them next.
    state.editSelection.mode = "edge";
    return info.innerEdges!;
  });
}

export function bevelSelection(): void {
  const em = state.editMesh;
  if (!em) return;
  if (state.editSelection.mode !== "edge") {
    status("⚠ Bevel: edge mode only");
    return;
  }
  if (state.editSelection.indices.size === 0) {
    status("⚠ Select edges to bevel");
    return;
  }
  const sel = new Set(state.editSelection.indices);
  // Bevel produces face geometry — flip the selection mode so the user can
  // immediately see and tweak the resulting chamfer with the standard gizmo.
  applyTopologyOp("Bevel", () => {
    const info = { skipped: 0 };
    // `bpy.ops.mesh.bevel` slides along unbeveled edges (`loop_slide` on), which the bmesh operator does not.
    const newFaces = bevelEdges(em, sel, { offset: state.editConfig.bevelOffset, offsetType: "PERCENT", loopSlide: true }, info);
    if (newFaces.size === 0) {
      status("⚠ Bevel: nothing was beveled");
      return new Set();
    }
    if (info.skipped > 0) {
      status(`Bevel: ${info.skipped} 辺は境界（面が片側だけ）なのでスキップ`);
    }
    state.editSelection.mode = "face";
    return newFaces;
  });
}

/**
 * Slide the selected edge loop sideways by `editConfig.slideAmount`
 * (sign = side). Repeat presses accumulate — nudge, check, nudge again.
 */
export function edgeSlideSelection(): void {
  const em = state.editMesh;
  if (!em) return;
  if (state.editSelection.mode !== "edge") {
    status("⚠ Edge Slide: edge mode only");
    return;
  }
  if (state.editSelection.indices.size === 0) {
    status("⚠ Select edges to slide");
    return;
  }
  const t = state.editConfig.slideAmount;
  if (t === 0) {
    status("⚠ Slide Amount が 0 — スライダーで量を設定");
    return;
  }
  const sel = new Set(state.editSelection.indices);
  applyTopologyOp("Edge Slide", () => edgeSlide(em, sel, t));
}

/**
 * Slide one vertex along its shared edge with another. Selection order
 * matters: first pick = anchor, second pick (Ctrl+click) = the vert that
 * moves. `slideAmount` sign: positive → toward the anchor, negative → away.
 * Repeat presses accumulate, mirroring Edge Slide's nudge workflow.
 */
export function vertexSlideSelection(): void {
  const em = state.editMesh;
  if (!em) return;
  if (state.editSelection.mode !== "vertex") {
    status("⚠ Vertex Slide: vertex mode only");
    return;
  }
  if (state.editSelection.indices.size !== 2) {
    status("⚠ Vertex Slide: 基準 → 動かす頂点の順に 2 つ選択 (Ctrl+クリック)");
    return;
  }
  const t = state.editConfig.slideAmount;
  if (t === 0) {
    status("⚠ Slide Amount が 0 — スライダーで量を設定");
    return;
  }
  // Set iteration preserves insertion order: [anchor, mover].
  const [anchor, mover] = [...state.editSelection.indices] as [number, number];
  applyTopologyOp("Vertex Slide", () => {
    const result = vertexSlide(em, anchor, mover, t);
    if (result.size === 0) {
      status("⚠ Vertex Slide: 2 頂点が辺で繋がっていない");
      return new Set(state.editSelection.indices);
    }
    // Keep both selected so repeat presses keep sliding the same vert.
    return new Set([anchor, mover]);
  });
}

/**
 * Merge selection: vertex mode = Merge At Center (all → centroid), edge
 * mode = Collapse (each connected edge run → its midpoint). The result is
 * vertex geometry, so the mode switches to vertex for the follow-up.
 */
export function mergeSelection(): void {
  const em = state.editMesh;
  if (!em) return;
  const mode = state.editSelection.mode;
  if (mode === "face") {
    status("⚠ Merge: vertex / edge mode only");
    return;
  }
  if (state.editSelection.indices.size === 0) {
    status("⚠ Select components to merge");
    return;
  }
  const sel = new Set(state.editSelection.indices);
  applyTopologyOp("Merge", () => {
    const result = mode === "vertex" ? mergeAtCenter(em, sel) : collapseEdges(em, sel);
    if (result.size === 0) {
      status("⚠ Merge: 頂点 2 つ以上（または辺）を選択");
      return new Set<number>();
    }
    state.editSelection.mode = "vertex";
    return result;
  });
}

/**
 * Make a face from the selected vertices (or the vertices of the selected
 * edges) — Blender's F, "Make Edge/Face", through `edgeFaceAdd`. Three or more
 * vertices make one face, ordered around their centre and wound to agree with
 * the faces beside it. Two vertices would make a wire edge in Blender; the
 * edit mesh's overlay does not draw wire edges yet, so that case is refused.
 */
export function fillSelection(): void {
  const em = state.editMesh;
  if (!em) return;
  const mode = state.editSelection.mode;
  const verts = new Set<number>();
  if (mode === "vertex") for (const v of state.editSelection.indices) verts.add(v);
  else if (mode === "edge")
    for (const he of state.editSelection.indices) {
      verts.add(edgeOrigin(em, he));
      verts.add(edgeEnd(em, he));
    }
  else {
    status("⚠ Fill (F): vertex / edge mode only");
    return;
  }
  if (verts.size < 3) {
    status("⚠ Fill (F): 頂点を 3 つ以上選択（2 頂点の辺は未対応）");
    return;
  }
  applyTopologyOp("Fill", () => {
    let face: number | null = null;
    try {
      face = edgeFaceAdd(em, verts);
    } catch (err) {
      status("⚠ Fill: " + (err as Error).message);
      return new Set<number>();
    }
    if (face === null) {
      status("⚠ Fill: 既に同じ面があるか、面を作れない配置です");
      return new Set<number>();
    }
    state.editSelection.mode = "face";
    return new Set([face]);
  });
}

/**
 * Bridge Edge Loops — Blender's operator with its defaults (`bridgeEditSelection`, the port of `bridge_loops`; compat-backlog
 * C116): two or more edge loops, of any lengths, joined by the pairing with the least total distance; or, with faces
 * selected, the holes they leave (a tunnel). Any selection mode: vertices and edges select what they enclose, as
 * Blender flushes them.
 */
export function bridgeSelection(): void {
  const em = state.editMesh;
  if (!em) return;
  if (state.editSelection.indices.size === 0) {
    status("⚠ Bridge: 2 つ以上の辺ループ（または面）を選択");
    return;
  }
  const mode = state.editSelection.mode;
  const ids = new Set(state.editSelection.indices);
  const sel = mode === "vertex" ? { verts: ids } : mode === "edge" ? { edges: ids } : { faces: ids };
  // Tried on a copy first: a refused bridge leaves the mesh, the selection and the undo history as they were, and the
  // warning stays on the status line.
  const trial = meshFromData(meshToData(em));
  const result = bridgeEditSelection(trial, sel);
  if (!result) {
    status("⚠ Bridge: つなげる辺ループが 2 つ以上いる（面を選ぶとその穴どうし）");
    return;
  }
  applyTopologyOp("Bridge Loops", () => {
    assignFromData(em, meshToData(trial));
    state.editSelection.mode = "face";
    return result;
  });
}

/**
 * Handle a pointerdown over the viewport while Edit Mode is active. Returns
 * true if the event was consumed (caller should skip default handling).
 *
 * Modifier semantics:
 *   - additive (ctrl): toggle the picked component in the existing selection
 *   - no modifier: replace selection with just the picked component
 *   - missed pick + no modifier: clear selection
 */
export function handleEditModePointerDown(screenX: number, screenY: number, additive: boolean): boolean {
  if (!state.editMesh || !currentOverlay || !currentGizmo) return false;
  // Don't steal clicks that land on any of the gizmo handles.
  if (currentGizmo.isHovered()) return false;

  const em = state.editMesh;
  let picked = -1;
  if (state.editSelection.mode === "vertex") picked = pickVertex(state.scene, em, screenX, screenY);
  else if (state.editSelection.mode === "edge") picked = pickEdge(state.scene, em, screenX, screenY);
  else picked = pickFace(state.scene, em, screenX, screenY);

  if (picked < 0) {
    if (!additive) {
      state.editSelection.indices.clear();
      rebuildOverlay(state.scene, currentOverlay, em, state.editSelection);
      currentGizmo.refresh(em, state.editSelection);
    }
    return true;
  }

  if (additive) {
    if (state.editSelection.indices.has(picked)) {
      state.editSelection.indices.delete(picked);
    } else {
      state.editSelection.indices.add(picked);
    }
  } else {
    state.editSelection.indices.clear();
    state.editSelection.indices.add(picked);
  }
  // Edge readout: surface the picked edge's crease so it is inspectable (the
  // Crease slider and Set Crease edit it).
  if (state.editSelection.mode === "edge") {
    const crease = creaseOf(em, picked);
    if (crease > 0) status(`Crease = ${crease}`);
  }
  rebuildOverlay(state.scene, currentOverlay, em, state.editSelection);
  currentGizmo.refresh(em, state.editSelection);
  return true;
}

/**
 * Begin box select. Returns true if Edit Mode swallowed the keystroke.
 * Subsequent pointer events on the canvas drive the rectangle until release.
 */
export function startBoxSelect(): boolean {
  if (!state.editMesh) return false;
  const canvas = state.canvas;
  const onMove = (e: PointerEvent): void => {
    if (!boxStart) return;
    if (!boxSelectDiv) {
      boxSelectDiv = document.createElement("div");
      boxSelectDiv.style.cssText =
        "position:fixed;pointer-events:none;z-index:9999;" +
        "border:1px solid rgba(255,220,80,0.9);background:rgba(255,220,80,0.1);";
      document.body.appendChild(boxSelectDiv);
    }
    const x = Math.min(boxStart.x, e.clientX);
    const y = Math.min(boxStart.y, e.clientY);
    const w = Math.abs(boxStart.x - e.clientX);
    const h = Math.abs(boxStart.y - e.clientY);
    boxSelectDiv.style.left = x + "px";
    boxSelectDiv.style.top = y + "px";
    boxSelectDiv.style.width = w + "px";
    boxSelectDiv.style.height = h + "px";
  };
  const onDown = (e: PointerEvent): void => {
    boxStart = { x: e.clientX, y: e.clientY };
    canvas.addEventListener("pointermove", onMove);
  };
  const onUp = (e: PointerEvent): void => {
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointerup", onUp);
    if (!boxStart) { cleanupBoxSelect(); return; }
    const rect = state.canvas.getBoundingClientRect();
    const r = {
      x1: boxStart.x - rect.left,
      y1: boxStart.y - rect.top,
      x2: e.clientX - rect.left,
      y2: e.clientY - rect.top,
    };
    boxStart = null;
    cleanupBoxSelect();
    finishBoxSelect(r);
  };
  // Single-shot listeners: next pointerdown starts the box.
  canvas.addEventListener("pointerdown", onDown, { once: true });
  canvas.addEventListener("pointerup", onUp);
  status("Box Select — drag a rectangle");
  return true;
}

function finishBoxSelect(rect: { x1: number; y1: number; x2: number; y2: number }): void {
  if (!state.editMesh || !currentOverlay || !currentGizmo) return;
  const w = Math.abs(rect.x1 - rect.x2);
  const h = Math.abs(rect.y1 - rect.y2);
  if (w < 3 || h < 3) return; // treat tiny boxes as accidental clicks
  const picked = collectBoxSelection(state.scene, state.editMesh, state.editSelection.mode, rect);
  if (picked.size === 0) return;
  // Replace selection (Blender-style B with no modifier).
  state.editSelection.indices = picked;
  rebuildOverlay(state.scene, currentOverlay, state.editMesh, state.editSelection);
  currentGizmo.refresh(state.editMesh, state.editSelection);
  status(`Box selected ${picked.size} ${state.editSelection.mode}(s)`);
}

function cleanupBoxSelect(): void {
  if (boxSelectDiv) {
    boxSelectDiv.remove();
    boxSelectDiv = null;
  }
  boxStart = null;
}

/**
 * Pick-by-faceId for a screen pick — convenience for tests / other callers.
 *
 * @internal
 */
export function pickComponentAt(pi: PickingInfo): number {
  if (!state.editMesh) return -1;
  if (pi.faceId < 0) return -1;
  return pi.faceId;
}


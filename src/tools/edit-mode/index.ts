import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { PickingInfo } from "@babylonjs/core/Collisions/pickingInfo";
import { state, status, E, isMobile, type ComponentMode } from "../../state";
import { buildEditMesh } from "./build";
import { commitTopology, writeEdgeAttrMetadata, writePolyMetadata } from "./commit";
import { createOverlay, rebuildOverlay, type EditOverlay } from "./overlay";
import { createComponentGizmo, type ComponentGizmo, type EditGizmoMode } from "./component-gizmo";
import { pickEdge, pickFace, pickVertex } from "./picking";
import { collectBoxSelection } from "./box-select";
import { bevelEdges, bridgeEdgeLoops, collapseEdges, deleteFaces, deleteFacesByEdges, deleteFacesByVertices, edgeSlide, extrudeEdges, extrudeFaces, insetFaces, knife, loopCut, mergeAtCenter, quadsToTris, subdivideCatmullClark, trisToQuads, vertexSlide } from "./operators";
import { setCreases, smartUVProject, toggleCreases, toggleSeams } from "./uv-unwrap";
import { planeCut } from "./knife";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { creaseOf, hasNonTriFaces, rebuildHalfEdges, rebuildPolygons, toIndexArray, toPolygons, triangulateFaces } from "./half-edge";
import { lastSelected, updateGizmo } from "../selection";
import { updateProperties } from "../../ui/panels";
import { refreshEditToolsUI } from "../../ui/builders";
import { switchTab } from "../../input";

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
  currentGizmo = createComponentGizmo(state.scene, em, state.editSelection, currentOverlay);
  currentGizmo.refresh(em, state.editSelection); // detaches gizmo when empty

  // Hide the object-mode gizmo while we're component-editing.
  updateGizmo();
  applyModeLabel();
  // Auto-jump to the Edit tab so operator buttons + sliders are visible.
  switchTab("edit");
  refreshEditToolsUI();
  // Mobile: hardware Tab key doesn't exist. Open the right panel so the user
  // can actually reach the Mark Seam / Unwrap / V-E-F buttons by tapping.
  // Close the left panel first to mirror togglePanel's "only one open" rule.
  if (isMobile()) {
    const lp = E("lpanel");
    const rp = E("rpanel");
    const ov = E("overlay");
    lp.classList.remove("open");
    rp.classList.add("open");
    ov.classList.add("open");
  }
  // Also reflect the toggle state on the mobile bottom-bar Edit button.
  document.querySelectorAll<HTMLElement>("#btnMobEdit").forEach((b) => b.classList.add("on"));
  status(isMobile() ? "Edit Mode — Editボタンで戻れる、1/2/3 をパネルから選択" : "Edit Mode — Tab to exit, 1/2/3 for V/E/F");
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
  applyModeLabel();
  refreshEditToolsUI();
  // Back to a sensible default tab when leaving Edit Mode.
  switchTab("xform");
  // Clear the mobile bottom-bar Edit button state.
  document.querySelectorAll<HTMLElement>("#btnMobEdit").forEach((b) => b.classList.remove("on"));
  updateProperties();
  status("Object Mode");
}

/**
 * Switch the component gizmo between Move / Rotate / Scale (keys T / R / S
 * in Edit Mode). No-op outside Edit Mode.
 */
export function setEditGizmoMode(mode: EditGizmoMode): void {
  if (!state.editMesh || !currentGizmo) return;
  currentGizmo.setMode(mode);
  refreshEditToolsUI();
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
  applyModeLabel();
  refreshEditToolsUI();
}

export function selectAllComponents(): void {
  if (!state.editMesh || !currentOverlay || !currentGizmo) return;
  const sel = state.editSelection;
  sel.indices.clear();
  const em = state.editMesh;
  if (sel.mode === "vertex") {
    for (let i = 0; i < em.vertices.length; i++) sel.indices.add(i);
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
  // Snapshot POLYGONS (not triangles) so undo/redo restores quads / n-gons.
  // Seams / creases are edge-attribute maps that some ops mutate (Merge remaps
  // seams; Subdivide propagates creases), so snapshot them too.
  const before = {
    positions: new Float32Array(em.positions),
    polys: toPolygons(em),
    seams: new Set(em.seams),
    creases: new Map(em.creases),
    selection: new Set(state.editSelection.indices),
    mode: state.editSelection.mode,
  };
  const newSel = op();
  state.editSelection.indices = newSel;
  commitTopology(em);
  rebuildOverlay(state.scene, currentOverlay, em, state.editSelection);
  currentGizmo.refresh(em, state.editSelection);
  applyModeLabel();
  refreshEditToolsUI();

  const after = {
    positions: new Float32Array(em.positions),
    polys: toPolygons(em),
    seams: new Set(em.seams),
    creases: new Map(em.creases),
    selection: new Set(state.editSelection.indices),
  };
  const overlayRef = currentOverlay;
  const gizmoRef = currentGizmo;
  const restoreEdgeAttrs = (seams: Set<string>, creases: Map<string, number>): void => {
    em.seams = new Set(seams);
    em.creases = new Map(creases);
  };
  state.history.push({
    label,
    undo() {
      if (state.editMesh !== em || !overlayRef || !gizmoRef) return;
      rebuildPolygons(em, new Float32Array(before.positions), before.polys);
      restoreEdgeAttrs(before.seams, before.creases);
      state.editSelection.indices = new Set(before.selection);
      state.editSelection.mode = before.mode;
      commitTopology(em);
      rebuildOverlay(state.scene, overlayRef, em, state.editSelection);
      gizmoRef.refresh(em, state.editSelection);
      applyModeLabel();
      updateProperties();
    },
    redo() {
      if (state.editMesh !== em || !overlayRef || !gizmoRef) return;
      rebuildPolygons(em, new Float32Array(after.positions), after.polys);
      restoreEdgeAttrs(after.seams, after.creases);
      state.editSelection.indices = new Set(after.selection);
      commitTopology(em);
      rebuildOverlay(state.scene, overlayRef, em, state.editSelection);
      gizmoRef.refresh(em, state.editSelection);
      applyModeLabel();
      updateProperties();
    },
  });
  status(`${label} — ${newSel.size} selected`);
}

export function extrudeSelection(): void {
  const em = state.editMesh;
  if (!em) return;
  if (state.editSelection.indices.size === 0) {
    status("⚠ Select to extrude");
    return;
  }
  const sel = new Set(state.editSelection.indices);
  const mode = state.editSelection.mode;
  if (mode === "vertex") {
    // Tri-mesh has no representation for an unanchored edge (a-a' with no face).
    // Skipping vertex extrude entirely — call it out so the user picks a
    // different mode instead of getting a silent no-op.
    status("⚠ Vertex extrude unsupported in tri-mesh — use Edge or Face mode");
    return;
  }
  applyTopologyOp("Extrude " + mode, () => {
    if (mode === "face") return extrudeFaces(em, sel);
    // Edge mode: fin extrusion. Result is face geometry, so switch the
    // overlay to face mode for the natural drag-to-shape follow-up.
    const newFaces = extrudeEdges(em, sel);
    if (newFaces.size > 0) state.editSelection.mode = "face";
    return newFaces;
  });
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
  applyTopologyOp("Delete " + mode, () => {
    if (mode === "face") return deleteFaces(em, sel);
    if (mode === "edge") return deleteFacesByEdges(em, sel);
    return deleteFacesByVertices(em, sel);
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
  applyTopologyOp("Inset", () => insetFaces(em, sel, state.editConfig.insetAmount));
}

export function knifeSelection(): void {
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
    const result = knife(em, sel);
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
  const invWorld = em.source.getWorldMatrix().clone().invert();
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
  const worldMatrix = em.source.getWorldMatrix();
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
  toggleSeams(em, sel);
  const after = new Set(em.seams);
  writeEdgeAttrMetadata(em);
  rebuildOverlay(state.scene, currentOverlay, em, state.editSelection);
  state.history.push({
    label: "Mark Seam",
    undo() { em.seams.clear(); for (const k of before) em.seams.add(k); writeEdgeAttrMetadata(em); if (currentOverlay && state.editMesh === em) rebuildOverlay(state.scene, currentOverlay, em, state.editSelection); },
    redo() { em.seams.clear(); for (const k of after) em.seams.add(k); writeEdgeAttrMetadata(em); if (currentOverlay && state.editMesh === em) rebuildOverlay(state.scene, currentOverlay, em, state.editSelection); },
  });
  status(`Seams: ${em.seams.size} edge(s)`);
}

/**
 * Toggle Catmull-Clark crease markers on the selected edges (Edge mode).
 * Creased edges stay sharp under Subdivide; visualized as cyan lines. Weight
 * comes from `editConfig.creaseWeight` (σ ≥ 1 = fully sharp; a σ of 2 keeps the
 * edge sharp for two subdivision levels then relaxes).
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
  toggleCreases(em, sel, state.editConfig.creaseWeight);
  const after = new Map(em.creases);
  writeEdgeAttrMetadata(em);
  rebuildOverlay(state.scene, currentOverlay, em, state.editSelection);
  const restore = (m: Map<string, number>): void => {
    em.creases.clear();
    for (const [k, v] of m) em.creases.set(k, v);
    writeEdgeAttrMetadata(em);
    if (currentOverlay && state.editMesh === em) rebuildOverlay(state.scene, currentOverlay, em, state.editSelection);
  };
  state.history.push({
    label: "Mark Crease",
    undo() { restore(before); },
    redo() { restore(after); },
  });
  status(`Creases: ${em.creases.size} edge(s)`);
}

/**
 * Assign the Crease Weight slider value EXACTLY to the selected edges — unlike
 * Mark Crease (Shift+E, toggle) this overwrites their current σ, and σ = 0
 * clears the crease. The precision tool for per-edge sharpness.
 */
export function setCreaseSelection(): void {
  const em = state.editMesh;
  if (!em || !currentOverlay) return;
  if (state.editSelection.mode !== "edge") {
    status("⚠ Set Crease: edge mode only");
    return;
  }
  if (state.editSelection.indices.size === 0) {
    status("⚠ Select edges to set crease σ");
    return;
  }
  const sigma = state.editConfig.creaseWeight;
  const sel = new Set(state.editSelection.indices);
  const before = new Map(em.creases);
  setCreases(em, sel, sigma);
  const after = new Map(em.creases);
  writeEdgeAttrMetadata(em);
  rebuildOverlay(state.scene, currentOverlay, em, state.editSelection);
  const restore = (m: Map<string, number>): void => {
    em.creases.clear();
    for (const [k, v] of m) em.creases.set(k, v);
    writeEdgeAttrMetadata(em);
    if (currentOverlay && state.editMesh === em) rebuildOverlay(state.scene, currentOverlay, em, state.editSelection);
  };
  state.history.push({
    label: "Set Crease",
    undo() { restore(before); },
    redo() { restore(after); },
  });
  status(sigma > 0
    ? `Crease σ = ${sigma}: ${sel.size} edge(s)`
    : `Crease cleared: ${sel.size} edge(s)`);
}

/**
 * Run Smart UV Project on the active EditMesh, rebuild the Babylon mesh with
 * the new UVs (vertex count grows: each face becomes 3 unique verts in V1),
 * and re-enter Edit Mode on the rebuilt geometry.
 *
 * Skin weights survive the rebuild: each rebuilt vertex knows its source
 * vertex (`UnwrapResult.sourceVerts`), so MatricesIndices/Weights are copied
 * across. Morph targets still abort — their per-target position buffers
 * cannot survive a vertex-count change.
 */
export function unwrapMesh(): void {
  const em = state.editMesh;
  if (!em || !currentOverlay || !currentGizmo) return;
  const mesh = em.source;
  if (mesh.morphTargetManager) {
    status("⚠ Unwrap: mesh has morph targets — clear them first");
    return;
  }

  // Snapshot for undo.
  const beforePos = new Float32Array(em.positions);
  const beforeIdxRaw = mesh.getIndices() ?? [];
  const beforeIdx: number[] = Array.from(beforeIdxRaw);
  const beforePolys = toPolygons(em);
  const beforeUV = mesh.getVerticesData(VertexBuffer.UVKind);
  const beforeUVCopy = beforeUV ? new Float32Array(beforeUV) : null;
  const beforeMIRaw = mesh.getVerticesData(VertexBuffer.MatricesIndicesKind);
  const beforeMWRaw = mesh.getVerticesData(VertexBuffer.MatricesWeightsKind);
  const beforeMI = beforeMIRaw ? new Float32Array(beforeMIRaw) : null;
  const beforeMW = beforeMWRaw ? new Float32Array(beforeMWRaw) : null;
  const beforeSel = new Set(state.editSelection.indices);
  const beforeMode = state.editSelection.mode;

  const result = smartUVProject(em, { method: state.editConfig.unwrapMethod });

  // Carry skin weights across the rebuild: copy each source vert's 4 influences.
  let afterMI: Float32Array | null = null;
  let afterMW: Float32Array | null = null;
  if (beforeMI && beforeMW) {
    const n = result.sourceVerts.length;
    afterMI = new Float32Array(n * 4);
    afterMW = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const src = result.sourceVerts[i]! * 4;
      for (let k = 0; k < 4; k++) {
        afterMI[i * 4 + k] = beforeMI[src + k]!;
        afterMW[i * 4 + k] = beforeMW[src + k]!;
      }
    }
  }

  // Apply to Babylon mesh.
  const vd = new VertexData();
  vd.positions = new Float32Array(result.positions);
  vd.indices = result.indices.slice();
  vd.uvs = new Float32Array(result.uvs);
  const normals = new Float32Array(result.positions.length);
  VertexData.ComputeNormals(result.positions, result.indices, normals);
  vd.normals = normals;
  if (afterMI && afterMW) {
    vd.matricesIndices = afterMI;
    vd.matricesWeights = afterMW;
  }
  vd.applyToMesh(mesh, true);

  // Rebuild EditMesh + overlay (polygon-preserving: quads survive unwrap).
  rebuildPolygons(em, new Float32Array(result.positions), result.polys);
  syncManualApply(em);
  // After the rebuild, the previous selection's component IDs are stale.
  state.editSelection.indices.clear();
  rebuildOverlay(state.scene, currentOverlay, em, state.editSelection);
  currentGizmo.refresh(em, state.editSelection);
  refreshEditToolsUI();

  const afterPos = new Float32Array(em.positions);
  const afterIdx = result.indices.slice();
  const afterUV = new Float32Array(result.uvs);

  state.history.push({
    label: "Unwrap",
    undo() {
      const m = em.source;
      const vd2 = new VertexData();
      vd2.positions = new Float32Array(beforePos);
      vd2.indices = beforeIdx.slice();
      if (beforeUVCopy) vd2.uvs = new Float32Array(beforeUVCopy);
      if (beforeMI && beforeMW) {
        vd2.matricesIndices = new Float32Array(beforeMI);
        vd2.matricesWeights = new Float32Array(beforeMW);
      }
      const n2 = new Float32Array(beforePos.length);
      VertexData.ComputeNormals(beforePos, beforeIdx, n2);
      vd2.normals = n2;
      vd2.applyToMesh(m, true);
      rebuildPolygons(em, new Float32Array(beforePos), beforePolys);
      syncManualApply(em);
      state.editSelection.indices = new Set(beforeSel);
      state.editSelection.mode = beforeMode;
      if (currentOverlay && state.editMesh === em) rebuildOverlay(state.scene, currentOverlay, em, state.editSelection);
      if (currentGizmo && state.editMesh === em) currentGizmo.refresh(em, state.editSelection);
      refreshEditToolsUI();
    },
    redo() {
      const m = em.source;
      const vd2 = new VertexData();
      vd2.positions = new Float32Array(afterPos);
      vd2.indices = afterIdx.slice();
      vd2.uvs = new Float32Array(afterUV);
      if (afterMI && afterMW) {
        vd2.matricesIndices = new Float32Array(afterMI);
        vd2.matricesWeights = new Float32Array(afterMW);
      }
      const n2 = new Float32Array(afterPos.length);
      VertexData.ComputeNormals(afterPos, afterIdx, n2);
      vd2.normals = n2;
      vd2.applyToMesh(m, true);
      rebuildPolygons(em, new Float32Array(afterPos), result.polys);
      syncManualApply(em);
      state.editSelection.indices.clear();
      if (currentOverlay && state.editMesh === em) rebuildOverlay(state.scene, currentOverlay, em, state.editSelection);
      if (currentGizmo && state.editMesh === em) currentGizmo.refresh(em, state.editSelection);
      refreshEditToolsUI();
    },
  });

  const methodLabel = state.editConfig.unwrapMethod === "conformal" ? "Conformal (LSCM)" : "Project";
  status(`Unwrap [${methodLabel}]: ${em.vertices.length} verts, ${em.faces.length} faces`);
}

/**
 * Re-sync the EditMesh render mapping + polygon metadata after a manual
 * VertexData apply (paths that bypass commitTopology, e.g. Unwrap).
 */
function syncManualApply(em: NonNullable<typeof state.editMesh>): void {
  em.triToFace = triangulateFaces(em).triToFace;
  writePolyMetadata(em);
}

/**
 * Join adjacent coplanar triangles into quads (Blender's Tris to Quads).
 * Face-mode selection limits the scope; otherwise the whole mesh converts.
 */
export function trisToQuadsSelection(): void {
  const em = state.editMesh;
  if (!em) return;
  const sel =
    state.editSelection.mode === "face" && state.editSelection.indices.size > 0
      ? new Set(state.editSelection.indices)
      : null;
  applyTopologyOp("Tris to Quads", () => {
    const result = trisToQuads(em, sel);
    if (result.size === 0) {
      status("⚠ Tris to Quads: 結合できる三角形ペアがない（共面 + 凸の四角形のみ）");
      return new Set<number>();
    }
    state.editSelection.mode = "face";
    return result;
  });
}

/**
 * Fan-triangulate quads / n-gons back to triangles (Blender's Triangulate
 * Faces). Face-mode selection limits the scope; otherwise the whole mesh.
 */
export function quadsToTrisSelection(): void {
  const em = state.editMesh;
  if (!em) return;
  const sel =
    state.editSelection.mode === "face" && state.editSelection.indices.size > 0
      ? new Set(state.editSelection.indices)
      : null;
  applyTopologyOp("Quads to Tris", () => {
    const result = quadsToTris(em, sel);
    if (result.size === 0) {
      status("⚠ Quads to Tris: 三角形化する多角形面がない");
      return new Set<number>();
    }
    state.editSelection.mode = "face";
    return result;
  });
}

/**
 * Catmull-Clark subdivision surface — one smooth level per press over the
 * whole mesh (repeat for more). Global by nature, so selection is ignored.
 * Guards against morph targets (vertex-count change would corrupt them).
 */
export function subdivideSelection(): void {
  const em = state.editMesh;
  if (!em) return;
  if (em.source.morphTargetManager) {
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
  // Take the first selected edge as the loop seed. The walker finds the rest
  // by following the coplanar quad chain.
  const seed = state.editSelection.indices.values().next().value!;
  applyTopologyOp("Loop Cut", () => {
    const newVerts = loopCut(em, seed);
    if (newVerts.size === 0) {
      status("⚠ Loop Cut: no valid loop from this seed (boundary or non-coplanar topology)");
      return new Set();
    }
    // After cut, the natural follow-up is "drag the new ring" — switch to
    // vertex mode so the midpoint verts can be moved with the gizmo.
    state.editSelection.mode = "vertex";
    return newVerts;
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
    const newFaces = bevelEdges(em, sel, state.editConfig.bevelWidth, info);
    if (newFaces.size === 0) {
      status("⚠ Bevel: no beveleable edges in selection (boundary / quad-adjacent edges are skipped)");
      return new Set();
    }
    if (info.skipped > 0) {
      status(`Bevel: ${info.skipped} 辺はスキップ（端点共有 or 多角形面に隣接）— 端点共有分はもう一度 Bevel で面取り`);
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
 * Bridge two boundary edge loops with a quad band. Select all edges of both
 * loops (same vertex count) first — e.g. box-select both tube ends.
 */
export function bridgeSelection(): void {
  const em = state.editMesh;
  if (!em) return;
  if (state.editSelection.mode !== "edge") {
    status("⚠ Bridge: edge mode only");
    return;
  }
  if (state.editSelection.indices.size < 2) {
    status("⚠ Bridge: 2 つの境界ループの辺をすべて選択");
    return;
  }
  const sel = new Set(state.editSelection.indices);
  applyTopologyOp("Bridge Loops", () => {
    const result = bridgeEdgeLoops(em, sel);
    if (result.size === 0) {
      status("⚠ Bridge: 同じ頂点数の境界ループ 2 本が必要（内部辺・分岐は不可）");
      return new Set<number>();
    }
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
  // Edge readout: surface the picked edge's crease σ so per-edge sharpness is
  // inspectable (Set Crease σ / Crease Weight slider edits it).
  if (state.editSelection.mode === "edge") {
    const sigma = creaseOf(em, picked);
    if (sigma > 0) status(`Crease σ = ${sigma}`);
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

function applyModeLabel(): void {
  const label = E("modeL");
  if (!label) return;
  if (!state.editMesh) {
    // Restore the Object Mode label (other tools own their own labels).
    label.textContent = "OBJECT";
    return;
  }
  const m = state.editSelection.mode;
  const code = m === "vertex" ? "V" : m === "edge" ? "E" : "F";
  label.textContent = `EDIT (${code})`;
}

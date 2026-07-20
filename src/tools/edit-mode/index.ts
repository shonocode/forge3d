import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { PickingInfo } from "@babylonjs/core/Collisions/pickingInfo";
import { state, status, E, isMobile, type ComponentMode } from "../../state";
import { buildEditMesh } from "./build";
import { commitTopology } from "./commit";
import { createOverlay, rebuildOverlay, type EditOverlay } from "./overlay";
import { createComponentGizmo, type ComponentGizmo, type EditGizmoMode } from "./component-gizmo";
import { pickEdge, pickFace, pickVertex } from "./picking";
import { collectBoxSelection } from "./box-select";
import { bevelEdges, bridgeEdgeLoops, collapseEdges, deleteFaces, deleteFacesByEdges, deleteFacesByVertices, edgeSlide, extrudeEdges, extrudeFaces, insetFaces, knife, loopCut, mergeAtCenter } from "./operators";
import { smartUVProject, toggleSeams } from "./uv-unwrap";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { rebuildHalfEdges, toIndexArray } from "./half-edge";
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
  const before = {
    positions: new Float32Array(em.positions),
    indices: toIndexArray(em),
    selection: new Set(state.editSelection.indices),
    mode: state.editSelection.mode,
  };
  const newSel = op();
  state.editSelection.indices = newSel;
  commitTopology(em, toIndexArray(em));
  rebuildOverlay(state.scene, currentOverlay, em, state.editSelection);
  currentGizmo.refresh(em, state.editSelection);
  applyModeLabel();
  refreshEditToolsUI();

  const after = {
    positions: new Float32Array(em.positions),
    indices: toIndexArray(em),
    selection: new Set(state.editSelection.indices),
  };
  const overlayRef = currentOverlay;
  const gizmoRef = currentGizmo;
  state.history.push({
    label,
    undo() {
      if (state.editMesh !== em || !overlayRef || !gizmoRef) return;
      rebuildHalfEdges(em, new Float32Array(before.positions), before.indices.slice());
      state.editSelection.indices = new Set(before.selection);
      state.editSelection.mode = before.mode;
      commitTopology(em, toIndexArray(em));
      rebuildOverlay(state.scene, overlayRef, em, state.editSelection);
      gizmoRef.refresh(em, state.editSelection);
      applyModeLabel();
      updateProperties();
    },
    redo() {
      if (state.editMesh !== em || !overlayRef || !gizmoRef) return;
      rebuildHalfEdges(em, new Float32Array(after.positions), after.indices.slice());
      state.editSelection.indices = new Set(after.selection);
      commitTopology(em, toIndexArray(em));
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
  rebuildOverlay(state.scene, currentOverlay, em, state.editSelection);
  state.history.push({
    label: "Mark Seam",
    undo() { em.seams.clear(); for (const k of before) em.seams.add(k); if (currentOverlay && state.editMesh === em) rebuildOverlay(state.scene, currentOverlay, em, state.editSelection); },
    redo() { em.seams.clear(); for (const k of after) em.seams.add(k); if (currentOverlay && state.editMesh === em) rebuildOverlay(state.scene, currentOverlay, em, state.editSelection); },
  });
  status(`Seams: ${em.seams.size} edge(s)`);
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
  const beforeUV = mesh.getVerticesData(VertexBuffer.UVKind);
  const beforeUVCopy = beforeUV ? new Float32Array(beforeUV) : null;
  const beforeMIRaw = mesh.getVerticesData(VertexBuffer.MatricesIndicesKind);
  const beforeMWRaw = mesh.getVerticesData(VertexBuffer.MatricesWeightsKind);
  const beforeMI = beforeMIRaw ? new Float32Array(beforeMIRaw) : null;
  const beforeMW = beforeMWRaw ? new Float32Array(beforeMWRaw) : null;
  const beforeSel = new Set(state.editSelection.indices);
  const beforeMode = state.editSelection.mode;

  const result = smartUVProject(em);

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

  // Rebuild EditMesh + overlay.
  rebuildHalfEdges(em, new Float32Array(result.positions), result.indices.slice());
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
      rebuildHalfEdges(em, new Float32Array(beforePos), beforeIdx.slice());
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
      rebuildHalfEdges(em, new Float32Array(afterPos), afterIdx.slice());
      state.editSelection.indices.clear();
      if (currentOverlay && state.editMesh === em) rebuildOverlay(state.scene, currentOverlay, em, state.editSelection);
      if (currentGizmo && state.editMesh === em) currentGizmo.refresh(em, state.editSelection);
      refreshEditToolsUI();
    },
  });

  status(`Unwrap: ${em.vertices.length} verts, ${em.faces.length} faces`);
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
      status("⚠ Bevel: no beveleable edges in selection (boundary edges are skipped)");
      return new Set();
    }
    if (info.skipped > 0) {
      status(`Bevel: ${info.skipped} 辺は端点共有のためスキップ — もう一度 Bevel で残りを面取り`);
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

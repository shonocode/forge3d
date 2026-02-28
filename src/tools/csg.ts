import { CSG } from "@babylonjs/core/Meshes/csg";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { state, status } from "../state";
import { selectMesh } from "./selection";
import { updateHierarchy } from "../ui/panels";
import { applyDefaultEdges } from "./mesh-utils";
import { addShadowCaster, removeShadowCaster } from "../viewport/shadows";

export type CSGOp = "union" | "subtract" | "intersect";

export function doCSG(op: CSGOp): void {
  if (state.selectedMeshes.length < 2) {
    status("\u26a0 2\u3064\u306e\u30e1\u30c3\u30b7\u30e5\u3092\u9078\u629e\u3057\u3066\u304f\u3060\u3055\u3044");
    return;
  }
  const a = state.selectedMeshes[0]!;
  const b = state.selectedMeshes[1]!;
  if (!(a instanceof Mesh) || !(b instanceof Mesh)) {
    status("\u26a0 CSG\u306b\u306fMesh\u304c\u5fc5\u8981\u3067\u3059");
    return;
  }

  // Clone meshes for CSG to preserve originals if operation fails
  const aClone = a.clone("csg_tmp_a", null);
  const bClone = b.clone("csg_tmp_b", null);
  if (!aClone || !bClone) {
    aClone?.dispose();
    bClone?.dispose();
    status("\u26a0 CSG \u30af\u30ed\u30fc\u30f3\u5931\u6557");
    return;
  }

  try {
    aClone.bakeCurrentTransformIntoVertices();
    bClone.bakeCurrentTransformIntoVertices();

    const ca = CSG.FromMesh(aClone);
    const cb = CSG.FromMesh(bClone);
    let r: CSG;
    switch (op) {
      case "union": r = ca.union(cb); break;
      case "subtract": r = ca.subtract(cb); break;
      case "intersect": r = ca.intersect(cb); break;
    }
    state.meshCounter++;
    const nm = r.toMesh("csg_" + op + "_" + state.meshCounter, a.material, state.scene, true);
    nm.isPickable = true;
    applyDefaultEdges(nm);

    // Dispose temp clones
    aClone.dispose();
    bClone.dispose();

    // Soft-delete originals (keep references for undo)
    state.selectedMeshes = state.selectedMeshes.filter((x) => x !== a && x !== b);
    a.setEnabled(false);
    b.setEnabled(false);
    removeShadowCaster(a);
    removeShadowCaster(b);
    const aIdx = state.allMeshes.indexOf(a);
    if (aIdx >= 0) state.allMeshes.splice(aIdx, 1);
    const bIdx = state.allMeshes.indexOf(b);
    if (bIdx >= 0) state.allMeshes.splice(bIdx, 1);

    // Add result
    state.allMeshes.push(nm);
    addShadowCaster(nm);
    selectMesh(nm, false);
    updateHierarchy();
    status("CSG " + op + " \u5b8c\u4e86");

    // Undo support
    state.history.push({
      label: "CSG " + op,
      undo() {
        // Hide result
        nm.setEnabled(false);
        removeShadowCaster(nm);
        const ni = state.allMeshes.indexOf(nm);
        if (ni >= 0) state.allMeshes.splice(ni, 1);
        // Restore originals
        a.setEnabled(true);
        b.setEnabled(true);
        addShadowCaster(a);
        addShadowCaster(b);
        state.allMeshes.push(a);
        state.allMeshes.push(b);
        selectMesh(a, false);
        updateHierarchy();
      },
      redo() {
        // Hide originals
        a.setEnabled(false);
        b.setEnabled(false);
        removeShadowCaster(a);
        removeShadowCaster(b);
        const ai = state.allMeshes.indexOf(a);
        if (ai >= 0) state.allMeshes.splice(ai, 1);
        const bi = state.allMeshes.indexOf(b);
        if (bi >= 0) state.allMeshes.splice(bi, 1);
        // Restore result
        nm.setEnabled(true);
        addShadowCaster(nm);
        state.allMeshes.push(nm);
        selectMesh(nm, false);
        updateHierarchy();
      },
    });
  } catch (e) {
    // Always clean up temp clones on failure
    aClone.dispose();
    bClone.dispose();
    console.error("CSG error:", e);
    status("\u26a0 CSG \u30a8\u30e9\u30fc: " + (e as Error).message);
  }
}

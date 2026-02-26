import { CSG } from "@babylonjs/core/Meshes/csg";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { state, status } from "../state";
import { selectMesh } from "./selection";
import { updateHierarchy } from "../ui/panels";
import { applyDefaultEdges } from "./mesh-utils";
import { cleanupMesh } from "./actions";

export type CSGOp = "union" | "subtract" | "intersect";

export function doCSG(op: CSGOp): void {
  if (state.selectedMeshes.length < 2) {
    status("⚠ 2つのメッシュを選択してください");
    return;
  }
  try {
    const a = state.selectedMeshes[0]!;
    const b = state.selectedMeshes[1]!;
    if (!(a instanceof Mesh) || !(b instanceof Mesh)) {
      status("⚠ CSGにはMeshが必要です");
      return;
    }

    // Clone meshes for CSG to preserve originals if operation fails
    const aClone = a.clone("csg_tmp_a", null);
    const bClone = b.clone("csg_tmp_b", null);
    if (!aClone || !bClone) {
      aClone?.dispose();
      bClone?.dispose();
      status("⚠ CSG クローン失敗");
      return;
    }
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

    // Remove originals with full cleanup (paint textures, morphs, skeleton refs)
    state.selectedMeshes = state.selectedMeshes.filter((x) => x !== a && x !== b);
    cleanupMesh(a);
    cleanupMesh(b);

    state.allMeshes.push(nm);
    selectMesh(nm, false);
    updateHierarchy();
    status("CSG " + op + " 完了");
  } catch (e) {
    console.error("CSG error:", e);
    status("⚠ CSG エラー: " + (e as Error).message);
  }
}

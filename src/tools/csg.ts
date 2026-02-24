import { CSG } from "@babylonjs/core/Meshes/csg";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { state, status } from "../state";
import { selectMesh } from "./selection";
import { updateHierarchy } from "../ui/panels";
import { applyDefaultEdges } from "./mesh-utils";

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
    a.bakeCurrentTransformIntoVertices();
    b.bakeCurrentTransformIntoVertices();
    const ca = CSG.FromMesh(a);
    const cb = CSG.FromMesh(b);
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

    removeMesh(a);
    removeMesh(b);
    a.dispose();
    b.dispose();
    state.allMeshes.push(nm);
    selectMesh(nm, false);
    updateHierarchy();
    status("CSG " + op + " 完了");
  } catch (e) {
    console.error("CSG error:", e);
    status("⚠ CSG エラー: " + (e as Error).message);
  }
}

function removeMesh(m: Mesh): void {
  state.allMeshes = state.allMeshes.filter((x) => x !== m);
}

/**
 * The left panel's Mesh Tools as actions, shared by the old screen
 * (`ui/builders.ts`) and the new one (`app/`, ADR-014): what each button does
 * to the last selected mesh, with its undo.
 */
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { state, status } from "../state";
import { lastSelected } from "./selection";
import { getModifiers, setModifierShading } from "./modifiers";
import {
  recalcNormals, flipNormals, weldVertices, centerOrigin, applyShading,
  snapshotVertexData, restoreVertexData,
} from "./mesh-utils";

export type MeshToolId = "recalc" | "flip" | "smooth" | "flat" | "autoSmooth" | "weld" | "center";

export interface MeshTool {
  id: MeshToolId;
  label: string;
  /** Hover text. */
  title?: string;
}

export const MESH_TOOLS: readonly MeshTool[] = [
  { id: "recalc", label: "Recalc Normals", title: "面の表裏をそろえる（黒く見える面を直す）" },
  { id: "flip", label: "Flip Normals", title: "面の表裏を全部ひっくり返す" },
  { id: "smooth", label: "Shade Smooth", title: "全面をなめらかにシェーディング（頂点法線を平均化）" },
  { id: "flat", label: "Shade Flat", title: "面ごとのフラットシェーディング（ハードエッジで頂点分割）" },
  { id: "autoSmooth", label: "Auto Smooth ∠", title: "角度より急な折り目だけハードエッジに（Blender の Auto Smooth 相当）" },
  { id: "weld", label: "Weld Vertices", title: "重なった頂点をくっつける" },
  { id: "center", label: "Center Origin", title: "回転・拡縮の中心を形の中心へ" },
];

/** Shade a mesh — through its modifier stack when it has one. */
function shade(m: AbstractMesh, angle: number): boolean {
  return setModifierShading(m, angle) || applyShading(m, angle);
}

function act(id: MeshToolId, m: AbstractMesh, autoSmoothDeg: number): boolean {
  switch (id) {
    case "recalc": return recalcNormals(m);
    case "flip": return flipNormals(m);
    case "smooth": return shade(m, Math.PI);
    case "flat": return shade(m, 0.02);
    case "autoSmooth": {
      const deg = Number.isNaN(autoSmoothDeg) ? 30 : Math.max(1, Math.min(180, autoSmoothDeg));
      return shade(m, (deg * Math.PI) / 180);
    }
    case "weld": return weldVertices(m);
    case "center": return centerOrigin(m);
  }
}

/**
 * Run a mesh tool on the last selected mesh, with undo and a status line.
 * `autoSmoothDeg` is the Auto Smooth angle (default 30°).
 */
export function runMeshTool(id: MeshToolId, autoSmoothDeg = 30): boolean {
  const tool = MESH_TOOLS.find((t) => t.id === id)!;
  const m = lastSelected();
  if (!m) {
    status("メッシュを選択");
    return false;
  }
  // A mesh with modifiers is re-evaluated from its base, so shading goes onto
  // the stack (which pushes its own undo) instead of the buffer.
  const snap = getModifiers(m).length ? null : snapshotVertexData(m);
  const ok = act(id, m, autoSmoothDeg);
  if (!ok) {
    status("変更なし（モーフ付きメッシュはシェーディング変更不可）");
    return false;
  }
  if (snap) {
    state.history.push({
      label: tool.label,
      undo() { restoreVertexData(m, snap); },
      redo() { act(id, m, autoSmoothDeg); },
    });
  }
  status(tool.label + " 完了");
  return true;
}

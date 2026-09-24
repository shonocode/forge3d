import { MorphTargetManager } from "@babylonjs/core/Morph/morphTargetManager";
import { MorphTarget } from "@babylonjs/core/Morph/morphTarget";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { store } from "../store";
import { state, status } from "../state";
import { lastSelected } from "./selection";

export function addMorph(): void {
  if (!state.selectedMeshes.length) {
    status("⚠ メッシュを選択");
    return;
  }
  const m = lastSelected()!;
  if (!state.morphMap.has(m.uniqueId)) {
    const mm = new MorphTargetManager();
    m.morphTargetManager = mm;
    state.morphMap.set(m.uniqueId, { manager: mm, targets: [] });
  }
  status("モーフ有効化。変形してキャプチャ");
  updateMorphUI();
}

export function captureMorph(): void {
  if (!state.selectedMeshes.length) return;
  const m = lastSelected()!;
  const d = state.morphMap.get(m.uniqueId);
  if (!d) {
    status("⚠ 先にターゲットを追加");
    return;
  }
  const pos = m.getVerticesData(VertexBuffer.PositionKind);
  const nor = m.getVerticesData(VertexBuffer.NormalKind);
  if (!pos) return;

  const tn = "target_" + d.targets.length;
  const t = new MorphTarget(tn, 0, state.scene);
  t.setPositions(new Float32Array(pos));
  if (nor) t.setNormals(new Float32Array(nor));
  d.manager.addTarget(t);
  d.targets.push(t);
  updateMorphUI();
  status("キャプチャ: " + tn);
}

export function deleteMorphTarget(uid: number, index: number): void {
  const d = state.morphMap.get(uid);
  if (!d || !d.targets[index]) return;
  const removed = d.targets.splice(index, 1)[0]!;
  const mesh = state.allMeshes.find((m) => m.uniqueId === uid);

  // Rebuild manager without the removed target
  d.manager.dispose();
  const mm = new MorphTargetManager();
  for (const t of d.targets) {
    mm.addTarget(t);
  }
  d.manager = mm;
  if (mesh) mesh.morphTargetManager = mm;

  updateMorphUI();
  status("モーフ削除: " + removed.name);
}

export function setMorphInfluence(uid: number, index: number, value: number): void {
  const d = state.morphMap.get(uid);
  if (!d || !d.targets[index]) return;
  d.targets[index].influence = value;
  const el = document.getElementById("mv" + index);
  if (el) el.textContent = value.toFixed(2);
}

/**
 * Tell the screen the morph targets changed. The Morph tab
 * (`app/tabs/surface.tsx`) reads `state.morphMap`; this used to build the old
 * screen's panel by id.
 */
export function updateMorphUI(): void {
  store.notify();
}

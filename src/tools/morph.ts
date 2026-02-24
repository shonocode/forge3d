import { MorphTargetManager } from "@babylonjs/core/Morph/morphTargetManager";
import { MorphTarget } from "@babylonjs/core/Morph/morphTarget";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { state, status, E } from "../state";
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

export function setMorphInfluence(uid: number, index: number, value: number): void {
  const d = state.morphMap.get(uid);
  if (!d) return;
  d.targets[index]!.influence = value;
  const el = document.getElementById("mv" + index);
  if (el) el.textContent = value.toFixed(2);
}

export function updateMorphUI(): void {
  const el = E("morC");
  if (!state.selectedMeshes.length) {
    el.innerHTML = '<div class="empty">メッシュを選択</div>';
    return;
  }
  const m = lastSelected()!;
  const d = state.morphMap.get(m.uniqueId);
  if (!d || !d.targets.length) {
    el.innerHTML = '<div class="empty">ターゲットなし</div>';
    return;
  }
  el.innerHTML = d.targets
    .map(
      (t, i) => `
    <div class="sr"><label>${t.name} <span id="mv${i}">${t.influence.toFixed(2)}</span></label>
      <input type="range" min="0" max="1" step=".01" value="${t.influence}"
        data-uid="${m.uniqueId}" data-idx="${i}" class="morph-slider"></div>`
    )
    .join("");

  // Attach event listeners
  el.querySelectorAll<HTMLInputElement>(".morph-slider").forEach((inp) => {
    inp.addEventListener("input", () => {
      setMorphInfluence(
        Number(inp.dataset.uid),
        Number(inp.dataset.idx),
        Number(inp.value)
      );
    });
  });
}

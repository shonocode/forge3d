import { MorphTargetManager } from "@babylonjs/core/Morph/morphTargetManager";
import { MorphTarget } from "@babylonjs/core/Morph/morphTarget";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { state, status, E, type AnimChannel } from "../state";
import { lastSelected } from "./selection";
import { escapeHtml } from "../ui/escape";
import { getActiveSkeleton } from "./skeleton-tool";
import { findDriver } from "./morph-driver";

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
  const skel = getActiveSkeleton();
  const CHANNEL_LABELS: Array<[AnimChannel, string]> = [
    ["rx", "Rot X"], ["ry", "Rot Y"], ["rz", "Rot Z"],
    ["px", "Pos X"], ["py", "Pos Y"], ["pz", "Pos Z"],
  ];
  el.innerHTML = d.targets
    .map((t, i) => {
      const drv = findDriver(state.morphDrivers, m.uniqueId, i);
      const driven = !!drv && drv.enabled;
      // Driver row: bone channel → influence. Needs a skeleton to offer bones.
      const boneOpts = skel
        ? skel.bones
            .map((b) => `<option value="${escapeHtml(b.name)}"${drv?.boneName === b.name ? " selected" : ""}>${escapeHtml(b.name)}</option>`)
            .join("")
        : "";
      const chOpts = CHANNEL_LABELS
        .map(([id, label]) => `<option value="${id}"${drv?.channel === id ? " selected" : ""}>${label}</option>`)
        .join("");
      const driverRow = skel
        ? `
      <div class="sr" style="display:flex;align-items:center;gap:3px;font-size:9px;padding-left:8px;color:var(--t4);">
        <label style="display:flex;align-items:center;gap:2px;cursor:pointer;" title="ボーンの姿勢チャンネルでこのモーフを駆動 (ドライバ有効中はスライダー / キーより優先)">
          <input type="checkbox" class="morph-drv-on" data-uid="${m.uniqueId}" data-idx="${i}"${driven ? " checked" : ""}>⚙
        </label>
        <select class="morph-drv-bone" data-uid="${m.uniqueId}" data-idx="${i}" style="flex:1;min-width:0;font-size:9px;"${driven ? "" : " disabled"}>${boneOpts}</select>
        <select class="morph-drv-ch" data-uid="${m.uniqueId}" data-idx="${i}" style="width:52px;font-size:9px;"${driven ? "" : " disabled"}>${chOpts}</select>
        <input type="number" class="morph-drv-min" data-uid="${m.uniqueId}" data-idx="${i}" step="0.1" value="${drv?.inMin ?? 0}" style="width:40px;font-size:9px;" title="この値で influence 0"${driven ? "" : " disabled"}>
        <input type="number" class="morph-drv-max" data-uid="${m.uniqueId}" data-idx="${i}" step="0.1" value="${drv?.inMax ?? 1}" style="width:40px;font-size:9px;" title="この値で influence 1"${driven ? "" : " disabled"}>
      </div>`
        : "";
      return `
    <div class="sr" style="display:flex;align-items:center;gap:4px;">
      <label style="flex:1;">${escapeHtml(t.name)}${driven ? " ⚙" : ""} <span id="mv${i}">${t.influence.toFixed(2)}</span></label>
      <input type="range" min="0" max="1" step=".01" value="${t.influence}"
        data-uid="${m.uniqueId}" data-idx="${i}" class="morph-slider" style="flex:2;"${driven ? " disabled" : ""}>
      <button class="abtn dan morph-del" data-uid="${m.uniqueId}" data-idx="${i}"
        style="padding:1px 5px;font-size:9px;min-width:0;">✕</button>
    </div>${driverRow}`;
    })
    .join("");

  // Attach slider event listeners
  el.querySelectorAll<HTMLInputElement>(".morph-slider").forEach((inp) => {
    inp.addEventListener("input", () => {
      setMorphInfluence(
        Number(inp.dataset.uid),
        Number(inp.dataset.idx),
        Number(inp.value)
      );
    });
    // Auto-Key: commit a morph keyframe once the drag settles ("change"
    // fires on release, not per-tick like "input").
    inp.addEventListener("change", async () => {
      const { notifyMorphEdited } = await import("./animation-tool");
      notifyMorphEdited(Number(inp.dataset.uid), Number(inp.dataset.idx));
    });
  });

  // Attach delete button event listeners
  el.querySelectorAll<HTMLButtonElement>(".morph-del").forEach((btn) => {
    btn.addEventListener("click", () => {
      deleteMorphTarget(Number(btn.dataset.uid), Number(btn.dataset.idx));
    });
  });

  // Driver rows: toggle + parameter edits write straight into state.morphDrivers.
  const readDriverRow = (uid: number, idx: number): void => {
    const q = (cls: string): HTMLInputElement | HTMLSelectElement | null =>
      el.querySelector(`.${cls}[data-uid="${uid}"][data-idx="${idx}"]`);
    const on = (q("morph-drv-on") as HTMLInputElement | null)?.checked ?? false;
    const boneName = (q("morph-drv-bone") as HTMLSelectElement | null)?.value ?? "";
    const channel = ((q("morph-drv-ch") as HTMLSelectElement | null)?.value ?? "rx") as AnimChannel;
    const inMin = Number((q("morph-drv-min") as HTMLInputElement | null)?.value ?? 0);
    const inMax = Number((q("morph-drv-max") as HTMLInputElement | null)?.value ?? 1);
    const existing = findDriver(state.morphDrivers, uid, idx);
    if (!on) {
      if (existing) {
        state.morphDrivers = state.morphDrivers.filter((dd) => dd !== existing);
        status("Driver 解除");
      }
      updateMorphUI();
      return;
    }
    if (!boneName) {
      status("⚠ Driver: ボーンがない — 先にスケルトンを作成");
      updateMorphUI();
      return;
    }
    if (existing) {
      existing.enabled = true;
      existing.boneName = boneName;
      existing.channel = channel;
      existing.inMin = Number.isFinite(inMin) ? inMin : 0;
      existing.inMax = Number.isFinite(inMax) ? inMax : 1;
    } else {
      state.morphDrivers.push({
        enabled: true,
        meshUniqueId: uid,
        targetIndex: idx,
        boneName,
        channel,
        inMin: Number.isFinite(inMin) ? inMin : 0,
        inMax: Number.isFinite(inMax) ? inMax : 1,
      });
      status(`Driver: ${boneName} → morph ${idx}`);
    }
    updateMorphUI();
  };
  el.querySelectorAll<HTMLInputElement>(".morph-drv-on").forEach((inp) => {
    inp.addEventListener("change", () => readDriverRow(Number(inp.dataset.uid), Number(inp.dataset.idx)));
  });
  for (const cls of ["morph-drv-bone", "morph-drv-ch", "morph-drv-min", "morph-drv-max"]) {
    el.querySelectorAll<HTMLElement>(`.${cls}`).forEach((elem) => {
      elem.addEventListener("change", () => {
        const de = elem as HTMLElement & { dataset: DOMStringMap };
        readDriverRow(Number(de.dataset.uid), Number(de.dataset.idx));
      });
    });
  }
}

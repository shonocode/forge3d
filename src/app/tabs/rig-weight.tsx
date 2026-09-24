/**
 * Weight tab (ADR-014) — old markup: `tb-weight` in the removed
 * `old-index.html`; behavior from `src/ui/bindings.ts` (weight handlers) and
 * `src/ui/panels.ts` (`updateWeightInfo`, `updateBoneSlotList`). Logic lives
 * in `src/tools/weight-paint.ts` / `auto-weights.ts` — this file only reads
 * `state` and calls those.
 *
 * `TAB_SECTIONS.weight` (guide.ts) has 4 ids: `wb`, `wm`, `wa`, `bs`. The old
 * screen's "Info" block (weightInfo) and the Ctrl/Shift hint text have no id
 * of their own — folded into `bs` (Bone Slots), which they sit right below
 * in the old layout.
 */
import type { WeightMode } from "../../state";
import { state, status } from "../../state";
import { getActiveSkeleton, selectBone } from "../../tools/skeleton-tool";
import { applyAutoWeights } from "../../tools/auto-weights";
import { initWeightData, hasWeightData, showWeightOverlay, hideWeightOverlay, refreshWeightOverlay } from "../../tools/weight-paint";
import { lastSelected } from "../../tools/selection";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { useForge } from "../use-forge";
import { LiveSlider, Empty, notifyRig } from "./rig-shared";

// ── wb: Weight Brush ──

export function WeightBrushSection() {
  useForge(() => null);
  const cfg = state.weightConfig;
  return (
    <>
      <LiveSlider label="Radius" ariaLabel="Weight brush radius" value={cfg.radius} min={0.1} max={3} step={0.05} onChange={(v) => { cfg.radius = v; }} />
      <LiveSlider label="Strength" ariaLabel="Weight brush strength" value={cfg.strength} min={0.01} max={1} step={0.01} onChange={(v) => { cfg.strength = v; }} />
      <LiveSlider label="Falloff" ariaLabel="Weight brush falloff" value={cfg.falloff} min={0.5} max={4} step={0.1} digits={1} onChange={(v) => { cfg.falloff = v; }} />
    </>
  );
}

// ── wm: Mode ──

const WEIGHT_MODES: { id: WeightMode; label: string }[] = [
  { id: "add", label: "+ Add" },
  { id: "subtract", label: "− Subtract" },
  { id: "smooth", label: "〜 Smooth" },
];

export function WeightModeSection() {
  useForge(() => null);
  return (
    <>
      <div role="group">
        {WEIGHT_MODES.map((wm) => (
          <button
            key={wm.id}
            type="button"
            className={"abtn" + (state.weightConfig.mode === wm.id ? " on" : "")}
            aria-pressed={state.weightConfig.mode === wm.id}
            onClick={() => { state.weightConfig.mode = wm.id; notifyRig(); }}
          >
            {wm.label}
          </button>
        ))}
      </div>
      <div style={{ marginTop: 6, fontSize: 9, color: "var(--t4)", lineHeight: 1.6 }}>
        Ctrl+drag: Subtract
        <br />
        Shift+drag: Smooth
      </div>
    </>
  );
}

// ── wa: Actions ──

export function WeightActionsSection() {
  useForge(() => null);
  const active = state.weightOverlayActive;
  return (
    <>
      <button
        type="button"
        className="abtn pri"
        title="Automatically bind all vertices to the nearest bones (replaces existing weights)"
        onClick={() => {
          const m = lastSelected();
          if (!m) { status("⚠ Select the skinned mesh first"); return; }
          const geodesic = (document.getElementById("autoWeightGeodesic") as HTMLInputElement | null)?.checked ?? true;
          applyAutoWeights(m, { geodesic });
          if (state.weightOverlayActive) refreshWeightOverlay();
          notifyRig();
        }}
      >
        ⚡ Auto Weights
      </button>
      <div className="pr">
        <span
          className="pl"
          style={{ fontSize: 10, color: "var(--t3)" }}
          title="Bind along the mesh surface instead of straight-line distance — prevents weight bleed between nearby-but-disconnected parts (e.g. arm↔torso)"
        >
          Geodesic (surface)
        </span>
        <input type="checkbox" id="autoWeightGeodesic" aria-label="Geodesic auto-weight" defaultChecked style={{ marginLeft: "auto" }} />
      </div>
      <button
        type="button"
        className="abtn"
        onClick={() => {
          const m = lastSelected();
          if (m) { initWeightData(m); notifyRig(); }
        }}
      >
        Init Weight Data
      </button>
      <button
        type="button"
        className="abtn"
        onClick={() => {
          const m = lastSelected();
          if (!m) return;
          if (active) hideWeightOverlay(m);
          else if (m.skeleton && hasWeightData(m)) showWeightOverlay(m);
          notifyRig();
        }}
      >
        Show/Hide Overlay
      </button>
    </>
  );
}

// ── bs: Bone Slots (+ Info) ──

function BoneSlotList() {
  const m = lastSelected();
  const skel = getActiveSkeleton();
  if (!m || !m.skeleton || !skel) return <Empty>スケルトンをアタッチしたメッシュを選択</Empty>;
  if (skel.bones.length === 0) return <Empty>ボーンなし</Empty>;

  const bjsBones = m.skeleton.bones;
  const counts = new Array<number>(bjsBones.length).fill(0);
  if (hasWeightData(m)) {
    const weights = m.getVerticesData(VertexBuffer.MatricesWeightsKind);
    const indices = m.getVerticesData(VertexBuffer.MatricesIndicesKind);
    if (weights && indices) {
      for (let i = 0; i < weights.length; i++) {
        if (weights[i]! > 0.01) {
          const bjsIdx = indices[i]!;
          if (bjsIdx >= 0 && bjsIdx < counts.length) counts[bjsIdx]!++;
        }
      }
    }
  }

  return (
    <div className="slist" style={{ maxHeight: "min(180px,30vh)", overflowY: "auto" }} role="list">
      {skel.bones.map((bd) => {
        const bjsIdx = bjsBones.indexOf(bd.bone);
        const count = bjsIdx >= 0 ? counts[bjsIdx]! : 0;
        const isSel = bd.id === state.selectedBoneId;
        return (
          <div
            key={bd.id}
            role="listitem"
            className={"sitem" + (isSel ? " sel" : "")}
            style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 10, padding: "3px 6px" }}
            title={`${bd.name} — ${count} 頂点がウェイト付き`}
            onClick={() => {
              selectBone(bd.id);
              refreshWeightOverlay();
              notifyRig();
            }}
          >
            <span style={{ color: "var(--ac)", fontSize: 9 }}>●</span>
            <span style={{ flex: 1 }}>{bd.name}</span>
            <span style={{ color: "var(--t4)", fontSize: 9 }}>{count}v</span>
          </div>
        );
      })}
    </div>
  );
}

export function WeightBoneSlotsSection() {
  useForge(() => null);
  const m = lastSelected();
  const hasSkel = m?.skeleton != null;
  const boneName = state.selectedBoneId
    ? getActiveSkeleton()?.bones.find((b) => b.id === state.selectedBoneId)?.name ?? "—"
    : "未選択";
  return (
    <>
      <BoneSlotList />
      {!m || !hasSkel ? (
        <Empty>スケルトンをアタッチしたメッシュを選択</Empty>
      ) : (
        <div style={{ fontSize: 10, color: "var(--t2)", lineHeight: 1.6, marginTop: 6 }}>
          <div><span style={{ color: "var(--t4)" }}>Weight Data:</span> {hasWeightData(m) ? "✓ initialized" : "✕ not initialized"}</div>
          <div><span style={{ color: "var(--t4)" }}>Bones:</span> {m.skeleton!.bones.length}</div>
          <div><span style={{ color: "var(--t4)" }}>Active Bone:</span> {boneName}</div>
        </div>
      )}
    </>
  );
}

/**
 * Bone tab (ADR-014) — old markup: `tb-bone` in the removed `old-index.html`;
 * behavior ported from `src/ui/bindings.ts` (bone/IK/constraint handlers) and
 * `src/ui/panels.ts` (`updateBoneUI` and its helpers). Logic lives in
 * `src/tools/skeleton-tool.ts` / `bone-constraints.ts` — this file only reads
 * `state` and calls those.
 *
 * `TAB_SECTIONS.bone` (guide.ts) has 4 ids: `bmo`, `sk`, `bh`, `ik`. The old
 * screen had 7 `.pg` blocks (Mode, Skeleton, Bone Hierarchy, Display,
 * Selected Bone, IK Constraint, Bone Constraints) — the two without a
 * section id are folded into the nearest one:
 *   - Display (bone size / X-ray / show bones) → `bh` (Bone Hierarchy)
 *   - Selected Bone (name/parent/position/roll, Mirror, Delete) → `bh`
 *   - Bone Constraints (Aim, Limit Rotation) → `ik` (IK Constraint)
 */
import { useState } from "react";
import { state, status } from "../../state";
import {
  findBoneById,
  getActiveSkeleton,
  createSkeleton,
  assignSkeletonToMesh,
  deleteBone,
  mirrorBoneChain,
  solveIKForBone,
  getIKPoleSuggestion,
  getAimTargetSuggestion,
  copyBonePose,
  pasteBonePose,
  refreshPoseGizmoOrientation,
  selectBone as selectBoneFn,
  applyBoneDisplayConfig,
  setBoneVisualsVisible,
  setBoneRollLive,
  commitBoneRoll,
  syncBoneFromVisual,
} from "../../tools/skeleton-tool";
import type { BoneData, SkeletonData } from "../../state";
import type { LimitRotationConstraint } from "../../tools/bone-constraints";
import { lastSelected } from "../../tools/selection";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { useForge } from "../use-forge";
import { NumField, LiveSlider, Empty, SubPanel, notifyRig } from "./rig-shared";

function boneDepth(bd: BoneData, skel: SkeletonData): number {
  let depth = 0;
  let cur = bd;
  while (cur.parentId) {
    depth++;
    const parent = skel.bones.find((b) => b.id === cur.parentId);
    if (!parent) break;
    cur = parent;
  }
  return depth;
}

// ── bmo: Mode ──

export function BoneModeSection() {
  useForge(() => null); // re-render on any store notify (mode / selection changes)
  const mode = state.boneEditMode;
  const setMode = (m: "edit" | "pose"): void => {
    state.boneEditMode = m;
    if (state.selectedBoneId) selectBoneFn(state.selectedBoneId);
    status(m === "pose" ? "Bone: Pose Mode (rotate)" : "Bone: Edit Mode (position)");
    notifyRig();
  };
  return (
    <>
      <div style={{ display: "flex", gap: 4 }}>
        <button type="button" className={"abtn" + (mode === "edit" ? " on" : "")} style={{ flex: 1, fontSize: 10 }} title="Edit Mode: position gizmo, rest pose layout" onClick={() => setMode("edit")}>
          Edit
        </button>
        <button type="button" className={"abtn" + (mode === "pose" ? " on" : "")} style={{ flex: 1, fontSize: 10 }} title="Pose Mode: rotation gizmo, keyframable poses" onClick={() => setMode("pose")}>
          Pose
        </button>
      </div>
      <div className="pr">
        <span className="pl" style={{ fontSize: 10, color: "var(--t3)" }} title="Pose の回転ギズモをボーンのローカル軸（ボーン方向 + Roll）に整列。OFF でワールド軸">
          Local 軸回転
        </span>
        <input
          type="checkbox"
          checked={state.poseRotationSpace === "local"}
          aria-label="Pose rotation in local bone axes"
          style={{ marginLeft: "auto" }}
          onChange={(e) => {
            state.poseRotationSpace = e.target.checked ? "local" : "world";
            try {
              const rotGizmo = state.gizmoManager.gizmos?.rotationGizmo;
              if (rotGizmo) rotGizmo.updateGizmoRotationToMatchAttachedMesh = state.poseRotationSpace === "local";
            } catch { /* gizmo may not exist yet */ }
            refreshPoseGizmoOrientation();
            status("Pose 回転軸: " + (state.poseRotationSpace === "local" ? "Local" : "World"));
            notifyRig();
          }}
        />
      </div>
      <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
        <button
          type="button"
          className="abtn"
          style={{ flex: 1, fontSize: 10 }}
          title="選択ボーンのローカルポーズ（回転+位置）をコピー"
          onClick={() => {
            if (!state.selectedBoneId) { status("⚠ コピーするボーンを選択"); return; }
            copyBonePose(state.selectedBoneId);
            notifyRig();
          }}
        >
          📋 Copy
        </button>
        <button
          type="button"
          className="abtn"
          style={{ flex: 1, fontSize: 10 }}
          title="コピーしたポーズを選択ボーンに貼り付け（undo 可）"
          onClick={() => { if (pasteBonePose()) notifyRig(); }}
        >
          📥 Paste
        </button>
        <button
          type="button"
          className="abtn"
          style={{ flex: 1, fontSize: 10 }}
          title="コピー元の対側ボーン（_L↔_R）へ X ミラーで貼り付け（Blender の Paste Pose Flipped 相当）"
          onClick={() => { if (pasteBonePose("x")) notifyRig(); }}
        >
          🪞 Mirror
        </button>
      </div>
    </>
  );
}

// ── sk: Skeleton ──

export function BoneSkeletonSection() {
  useForge(() => null);
  const skel = getActiveSkeleton();
  return (
    <>
      {skel ? (
        <div style={{ fontSize: 10, color: "var(--t2)", lineHeight: 1.6 }}>
          <div><span style={{ color: "var(--t4)" }}>Name:</span> {skel.skeleton.name}</div>
          <div><span style={{ color: "var(--t4)" }}>Bones:</span> {skel.bones.length}</div>
          <div><span style={{ color: "var(--t4)" }}>Mesh:</span> {skel.assignedMesh?.name ?? "未割当"}</div>
        </div>
      ) : (
        <Empty>BONEツールで骨格を作成</Empty>
      )}
      <button
        type="button"
        className="abtn"
        style={{ marginTop: 6 }}
        onClick={() => { createSkeleton(); notifyRig(); }}
      >
        + New Skeleton
      </button>
      <button
        type="button"
        className="abtn"
        onClick={() => {
          const m = lastSelected();
          if (m) { assignSkeletonToMesh(m); notifyRig(); }
          else status("⚠ Select a mesh first");
        }}
      >
        Assign to Mesh
      </button>
    </>
  );
}

// ── bh: Bone Hierarchy (+ Display, + Selected Bone) ──

function BoneHierarchyList() {
  const skel = getActiveSkeleton();
  if (!skel || skel.bones.length === 0) return <Empty>ボーンなし</Empty>;
  return (
    <div className="slist" role="list">
      {skel.bones.map((bd) => (
        <div
          key={bd.id}
          role="listitem"
          className={"sitem" + (bd.id === state.selectedBoneId ? " sel" : "")}
          style={{ paddingLeft: 8 + boneDepth(bd, skel) * 12 }}
          onClick={() => {
            selectBoneFn(bd.id);
            notifyRig();
          }}
        >
          <span style={{ color: "var(--ac)", fontSize: 10 }}>●</span> <span>{bd.name}</span>
        </div>
      ))}
    </div>
  );
}

function BoneDisplayControls() {
  const [visible, setVisible] = useState(true);
  return (
    <SubPanel title="Display">
      <LiveSlider
        label="Bone Size"
        ariaLabel="Bone visual size"
        value={state.boneDisplay.size}
        min={0.25}
        max={4}
        step={0.05}
        onChange={(v) => {
          state.boneDisplay.size = v;
          applyBoneDisplayConfig();
        }}
      />
      <div className="pr">
        <span className="pl" style={{ fontSize: 10, color: "var(--t3)" }} title="メッシュ越しにボーンを表示 (Blender の X-Ray armature 相当)">
          X-Ray
        </span>
        <input
          type="checkbox"
          checked={state.boneDisplay.xray}
          aria-label="Bone X-ray (show through mesh)"
          style={{ marginLeft: "auto" }}
          onChange={(e) => {
            state.boneDisplay.xray = e.target.checked;
            applyBoneDisplayConfig();
            notifyRig();
          }}
        />
      </div>
      <div className="pr">
        <span
          className="pl"
          style={{ fontSize: 10, color: "var(--t3)" }}
          title="ボーン全体の表示 / 非表示（Blender の Overlay ▸ Bones 相当）"
        >
          Show Bones
        </span>
        <input
          type="checkbox"
          checked={visible}
          aria-label="Show bones"
          style={{ marginLeft: "auto" }}
          onChange={(e) => {
            if (state.skeletonMap.size === 0) { status("No skeleton to show or hide"); return; }
            setVisible(e.target.checked);
            setBoneVisualsVisible(e.target.checked);
            status(e.target.checked ? "Bones shown" : "Bones hidden");
          }}
        />
      </div>
    </SubPanel>
  );
}

function SelectedBoneControls() {
  const skel = getActiveSkeleton();
  const bd = skel && state.selectedBoneId ? skel.bones.find((b) => b.id === state.selectedBoneId) : null;
  const [rollGesture, setRollGesture] = useState<number | null>(null);

  return (
    <SubPanel title="Selected Bone">
      {!bd || !skel ? (
        <Empty>ボーンを選択</Empty>
      ) : (
        <>
          <div style={{ fontSize: 10, color: "var(--t2)", lineHeight: 1.6 }}>
            <div><span style={{ color: "var(--t4)" }}>Name:</span> {bd.name}</div>
            <div><span style={{ color: "var(--t4)" }}>Parent:</span> {bd.parentId ? skel.bones.find((b) => b.id === bd.parentId)?.name ?? "—" : "— (root)"}</div>
          </div>
          {bd.visual && (
            <div className="pg" style={{ marginTop: 4 }}>
              <div className="pgt">Position</div>
              {(["x", "y", "z"] as const).map((a) => (
                <NumField
                  key={bd.id + a}
                  axisLabel={a.toUpperCase()}
                  ariaLabel={"Bone position " + a.toUpperCase()}
                  step={0.1}
                  value={bd.visual!.position[a]}
                  onChange={(v) => {
                    if (!bd.visual) return;
                    bd.visual.position[a] = v;
                    syncBoneFromVisual(bd, skel);
                    notifyRig();
                  }}
                />
              ))}
            </div>
          )}
          <div className="pr" style={{ marginTop: 4 }}>
            <span className="pl" style={{ fontSize: 10, color: "var(--t3)" }} title="ボーン軸まわりのレスト方向ひねり（Blender の Roll 相当）。Pose の Local 軸ギズモの向きを制御">
              Roll°
            </span>
            <input
              type="number"
              step={5}
              aria-label="Bone roll (degrees)"
              style={{ marginLeft: "auto", width: 64, fontSize: 10 }}
              defaultValue={(((bd.roll ?? 0) * 180) / Math.PI).toFixed(1)}
              key={bd.id + "-roll"}
              onFocus={() => setRollGesture(bd.roll ?? 0)}
              onChange={(e) => {
                const deg = parseFloat(e.target.value);
                if (Number.isNaN(deg)) return;
                if (rollGesture === null) setRollGesture(bd.roll ?? 0);
                setBoneRollLive(bd.id, (deg * Math.PI) / 180);
              }}
              onBlur={() => {
                if (rollGesture !== null) commitBoneRoll(bd.id, rollGesture);
                setRollGesture(null);
                notifyRig();
              }}
            />
          </div>
          <button
            type="button"
            className="abtn"
            title="Mirror the selected bone and its children across X=0 (left↔right), swapping _L/_R names"
            onClick={() => { mirrorBoneChain(bd.id, "x"); notifyRig(); }}
          >
            ⇄ Mirror Bone (X)
          </button>
          <button
            type="button"
            className="abtn dan"
            onClick={() => { deleteBone(bd.id); notifyRig(); }}
          >
            Delete Bone
          </button>
        </>
      )}
    </SubPanel>
  );
}

export function BoneHierarchySection() {
  useForge(() => null);
  return (
    <>
      <BoneHierarchyList />
      <BoneDisplayControls />
      <SelectedBoneControls />
    </>
  );
}

// ── ik: IK Constraint (+ Bone Constraints) ──

function IkConstraintControls() {
  const bd = state.selectedBoneId ? findBoneById(state.selectedBoneId) : null;
  const ik = bd?.ikConstraint;

  return (
    <SubPanel title="IK Constraint">
      <div className="pr">
        <span className="pl" style={{ fontSize: 10, color: "var(--t3)" }}>Enable IK</span>
        <input
          type="checkbox"
          checked={ik?.enabled ?? false}
          aria-label="IK enabled"
          style={{ marginLeft: "auto" }}
          onChange={(e) => {
            if (!bd) return;
            if (e.target.checked) {
              const p = bd.visual?.position;
              bd.ikConstraint = {
                enabled: true,
                chainLength: ik?.chainLength ?? 2,
                targetX: p?.x ?? 0,
                targetY: p?.y ?? 0,
                targetZ: p?.z ?? 0,
              };
            } else {
              bd.ikConstraint = undefined;
            }
            notifyRig();
          }}
        />
      </div>
      <LiveSlider
        label="Chain Length"
        ariaLabel="IK chain length"
        value={ik?.chainLength ?? 2}
        min={1}
        max={5}
        step={1}
        digits={0}
        onChange={(v) => { if (bd?.ikConstraint) { bd.ikConstraint.chainLength = v; notifyRig(); } }}
      />
      <div className="pr">
        <span className="pl" style={{ fontSize: 10, color: "var(--t3)" }}>Target</span>
        <button
          type="button"
          className="abtn"
          style={{ marginLeft: "auto", fontSize: 10, padding: "2px 8px" }}
          title="Snap target to current bone tip position"
          onClick={() => {
            if (!bd?.ikConstraint || !bd.visual) { status("⚠ Enable IK and select a bone first"); return; }
            const p = bd.visual.position;
            bd.ikConstraint.targetX = p.x;
            bd.ikConstraint.targetY = p.y;
            bd.ikConstraint.targetZ = p.z;
            status("IK target snapped to bone");
            notifyRig();
          }}
        >
          Snap to Bone
        </button>
      </div>
      {(["X", "Y", "Z"] as const).map((axis) => (
        <NumField
          key={"ikTarget" + axis}
          axisLabel={axis}
          ariaLabel={"IK target " + axis}
          value={ik ? ik[`target${axis}` as "targetX" | "targetY" | "targetZ"] : 0}
          onChange={(v) => { if (bd?.ikConstraint) bd.ikConstraint[`target${axis}` as "targetX" | "targetY" | "targetZ"] = v; }}
        />
      ))}
      <div className="pr" style={{ marginTop: 6 }}>
        <span className="pl" style={{ fontSize: 10, color: "var(--t3)" }} title="Steer which way the chain bends (elbow/knee direction)">
          Pole (bend dir)
        </span>
        <input
          type="checkbox"
          checked={ik?.poleEnabled ?? false}
          aria-label="IK pole enabled"
          style={{ marginLeft: "auto" }}
          onChange={(e) => { if (bd?.ikConstraint) { bd.ikConstraint.poleEnabled = e.target.checked; notifyRig(); } }}
        />
      </div>
      <div className="pr">
        <span className="pl" style={{ fontSize: 10, color: "var(--t3)" }}>Pole Target</span>
        <button
          type="button"
          className="abtn"
          style={{ marginLeft: "auto", fontSize: 10, padding: "2px 8px" }}
          title="Place the pole at the current mid-joint, pushed outward"
          onClick={() => {
            if (!bd?.ikConstraint) { status("⚠ Enable IK and select a bone first"); return; }
            const p = getIKPoleSuggestion(bd.id);
            if (!p) return;
            bd.ikConstraint.poleEnabled = true;
            bd.ikConstraint.poleX = p.x;
            bd.ikConstraint.poleY = p.y;
            bd.ikConstraint.poleZ = p.z;
            status("IK pole snapped to bend");
            notifyRig();
          }}
        >
          Snap to Bend
        </button>
      </div>
      {(["X", "Y", "Z"] as const).map((axis) => (
        <NumField
          key={"ikPole" + axis}
          axisLabel={axis}
          ariaLabel={"IK pole " + axis}
          value={ik ? (ik[`pole${axis}` as "poleX" | "poleY" | "poleZ"] ?? 0) : 0}
          onChange={(v) => { if (bd?.ikConstraint) bd.ikConstraint[`pole${axis}` as "poleX" | "poleY" | "poleZ"] = v; }}
        />
      ))}
      <div className="sr" style={{ display: "flex", gap: 4, marginTop: 4 }}>
        <label style={{ fontSize: 9, flex: 1 }} title="Max bend per joint in degrees (0 = no limit). Prevents sharp kinks / hyperextension.">
          Max Bend °
        </label>
        <input
          type="number"
          step={5}
          min={0}
          max={180}
          aria-label="IK max bend degrees"
          style={{ width: 56, fontSize: 10 }}
          value={ik?.maxBendDeg ?? 0}
          onChange={(e) => {
            const v = +e.target.value;
            if (Number.isNaN(v) || !bd?.ikConstraint) return;
            bd.ikConstraint.maxBendDeg = Math.max(0, Math.min(180, v));
            notifyRig();
          }}
        />
      </div>
      <button
        type="button"
        className="abtn pri"
        style={{ marginTop: 6 }}
        title="Solve the chain once toward the target (undo-able). When 'Enable IK' is on the chain also solves live every frame."
        onClick={() => {
          if (!bd) { status("⚠ Select the chain's tip bone first"); return; }
          const c = bd.ikConstraint;
          if (!c) { status("⚠ Enable IK on this bone first"); return; }
          solveIKForBone(bd.id, new Vector3(c.targetX, c.targetY, c.targetZ));
          notifyRig();
        }}
      >
        Solve IK Now
      </button>
    </SubPanel>
  );
}

function BoneConstraintsControls() {
  const bd = state.selectedBoneId ? findBoneById(state.selectedBoneId) : null;
  const aim = bd?.aimConstraint;
  const lim = bd?.limitRotation;

  const readLimitInputs = (overrides: Partial<LimitRotationConstraint> = {}): LimitRotationConstraint => ({
    enabled: true,
    limitX: lim?.limitX ?? false,
    minXDeg: lim?.minXDeg ?? -180,
    maxXDeg: lim?.maxXDeg ?? 180,
    limitY: lim?.limitY ?? false,
    minYDeg: lim?.minYDeg ?? -180,
    maxYDeg: lim?.maxYDeg ?? 180,
    limitZ: lim?.limitZ ?? false,
    minZDeg: lim?.minZDeg ?? -180,
    maxZDeg: lim?.maxZDeg ?? 180,
    ...overrides,
  });

  const axisRow = (axis: "X" | "Y" | "Z") => {
    const limitKey = `limit${axis}` as "limitX" | "limitY" | "limitZ";
    const minKey = `min${axis}Deg` as "minXDeg" | "minYDeg" | "minZDeg";
    const maxKey = `max${axis}Deg` as "maxXDeg" | "maxYDeg" | "maxZDeg";
    return (
      <div className="sr" style={{ display: "flex", gap: 4, alignItems: "center" }} key={axis}>
        <input
          type="checkbox"
          aria-label={"Limit " + axis + " axis"}
          checked={lim?.[limitKey] ?? false}
          onChange={(e) => { if (bd) bd.limitRotation = readLimitInputs({ [limitKey]: e.target.checked }); notifyRig(); }}
        />
        <label style={{ fontSize: 9, width: 10 }}>{axis}</label>
        <input
          type="number"
          step={5}
          aria-label={axis + " min degrees"}
          placeholder="min°"
          style={{ flex: 1, fontSize: 10 }}
          value={lim?.[minKey] ?? -180}
          onChange={(e) => { if (bd) bd.limitRotation = readLimitInputs({ [minKey]: +e.target.value }); notifyRig(); }}
        />
        <input
          type="number"
          step={5}
          aria-label={axis + " max degrees"}
          placeholder="max°"
          style={{ flex: 1, fontSize: 10 }}
          value={lim?.[maxKey] ?? 180}
          onChange={(e) => { if (bd) bd.limitRotation = readLimitInputs({ [maxKey]: +e.target.value }); notifyRig(); }}
        />
      </div>
    );
  };

  return (
    <SubPanel title="Bone Constraints">
      <div className="pr">
        <span className="pl" style={{ fontSize: 10, color: "var(--t3)" }} title="ボーンの +Y 軸（Roll 反映）をターゲットへ向け続ける（Blender の Damped Track 相当）。IK 適用後に毎フレーム適用">
          Aim (注視)
        </span>
        <input
          type="checkbox"
          checked={aim?.enabled ?? false}
          aria-label="Aim constraint enabled"
          style={{ marginLeft: "auto" }}
          onChange={(e) => {
            if (!bd) return;
            if (e.target.checked) {
              const p = getAimTargetSuggestion(bd.id);
              bd.aimConstraint = { enabled: true, targetX: p?.x ?? 0, targetY: p?.y ?? 0, targetZ: p?.z ?? 0 };
            } else {
              bd.aimConstraint = undefined;
            }
            notifyRig();
          }}
        />
      </div>
      <div className="pr">
        <span className="pl" style={{ fontSize: 10, color: "var(--t3)" }}>Aim Target</span>
        <button
          type="button"
          className="abtn"
          style={{ marginLeft: "auto", fontSize: 10, padding: "2px 8px" }}
          title="ターゲットを現在のボーン方向の先へスナップ（有効化してもポーズが跳ばない）"
          onClick={() => {
            if (!bd?.aimConstraint) { status("⚠ Aim を有効化してボーンを選択"); return; }
            const p = getAimTargetSuggestion(bd.id);
            if (!p) return;
            bd.aimConstraint.targetX = p.x;
            bd.aimConstraint.targetY = p.y;
            bd.aimConstraint.targetZ = p.z;
            status("Aim target snapped ahead");
            notifyRig();
          }}
        >
          Snap Ahead
        </button>
      </div>
      {(["X", "Y", "Z"] as const).map((axis) => (
        <NumField
          key={"aimTarget" + axis}
          axisLabel={axis}
          ariaLabel={"Aim target " + axis}
          value={aim ? aim[`target${axis}` as "targetX" | "targetY" | "targetZ"] : 0}
          onChange={(v) => { if (bd?.aimConstraint) bd.aimConstraint[`target${axis}` as "targetX" | "targetY" | "targetZ"] = v; }}
        />
      ))}
      <div className="pr" style={{ marginTop: 6 }}>
        <span
          className="pl"
          style={{ fontSize: 10, color: "var(--t3)" }}
          title="ローカル回転を軸ごとに min/max（度）へクランプ（Blender の Limit Rotation 相当）。IK・Aim の結果にも適用"
        >
          Limit Rotation
        </span>
        <input
          type="checkbox"
          checked={lim?.enabled ?? false}
          aria-label="Limit rotation enabled"
          style={{ marginLeft: "auto" }}
          onChange={(e) => { if (bd) bd.limitRotation = e.target.checked ? readLimitInputs() : undefined; notifyRig(); }}
        />
      </div>
      {axisRow("X")}
      {axisRow("Y")}
      {axisRow("Z")}
    </SubPanel>
  );
}

export function BoneIkSection() {
  useForge(() => null);
  return (
    <>
      <IkConstraintControls />
      <BoneConstraintsControls />
    </>
  );
}

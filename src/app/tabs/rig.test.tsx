// @vitest-environment jsdom
/**
 * Renders each Bone / Weight / Anim section with nothing selected (the
 * `.empty` messages the old screen showed), plus a few cheap interactions
 * that don't need a Babylon scene: creating a clip, switching weight mode,
 * and selecting a bone from a hand-built skeleton (no `new Skeleton(...)` —
 * that needs `state.scene`, which is null in jsdom; see `fakeSkeleton`
 * below). Style follows `src/app/app.test.tsx`.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { boneControls, weightControls, animControls } from "./rig";
import { TAB_SECTIONS } from "../guide/guide";
import { state } from "../../state";
import type { BoneData, SkeletonData } from "../../state";

afterEach(cleanup);

/** Section ids this group must cover, per `TAB_SECTIONS` — every one but "io". */
function ownedSections(tab: keyof typeof TAB_SECTIONS): string[] {
  return TAB_SECTIONS[tab].map((s) => s.id).filter((id) => id !== "io");
}

beforeEach(() => {
  // Reset the slice of the shared `state` singleton this group touches, so
  // tests don't leak into each other (the app itself never resets `state`).
  state.selectedMeshes = [];
  state.skeletonMap.clear();
  state.activeSkeletonId = null;
  state.selectedBoneId = null;
  state.boneEditMode = "edit";
  state.poseRotationSpace = "local";
  state.poseClipboard = null;
  state.boneDisplay = { size: 1, xray: true };
  state.weightConfig = { radius: 0.5, strength: 0.3, falloff: 2, mode: "add" };
  state.weightOverlayActive = false;
  state.animClips = [];
  state.activeClipId = null;
  state.currentFrame = 0;
  state.autoKey = true;
  state.onionSkin = { enabled: false, offset: 5 };
  state.importedAnimGroups = [];
  state.keyframeClipboard = null;
});

/** A skeleton with no Babylon `Bone`/`Skeleton` instances — enough for the
 *  list/selection UI, which only reads `id`/`name`/`parentId`/`visual`. Any
 *  code path that would call a real Babylon method (gizmo attach, absolute
 *  transforms) is guarded by `visual == null` here, which every one of
 *  these render paths respects (see rig-bone.tsx's `SelectedBoneControls`). */
function fakeSkeleton(): SkeletonData {
  const bones: BoneData[] = [
    { id: "b1", name: "Root", bone: {} as BoneData["bone"], parentId: null, visual: null },
    { id: "b2", name: "Arm_L", bone: {} as BoneData["bone"], parentId: "b1", visual: null },
  ];
  return { skeleton: {} as SkeletonData["skeleton"], bones, assignedMesh: null, hierarchyLines: null };
}

describe("rig.tsx — section coverage", () => {
  it("boneControls / weightControls / animControls cover every non-io section id", () => {
    expect(Object.keys(boneControls).sort()).toEqual(ownedSections("bone").sort());
    expect(Object.keys(weightControls).sort()).toEqual(ownedSections("weight").sort());
    expect(Object.keys(animControls).sort()).toEqual(ownedSections("anim").sort());
  });
});

describe("Bone tab", () => {
  it("Mode: Edit/Pose toggle, local-axis checkbox, pose copy/paste buttons", () => {
    render(<>{boneControls.bmo!()}</>);
    expect(screen.getByRole("button", { name: "Edit" }).className).toContain("on");
    expect(screen.getByRole("button", { name: "Pose" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Pose rotation in local bone axes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "📋 Copy" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "📥 Paste" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "🪞 Mirror" })).toBeTruthy();
  });

  it("Skeleton: empty state + New Skeleton / Assign to Mesh", () => {
    render(<>{boneControls.sk!()}</>);
    expect(screen.getByText("BONEツールで骨格を作成")).toBeTruthy();
    expect(screen.getByRole("button", { name: "+ New Skeleton" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Assign to Mesh" })).toBeTruthy();
  });

  it("Bone Hierarchy: empty state, Display controls, Selected Bone empty", () => {
    render(<>{boneControls.bh!()}</>);
    expect(screen.getByText("ボーンなし")).toBeTruthy();
    expect(screen.getByRole("slider", { name: "Bone visual size" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Bone X-ray (show through mesh)" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Show bones" })).toBeTruthy();
    expect(screen.getByText("ボーンを選択")).toBeTruthy();
  });

  it("Bone Hierarchy: lists a fake skeleton's bones and selects one on click", async () => {
    state.skeletonMap.set("skel_1", fakeSkeleton());
    state.activeSkeletonId = "skel_1";
    render(<>{boneControls.bh!()}</>);
    expect(screen.getByText("Root")).toBeTruthy();
    expect(screen.getByText("Arm_L")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText("Arm_L"));
    });
    expect(state.selectedBoneId).toBe("b2");
  });

  it("IK Constraint + Bone Constraints render with nothing selected", () => {
    render(<>{boneControls.ik!()}</>);
    expect(screen.getByRole("checkbox", { name: "IK enabled" })).toBeTruthy();
    expect(screen.getByRole("slider", { name: "IK chain length" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Solve IK Now" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Aim constraint enabled" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Limit rotation enabled" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Limit X axis" })).toBeTruthy();
  });
});

describe("Weight tab", () => {
  it("Weight Brush: radius/strength/falloff sliders at their defaults", () => {
    render(<>{weightControls.wb!()}</>);
    expect((screen.getByRole("slider", { name: "Weight brush radius" }) as HTMLInputElement).value).toBe("0.5");
    expect((screen.getByRole("slider", { name: "Weight brush strength" }) as HTMLInputElement).value).toBe("0.3");
    expect((screen.getByRole("slider", { name: "Weight brush falloff" }) as HTMLInputElement).value).toBe("2");
  });

  it("Mode: Add is active by default; clicking Subtract switches it", async () => {
    render(<>{weightControls.wm!()}</>);
    expect(screen.getByRole("button", { name: "+ Add" }).getAttribute("aria-pressed")).toBe("true");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "− Subtract" }));
    });
    expect(state.weightConfig.mode).toBe("subtract");
  });

  it("Actions: Auto Weights, Geodesic (checked by default), Init, Overlay toggle", () => {
    render(<>{weightControls.wa!()}</>);
    expect(screen.getByRole("button", { name: "⚡ Auto Weights" })).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "Geodesic auto-weight" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("button", { name: "Init Weight Data" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show/Hide Overlay" })).toBeTruthy();
  });

  it("Bone Slots: empty state when nothing is selected", () => {
    render(<>{weightControls.bs!()}</>);
    expect(screen.getAllByText("スケルトンをアタッチしたメッシュを選択").length).toBeGreaterThan(0);
  });
});

describe("Anim tab", () => {
  it("Clip: empty state, then + New Clip creates one", async () => {
    render(<>{animControls.clip!()}</>);
    expect(screen.getByText("クリップを作成してアニメーション")).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Active clip" }) as HTMLSelectElement).disabled).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "+ New Clip" }));
    });
    expect(state.animClips.length).toBe(1);
    expect(within(screen.getByRole("combobox", { name: "Active clip" })).getByText("Clip_1")).toBeTruthy();
  });

  it("Timeline: frame/fps/max-frames controls, onion skin, graph editor + dopesheet canvases", () => {
    render(<>{animControls.tl!()}</>);
    expect(screen.getByRole("slider", { name: "Animation frame" })).toBeTruthy();
    expect(screen.getByRole("slider", { name: "Frames per second" })).toBeTruthy();
    expect(screen.getByRole("slider", { name: "Max frames" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Loop mode" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Onion skin ghosts" })).toBeTruthy();
    // canvas has no reliable implicit ARIA role in jsdom — check by id instead.
    expect(document.getElementById("graphCanvas")).toBeTruthy();
    expect(document.getElementById("dopeCanvas")).toBeTruthy();
  });

  it("Timeline: the graph editor is wired again after the Anim tab is left and reopened", () => {
    // Leaving the tab unmounts the canvases; the editor used to keep the
    // detached canvas and never wire the new one (blank, unresponsive).
    const first = render(<>{animControls.tl!()}</>);
    expect(within(document.getElementById("graphChannels")!).getByText("Pos X")).toBeTruthy();
    first.unmount();
    render(<>{animControls.tl!()}</>);
    expect(within(document.getElementById("graphChannels")!).getByText("Pos X")).toBeTruthy();
  });

  it("Record: Auto-Key on by default, record/delete buttons, easing select, keyframes empty", () => {
    render(<>{animControls.rec!()}</>);
    expect((screen.getByLabelText("🔑 Auto-Key（ポーズ変更を自動キー）") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("button", { name: "⏺ Record Keyframe" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "⏺ Record All Bones" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "✕ Delete Keyframe" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Keyframe easing" })).toBeTruthy();
    expect(screen.getByText("ボーンを選択してキーフレーム表示")).toBeTruthy();
  });

  it("Playback: Play/Stop + Export JSON", () => {
    render(<>{animControls.play!()}</>);
    expect(screen.getByRole("button", { name: "▶ Play" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "■ Stop" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "⬇ Export JSON" })).toBeTruthy();
  });
});

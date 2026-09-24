/**
 * Rig group (ADR-014) — Bone / Weight / Anim tabs. Assembles the section
 * components from `rig-bone.tsx` / `rig-weight.tsx` / `rig-anim.tsx` into the
 * `Record<sectionId, () => ReactNode>` shape `right-panel.tsx` expects (see
 * its `CONTROLS` map), keyed by `TAB_SECTIONS.bone/weight/anim` in
 * `src/app/guide/guide.ts`.
 *
 * Section-id → old-screen-block mapping and any folded-in orphans are
 * documented at the top of each `rig-*.tsx` file.
 */
import type { ReactNode } from "react";
import { BoneModeSection, BoneSkeletonSection, BoneHierarchySection, BoneIkSection } from "./rig-bone";
import { WeightBrushSection, WeightModeSection, WeightActionsSection, WeightBoneSlotsSection } from "./rig-weight";
import { AnimClipSection, AnimTimelineSection, AnimRecordSection, AnimPlaySection } from "./rig-anim";

export const boneControls: Record<string, () => ReactNode> = {
  bmo: () => <BoneModeSection />,
  sk: () => <BoneSkeletonSection />,
  bh: () => <BoneHierarchySection />,
  ik: () => <BoneIkSection />,
};

export const weightControls: Record<string, () => ReactNode> = {
  wb: () => <WeightBrushSection />,
  wm: () => <WeightModeSection />,
  wa: () => <WeightActionsSection />,
  bs: () => <WeightBoneSlotsSection />,
};

export const animControls: Record<string, () => ReactNode> = {
  clip: () => <AnimClipSection />,
  tl: () => <AnimTimelineSection />,
  rec: () => <AnimRecordSection />,
  play: () => <AnimPlaySection />,
};

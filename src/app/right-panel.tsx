/**
 * The right panel: tabs, the tool card for what is in use (variant A), and
 * the open tab's sections with their notes (variant C) and their controls
 * (`tabs/*.tsx`, ported from the old screen).
 */
import type { ReactNode } from "react";
import { TAB_LABELS, TAB_SECTIONS, topicFor, type TabId } from "./guide/guide";
import { ToolCard } from "./guide/tool-card";
import { SectionNote } from "./guide/section-note";
import { TransformFields } from "./transform-fields";
import { ModifierPanel } from "./modifier-panel";
import { useForge } from "./use-forge";
import { editControls, ioControls, snapControls } from "./tabs/edit";
import { paintControls, sculptControls } from "./tabs/brush";
import { animControls, boneControls, weightControls } from "./tabs/rig";
import { mapControls, matControls, morphControls, sceneControls } from "./tabs/surface";

/** Each tab's section controls, by section id. Export / Save (`io`) is the same on every tab. */
const CONTROLS: Record<TabId, Record<string, () => ReactNode>> = {
  xform: {
    snap: snapControls,
    tf: () => <TransformFields />,
    mod: () => <ModifierPanel />,
  },
  mat: matControls,
  morph: morphControls,
  sculpt: sculptControls,
  paint: paintControls,
  bone: boneControls,
  weight: weightControls,
  anim: animControls,
  edit: editControls,
  map: mapControls,
  scene: sceneControls,
};

export interface RightPanelProps {
  open: boolean;
  tab: TabId;
  onTab(tab: TabId): void;
}

export function RightPanel({ open, tab, onTab }: RightPanelProps) {
  const tool = useForge((s) => s.tool);
  const controls = CONTROLS[tab];
  return (
    <aside className={"rp" + (open ? " open" : "")} aria-label="右パネル">
      <div className="tabs" role="tablist">
        {(Object.keys(TAB_LABELS) as TabId[]).map((id) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={"tb" + (tab === id ? " on" : "")} onClick={() => onTab(id)}>
            {TAB_LABELS[id]}
          </button>
        ))}
      </div>
      <ToolCard key={tab + tool} topic={topicFor(tool, tab)} />
      {TAB_SECTIONS[tab].map((sec) => {
        const body = sec.id === "io" ? ioControls : controls[sec.id];
        return (
          <SectionNote key={tab + sec.id} section={sec}>
            {body ? body() : <div className="empty porting">操作部品は新しい画面へ移植中</div>}
          </SectionNote>
        );
      })}
    </aside>
  );
}

/**
 * The right panel: tabs, the tool card for what is in use (variant A), and
 * the open tab's sections with their notes (variant C). Transform's sections
 * have their controls; the other tabs show their notes and say the controls
 * are still being moved over from the old screen.
 */
import type { ReactNode } from "react";
import { TAB_LABELS, TAB_SECTIONS, topicFor, type TabId } from "./guide/guide";
import { ToolCard } from "./guide/tool-card";
import { SectionNote } from "./guide/section-note";
import { TransformFields } from "./transform-fields";
import { ModifierPanel } from "./modifier-panel";
import { useForge } from "./use-forge";

/** Sections that have their controls on the new screen, by tab and section id. */
const CONTROLS: Partial<Record<TabId, Record<string, () => ReactNode>>> = {
  xform: {
    tf: () => <TransformFields />,
    mod: () => <ModifierPanel />,
  },
};

export interface RightPanelProps {
  open: boolean;
  tab: TabId;
  onTab(tab: TabId): void;
}

export function RightPanel({ open, tab, onTab }: RightPanelProps) {
  const tool = useForge((s) => s.tool);
  const controls = CONTROLS[tab] ?? {};
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
        const body = controls[sec.id];
        return (
          <SectionNote key={tab + sec.id} section={sec}>
            {body ? body() : <div className="empty porting">操作部品は新しい画面へ移植中</div>}
          </SectionNote>
        );
      })}
    </aside>
  );
}

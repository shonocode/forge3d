/**
 * The new screen (ADR-014): header, left panel, the 3D view, right panel,
 * status line — the Claude Design proposal's layout, on the old stylesheet's
 * palette and grid. The 3D side starts once the canvas is in the page.
 */
import { useEffect, useState } from "react";
import { TOOL_TAB, type TabId } from "./guide/guide";
import { Glossary } from "./guide/glossary";
import { Shortcuts } from "./guide/shortcuts";
import { MobileBar } from "./mobile-bar";
import { ViewportOverlay } from "./viewport-overlay";
import { Header } from "./header";
import { LeftPanel } from "./left-panel";
import { RightPanel } from "./right-panel";
import { useForge, useStatus } from "./use-forge";
import { isMobile, state } from "../state";

export interface AppProps {
  /** Start the 3D side; the app passes `boot`, tests pass nothing. */
  onCanvas?: () => void;
}

export function App({ onCanvas }: AppProps) {
  const tool = useForge((s) => s.tool);
  const [tab, setTab] = useState<TabId>(TOOL_TAB[tool]);
  const [left, setLeft] = useState(false);
  const [right, setRight] = useState(false);
  const [help, setHelp] = useState<null | "glossary" | "keys">(null);
  const status = useStatus();

  // A tool switch opens its tab, as the old screen did.
  useEffect(() => setTab(TOOL_TAB[tool]), [tool]);
  // Entering Edit Mode opens the Edit tab, and leaving it goes back to the
  // tool's. On a phone (no Tab key, no room) the right panel opens too, so the
  // V / E / F buttons and the operators can be reached.
  const editing = useForge((s) => s.editMesh !== null);
  useEffect(() => {
    setTab(editing ? "edit" : TOOL_TAB[state.tool]);
    if (editing && isMobile()) {
      setRight(true);
      setLeft(false);
    }
  }, [editing]);
  useEffect(() => onCanvas?.(), [onCanvas]);

  return (
    <div id="app">
      <Header onToggleLeft={() => setLeft(!left)} onToggleRight={() => setRight(!right)} onGlossary={() => setHelp("glossary")} />
      <LeftPanel open={left} />
      <main className="vp">
        <canvas id="rc" aria-label="3D ビュー" />
        <ViewportOverlay />
      </main>
      <RightPanel open={right} tab={tab} onTab={setTab} />
      <MobileBar onPrimitives={() => { setLeft(true); setRight(false); }} />
      <footer className={"stat" + (status?.kind === "error" ? " stat-err" : status?.kind === "ok" ? " stat-ok" : "")} role="status">
        <span id="stxt">{status?.text ?? ""}</span>
      </footer>
      {/* showLoading / hideLoading in state.ts find these by id. */}
      <div className="loading-overlay" id="loadingOverlay" role="alert" aria-live="assertive">
        <div className="loading-spinner" />
        <div className="loading-text" id="loadingText">Loading...</div>
      </div>
      {help && (
        <div className="glossary-overlay" role="dialog" aria-label="ヘルプ" onClick={() => setHelp(null)}>
          <div className="glossary-modal" onClick={(e) => e.stopPropagation()}>
            <div className="glossary-head">
              <div className="help-tabs" role="tablist">
                <button type="button" role="tab" aria-selected={help === "glossary"} onClick={() => setHelp("glossary")}>用語集</button>
                <button type="button" role="tab" aria-selected={help === "keys"} onClick={() => setHelp("keys")}>ショートカット</button>
              </div>
              <button type="button" onClick={() => setHelp(null)} aria-label="閉じる">✕</button>
            </div>
            {help === "glossary" ? <Glossary /> : <Shortcuts />}
          </div>
        </div>
      )}
    </div>
  );
}

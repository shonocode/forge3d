/**
 * The new screen (ADR-014): header, left panel, the 3D view, right panel,
 * status line — the Claude Design proposal's layout, on the old stylesheet's
 * palette and grid. The 3D side starts once the canvas is in the page.
 */
import { useEffect, useState } from "react";
import { TOOL_TAB, type TabId } from "./guide/guide";
import { Glossary } from "./guide/glossary";
import { Header } from "./header";
import { LeftPanel } from "./left-panel";
import { RightPanel } from "./right-panel";
import { useForge, useStatus } from "./use-forge";

export interface AppProps {
  /** Start the 3D side; the app passes `boot`, tests pass nothing. */
  onCanvas?: () => void;
}

export function App({ onCanvas }: AppProps) {
  const tool = useForge((s) => s.tool);
  const [tab, setTab] = useState<TabId>(TOOL_TAB[tool]);
  const [left, setLeft] = useState(false);
  const [right, setRight] = useState(false);
  const [glossary, setGlossary] = useState(false);
  const status = useStatus();

  // A tool switch opens its tab, as the old screen did.
  useEffect(() => setTab(TOOL_TAB[tool]), [tool]);
  useEffect(() => onCanvas?.(), [onCanvas]);

  return (
    <div id="app">
      <Header onToggleLeft={() => setLeft(!left)} onToggleRight={() => setRight(!right)} onGlossary={() => setGlossary(true)} />
      <LeftPanel open={left} />
      <main className="vp">
        <canvas id="rc" aria-label="3D ビュー" />
      </main>
      <RightPanel open={right} tab={tab} onTab={setTab} />
      <footer className={"stat" + (status?.kind === "error" ? " stat-err" : status?.kind === "ok" ? " stat-ok" : "")} role="status">
        <span id="stxt">{status?.text ?? ""}</span>
      </footer>
      {glossary && (
        <div className="glossary-overlay" role="dialog" aria-label="用語集" onClick={() => setGlossary(false)}>
          <div className="glossary-modal" onClick={(e) => e.stopPropagation()}>
            <div className="glossary-head">
              <h2>用語集</h2>
              <button type="button" onClick={() => setGlossary(false)} aria-label="閉じる">✕</button>
            </div>
            <Glossary />
          </div>
        </div>
      )}
    </div>
  );
}

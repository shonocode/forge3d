/**
 * The top bar: tool pills (keys from the keymap), undo / redo, the panel
 * toggles on a phone, and the glossary.
 */
import type { ToolId } from "../state";
import { setTool } from "../input";
import { state } from "../state";
import { TOPICS, topicKey } from "./guide/guide";
import { useForge } from "./use-forge";

const TOOLS: ToolId[] = ["select", "move", "rotate", "scale", "sculpt", "paint", "bone", "weight", "anim"];

export interface HeaderProps {
  onToggleLeft(): void;
  onToggleRight(): void;
  onGlossary(): void;
}

export function Header({ onToggleLeft, onToggleRight, onGlossary }: HeaderProps) {
  const tool = useForge((s) => s.tool);
  const canUndo = useForge((s) => s.history.canUndo());
  const canRedo = useForge((s) => s.history.canRedo());
  return (
    <header className="hdr">
      <button type="button" className="mob-toggle" onClick={onToggleLeft} aria-label="左パネル">☰</button>
      <div className="logo">
        FORGE<span>3D</span>
      </div>
      <nav className="pills" aria-label="ツール">
        {TOOLS.map((id) => {
          const t = TOPICS[id];
          const key = topicKey(t);
          return (
            <button
              key={id}
              type="button"
              className={"pill" + (tool === id ? " on" : "")}
              aria-pressed={tool === id}
              title={`${t.name}（${t.ja}）${key ? ` [${key}]` : " ― キーなし"}：${t.one}`}
              onClick={() => setTool(id)}
            >
              {t.code}
              {key && <span className="pill-key">{key}</span>}
            </button>
          );
        })}
      </nav>
      <div className="undo-btns">
        <button type="button" className="undo-btn" disabled={!canUndo} onClick={() => state.history.undo()} aria-label="Undo" title="Undo (Ctrl+Z)">↶</button>
        <button type="button" className="undo-btn" disabled={!canRedo} onClick={() => state.history.redo()} aria-label="Redo" title="Redo (Ctrl+Shift+Z)">↷</button>
      </div>
      <button type="button" className="help-btn" onClick={onGlossary} aria-label="用語集" title="用語集">?</button>
      <button type="button" className="mob-toggle" onClick={onToggleRight} aria-label="右パネル">⚙</button>
    </header>
  );
}

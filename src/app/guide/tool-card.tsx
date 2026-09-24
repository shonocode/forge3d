/**
 * The tool card — the Claude Design proposal's variant A (ガイドカード): what
 * the tool in use (or the open tab) is for, how to use it step by step, and
 * when to reach for it. Folds to its heading.
 */
import { useState } from "react";
import { fillKeys, topicKey, type Topic } from "./guide";

export interface ToolCardProps {
  topic: Topic;
  /** Start folded. */
  folded?: boolean;
}

export function ToolCard({ topic, folded = false }: ToolCardProps) {
  const [open, setOpen] = useState(!folded);
  const key = topicKey(topic);
  return (
    <section className="tool-card" aria-label={`${topic.name} の説明`}>
      <header className="tool-card-head">
        <span className="tool-card-kind">{topic.tab ? "このタブについて" : "いま使っているツール"}</span>
        <h2>
          {topic.name}
          <span className="tool-card-ja">{topic.ja}</span>
          {key && <kbd>{key}</kbd>}
        </h2>
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "たたむ ▴" : "ひらく ▾"}
        </button>
      </header>
      {open && (
        <>
          <p className="tool-card-one">{topic.one}</p>
          <h3>使い方</h3>
          <ol className="tool-card-steps">
            {topic.steps.map((s) => (
              <li key={s}>{fillKeys(s)}</li>
            ))}
          </ol>
          <h3>こんな時に</h3>
          <ul className="tool-card-uses">
            {topic.uses.map((u) => (
              <li key={u}>{fillKeys(u)}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * A panel section's heading with its note — the Claude Design proposal's
 * variant C (ステップ): the note is always there, cut to two lines, and
 * "詳しく ▾" opens the rest. The section's controls go in `children`.
 */
import { useState, type ReactNode } from "react";
import { fillKeys, type Section } from "./guide";

export interface SectionNoteProps {
  section: Section;
  children?: ReactNode;
}

export function SectionNote({ section, children }: SectionNoteProps) {
  const [more, setMore] = useState(false);
  return (
    <section className="panel-section" aria-labelledby={`sec-${section.id}`}>
      <h3 id={`sec-${section.id}`}>{section.title}</h3>
      <p className="panel-section-note" data-clamped={!more} style={more ? undefined : CLAMP_2}>
        {fillKeys(section.desc)}
      </p>
      <button type="button" className="panel-section-more" onClick={() => setMore(!more)} aria-expanded={more}>
        {more ? "閉じる ▴" : "詳しく ▾"}
      </button>
      {children}
    </section>
  );
}

/** Two lines, then an ellipsis. */
const CLAMP_2 = {
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
} as const;

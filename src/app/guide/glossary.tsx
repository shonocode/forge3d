/**
 * The glossary: every term in English and Japanese with a one-line meaning,
 * narrowed by category and by a search over all three.
 */
import { useState } from "react";
import { GLOSSARY, GLOSSARY_CATEGORIES, fillKeys, type GlossaryCategory, type GlossaryEntry } from "./guide";

const ALL = "すべて";

/** The entries in `cat` (or all) whose English, Japanese or meaning holds `query`. */
export function filterGlossary(entries: readonly GlossaryEntry[], cat: GlossaryCategory | typeof ALL, query: string): GlossaryEntry[] {
  const q = query.trim().toLowerCase();
  return entries.filter((g) => (cat === ALL || g.cat === cat) && (!q || (g.en + g.ja + g.desc).toLowerCase().includes(q)));
}

export function Glossary({ entries = GLOSSARY }: { entries?: readonly GlossaryEntry[] }) {
  const [cat, setCat] = useState<GlossaryCategory | typeof ALL>(ALL);
  const [query, setQuery] = useState("");
  const shown = filterGlossary(entries, cat, query);
  return (
    <section className="glossary" aria-label="用語集">
      <input type="search" placeholder="用語をさがす" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="用語をさがす" />
      <div className="glossary-cats" role="group" aria-label="カテゴリ">
        {[ALL, ...GLOSSARY_CATEGORIES].map((c) => (
          <button key={c} type="button" aria-pressed={cat === c} onClick={() => setCat(c as GlossaryCategory | typeof ALL)}>
            {c}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="glossary-empty">見つかりません</p>
      ) : (
        <dl>
          {shown.map((g) => (
            <div key={g.en} className="glossary-entry">
              <dt>
                {g.en} <span className="glossary-ja">{g.ja}</span>
              </dt>
              <dd>{fillKeys(g.desc)}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

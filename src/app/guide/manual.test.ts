import { describe, it, expect } from "vitest";
import { renderManual } from "./manual";
import { TOPICS, GLOSSARY, MODIFIER_HELP } from "./guide";

// MANUAL.html is not committed (2026-09-25): it is generated on demand with
// `npm run manual`, so there is no checked-in copy to hold against the guide.
describe("MANUAL.html", () => {
  it("carries every topic, modifier and term, with keys filled and no markers left", () => {
    const html = renderManual();
    for (const t of Object.values(TOPICS)) expect(html).toContain(t.one);
    for (const m of Object.values(MODIFIER_HELP)) expect(html).toContain(m.name);
    for (const g of GLOSSARY) expect(html).toContain(g.ja.replace(/&/g, "&amp;"));
    expect(html).not.toContain("{key:");
    expect(html).toContain("<kbd>G</kbd>");
  });
});

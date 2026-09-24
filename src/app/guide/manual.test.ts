import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { renderManual } from "./manual";
import { TOPICS, GLOSSARY, MODIFIER_HELP } from "./guide";

describe("MANUAL.html", () => {
  it("is what the guide data produces — run `npm run manual` after changing the guide", () => {
    const committed = readFileSync(new URL("../../../MANUAL.html", import.meta.url), "utf8");
    expect(committed).toBe(renderManual());
  });

  it("carries every topic, modifier and term, with keys filled and no markers left", () => {
    const html = renderManual();
    for (const t of Object.values(TOPICS)) expect(html).toContain(t.one);
    for (const m of Object.values(MODIFIER_HELP)) expect(html).toContain(m.name);
    for (const g of GLOSSARY) expect(html).toContain(g.ja.replace(/&/g, "&amp;"));
    expect(html).not.toContain("{key:");
    expect(html).toContain("<kbd>G</kbd>");
  });
});

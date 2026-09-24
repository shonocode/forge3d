import { describe, it, expect } from "vitest";
import {
  GLOSSARY,
  GLOSSARY_CATEGORIES,
  LEFT_SECTIONS,
  MODIFIER_HELP,
  TAB_LABELS,
  TAB_SECTIONS,
  TOOL_TAB,
  TOPICS,
  fillKeys,
  keyMarkers,
  topicFor,
  topicKey,
  type TabId,
} from "./guide";
import { KEYMAP } from "../../keymap";
import { MODIFIER_TYPES } from "../../state";

/**
 * The help text held to the code: if a key is rebound, a tool renamed or a
 * modifier added, these fail instead of the help going quietly stale.
 */

/** Every piece of text the guide holds. */
function allTexts(): string[] {
  const out: string[] = [];
  for (const t of Object.values(TOPICS)) out.push(t.one, ...t.steps, ...t.uses);
  for (const s of LEFT_SECTIONS) out.push(s.desc);
  for (const list of Object.values(TAB_SECTIONS)) for (const s of list) out.push(s.desc);
  for (const m of Object.values(MODIFIER_HELP)) out.push(m.one);
  for (const g of GLOSSARY) out.push(g.desc);
  return out;
}

describe("keys come from keymap.ts", () => {
  it("every {key:…} marker names an action that has a key", () => {
    const known = new Set(KEYMAP.map((b) => b.action));
    const markers = allTexts().flatMap(keyMarkers);
    expect(markers.length).toBeGreaterThan(10);
    for (const m of markers) expect(known.has(m as never), m).toBe(true);
    for (const text of allTexts()) expect(fillKeys(text)).not.toContain("—");
  });

  it("fills a marker with the bound key — Blender's, not the design proposal's", () => {
    expect(fillKeys("{key:tool.move}")).toBe("G");
    expect(fillKeys("{key:mode.editToggle} で切替")).toBe("Tab で切替");
    expect(topicKey(TOPICS.select)).toBe("W");
    // Sculpt has no key (Blender's Ctrl+Tab belongs to the browser).
    expect(topicKey(TOPICS.sculpt)).toBe("");
  });

  it("a marker for an action with no key shows as — rather than vanishing", () => {
    expect(fillKeys("x {key:no.such} y")).toBe("x — y");
  });

  it("no text writes a key by hand next to a tool name", () => {
    // The proposal had "[V]" style keys baked in; they must come through markers.
    for (const text of allTexts()) expect(text).not.toMatch(/\[[A-Z]\]/);
  });
});

describe("topics", () => {
  it("each tool opens a tab, and the card shows the right topic", () => {
    expect(topicFor("move", "xform")).toBe(TOPICS.move);
    // A non-transform tool on the Transform tab: the card falls back to Select.
    expect(topicFor("sculpt", "xform")).toBe(TOPICS.select);
    expect(topicFor("sculpt", "sculpt")).toBe(TOPICS.sculpt);
    expect(topicFor("select", "mat")).toBe(TOPICS.mat);
    for (const tab of Object.values(TOOL_TAB)) expect(TAB_LABELS[tab]).toBeTruthy();
  });

  it("every topic says what it is for, how, and when", () => {
    for (const [id, t] of Object.entries(TOPICS)) {
      expect(t.one.length, id).toBeGreaterThan(10);
      expect(t.steps.length, id).toBeGreaterThanOrEqual(3);
      expect(t.uses.length, id).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("sections", () => {
  it("every tab has sections, ids unique within it, ending with Export / Save", () => {
    for (const tab of Object.keys(TAB_LABELS) as TabId[]) {
      const list = TAB_SECTIONS[tab];
      expect(list.length, tab).toBeGreaterThanOrEqual(2);
      expect(new Set(list.map((s) => s.id)).size, tab).toBe(list.length);
      expect(list[list.length - 1]!.id, tab).toBe("io");
    }
  });
});

describe("modifiers", () => {
  it("has a line for exactly the modifiers the stack can add", () => {
    expect(Object.keys(MODIFIER_HELP).sort()).toEqual([...MODIFIER_TYPES].sort());
  });

  it("the glossary names every modifier", () => {
    const entry = GLOSSARY.find((g) => g.en === "Modifier")!;
    for (const m of Object.values(MODIFIER_HELP)) expect(entry.desc).toContain(m.name);
  });
});

describe("glossary", () => {
  it("one entry per term, every category used", () => {
    expect(new Set(GLOSSARY.map((g) => g.en)).size).toBe(GLOSSARY.length);
    for (const c of GLOSSARY_CATEGORIES) expect(GLOSSARY.some((g) => g.cat === c), c).toBe(true);
  });

  it("says which way is up", () => {
    const axes = GLOSSARY.find((g) => g.en === "X / Y / Z")!;
    expect(axes.desc).toContain("Y が上");
    expect(axes.desc).toContain("Z が上");
  });
});

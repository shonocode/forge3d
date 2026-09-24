// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ToolCard } from "./tool-card";
import { SectionNote } from "./section-note";
import { Glossary, filterGlossary } from "./glossary";
import { GLOSSARY, TAB_SECTIONS, TOPICS } from "./guide";

afterEach(cleanup);

describe("ToolCard (variant A)", () => {
  it("shows the tool's key from the keymap and its steps with markers filled", () => {
    render(<ToolCard topic={TOPICS.move} />);
    const card = screen.getByRole("region", { name: "Move の説明" });
    expect(within(card).getByText("G", { selector: "kbd" })).toBeTruthy();
    expect(within(card).getByText("いま使っているツール")).toBeTruthy();
    const steps = within(card).getAllByRole("listitem");
    // First step names the key; the raw marker never reaches the screen.
    expect(steps[0]!.textContent).toContain("G（または MOV）");
    expect(card.textContent).not.toContain("{key:");
  });

  it("a tool without a key shows none; a tab says it is a tab", () => {
    render(<ToolCard topic={TOPICS.sculpt} />);
    expect(document.querySelector("kbd")).toBeNull();
    cleanup();
    render(<ToolCard topic={TOPICS.mat} />);
    expect(screen.getByText("このタブについて")).toBeTruthy();
  });

  it("folds to its heading and opens again", () => {
    render(<ToolCard topic={TOPICS.select} folded />);
    expect(screen.queryByText("使い方")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "ひらく ▾" }));
    expect(screen.getByText("使い方")).toBeTruthy();
  });
});

describe("SectionNote (variant C)", () => {
  const snap = TAB_SECTIONS.xform[0]!;

  it("shows the note cut to two lines until 詳しく is pressed", () => {
    render(
      <SectionNote section={snap}>
        <input aria-label="Position step" />
      </SectionNote>,
    );
    const note = screen.getByText(/キリのいい数値/);
    expect(note.dataset.clamped).toBe("true");
    expect(note.style.webkitLineClamp || note.style.getPropertyValue("-webkit-line-clamp")).toBe("2");
    fireEvent.click(screen.getByRole("button", { name: "詳しく ▾" }));
    expect(note.dataset.clamped).toBe("false");
    expect(screen.getByRole("button", { name: "閉じる ▴" })).toBeTruthy();
    // The section's own controls sit under the note.
    expect(screen.getByLabelText("Position step")).toBeTruthy();
  });

  it("fills key markers in the note", () => {
    const cm = TAB_SECTIONS.edit.find((s) => s.id === "cm")!;
    render(<SectionNote section={cm} />);
    expect(screen.getByText(/1 \/ 2 \/ 3 でも切替/)).toBeTruthy();
  });
});

describe("Glossary", () => {
  it("narrows by category and by search over English, Japanese and meaning", () => {
    expect(filterGlossary(GLOSSARY, "すべて", "")).toHaveLength(GLOSSARY.length);
    expect(filterGlossary(GLOSSARY, "ファイル", "").every((g) => g.cat === "ファイル")).toBe(true);
    expect(filterGlossary(GLOSSARY, "すべて", "法線").map((g) => g.en)).toContain("Normal");
    expect(filterGlossary(GLOSSARY, "すべて", "normal").map((g) => g.en)).toContain("Normal");
  });

  it("on screen: search, category, and nothing found", () => {
    render(<Glossary />);
    const search = screen.getByRole("searchbox", { name: "用語をさがす" });
    fireEvent.change(search, { target: { value: "ボーン" } });
    expect(screen.getByText("Bone")).toBeTruthy();
    expect(screen.queryByText("Albedo")).toBeNull();
    fireEvent.change(search, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "見た目" }));
    expect(screen.getByText("Albedo")).toBeTruthy();
    expect(screen.queryByText("Bone")).toBeNull();
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.getByText("見つかりません")).toBeTruthy();
  });
});

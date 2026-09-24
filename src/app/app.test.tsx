// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { App } from "./app";
import { state } from "../state";
import { store } from "../store";
import { connectStore } from "./connect";

/**
 * The screen without the 3D side (no `onCanvas`, so Babylon never starts):
 * the layout, the tabs and their notes, the tool card, the glossary. The
 * Babylon-driven parts — adding a primitive, the gizmo, the modifier stack on
 * a real mesh — are checked in a browser (see the commit that added this).
 */
afterEach(cleanup);

describe("App", () => {
  it("lays out header, both panels, the 3D canvas and the status line", () => {
    render(<App />);
    expect(screen.getByRole("navigation", { name: "ツール" })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "左パネル" })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "右パネル" })).toBeTruthy();
    expect(document.getElementById("rc")).toBeTruthy();
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("tool pills carry the keymap's keys; tools without one show none", () => {
    render(<App />);
    const pills = within(screen.getByRole("navigation", { name: "ツール" })).getAllByRole("button");
    expect(pills.map((p) => p.textContent)).toEqual(["SELW", "MOVG", "ROTR", "SCLS", "SCP", "PNT", "BONE", "WGT", "ANM"]);
  });

  it("the right panel shows the open tab's sections, each with its note, and the tool card", () => {
    render(<App />);
    const right = screen.getByRole("complementary", { name: "右パネル" });
    expect(within(right).getByRole("region", { name: "Select の説明" })).toBeTruthy();
    expect(within(right).getByText("Modifiers")).toBeTruthy();
    // No mesh selected: the Transform and Modifiers sections say so.
    expect(within(right).getAllByText("メッシュを選択").length).toBe(2);

    fireEvent.click(within(right).getByRole("tab", { name: "Material" }));
    expect(within(right).getByRole("region", { name: "Material の説明" })).toBeTruthy();
    expect(within(right).getByText("Albedo")).toBeTruthy();
    // Material's controls are not on the new screen yet, and it says so.
    expect(within(right).getAllByText("操作部品は新しい画面へ移植中").length).toBeGreaterThan(0);
  });

  it("the status line shows what the last action reported", async () => {
    render(<App />);
    await act(async () => store.setStatus("⚠ 2つのメッシュを選択してください"));
    const bar = screen.getByRole("status");
    expect(bar.textContent).toBe("⚠ 2つのメッシュを選択してください");
    expect(bar.className).toContain("stat-err");
  });

  it("undo is disabled with an empty history and enabled after a push", async () => {
    state.history.clear();
    // What boot() does, minus the scene: the history feeds the store.
    const off = connectStore(store, state, { onAfterRenderObservable: { add: () => null, remove: () => true } });
    render(<App />);
    const undo = screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement;
    expect(undo.disabled).toBe(true);
    await act(async () => state.history.push({ label: "x", undo() {}, redo() {} }));
    expect(undo.disabled).toBe(false);
    off();
    state.history.clear();
  });

  it("the glossary opens from ? and closes", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "用語集" }));
    const dialog = screen.getByRole("dialog", { name: "用語集" });
    expect(within(dialog).getByText("Mesh")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "閉じる" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

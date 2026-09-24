import { describe, it, expect } from "vitest";
import { KEYMAP, actionFor, keyLabel, bindingLabel, ACTION_TEXT, type KeyInput, type Binding } from "./keymap";

/** A key press as the handler sees it. */
function press(key: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; code?: string } = {}): KeyInput {
  return {
    key,
    code: mods.code ?? (key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : /^[0-9]$/.test(key) ? `Digit${key}` : key),
    ctrlKey: !!mods.ctrl,
    metaKey: false,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
  };
}
/** Numpad keys as a browser sends them with Num Lock off — "." comes as "Delete". */
const numpadKey = (code: string): string => (code === "NumpadDecimal" ? "Delete" : code.slice(-1));
const fromBinding = (bd: Binding): KeyInput =>
  press(bd.code ? numpadKey(bd.code) : bd.key, { ctrl: bd.ctrl, shift: bd.shift, alt: bd.alt, code: bd.code });

describe("keymap", () => {
  it("reaches every binding — none is shadowed by another in its context", () => {
    for (const bd of KEYMAP) {
      const contexts = bd.context === "any" ? (["object", "edit"] as const) : ([bd.context] as const);
      for (const ctx of contexts) expect(actionFor(fromBinding(bd), ctx), `${bindingLabel(bd)} in ${ctx}`).toBe(bd.action);
    }
  });

  it("uses Blender's keys where forge3d used to have its own", () => {
    // Object Mode: A selects all, W is the select tool, Shift+D duplicates.
    expect(actionFor(press("a"), "object")).toBe("select.all");
    expect(actionFor(press("a", { alt: true }), "object")).toBe("select.none");
    expect(actionFor(press("w"), "object")).toBe("tool.select");
    expect(actionFor(press("D", { shift: true }), "object")).toBe("object.duplicate");
    expect(actionFor(press("H", { shift: true }), "object")).toBe("view.hideUnselected");
    expect(actionFor(press("h", { alt: true }), "object")).toBe("view.reveal");
    // …and the old ones are gone rather than meaning something else.
    for (const k of ["v", "d", "p", "b", "f"]) expect(actionFor(press(k), "object"), k).toBeNull();
    expect(actionFor(press("d", { ctrl: true }), "object")).toBeNull();
    expect(actionFor(press("a", { ctrl: true }), "object")).toBeNull();
    // Edit Mode: F fills, G moves, Alt+J joins triangles.
    expect(actionFor(press("f"), "edit")).toBe("edit.fill");
    expect(actionFor(press("g"), "edit")).toBe("edit.move");
    expect(actionFor(press("j", { alt: true }), "edit")).toBe("edit.trisToQuads");
    for (const k of ["t", "j"]) expect(actionFor(press(k), "edit"), k).toBeNull();
    expect(actionFor(press("S", { shift: true }), "edit")).toBeNull();
    expect(actionFor(press("d", { ctrl: true }), "edit")).toBeNull();
  });

  it("keeps the number row and the numpad apart", () => {
    expect(actionFor(press("1"), "edit")).toBe("comp.vertex");
    expect(actionFor(press("1", { code: "Numpad1" }), "edit")).toBe("view.front");
    expect(actionFor(press("1", { code: "Numpad1", ctrl: true }), "object")).toBe("view.back");
    expect(actionFor(press(".", { code: "NumpadDecimal" }), "object")).toBe("view.selected");
    // Num Lock off: the same key arrives as "Delete" and must still only frame.
    expect(actionFor(press("Delete", { code: "NumpadDecimal" }), "object")).toBe("view.selected");
    expect(actionFor(press("Delete", { code: "NumpadDecimal" }), "edit")).toBeNull();
  });

  it("does not let Object Mode keys leak into Edit Mode", () => {
    expect(actionFor(press("w"), "edit")).toBeNull();
    expect(actionFor(press("h"), "edit")).toBeNull();
  });

  it("labels keys the way Blender's docs write them", () => {
    expect(keyLabel("edit.setCrease", "edit")).toBe("Ctrl+Shift+E");
    expect(keyLabel("view.selected")).toBe("Numpad .");
    expect(keyLabel("mode.editToggle")).toBe("Tab");
    for (const bd of KEYMAP) expect(ACTION_TEXT[bd.action], bd.action).toBeTruthy();
  });
});

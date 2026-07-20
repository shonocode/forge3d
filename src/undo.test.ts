import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the status function from state.ts to avoid DOM dependency
vi.mock("./state", () => ({
  status: vi.fn(),
}));

import { UndoHistory, type UndoCommand } from "./undo";

function makeCmd(label: string): UndoCommand & { undoCalls: number; redoCalls: number } {
  const cmd = {
    label,
    undoCalls: 0,
    redoCalls: 0,
    undo() { cmd.undoCalls++; },
    redo() { cmd.redoCalls++; },
  };
  return cmd;
}

describe("UndoHistory", () => {
  let history: UndoHistory;

  beforeEach(() => {
    history = new UndoHistory();
  });

  // Initial state
  it("starts empty", () => {
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
    expect(history.undoCount()).toBe(0);
    expect(history.redoCount()).toBe(0);
  });

  // Push
  it("push adds to undo stack", () => {
    history.push(makeCmd("A"));
    expect(history.canUndo()).toBe(true);
    expect(history.undoCount()).toBe(1);
    expect(history.canRedo()).toBe(false);
  });

  it("push clears redo stack", () => {
    history.push(makeCmd("A"));
    history.undo();
    expect(history.canRedo()).toBe(true);
    history.push(makeCmd("B"));
    expect(history.canRedo()).toBe(false);
    expect(history.redoCount()).toBe(0);
  });

  it("push enforces max size of 50", () => {
    for (let i = 0; i < 60; i++) {
      history.push(makeCmd(`cmd_${i}`));
    }
    expect(history.undoCount()).toBe(50);
  });

  // Undo
  it("undo executes command's undo()", () => {
    const cmd = makeCmd("A");
    history.push(cmd);
    history.undo();
    expect(cmd.undoCalls).toBe(1);
  });

  it("undo returns true when stack is non-empty", () => {
    history.push(makeCmd("A"));
    expect(history.undo()).toBe(true);
  });

  it("undo returns false when stack is empty", () => {
    expect(history.undo()).toBe(false);
  });

  it("undo moves command to redo stack", () => {
    history.push(makeCmd("A"));
    history.undo();
    expect(history.canRedo()).toBe(true);
    expect(history.redoCount()).toBe(1);
    expect(history.undoCount()).toBe(0);
  });

  it("undo catches when cmd.undo() throws", () => {
    const cmd: UndoCommand = {
      label: "Throws",
      undo() { throw new Error("fail"); },
      redo() { /* noop */ },
    };
    history.push(cmd);
    expect(history.undo()).toBe(true);
    expect(history.redoCount()).toBe(1);
  });

  // Redo
  it("redo executes command's redo()", () => {
    const cmd = makeCmd("A");
    history.push(cmd);
    history.undo();
    history.redo();
    expect(cmd.redoCalls).toBe(1);
  });

  it("redo returns true when redo stack is non-empty", () => {
    history.push(makeCmd("A"));
    history.undo();
    expect(history.redo()).toBe(true);
  });

  it("redo returns false when redo stack is empty", () => {
    expect(history.redo()).toBe(false);
  });

  it("redo moves command back to undo stack", () => {
    history.push(makeCmd("A"));
    history.undo();
    history.redo();
    expect(history.undoCount()).toBe(1);
    expect(history.redoCount()).toBe(0);
  });

  it("redo catches when cmd.redo() throws", () => {
    const cmd: UndoCommand = {
      label: "Throws",
      undo() { /* noop */ },
      redo() { throw new Error("fail"); },
    };
    history.push(cmd);
    history.undo();
    expect(history.redo()).toBe(true);
    expect(history.undoCount()).toBe(1);
  });

  // Multiple undo/redo preserves LIFO order
  it("multiple undo/redo preserves order", () => {
    const log: string[] = [];
    const a: UndoCommand = { label: "A", undo() { log.push("undo-A"); }, redo() { log.push("redo-A"); } };
    const b: UndoCommand = { label: "B", undo() { log.push("undo-B"); }, redo() { log.push("redo-B"); } };
    history.push(a);
    history.push(b);
    history.undo(); // undo B
    history.undo(); // undo A
    history.redo(); // redo A
    history.redo(); // redo B
    expect(log).toEqual(["undo-B", "undo-A", "redo-A", "redo-B"]);
  });

  // popUndo
  it("popUndo removes last entry without executing", () => {
    const cmd = makeCmd("A");
    history.push(cmd);
    const popped = history.popUndo();
    expect(popped).toBe(cmd);
    expect(cmd.undoCalls).toBe(0);
    expect(history.undoCount()).toBe(0);
  });

  it("popUndo returns undefined on empty stack", () => {
    expect(history.popUndo()).toBeUndefined();
  });

  // clear
  it("clear empties both stacks", () => {
    history.push(makeCmd("A"));
    history.push(makeCmd("B"));
    history.undo();
    history.clear();
    expect(history.undoCount()).toBe(0);
    expect(history.redoCount()).toBe(0);
  });

  // onChange callback
  it("onChange fires on push, undo, redo, popUndo, clear", () => {
    const onChange = vi.fn();
    history.setOnChange(onChange);
    history.push(makeCmd("A"));   // 1
    history.undo();               // 2
    history.redo();               // 3
    history.popUndo();            // 4
    history.push(makeCmd("B"));   // 5
    history.clear();              // 6
    expect(onChange).toHaveBeenCalledTimes(6);
  });
});

describe("version counter (autosave differential skip)", () => {
  it("bumps on push / undo / redo / popUndo / clear, and only then", () => {
    const h = new UndoHistory();
    const v0 = h.version;
    h.push({ label: "a", undo() {}, redo() {} });
    expect(h.version).toBe(v0 + 1);
    h.undo();
    expect(h.version).toBe(v0 + 2);
    h.redo();
    expect(h.version).toBe(v0 + 3);
    h.popUndo();
    expect(h.version).toBe(v0 + 4);
    h.popUndo(); // empty stack — no change happened
    expect(h.version).toBe(v0 + 4);
    h.clear();
    expect(h.version).toBe(v0 + 5);
    h.undo(); // nothing to undo — counter stays
    expect(h.version).toBe(v0 + 5);
  });
});

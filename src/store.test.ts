import { describe, it, expect } from "vitest";
import { ForgeStore, fingerprint, statusKind, type FingerprintSource } from "./store";
import { UndoHistory } from "./undo";

const tick = (): Promise<void> => Promise.resolve();

function source(): FingerprintSource {
  return {
    tool: "select",
    selectedMeshes: [],
    allMeshes: [{ uniqueId: 1 }, { uniqueId: 2 }],
    editMesh: null,
    sculpting: false,
    painting: false,
    weightPainting: false,
    boneEditMode: "edit",
    viewportMode: "textured",
    history: { version: 0 },
  };
}

describe("ForgeStore", () => {
  it("merges notifications in one tick into one", async () => {
    const s = new ForgeStore();
    let calls = 0;
    s.subscribe(() => calls++);
    s.notify();
    s.notify();
    s.setStatus("x");
    expect(calls).toBe(0);
    await tick();
    expect(calls).toBe(1);
    expect(s.version).toBe(1);
    s.notify();
    await tick();
    expect(calls).toBe(2);
  });

  it("stops calling a listener once it unsubscribes", async () => {
    const s = new ForgeStore();
    let calls = 0;
    const off = s.subscribe(() => calls++);
    off();
    s.notify();
    await tick();
    expect(calls).toBe(0);
  });

  it("keeps the last status line with its kind and a sequence number", () => {
    const s = new ForgeStore();
    s.setStatus("box を追加");
    s.setStatus("box を追加");
    expect(s.status).toEqual({ text: "box を追加", kind: "info", seq: 2 });
    s.setStatus("⚠ 2つのメッシュを選択してください");
    expect(s.status!.kind).toBe("error");
    expect(statusKind("Project saved")).toBe("ok");
  });

  it("poll notifies only when the fingerprint changes, and not on the first call", async () => {
    const s = new ForgeStore();
    let calls = 0;
    s.subscribe(() => calls++);
    const src = source();
    s.poll(fingerprint(src));
    s.poll(fingerprint(src));
    await tick();
    expect(calls).toBe(0);
    src.selectedMeshes = [{ uniqueId: 2 }];
    s.poll(fingerprint(src));
    await tick();
    expect(calls).toBe(1);
  });
});

describe("fingerprint", () => {
  it("changes with each thing the GUI draws from", () => {
    const base = fingerprint(source());
    const changes: Array<(s: FingerprintSource) => void> = [
      (s) => (s.tool = "move"),
      (s) => (s.selectedMeshes = [{ uniqueId: 1 }]),
      (s) => (s.allMeshes = [{ uniqueId: 1 }]),
      (s) => (s.editMesh = {}),
      (s) => (s.sculpting = true),
      (s) => (s.painting = true),
      (s) => (s.weightPainting = true),
      (s) => (s.boneEditMode = "pose"),
      (s) => (s.viewportMode = "wire"),
      (s) => (s.history = { version: 1 }),
    ];
    for (const change of changes) {
      const s = source();
      change(s);
      expect(fingerprint(s)).not.toBe(base);
    }
  });
});

describe("UndoHistory.subscribe", () => {
  it("hears push, undo, redo and clear next to setOnChange, until unsubscribed", () => {
    const h = new UndoHistory();
    let heard = 0;
    let single = 0;
    h.setOnChange(() => single++);
    const off = h.subscribe(() => heard++);
    h.push({ label: "a", undo() {}, redo() {} });
    h.undo();
    h.redo();
    h.clear();
    expect(heard).toBe(4);
    expect(single).toBe(4);
    off();
    h.push({ label: "b", undo() {}, redo() {} });
    expect(heard).toBe(4);
    expect(single).toBe(5);
  });
});
